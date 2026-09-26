import { stripTerminalControls } from "./terminal.ts";

export type PatchRow = {
	kind: "context" | "delete" | "add";
	oldLine?: number;
	newLine?: number;
	content: string;
	patchLineIndex: number;
};

export type ReviewDiffRow = {
	text: string;
	mapping?: { file: string; side: "old" | "new"; line: number };
};

/** Parse one complete unified Git patch. Invalid or incomplete patches fail closed. */
export function parseUnifiedPatch(patch: string): PatchRow[] | null {
	const lines = patch.split(/\r?\n/);
	const rows: PatchRow[] = [];
	let inHunk = false;
	let oldLine = 0;
	let newLine = 0;
	let oldRemaining = 0;
	let newRemaining = 0;
	let hunks = 0;

	for (const [patchLineIndex, rawLine] of lines.entries()) {
		const line = stripTerminalControls(rawLine);
		if (line.startsWith("@@")) {
			if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) return null;
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
			if (!match) return null;
			oldLine = Number(match[1]);
			newLine = Number(match[3]);
			oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
			newRemaining = match[4] === undefined ? 1 : Number(match[4]);
			inHunk = true;
			hunks++;
			continue;
		}
		if (!inHunk) continue;
		if (line === "\\ No newline at end of file") continue;
		if (oldRemaining === 0 && newRemaining === 0) {
			inHunk = false;
			continue;
		}
		const marker = line[0];
		const content = line.slice(1);
		if (marker === " " && oldRemaining > 0 && newRemaining > 0) {
			rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, content, patchLineIndex });
			oldRemaining--;
			newRemaining--;
		} else if (marker === "-" && oldRemaining > 0) {
			rows.push({ kind: "delete", oldLine: oldLine++, content, patchLineIndex });
			oldRemaining--;
		} else if (marker === "+" && newRemaining > 0) {
			rows.push({ kind: "add", newLine: newLine++, content, patchLineIndex });
			newRemaining--;
		} else {
			return null;
		}
	}
	if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) return null;
	return hunks > 0 ? rows : null;
}

function parseDeltaLine(line: string): { oldLine?: number; newLine?: number; content: string } | null {
	// Delta's normal single-column line-number layout: old ⋮ new │ content.
	const match = /^\s*(\d*)\s*⋮\s*(\d*)\s*│(.*)$/.exec(stripTerminalControls(line));
	if (!match || (!match[1] && !match[2])) return null;
	return {
		oldLine: match[1] ? Number(match[1]) : undefined,
		newLine: match[2] ? Number(match[2]) : undefined,
		content: match[3],
	};
}

/**
 * Map Delta's normal output rows to exact source rows. Candidate rows are aligned
 * in order, and any mismatch ends mapping for the remainder of the output.
 */
export function mapDeltaRows(
	file: string,
	patch: string,
	deltaOutput: string,
	paths?: { oldFile: string | null; newFile: string | null },
): ReviewDiffRow[] {
	const source = parseUnifiedPatch(patch);
	const outputRows = deltaOutput.split("\n");
	if (outputRows.at(-1) === "") outputRows.pop();
	let sourceIndex = 0;
	let mismatch = source === null;

	return outputRows.map((text) => {
		const parsed = parseDeltaLine(text.replace(/\r$/, ""));
		if (!parsed || mismatch) return { text };
		const expected = source?.[sourceIndex];
		if (!expected) {
			mismatch = true;
			return { text };
		}
		sourceIndex++;
		const sameContent = parsed.content === expected.content;
		const sameCoordinates = expected.kind === "context"
			? parsed.oldLine === expected.oldLine && parsed.newLine === expected.newLine
			: expected.kind === "delete"
				? parsed.oldLine === expected.oldLine && parsed.newLine === undefined
				: parsed.oldLine === undefined && parsed.newLine === expected.newLine;
		if (!sameContent || !sameCoordinates) {
			mismatch = true;
			return { text };
		}
		const side: "old" | "new" = expected.kind === "delete" ? "old" : "new";
		const mappedFile = paths
			? (side === "old" ? paths.oldFile : paths.newFile)
			: file;
		if (!mappedFile) return { text };
		const mapping = {
			file: mappedFile,
			side,
			line: side === "old" ? expected.oldLine! : expected.newLine!,
		};
		return { text, mapping };
	});
}
