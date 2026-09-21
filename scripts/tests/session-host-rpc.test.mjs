// Protocol tests for src-tauri/resources/agent-sidecar/session-host.mjs.
//
// One spawned sidecar for the whole file (after() closes it), driven over the
// same JSONL stdin/stdout contract the Rust side in src-tauri/src/pi.rs uses.
// Every call goes through SessionHostClient#call, which enforces a timeout and
// rejects with the sidecar's stderr tail, so a hanging command fails the test
// instead of wedging the run.
//
//   src-tauri/resources/pi-runtime/node/node.exe --test scripts/tests/

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	CALL_TIMEOUT_MS,
	delay,
	HostStartupError,
	SessionHostClient,
	vendoredRuntimeSkipReason,
	waitForEventAfter,
} from "./session-host-harness.mjs";

let host = null;
let skipReason = vendoredRuntimeSkipReason();
if (!skipReason) {
	try {
		host = await SessionHostClient.start();
	} catch (error) {
		if (error instanceof HostStartupError && error.skipReason) {
			skipReason = error.skipReason;
		} else {
			throw error;
		}
	}
}

after(async () => {
	await host?.close();
});

const protocolTest = (name, fn) => test(name, { skip: skipReason || false, timeout: 120_000 }, fn);

protocolTest("get_state returns the documented response envelope", async () => {
	const res = await host.call({ type: "get_state" });
	assert.equal(res.type, "response");
	assert.equal(res.command, "get_state");
	assert.equal(res.success, true);
	assert.equal(res.error, undefined);
	assert.equal(typeof res.id, "number");

	const state = res.data;
	assert.equal(typeof state.sessionFile, "string");
	assert.ok(state.sessionFile.length > 0, "sessionFile should be a path");
	assert.equal(typeof state.sessionId, "string");
	assert.equal(typeof state.messageCount, "number");
	assert.equal(typeof state.pendingMessageCount, "number");
	assert.equal(state.isStreaming, false);
	assert.equal(typeof state.thinkingLevel, "string");
	assert.equal(typeof state.steeringMode, "string");
	assert.equal(typeof state.followUpMode, "string");
	assert.equal(typeof state.autoCompactionEnabled, "boolean");
	// The host exits(1) at startup when no model is configured, so a live host
	// always reports one.
	assert.equal(typeof state.model?.provider, "string");
	assert.equal(typeof state.model?.id, "string");
});

protocolTest("response ids echo the request id and stay correlated", async () => {
	const [thinkingId, statsId] = host.reserveIds(2);
	await host.writeLine(JSON.stringify({ id: thinkingId, type: "get_available_thinking_levels" }));
	await host.writeLine(JSON.stringify({ id: statsId, type: "get_session_stats" }));

	const thinking = await host.waitForResponse(thinkingId, {
		command: "get_available_thinking_levels",
	});
	const stats = await host.waitForResponse(statsId, { command: "get_session_stats" });

	assert.equal(thinking.id, thinkingId);
	assert.equal(thinking.command, "get_available_thinking_levels");
	assert.equal(stats.id, statsId);
	assert.equal(stats.command, "get_session_stats");
	assert.notEqual(thinkingId, statsId);
});

protocolTest("LF framing accepts CRLF and unterminated trailing lines", async () => {
	const [crlfId, lateId] = host.reserveIds(2);

	await host.writeRaw(`${JSON.stringify({ id: crlfId, type: "get_state" })}\r\n`);
	const crlf = await host.waitForResponse(crlfId, { command: "get_state" });
	assert.equal(crlf.success, true, "a \\r\\n terminated line must be accepted");

	// A line without its LF stays in the framing buffer — the host must not
	// answer (or lose) it, and must answer once the LF arrives.
	await host.writeRaw(JSON.stringify({ id: lateId, type: "get_state" }));
	await assert.rejects(
		host.waitForResponse(lateId, { timeoutMs: 1000, command: "get_state" }),
		/timed out/,
		"an unterminated line must not be answered yet",
	);
	await host.writeRaw("\n");
	const late = await host.waitForResponse(lateId, { command: "get_state" });
	assert.equal(late.success, true);
	assert.equal(late.id, lateId);
});

