import { randomUUID } from "node:crypto";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadSnapshot, type ReviewSection, type ReviewSnapshot } from "./git-review.ts";
import { loadReviewPromptConfig, type ReviewPromptConfig } from "./review-config.ts";
import { preserveSelectedBackground, stripTerminalControls } from "./delta-map.ts";
import {
	draftTargetKey,
	keepCursorVisible,
	reconcileDrafts,
	removeDraft,
	resolveReviewAction,
	reviewLayout,
	sidebarEntries,
	updateDrafts,
	type ResolvedDraft,
	type ReviewDraft,
	type ReviewTarget,
	type SidebarEntry,
} from "./review-core.ts";

const DRAFT_ENTRY_TYPE = "pi-review.drafts.v1";
const COMMENT_EDITOR_HINT = "Enter saves · Shift+Enter/Ctrl+J adds a line · Esc cancels";

type DraftRecord = {
	version: 1;
	repoRoot: string;
	sessionId: string;
	drafts: ReviewDraft[];
};

type ReviewResult = { action: "close" } | { action: "submit"; message: string; clearDrafts: boolean; repoRoot: string };

type ReviewRow =
	| { kind: "file"; sectionIndex: number }
	| { kind: "delta"; sectionIndex: number; deltaIndex: number }
	| { kind: "comment"; sectionIndex: number; draftId: string }
	| { kind: "draft"; draftId: string }
	| { kind: "info"; id: string; text: string };

function validDraft(value: unknown): value is ReviewDraft {
	if (!value || typeof value !== "object") return false;
	const draft = value as Partial<ReviewDraft>;
	return typeof draft.id === "string" &&
		(draft.kind === "file" || draft.kind === "line") &&
		typeof draft.sectionKey === "string" &&
		typeof draft.file === "string" &&
		typeof draft.patchHash === "string" &&
		typeof draft.text === "string" &&
		(draft.kind !== "line" || ((draft.side === "old" || draft.side === "new") && Number.isInteger(draft.line)));
}

function loadDrafts(ctx: ExtensionCommandContext, repoRoot: string): ReviewDraft[] {
	const sessionId = ctx.sessionManager.getSessionId();
	let latest: ReviewDraft[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DRAFT_ENTRY_TYPE) continue;
		const record = entry.data as Partial<DraftRecord> | undefined;
		if (record?.version !== 1 || record.repoRoot !== repoRoot || record.sessionId !== sessionId || !Array.isArray(record.drafts)) continue;
		latest = record.drafts.filter(validDraft);
	}
	return latest;
}

function saveDrafts(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	drafts: ReviewDraft[],
): boolean {
	try {
		pi.appendEntry(DRAFT_ENTRY_TYPE, {
			version: 1,
			repoRoot,
			sessionId: ctx.sessionManager.getSessionId(),
			drafts,
		} satisfies DraftRecord);
		return true;
	} catch (error) {
		console.error("[pi-review] Could not persist review drafts", error);
		return false;
	}
}

