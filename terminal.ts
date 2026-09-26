export function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function escapeTerminalControls(text: string): string {
	return text
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (control) =>
			`\\x${control.codePointAt(0)!.toString(16).padStart(2, "0")}`);
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