protocolTest("an unknown command answers with an error instead of hanging", async () => {
	const res = await host.call({ type: "definitely_not_a_command" });
	assert.equal(res.type, "response");
	assert.equal(res.success, false);
	assert.equal(res.command, "definitely_not_a_command");
	assert.equal(res.error, "Unknown command: definitely_not_a_command");
	assert.equal(res.data, undefined);
});

protocolTest("a malformed JSON line yields a parse error and the host keeps serving", async () => {
	const before = host.events.length;
	await host.writeRaw("{ this is not json\n");

	const parseError = await waitForEventAfter(
		host,
		before,
		(event) => event?.type === "response" && event?.command === "parse",
		{ what: 'the "parse" error response' },
	);
	assert.equal(parseError.success, false);
	assert.match(parseError.error, /Failed to parse command/);
	// The parse error carries no command id, so it can never be mistaken for a
	// real response.
	assert.equal(parseError.id, undefined);

	const after = await host.call({ type: "get_state" });
	assert.equal(after.success, true, "the host must still serve commands after a bad line");
});

protocolTest("non-object JSON lines are answered, not crashed on", async () => {
	const before = host.events.length;
	const junk = ["42", '"a string"', "[]", "{}", "true"];
	for (const line of junk) {
		await host.writeRaw(`${line}\n`);
	}
	// Each junk line produces exactly one id-less error response; wait for all
	// of them rather than assuming a fixed arrival order.
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
		`expected ${junk.length} error responses, got ${errors.length}: ${JSON.stringify(host.events.slice(before))}`,
	);
	for (const error of errors) {
		assert.equal(error.command, undefined);
		assert.equal(error.id, undefined);
		assert.match(error.error, /Unknown command/);
	}
	assert.ok(host.isAlive, "the host must survive junk input");
	assert.equal((await host.call({ type: "get_state" })).success, true);
});

protocolTest("an extension_ui_response for an unknown id is ignored", async () => {
	await host.writeRaw(
		`${JSON.stringify({ type: "extension_ui_response", id: "not-a-real-request", value: 1 })}\n`,
	);
	await delay(300);
	assert.ok(host.isAlive, "an unknown extension_ui_response must not kill the host");
	assert.equal((await host.call({ type: "get_state" })).success, true);
});

protocolTest("thinking levels round-trip through get_state", async () => {
	const levels = (await host.call({ type: "get_available_thinking_levels" })).data?.levels;
	assert.ok(Array.isArray(levels) && levels.length > 0, `levels: ${JSON.stringify(levels)}`);
	for (const level of levels) assert.equal(typeof level, "string");

	const original = (await host.call({ type: "get_state" })).data.thinkingLevel;
	const target = levels.find((level) => level !== original) ?? levels[0];

	const set = await host.call({ type: "set_thinking_level", level: target });
	assert.equal(set.success, true, JSON.stringify(set.error ?? ""));
	assert.equal((await host.call({ type: "get_state" })).data.thinkingLevel, target);

	const restore = await host.call({ type: "set_thinking_level", level: original });
	assert.equal(restore.success, true);
	assert.equal((await host.call({ type: "get_state" })).data.thinkingLevel, original);
});

protocolTest("get_available_models lists provider/model pairs", async (t) => {
	const models = (await host.call({ type: "get_available_models" })).data?.models;
	assert.ok(Array.isArray(models), "models must be an array");
	if (models.length === 0) {
		// pi lists the models of providers that have credentials; a machine
		// with no auth (CI) legitimately has none, and there is no shape left
		// to check. The envelope contract above still holds.
		t.skip("no models in this environment (no provider credentials)");
		return;
	}
	for (const model of models) {
		assert.equal(typeof model.provider, "string");
		assert.equal(typeof model.id, "string");
		assert.ok(model.id.length > 0);
	}
});

