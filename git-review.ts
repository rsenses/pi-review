import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	isSubmodule: boolean;
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
	input?: string | Buffer;
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
			const failure = command === "delta" && (error as NodeJS.ErrnoException).code === "ENOENT"
				? new Error("Delta is required to review diffs; install delta and ensure it is on PATH", { cause: error })
				: error;
			options.budget.failure ??= failure.message;
			cancelSnapshot(options.budget);
			reject(failure);
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

function parseRawPatch(output: string): { changes: FileChange[]; patch: string } {
	if (!output) return { changes: [], patch: "" };
	const start = output.indexOf("\0\0diff --git ");
	if (start < 0) throw new Error("Git raw metadata has no patch; refusing line annotations");
	const tokens = output.slice(0, start).split("\0");
	const changes: FileChange[] = [];
	for (let i = 0; i < tokens.length;) {
		const record = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z][0-9]*)$/i.exec(tokens[i++]);
		if (!record) throw new Error("Malformed Git raw metadata; refusing line annotations");
		const status = record[3];
		const kind = status[0];
		const file = tokens[i++];
		if (!file || file.includes("\ufffd")) throw new Error("Incomplete Git raw metadata; refusing line annotations");
		const other = kind === "R" || kind === "C" ? tokens[i++] : file;
		if (!other || other.includes("\ufffd") || !"ACDMRTUXB".includes(kind)) throw new Error("Unsupported Git raw metadata; refusing line annotations");
		changes.push({
			status,
			oldFile: kind === "A" ? null : file,
			newFile: kind === "D" ? null : other,
			isSubmodule: record[1] === "160000" || record[2] === "160000",
		});
	}
	return { changes, patch: output.slice(start + 2) };
}

