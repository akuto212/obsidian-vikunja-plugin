import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, readdirSync, rmSync, cpSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const version = "2.7.0";
const directory = mkdtempSync(join(tmpdir(), "vikunja-sdk-"));

function trimGeneratedWhitespace(path) {
	for (const entry of readdirSync(path, {withFileTypes: true})) {
		const file = join(path, entry.name);
		if (entry.isDirectory()) trimGeneratedWhitespace(file);
		else if (entry.name.endsWith(".ts")) {
			writeFileSync(file, readFileSync(file, "utf8").replace(/[\t ]+$/gm, ""));
		}
	}
}

try {
	let spec;
	if (process.argv[2]) {
		spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
	} else {
		const response = await fetch(`https://raw.githubusercontent.com/go-vikunja/vikunja/v${version}/pkg/swagger/swagger.json`);
		if (!response.ok) throw new Error(`Could not download Vikunja schema: HTTP ${response.status}`);
		spec = await response.json();
	}
	// Release sources omit the version; the server fills it in at runtime.
	spec.info.version = version;
	const schema = join(directory, "swagger.json");
	const output = join(directory, "sdk");
	writeFileSync(schema, JSON.stringify(spec));
	execFileSync(process.execPath, [
		"node_modules/@openapitools/openapi-generator-cli/main.js", "generate",
		"-i", schema, "-o", output, "-g", "typescript-fetch",
		"-t", "scripts/templates",
		"--additional-properties", "supportsES6=true,npmVersion=10.8.1,typescriptThreePlus=true",
	], {stdio: "inherit"});
	trimGeneratedWhitespace(output);
	rmSync("vikunja_sdk", {recursive: true, force: true});
	cpSync(output, "vikunja_sdk", {recursive: true});
} finally {
	rmSync(directory, {recursive: true, force: true});
}
