// Shared harness for the session-host.mjs JSON-RPC protocol tests.
//
// session-host.mjs (src-tauri/resources/agent-sidecar/session-host.mjs) is the
// JSONL stdin/stdout RPC server that src-tauri/src/pi.rs spawns on the vendored
// node. It used to have zero automated coverage — only the hand-run spike in
// scripts/spike/session-host-smoke.mjs. The suites in this directory drive the
// same spawn contract, but with node:test so a hung sidecar fails the run
// instead of blocking it forever:
//
//   * every RPC call has a timeout (CALL_TIMEOUT_MS) and rejects with the
//     sidecar's stderr tail attached, so a hang is diagnosable;
//   * stdout lines are JSON.parsed inside try/catch — a non-JSON line is
//     recorded, never thrown;
//   * only `type: "response"` messages resolve a pending call. Everything else
//     (agent events, extension_ui_request, bash_execution_update — which
//     deliberately echoes the command id) is routed to the event log, which is
//     what the Rust reader does too;
//   * the vendored runtime is gitignored (src-tauri/resources/pi-runtime/*), so
//     every suite skips with an actionable message when `npm run vendor:pi`
//     has not been run.
//
// Run from the repo root with the vendored node (node.exe on Windows, node
// everywhere else — the spike script hardcoded the POSIX name and died with
// ENOENT on Windows):
//
//   src-tauri/resources/pi-runtime/node/node.exe --test scripts/tests/
//
// Or with any node >= 20:  node --test scripts/tests/

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(HERE, "..", "..");
export const RUNTIME_DIR = join(ROOT, "src-tauri", "resources", "pi-runtime");
export const AGENT_SIDECAR_DIR = join(ROOT, "src-tauri", "resources", "agent-sidecar");
export const HOST_SCRIPT = join(AGENT_SIDECAR_DIR, "session-host.mjs");
export const TAU_EXTENSION = join(AGENT_SIDECAR_DIR, "tau-extension.mjs");
export const PI_PKG = join(
	RUNTIME_DIR,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"index.js",
);

/** Cold start (node.exe boot + pi SDK import) is ~3s, but antivirus can make it much slower. */
export const STARTUP_TIMEOUT_MS = 60_000;
/** Per-RPC-call ceiling: a sidecar that never answers fails the call, never hangs the run. */
export const CALL_TIMEOUT_MS = 15_000;
export const EVENT_TIMEOUT_MS = 15_000;
/** Waiting for the sidecar to exit after stdin EOF / a signal. */
export const EXIT_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 4000;
const MAX_EVENTS = 5000;
const MAX_RESPONSES = 20000;

export const isWindows = () => process.platform === "win32";

/**
 * Absolute path of the vendored node binary, or null when the runtime has not
 * been vendored. Windows ships node/node.exe, every other platform node/node —
 * the same candidate order src-tauri/src/pi.rs uses.
 */
