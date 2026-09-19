// Smoke test for src-tauri/resources/agent-sidecar/session-host.mjs: spawns it
// on the vendored node with the TAU_* env contract and drives the RPC protocol
// end-to-end (state, models, prompt roundtrip, bash, session switching).
// Run from the repo root:
//   src-tauri/resources/pi-runtime/node/node scripts/spike/session-host-smoke.mjs

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const nodeBin = join(root, "src-tauri/resources/pi-runtime/node/node");
const hostScript = join(root, "src-tauri/resources/agent-sidecar/session-host.mjs");
const pkgIndex = join(
	root,
	"src-tauri/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
const tauExtension = join(root, "src-tauri/resources/agent-sidecar/tau-extension.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
	if (!ok) failures++;
};

const tmpCwd = mkdtempSync(join(tmpdir(), "tau-host-cwd-"));
const tmpSess = mkdtempSync(join(tmpdir(), "tau-host-sess-"));

const child = spawn(nodeBin, [hostScript], {
	cwd: tmpCwd,
	env: {
		...process.env,
		TAU_PI_PKG: pkgIndex,
		TAU_SESSION_DIR: tmpSess,
		TAU_EXTENSION: tauExtension,
	},
	stdio: ["pipe", "pipe", "pipe"],
});

let stderrTail = "";
child.stderr.on("data", (d) => {
	const text = d.toString();
	stderrTail = (stderrTail + text).slice(-4000);
	process.stderr.write(`  [host stderr] ${text}`);
});

// --- minimal JSONL client ----------------------------------------------------
let buffer = "";
const pending = new Map(); // id -> {resolve, reject, timer}
const events = [];
const eventWaiters = []; // {type, pred, resolve, timer}
let nextId = 1;

child.stdout.on("data", (d) => {
	buffer += d.toString();
	while (true) {
		const idx = buffer.indexOf("\n");
		if (idx === -1) return;
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			check("stdout line is valid JSON", false, line.slice(0, 120));
			continue;
		}
		if (msg.type === "response" && msg.id !== undefined && pending.has(msg.id)) {
			const p = pending.get(msg.id);
			pending.delete(msg.id);
			clearTimeout(p.timer);
			p.resolve(msg);
		} else {
			events.push(msg);
			for (let i = eventWaiters.length - 1; i >= 0; i--) {
				const w = eventWaiters[i];
				if (w.type === msg.type && (!w.pred || w.pred(msg))) {
					eventWaiters.splice(i, 1);
					clearTimeout(w.timer);
					w.resolve(msg);
				}
			}
		}
	}
});

function send(cmd, { timeoutMs = 60_000, expectResponse = true } = {}) {
	const id = nextId++;
	child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
	if (!expectResponse) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`timeout waiting for response to ${cmd.type} (id=${id})`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
	});
}

function waitEvent(type, { timeoutMs = 120_000, pred } = {}) {
	const seen = events.find((e) => e.type === type && (!pred || pred(e)));
	if (seen) return Promise.resolve(seen);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const i = eventWaiters.findIndex((w) => w.resolve === resolve);
			if (i !== -1) eventWaiters.splice(i, 1);
			reject(new Error(`timeout waiting for event ${type}`));
		}, timeoutMs);
		eventWaiters.push({ type, pred, resolve, timer });
	});
}

async function step(name, fn) {
	try {
		await fn();
	} catch (e) {
		check(name, false, e.message);
	}
}

// --- test sequence -------------------------------------------------------------
let sessionFileA = null;

await step("get_state response envelope", async () => {
	const res = await send({ type: "get_state" });
	check("get_state success", res.success === true, JSON.stringify(res.error ?? ""));
	check(
		"get_state envelope shape",
		res.type === "response" && res.command === "get_state" && typeof res.id === "number",
	);
	check(
		"get_state data",
		!!res.data &&
			typeof res.data.sessionFile === "string" &&
			typeof res.data.messageCount === "number",
	);
	check(
		"model configured",
		!!res.data?.model,
		res.data?.model
			? `${res.data.model.provider}/${res.data.model.id}`
			: "no model — check pi auth",
	);
	sessionFileA = res.data.sessionFile;
});

await step("get_available_thinking_levels", async () => {
	const res = await send({ type: "get_available_thinking_levels" });
	check(
		"thinking levels",
		res.success === true && Array.isArray(res.data?.levels),
		JSON.stringify(res.data?.levels),
	);
	if (res.data?.levels?.length) {
		const set = await send({ type: "set_thinking_level", level: res.data.levels[0] });
		check("set_thinking_level", set.success === true, JSON.stringify(set.error ?? ""));
	}
});

