import { readFileSync } from "node:fs";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ReviewPromptConfig {
	prepend: string | null;
	append: string | null;
	comments: string | null;
	validation: string | null;
}

const PROMPT_FIELDS = ["prepend", "append", "comments", "validation"] as const;

export function loadReviewPromptConfig(agentDir: string): ReviewPromptConfig {
	const configPath = join(agentDir, "extensions", "pi-review", "config.json");
	let contents: string;
	try {
		contents = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { prepend: null, append: null, comments: null, validation: null };
		}
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
	if (prompt === undefined) return { prepend: null, append: null, comments: null, validation: null };
	if (!isRecord(prompt)) throw new Error(`pi-review config prompt must be an object: ${configPath}`);

	const result: ReviewPromptConfig = { prepend: null, append: null, comments: null, validation: null };
	for (const field of PROMPT_FIELDS) {
		const value = prompt[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== "string") {
			throw new Error(`pi-review config prompt.${field} must be a string or null: ${configPath}`);
		}
		result[field] = value;
	}
	return result;
}
