import {ResponseError} from "../../vikunja_sdk";

export function apiErrorMessage(error: unknown): string {
	if (error instanceof ResponseError) {
		const status = error.response.status;
		const hint = status === 401 || status === 403
			? " Check that the access token is valid and has permission for this API operation."
			: "";
		return `HTTP ${status}.${hint}`;
	}
	return error instanceof Error ? error.message : "Unknown error";
}