await step("get_available_models", async () => {
	const res = await send({ type: "get_available_models" });
	check(
		"available models",
		res.success === true && Array.isArray(res.data?.models) && res.data.models.length > 0,
		`${res.data?.models?.length ?? 0} models`,
	);
});

await step("get_commands", async () => {
	const res = await send({ type: "get_commands" });
	check(
		"commands list",
		res.success === true && Array.isArray(res.data?.commands),
		`${res.data?.commands?.length ?? 0} commands`,
	);
});

await step("set_session_name", async () => {
	const res = await send({ type: "set_session_name", name: "smoke" });
	check("set_session_name", res.success === true, JSON.stringify(res.error ?? ""));
	const state = await send({ type: "get_state" });
	check(
		"sessionName applied",
		state.data?.sessionName === "smoke",
		String(state.data?.sessionName),
	);
});

await step("prompt roundtrip", async () => {
	const state = await send({ type: "get_state" });
	if (!state.data?.model) {
		check("prompt roundtrip", false, "no model configured — skipped");
		return;
	}
	const res = await send({ type: "prompt", message: "Reply with exactly: ok" });
	check("prompt accepted", res.success === true, JSON.stringify(res.error ?? ""));
	await waitEvent("agent_settled", { timeoutMs: 180_000 });
	const types = new Set(events.map((e) => e.type));
	check("message_start seen", types.has("message_start"));
	check("message_update seen", types.has("message_update"));
	const mu = events.find((e) => e.type === "message_update");
	check(
		"message_update has assistantMessageEvent",
		!!mu &&
			typeof mu.assistantMessageEvent === "object" &&
			typeof mu.assistantMessageEvent.type === "string",
	);
	const me = events.find((e) => e.type === "message_end");
	check("message_end seen", !!me);
	check("message_end content is array", Array.isArray(me?.message?.content));
	check("agent_end seen", types.has("agent_end"));
	check("agent_settled seen", types.has("agent_settled"));
	const last = await send({ type: "get_last_assistant_text" });
	check(
		"assistant replied 'ok'",
		last.success === true && (last.data?.text ?? "").toLowerCase().includes("ok"),
		JSON.stringify((last.data?.text ?? "").slice(0, 60)),
	);
});

await step("get_session_stats", async () => {
	const res = await send({ type: "get_session_stats" });
	check("session stats", res.success === true && typeof res.data === "object" && res.data !== null);
});

await step("get_messages", async () => {
	const res = await send({ type: "get_messages" });
	check(
		"messages",
		res.success === true && Array.isArray(res.data?.messages) && res.data.messages.length >= 2,
		`${res.data?.messages?.length ?? 0} messages`,
	);
});

await step("bash", async () => {
	const res = await send({ type: "bash", command: "echo hi" });
	check("bash success", res.success === true, JSON.stringify(res.error ?? ""));
	const out = res.data?.output ?? JSON.stringify(res.data);
	check("bash output contains hi", out.includes("hi"), out.slice(0, 60));
	check(
		"bash_execution_update seen",
		events.some((e) => e.type === "bash_execution_update"),
	);
});

await step("new_session + switch_session", async () => {
	const res = await send({ type: "new_session" });
	check(
		"new_session",
		res.success === true && res.data?.cancelled === false,
		JSON.stringify(res.error ?? res.data),
	);
	const after = await send({ type: "get_state" });
	check(
		"session file changed",
		!!after.data?.sessionFile && after.data.sessionFile !== sessionFileA,
		`${sessionFileA} -> ${after.data?.sessionFile}`,
	);
	const sw = await send({ type: "switch_session", sessionPath: sessionFileA });
	check("switch_session back", sw.success === true, JSON.stringify(sw.error ?? ""));
	const back = await send({ type: "get_state" });
	check(
		"session file restored",
		back.data?.sessionFile === sessionFileA,
		String(back.data?.sessionFile),
	);
});

await step("unknown command", async () => {
	const res = await send({ type: "definitely_not_a_command" });
	check(
		"unknown type -> success:false",
		res.success === false && typeof res.error === "string",
		JSON.stringify(res.error ?? ""),
	);
});

// stdin EOF -> graceful exit(0)
const exitInfo = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve({ timeout: true }), 30_000);
	child.on("exit", (code, signal) => {
		clearTimeout(timer);
		resolve({ code, signal });
	});
	child.stdin.end();
});
check("graceful exit on stdin EOF", exitInfo.code === 0, JSON.stringify(exitInfo));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
