import assert from "node:assert/strict";
import {test} from "node:test";
import {buildSync} from "esbuild";
import {fileURLToPath} from "node:url";

const result = buildSync({
	stdin: {
		contents: 'export {Tasks} from "./src/vikunja/tasks"; export {Configuration, TaskApi, LabelsApi, ProjectApi, UserApi, ResponseError} from "./vikunja_sdk";',
		resolveDir: fileURLToPath(new URL("../", import.meta.url)),
	},
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	write: false,
});
const {Tasks, Configuration, TaskApi, LabelsApi, ProjectApi, UserApi, ResponseError} =
	await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const host = "https://vikunja.example";
const token = "tk_test_token";
const plugin = {settings: {vikunjaHost: host, vikunjaAccessToken: token}};

test("connection check reads /tasks and converts the current task response", async t => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push({url, init});
		return new Response(JSON.stringify([{
			id: 1, title: "Task", project_id: 2, due_date: "2026-10-10T12:00:00Z",
			labels: [{id: 3, title: "Label"}], buckets: [{id: 4, project_view_id: 5}],
			is_unread: true, time_entries_count: 6,
		}]), {status: 200});
	});
	const tasks = await new Tasks({}, plugin).getAllTasks();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${host}/api/v1/tasks?page=0`);
	assert.equal(calls[0].init.method, "GET");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
	assert.equal(tasks[0].projectId, 2);
	assert.equal(tasks[0].dueDate, "2026-10-10T12:00:00Z");
	assert.equal(tasks[0].labels[0].title, "Label");
	assert.equal(tasks[0].buckets[0].projectViewId, 5);
	assert.equal(tasks[0].isUnread, true);
	assert.equal(tasks[0].timeEntriesCount, 6);
});

test("task paging uses the new endpoint and accepts an empty result", async t => {
	t.mock.method(globalThis, "fetch", async url => {
		assert.equal(url, `${host}/api/v1/tasks?page=2`);
		return new Response("[]", {status: 200});
	});
	assert.deepEqual(await new Tasks({}, plugin).getTasksForPage(2), []);
});

for (const status of [401, 403, 404, 500]) {
	test(`HTTP ${status} is propagated instead of returning an empty task list`, async t => {
		t.mock.method(globalThis, "fetch", async () => new Response(
			JSON.stringify({message: "Request failed"}), {status},
		));
		await assert.rejects(new Tasks({}, plugin).getAllTasks(), error =>
			error instanceof ResponseError && error.response.status === status);
	});
}

test("task writes retain v1 methods and snake_case payload fields", async () => {
	const calls = [];
	const api = new TaskApi(new Configuration({
		basePath: `${host}/api/v1`, apiKey: `Bearer ${token}`,
		fetchApi: async (url, init) => {
			calls.push({url, init});
			return new Response(init.body, {status: 200});
		},
	}));
	const task = {title: "Task", projectId: 2, dueDate: "2026-10-10T12:00:00Z", done: true, bucketId: 4};
	await api.projectsIdTasksPut({id: 2, task});
	await api.tasksIdPost({id: 1, task});
	assert.deepEqual(calls.map(({url, init}) => [url, init.method]), [
		[`${host}/api/v1/projects/2/tasks`, "PUT"],
		[`${host}/api/v1/tasks/1`, "POST"],
	]);
	for (const {init} of calls) {
		assert.equal(init.headers.Authorization, `Bearer ${token}`);
		const body = JSON.parse(init.body);
		assert.equal(body.project_id, 2);
		assert.equal(body.due_date, task.dueDate);
		assert.equal(body.bucket_id, 4);
		assert.equal(body.done, true);
		assert.equal(body.projectId, undefined);
	}
});

test("label and Kanban operations retain their supported v1 routes", async () => {
	const calls = [];
	const configuration = new Configuration({
		basePath: `${host}/api/v1`, apiKey: `Bearer ${token}`,
		fetchApi: async (url, init) => {
			calls.push([new URL(url).pathname, init.method]);
			return new Response(init.method === "GET" && !url.endsWith("/user") ? "[]" : "{}", {status: 200});
		},
	});
	const labels = new LabelsApi(configuration);
	await labels.labelsGet();
	await labels.labelsPut({label: {title: "Label"}});
	await labels.labelsIdPut({id: 3, label: {title: "Label"}});
	await labels.labelsIdDelete({id: 3});
	await labels.tasksTaskLabelsPut({task: 1, label: {labelId: 3}});
	await labels.tasksTaskLabelsLabelDelete({task: 1, label: 3});
	const projects = new ProjectApi(configuration);
	await projects.projectsGet();
	await projects.projectsProjectViewsGet({project: 2});
	await projects.projectsIdViewsViewBucketsPut({id: 2, view: 5, bucket: {title: "Done"}});
	await projects.projectsProjectViewsIdPost({project: 2, id: 5, view: {doneBucketId: 4}});
	await new UserApi(configuration).userGet();
	assert.deepEqual(calls, [
		["/api/v1/labels", "GET"], ["/api/v1/labels", "PUT"],
		["/api/v1/labels/3", "PUT"], ["/api/v1/labels/3", "DELETE"],
		["/api/v1/tasks/1/labels", "PUT"], ["/api/v1/tasks/1/labels/3", "DELETE"],
		["/api/v1/projects", "GET"], ["/api/v1/projects/2/views", "GET"],
		["/api/v1/projects/2/views/5/buckets", "PUT"],
		["/api/v1/projects/2/views/5", "POST"], ["/api/v1/user", "GET"],
	]);
});
