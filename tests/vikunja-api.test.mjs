import assert from "node:assert/strict";
import {beforeEach, test} from "node:test";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";

const result = await build({
	stdin: {
		contents: `
			export {Tasks} from "./src/vikunja/tasks";
			export {Projects} from "./src/vikunja/projects";
			export {Label} from "./src/vikunja/labels";
			export {User} from "./src/vikunja/user";
			export {obsidianFetch} from "./src/vikunja/transport";
			export {apiErrorMessage} from "./src/vikunja/errors";
			export {MainSetting, DEFAULT_SETTINGS} from "./src/settings/mainSetting";
			export {Automaton, AutomatonStatus} from "./src/processing/automaton";
			export {Processor} from "./src/processing/processor";
			export {EmojiTaskParser} from "./src/taskFormats/emojiTaskFormat";
			export {transport} from "obsidian";
			export {Configuration, LabelsApi, ProjectApi, UserApi, ResponseError, FetchError} from "./vikunja_sdk";
		`,
		resolveDir: fileURLToPath(new URL("../", import.meta.url)),
	},
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	write: false,
	plugins: [{
		name: "mock-obsidian",
		setup(build) {
			build.onResolve({filter: /^obsidian$/}, () => ({path: "obsidian", namespace: "mock"}));
			build.onResolve({filter: /^obsidian-daily-notes-interface$/}, () => ({path: "daily-notes", namespace: "mock"}));
			build.onResolve({filter: /^obsidian-dataview$/}, () => ({path: "dataview", namespace: "mock"}));
			build.onLoad({filter: /dataview/, namespace: "mock"}, () => ({contents:
				"export const getAPI = () => { throw new Error('Unexpected Dataview access'); };"}));
			build.onLoad({filter: /daily-notes/, namespace: "mock"}, () => ({contents:
				`export const appHasDailyNotesPluginLoaded = () => true;
				export const createDailyNote = () => { throw new Error("Unexpected daily note write"); };
				export const getAllDailyNotes = () => { throw new Error("Unexpected daily note access"); };
				export const getDailyNote = () => { throw new Error("Unexpected daily note access"); };`}));
			build.onLoad({filter: /obsidian/, namespace: "mock"}, () => ({contents: `
				export const transport = {requestUrl: async () => { throw new Error("Unexpected HTTP request"); }};
				export const requestUrl = params => transport.requestUrl(params);
				export class PluginSettingTab {}
				export class Setting {}
				export class Notice {}
				export class MarkdownView {}
				export class TFile {}
				export const moment = () => { throw new Error("Unexpected date formatting"); };
			`}));
		},
	}],
});
const {Tasks, Projects, Label, User, obsidianFetch, transport, apiErrorMessage, MainSetting, DEFAULT_SETTINGS,
	Automaton, AutomatonStatus,
	Processor, EmojiTaskParser,
	Configuration, LabelsApi, ProjectApi, UserApi, ResponseError, FetchError} =
	await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const host = "https://vikunja.example";
const token = "tk_test_token";
const plugin = {settings: {vikunjaHost: host, vikunjaAccessToken: token}};

function httpResponse(body, status = 200, headers = {}) {
	return {status, headers, arrayBuffer: new TextEncoder().encode(body).buffer};
}

// Reproduce a browser that cannot fetch this server because of CORS.
beforeEach(t => {
	t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
	t.mock.method(console, "error", () => {});
});

