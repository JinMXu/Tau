// Process-lifecycle tests for src-tauri/resources/agent-sidecar/session-host.mjs:
// stdin EOF, SIGTERM/SIGHUP, survival of malformed input, and the one input
// shape that currently kills the host. Each test spawns (and tears down) its
// own sidecar, so a crash in one cannot mask the next.
//
//   src-tauri/resources/pi-runtime/node/node.exe --test "scripts/tests/*.test.mjs"

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CALL_TIMEOUT_MS,
	delay,
	HostStartupError,
	isWindows,
	SessionHostClient,
	vendoredRuntimeSkipReason,
	waitForEventAfter,
} from "./session-host-harness.mjs";

const skipReason = vendoredRuntimeSkipReason();

/**
 * Spawn a sidecar for a single test. Returns null when the environment cannot
 * run it (no vendored runtime, no pi models) — the caller must then return.
 */
async function startHost(t) {
	try {
		return await SessionHostClient.start();
	} catch (error) {
		if (error instanceof HostStartupError && error.skipReason) {
			t.skip(error.skipReason);
			return null;
		}
		throw error;
	}
}

test(
	"stdin EOF exits with code 0 and closes stdout",
	{ skip: skipReason || false, timeout: 120_000 },
	async (t) => {
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		// Prove the host is fully up before pulling the plug.
		assert.equal((await host.call({ type: "get_state" })).success, true);

		const stdoutEnded = host.waitForStdoutEnd();
		host.endStdin();

		const exit = await host.waitForExit();
		assert.ok(exit, "the sidecar must exit after stdin EOF");
		assert.equal(exit.code, 0);
		assert.equal(exit.signal, null);
		assert.equal(await stdoutEnded, true, "stdout must be closed when the sidecar exits");
		assert.equal(host.isStdoutEnded, true);
	},
);

test(
	"SIGTERM stops the sidecar and closes stdout",
	{ skip: skipReason || false, timeout: 120_000 },
	async (t) => {
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		assert.equal((await host.call({ type: "get_state" })).success, true);

		const stdoutEnded = host.waitForStdoutEnd();
		host.kill("SIGTERM");

		const exit = await host.waitForExit();
		assert.ok(exit, "the sidecar must exit after SIGTERM");
		assert.equal(await stdoutEnded, true, "stdout must be closed after SIGTERM");

		if (isWindows()) {
			// Node cannot deliver a catchable SIGTERM to a Windows child: libuv calls
			// TerminateProcess, so session-host.mjs's handler (which would flush
			// nothing and exit 143) never runs. Only the "it dies, stdout closes"
			// half of the contract is verifiable here; the graceful exit-code half
			// is covered by the stdin-EOF test and by the POSIX branch below.
			t.diagnostic(
				`Windows SIGTERM: code=${exit.code} signal=${exit.signal} (TerminateProcess — the host's handler cannot run)`,
			);
			assert.ok(exit.code !== 0 || exit.signal !== null, "the sidecar must not exit 0 on SIGTERM");
		} else {
			assert.equal(exit.code, 143, "SIGTERM must exit with 143");
			assert.equal(exit.signal, null);
		}
	},
);

test(
	"SIGHUP stops the sidecar with the documented exit code (POSIX only)",
	{ skip: skipReason || false, timeout: 120_000 },
	async (t) => {
		if (isWindows()) {
			// session-host.mjs registers SIGHUP only when process.platform !== "win32".
			t.skip(
				"SIGHUP is not registered on Windows (session-host.mjs guards the handler with process.platform)",
			);
			return;
		}
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		assert.equal((await host.call({ type: "get_state" })).success, true);

		const stdoutEnded = host.waitForStdoutEnd();
		host.kill("SIGHUP");

		const exit = await host.waitForExit();
		assert.ok(exit, "the sidecar must exit after SIGHUP");
		assert.equal(exit.code, 129, "SIGHUP must exit with 129");
		assert.equal(await stdoutEnded, true, "stdout must be closed after SIGHUP");
	},
);

test(
	"the sidecar survives malformed input and still exits cleanly",
	{ skip: skipReason || false, timeout: 120_000 },
	async (t) => {
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		assert.equal((await host.call({ type: "get_state" })).success, true);

		// Every shape except a bare `null` (see the next test) must be answered
		// with an error response, not a crash.
		const junk = ["{ not json at all", "42", '"a bare string"', "[]", "{}", "true"];
		const before = host.events.length;
		for (const line of junk) {
			await host.writeRaw(`${line}\n`);
		}

		const deadline = Date.now() + CALL_TIMEOUT_MS;
		let errors = [];
		while (Date.now() < deadline && errors.length < junk.length) {
			errors = host.events
				.slice(before)
				.filter((event) => event?.type === "response" && event?.success === false);
			if (errors.length < junk.length) await delay(50);
		}
		assert.equal(
			errors.length,
			junk.length,
			`expected ${junk.length} error responses, got ${errors.length}`,
		);
		for (const error of errors) {
			assert.equal(error.id, undefined, "error responses must not carry a command id");
			assert.equal(typeof error.error, "string");
			assert.ok(error.error.length > 0);
		}

		// The invalid-JSON line is reported through the parse branch, everything
		// else through the unknown-command branch.
		const parseError = await waitForEventAfter(
			host,
			before,
			(event) => event?.command === "parse",
			{ what: 'the "parse" error response' },
		);
		assert.match(parseError.error, /Failed to parse command/);

		assert.ok(host.isAlive, "the sidecar must survive malformed input");
		assert.equal((await host.call({ type: "get_state" })).success, true, "and keep serving");

		const stdoutEnded = host.waitForStdoutEnd();
		host.endStdin();
		const exit = await host.waitForExit();
		assert.ok(exit);
		assert.equal(exit.code, 0);
		assert.equal(await stdoutEnded, true);
	},
);

test(
	"a bare null line is survived like any other malformed input",
	{ skip: skipReason || false, timeout: 120_000 },
	async (t) => {
		// Regression: handleCommand(null) throws, and the catch block in
		// handleInputLine used to throw again on `parsed.id` — that second throw
		// escaped as an unhandledRejection whose process-level handler logs and
		// exit(1)s, killing the session over one malformed line. The host now
		// answers with an id-less error and keeps serving.
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		const before = host.events.length;
		assert.equal((await host.call({ type: "get_state" })).success, true);
		await host.writeRaw("null\n");

		const error = await waitForEventAfter(
			host,
			before,
			(event) => event?.type === "response" && event?.success === false,
			{ what: "the error response for the null line" },
		);
		assert.equal(error.id, undefined, "the error response must not carry a command id");
		assert.ok(typeof error.error === "string" && error.error.length > 0);

		assert.ok(host.isAlive, "the sidecar must survive a bare null line");
		assert.equal((await host.call({ type: "get_state" })).success, true, "and keep serving");

		const stdoutEnded = host.waitForStdoutEnd();
		host.endStdin();
		const exit = await host.waitForExit();
		assert.ok(exit);
		assert.equal(exit.code, 0);
		assert.equal(await stdoutEnded, true);
	},
);
