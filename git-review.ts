import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, resolve } from "node:path";
import { mapDeltaRows, parseUnifiedPatch, type ReviewDiffRow } from "./delta-map.ts";
import { escapeTerminalControls } from "./terminal.ts";

const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_SNAPSHOT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_DURATION_MS = 60_000;
const MAX_REVIEW_SECTIONS = 256;
const COMMAND_TIMEOUT_MS = 20_000;

type FileChange = {
	status: string;
	oldFile: string | null;
	newFile: string | null;
	oldMode: string;
	newMode: string;
};

export type ReviewSection = {
	key: string;
	label: string;
	oldFile: string | null;
	newFile: string | null;
	displayFile: string;
	patch: string;
	patchHash: string;
	isSubmodule: boolean;
	rows: ReviewDiffRow[];
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
	allowMissingExecutable?: boolean;
};

function executableOnPath(command: string, cwd: string): boolean {
	const pathValue = process.env.PATH ?? (process.platform === "win32" ? process.env.Path ?? "" : "/usr/bin:/bin");
	const directories = pathValue.split(delimiter);
	const extensions = process.platform === "win32"
		? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
		: [""];
	const mode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
	return directories.some((directory) => extensions.some((extension) => {
		try {
			accessSync(resolve(cwd, directory || ".", `${command}${extension}`), mode);
			return true;
		} catch {
			return false;
		}
	}));
}

function isMissingExecutable(error: unknown, command: string, cwd: string): boolean {
	const spawnError = error as NodeJS.ErrnoException & { path?: string };
	return spawnError.code === "ENOENT" && spawnError.path === command && existsSync(cwd) && !executableOnPath(command, cwd);
}

function cancelSnapshot(budget: SnapshotBudget): void {
	for (const cancel of [...budget.cancelers]) cancel();
}

function reserveSections(budget: SnapshotBudget, count: number): void {
	if (budget.sectionCount + count > MAX_REVIEW_SECTIONS) {
		throw new Error(`Review exceeds the ${MAX_REVIEW_SECTIONS}-section limit`);
	}
	budget.sectionCount += count;
}

function run(command: string, args: string[], options: CommandOptions & { allowMissingExecutable: true }): Promise<string | null>;
function run(command: string, args: string[], options: CommandOptions): Promise<string>;
function run(command: string, args: string[], options: CommandOptions): Promise<string | null> {
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
		let spawnError = false;
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
			spawnError = true;
			clearTimeout(timeout);
			options.budget.cancelers.delete(cancel);
			if (options.allowMissingExecutable && isMissingExecutable(error, command, options.cwd)) {
				resolve(null);
				return;
			}
			options.budget.failure ??= error.message;
			cancelSnapshot(options.budget);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			options.budget.cancelers.delete(cancel);
			if (spawnError) return;
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

type RawPatch = { changes: FileChange[]; patch: string };

function parseRawPatch(output: string): RawPatch {
	if (!output) return { changes: [], patch: "" };
	const patchStart = output.indexOf("\0\0diff --git ");
	if (patchStart < 0) throw new Error("Git raw metadata had no unified patch; refusing line annotations");
	const tokens = splitNul(output.slice(0, patchStart));
	const changes: FileChange[] = [];
	for (let i = 0; i < tokens.length;) {
		const record = tokens[i++];
		const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z][0-9]*)$/i.exec(record);
		if (!match) throw new Error("Git returned malformed raw diff metadata; refusing line annotations");
		const status = match[3];
		const kind = status[0];
		const oldFile = tokens[i++];
		if (oldFile === undefined) throw new Error("Git returned an incomplete raw diff record");
		if (kind === "R" || kind === "C") {
			const newFile = tokens[i++];
			if (newFile === undefined) throw new Error("Git returned an incomplete rename record");
			changes.push({ status, oldFile, newFile, oldMode: match[1], newMode: match[2] });
			continue;
		}
		if (!["A", "D", "M", "T", "U", "X", "B"].includes(kind)) {
			throw new Error(`Git returned unsupported raw diff status ${status}; refusing line annotations`);
		}
		changes.push({
			status,
			oldFile: kind === "A" ? null : oldFile,
			newFile: kind === "D" ? null : oldFile,
			oldMode: match[1],
			newMode: match[2],
		});
	}
	return { changes, patch: output.slice(patchStart + 2) };
}

function decodeGitPath(value: string): string | null {
	if (!value.startsWith('"')) return value.includes("\ufffd") ? null : value;
	if (!value.endsWith('"')) return null;
	const bytes: number[] = [];
	for (let index = 1; index < value.length - 1;) {
		if (value[index] !== "\\") {
			if (value[index] === '"') return null;
			const point = value.codePointAt(index)!;
			bytes.push(...Buffer.from(String.fromCodePoint(point), "utf8"));
			index += point > 0xffff ? 2 : 1;
			continue;
		}
		const escaped = value[index + 1];
		const simple: Record<string, number> = { '"': 34, "\\": 92, a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
		if (escaped !== undefined && Object.hasOwn(simple, escaped)) {
			bytes.push(simple[escaped]);
			index += 2;
			continue;
		}
		if (!/[0-7]/.test(escaped ?? "")) return null;
		let octal = "";
		while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) octal += value[++index];
		const byte = Number.parseInt(octal, 8);
		if (byte > 0xff) return null;
		bytes.push(byte);
		index++;
	}
	const buffer = Buffer.from(bytes);
	const decoded = buffer.toString("utf8");
	return Buffer.from(decoded, "utf8").equals(buffer) && !decoded.includes("\ufffd") ? decoded : null;
}