test("connection check reads /tasks and converts the current task response", async t => {
	const calls = [];
	t.mock.method(transport, "requestUrl", async request => {
		calls.push(request);
		return httpResponse(JSON.stringify([{
			id: 1, title: "Task", project_id: 2, due_date: "2026-10-10T12:00:00Z",
			labels: [{id: 3, title: "Label"}], buckets: [{id: 4, project_view_id: 5}],
			is_unread: true, time_entries_count: 6,
		}]));
	});
	const tasks = await new Tasks({}, plugin).getAllTasks();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${host}/api/v1/tasks?page=0`);
	assert.equal(calls[0].method, "GET");
	assert.equal(calls[0].headers.authorization, `Bearer ${token}`);
	assert.equal(calls[0].body, undefined);
	assert.equal(calls[0].throw, false);
	assert.equal(globalThis.fetch.mock.callCount(), 0);
	assert.equal(tasks[0].projectId, 2);
	assert.equal(tasks[0].dueDate, "2026-10-10T12:00:00Z");
	assert.equal(tasks[0].labels[0].title, "Label");
	assert.equal(tasks[0].buckets[0].projectViewId, 5);
	assert.equal(tasks[0].isUnread, true);
	assert.equal(tasks[0].timeEntriesCount, 6);
});

test("task paging uses the new endpoint and accepts an empty result", async t => {
	t.mock.method(transport, "requestUrl", async ({url}) => {
		assert.equal(url, `${host}/api/v1/tasks?page=2`);
		return httpResponse("[]");
	});
	assert.deepEqual(await new Tasks({}, plugin).getTasksForPage(2), []);
});

for (const status of [401, 403, 404, 500]) {
	test(`HTTP ${status} is propagated instead of returning an empty task list`, async t => {
		t.mock.method(transport, "requestUrl", async () => httpResponse(
			JSON.stringify({message: "Request failed"}), status,
		));
		await assert.rejects(new Tasks({}, plugin).getAllTasks(), error =>
			error instanceof ResponseError && error.response.status === status);
	});
}

test("task writes retain v1 methods and snake_case payload fields", async t => {
	const calls = [];
	t.mock.method(transport, "requestUrl", async request => {
		calls.push(request);
		return httpResponse(new TextDecoder().decode(request.body));
	});
	const api = new Tasks({}, plugin).tasksApi;
	const task = {title: "Task", projectId: 2, dueDate: "2026-10-10T12:00:00Z", done: true, bucketId: 4};
	await api.projectsIdTasksPut({id: 2, task});
	await api.tasksIdPost({id: 1, task});
	assert.deepEqual(calls.map(({url, method}) => [url, method]), [
		[`${host}/api/v1/projects/2/tasks`, "PUT"],
		[`${host}/api/v1/tasks/1`, "POST"],
	]);
	for (const request of calls) {
		assert.equal(request.headers.authorization, `Bearer ${token}`);
		assert.equal(request.headers["content-type"], "application/json");
		const body = JSON.parse(new TextDecoder().decode(request.body));
		assert.equal(body.title, task.title);
		assert.equal(body.project_id, 2);
		assert.equal(body.due_date, task.dueDate);
		assert.equal(body.bucket_id, 4);
		assert.equal(body.done, true);
		assert.equal(body.projectId, undefined);
	}
});

test("label and Kanban operations retain their supported v1 routes", async t => {
	const calls = [];
	t.mock.method(transport, "requestUrl", async ({url, method}) => {
		calls.push([new URL(url).pathname, method]);
		return httpResponse(method === "GET" && !url.endsWith("/user") ? "[]" : "{}");
	});
	const configuration = new Configuration({
		basePath: `${host}/api/v1`, apiKey: `Bearer ${token}`,
		fetchApi: obsidianFetch,
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

test("project, user and label wrappers also bypass browser fetch", async t => {
	const calls = [];
	t.mock.method(transport, "requestUrl", async request => {
		calls.push(request);
		return httpResponse(request.url.endsWith("/user") ? '{"id":1}' : "[]");
	});
	assert.deepEqual(await new Projects({}, plugin).getAllProjects(), []);
	assert.equal((await new User({}, plugin).getUser()).id, 1);
	// Label initialization starts a background load; await a second load too.
	assert.deepEqual(await new Label({}, plugin).loadLabels(), []);
	assert.deepEqual(calls.map(({url}) => new URL(url).pathname), [
		"/api/v1/projects", "/api/v1/user", "/api/v1/labels", "/api/v1/labels",
	]);
	assert.ok(calls.every(request => request.headers.authorization === `Bearer ${token}`));
	assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("the transport preserves response headers, text and empty bodies", async t => {
	let status = 200;
	t.mock.method(transport, "requestUrl", async () =>
		httpResponse("response body", status, {"x-pagination-total-pages": "3"}));
	const response = await obsidianFetch(`${host}/api/v1/tasks`);
	assert.equal(response.headers.get("x-pagination-total-pages"), "3");
	assert.equal(await response.clone().text(), "response body");
	for (status of [204, 205, 304]) {
		const empty = await obsidianFetch(`${host}/api/v1/tasks`);
		assert.equal(empty.status, status);
		assert.equal(await empty.text(), "");
	}
	status = 200;
	assert.equal(await (await obsidianFetch(`${host}/api/v1/tasks`, {method: "HEAD"})).text(), "");
});

test("network failures still propagate through the SDK", async t => {
	const cause = new Error("Connection refused");
	t.mock.method(transport, "requestUrl", async () => { throw cause; });
	await assert.rejects(new Tasks({}, plugin).getAllTasks(), error =>
		error instanceof FetchError && error.cause === cause);
});

function connectionSettings(t) {
	const currentPlugin = {settings: {...DEFAULT_SETTINGS, ...plugin.settings}};
	currentPlugin.tasksApi = new Tasks({}, currentPlugin);
	currentPlugin.projectsApi = new Projects({}, currentPlugin);
	currentPlugin.labelsApi = new Label({}, currentPlugin);
	const settings = Object.create(MainSetting.prototype);
	settings.plugin = currentPlugin;
	settings.display = t.mock.fn();
	return settings;
}

test("connection validation checks tasks, labels and projects before succeeding", async t => {
	const paths = [];
	t.mock.method(transport, "requestUrl", async ({url}) => {
		paths.push(new URL(url).pathname);
		return httpResponse(url.endsWith("/projects") ? '[{"id":2,"title":"Project"}]' : "[]");
	});
	const settings = connectionSettings(t);
	await settings.testConnection();
	assert.ok(paths.includes("/api/v1/tasks"));
	assert.ok(paths.includes("/api/v1/labels"));
	assert.ok(paths.includes("/api/v1/projects"));
	assert.equal(settings.display.mock.callCount(), 1);
});

for (const denied of ["labels", "projects"]) {
	test(`connection validation fails if tasks work but ${denied} returns HTTP 401`, async t => {
		t.mock.method(console, "error", () => {});
		t.mock.method(transport, "requestUrl", async ({url}) =>
			httpResponse("[]", url.endsWith(`/${denied}`) ? 401 : 200));
		const settings = connectionSettings(t);
		await assert.rejects(settings.testConnection(), error => {
			assert.match(apiErrorMessage(error), /HTTP 401/);
			assert.match(apiErrorMessage(error), /permission/);
			return error instanceof ResponseError;
		});
		assert.equal(settings.display.mock.callCount(), 0);
	});
}

test("loading an empty project list succeeds with debugging enabled", async t => {
	t.mock.method(console, "log", () => {});
	t.mock.method(transport, "requestUrl", async () => httpResponse("[]"));
	const settings = connectionSettings(t);
	settings.plugin.settings.debugging = true;
	await settings.loadApi();
	assert.deepEqual(settings.projects, []);
	assert.equal(settings.display.mock.callCount(), 1);
});

test("failed requests preserve the server response without transport debug output", async t => {
	const body = {code: 3002, message: "This project does not exist."};
	t.mock.method(transport, "requestUrl", async () => httpResponse(JSON.stringify(body), 404));
	let failure;
	await assert.rejects(new Tasks({}, plugin).getAllTasks(), error => {
		failure = error;
		return error instanceof ResponseError && error.response.status === 404;
	});
	assert.equal(console.error.mock.callCount(), 0);
	assert.deepEqual(await failure.response.json(), body);
});

test("the automaton retains the error object and HTTP status when a step fails", async () => {
	const failure = new ResponseError(new Response("{}", {status: 403}), "Response returned an error code");
	const automaton = Object.create(Automaton.prototype);
	automaton.currentStep = 0;
	automaton.steps = [{step: async () => { throw failure; }}];
	await automaton.run({localTasks: [], vikunjaTasks: []});
	assert.equal(automaton.status, AutomatonStatus.ERROR);
	const args = console.error.mock.calls[0].arguments;
	assert.match(args[1], /HTTP 403/);
	assert.equal(args[2], failure);
});

test("empty checkboxes and metadata-only tasks do not stop creation of valid tasks", async t => {
	const currentPlugin = {settings: {...DEFAULT_SETTINGS, ...plugin.settings, defaultVikunjaProject: 1}};
	const parser = new EmojiTaskParser({}, currentPlugin);
	const tasks = [];
	for (const [line, text] of ["- [ ] ", "- [ ] #tag 📅 2026-10-10", "- [ ] Купить молоко"].entries()) {
		tasks.push({filepath: "note.md", lineno: line, task: await parser.parse(text)});
	}
	const warnings = t.mock.method(console, "warn", () => {});
	const create = t.mock.fn(async task => ({...task.task, id: 101}));
	currentPlugin.tasksApi = {createTask: create};
	const processor = Object.create(Processor.prototype);
	processor.plugin = currentPlugin;
	processor.updateToVault = t.mock.fn(async () => {});
	await processor.pushTasksFromVaultToVikunja(tasks, []);
	assert.equal(create.mock.callCount(), 1);
	assert.equal(create.mock.calls[0].arguments[0].task.title, "Купить молоко");
	assert.equal(processor.updateToVault.mock.callCount(), 1);
	assert.equal(warnings.mock.callCount(), 0);
	assert.equal(tasks[0].task.id, undefined);
	assert.equal(tasks[1].task.id, undefined);
	currentPlugin.settings.debugging = true;
	t.mock.method(console, "log", () => {});
	await processor.pushTasksFromVaultToVikunja(tasks.slice(0, 2), []);
	assert.deepEqual(warnings.mock.calls.map(call => call.arguments[1]), [
		{file: "note.md", line: 1}, {file: "note.md", line: 2},
	]);
});

test("parsed Cyrillic titles reach the task creation request unchanged", async t => {
	const currentPlugin = {settings: {...DEFAULT_SETTINGS, ...plugin.settings, defaultVikunjaProject: 1},
		labelsApi: {getOrCreateLabels: async () => []}};
	const parser = new EmojiTaskParser({}, currentPlugin);
	const task = await parser.parse("- [ ] Купить молоко 📅 2026-10-10");
	t.mock.method(transport, "requestUrl", async request => {
		const body = JSON.parse(new TextDecoder().decode(request.body));
		assert.equal(body.title, "Купить молоко");
		assert.equal(body.due_date, "2026-10-10T12:00:00Z");
		return httpResponse(JSON.stringify({...body, id: 101}));
	});
	const created = await new Tasks({}, currentPlugin).createTask({filepath: "note.md", lineno: 0, task});
	assert.equal(created.title, "Купить молоко");
});
