import type { DeltaRow } from "./delta-map.ts";
import type { ReviewPromptConfig } from "./review-config.ts";

export type ReviewDraft = {
	id: string;
	kind: "file" | "line";
	sectionKey: string;
	file: string;
	side?: "old" | "new";
	line?: number;
	patchHash: string;
	text: string;
};

export type ReviewTarget = Omit<ReviewDraft, "id" | "text">;

export type ReviewSectionState = {
	key: string;
	patchHash: string;
	rows: DeltaRow[];
};

export type ResolvedDraft = ReviewDraft & { stale: boolean };

export type ReviewActionResult =
	| { kind: "close" }
	| { kind: "blocked"; reason: "stale" | "empty"; count?: number }
	| { kind: "send-comments"; message: string }
	| { kind: "validate"; message: string };

export const VALIDATION_FOLLOW_UP = "# Code Review\n\nCode review completed — no changes requested.";

const DEFAULT_COMMENT_INSTRUCTIONS = `# Code Review

I reviewed the current changes manually. Address the review comments below.

Treat each comment as unverified review input. Inspect it against the actual code; do not assume it is correct. For every comment, give a clear verdict (Confirmed / Partly / Not a bug / Intended) with concise code evidence, and say whether it was introduced by the current changes, pre-existing, or reflects deliberate scope. Review only the submitted comments; do not independently review the rest of the diff or search for issues that were not submitted.

Do not change any code until we have discussed the verdicts and validated the findings. Discuss discrepancies before editing. Apply only changes I authorize, keep them within scope, follow existing project conventions and simplicity, leave unrelated code untouched, and verify the result according to the project's instructions.`;

function escapePath(path: string): string {
	return JSON.stringify(path);
}

function quoteComment(text: string): string {
	return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

export function buildCommentFollowUp(
	drafts: ReviewDraft[],
	promptConfig: Partial<ReviewPromptConfig> = {},
): string {
	const comments = drafts.map((draft, index) => {
		const location = draft.kind === "file"
			? `File: ${escapePath(draft.file)}`
			: `File: ${escapePath(draft.file)}\nLocation: ${draft.side === "old" ? "old/deleted" : "new/current"} side, line ${draft.line}`;
		return `### Comment ${index + 1}\n${location}\nComment:\n${quoteComment(draft.text)}`;
	}).join("\n\n");

	return `${promptConfig.prepend ?? ""}${promptConfig.comments ?? DEFAULT_COMMENT_INSTRUCTIONS}\n\n## Review comments\n\n${comments}${promptConfig.append ?? ""}`;
}

export function draftTargetKey(target: ReviewTarget): string {
	return target.kind === "file"
		? `${target.sectionKey}\0file\0${target.file}`
		: `${target.sectionKey}\0line\0${target.file}\0${target.side}\0${target.line}`;
}

export function updateDrafts(
	drafts: ReviewDraft[],
	target: ReviewTarget,
	text: string,
	newId: () => string,
): ReviewDraft[] {
	const key = draftTargetKey(target);
	const existing = drafts.find((draft) => draftTargetKey(draft) === key);
	const cleanedText = text.trim();
	if (!cleanedText) return drafts.filter((draft) => draftTargetKey(draft) !== key);
	const next: ReviewDraft = { ...target, id: existing?.id ?? newId(), text: cleanedText };
	return existing
		? drafts.map((draft) => draft.id === existing.id ? next : draft)
		: [...drafts, next];
}

export function removeDraft(drafts: ReviewDraft[], id: string): ReviewDraft[] {
	return drafts.filter((draft) => draft.id !== id);
}

export const SIDEBAR_MIN_WIDTH = 18;
export const SIDEBAR_MAX_WIDTH = 28;
export const SIDEBAR_SEPARATOR_WIDTH = 1;
export const SIDEBAR_MIN_TOTAL_WIDTH = 76;
export const SIDEBAR_MIN_BODY_WIDTH = 48;

export type ReviewLayout = { sidebarWidth: number; bodyWidth: number };

/**
 * Split the viewport into a file sidebar and a diff body. Narrow terminals keep the
 * whole width for the diff, because Delta is rendered for the body width and a body
 * that is too narrow would truncate source lines.
 */
export function reviewLayout(totalWidth: number): ReviewLayout {
	const width = Math.max(1, Math.floor(totalWidth));
	const full = { sidebarWidth: 0, bodyWidth: width };
	if (width < SIDEBAR_MIN_TOTAL_WIDTH) return full;
	const sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.floor(width * 0.28)));
	const bodyWidth = width - sidebarWidth - SIDEBAR_SEPARATOR_WIDTH;
	return bodyWidth < SIDEBAR_MIN_BODY_WIDTH ? full : { sidebarWidth, bodyWidth };
}

export type SidebarEntry = {
	depth: number;
	label: string;
	isDirectory: boolean;
	/** Section index for a file entry, or null for a plain directory. */
	sectionIndex: number | null;
};

