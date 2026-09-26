import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewPromptAppend } from "./review-config.ts";

function withAgentDir(run) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-review-config-"));
	try {
		return run(agentDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function configPath(agentDir) {
	return join(agentDir, "extensions", "pi-review", "config.json");
}

test("loads the global extension prompt.append value", () => withAgentDir((agentDir) => {
	const append = "\n\n---\n\nExtra review guidance.";
	const file = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-review"), { recursive: true });
	writeFileSync(file, JSON.stringify({ prompt: { append } }));
	assert.equal(loadReviewPromptAppend(agentDir), append);
}));

test("uses no custom append when the optional config is absent", () => withAgentDir((agentDir) => {
	assert.equal(loadReviewPromptAppend(agentDir), "");
}));

test("rejects a non-string prompt.append value", () => withAgentDir((agentDir) => {
	const file = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-review"), { recursive: true });
	writeFileSync(file, JSON.stringify({ prompt: { append: false } }));
	assert.throws(() => loadReviewPromptAppend(agentDir), /prompt\.append must be a string/);
}));
