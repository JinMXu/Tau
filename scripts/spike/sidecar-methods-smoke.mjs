// Stage-3 smoke test: exercise the new sidecar methods (session.export_html,
// package.list) against a real session file, talking to sidecar.mjs directly
// over its JSONL stdio protocol.
//
// Run with the vendored node from the repo root (node.exe on Windows):
//   src-tauri/resources/pi-runtime/node/node scripts/spike/sidecar-methods-smoke.mjs [session.jsonl]
//
// With no argument, the newest ~/.pi/agent/sessions/**/*.jsonl is used.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir, requireVendoredNodeBin, root } from "./vendored-runtime.mjs";

const node = requireVendoredNodeBin();
const script = join(root, "src-tauri/resources/agent-sidecar/sidecar.mjs");
const pkgIndex = join(
	root,
	"src-tauri/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);

function newestSessionFile(dir) {
	let best = null;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = newestSessionFile(full);
			if (nested && (!best || nested.mtime > best.mtime)) best = nested;
		} else if (entry.name.endsWith(".jsonl")) {
			const mtime = statSync(full).mtimeMs;
			if (!best || mtime > best.mtime) best = { path: full, mtime };
		}
	}
	return best;
}

const sessionPath =
	process.argv[2] ?? newestSessionFile(join(homedir(), ".pi/agent/sessions"))?.path;
if (!sessionPath || !existsSync(sessionPath)) {
	console.error("no session file found — pass one as argv[2]");
	process.exit(1);
}

const child = spawn(node, [script], {
	env: { ...process.env, TAU_PI_PKG: pkgIndex },
	stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const nl = buffer.indexOf("\n");
		if (nl < 0) break;
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (!line.trim()) continue;
		// A sidecar that dies mid-line (or prints a warning to stdout) would
		// otherwise crash the smoke script with an opaque JSON error.
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		const slot = pending.get(msg.id);
		if (slot) {
			pending.delete(msg.id);
			msg.ok ? slot.resolve(msg.result) : slot.reject(new Error(msg.error));
		}
	}
});

function call(method, params, timeoutMs = 60_000) {
	const id = nextId++;
	return new Promise((resolvePromise, reject) => {
		// A hung sidecar must fail the script, not wedge it forever.
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`call ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		pending.set(id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		});
		child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
	});
}

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
};

try {
	const ping = await call("ping", {});
	check("ping", typeof ping.pi === "string", `pi ${ping.pi}, node ${ping.node}`);

	const outPath = join(tmpdir(), "tau-sidecar-smoke-export.html");
	const exported = await call("session.export_html", { path: sessionPath, outPath });
	check(
		"session.export_html",
		typeof exported.outPath === "string" && existsSync(exported.outPath),
		`${exported.outPath} (${statSync(exported.outPath).size} bytes, from ${sessionPath})`,
	);

	const packages = await call("package.list", { cwd: root });
	check("package.list", Array.isArray(packages), `${packages.length} configured package(s)`);
	for (const pkg of packages) {
		console.log(
			`  [${pkg.scope}] ${pkg.source}${pkg.filtered ? " (filtered)" : ""}${pkg.installedPath ? " -> " + pkg.installedPath : ""}`,
		);
	}
} catch (err) {
	check("smoke", false, err.message);
}

child.stdin.end();
child.kill();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
