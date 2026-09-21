// Backpressure / framing tests for src-tauri/resources/agent-sidecar/session-host.mjs.
//
// session-host.mjs serializes every stdout write through a queue whose
// writeChunk() retries ENOBUFS/EAGAIN/EWOULDBLOCK, and handleInputLine() awaits
// that queue after each response — so a client that stops reading must not lose
// or corrupt commands. These tests drive both directions:
//
//   1. client stops reading stdout  -> the sidecar's write queue applies
//      backpressure and must still deliver every response, byte-exact;
//   2. client floods stdin faster than the pipe drains -> the client-side
//      write()/drain path must not drop lines either.
//
//   src-tauri/resources/pi-runtime/node/node.exe --test "scripts/tests/*.test.mjs"

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	delay,
	HostStartupError,
	SessionHostClient,
	vendoredRuntimeSkipReason,
} from "./session-host-harness.mjs";

const skipReason = vendoredRuntimeSkipReason();

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

/** Every response must arrive exactly once, in request order, as valid JSON. */
function assertBurstIntact(host, ids, responses, label) {
	assert.equal(responses.length, ids.length, `${label}: expected ${ids.length} responses`);
	const idsInOrder = responses.map((response) => response.id);
	assert.deepEqual(idsInOrder, ids, `${label}: responses must arrive in request order`);
	for (const response of responses) {
		assert.equal(response.type, "response", `${label}: unexpected envelope`);
		assert.equal(response.success, true, `${label}: ${JSON.stringify(response.error ?? "")}`);
	}
	assert.deepEqual(
		host.malformedLines,
		[],
		`${label}: stdout framing broke — non-JSON lines: ${JSON.stringify(host.malformedLines.slice(0, 3))}`,
	);
	assert.ok(host.isAlive, `${label}: the sidecar must still be running`);
}

/** After the burst the sidecar must still answer, then exit cleanly on EOF. */
async function assertStillHealthy(host, label) {
	assert.equal(
		(await host.call({ type: "get_state" })).success,
		true,
		`${label}: must keep serving`,
	);
	const stdoutEnded = host.waitForStdoutEnd();
	host.endStdin();
	const exit = await host.waitForExit();
	assert.ok(exit, `${label}: the sidecar must exit after stdin EOF`);
	assert.equal(exit.code, 0, `${label}: exit code`);
	assert.equal(await stdoutEnded, true, `${label}: stdout must close on exit`);
}

test(
	"a pipelined burst with stdout paused loses no responses",
	{ skip: skipReason || false, timeout: 300_000 },
	async (t) => {
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		assert.equal((await host.call({ type: "get_state" })).success, true);

		const count = 400;
		const ids = host.reserveIds(count);
		const waiters = ids.map((id) =>
			host.waitForResponse(id, { timeoutMs: 60_000, command: "get_state" }),
		);

		// Stop reading stdout: the sidecar's write queue has to block, and
		// handleInputLine() then stops consuming stdin until we resume.
		host.pauseStdout();
		const lines = ids.map((id) => `${JSON.stringify({ id, type: "get_state" })}\n`);
		await host.writeLines(lines);
		await delay(2500);
		host.resumeStdout();

		const responses = await Promise.all(waiters);
		assertBurstIntact(host, ids, responses, "paused burst");
		await assertStillHealthy(host, "paused burst");
	},
);

test(
	"a stdin burst larger than the pipe buffer loses no commands",
	{ skip: skipReason || false, timeout: 300_000 },
	async (t) => {
		const host = await startHost(t);
		if (!host) return;
		t.after(async () => {
			await host.close();
		});

		assert.equal((await host.call({ type: "get_state" })).success, true);

		// ~105KB of JSONL — past any stdio pipe buffer, so the client-side
		// write() must report backpressure and wait for drain.
		const count = 3000;
		const ids = host.reserveIds(count);
		const waiters = ids.map((id) =>
			host.waitForResponse(id, { timeoutMs: 60_000, command: "get_state" }),
		);
		const lines = ids.map((id) => `${JSON.stringify({ id, type: "get_state" })}\n`);

		await host.writeLines(lines);
		assert.ok(
			host.drainWaits > 0,
			"expected the client to hit stdin backpressure at least once (raise the burst size if not)",
		);

		const responses = await Promise.all(waiters);
		assertBurstIntact(host, ids, responses, "stdin flood");
		await assertStillHealthy(host, "stdin flood");
	},
);
