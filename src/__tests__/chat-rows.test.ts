import { describe, expect, it } from "vitest";
import type { Block, ChatMessage } from "../chat-types";
import {
	attachToolResults,
	buildChatRows,
	type MessageItem,
	deriveTurnChanges,
	deriveTurnTimings,
	extractTodos,
	numberDiff,
	searchBypassIds,
} from "../components/chat-rows";

let nextId = 1;

function msg(
	role: ChatMessage["role"],
	blocks: Block[],
	extra?: Partial<ChatMessage>,
): ChatMessage {
	return { id: nextId++, role, blocks, streaming: false, ...extra };
}

describe("numberDiff", () => {
	it("assigns old/new line numbers (ctx advances both, add/del advance one)", () => {
		const lines = numberDiff([
			{ type: "ctx", text: "a" },
			{ type: "del", text: "b" },
			{ type: "del", text: "c" },
			{ type: "add", text: "B" },
			{ type: "ctx", text: "d" },
		]);
		expect(lines.map((l) => [l.oldNo, l.newNo])).toEqual([
			[1, 1],
			[2, null],
			[3, null],
			[null, 2],
			[4, 3],
		]);
	});
});

describe("deriveTurnChanges", () => {
	const editArgs = JSON.stringify({
		path: "src/a.ts",
		oldText: "a\nb\nc",
		newText: "a\nB\nc",
	});
	const writeArgs = JSON.stringify({ path: "src/new.ts", content: "x\ny\n" });

	it("derives per-turn file changes from edit tool calls", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "hi" }]),
			msg("assistant", [
				{ kind: "thinking", text: "hmm" },
				{ kind: "tool", name: "edit", args: editArgs },
			]),
		];
		const turns = deriveTurnChanges(messages);
		expect(turns).toHaveLength(1);
		expect(turns[0].turnIndex).toBe(0);
		expect(turns[0].files).toHaveLength(1);
		const file = turns[0].files[0];
		expect(file.path).toBe("src/a.ts");
		expect(file.added).toBe(1);
		expect(file.removed).toBe(1);
		expect(file.sections[0].map((l) => l.text)).toEqual(["a", "b", "B", "c"]);
		expect(turns[0].totalAdded).toBe(1);
		expect(turns[0].totalRemoved).toBe(1);
	});

	it("treats write content as all-added lines and skips non-file tools", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "hi" }]),
			msg("assistant", [
				{ kind: "tool", name: "write", args: writeArgs },
				{ kind: "tool", name: "bash", args: JSON.stringify({ command: "ls" }) },
			]),
		];
		const turns = deriveTurnChanges(messages);
		expect(turns[0].files).toHaveLength(1);
		expect(turns[0].files[0].path).toBe("src/new.ts");
		expect(turns[0].totalAdded).toBe(2);
		expect(turns[0].totalRemoved).toBe(0);
	});

	it("merges multiple edits to the same file within a turn and splits turns on user messages", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "t1" }]),
			msg("assistant", [{ kind: "tool", name: "edit", args: editArgs }]),
			msg("assistant", [{ kind: "tool", name: "edit", args: editArgs }]),
			msg("user", [{ kind: "text", text: "t2" }]),
			msg("assistant", [{ kind: "tool", name: "write", args: writeArgs }]),
		];
		const turns = deriveTurnChanges(messages);
		expect(turns).toHaveLength(2);
		expect(turns[0].files[0].sections).toHaveLength(2);
		expect(turns[0].totalAdded).toBe(2);
		expect(turns[1].turnIndex).toBe(1);
		expect(turns[1].files[0].path).toBe("src/new.ts");
	});

	it("returns [] for sessions without edit/write calls", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "hi" }]),
			msg("assistant", [{ kind: "text", text: "hello" }]),
		];
		expect(deriveTurnChanges(messages)).toEqual([]);
	});
});

describe("deriveTurnTimings", () => {
	it("uses the user message as start and the newest message as end", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "hi" }], { timestamp: "2026-01-01T00:00:00.000Z" }),
			msg("assistant", [{ kind: "text", text: "yo" }], {
				timestamp: "2026-01-01T00:00:10.000Z",
			}),
			msg("tool", [{ kind: "tool", name: "bash", args: "out", result: true }], {
				timestamp: "2026-01-01T00:00:42.000Z",
			}),
		];
		const timings = deriveTurnTimings(messages);
		expect(timings).toHaveLength(1);
		expect(timings[0].startedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
		expect(timings[0].endedAt).toBe(Date.parse("2026-01-01T00:00:42.000Z"));
	});

	it("keeps endedAt null for a live turn without timestamps", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "hi" }]),
			msg("assistant", [{ kind: "tool", name: "bash", args: "{}" }], { streaming: true }),
		];
		const timings = deriveTurnTimings(messages);
		expect(timings[0].startedAt).toBeNull();
		expect(timings[0].endedAt).toBeNull();
	});
});

