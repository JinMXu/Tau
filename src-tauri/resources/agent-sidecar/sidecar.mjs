// Tau SDK sidecar — a small Node entry that runs on the vendored runtime and
// exposes pi SDK APIs to the Rust host as JSONL over stdio.
//
// Spawned by src-tauri/src/sidecar.rs with:
//   TAU_PI_PKG=<abs path to pi-coding-agent/dist/index.js> node sidecar.mjs
//
// Protocol: one JSON object per line.
//   → {"id":1,"method":"ping","params":{}}
//   ← {"id":1,"ok":true,"result":{...}}   |   {"id":1,"ok":false,"error":"..."}
//
// The pi package is loaded by absolute file URL (not a bare specifier) so the
// sidecar can live anywhere — ESM resolution of the package's own relative
// chunks and its nested dependencies still works because they resolve from
// the package's own location.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const pkgIndex = process.env.TAU_PI_PKG;
if (!pkgIndex) {
	console.error("[tau-sidecar] TAU_PI_PKG is not set");
	process.exit(1);
}

const pi = await import(pathToFileURL(pkgIndex));

// The HTML exporter is not re-exported from the package index — deep-import
// it relative to the SDK entry (…/dist/index.js → …/dist/core/export-html/).
let exportHtmlMod = null;
async function exportHtmlModule() {
	if (!exportHtmlMod) {
		exportHtmlMod = await import(new URL("core/export-html/index.js", pathToFileURL(pkgIndex)));
	}
	return exportHtmlMod;
}

function packageManager(cwd) {
	const agentDir = pi.getAgentDir();
	return new pi.DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: pi.SettingsManager.create(cwd, agentDir),
	});
}

function countByType(entries) {
	const counts = {};
	for (const entry of entries) {
		counts[entry.type] = (counts[entry.type] ?? 0) + 1;
	}
	return counts;
}

async function handle(method, params) {
	switch (method) {
		case "ping":
			return {
				pi: pi.VERSION,
				node: process.version,
				agentDir: pi.getAgentDir(),
			};
		case "agent.paths":
			return { agentDir: pi.getAgentDir(), configDir: pi.CONFIG_DIR_NAME };
		case "session.parse": {
			const path = String(params?.path ?? "");
			if (!path) throw new Error("params.path is required");
			const content = readFileSync(path, "utf8");
			const entries = pi.parseSessionEntries(content);
			const header = entries.find((e) => e.type === "session") ?? null;
			return {
				header,
				entryCount: entries.length,
				counts: countByType(entries),
			};
		}
		case "session.export_html": {
			const path = String(params?.path ?? "");
			const outPath = String(params?.outPath ?? "");
			if (!path) throw new Error("params.path is required");
			const mod = await exportHtmlModule();
			let produced;
			if (typeof mod.exportFromFile === "function") {
				produced = await mod.exportFromFile(path, outPath || undefined);
			} else {
				// SDK builds without exportFromFile: same work by hand, like
				// the TUI's /export (SessionManager + exportSessionToHtml).
				const sm = pi.SessionManager.open(path);
				produced = await mod.exportSessionToHtml(sm, undefined, outPath || undefined);
			}
			return { outPath: produced };
		}
		case "package.list": {
			const cwd = String(params?.cwd ?? "") || process.cwd();
			return packageManager(cwd).listConfiguredPackages();
		}
		case "package.install":
		case "package.remove": {
			const cwd = String(params?.cwd ?? "") || process.cwd();
			const source = String(params?.source ?? "");
			if (!source) throw new Error("params.source is required");
			const options = { local: params?.local === true };
			if (method === "package.install") {
				await packageManager(cwd).installAndPersist(source, options);
				return { installed: source };
			}
			return { removed: await packageManager(cwd).removeAndPersist(source, options) };
		}
		default:
			throw new Error(`unknown method: ${method}`);
	}
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	if (!line.trim()) continue;
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		continue;
	}
	const { id, method, params } = req ?? {};
	try {
		const result = await handle(method, params ?? {});
		process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
	} catch (err) {
		const error = err?.message ?? String(err);
		process.stdout.write(JSON.stringify({ id, ok: false, error }) + "\n");
	}
}
process.exit(0);