type TreeNode = {
	name: string;
	/** null marks a file; a Map marks a directory. */
	children: Map<string, TreeNode> | null;
	sectionIndex: number;
};

function nodeAt(level: Map<string, TreeNode>, name: string, isFile: boolean, sectionIndex: number): TreeNode {
	const existing = level.get(name);
	if (!existing) {
		const node: TreeNode = { name, children: isFile ? null : new Map(), sectionIndex: isFile ? sectionIndex : -1 };
		level.set(name, node);
		return node;
	}
	if (isFile) {
		existing.children = null;
		existing.sectionIndex = sectionIndex;
	} else if (existing.children === null) {
		// A changed file shares this name with a directory that also holds changes.
		// Git cannot normally produce this; keep both reachable rather than dropping one.
		existing.children = new Map();
	}
	return existing;
}

/**
 * Flatten changed paths into an always-expanded folder tree. Siblings keep the order in
 * which they first appear in the diff, so the staged-before-untracked grouping survives
 * at folder level. Labels are single path segments: the folder is implied by nesting.
 */
export function sidebarEntries(paths: string[]): SidebarEntry[] {
	const root = new Map<string, TreeNode>();
	for (let sectionIndex = 0; sectionIndex < paths.length; sectionIndex++) {
		const segments = paths[sectionIndex].split("/").filter((segment) => segment.length > 0);
		if (segments.length === 0) continue;
		let level = root;
		for (let depth = 0; depth < segments.length - 1; depth++) {
			level = nodeAt(level, segments[depth], false, -1).children!;
		}
		nodeAt(level, segments[segments.length - 1], true, sectionIndex);
	}
	const entries: SidebarEntry[] = [];
	const walk = (level: Map<string, TreeNode>, depth: number): void => {
		for (const node of level.values()) {
			const isDirectory = node.children !== null;
			entries.push({
				depth,
				label: node.name,
				isDirectory,
				sectionIndex: isDirectory ? (node.sectionIndex >= 0 ? node.sectionIndex : null) : node.sectionIndex,
			});
			if (isDirectory) walk(node.children!, depth + 1);
		}
	};
	walk(root, 0);
	return entries;
}

export function keepCursorVisible(scrollStart: number, cursor: number, rowCount: number, viewportHeight: number): number {
	const maxStart = Math.max(0, rowCount - Math.max(viewportHeight, 1));
	const currentStart = Math.max(0, Math.min(scrollStart, maxStart));
	if (viewportHeight <= 0) return currentStart;
	if (cursor < currentStart) return Math.max(0, cursor);
	if (cursor >= currentStart + viewportHeight) return Math.min(maxStart, cursor - viewportHeight + 1);
	return currentStart;
}

export function reconcileDrafts(drafts: ReviewDraft[], sections: ReviewSectionState[]): ResolvedDraft[] {
	const sectionsByKey = new Map(sections.map((section) => [section.key, section] as const));
	const mappedLines = new Set<string>();
	for (const section of sections) {
		for (const { mapping } of section.rows) {
			if (!mapping) continue;
			mappedLines.add(draftTargetKey({
				kind: "line",
				sectionKey: section.key,
				file: mapping.file,
				side: mapping.side,
				line: mapping.line,
				patchHash: section.patchHash,
			}));
		}
	}
	return drafts.map((draft) => {
		const section = sectionsByKey.get(draft.sectionKey);
		const stale = !section || section.patchHash !== draft.patchHash ||
			(draft.kind === "line" && !mappedLines.has(draftTargetKey(draft)));
		return { ...draft, stale };
	});
}

export function resolveReviewAction(
	action: "close",
	drafts: ReviewDraft[],
	sections: ReviewSectionState[],
	promptConfig?: Partial<ReviewPromptConfig>,
): Extract<ReviewActionResult, { kind: "close" }>;
export function resolveReviewAction(
	action: "send",
	drafts: ReviewDraft[],
	sections: ReviewSectionState[],
	promptConfig?: Partial<ReviewPromptConfig>,
): Exclude<ReviewActionResult, { kind: "close" }>;
export function resolveReviewAction(
	action: "close" | "send",
	drafts: ReviewDraft[],
	sections: ReviewSectionState[],
	promptConfig: Partial<ReviewPromptConfig> = {},
): ReviewActionResult {
	if (action === "close") return { kind: "close" };
	const staleCount = reconcileDrafts(drafts, sections).filter((draft) => draft.stale).length;
	if (staleCount > 0) return { kind: "blocked", reason: "stale", count: staleCount };
	if (sections.length === 0) return { kind: "blocked", reason: "empty" };
	return drafts.length > 0
		? { kind: "send-comments", message: buildCommentFollowUp(drafts, promptConfig) }
		: { kind: "validate", message: promptConfig.validation ?? VALIDATION_FOLLOW_UP };
}
