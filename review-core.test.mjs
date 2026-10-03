import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCommentFollowUp,
	draftTargetKey,
	keepCursorVisible,
	reconcileDrafts,
	removeDraft,
	resolveReviewAction,
	reviewLayout,
	shortenPath,
	updateDrafts,
	VALIDATION_FOLLOW_UP,
} from "./review-core.ts";

const lineTarget = {
	kind: "line",
	sectionKey: "src/a.ts",
	file: "src/a.ts",
	side: "old",
	line: 8,
	patchHash: "patch-1",
};

const section = {
	key: "src/a.ts",
	patchHash: "patch-1",
	rows: [{ text: "removed", mapping: { file: "src/a.ts", side: "old", line: 8 } }],
};

test("viewport scrolls only when the cursor passes the visible edge", () => {
	assert.equal(keepCursorVisible(0, 3, 20, 4), 0);
	assert.equal(keepCursorVisible(0, 4, 20, 4), 1);
	assert.equal(keepCursorVisible(1, 3, 20, 4), 1);
	assert.equal(keepCursorVisible(1, 1, 20, 4), 1);
	assert.equal(keepCursorVisible(1, 0, 20, 4), 0);
	assert.equal(keepCursorVisible(17, 19, 20, 4), 16);
});

test("layout gives the diff a sidebar only when both columns stay usable", () => {
	assert.deepEqual(reviewLayout(40), { sidebarWidth: 0, bodyWidth: 40 });
	assert.deepEqual(reviewLayout(75), { sidebarWidth: 0, bodyWidth: 75 });
	assert.deepEqual(reviewLayout(100), { sidebarWidth: 28, bodyWidth: 71 });
	assert.deepEqual(reviewLayout(200), { sidebarWidth: 28, bodyWidth: 171 });
	assert.deepEqual(reviewLayout(76), { sidebarWidth: 21, bodyWidth: 54 });
	for (const width of [76, 90, 100, 200, 500]) {
		const { sidebarWidth, bodyWidth } = reviewLayout(width);
		assert.equal(sidebarWidth + bodyWidth + 1, width);
		assert.ok(sidebarWidth >= 18 && sidebarWidth <= 28, `sidebar width ${sidebarWidth}`);
		assert.ok(bodyWidth >= 48, `body width ${bodyWidth}`);
	}
});

test("paths are shortened from the left so the file name survives", () => {
	assert.equal(shortenPath("src/a.ts", 12), "src/a.ts");
	assert.equal(shortenPath("a/very/long/path/to/some/file.ts", 14), "…/some/file.ts");
	assert.equal(shortenPath("a/very/long/path/to/some/file.ts", 12), "…/file.ts");
	assert.equal(shortenPath("abcdefghijklmnopqrstuvwxyz", 6), "…vwxyz");
	assert.equal(shortenPath("a/b.ts", 1), "…");
	assert.equal(shortenPath("a/b.ts", 0), "");
});

test("drafts upsert by exact target, retain IDs, and blank edits remove", () => {
	const first = updateDrafts([], lineTarget, "  Please check this.  ", () => "draft-1");
	assert.equal(first[0].id, "draft-1");
	assert.equal(first[0].text, "Please check this.");
	const edited = updateDrafts(first, lineTarget, "Updated comment", () => "unused");
	assert.equal(edited[0].id, "draft-1");
	assert.equal(edited[0].text, "Updated comment");
	assert.deepEqual(updateDrafts(edited, lineTarget, "  ", () => "unused"), []);
});

test("stale anchors are retained and require an exact section hash and mapping", () => {
	const draft = { ...lineTarget, id: "draft-1", text: "Review me" };
	assert.equal(reconcileDrafts([draft], [section])[0].stale, false);
	assert.equal(reconcileDrafts([draft], [{ ...section, patchHash: "patch-2" }])[0].stale, true);
	assert.equal(reconcileDrafts([draft], [{ ...section, rows: [] }])[0].stale, true);
	assert.equal(reconcileDrafts([draft], [])[0].stale, true);
});

