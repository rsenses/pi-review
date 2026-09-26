import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewPromptConfig } from "./review-config.ts";

function withAgentDir(run) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-review-config-"));
	try {
		return run(agentDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function writeConfig(agentDir, config) {
	const file = join(agentDir, "extensions", "pi-review", "config.json");
	mkdirSync(join(agentDir, "extensions", "pi-review"), { recursive: true });
	writeFileSync(file, JSON.stringify(config));
}

const emptyConfig = { prepend: null, append: null, comments: null, validation: null };

test("loads all optional prompt fields unchanged", () => withAgentDir((agentDir) => {
	const config = {
		prepend: "  prepend  ",
		append: "\nappend\n",
		comments: "comments",
		validation: "validation",
	};
	writeConfig(agentDir, { prompt: config });
	assert.deepEqual(loadReviewPromptConfig(agentDir), config);
}));

test("returns null values when the optional config is absent", () => withAgentDir((agentDir) => {
	assert.deepEqual(loadReviewPromptConfig(agentDir), emptyConfig);
}));

test("returns null values for a missing prompt or missing and null fields", () => withAgentDir((agentDir) => {
	writeConfig(agentDir, {});
	assert.deepEqual(loadReviewPromptConfig(agentDir), emptyConfig);

	writeConfig(agentDir, { prompt: { prepend: null, comments: "comments" } });
	assert.deepEqual(loadReviewPromptConfig(agentDir), {
		prepend: null,
		append: null,
		comments: "comments",
		validation: null,
	});
}));

test("rejects a non-object prompt", () => withAgentDir((agentDir) => {
	writeConfig(agentDir, { prompt: null });
	assert.throws(() => loadReviewPromptConfig(agentDir), /prompt must be an object/);
}));

test("rejects prompt fields that are neither strings nor null", () => withAgentDir((agentDir) => {
	for (const field of ["prepend", "append", "comments", "validation"]) {
		writeConfig(agentDir, { prompt: { [field]: false } });
		assert.throws(() => loadReviewPromptConfig(agentDir), new RegExp(`prompt\\.${field} must be a string or null`));
	}
}));
