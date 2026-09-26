import { readFileSync } from "node:fs";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadReviewPromptAppend(agentDir: string): string {
	const configPath = join(agentDir, "extensions", "pi-review", "config.json");
	let contents: string;
	try {
		contents = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw new Error(`Could not read pi-review config at ${configPath}: ${String(error)}`);
	}

	let config: unknown;
	try {
		config = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Invalid JSON in pi-review config at ${configPath}: ${String(error)}`);
	}
	if (!isRecord(config)) throw new Error(`pi-review config must be an object: ${configPath}`);

	const prompt = config.prompt;
	if (prompt === undefined) return "";
	if (!isRecord(prompt)) throw new Error(`pi-review config prompt must be an object: ${configPath}`);

	const append = prompt.append;
	if (append === undefined) return "";
	if (typeof append !== "string") throw new Error(`pi-review config prompt.append must be a string: ${configPath}`);
	return append;
}