function patchHeaderMatches(change: FileChange, patch: string): boolean {
	const newline = patch.indexOf("\n");
	if (newline < 0) return false;
	const firstLine = patch.slice(0, newline);
	if (!firstLine.startsWith("diff --git ")) return false;
	const paths = firstLine.slice("diff --git ".length);
	const expectedOld = change.oldFile ?? change.newFile;
	const expectedNew = change.newFile ?? change.oldFile;
	if (expectedOld === null || expectedNew === null) return false;
	for (let split = 1; split < paths.length; split++) {
		if (paths[split] !== " ") continue;
		const oldPath = decodeGitPath(paths.slice(0, split));
		const newPath = decodeGitPath(paths.slice(split + 1));
		if (oldPath === `a/${expectedOld}` && newPath === `b/${expectedNew}`) return true;
	}
	return false;
}

export function verifyPatchChanges(changes: FileChange[], patches: string[]): void {
	if (changes.length !== patches.length) {
		throw new Error(`Git raw metadata and patch disagree (${changes.length} files, ${patches.length} patches); refusing line annotations`);
	}
	for (let index = 0; index < changes.length; index++) {
		if (!patchHeaderMatches(changes[index], patches[index])) {
			throw new Error(`Git raw metadata does not match patch ${index + 1}; refusing line annotations`);
		}
	}
}

function splitFilePatches(patch: string): string[] {
	if (!patch) return [];
	const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index!);
	if (starts.length === 0 || patch.slice(0, starts[0]).trim()) {
		throw new Error("Could not safely split Git's patch into file sections");
	}
	return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function layerArgs(layer: "staged" | "worktree" | "head"): string[] {
	const args = [
		"--no-pager", "diff", "--patch-with-raw", "-z", "--default-prefix",
		"--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", "--submodule=short", "--find-renames",
	];
	if (layer === "staged") args.push("--cached", "--root");
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
					: change.status.startsWith("C") ? "copied"
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
		isSubmodule: change.oldMode === "160000" || change.newMode === "160000",
		rows: [],
	};
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

function renderRawPatch(section: ReviewSection): ReviewDiffRow[] {
	const parsed = parseUnifiedPatch(section.patch);
	const rowsByPatchLine = new Map(parsed?.map((row) => [row.patchLineIndex, row]) ?? []);
	const lines = section.patch.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line, index) => {
		const text = escapeTerminalControls(line);
		const source = rowsByPatchLine.get(index);
		if (!source || !parsed || section.isSubmodule) return { text };
		const side = source.kind === "delete" ? "old" : "new";
		const file = side === "old" ? section.oldFile : section.newFile;
		if (!file) return { text };
		return {
			text,
			mapping: {
				file,
				side,
				line: side === "old" ? source.oldLine! : source.newLine!,
			},
		};
	});
}

async function renderWithDelta(
	section: ReviewSection,
	width: number,
	cwd: string,
	budget: SnapshotBudget,
): Promise<ReviewDiffRow[] | null> {
	const safePatch = escapeTerminalControls(section.patch);
	const output = await run(
		"delta",
		["--paging", "never", "--line-numbers", "--width", String(Math.max(30, width))],
		{ cwd, budget, input: safePatch, allowMissingExecutable: true },
	);
	if (output === null) return null;
	const mapped = mapDeltaRows(section.displayFile, safePatch, output, {
		oldFile: section.oldFile,
		newFile: section.newFile,
	});
	return mapped.map((row) => ({
		...row,
		text: sanitizeDeltaLine(row.text),
		mapping: section.isSubmodule ? undefined : row.mapping,
	}));
}

async function collectLayer(root: string, layer: "staged" | "worktree" | "head", budget: SnapshotBudget): Promise<ReviewSection[]> {
	const { changes, patch } = parseRawPatch(await run("git", layerArgs(layer), { cwd: root, budget }));
	reserveSections(budget, changes.length);
	const patches = splitFilePatches(patch);
	verifyPatchChanges(changes, patches);
	return changes.map((change, index) => makeSection(change, patches[index], layer));
}

async function collectUntracked(root: string, budget: SnapshotBudget): Promise<ReviewSection[]> {
	const files = splitNul(await run("git", ["--no-pager", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, budget }));
	reserveSections(budget, files.length);
	const sections: ReviewSection[] = [];
	for (const file of files) {
		const output = await run(
			"git",
			["--no-pager", "diff", "--no-index", "--patch-with-raw", "-z", "--default-prefix", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", file],
			{ cwd: root, budget, allowedExitCodes: [0, 1] },
		);
		const { changes, patch } = parseRawPatch(output);
		if (!patch) continue;
		const patches = splitFilePatches(patch);
		verifyPatchChanges(changes, patches);
		if (changes.length !== 1 || changes[0].status[0] !== "A" || changes[0].oldFile !== null || changes[0].newFile !== file) {
			throw new Error(`Git untracked-file metadata does not match ${file}; refusing line annotations`);
		}
		sections.push(makeSection(changes[0], patches[0], "untracked"));
	}
	return sections;
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
	let deltaMissing = false;
	const rendered: ReviewSection[] = [];
	const batchSize = 6;
	for (let start = 0; start < sections.length; start += batchSize) {
		const batch = sections.slice(start, start + batchSize);
		rendered.push(...await Promise.all(batch.map(async (section) => {
			if (deltaMissing) return { ...section, rows: renderRawPatch(section) };
			const rows = await renderWithDelta(section, width, repoRoot, budget);
			if (rows === null) {
				deltaMissing = true;
				return { ...section, rows: renderRawPatch(section) };
			}
			return { ...section, rows };
		})));
	}
	return { repoRoot, sections: rendered, signature: snapshotSignature(rendered) };
}