describe("extractTodos", () => {
	it("returns the latest todo tool call's list", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "plan" }]),
			msg("assistant", [
				{
					kind: "tool",
					name: "todo",
					args: JSON.stringify({
						todos: [
							{ content: "a", status: "completed" },
							{ content: "b", status: "in_progress" },
							{ content: "c", status: "pending" },
						],
					}),
				},
			]),
			msg("assistant", [
				{
					kind: "tool",
					name: "todo",
					args: JSON.stringify({
						todos: [
							{ content: "a", status: "completed" },
							{ content: "b", status: "completed" },
							{ content: "c", status: "in_progress" },
						],
					}),
				},
			]),
		];
		const todos = extractTodos(messages);
		expect(todos).toHaveLength(3);
		expect(todos[2]).toEqual({ content: "c", status: "in_progress" });
	});

	it("skips partial streaming args and invalid entries", () => {
		const messages = [
			msg("assistant", [{ kind: "tool", name: "todo", args: '{"todos":[{"cont' }]),
			msg("assistant", [
				{
					kind: "tool",
					name: "todo",
					args: JSON.stringify({ todos: [{ content: "", status: "pending" }, "junk"] }),
				},
			]),
		];
		expect(extractTodos(messages)).toEqual([]);
	});

	it("returns [] when the session never used the todo tool", () => {
		expect(extractTodos([msg("assistant", [{ kind: "text", text: "hi" }])])).toEqual([]);
	});
});

