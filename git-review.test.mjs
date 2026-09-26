import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadSnapshot, verifyPatchChanges } from "./git-review.ts";
import { stripTerminalControls } from "./delta-map.ts";

const hasDelta = spawnSync("delta", ["--version"], { stdio: "ignore" }).status === 0;

function repo() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-git-"));
	execFileSync("git", ["init", "-q"], { cwd });
	return cwd;
}

function commit(cwd, message = "fixture") {
	execFileSync("git", ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", message], { cwd });
}

function mapped(section, file, side, line) {
	return section.rows.some(({ mapping }) => mapping?.file === file && mapping.side === side && mapping.line === line);
}

test("Git metadata must agree with both patch header and old/new text markers", () => {
	const change = { status: "M", oldFile: "expected.txt", newFile: "expected.txt", isSubmodule: false };
	const patch = "diff --git a/expected.txt b/expected.txt\n--- a/expected.txt\n+++ b/expected.txt\n@@ -1 +1 @@\n-old\n+new\n";
	assert.doesNotThrow(() => verifyPatchChanges([change], [patch]));
	assert.throws(() => verifyPatchChanges([change], []), /metadata and patch disagree/);
	assert.throws(() => verifyPatchChanges([change], [patch.replace("diff --git a/expected.txt", "diff --git a/other.txt")]), /refusing line annotations/);
	assert.throws(() => verifyPatchChanges([change], [patch.replace("+++ b/expected.txt", "+++ b/other.txt")]), /refusing line annotations/);
	assert.throws(() => verifyPatchChanges([change], [patch.replace("--- a/expected.txt", "--- a/other.txt")]), /refusing line annotations/);
	assert.throws(() => verifyPatchChanges([{ ...change, oldFile: 'odd"name.txt' }], ['diff --git "a/odd"name.txt" b/expected.txt\n']), /refusing line annotations/);
});

test("quoted rename/deletion and untracked paths are verified end-to-end", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "old space.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
		writeFileSync(join(cwd, "gone\nline.txt"), "first\nsecond\n");
		execFileSync("git", ["add", "--all"], { cwd });
		commit(cwd);
		execFileSync("git", ["mv", "old space.txt", 'new "name".txt'], { cwd });
		writeFileSync(join(cwd, 'new "name".txt'), "one\ntwo\nthree\nfour\nchanged\nsix\n");
		execFileSync("git", ["rm", "-q", "gone\nline.txt"], { cwd });
		writeFileSync(join(cwd, "added\tfile.txt"), "fresh\n");
		writeFileSync(join(cwd, "caf\u00e9.txt"), "unicode\n");
		execFileSync("git", ["config", "core.quotePath", "true"], { cwd });
		execFileSync("git", ["config", "diff.noprefix", "true"], { cwd });
		const sections = (await loadSnapshot(cwd, 100)).sections;
		const renamed = sections.find((section) => section.oldFile === "old space.txt");
		assert.equal(renamed?.newFile, 'new "name".txt');
		assert.ok(mapped(renamed, "old space.txt", "old", 5));
		assert.ok(mapped(renamed, 'new "name".txt', "new", 5));
		assert.ok(mapped(sections.find((section) => section.oldFile === "gone\nline.txt"), "gone\nline.txt", "old", 1));
		assert.ok(mapped(sections.find((section) => section.newFile === "added\tfile.txt"), "added\tfile.txt", "new", 1));
		assert.ok(mapped(sections.find((section) => section.newFile === "caf\u00e9.txt"), "caf\u00e9.txt", "new", 1));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Git diff context configuration survives canonical patch capture", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "context.txt"), "one\ntwo\nthree\nfour\nfive\n");
		execFileSync("git", ["add", "context.txt"], { cwd });
		commit(cwd);
		execFileSync("git", ["config", "diff.context", "1"], { cwd });
		execFileSync("git", ["config", "diff.algorithm", "histogram"], { cwd });
		writeFileSync(join(cwd, "context.txt"), "one\ntwo\nchanged\nfour\nfive\n");
		const section = (await loadSnapshot(cwd, 100)).sections[0];
		assert.match(section.patch, /@@ -2,3 \+2,3 @@/);
		assert.ok(mapped(section, "context.txt", "new", 3));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("submodule modes stay file-commentable without line anchors", { skip: !hasDelta }, async () => {
	const cwd = repo();
	const modulePath = join(cwd, "module");
	try {
		mkdirSync(modulePath);
		execFileSync("git", ["init", "-q"], { cwd: modulePath });
		writeFileSync(join(modulePath, "inner.txt"), "first\n");
		execFileSync("git", ["add", "inner.txt"], { cwd: modulePath });
		commit(modulePath);
		execFileSync("git", ["add", "module"], { cwd, stdio: "ignore" });
		commit(cwd);
		writeFileSync(join(modulePath, "inner.txt"), "second\n");
		execFileSync("git", ["add", "inner.txt"], { cwd: modulePath });
		commit(modulePath);
		execFileSync("git", ["config", "diff.submodule", "diff"], { cwd });
		const section = (await loadSnapshot(cwd, 100)).sections.find(({ newFile }) => newFile === "module");
		assert.ok(section?.isSubmodule);
		assert.equal(section.rows.some(({ mapping }) => mapping), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Delta absence reports its requirement instead of falling back", async () => {
	const cwd = repo();
	const bin = mkdtempSync(join(tmpdir(), "pi-review-bin-"));
	const originalPath = process.env.PATH;
	try {
		writeFileSync(join(cwd, "demo.txt"), "before\n");
		execFileSync("git", ["add", "demo.txt"], { cwd });
		commit(cwd);
		writeFileSync(join(cwd, "demo.txt"), "after\n");
		const gitDirectory = (originalPath ?? "").split(delimiter).find((directory) => spawnSync(join(directory, "git"), ["--version"], { stdio: "ignore" }).status === 0);
		assert.ok(gitDirectory);
		symlinkSync(resolve(gitDirectory, "git"), join(bin, "git"));
		process.env.PATH = bin;
		await assert.rejects(loadSnapshot(cwd, 100), /Delta is required/);
	} finally {
		process.env.PATH = originalPath;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("source terminal controls render as literal text while line mapping remains verified", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "controls.txt"), "before\nold line\n");
		execFileSync("git", ["add", "controls.txt"], { cwd });
		commit(cwd);
		writeFileSync(join(cwd, "controls.txt"), "before\nnew \x1b[8mhidden\x1b[0m c1 \u009b31m cr\rreturn\n");
		const snapshot = await loadSnapshot(cwd, 100);
		const section = snapshot.sections[0];
		const added = section.rows.find(({ mapping }) => mapping?.side === "new" && mapping.line === 2);
		assert.ok(added?.mapping, "sanitize source controls without losing the verified line anchor");
		const plain = stripTerminalControls(added.text);
		assert.ok(plain.includes("\\x1b[8mhidden\\x1b[0m"));
		assert.ok(plain.includes("\\x9b31m"));
		assert.ok(plain.includes("\\x0dreturn"));
		assert.doesNotMatch(plain, /[\x1b\u0080-\u009f]/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("caps changed sections before launching per-file diffs", async () => {
	const cwd = repo();
	try {
		for (let index = 0; index < 257; index++) {
			writeFileSync(join(cwd, `untracked-${index}.txt`), "content\n");
		}
		await assert.rejects(loadSnapshot(cwd, 100), /256-section limit/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("collects a tracked diff and maps added and removed rows against Git", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "demo.txt"), "before\ndeleted\nafter\n");
		execFileSync("git", ["add", "demo.txt"], { cwd });
		commit(cwd);
		writeFileSync(join(cwd, "demo.txt"), "before\nadded\nafter\n");
		const snapshot = await loadSnapshot(cwd, 100);
		assert.equal(snapshot.sections.length, 1);
		const [section] = snapshot.sections;
		assert.equal(section.oldFile, "demo.txt");
		assert.equal(section.newFile, "demo.txt");
		assert.ok(mapped(section, "demo.txt", "old", 2));
		assert.ok(mapped(section, "demo.txt", "new", 2));
		assert.ok(section.rows.some(({ text }) => stripTerminalControls(text).includes("added")));
		assert.ok(section.rows.some(({ text }) => text.includes("\x1b[")), "retain Delta SGR sequences for Pi's TUI renderer");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("renames use old/new paths and untracked or binary files fall back to file comments", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "before.txt"), "one\ntwo\nthree\nfour\nfive\n");
		execFileSync("git", ["add", "before.txt"], { cwd });
		commit(cwd);
		execFileSync("git", ["mv", "before.txt", "after.txt"], { cwd });
		writeFileSync(join(cwd, "after.txt"), "one\nchanged\nthree\nfour\nfive\n");
		writeFileSync(join(cwd, "untracked.txt"), "first\nsecond\n");
		writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3, 0]));
		const snapshot = await loadSnapshot(cwd, 100);
		const renamed = snapshot.sections.find((section) => section.oldFile === "before.txt");
		assert.ok(renamed, "Git should identify the rename");
		assert.equal(renamed.newFile, "after.txt");
		assert.ok(mapped(renamed, "before.txt", "old", 2));
		assert.ok(mapped(renamed, "after.txt", "new", 2));
		const untracked = snapshot.sections.find((section) => section.newFile === "untracked.txt");
		assert.ok(untracked);
		assert.ok(untracked.label.startsWith("untracked · added · untracked.txt"));
		assert.ok(mapped(untracked, "untracked.txt", "new", 1));
		const binary = snapshot.sections.find((section) => section.newFile === "binary.dat");
		assert.ok(binary);
		assert.equal(binary.rows.some(({ mapping }) => mapping), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("unborn repositories present staged, unstaged, and untracked changes without mixing anchors", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "staged.txt"), "index version\n");
		execFileSync("git", ["add", "staged.txt"], { cwd });
		writeFileSync(join(cwd, "staged.txt"), "working tree version\n");
		writeFileSync(join(cwd, "loose.txt"), "untracked\n");
		const snapshot = await loadSnapshot(cwd, 100);
		assert.ok(snapshot.sections.some((section) => section.label.startsWith("staged · added · staged.txt")));
		assert.ok(snapshot.sections.some((section) => section.label.startsWith("worktree · modified · staged.txt")));
		assert.ok(snapshot.sections.some((section) => section.newFile === "loose.txt"));
		assert.equal(new Set(snapshot.sections.map((section) => section.key)).size, snapshot.sections.length);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleted files retain old-side mappings", { skip: !hasDelta }, async () => {
	const cwd = repo();
	try {
		mkdirSync(join(cwd, "nested"));
		writeFileSync(join(cwd, "nested", "gone.txt"), "first\nsecond\n");
		execFileSync("git", ["add", "nested/gone.txt"], { cwd });
		commit(cwd);
		execFileSync("git", ["rm", "-q", "nested/gone.txt"], { cwd });
		const snapshot = await loadSnapshot(cwd, 100);
		const deleted = snapshot.sections.find((section) => section.oldFile === "nested/gone.txt");
		assert.ok(deleted);
		assert.equal(deleted.newFile, null);
		assert.ok(mapped(deleted, "nested/gone.txt", "old", 1));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