protocolTest("get_commands lists registered commands with a source", async () => {
	const commands = (await host.call({ type: "get_commands" })).data?.commands;
	assert.ok(Array.isArray(commands), "commands must be an array");
	for (const command of commands) {
		assert.equal(typeof command.name, "string");
		assert.ok(command.name.length > 0);
		assert.equal(typeof command.source, "string");
	}
});

protocolTest("the session name round-trips through get_state", async () => {
	const name = "tau-protocol-test";
	const set = await host.call({ type: "set_session_name", name });
	assert.equal(set.success, true, JSON.stringify(set.error ?? ""));
	assert.equal((await host.call({ type: "get_state" })).data.sessionName, name);

	// Whitespace-only names are rejected rather than silently accepted.
	const blank = await host.call({ type: "set_session_name", name: "   " });
	assert.equal(blank.success, false);
	assert.equal(blank.error, "Session name cannot be empty");
});

protocolTest("steering and follow-up modes round-trip (previous value restored)", async () => {
	// NOTE: set_steering_mode / set_follow_up_mode persist to the *global* pi
	// settings, so each mode is written back to the value it had before.
	const modes = ["all", "one-at-a-time"];
	for (const [command, field] of [
		["set_steering_mode", "steeringMode"],
		["set_follow_up_mode", "followUpMode"],
	]) {
		const original = (await host.call({ type: "get_state" })).data[field];
		const target = modes.find((mode) => mode !== original) ?? modes[0];

		const set = await host.call({ type: command, mode: target });
		assert.equal(set.success, true, JSON.stringify(set.error ?? ""));
		assert.equal((await host.call({ type: "get_state" })).data[field], target);

		const restore = await host.call({ type: command, mode: original });
		assert.equal(restore.success, true);
		assert.equal((await host.call({ type: "get_state" })).data[field], original);
	}
});

protocolTest("auto-compaction toggles round-trip (previous value restored)", async () => {
	// set_auto_compaction persists to the global pi settings; restore it.
	const original = (await host.call({ type: "get_state" })).data.autoCompactionEnabled;
	const set = await host.call({ type: "set_auto_compaction", enabled: !original });
	assert.equal(set.success, true, JSON.stringify(set.error ?? ""));
	assert.equal((await host.call({ type: "get_state" })).data.autoCompactionEnabled, !original);

	const restore = await host.call({ type: "set_auto_compaction", enabled: original });
	assert.equal(restore.success, true);
	assert.equal((await host.call({ type: "get_state" })).data.autoCompactionEnabled, original);
});

protocolTest("idle abort commands are accepted without side effects", async () => {
	for (const type of ["abort", "abort_bash", "abort_retry"]) {
		const res = await host.call({ type });
		assert.equal(res.success, true, `${type}: ${JSON.stringify(res.error ?? "")}`);
		assert.equal(res.command, type);
	}
});

protocolTest("session stats, messages, fork messages and last assistant text shapes", async () => {
	const stats = (await host.call({ type: "get_session_stats" })).data;
	assert.equal(typeof stats.sessionFile, "string");
	assert.equal(typeof stats.sessionId, "string");
	assert.equal(typeof stats.totalMessages, "number");

	const messages = (await host.call({ type: "get_messages" })).data;
	assert.ok(Array.isArray(messages.messages), "get_messages must return an array");

	const forks = (await host.call({ type: "get_fork_messages" })).data;
	assert.ok(Array.isArray(forks.messages), "get_fork_messages must return an array");

	const last = await host.call({ type: "get_last_assistant_text" });
	assert.equal(last.success, true);
	assert.equal(typeof last.data, "object");
	assert.notEqual(last.data, null);
});

