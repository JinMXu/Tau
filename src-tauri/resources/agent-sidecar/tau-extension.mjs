import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(process.env.TAU_PI_PKG);
const { Type } = require("typebox");

const OPEN_PARAMS = Type.Object({
	path: Type.String({ description: "Absolute path of the file or folder to open" }),
});

/// Open `target` in a desktop editor and return a human-readable outcome.
/// VS Code when installed (resolved to its real exe — `code` is a .cmd shim
/// that either flashes a console or needs windowsHide, which would hide the
/// window), otherwise Notepad, otherwise Explorer's default handler. Editor
/// spawns deliberately do NOT pass windowsHide: it makes Windows GUI apps
/// start with a hidden window (STARTF_USESHOWWINDOW/SW_HIDE) — the process
/// runs but nothing appears, which is worse than failing.
function openInEditor(target) {
	if (!existsSync(target)) {
		return `not found: ${target}`;
	}
	if (process.platform === "win32") {
		try {
			const where = spawnSync("cmd", ["/c", "where", "code"], {
				encoding: "utf8",
				windowsHide: true,
			});
			if (where.status === 0) {
				const shim = (where.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
				if (shim) {
					const codeExe = join(dirname(dirname(shim.trim())), "Code.exe");
					if (existsSync(codeExe)) {
						spawn(codeExe, [target], { stdio: "ignore", detached: true }).unref();
						return `opening ${target} in VS Code`;
					}
				}
			}
		} catch {
			// fall through to Notepad
		}
		spawn("notepad.exe", [target], { stdio: "ignore", detached: true }).unref();
		return `opening ${target} in Notepad`;
	}
	spawn("code", [target], { stdio: "ignore", detached: true }).unref();
	return `opening ${target} in editor`;
}

/** @returns {import("@earendil-works/pi-coding-agent").ExtensionFactory} */
export default function tauExtension(pi) {
	pi.registerTool({
		name: "tau_open_in_editor",
		label: "Open in Editor",
		description:
			"Open a file in the user's desktop editor (VS Code when installed, otherwise Notepad). " +
			"Use after editing or inspecting a file when the user may want to see it in a real editor.",
		promptSnippet: "Open a file in the user's desktop editor",
		promptGuidelines: [
			"Use tau_open_in_editor when the user asks to open, show or review a file in their editor.",
		],
		parameters: OPEN_PARAMS,
		async execute(_toolCallId, params) {
			const text = openInEditor(String(params.path ?? ""));
			return {
				content: [{ type: "text", text }],
				details: { tool: "tau_open_in_editor", path: params.path },
			};
		},
	});
}
