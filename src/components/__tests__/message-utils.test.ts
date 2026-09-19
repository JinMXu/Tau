import { describe, expect, it } from "vitest";
import {
	chatMessageToMarkdown,
	chatMessageToPlainText,
	computeLineDiff,
	diffBlocksFromArgs,
	parsedMessagesToMarkdown,
	retryTextFor,
	searchMessages,
	splitOnQuery,
	toolSummary,
} from "../message-utils";
import type { UiError } from "../../errors";
import type { ChatMessage } from "../../chat-types";

describe("toolSummary", () => {
	it("returns the first present summary key", () => {
		expect(toolSummary(JSON.stringify({ path: "src/a.ts", command: "ls" }))).toBe("src/a.ts");
		expect(toolSummary(JSON.stringify({ command: "git status" }))).toBe("git status");
		expect(toolSummary(JSON.stringify({ pattern: "TODO" }))).toBe("TODO");
	});

	it("handles missing keys, empty values, and invalid JSON", () => {
		expect(toolSummary(JSON.stringify({}))).toBeNull();
		expect(toolSummary(JSON.stringify({ path: "  " }))).toBeNull();
		expect(toolSummary("not json")).toBeNull();
	});
});

describe("computeLineDiff", () => {
	it("computes an LCS line diff", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nx\nc");
		expect(diff).toEqual([
			{ type: "ctx", text: "a" },
			{ type: "del", text: "b" },
			{ type: "add", text: "x" },
			{ type: "ctx", text: "c" },
		]);
	});

	it("handles identical and empty inputs", () => {
		expect(computeLineDiff("same", "same")).toEqual([{ type: "ctx", text: "same" }]);
		// An empty string is a single empty line in line-diff terms.
		expect(computeLineDiff("", "new")).toEqual([
			{ type: "del", text: "" },
			{ type: "add", text: "new" },
		]);
		expect(computeLineDiff("old", "")).toEqual([
			{ type: "del", text: "old" },
			{ type: "add", text: "" },
		]);
	});

	it("degrades to whole-block display for huge inputs", () => {
		const oldText = Array.from({ length: 1100 }, (_, i) => `l${i}`).join("\n");
		const newText = Array.from({ length: 1100 }, (_, i) => `r${i}`).join("\n");
		const diff = computeLineDiff(oldText, newText);
		expect(diff[0]).toEqual({ type: "del", text: "l0" });
		expect(diff[diff.length - 1]).toEqual({ type: "add", text: "r1099" });
		expect(diff.length).toBe(2200);
	});
});

describe("diffBlocksFromArgs", () => {
	it("extracts edit hunks", () => {
		const blocks = diffBlocksFromArgs(
			JSON.stringify({
				path: "a.ts",
				edits: [{ oldText: "x", newText: "y" }],
			}),
		);
		expect(blocks).toHaveLength(1);
		expect(blocks![0].lines).toEqual([
			{ type: "del", text: "x" },
			{ type: "add", text: "y" },
		]);
	});

	it("handles old_string/new_string and content-style writes", () => {
		const blocks = diffBlocksFromArgs(
			JSON.stringify({ file_path: "a.ts", old_string: "p", new_string: "q" }),
		);
		expect(blocks).toHaveLength(1);

		const write = diffBlocksFromArgs(JSON.stringify({ path: "a.ts", content: "line1\nline2" }));
		expect(write![0].lines.map((l) => l.text)).toEqual(["line1", "line2"]);
	});

	it("returns null for non-file tools and invalid JSON", () => {
		expect(diffBlocksFromArgs(JSON.stringify({ command: "ls" }))).toBeNull();
		expect(diffBlocksFromArgs("{oops")).toBeNull();
	});
});

describe("searchMessages", () => {
	const messages: ChatMessage[] = [
		{
			id: 1,
			role: "user",
			blocks: [{ kind: "text", text: "Fix the Flaky test" }],
			streaming: false,
		},
		{
			id: 2,
			role: "assistant",
			blocks: [
				{ kind: "thinking", text: "flaky means unstable" },
				{ kind: "tool", name: "edit", args: JSON.stringify({ path: "flaky.test.ts" }) },
			],
			streaming: false,
		},
	];

	it("finds case-insensitive hits across block kinds", () => {
		const hits = searchMessages(messages, "flaky");
		expect(hits).toHaveLength(3);
		expect(hits[0].messageIndex).toBe(0);
		expect(hits[1].messageIndex).toBe(1);
		expect(hits[2].blockIndex).toBe(1);
	});

	it("returns nothing for empty or absent queries", () => {
		expect(searchMessages(messages, "  ")).toEqual([]);
		expect(searchMessages(messages, "zzz")).toEqual([]);
	});
});