protocolTest("get_entries since= returns the suffix after the given entry", async () => {
	const first = await host.call({ type: "get_entries" });
	const entries = first.data?.entries;
	assert.ok(
		Array.isArray(entries) && entries.length > 0,
		"a fresh session still has model/thinking entries",
	);
	assert.equal(typeof first.data.leafId, "string");

	const target = entries[0];
	const since = await host.call({ type: "get_entries", since: target.id });
	assert.equal(since.success, true, JSON.stringify(since.error ?? ""));
	const suffix = since.data.entries;
	assert.equal(suffix.length, entries.length - 1, "the anchor entry itself must be excluded");
	assert.deepEqual(
		suffix.map((entry) => entry.id),
		entries.slice(1).map((entry) => entry.id),
	);

	const missing = await host.call({ type: "get_entries", since: "not-a-real-entry-id" });
	assert.equal(missing.success, false);
	assert.equal(missing.error, "Entry not found: not-a-real-entry-id");

	const tree = await host.call({ type: "get_tree" });
	assert.equal(tree.success, true);
	assert.ok(Array.isArray(tree.data.tree));
	assert.equal(typeof tree.data.leafId, "string");
	assert.equal(tree.data.leafId, (await host.call({ type: "get_entries" })).data.leafId);
});

protocolTest(
	"new_session and switch_session move the session file and rebind cleanly",
	async () => {
		const fileA = (await host.call({ type: "get_state" })).data.sessionFile;

		const created = await host.call({ type: "new_session" });
		assert.equal(created.success, true, JSON.stringify(created.error ?? ""));
		assert.equal(created.data.cancelled, false);
		const fileB = (await host.call({ type: "get_state" })).data.sessionFile;
		assert.notEqual(fileB, fileA, "new_session must open a different session file");

		// Rebind path: the subscription is torn down and re-created, so a command
		// right after the switch proves the host is still wired up.
		const switched = await host.call({ type: "switch_session", sessionPath: fileA });
		assert.equal(switched.success, true, JSON.stringify(switched.error ?? ""));
		const back = await host.call({ type: "get_state" });
		assert.equal(back.data.sessionFile, fileA);
		assert.equal((await host.call({ type: "get_session_stats" })).success, true);
	},
);

protocolTest(
	"bash runs a command and streams bash_execution_update with the command id",
	async () => {
		const [id] = host.reserveIds(1);
		await host.writeLine(JSON.stringify({ id, type: "bash", command: "echo tau-protocol" }));

		const res = await host.waitForResponse(id, { timeoutMs: 25_000, command: "bash" });
		assert.equal(res.success, true, JSON.stringify(res.error ?? ""));
		assert.match(String(res.data?.output ?? ""), /tau-protocol/);
		assert.equal(res.data?.exitCode, 0);

		const update = await host.waitForEvent("bash_execution_update", {
			predicate: (event) => event.id === id,
			timeoutMs: 25_000,
		});
		assert.match(String(update.delta ?? ""), /tau-protocol/);
	},
);

protocolTest("SDK-backed error paths answer with an error instead of hanging", async () => {
	const cases = [
		[
			{ type: "set_model", provider: "no-such-provider", modelId: "no-such-model" },
			/Model not found/,
		],
		[{ type: "prompt" }, /.+/], // no message: fails before any network call
		[{ type: "clone" }, /.+/], // unsaved session
		[{ type: "export_html", outputPath: "tau-protocol-export.html" }, /.+/], // nothing to export
	];
	for (const [command, expected] of cases) {
		const res = await host.call(command);
		assert.equal(res.success, false, `${command.type} should have failed`);
		assert.equal(typeof res.error, "string", `${command.type} error must be a string`);
		assert.match(res.error, expected);
	}
});

protocolTest("stdout carries protocol JSON only", async () => {
	assert.deepEqual(
		host.malformedLines,
		[],
		`non-JSON lines on stdout: ${JSON.stringify(host.malformedLines.slice(0, 3))}`,
	);
	for (const event of host.events) {
		assert.equal(
			typeof event?.type,
			"string",
			`event without a type: ${JSON.stringify(event).slice(0, 120)}`,
		);
	}
});
