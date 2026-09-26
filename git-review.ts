import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mapDeltaRows, type DeltaRow } from "./delta-map.ts";

const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_SNAPSHOT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_DURATION_MS = 60_000;
const MAX_REVIEW_SECTIONS = 256;
const COMMAND_TIMEOUT_MS = 20_000;

type FileChange = {
	status: string;
	oldFile: string | null;
	newFile: string | null;
};

export type ReviewSection = {
	key: string;
	label: string;
	oldFile: string | null;
	newFile: string | null;
	displayFile: string;
	patch: string;
	patchHash: string;
	rows: DeltaRow[];
};

export type ReviewSnapshot = {
	repoRoot: string;
	sections: ReviewSection[];
	signature: string;
};

type SnapshotBudget = {
	deadline: number;
	outputBytes: number;
	sectionCount: number;
	failure?: string;
	cancelers: Set<() => void>;
};

type CommandOptions = {
	cwd: string;
	budget: SnapshotBudget;
	input?: string;
	allowedExitCodes?: number[];
};

function cancelSnapshot(budget: SnapshotBudget): void {
	for (const cancel of [...budget.cancelers]) cancel();
}

function reserveSections(budget: SnapshotBudget, count: number): void {
	if (budget.sectionCount + count > MAX_REVIEW_SECTIONS) {
		throw new Error(`Review exceeds the ${MAX_REVIEW_SECTIONS}-section limit`);
	}
	budget.sectionCount += count;
}

function run(command: string, args: string[], options: CommandOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		if (options.budget.failure) return reject(new Error(options.budget.failure));
		const remainingMs = options.budget.deadline - Date.now();
		if (remainingMs <= 0) return reject(new Error("Review exceeded its 60-second time limit"));
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let commandBytes = 0;
		const cancel = () => child.kill("SIGTERM");
		options.budget.cancelers.add(cancel);
		const timeout = setTimeout(() => {
			options.budget.failure ??= "Review exceeded its time limit";
			cancelSnapshot(options.budget);
		}, Math.min(COMMAND_TIMEOUT_MS, remainingMs));
		const collect = (target: Buffer[]) => (chunk: Buffer) => {
			commandBytes += chunk.length;
			options.budget.outputBytes += chunk.length;
			if (commandBytes > MAX_OUTPUT_BYTES || options.budget.outputBytes > MAX_SNAPSHOT_OUTPUT_BYTES) {
				options.budget.failure ??= commandBytes > MAX_OUTPUT_BYTES
					? "A Git/Delta command exceeded the 24 MiB output limit"
					: "Review exceeded the 64 MiB total output limit";
				cancelSnapshot(options.budget);
				return;
			}
			target.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			clearTimeout(timeout);
			options.budget.cancelers.delete(cancel);
			options.budget.failure ??= error.message;
			cancelSnapshot(options.budget);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			options.budget.cancelers.delete(cancel);
			if (options.budget.failure) return reject(new Error(options.budget.failure));
			const allowed = options.allowedExitCodes ?? [0];
			if (code === null || !allowed.includes(code)) {
				const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 600);
				const error = new Error(detail || `${command} exited with status ${code}`);
				options.budget.failure = error.message;
				cancelSnapshot(options.budget);
				return reject(error);
			}
			resolve(Buffer.concat(stdout).toString("utf8"));
		});
		child.stdin.end(options.input ?? "");
	});
}

function splitNul(value: string): string[] {
	return value.split("\0").filter((part) => part.length > 0);
}

function parseNameStatus(value: string): FileChange[] {
	const tokens = splitNul(value);
	const changes: FileChange[] = [];
	for (let i = 0; i < tokens.length;) {
		const status = tokens[i++];
		if (!status) break;
		const kind = status[0];
		if (kind === "R" || kind === "C") {
			const oldFile = tokens[i++];
			const newFile = tokens[i++];
			if (oldFile === undefined || newFile === undefined) throw new Error("Git returned an incomplete rename record");
			changes.push({ status, oldFile, newFile });
			continue;
		}
		const file = tokens[i++];
		if (file === undefined) throw new Error("Git returned an incomplete file record");
		changes.push({
			status,
			oldFile: kind === "A" ? null : file,
			newFile: kind === "D" ? null : file,
		});
	}
	return changes;
}

function splitFilePatches(patch: string): string[] {
	if (!patch) return [];
	const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index!);
	if (starts.length === 0 || patch.slice(0, starts[0]).trim()) {
		throw new Error("Could not safely split Git's patch into file sections");
	}
	return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function layerArgs(layer: "staged" | "worktree" | "head", nameStatus: boolean): string[] {
	const args = ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--find-renames"];
	if (layer === "staged") args.push("--cached", "--root");
	if (nameStatus) args.push("--name-status", "-z");
	if (layer === "head") args.push("HEAD");
	args.push("--");
	return args;
}

function changeLabel(change: FileChange, layer: string): string {
	const file = change.newFile ?? change.oldFile ?? "(unknown path)";
	const rename = change.oldFile && change.newFile && change.oldFile !== change.newFile
		? `${change.oldFile} → ${change.newFile}`
		: file;
	const status = change.status === "??" ? "untracked · added"
		: change.status.startsWith("R") ? "renamed"
			: change.status.startsWith("A") ? "added"
			: change.status.startsWith("D") ? "deleted"
				: change.status.startsWith("T") ? "type changed"
					: "modified";
	return layer === "head" || change.status === "??" ? `${status} · ${rename}` : `${layer} · ${status} · ${rename}`;
}

