// Shared plumbing for the spike scripts.
//
// The vendored runtime ships a platform-specific node binary — node.exe on
// Windows, node elsewhere — and hardcoding the POSIX name made every script
// that spawns it fail with ENOENT on Windows, the project's primary platform.
// The lookup lives here once. Also exports the repo root and the home
// directory (process.env.HOME is unset on Windows).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

export { homedir, root };

/** Path to the vendored runtime's node binary, or null when it is absent. */
export function vendoredNodeBin() {
	const candidate = join(
		root,
		"src-tauri/resources/pi-runtime/node",
		process.platform === "win32" ? "node.exe" : "node",
	);
	return existsSync(candidate) ? candidate : null;
}

/** vendoredNodeBin, but exits with an actionable message when absent. */
export function requireVendoredNodeBin() {
	const bin = vendoredNodeBin();
	if (!bin) {
		console.error(
			"vendored pi runtime not found under src-tauri/resources/pi-runtime — run `npm run vendor:pi` first",
		);
		process.exit(1);
	}
	return bin;
}
