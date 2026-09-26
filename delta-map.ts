export type PatchRow = {
	kind: "context" | "delete" | "add";
	oldLine?: number;
	newLine?: number;
	content: string;
};

export type DeltaRow = {
	text: string;
	mapping?: { file: string; side: "old" | "new"; line: number };
};

/** Remove terminal controls for parsing only; callers retain the original display text. */
export function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function preserveSelectedBackground(text: string, selectedBackground: string): string {
	return text.replace(/\x1b\[([0-?]*)m/g, (_sequence, parameters: string) => {
		const codes = parameters ? parameters.split(";") : ["0"];
		let result = "";
		let retained: string[] = [];
		const flush = () => {
			if (retained.length === 0) return;
			result += `\x1b[${retained.join(";")}m`;
			retained = [];
		};

		for (let index = 0; index < codes.length; index++) {
			const parameter = codes[index];
			const code = Number(parameter.split(":")[0]);
			if (code === 0) {
				flush();
				result += `\x1b[0m${selectedBackground}`;
				continue;
			}
			if (code === 48) {
				flush();
				if (!parameter.includes(":")) {
					if (codes[index + 1] === "2") index += 4;
					else if (codes[index + 1] === "5") index += 2;
				}
				continue;
			}
			if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) continue;
			if (code === 38 && !parameter.includes(":")) {
				const components = codes[index + 1] === "2" ? 4 : codes[index + 1] === "5" ? 2 : 0;
				retained.push(...codes.slice(index, index + components + 1));
				index += components;
				continue;
			}
			retained.push(parameter);
		}
		flush();
		return result;
	});
}

/** Parse one complete unified Git patch. Invalid or incomplete patches fail closed. */
export function parseUnifiedPatch(patch: string): PatchRow[] | null {
	const lines = stripTerminalControls(patch).split(/\r?\n/);
	const rows: PatchRow[] = [];
	let inHunk = false;
	let oldLine = 0;
	let newLine = 0;
	let oldRemaining = 0;
	let newRemaining = 0;
	let hunks = 0;

	for (const line of lines) {
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
			rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, content });
			oldRemaining--;
			newRemaining--;
		} else if (marker === "-" && oldRemaining > 0) {
			rows.push({ kind: "delete", oldLine: oldLine++, content });
			oldRemaining--;
		} else if (marker === "+" && newRemaining > 0) {
			rows.push({ kind: "add", newLine: newLine++, content });
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
): DeltaRow[] {
	const source = parseUnifiedPatch(patch);
	const outputRows = deltaOutput.split("\n");
	if (outputRows.at(-1) === "") outputRows.pop();
	let sourceIndex = 0;
	let mismatch = source === null;
	let tabWidth: number | undefined;

	return outputRows.map((text) => {
		const parsed = parseDeltaLine(text.replace(/\r$/, ""));
		if (!parsed || mismatch) return { text };
		const expected = source?.[sourceIndex];
		if (!expected) {
			mismatch = true;
			return { text };
		}
		sourceIndex++;
		let sameContent = parsed.content === expected.content;
		if (expected.content.includes("\t")) {
			// Delta expands tabs to a configurable number of spaces. Infer that width
			// from the full row, and require the same width throughout this file.
			const tabs = expected.content.split("\t").length - 1;
			const width = (parsed.content.length - expected.content.length + tabs) / tabs;
			const expanded = Number.isInteger(width) && width > 0 && width <= 256 &&
				expected.content.replaceAll("\t", " ".repeat(width)) === parsed.content;
			const observedWidth = sameContent ? 0 : expanded ? width : undefined;
			sameContent = observedWidth !== undefined && (tabWidth === undefined || tabWidth === observedWidth);
			if (sameContent) tabWidth = observedWidth;
		}
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