function sectionKey(layer: string, oldFile: string | null, newFile: string | null): string {
	return `${layer}\0${oldFile ?? ""}\0${newFile ?? ""}`;
}

function makeSection(change: FileChange, patch: string, layer: string): ReviewSection {
	const displayFile = change.newFile ?? change.oldFile ?? "(unknown path)";
	return {
		key: sectionKey(layer, change.oldFile, change.newFile),
		label: changeLabel(change, layer),
		oldFile: change.oldFile,
		newFile: change.newFile,
		displayFile,
		patch,
		patchHash: createHash("sha256").update(patch).digest("hex"),
		rows: [],
	};
}

async function collectLayer(root: string, layer: "staged" | "worktree" | "head", budget: SnapshotBudget): Promise<ReviewSection[]> {
	const [statusText, patch] = await Promise.all([
		run("git", layerArgs(layer, true), { cwd: root, budget }),
		run("git", layerArgs(layer, false), { cwd: root, budget }),
	]);
	const changes = parseNameStatus(statusText);
	reserveSections(budget, changes.length);
	const patches = splitFilePatches(patch);
	if (changes.length !== patches.length) {
		throw new Error(`Git file list and patch disagree (${changes.length} files, ${patches.length} patches); refusing line annotations`);
	}
	return changes.map((change, index) => makeSection(change, patches[index], layer));
}

async function collectUntracked(root: string, budget: SnapshotBudget): Promise<ReviewSection[]> {
	const files = splitNul(await run("git", ["--no-pager", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, budget }));
	reserveSections(budget, files.length);
	const sections: ReviewSection[] = [];
	for (const file of files) {
		const patch = await run(
			"git",
			["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", "/dev/null", file],
			{ cwd: root, budget, allowedExitCodes: [0, 1] },
		);
		if (!patch) continue;
		sections.push(makeSection({ status: "??", oldFile: null, newFile: file }, patch, "untracked"));
	}
	return sections;
}

function sanitizePatchForDelta(patch: string): string {
	return patch
		.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, (sequence) => `\\x1b${sequence.slice(1)}`)
		.replace(/\x1b/g, "\\x1b")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (control) =>
			`\\x${control.codePointAt(0)!.toString(16).padStart(2, "0")}`);
}

function sanitizeDeltaLine(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (sequence, final: string) => final === "m" ? sequence : "")
		.replace(/\x1b(?!\[[0-?]*[ -/]*m)/g, "")
		.replace(/\t/g, "    ")
		.replace(/\r/g, "\\x0d")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, (control) =>
			`\\x${control.codePointAt(0)!.toString(16).padStart(2, "0")}`);
}

async function renderWithDelta(section: ReviewSection, width: number, repoRoot: string, budget: SnapshotBudget): Promise<ReviewSection> {
	const patch = sanitizePatchForDelta(section.patch);
	const output = await run("delta", ["--paging", "never", "--line-numbers", "--width", String(Math.max(30, width))], {
		cwd: repoRoot,
		budget,
		input: patch,
	});
	const mapped = mapDeltaRows(section.displayFile, patch, output, {
		oldFile: section.oldFile,
		newFile: section.newFile,
	});
	const isSubmodule = /\b160000\b/.test(section.patch) && section.patch.includes("Subproject commit ");
	return {
		...section,
		rows: mapped.map((row) => ({
			...row,
			text: sanitizeDeltaLine(row.text),
			mapping: isSubmodule ? undefined : row.mapping,
		})),
	};
}

function snapshotSignature(sections: ReviewSection[]): string {
	const parts = sections.map((section) => `${section.key}\0${section.patchHash}`).sort();
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export async function loadSnapshot(cwd: string, width: number): Promise<ReviewSnapshot> {
	const budget: SnapshotBudget = {
		deadline: Date.now() + MAX_SNAPSHOT_DURATION_MS,
		outputBytes: 0,
		sectionCount: 0,
		cancelers: new Set(),
	};
	const repoRoot = (await run("git", ["rev-parse", "--show-toplevel"], { cwd, budget })).trim();
	if (!repoRoot) throw new Error("Could not determine the Git repository root");
	let sections: ReviewSection[];
	const head = await run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repoRoot, budget, allowedExitCodes: [0, 1] });
	const hasHead = head.trim().length > 0;
	if (hasHead) {
		sections = await collectLayer(repoRoot, "head", budget);
	} else {
		const [staged, worktree] = await Promise.all([
			collectLayer(repoRoot, "staged", budget),
			collectLayer(repoRoot, "worktree", budget),
		]);
		sections = [...staged, ...worktree];
	}
	sections.push(...await collectUntracked(repoRoot, budget));
	const rendered: ReviewSection[] = [];
	const batchSize = 6;
	for (let start = 0; start < sections.length; start += batchSize) {
		const batch = sections.slice(start, start + batchSize);
		rendered.push(...await Promise.all(batch.map((section) => renderWithDelta(section, width, repoRoot, budget))));
	}
	return { repoRoot, sections: rendered, signature: snapshotSignature(rendered) };
}
