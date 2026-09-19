// Stage-0 spike: verify the pi SDK covers everything Tau's session-host needs.
// Run with the vendored node from the repo root:
//   src-tauri/resources/pi-runtime/node/node scripts/spike/sdk-spike.mjs
//
// Each check prints PASS/FAIL. A real prompt is only attempted when a model
// with credentials is available (network + API key required).

import { pathToFileURL } from "node:url";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const pkgIndex = join(
	root,
	"src-tauri/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
// tau-extension.mjs does createRequire(process.env.TAU_PI_PKG) — same as the
// Rust spawn sets it in production (pi.rs:759-762).
process.env.TAU_PI_PKG = pkgIndex;
const pi = await import(pathToFileURL(pkgIndex));

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
};

// --- 1. SessionManager + createAgentSession + subscribe ----------------------
const tmpCwd = mkdtempSync(join(tmpdir(), "tau-spike-cwd-"));
const tmpSess = mkdtempSync(join(tmpdir(), "tau-spike-sess-"));
let session = null;
const events = [];
try {
	const sm = pi.SessionManager.create(tmpCwd, tmpSess);
	check("SessionManager.create", !!sm);
	const agentDir = pi.getAgentDir();
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd: tmpCwd,
		agentDir,
		additionalExtensionPaths: [join(root, "src-tauri/resources/agent-sidecar/tau-extension.mjs")],
	});
	await resourceLoader.reload();
	check("DefaultResourceLoader.reload (with tau-extension)", true);
	const result = await pi.createAgentSession({ resourceLoader, sessionManager: sm });
	session = result.session;
	check("createAgentSession", !!session);
	const er = result.extensionsResult;
	console.log(
		`  extensionsResult: loaded=${JSON.stringify(er?.extensions?.map?.((e) => e.path) ?? er?.loaded ?? null)} errors=${JSON.stringify(er?.errors ?? er?.diagnostics ?? null)}`,
	);
	const unsub = session.subscribe((ev) => events.push(ev.type));
	check("subscribe", typeof unsub === "function");
	check("getAvailableThinkingLevels", Array.isArray(session.getAvailableThinkingLevels()));
	check("session.messages getter", Array.isArray(session.messages));
	check("getSessionStats", !!session.getSessionStats());
} catch (e) {
	check("session setup", false, e.message);
}

// --- 2. bindExtensions + tau_open_in_editor registered -----------------------
try {
	const requests = [];
	const uiContext = {
		select: (title, options) => {
			requests.push(["select", title, options]);
			return Promise.resolve(undefined);
		},
		confirm: (title, message) => {
			requests.push(["confirm", title, message]);
			return Promise.resolve(undefined);
		},
		input: (title, placeholder) => {
			requests.push(["input", title]);
			return Promise.resolve(undefined);
		},
		notify: (message, type) => {
			requests.push(["notify", message, type]);
		},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
		setEditorText: () => {},
		editor: () => Promise.resolve(undefined),
	};
	await session.bindExtensions({
		uiContext,
		mode: "rpc",
		onError: (err) => console.log("  [ext error]", err?.message ?? err),
	});
	const runner = session.extensionRunner;
	const tools = runner?.getAllRegisteredTools?.() ?? [];
	const names = tools.map((t) => t.name ?? t.definition?.name ?? String(t));
	check("bindExtensions", true, `registered tools: ${names.join(",") || "(none visible)"}`);
	check(
		"tau_open_in_editor registered",
		names.some((n) => String(n).includes("tau_open_in_editor")),
		names.join(","),
	);
} catch (e) {
	check("bindExtensions", false, e.message);
}

// --- 3. exportFromFile deep import (after a prompt, so a session file exists) --
// (deferred — runs in section 6.5 after the prompt)

// --- 4. DefaultPackageManager surface -----------------------------------------
try {
	const settingsManager = pi.SettingsManager.create(tmpCwd, pi.getAgentDir());
	const pm = new pi.DefaultPackageManager({
		cwd: tmpCwd,
		agentDir: pi.getAgentDir(),
		settingsManager,
	});
	const methods = [
		"install",
		"installAndPersist",
		"remove",
		"removeAndPersist",
		"listConfiguredPackages",
	].filter((m) => typeof pm[m] === "function");
	check("DefaultPackageManager methods", methods.length === 5, `found: ${methods.join(",")}`);
	const configured = pm.listConfiguredPackages();
	check("listConfiguredPackages()", Array.isArray(configured), `${configured.length} configured`);
} catch (e) {
	check("DefaultPackageManager", false, e.message);
}

// --- 5. bash / abort_bash / abort_retry surface --------------------------------
try {
	const names = Object.getOwnPropertyNames(Object.getPrototypeOf(session));
	const bashish = names.filter((n) => /bash|retry/i.test(n));
	check("session bash/retry methods", bashish.length > 0, bashish.join(","));
} catch (e) {
	check("bash surface", false, e.message);
}

// --- 6. real prompt (only if a model is available) -----------------------------
try {
	const state = session.state;
	if (!state?.model) {
		check("prompt roundtrip", false, "no model configured — skipped (check pi auth)");
	} else {
		console.log(`  model: ${state.model.provider}/${state.model.id}, prompting…`);
		await session.prompt("Reply with exactly: ok", { source: "rpc" });
		await session.waitForIdle();
		const last = session.getLastAssistantText() ?? "";
		check("prompt roundtrip", last.toLowerCase().includes("ok"), JSON.stringify(last.slice(0, 80)));
		const counts = {};
		for (const t of events) counts[t] = (counts[t] ?? 0) + 1;
		console.log(
			`  events seen: ${Object.entries(counts)
				.map(([k, v]) => `${k}×${v}`)
				.join(" ")}`,
		);
		check(
			"event stream shape",
			(events.includes("message_start") &&
				events.includes("message_update") &&
				events.includes("message_end") &&
				events.includes("agent_end")) ||
				events.includes("agent_settled"),
		);

		// --- 3 (deferred). exportFromFile deep import, now that a session file exists
		try {
			const sessFile = session.sessionFile;
			if (!sessFile || !existsSync(sessFile)) {
				check("exportFromFile", false, `no session file (sessionFile=${sessFile})`);
			} else {
				const mod = await import(
					pathToFileURL(
						join(
							root,
							"src-tauri/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js",
						),
					)
				);
				const out = join(tmpdir(), "tau-spike-export.html");
				const fn = mod.exportFromFile ?? mod.default?.exportFromFile;
				const produced = await fn(sessFile, out);
				check("exportFromFile", existsSync(produced ?? out), produced);
			}
		} catch (e) {
			check("exportFromFile", false, e.message);
		}
	}
} catch (e) {
	check("prompt roundtrip", false, e.message);
}

try {
	session?.dispose();
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
