import {requestUrl} from "obsidian";
import type {FetchAPI} from "../../vikunja_sdk";

// Use Obsidian's HTTP transport so API requests are not blocked by browser CORS.
export const obsidianFetch: FetchAPI = async (input, init) => {
	const request = new Request(input, init);
	const headers: Record<string, string> = {};
	request.headers.forEach((value, name) => headers[name] = value);

	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers,
		body: request.body === null ? undefined : await request.arrayBuffer(),
		// Let the SDK turn HTTP errors into ResponseError, as it does with fetch.
		throw: false,
	});

	const noBody = request.method === "HEAD" || [204, 205, 304].includes(response.status);
	return new Response(noBody ? null : response.arrayBuffer, {
		status: response.status,
		headers: response.headers,
	});
};