export function nodeBinary() {
	const names = isWindows() ? ["node.exe", "node"] : ["node", "node.exe"];
	for (const name of names) {
		const candidate = join(RUNTIME_DIR, "node", name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Why the suite cannot run here, or null when everything needed is present. */
export function vendoredRuntimeSkipReason() {
	if (!nodeBinary()) {
		return `vendored node runtime not found under ${join(RUNTIME_DIR, "node")} — run \`npm run vendor:pi\` first`;
	}
	if (!existsSync(PI_PKG)) {
		return `vendored pi SDK entry not found at ${PI_PKG} — run \`npm run vendor:pi\` first`;
	}
	if (!existsSync(HOST_SCRIPT)) {
		return `session host script not found at ${HOST_SCRIPT}`;
	}
	if (!existsSync(TAU_EXTENSION)) {
		return `tau extension not found at ${TAU_EXTENSION}`;
	}
	return null;
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for an event produced at or after `fromIndex` in the event log. Used for
 * responses that carry no command id (parse errors, junk-input errors), which
 * cannot be matched by id.
 */
export async function waitForEventAfter(
	client,
	fromIndex,
	predicate,
	{ timeoutMs = CALL_TIMEOUT_MS, what = "event" } = {},
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = client.events.slice(fromIndex).find(predicate);
		if (found) return found;
		await delay(50);
	}
	throw new Error(
		`timed out after ${timeoutMs}ms waiting for ${what}; sidecar ${client.isAlive ? "is alive" : "exited"}`,
	);
}

const truncate = (text, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Startup could not happen for an environmental reason (missing runtime, no pi models). */
export class HostStartupError extends Error {
	constructor(message, skipReason) {
		super(message);
		this.name = "HostStartupError";
		this.skipReason = skipReason ?? null;
	}
}

/**
 * Minimal JSONL client for one session-host.mjs child process.
 *
 * One instance per spawned sidecar; tests either keep one for the whole file
 * (after() closes it) or create one per test.
 */
export class SessionHostClient {
	constructor(child, dirs) {
		this.child = child;
		this.dirs = dirs;
		this._decoder = new StringDecoder("utf8");
		this._buffer = "";
		this._pending = new Map();
		this._responses = new Map();
		this._events = [];
		this._eventWaiters = [];
		this._malformedLines = [];
		this._nextId = 1;
		this._stderrTail = "";
		this._exitInfo = null;
		this._stdinEnded = false;
		this._closed = false;
		this._stdoutEnded = false;
		this._drainWaits = 0;

		child.stdout.on("data", (chunk) => this._onStdout(chunk));
		child.stdout.on("end", () => {
			this._stdoutEnded = true;
		});
		child.stderr.on("data", (chunk) => {
			this._stderrTail = `${this._stderrTail}${this._decoder.write(chunk)}`.slice(
				-STDERR_TAIL_CHARS,
			);
		});
		// The sidecar may exit while we still hold a pending write; without this
		// listener an EPIPE would take the whole test process down.
		child.stdin.on("error", () => {});
		child.on("exit", (code, signal) => {
			this._exitInfo = { code, signal };
			for (const [, waiter] of this._pending) {
				clearTimeout(waiter.timer);
				waiter.reject(
					new Error(
						`sidecar exited (code=${code} signal=${signal}) while waiting for id=${waiter.id}; stderr: ${this._stderrTail || "<empty>"}`,
					),
				);
			}
			this._pending.clear();
			for (const waiter of this._eventWaiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(`sidecar exited (code=${code} signal=${signal})`));
			}
		});
	}

	/**
	 * Spawn a session host on the vendored node with the TAU_* env contract and
	 * wait until it answers a first get_state, so a broken startup fails (or
	 * skips) instead of surfacing as a timeout in the first test.
	 */
	static async start(options = {}) {
		const skipReason = vendoredRuntimeSkipReason();
		if (skipReason) {
			throw new HostStartupError(skipReason, skipReason);
		}
		const cwd = mkdtempSync(join(tmpdir(), "tau-session-host-cwd-"));
		const sessionDir = mkdtempSync(join(tmpdir(), "tau-session-host-sess-"));
		const child = spawn(nodeBinary(), [HOST_SCRIPT], {
			cwd,
			env: {
				...process.env,
				// Keep the suite hermetic: no model-catalog refresh over the network.
				PI_OFFLINE: "1",
				TAU_PI_PKG: PI_PKG,
				TAU_SESSION_DIR: sessionDir,
				TAU_EXTENSION: TAU_EXTENSION,
				...options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const client = new SessionHostClient(child, { cwd, sessionDir });
		try {
			await client.call({ type: "get_state" }, { timeoutMs: STARTUP_TIMEOUT_MS });
		} catch (error) {
			const stderr = client.stderrTail;
			const exit = client.exitInfo;
			await client.close();
			if (exit && /no models available/i.test(stderr)) {
				throw new HostStartupError(
					`session host exited during startup: ${stderr.trim().slice(0, 200)}`,
					"session host has no models available (no pi credentials / default model on this machine) — log in with `pi` once or configure a default model; skipping",
				);
			}
			throw new HostStartupError(
				`session host did not answer the first get_state: ${error.message}`,
				null,
			);
		}
		return client;
	}

	// --- protocol ------------------------------------------------------------

	/** Send a command and resolve with its `type: "response"` envelope. */
	call(command, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
		const id = this._nextId;
		this._nextId += 1;
		return this._write(`${JSON.stringify({ id, ...command })}\n`).then(() =>
			this.waitForResponse(id, { timeoutMs, command }),
		);
	}

	/** Reserve command ids without writing anything (used by burst tests). */
	reserveIds(count) {
		const ids = [];
		for (let i = 0; i < count; i += 1) {
			ids.push(this._nextId);
			this._nextId += 1;
		}
		return ids;
	}

	/** Write one raw line, awaiting drain so client-side backpressure is honoured. */
	writeLine(line) {
		return this._write(line.endsWith("\n") ? line : `${line}\n`);
	}

	/** Write exactly `text` (no framing added) — for CRLF / unterminated-line tests. */
	writeRaw(text) {
		return this._write(text);
	}

	/**
	 * Write many lines in one go and honour backpressure: every line is handed
	 * to the stream immediately and a single drain wait covers the whole batch,
	 * so a burst bigger than the pipe buffer is delivered intact.
	 */
	writeLines(lines) {
		const stdin = this.child.stdin;
		if (!stdin || stdin.writableEnded || stdin.destroyed) {
			return Promise.reject(new Error("stdin is closed — cannot write a burst"));
		}
		let needsDrain = false;
		return new Promise((resolve, reject) => {
			const onError = (error) => {
				stdin.off("drain", onDrain);
				reject(error);
			};
			const onDrain = () => {
				stdin.off("error", onError);
				resolve();
			};
			stdin.on("error", onError);
			for (const line of lines) {
				if (stdin.write(line) === false) needsDrain = true;
			}
			if (needsDrain) {
				this._drainWaits += 1;
				stdin.on("drain", onDrain);
			} else {
				stdin.off("error", onError);
				resolve();
			}
		});
	}

	_write(text) {
		const stdin = this.child.stdin;
		if (!stdin || stdin.writableEnded || stdin.destroyed) {
			return Promise.reject(new Error(`stdin is closed — cannot write: ${truncate(text)}`));
		}
		return new Promise((resolve, reject) => {
			const onError = (error) => {
				stdin.off("drain", onDrain);
				reject(error);
			};
			const onDrain = () => {
				stdin.off("error", onError);
				resolve();
			};
			stdin.on("error", onError);
			// write() === false means the pipe is full: wait for drain instead of
			// buffering unboundedly (the ENOBUUFS-shaped failure the sidecar's
			// own write queue has to survive).
			if (stdin.write(text) === false) {
				stdin.on("drain", onDrain);
			} else {
				stdin.off("error", onError);
				resolve();
			}
		});
	}

	/** Resolve with the response carrying `id`, rejecting after `timeoutMs`. */
	waitForResponse(id, { timeoutMs = CALL_TIMEOUT_MS, command = "" } = {}) {
		const seen = this._responses.get(id);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const waiter = {
				id,
				timer: setTimeout(() => {
					this._pending.delete(id);
					reject(
						new Error(
							`timed out after ${timeoutMs}ms waiting for the response to "${command || "?"}" (id=${id}); sidecar ${this._describeState()}`,
						),
					);
				}, timeoutMs),
				resolve,
				reject,
			};
			this._pending.set(id, waiter);
		});
	}

	/** Resolve with the first event of `type` matching `predicate`. */
	waitForEvent(type, { predicate, timeoutMs = EVENT_TIMEOUT_MS } = {}) {
		const seen = this._events.find(
			(event) => event?.type === type && (!predicate || predicate(event)),
		);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this._eventWaiters.findIndex((waiter) => waiter.resolve === resolve);
				if (index !== -1) this._eventWaiters.splice(index, 1);
				reject(
					new Error(
						`timed out after ${timeoutMs}ms waiting for event "${type}"; sidecar ${this._describeState()}`,
					),
				);
			}, timeoutMs);
			this._eventWaiters.push({ type, predicate, resolve, reject, timer });
		});
	}

	_onStdout(chunk) {
		this._buffer += this._decoder.write(chunk);
		while (true) {
			const newline = this._buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this._buffer.slice(0, newline);
			this._buffer = this._buffer.slice(newline + 1);
			if (line.trim().length === 0) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				// stdout must carry protocol JSON only; anything else is a defect.
				this._malformedLines.push(line);
				continue;
			}
			this._route(message);
		}
	}

	_route(message) {
		const id = message?.id;
		if (message?.type === "response" && id !== undefined && id !== null && this._pending.has(id)) {
			const waiter = this._pending.get(id);
			this._pending.delete(id);
			clearTimeout(waiter.timer);
			if (this._responses.size >= MAX_RESPONSES) {
				const oldest = this._responses.keys().next();
				if (!oldest.done) this._responses.delete(oldest.value);
			}
			this._responses.set(id, message);
			waiter.resolve(message);
			return;
		}
		if (this._events.length < MAX_EVENTS) this._events.push(message);
		for (let i = this._eventWaiters.length - 1; i >= 0; i -= 1) {
			const waiter = this._eventWaiters[i];
			if (waiter.type === message?.type && (!waiter.predicate || waiter.predicate(message))) {
				this._eventWaiters.splice(i, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			}
		}
	}

	_describeState() {
		if (this._exitInfo) {
			return `exited with code=${this._exitInfo.code} signal=${this._exitInfo.signal}; stderr: ${this._stderrTail || "<empty>"}`;
		}
		return `is still running; stderr: ${this._stderrTail || "<empty>"}`;
	}

	// --- introspection -------------------------------------------------------

	get events() {
		return this._events;
	}

	get malformedLines() {
		return this._malformedLines;
	}

	get stderrTail() {
		return this._stderrTail;
	}

	get exitInfo() {
		return this._exitInfo;
	}

	get isAlive() {
		return this._exitInfo === null;
	}

	get isStdoutEnded() {
		return this._stdoutEnded;
	}

	/** How often a write had to wait for drain (client-side backpressure). */
	get drainWaits() {
		return this._drainWaits;
	}

	// --- lifecycle -----------------------------------------------------------

	pauseStdout() {
		this.child.stdout.pause();
	}

	resumeStdout() {
		this.child.stdout.resume();
	}

	endStdin() {
		if (this._stdinEnded) return;
		this._stdinEnded = true;
		this.child.stdin.end();
	}

	kill(signal = "SIGTERM") {
		try {
			this.child.kill(signal);
		} catch {
			// Already dead.
		}
	}

	waitForExit({ timeoutMs = EXIT_TIMEOUT_MS } = {}) {
		if (this._exitInfo) return Promise.resolve(this._exitInfo);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), timeoutMs);
			this.child.once("exit", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal });
			});
		});
	}

	waitForStdoutEnd({ timeoutMs = EXIT_TIMEOUT_MS } = {}) {
		if (this._stdoutEnded) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.child.stdout.once("end", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	/** Close stdin, wait for a clean exit, SIGKILL if needed, remove temp dirs. */
	async close() {
		if (this._closed) return this._exitInfo;
		this._closed = true;
		this.endStdin();
		let info = await this.waitForExit({ timeoutMs: EXIT_TIMEOUT_MS });
		if (!info) {
			this.kill("SIGKILL");
			info = await this.waitForExit({ timeoutMs: 5000 });
		}
		this.child.stdout?.resume();
		this.child.stderr?.resume();
		this.child.unref();
		for (const dir of Object.values(this.dirs)) {
			rmSync(dir, { recursive: true, force: true });
		}
		return info;
	}
}
