import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapDeltaRows, parseUnifiedPatch } from "./delta-map.ts";
import { preserveSelectedBackground, stripTerminalControls } from "./terminal.ts";

const patch = `diff --git a/demo.txt b/demo.txt
index 1111111..2222222 100644
--- a/demo.txt
+++ b/demo.txt
@@ -10,3 +10,3 @@
 context
-deleted
+added
 end`;

test("parses source coordinates and maps context, deletion, and addition", () => {
	assert.deepEqual(parseUnifiedPatch(patch), [
		{ kind: "context", oldLine: 10, newLine: 10, content: "context", patchLineIndex: 5 },
		{ kind: "delete", oldLine: 11, content: "deleted", patchLineIndex: 6 },
		{ kind: "add", newLine: 11, content: "added", patchLineIndex: 7 },
		{ kind: "context", oldLine: 12, newLine: 12, content: "end", patchLineIndex: 8 },
	]);
	const rendered = [
		"10 ⋮ 10 │context\x1b[K",
		"11 ⋮    │deleted",
		"    ⋮ 11 │added",
		"12 ⋮ 12 │end",
	].join("\n");
	const rows = mapDeltaRows("demo.txt", patch, rendered);
	assert.deepEqual(rows.map(({ mapping }) => mapping), [
		{ file: "demo.txt", side: "new", line: 10 },
		{ file: "demo.txt", side: "old", line: 11 },
		{ file: "demo.txt", side: "new", line: 11 },
		{ file: "demo.txt", side: "new", line: 12 },
	]);
	assert.deepEqual(rows.map(({ text }) => text), rendered.split("\n"));
});

test("strips CSI and OSC controls for parsing without changing display rows", () => {
	assert.equal(stripTerminalControls("a\x1b[31mred\x1b[0m\x1b]8;;https://example.test\x07link\x1b]8;;\x07"), "aredlink");
	const rendered = "\x1b[32m10 ⋮ 10 │context\x1b[0m";
	assert.equal(mapDeltaRows("demo.txt", patch, rendered)[0].text, rendered);
	assert.ok(mapDeltaRows("demo.txt", patch, rendered)[0].mapping);
});

test("selected Delta rows retain foreground colors and reapply Pi's background after resets", () => {
	const selected = "\x1b[48;2;1;2;3m";
	const delta = "\x1b[38;2;10;20;30mdeleted\x1b[48;2;200;0;0m+\x1b[0mrest\x1b[49m";
	assert.equal(
		preserveSelectedBackground(delta, selected),
		`\x1b[38;2;10;20;30mdeleted+\x1b[0m${selected}rest`,
	);
});

test("unmappable decorations remain unchanged and do not consume source rows", () => {
	const rendered = ["file header", "10 ⋮ 10 │context", "11 ⋮    │deleted", "    ⋮ 11 │added", "12 ⋮ 12 │end"].join("\n");
	const rows = mapDeltaRows("demo.txt", patch, rendered);
	assert.deepEqual(rows.map(({ mapping }) => mapping ?? null), [
		null,
		{ file: "demo.txt", side: "new", line: 10 },
		{ file: "demo.txt", side: "old", line: 11 },
		{ file: "demo.txt", side: "new", line: 11 },
		{ file: "demo.txt", side: "new", line: 12 },
	]);
});

test("content mismatch, duplicate candidates, and malformed patches fail closed", () => {
	const mismatch = mapDeltaRows("demo.txt", patch, "10 ⋮ 10 │other\n11 ⋮    │deleted");
	assert.deepEqual(mismatch.map(({ mapping }) => mapping), [undefined, undefined]);
	const ambiguous = mapDeltaRows("demo.txt", patch, "10 ⋮ 10 │context\n10 ⋮ 10 │context\n11 ⋮    │deleted");
	assert.deepEqual(ambiguous.map(({ mapping }) => mapping ?? null), [
		{ file: "demo.txt", side: "new", line: 10 }, null, null,
	]);
	assert.equal(parseUnifiedPatch(patch.replace("+added", "+added\n+extra")), null);
	assert.deepEqual(mapDeltaRows("demo.txt", "not a patch", "10 ⋮ 10 │context"), [
		{ text: "10 ⋮ 10 │context" },
	]);
});

test("an extra Delta line candidate prevents speculative remapping after it", () => {
	const rendered = ["10 ⋮ 10 │context", "11 ⋮ 11 │unexpected", "11 ⋮    │deleted", "    ⋮ 11 │added"].join("\n");
	const rows = mapDeltaRows("demo.txt", patch, rendered);
	assert.deepEqual(rows.map(({ mapping }) => mapping ?? null), [
		{ file: "demo.txt", side: "new", line: 10 }, null, null, null,
	]);
});

test("renamed-file rows retain the path belonging to their old or new side", () => {
	const rendered = [
		"10 ⋮ 10 │context",
		"11 ⋮    │deleted",
		"    ⋮ 11 │added",
		"12 ⋮ 12 │end",
	].join("\n");
	const rows = mapDeltaRows("after/demo.txt", patch, rendered, {
		oldFile: "before/demo.txt",
		newFile: "after/demo.txt",
	});
	assert.deepEqual(rows.map(({ mapping }) => mapping ?? null), [
		{ file: "after/demo.txt", side: "new", line: 10 },
		{ file: "before/demo.txt", side: "old", line: 11 },
		{ file: "after/demo.txt", side: "new", line: 11 },
		{ file: "after/demo.txt", side: "new", line: 12 },
	]);
});

test("maps real Delta normal output, including its hunk decorations and ANSI resets", {
	skip: spawnSync("delta", ["--version"], { stdio: "ignore" }).status !== 0,
}, () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-delta-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "demo.txt"), "context\ndeleted\nend\n");
		execFileSync("git", ["add", "demo.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"], { cwd });
		writeFileSync(join(cwd, "demo.txt"), "context\nadded\nend\n");
		const source = execFileSync("git", ["--no-pager", "diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--"], { cwd, encoding: "utf8" });
		const delta = spawnSync("delta", ["--paging", "never", "--line-numbers", "--width", "100"], { cwd, input: source, encoding: "utf8" });
		assert.equal(delta.status, 0, delta.stderr);
		const rows = mapDeltaRows("demo.txt", source, delta.stdout, { oldFile: "demo.txt", newFile: "demo.txt" });
		assert.ok(rows.some(({ mapping }) => mapping?.side === "old" && mapping.line === 2));
		assert.ok(rows.some(({ mapping }) => mapping?.side === "new" && mapping.line === 2));
		assert.ok(rows.some(({ mapping }) => mapping?.side === "new" && mapping.line === 3));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
