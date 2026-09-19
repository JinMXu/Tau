// OAuth sidecar smoke test: drives the oauth.* methods against sidecar.mjs
// directly over its JSONL stdio protocol. Starts a kimi-coding device flow,
// waits for the device_code event (proving notify() reaches oauth.status),
// then cancels — no login is completed and no credential is written.
//
// Run with the vendored node from the repo root:
//   src-tauri/resources/pi-runtime/node/node scripts/spike/sidecar-oauth-smoke.mjs

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const node = join(root, "src-tauri/resources/pi-runtime/node/node");
const script = join(root, "src-tauri/resources/agent-sidecar/sidecar.mjs");
const pkgIndex = join(
	root,
	"src-tauri/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);

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
		const msg = JSON.parse(line);
		const slot = pending.get(msg.id);
		if (slot) {
			pending.delete(msg.id);
			msg.ok ? slot.resolve(msg.result) : slot.reject(new Error(msg.error));
		}
	}
});

function call(method, params) {
	const id = nextId++;
	return new Promise((resolvePromise, reject) => {
		pending.set(id, { resolve: resolvePromise, reject });
		child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
};

try {
	const ping = await call("ping", {});
	check("ping", typeof ping.pi === "string", `pi ${ping.pi}, node ${ping.node}`);

	const { flowId } = await call("oauth.begin", { providerId: "kimi-coding" });
	check("oauth.begin", typeof flowId === "string" && flowId.length > 0, `flowId=${flowId}`);

	// Poll until the device flow surfaces its code (or the flow dies).
	let status = null;
	let deviceEvent = null;
	for (let i = 0; i < 120; i++) {
		status = await call("oauth.status", { flowId });
		if (status.phase === "error" || status.phase === "cancelled") break;
		if (status.event?.type === "device_code") {
			deviceEvent = status.event;
			break;
		}
		await sleep(500);
	}
	check(
		"oauth.status device_code event",
		deviceEvent !== null,
		deviceEvent
			? `userCode=${deviceEvent.userCode} verificationUri=${deviceEvent.verificationUri}`
			: `last status: ${JSON.stringify(status)}`,
	);
	if (deviceEvent) {
		console.log(`  → open ${deviceEvent.verificationUri} and enter ${deviceEvent.userCode}`);
		console.log("  → (not doing that — cancelling instead, no credential is written)");
	}

	await call("oauth.cancel", { flowId });
	const final = await call("oauth.status", { flowId });
	check(
		"oauth.cancel → terminal status",
		final.phase === "cancelled" || final.phase === "error",
		`phase=${final.phase} error=${final.error}`,
	);

	// Terminal statuses are single-read: the flow must be gone now.
	let gone = false;
	try {
		await call("oauth.status", { flowId });
	} catch (err) {
		gone = /unknown oauth flow/.test(err.message);
	}
	check("flow forgotten after terminal read", gone);
} catch (err) {
	check("smoke", false, err.message);
}

child.stdin.end();
child.kill();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
