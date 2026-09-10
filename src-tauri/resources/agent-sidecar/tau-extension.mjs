// Tau desktop-tool extension — loaded by the pi RPC process via
// `--extension <path>` (wired in src-tauri/src/pi.rs). Registers tools that
// give the agent access to desktop-host capabilities a terminal CLI cannot
// offer. Runs in-process with pi; desktop actions are executed directly.
//
// typebox is resolved through the pi package's own dependency tree via
// createRequire (it lives nested under pi-coding-agent/node_modules).
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(process.env.TAU_PI_PKG);
const { Type } = require("typebox");

const OPEN_PARAMS = Type.Object({
	path: Type.String({ description: "Absolute path of the file or folder to open" }),
});

function openInEditor(target) {
	if (!existsSync(target)) {
		return `not found: ${target}`;
	}
	let child;
	if (process.platform === "win32") {
		// VS Code when available, Notepad as the guaranteed fallback.
		child = spawn("cmd", ["/c", "where", "code"], { stdio: "ignore", windowsHide: true });
		child.on("exit", (code) => {
			if (code === 0) {
				spawn("cmd", ["/c", "code", target], { stdio: "ignore", windowsHide: true, detached: true });
			} else {
				spawn("notepad.exe", [target], { stdio: "ignore", windowsHide: true, detached: true });
			}
		});
	} else {
		child = spawn("code", [target], { stdio: "ignore", detached: true });
	}
	child.unref?.();
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
