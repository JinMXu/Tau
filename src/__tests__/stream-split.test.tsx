// @vitest-environment happy-dom
// Guards the stream/committed split (see App.tsx): the in-flight message must\n// render, keep its DOM node when it is committed, and leave the committed rows\n// untouched while tokens stream.
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../components/MessageList";
import type { ChatMessage } from "../chat-types";
import { getMessages } from "../i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
if (!(globalThis as Record<string, unknown>).ResizeObserver) {
	(globalThis as Record<string, unknown>).ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

const t = getMessages("en");

let render: (
	messages: ChatMessage[],
	stream: ChatMessage | null,
	streaming?: boolean,
) => Promise<void>;
let container: HTMLElement;

async function mount() {
	container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const Host = ({
		messages,
		stream,
		streaming,
	}: {
		messages: ChatMessage[];
		stream: ChatMessage | null;
		streaming: boolean;
	}) => (
		<div className="chat-scroll">
			<MessageList
				messages={messages}
				stream={stream}
				streaming={streaming}
				working={streaming}
				textStreaming={streaming}
				t={t}
			/>
		</div>
	);
	render = async (messages, stream, streaming = stream !== null) => {
		await act(async () => {
			root.render(<Host messages={messages} stream={stream} streaming={streaming} />);
		});
	};
}

const user: ChatMessage = {
	id: 1,
	role: "user",
	blocks: [{ kind: "text", text: "hello" }],
	streaming: false,
};

const rows = () => container.querySelectorAll(".message");

describe("stream / committed split", () => {
	it("renders the in-flight message and commits it without remounting the row", async () => {
		await mount();
		await render([user], null);
		const committedUserRow = rows()[0];
		expect(rows().length).toBe(1);

		// message_start(assistant): in-flight, no blocks yet → no row of its own
		const streamMsg: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [],
			streaming: true,
			timestamp: new Date().toISOString(),
		};
		await render([user], streamMsg);
		expect(rows().length).toBe(1);
		expect(rows()[0]).toBe(committedUserRow);

		// deltas: only the stream object changes; the text row appears
		const streamed: ChatMessage = { ...streamMsg, blocks: [{ kind: "text", text: "hi there" }] };
		await render([user], streamed);
		expect(rows().length).toBe(2);
		const assistantRow = rows()[1];
		expect(assistantRow.querySelector(".markdown-host")).toBeTruthy();
		expect(rows()[0]).toBe(committedUserRow);

		// message_end: the SAME id moves into the transcript → same key → same DOM node
		await render([user, { ...streamed, streaming: false }], null);
		expect(rows().length).toBe(2);
		expect(rows()[1]).toBe(assistantRow);
		expect(rows()[0]).toBe(committedUserRow);
	});

	it("leaves the committed rows' DOM alone while the stream changes", async () => {
		await mount();
		// streaming=false isolates the row from the recall-button flip that the
		// live run intentionally causes on the trailing user row.
		await render([user], null, false);
		const committedRowEl = rows()[0];
		const committedHtml = committedRowEl.outerHTML;
		const records: string[] = [];
		const observer = new MutationObserver((list) => {
			for (const r of list) {
				const el = r.target as Element;
				records.push(
					`${r.type}${r.attributeName ? `:${r.attributeName}` : ""} on ${el.nodeName}.${el.className || ""}`,
				);
			}
		});
		observer.observe(committedRowEl, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
		});
		const streamMsg: ChatMessage = { id: 2, role: "assistant", blocks: [], streaming: true };
		for (const text of ["a", "ab", "abc", "abcd"]) {
			await render([user], { ...streamMsg, blocks: [{ kind: "text", text }] }, false);
		}
		observer.disconnect();
		expect(records).toEqual([]);
		expect(committedRowEl.outerHTML).toBe(committedHtml);
	});

	it("folds a committed tool result back into the assistant group", async () => {
		await mount();
		const assistant: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [{ kind: "tool", name: "read", args: '{"path":"a.ts"}' }],
			streaming: false,
		};
		await render([user, assistant], null, false);
		// tool-only assistant messages fold into an ActivityCard (no .message row)
		expect(container.querySelectorAll(".act-card, .act-bare").length).toBeGreaterThan(0);
		// the toolResult streams first (empty blocks → invisible), then commits
		await render([user, assistant], { id: 3, role: "tool", blocks: [], streaming: true }, true);
		// the empty in-flight tool message contributes no row of its own
		expect(rows().length).toBe(1);
		// the committed tool result folds back into the assistant's tool call
		await render(
			[
				user,
				assistant,
				{
					id: 3,
					role: "tool",
					blocks: [{ kind: "tool", name: "read", args: "FILE BODY", result: true }],
					streaming: false,
				},
			],
			null,
			false,
		);
		expect(rows().length).toBe(1);
		expect(container.textContent).toContain("a.ts");
	});
});
