import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapDeltaRows, parseUnifiedPatch, preserveSelectedBackground, stripTerminalControls } from "./delta-map.ts";

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
		{ kind: "context", oldLine: 10, newLine: 10, content: "context" },
		{ kind: "delete", oldLine: 11, content: "deleted" },
		{ kind: "add", newLine: 11, content: "added" },
		{ kind: "context", oldLine: 12, newLine: 12, content: "end" },
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

test("multiple hunks map in order without assigning anchors to decorations", () => {
	const source = `diff --git a/multi.txt b/multi.txt
--- a/multi.txt
+++ b/multi.txt
@@ -1 +1 @@
-old
+new
@@ -20 +20 @@
-later
+latest`;
	const delta = "file header\n1 ⋮    │old\n    ⋮ 1 │new\nhunk decoration\n20 ⋮    │later\n    ⋮ 20 │latest";
	assert.deepEqual(mapDeltaRows("multi.txt", source, delta).map(({ mapping }) => mapping?.line ?? null), [null, 1, 1, null, 20, 20]);
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

test("maps tab-indented rows using Delta's configured tab width without guessing other content", {
	skip: spawnSync("delta", ["--version"], { stdio: "ignore" }).status !== 0,
}, () => {
	const source = `diff --git a/tabs.txt b/tabs.txt
index 1111111..2222222 100644
--- a/tabs.txt
+++ b/tabs.txt
@@ -1,3 +1,3 @@
 \tcontext\tmore
-\told
+\tnew
 tail`;
	for (const width of [0, 2, 8]) {
		const rendered = spawnSync("delta", ["--paging", "never", "--line-numbers", "--width", "100", "--tabs", String(width)], {
			input: source, encoding: "utf8",
		});
		assert.equal(rendered.status, 0, rendered.stderr);
		const rows = mapDeltaRows("tabs.txt", source, rendered.stdout);
		assert.deepEqual(rows.filter(({ mapping }) => mapping).map(({ mapping }) => [mapping.side, mapping.line]), [
			["new", 1], ["old", 2], ["new", 2], ["new", 3],
		]);
	}
});

test("tab expansion must match the whole row at one consistent width", () => {
	const source = `diff --git a/tabs.txt b/tabs.txt
--- a/tabs.txt
+++ b/tabs.txt
@@ -1,3 +1,3 @@
 \tfirst
-\told
+\tnew
 tail`;
	const inconsistent = "1 ⋮ 1 │  first\n2 ⋮   │    old\n   ⋮ 2 │    new\n3 ⋮ 3 │tail";
	assert.deepEqual(mapDeltaRows("tabs.txt", source, inconsistent).map(({ mapping }) => mapping?.line ?? null), [1, null, null, null]);
	const changedText = "1 ⋮ 1 │  first\n2 ⋮   │  wrong\n   ⋮ 2 │  new";
	assert.deepEqual(mapDeltaRows("tabs.txt", source, changedText).map(({ mapping }) => mapping?.line ?? null), [1, null, null]);
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