// Git quotes unusual path bytes using C-style escapes, including octal UTF-8 bytes.
function decodeGitPath(value: string): string | null {
	if (!value.startsWith('"')) return /["\\\r\n\ufffd]/.test(value) ? null : value;
	if (!value.endsWith('"')) return null;
	const bytes: number[] = [];
	for (let i = 1; i < value.length - 1;) {
		if (value[i] !== "\\") {
			if (value[i] === '"') return null;
			const point = value.codePointAt(i)!;
			bytes.push(...Buffer.from(String.fromCodePoint(point)));
			i += point > 0xffff ? 2 : 1;
			continue;
		}
		const escaped = value[i + 1];
		const simple: Record<string, number> = { '"': 34, "\\": 92, a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
		if (escaped !== undefined && Object.hasOwn(simple, escaped)) {
			bytes.push(simple[escaped]);
			i += 2;
			continue;
		}
		if (!/^[0-7]{3}$/.test(value.slice(i + 1, i + 4))) return null;
		bytes.push(Number.parseInt(value.slice(i + 1, i + 4), 8));
		i += 4;
	}
	const buffer = Buffer.from(bytes);
	const decoded = buffer.toString("utf8");
	return Buffer.from(decoded).equals(buffer) && !decoded.includes("\ufffd") ? decoded : null;
}

function headerMatches(header: string, oldPath: string, newPath: string): boolean {
	if (!header.startsWith("diff --git ")) return false;
	const paths = header.slice("diff --git ".length);
	for (let i = 1; i < paths.length; i++) {
		if (paths[i] === " " && decodeGitPath(paths.slice(0, i)) === oldPath && decodeGitPath(paths.slice(i + 1)) === newPath) return true;
	}
	return false;
}

export function verifyPatchChanges(changes: FileChange[], patches: string[]): void {
	if (changes.length !== patches.length) {
		throw new Error(`Git metadata and patch disagree (${changes.length} files, ${patches.length} patches); refusing line annotations`);
	}
	for (let i = 0; i < changes.length; i++) {
		const change = changes[i];
		const oldPath = `a/${change.oldFile ?? change.newFile}`;
		const newPath = `b/${change.newFile ?? change.oldFile}`;
		const lines = patches[i].split("\n");
		if (!headerMatches(lines[0], oldPath, newPath)) {
			throw new Error(`Git metadata does not match patch ${i + 1}; refusing line annotations`);
		}
		// Text patches carry old/new markers; renames without hunks, binaries and mode-only changes may not.
		const hunk = lines.findIndex((line) => line.startsWith("@@ "));
		const markers = lines.slice(1, hunk < 0 ? undefined : hunk);
		const oldMarkers = markers.filter((line) => line.startsWith("--- "));
		const newMarkers = markers.filter((line) => line.startsWith("+++ "));
		if ((hunk >= 0 || oldMarkers.length > 0 || newMarkers.length > 0) &&
			(oldMarkers.length !== 1 || newMarkers.length !== 1 ||
				decodeGitPath(oldMarkers[0].slice(4).replace(/\t$/, "")) !== (change.oldFile === null ? "/dev/null" : oldPath) ||
				decodeGitPath(newMarkers[0].slice(4).replace(/\t$/, "")) !== (change.newFile === null ? "/dev/null" : newPath))) {
			throw new Error(`Git old/new paths do not match patch ${i + 1}; refusing line annotations`);
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
	const args = ["--no-pager", "diff", "--patch-with-raw", "-z", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", "--submodule=short", "--find-renames"];
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
		isSubmodule: change.isSubmodule,
		rows: [],
	};
}

async function collectLayer(root: string, layer: "staged" | "worktree" | "head", budget: SnapshotBudget): Promise<ReviewSection[]> {
	const { changes, patch } = parseRawPatch(await run("git", layerArgs(layer), { cwd: root, budget }));
	reserveSections(budget, changes.length);
	const patches = splitFilePatches(patch);
	verifyPatchChanges(changes, patches);
	return changes.map((change, index) => makeSection(change, patches[index], layer));
}

function isDirectorySymlink(root: string, file: string): boolean {
	const path = join(root, file);
	return lstatSync(path).isSymbolicLink() && statSync(path).isDirectory();
}

async function diffDirectorySymlink(root: string, file: string, budget: SnapshotBudget): Promise<{ changes: FileChange[]; patch: string }> {
	const target = readlinkSync(join(root, file), { encoding: "buffer" });
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-review-untracked-"));
	try {
		const tempFile = resolve(tempRoot, file);
		const relativeFile = relative(tempRoot, tempFile);
		if (!relativeFile || relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
			throw new Error("Unsafe untracked Git path; refusing line annotations");
		}
		mkdirSync(dirname(tempFile), { recursive: true });
		writeFileSync(tempFile, target, { mode: 0o644 });
		chmodSync(tempFile, 0o644);

		const { changes, patch } = parseRawPatch(await run(
			"git",
			["--no-pager", "diff", "--no-index", "--patch-with-raw", "-z", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", file],
			{ cwd: tempRoot, budget, allowedExitCodes: [0, 1] },
		));
		const patches = splitFilePatches(patch);
		verifyPatchChanges(changes, patches);
		if (changes.length !== 1 || changes[0].status !== "A" || changes[0].oldFile !== null || changes[0].newFile !== file) {
			throw new Error(`Git untracked metadata does not match ${file}; refusing line annotations`);
		}
		const modeLine = /^new file mode 100644$/gm;
		if ([...patches[0].matchAll(modeLine)].length !== 1) {
			throw new Error(`Git symlink mode does not match ${file}; refusing line annotations`);
		}
		const indexLine = /^index (0+)\.\.([0-9a-f]+)$/m.exec(patches[0]);
		if (!indexLine) throw new Error(`Git symlink object metadata is missing for ${file}; refusing line annotations`);
		const objectId = (await run("git", ["hash-object", "--stdin"], { cwd: root, budget, input: target })).trim();
		if (!/^[0-9a-f]+$/i.test(objectId)) throw new Error(`Git symlink object metadata is malformed for ${file}; refusing line annotations`);

		const symlinkPatch = patches[0]
			.replace(modeLine, "new file mode 120000")
			.replace(indexLine[0], `index ${indexLine[1]}..${objectId}`);
		verifyPatchChanges(changes, [symlinkPatch]);
		return { changes, patch: symlinkPatch };
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function collectUntracked(root: string, budget: SnapshotBudget): Promise<ReviewSection[]> {
	const files = splitNul(await run("git", ["--no-pager", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, budget }));
	reserveSections(budget, files.length);
	const sections: ReviewSection[] = [];
	for (const file of files) {
		const { changes, patch } = isDirectorySymlink(root, file)
			? await diffDirectorySymlink(root, file, budget)
			: parseRawPatch(await run(
				"git",
				["--no-pager", "diff", "--no-index", "--patch-with-raw", "-z", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", file],
				{ cwd: root, budget, allowedExitCodes: [0, 1] },
			));
		const patches = splitFilePatches(patch);
		verifyPatchChanges(changes, patches);
		if (changes.length !== 1 || changes[0].status !== "A" || changes[0].oldFile !== null || changes[0].newFile !== file) {
			throw new Error(`Git untracked metadata does not match ${file}; refusing line annotations`);
		}
		sections.push(makeSection({ ...changes[0], status: "??" }, patches[0], "untracked"));
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
	const isSubmodule = section.isSubmodule;
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