test("file comments stay file-level and become stale if that file patch changes", () => {
	const draft = {
		id: "draft-file",
		kind: "file",
		sectionKey: "src/a.ts",
		file: "src/a.ts",
		patchHash: "patch-1",
		text: "Review the module",
	};
	assert.equal(reconcileDrafts([draft], [section])[0].stale, false);
	assert.equal(reconcileDrafts([draft], [{ ...section, patchHash: "patch-2" }])[0].stale, true);
	assert.notEqual(draftTargetKey(draft), draftTargetKey(lineTarget));
});

test("comment follow-up applies optional configuration and keeps generated comments", () => {
	const prepend = "Start with this context.\n\n";
	const append = "\n\n---\n\nEnd with this instruction.";
	const draft = { ...lineTarget, id: "draft-1", text: "Check the deleted behavior.\nIt may regress." };
	const promptConfig = { prepend, append, comments: "Custom review instructions.", validation: "Custom validation." };
	const prompt = buildCommentFollowUp([draft], promptConfig);
	assert.ok(prompt.startsWith(`${prepend}Custom review instructions.\n\n## Review comments\n\n`));
	assert.match(prompt, /old\/deleted side, line 8/);
	assert.match(prompt, /> Check the deleted behavior\.\n> It may regress\./);
	assert.ok(prompt.endsWith(append));
	assert.doesNotMatch(prompt, /I reviewed the current changes manually/);
	const defaultPrompt = buildCommentFollowUp([draft]);
	assert.match(defaultPrompt, /I reviewed the current changes manually/);
	assert.match(defaultPrompt, /discuss discrepancies before editing/i);
	assert.equal(buildCommentFollowUp([draft], { prepend: null, append: null, comments: null }), defaultPrompt);
	assert.doesNotMatch(prompt, /no changes requested/i);
});

test("validation prompt is the agreed Plannotator default", () => {
	assert.equal(VALIDATION_FOLLOW_UP, "# Code Review\n\nCode review completed — no changes requested.");
});

test("explicit close sends nothing; comments and validation use their respective configuration", () => {
	const draft = { ...lineTarget, id: "draft-1", text: "Review me" };
	const promptConfig = {
		prepend: "Review context.\n\n",
		append: "\n\nCustom ending.",
		comments: "Custom comment instructions.",
		validation: "Custom validation message.",
	};
	assert.deepEqual(resolveReviewAction("close", [draft], [section]), { kind: "close" });
	const comments = resolveReviewAction("send", [draft], [section], promptConfig);
	assert.equal(comments.kind, "send-comments");
	assert.ok(comments.kind === "send-comments" && comments.message.startsWith("Review context.\n\nCustom comment instructions."));
	assert.ok(comments.kind === "send-comments" && comments.message.endsWith(promptConfig.append));
	assert.deepEqual(resolveReviewAction("send", [], [section], promptConfig), {
		kind: "validate", message: "Custom validation message.",
	});
	assert.deepEqual(resolveReviewAction("send", [], [section]), { kind: "validate", message: VALIDATION_FOLLOW_UP });
	assert.deepEqual(resolveReviewAction("send", [draft], [{ ...section, patchHash: "changed" }]), {
		kind: "blocked", reason: "stale", count: 1,
	});
	assert.deepEqual(resolveReviewAction("send", [], []), { kind: "blocked", reason: "empty" });
});

test("removing a comment deletes only the selected draft", () => {
	const first = { id: "first", kind: "file", sectionKey: "a", file: "a.txt", patchHash: "a", text: "one" };
	const second = { id: "second", kind: "file", sectionKey: "b", file: "b.txt", patchHash: "b", text: "two" };
	assert.deepEqual(removeDraft([first, second], first.id), [second]);
	assert.deepEqual(removeDraft([second], "missing"), [second]);
});