function safePlainText(text: string): string {
	return stripTerminalControls(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ");
}

function createReviewEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function targetDescription(target: ReviewTarget): string {
	const file = safePlainText(target.file);
	return target.kind === "file"
		? `file ${file}`
		: `${target.side === "old" ? "old/deleted line" : "current line"} ${target.line} · ${file}`;
}

function excerpt(text: string, maxLength = 90): string {
	const flat = safePlainText(text);
	return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

function targetFromRow(row: ReviewRow, sections: ReviewSection[]): ReviewTarget | undefined {
	if (row.kind === "file") {
		const section = sections[row.sectionIndex];
		if (!section) return undefined;
		return {
			kind: "file",
			sectionKey: section.key,
			file: section.newFile ?? section.oldFile ?? section.displayFile,
			patchHash: section.patchHash,
		};
	}
	if (row.kind !== "delta") return undefined;
	const section = sections[row.sectionIndex];
	const delta = section?.rows[row.deltaIndex];
	if (!section || !delta?.mapping) return undefined;
	return {
		kind: "line",
		sectionKey: section.key,
		file: delta.mapping.file,
		side: delta.mapping.side,
		line: delta.mapping.line,
		patchHash: section.patchHash,
	};
}

function ancestorLines(entries: SidebarEntry[], activeLine: number | undefined): Set<number> {
	const ancestors = new Set<number>();
	if (activeLine === undefined) return ancestors;
	let depth = entries[activeLine].depth;
	for (let index = activeLine - 1; index >= 0 && depth > 0; index--) {
		if (entries[index].isDirectory && entries[index].depth === depth - 1) {
			ancestors.add(index);
			depth--;
		}
	}
	return ancestors;
}

function activeSectionIndex(rows: ReviewRow[], cursor: number): number | undefined {
	const row = rows[cursor];
	return row && (row.kind === "file" || row.kind === "delta" || row.kind === "comment") ? row.sectionIndex : undefined;
}

function rowIdentity(row: ReviewRow | undefined, sections: ReviewSection[]): string {
	if (!row) return "";
	if (row.kind === "file") return `file:${sections[row.sectionIndex]?.key ?? row.sectionIndex}`;
	if (row.kind === "delta") {
		const section = sections[row.sectionIndex];
		const mapping = section?.rows[row.deltaIndex]?.mapping;
		return mapping
			? `line:${section?.key}:${mapping.file}:${mapping.side}:${mapping.line}`
			: `delta:${section?.key}:${row.deltaIndex}`;
	}
	if (row.kind === "draft" || row.kind === "comment") return `draft:${row.draftId}`;
	return `info:${row.id}`;
}

class ReviewScreen implements Component {
	private drafts: ReviewDraft[];
	private cursor = 0;
	private scrollOffset = 0;
	private sidebarScroll = 0;
	private busy = false;
	private message = "";
	private pendingConfirmation: "comments" | "validation" | null = null;
	private commentEditor: Editor | null = null;
	private commentTarget: ReviewTarget | null = null;
	private snapshot: ReviewSnapshot;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionCommandContext,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result: ReviewResult) => void,
		snapshot: ReviewSnapshot,
		drafts: ReviewDraft[],
		private readonly reviewPromptConfig: ReviewPromptConfig,
	) {
		this.snapshot = snapshot;
		this.drafts = drafts;
	}

	invalidate(): void {}

	private resolvedDrafts(): ResolvedDraft[] {
		return reconcileDrafts(this.drafts, this.snapshot.sections);
	}

	private buildRows(resolved = this.resolvedDrafts()): ReviewRow[] {
		const rows: ReviewRow[] = [];
		const fileComments = new Map<string, ResolvedDraft[]>();
		const lineComments = new Map<string, ResolvedDraft[]>();
		const stale = resolved.filter((draft) => draft.stale);
		for (const draft of resolved) {
			if (draft.stale) continue;
			const groups = draft.kind === "file" ? fileComments : lineComments;
			const key = draftTargetKey(draft);
			const group = groups.get(key) ?? [];
			group.push(draft);
			groups.set(key, group);
		}
		if (stale.length > 0) {
			rows.push({ kind: "info", id: "stale-heading", text: `⚠ ${stale.length} draft(s) with stale anchors: press x to remove before sending.` });
			for (const draft of stale) rows.push({ kind: "draft", draftId: draft.id });
		}
		if (this.snapshot.sections.length === 0) {
			rows.push({ kind: "info", id: "empty", text: "No Git changes to review; nothing will be submitted for validation." });
			return rows;
		}
		for (let sectionIndex = 0; sectionIndex < this.snapshot.sections.length; sectionIndex++) {
			const section = this.snapshot.sections[sectionIndex];
			rows.push({ kind: "file", sectionIndex });
			const fileTarget: ReviewTarget = {
				kind: "file",
				sectionKey: section.key,
				file: section.newFile ?? section.oldFile ?? section.displayFile,
				patchHash: section.patchHash,
			};
			for (const draft of fileComments.get(draftTargetKey(fileTarget)) ?? []) {
				rows.push({ kind: "comment", sectionIndex, draftId: draft.id });
			}
			for (let deltaIndex = 0; deltaIndex < section.rows.length; deltaIndex++) {
				const delta = section.rows[deltaIndex];
				rows.push({ kind: "delta", sectionIndex, deltaIndex });
				if (!delta.mapping) continue;
				const lineTarget: ReviewTarget = {
					kind: "line",
					sectionKey: section.key,
					file: delta.mapping.file,
					side: delta.mapping.side,
					line: delta.mapping.line,
					patchHash: section.patchHash,
				};
				for (const draft of lineComments.get(draftTargetKey(lineTarget)) ?? []) {
					rows.push({ kind: "comment", sectionIndex, draftId: draft.id });
				}
			}
		}
		return rows;
	}

	private setMessage(message: string): void {
		this.message = message;
		this.tui.requestRender();
	}

	private move(delta: number): void {
		const rows = this.buildRows();
		this.cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + delta));
		this.message = "";
		this.tui.requestRender();
	}

	private moveFile(direction: -1 | 1): void {
		const rows = this.buildRows();
		const headers = rows.map((row, index) => row.kind === "file" ? index : -1).filter((index) => index >= 0);
		if (headers.length === 0) return;
		const target = direction > 0
			? headers.find((index) => index > this.cursor) ?? headers[0]
			: [...headers].reverse().find((index) => index < this.cursor) ?? headers[headers.length - 1];
		this.cursor = target;
		this.message = "";
		this.tui.requestRender();
	}

	private currentRow(): ReviewRow | undefined {
		return this.buildRows()[this.cursor];
	}

	private currentDraft(row: ReviewRow): ReviewDraft | undefined {
		if (row.kind !== "draft" && row.kind !== "comment") return undefined;
		return this.drafts.find((draft) => draft.id === row.draftId);
	}

	private editComment(): void {
		const row = this.currentRow();
		if (!row) return;
		const selectedDraft = this.currentDraft(row);
		const target = selectedDraft
			? (({ id: _id, text: _text, ...rest }) => rest)(selectedDraft)
			: targetFromRow(row, this.snapshot.sections);
		if (!target) {
			this.setMessage("This row has no verifiable location; use the file header to comment on the file.");
			return;
		}
		const existing = this.drafts.find((draft) => draftTargetKey(draft) === draftTargetKey(target));
		const editor = new Editor(this.tui, createReviewEditorTheme(this.theme));
		editor.setText(existing?.text ?? "");
		editor.disableSubmit = true;
		editor.focused = true;
		editor.onChange = () => this.tui.requestRender();
		this.commentEditor = editor;
		this.commentTarget = target;
		this.message = `Editing ${targetDescription(target)}.`;
		this.tui.requestRender();
	}

	private saveComment(): void {
		const editor = this.commentEditor;
		const target = this.commentTarget;
		if (!editor || !target) return;
		const text = editor.getText().trim();
		const existing = this.drafts.find((draft) => draftTargetKey(draft) === draftTargetKey(target));
		if (!text) {
			this.commentEditor = null;
			this.commentTarget = null;
			this.message = existing ? "Comment is empty; the existing comment was kept. Press x to remove it." : "Empty comment was not saved.";
			this.tui.requestRender();
			return;
		}
		if (existing?.text === text) {
			this.commentEditor = null;
			this.commentTarget = null;
			this.message = "Comment unchanged.";
			this.tui.requestRender();
			return;
		}
		const next = updateDrafts(this.drafts, target, text, randomUUID);
		if (!saveDrafts(this.pi, this.ctx, this.snapshot.repoRoot, next)) {
			this.message = "Could not save the draft; it remains in the editor. Don't close Pi until this is resolved.";
			this.tui.requestRender();
			return;
		}
		this.drafts = next;
		this.commentEditor = null;
		this.commentTarget = null;
		this.message = "Draft saved for this session.";
		const saved = next.find((draft) => draftTargetKey(draft) === draftTargetKey(target));
		const commentIndex = this.buildRows().findIndex((row) => row.kind === "comment" && row.draftId === saved?.id);
		if (commentIndex >= 0) this.cursor = commentIndex;
		this.tui.requestRender();
	}

	private cancelCommentEdit(): void {
		this.commentEditor = null;
		this.commentTarget = null;
		this.message = "Editing cancelled; the draft was not changed.";
		this.tui.requestRender();
	}

	private removeComment(): void {
		const row = this.currentRow();
		const draft = row ? this.currentDraft(row) : undefined;
		if (!draft) {
			this.setMessage("Select a comment row to remove it.");
			return;
		}
		const next = removeDraft(this.drafts, draft.id);
		if (!saveDrafts(this.pi, this.ctx, this.snapshot.repoRoot, next)) {
			this.setMessage("Could not save the removal; the comment is still saved.");
			return;
		}
		this.drafts = next;
		this.cursor = Math.min(this.cursor, Math.max(0, this.buildRows().length - 1));
		this.message = "Comment removed.";
		this.tui.requestRender();
	}

	private requestSubmissionConfirmation(): void {
		const decision = resolveReviewAction("send", this.drafts, this.snapshot.sections, this.reviewPromptConfig);
		if (decision.kind === "blocked") {
			this.message = decision.reason === "stale"
				? `${decision.count} stale anchor(s): remove them with x before sending.`
				: "No changes to validate; nothing was sent.";
			this.tui.requestRender();
			return;
		}
		this.pendingConfirmation = decision.kind === "send-comments" ? "comments" : "validation";
		this.message = "";
		this.tui.requestRender();
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.message = "Checking that the diff has not changed…";
		this.tui.requestRender();
		try {
			const fresh = await loadSnapshot(this.snapshot.repoRoot, reviewLayout(this.tui.terminal.columns).bodyWidth);
			const changed = fresh.signature !== this.snapshot.signature;
			const oldIdentity = rowIdentity(this.currentRow(), this.snapshot.sections);
			if (changed) {
				this.snapshot = fresh;
				const refreshedRows = this.buildRows();
				const match = refreshedRows.findIndex((row) => rowIdentity(row, fresh.sections) === oldIdentity);
				this.cursor = match >= 0 ? match : Math.min(this.cursor, Math.max(0, refreshedRows.length - 1));
				this.message = "The diff changed. The view has been refreshed; review it and press w again.";
				return;
			}
			this.snapshot = fresh;
			const decision = resolveReviewAction("send", this.drafts, fresh.sections, this.reviewPromptConfig);
			if (decision.kind === "blocked") {
				this.message = decision.reason === "stale"
					? `${decision.count} stale anchor(s): remove them with x before sending.`
					: "No changes to validate; nothing was sent.";
				return;
			}
			this.done({
				action: "submit",
				message: decision.message,
				clearDrafts: decision.kind === "send-comments",
				repoRoot: fresh.repoRoot,
			});
		} catch (error) {
			this.message = `Could not verify the diff; nothing was sent. ${String(error)}`;
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (this.pendingConfirmation) {
			if (data === "y") {
				this.pendingConfirmation = null;
				void this.submit();
			} else if (data === "n" || matchesKey(data, Key.escape)) {
				this.pendingConfirmation = null;
				this.message = "Submission cancelled; you are still reviewing, and the drafts were kept.";
				this.tui.requestRender();
			} else if (data === "q") {
				this.pendingConfirmation = null;
				this.done({ action: "close" });
			}
			return;
		}
		if (this.commentEditor) {
			if (matchesKey(data, Key.escape)) return this.cancelCommentEdit();
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) return this.saveComment();
			this.commentEditor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (data === "q") {
			const decision = resolveReviewAction("close", this.drafts, this.snapshot.sections);
			if (decision.kind === "close") this.done({ action: "close" });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.setMessage("Press q to close without sending.");
			return;
		}
		if (data === "w" || matchesKey(data, Key.ctrl("s"))) {
			this.requestSubmissionConfirmation();
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) return this.move(1);
		if (data === "k" || matchesKey(data, Key.up)) return this.move(-1);
		if (data === "h" || matchesKey(data, Key.left)) return this.moveFile(-1);
		if (data === "l" || matchesKey(data, Key.right)) return this.moveFile(1);
		if (data === "c") {
			this.editComment();
			return;
		}
		if (data === "x") {
			this.removeComment();
			return;
		}
		if (matchesKey(data, Key.pageDown)) return this.move(10);
		if (matchesKey(data, Key.pageUp)) return this.move(-10);
	}

	render(width: number): string[] {
		const resolved = this.resolvedDrafts();
		const rows = this.buildRows(resolved);
		if (rows.length === 0) this.cursor = 0;
		else this.cursor = Math.max(0, Math.min(this.cursor, rows.length - 1));
		const staleCount = resolved.filter((draft) => draft.stale).length;
		const draftCount = this.drafts.length;
		const height = Math.max(4, this.tui.terminal.rows);
		const { sidebarWidth, bodyWidth } = reviewLayout(width);
		const editorLines = this.commentEditor?.render(width) ?? [];
		const editorRows = this.commentTarget
			? [
				this.theme.fg("accent", `Comment · ${targetDescription(this.commentTarget)}`),
				...editorLines,
				this.theme.fg("dim", COMMENT_EDITOR_HINT),
			]
			: [];
		const bodyHeight = Math.max(0, height - 4 - editorRows.length);
		const start = keepCursorVisible(this.scrollOffset, this.cursor, rows.length, bodyHeight);
		this.scrollOffset = start;
		const visible = rows.slice(start, start + bodyHeight);
		const draftsById = new Map(this.drafts.map((draft) => [draft.id, draft] as const));
		const title = this.theme.fg("accent", this.theme.bold(`Review · ${safePlainText(path.basename(this.snapshot.repoRoot))}`));
		const summary = `${this.snapshot.sections.length} file(s) · ${draftCount} draft(s)${staleCount ? ` · ${staleCount} stale` : ""}${this.busy ? " · working…" : ""}`;
		const selectedRow = rows[this.cursor];
		const selectedDraft = selectedRow?.kind === "draft" || selectedRow?.kind === "comment";
		const footer = this.pendingConfirmation
			? "y confirm · n/Esc cancel · q close without sending"
			: this.commentEditor
				? COMMENT_EDITOR_HINT
				: `j/k/↑↓ row · h/l/←→ file · c ${selectedDraft ? "edit" : "comment"}${selectedDraft ? " · x remove" : ""} · w request submission/validation · q close`;
		const statusText = this.pendingConfirmation
			? `Are you sure you want to send ${this.pendingConfirmation === "comments" ? "the comments to the agent" : "the validation"}? y: yes · n/Esc: no`
			: this.message || (staleCount ? "There are stale anchors; w will not send them." : "");
		const sidebarLines = sidebarWidth > 0
			? this.renderSidebar(sidebarWidth, bodyHeight, activeSectionIndex(rows, this.cursor), resolved)
			: [];
		const separator = sidebarWidth > 0 ? this.theme.fg("border", "│") : "";
		// Always emit exactly bodyHeight rows: the overlay is composited into the visible
		// viewport, so a short diff must pad with blank rows or Pi's transcript shows below it.
		const body = Array.from({ length: bodyHeight }, (_, offset) => {
			const row = visible[offset];
			const line = row
				? truncateToWidth(this.renderRow(row, start + offset === this.cursor, bodyWidth, draftsById), bodyWidth)
				: "";
			if (sidebarWidth === 0) return line;
			const cell = sidebarLines[offset] ?? "";
			return `${truncateToWidth(cell, sidebarWidth, "", true)}${separator}${line}`;
		});
		const rendered = [
			truncateToWidth(title, width),
			truncateToWidth(this.theme.fg("muted", summary), width),
			...body,
			...editorRows,
			truncateToWidth(this.theme.fg(this.pendingConfirmation || staleCount ? "warning" : "muted", statusText), width),
			truncateToWidth(this.theme.fg("dim", footer), width),
		];
		return rendered.slice(0, height).map((line) => truncateToWidth(line, width));
	}

	/** Changed files as an expanded folder tree, anchored on the section under the cursor. */
	private renderSidebar(
		width: number,
		height: number,
		activeSection: number | undefined,
		resolved: ResolvedDraft[],
	): string[] {
		const sections = this.snapshot.sections;
		const entries = sidebarEntries(sections.map((section) => safePlainText(section.displayFile)));
		const counts = new Map<number, { total: number; stale: number }>();
		for (const draft of resolved) {
			const sectionIndex = sections.findIndex((section) => section.key === draft.sectionKey);
			if (sectionIndex < 0) continue;
			const entry = counts.get(sectionIndex) ?? { total: 0, stale: 0 };
			entry.total++;
			if (draft.stale) entry.stale++;
			counts.set(sectionIndex, entry);
		}
		const lineOfSection = new Map<number, number>();
		for (let index = 0; index < entries.length; index++) {
			const sectionIndex = entries[index].sectionIndex;
			if (sectionIndex !== null && !lineOfSection.has(sectionIndex)) lineOfSection.set(sectionIndex, index);
		}
		const activeLine = activeSection === undefined ? undefined : lineOfSection.get(activeSection);
		const start = activeLine === undefined
			? Math.min(this.sidebarScroll, Math.max(0, entries.length - height))
			: keepCursorVisible(this.sidebarScroll, activeLine, entries.length, height);
		this.sidebarScroll = start;
		const ancestors = ancestorLines(entries, activeLine);
		return Array.from({ length: Math.max(0, height) }, (_, offset) => {
			const index = start + offset;
			const entry = entries[index];
			if (!entry) return "";
			const selected = index === activeLine;
			const onPath = selected || ancestors.has(index);
			const count = entry.sectionIndex === null ? undefined : counts.get(entry.sectionIndex);
			const badgeWidth = count && count.total > 0 ? 2 + String(count.total).length : 0;
			const indent = "  ".repeat(entry.depth);
			const label = truncateToWidth(
				entry.isDirectory ? this.theme.bold(entry.label) : entry.label,
				Math.max(1, width - 2 - indent.length - badgeWidth),
				"…",
			);
			const marker = selected ? this.theme.fg("accent", "▸") : " ";
			const color = onPath || entry.isDirectory ? "accent" : "muted";
			const badge = count && count.total > 0
				? ` ${this.theme.fg(count.stale > 0 ? "warning" : "success", `●${count.total}`)}`
				: "";
			const line = truncateToWidth(`${marker}${indent}${label}${badge}`, width);
			return selected
				? this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))))
				: line;
		});
	}

	private renderRow(row: ReviewRow, selected: boolean, width: number, draftsById: Map<string, ReviewDraft>): string {
		const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
		let text = "";
		if (row.kind === "file") {
			const section = this.snapshot.sections[row.sectionIndex];
			text = this.theme.fg("accent", this.theme.bold(`▸ ${safePlainText(section?.label ?? "file")}  [c: comment on file]`));
		} else if (row.kind === "delta") {
			const section = this.snapshot.sections[row.sectionIndex];
			text = section?.rows[row.deltaIndex]?.text ?? "";
		} else if (row.kind === "comment") {
			const draft = draftsById.get(row.draftId);
			text = `${this.theme.fg("success", `    ↳ comment: ${excerpt(draft?.text ?? "")}`)}${this.theme.fg("dim", "  [c edit · x remove]")}`;
		} else if (row.kind === "draft") {
			const draft = draftsById.get(row.draftId);
			const location = draft?.kind === "line" ? `${draft.file} (${draft.side}:${draft.line})` : draft?.file;
			text = this.theme.fg("warning", `⚠ ${safePlainText(location ?? "stale anchor")}: ${excerpt(draft?.text ?? "")}  [c edit · x remove]`);
		} else {
			text = this.theme.fg("muted", row.text);
		}
		const availableWidth = Math.max(1, width);
		const line = cursor + text;
		if (!selected) return truncateToWidth(line, availableWidth);
		const clipped = truncateToWidth(line, availableWidth, "");
		const selectedLine = row.kind === "delta"
			? preserveSelectedBackground(clipped, this.theme.getBgAnsi("selectedBg"))
			: clipped;
		const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(selectedLine)));
		return this.theme.bg("selectedBg", selectedLine + padding);
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: "Review the current repository's Git changes in Delta (Pi CWD); paths are not accepted",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/review requires Pi's interactive TUI.", "warning");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("/review does not accept paths; start Pi inside the repository you want to review.", "warning");
				return;
			}
			let reviewPromptConfig: ReviewPromptConfig;
			try {
				reviewPromptConfig = loadReviewPromptConfig(getAgentDir());
			} catch (error) {
				ctx.ui.notify(`/review could not read its configuration: ${String(error)}`, "error");
				return;
			}
			try {
				if (!ctx.sessionManager.getSessionFile()) {
					ctx.ui.notify("This session is not saved to disk; drafts will only survive while Pi remains open.", "warning");
				}
				// Delta renders for the body column, not the whole terminal, because the
				// file sidebar takes the rest of the width.
				const width = process.stdout.columns || 100;
				const snapshot = await loadSnapshot(ctx.cwd, reviewLayout(width).bodyWidth);
				const drafts = loadDrafts(ctx, snapshot.repoRoot);
				// Overlay mode composes against the visible viewport instead of Pi's content
				// buffer, so the footer and transcript below can never show through the review.
				const result = await ctx.ui.custom<ReviewResult>(
					(tui, theme, _keybindings, done) => new ReviewScreen(pi, ctx, tui, theme, done, snapshot, drafts, reviewPromptConfig),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } },
				);
				if (result.action === "submit") {
					pi.sendUserMessage(result.message, { deliverAs: "followUp" });
					if (result.clearDrafts && !saveDrafts(pi, ctx, result.repoRoot, [])) {
						ctx.ui.notify("Comments sent; could not clear the persisted draft, so it may reappear.", "warning");
					}
				}
			} catch (error) {
				ctx.ui.notify(`/review could not load the diff: ${String(error)}`, "error");
			}
		},
	});
}