describe("buildChatRows", () => {
	function toolWithResult() {
		const call = msg("assistant", [
			{ kind: "thinking", text: "let me look" },
			{ kind: "tool", name: "read", args: '{"path":"a.ts"}' },
			{ kind: "text", text: "here is what I found" },
		]);
		const result = msg("tool", [{ kind: "tool", name: "read", args: "file body", result: true }]);
		return [call, result];
	}

	it("folds thinking + tool calls into a group and closes it on text", () => {
		const messages = [...toolWithResult()];
		const rows = buildChatRows(attachToolResults(messages), {
			working: false,
			streaming: false,
		});
		expect(rows).toHaveLength(2);
		expect(rows[0].kind).toBe("group");
		if (rows[0].kind !== "group") return;
		expect(rows[0].entries.map((e) => e.kind)).toEqual(["thinking", "tool"]);
		expect(rows[0].entries[1].result?.args).toBe("file body");
		expect(rows[1].kind).toBe("msg");
	});

	it("emits a turn row before the next user message only for turns with changes", () => {
		const t0 = "2026-01-01T00:00:00Z";
		const t1 = "2026-01-01T00:01:00Z";
		const messages = [
			msg("user", [{ kind: "text", text: "t1" }], { timestamp: t0 }),
			msg(
				"assistant",
				[
					{
						kind: "tool",
						name: "edit",
						args: JSON.stringify({ path: "a.ts", oldText: "x", newText: "y" }),
					},
				],
				{ timestamp: t1 },
			),
			msg("user", [{ kind: "text", text: "t2" }], { timestamp: t0 }),
			msg("assistant", [{ kind: "text", text: "text only" }], { timestamp: t1 }),
		];
		const rows = buildChatRows(attachToolResults(messages), {
			working: false,
			streaming: false,
		});
		const turnRows = rows.filter((r) => r.kind === "turn");
		// turn 0 (has changes) gets its footer right before the t2 user row;
		// the final turn (text only) still gets a footer — 运行时长恒展示
		//（force），只是 changes 为 null。
		expect(turnRows).toHaveLength(2);
		const turnIdx = rows.findIndex((r) => r.kind === "turn");
		expect(rows[turnIdx + 1].kind).toBe("msg");
		expect((rows[turnIdx + 1] as { item: MessageItem }).item.msg.role).toBe("user");
		if (turnRows[0].kind !== "turn") return;
		expect(turnRows[0].changes?.files[0].path).toBe("a.ts");
		expect(turnRows[0].live).toBe(false);
		const finalTurn = turnRows[1];
		if (finalTurn.kind !== "turn") return;
		expect(finalTurn.changes).toBeNull();
		expect(finalTurn.live).toBe(false);
		expect(finalTurn.startedAt).not.toBeNull();
		expect(finalTurn.endedAt).not.toBeNull();
	});

	it("marks the last group live only while working without streaming text", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "go" }]),
			msg(
				"assistant",
				[
					{ kind: "thinking", text: "deep thought" },
					{ kind: "tool", name: "bash", args: '{"command":"ls"}' },
				],
				{ streaming: true },
			),
		];
		const rows = buildChatRows(attachToolResults(messages), {
			working: true,
			streaming: false,
		});
		const group = rows.find((r) => r.kind === "group");
		expect(
			group &&
				group.kind === "group" &&
				group.entries.every((e) => e.running || e.kind === "thinking"),
		).toBe(true);

		const rowsStreaming = buildChatRows(attachToolResults(messages), {
			working: true,
			streaming: true,
		});
		// MessageList applies the live flag; the builder only marks the turn row.
		const turn = rowsStreaming.find((r) => r.kind === "turn");
		expect(turn && turn.kind === "turn" && turn.live).toBe(true);
	});

	it("splits [thinking, text, tool] into ordered rows (group, text, group)", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "go" }]),
			msg(
				"assistant",
				[
					{ kind: "thinking", text: "plan" },
					{ kind: "text", text: "let me check" },
					{ kind: "tool", name: "bash", args: '{"command":"ls"}' },
				],
				{ streaming: true },
			),
		];
		const rows = buildChatRows(attachToolResults(messages), {
			working: true,
			streaming: true,
		}).filter((r) => r.kind !== "turn");
		expect(rows.map((r) => r.kind)).toEqual(["msg", "group", "msg", "group"]);
		// rows[1] is the message's text segment (last=false — the trailing
		// tool group renders after it).
		const textRow = rows[1];
		expect(textRow.kind === "msg" && textRow.last).toBe(false);
		const toolGroup = rows[3];
		expect(toolGroup.kind === "group" && toolGroup.entries[0].running).toBe(true);
	});

	it("keeps [text, tool] in stream order: text row before the tool group", () => {
		const messages = [
			msg("user", [{ kind: "text", text: "go" }]),
			msg(
				"assistant",
				[
					{ kind: "text", text: "checking now" },
					{ kind: "tool", name: "read", args: '{"path":"a.ts"}' },
				],
				{ streaming: true },
			),
		];
		const rows = buildChatRows(attachToolResults(messages), {
			working: true,
			streaming: true,
		}).filter((r) => r.kind !== "turn");
		expect(rows.map((r) => r.kind)).toEqual(["msg", "msg", "group"]);
		// The text row is the message's LAST text row → it carries the cursor,
		// even though the live tool group renders after it.
		const textRow = rows[1];
		expect(textRow.kind === "msg" && textRow.last).toBe(true);
	});

	it("merges meta segments across consecutive assistant messages until text closes them", () => {
		// Real pi streams look like: [thinking, tool] → tool result → [thinking,
		// tool] → … → [thinking, text]. Percho folds the whole burst into ONE
		// group ("执行 13 条命令"), the narration text closes it. One group per
		// message was the bug behind the wall of tiny 2-dot rows.
		const messages = [
			msg("user", [{ kind: "text", text: "go" }]),
			msg("assistant", [
				{ kind: "thinking", text: "t1" },
				{ kind: "tool", name: "bash", args: '{"command":"ls"}' },
			]),
			msg("tool", [{ kind: "tool", name: "bash", args: "out1", result: true }]),
			msg("assistant", [
				{ kind: "thinking", text: "t2" },
				{ kind: "tool", name: "read", args: '{"path":"a"}' },
			]),
			msg("tool", [{ kind: "tool", name: "read", args: "out2", result: true }]),
			msg("assistant", [
				{ kind: "thinking", text: "t3" },
				{ kind: "text", text: "done" },
			]),
		];
		const rows = buildChatRows(attachToolResults(messages), {
			working: false,
			streaming: false,
		});
		const groups = rows.filter((r) => r.kind === "group");
		expect(groups).toHaveLength(1);
		if (groups[0].kind !== "group") return;
		expect(groups[0].entries).toHaveLength(5); // t1, bash, t2, read, t3
		expect(groups[0].entries.map((e) => e.kind)).toEqual([
			"thinking",
			"tool",
			"thinking",
			"tool",
			"thinking",
		]);
		const textRows = rows.filter((r) => r.kind === "msg" && r.item.msg.role === "assistant");
		expect(textRows).toHaveLength(1);
	});

	it("bypass search-target messages: no folding, all blocks inline", () => {
		const messages = [...toolWithResult()];
		const ids = searchBypassIds(messages, "found");
		expect(ids.size).toBeGreaterThan(0);
		const rows = buildChatRows(attachToolResults(messages), {
			working: false,
			streaming: false,
			bypassIds: ids,
		});
		expect(rows.every((r) => r.kind !== "group")).toBe(true);
		const assistantRow = rows.find((r) => r.kind === "msg" && r.item.msg.role === "assistant");
		expect(assistantRow && assistantRow.kind === "msg" && assistantRow.skip.size).toBe(0);
	});
});