describe("splitOnQuery", () => {
	it("splits text on a case-insensitive query", () => {
		expect(splitOnQuery("a Foo b foo", "foo")).toEqual([
			{ text: "a ", match: false },
			{ text: "Foo", match: true },
			{ text: " b ", match: false },
			{ text: "foo", match: true },
		]);
	});

	it("returns the whole text for an empty query", () => {
		expect(splitOnQuery("abc", "")).toEqual([{ text: "abc", match: false }]);
	});
});

describe("chatMessageToMarkdown", () => {
	const msg: ChatMessage = {
		id: 1,
		role: "assistant",
		blocks: [
			{ kind: "thinking", text: "internal note" },
			{ kind: "text", text: "Done." },
			{ kind: "tool", name: "bash", args: '{"command":"ls"}' },
		],
		streaming: false,
	};

	it("renders text, thinking and tool blocks as details", () => {
		const md = chatMessageToMarkdown(msg);
		expect(md).toContain("**Pi**:");
		expect(md).toContain("<details><summary>thinking</summary>");
		expect(md).toContain("Done.");
		expect(md).toContain("<summary>tool: bash</summary>");
		expect(md).toContain('{"command":"ls"}');
	});

	it("labels user and tool roles", () => {
		expect(
			chatMessageToMarkdown({
				...msg,
				role: "user",
				blocks: [{ kind: "text", text: "hi" }],
			}),
		).toBe("**User**:\nhi");
		expect(
			chatMessageToMarkdown({
				...msg,
				role: "tool",
				blocks: [{ kind: "text", text: "out" }],
			}),
		).toBe("**Tool**:\nout");
	});

	it("returns empty for messages without renderable blocks", () => {
		expect(chatMessageToMarkdown({ ...msg, blocks: [] })).toBe("");
	});
});

describe("chatMessageToPlainText", () => {
	it("joins only text blocks", () => {
		expect(
			chatMessageToPlainText({
				id: 1,
				role: "assistant",
				blocks: [
					{ kind: "text", text: "a" },
					{ kind: "tool", name: "bash", args: "{}" },
					{ kind: "text", text: "b" },
				],
				streaming: false,
			}),
		).toBe("a\n\nb");
	});
});

describe("parsedMessagesToMarkdown", () => {
	it("separates messages with a horizontal rule", () => {
		const md = parsedMessagesToMarkdown([
			{ role: "user", timestamp: null, blocks: [{ kind: "text", text: "hi" }] },
			{ role: "assistant", timestamp: null, blocks: [{ kind: "text", text: "yo" }] },
		]);
		expect(md).toBe("**User**:\nhi\n\n---\n\n**Pi**:\nyo");
	});
});

describe("retryTextFor", () => {
	const err: UiError = {
		severity: "error",
		source: "llm",
		titleKey: "x",
		actions: [],
		timestamp: 0,
	};
	const turn: ChatMessage[] = [
		{ id: 1, role: "user", blocks: [{ kind: "text", text: "  run the tests " }], streaming: false },
		{
			id: 2,
			role: "assistant",
			blocks: [{ kind: "text", text: "half-written ans…" }],
			streaming: false,
			error: { ...err },
		},
	];

	it("walks back to the user message for a failed assistant card", () => {
		expect(retryTextFor(turn, turn[1])).toBe("run the tests");
	});

	it("uses the message itself for a failed user send", () => {
		const failedUser: ChatMessage = { ...turn[0], error: { ...err } };
		expect(retryTextFor([failedUser, turn[1]], failedUser)).toBe("run the tests");
	});

	it("returns null when no user message precedes the failure", () => {
		expect(retryTextFor([turn[1]], turn[1])).toBeNull();
		expect(retryTextFor([], turn[1])).toBeNull();
	});

	it("returns null when the user message has no text blocks", () => {
		const imageOnly: ChatMessage = {
			id: 3,
			role: "user",
			blocks: [],
			streaming: false,
			images: [{ mimeType: "image/png", data: "x" }],
		};
		expect(retryTextFor([imageOnly, turn[1]], turn[1])).toBeNull();
	});
});
