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
	extra?: { searchQuery?: string; searchActiveMessageId?: number | null },
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
		searchQuery,
		searchActiveMessageId,
	}: {
		messages: ChatMessage[];
		stream: ChatMessage | null;
		streaming: boolean;
		searchQuery?: string;
		searchActiveMessageId?: number | null;
	}) => (
		<div className="chat-scroll">
			<MessageList
				messages={messages}
				stream={stream}
				streaming={streaming}
				working={streaming}
				textStreaming={streaming}
				searchQuery={searchQuery}
				searchActiveMessageId={searchActiveMessageId}
				t={t}
			/>
		</div>
	);
	render = async (messages, stream, streaming = stream !== null, extra) => {
		await act(async () => {
			root.render(
				<Host
					messages={messages}
					stream={stream}
					streaming={streaming}
					searchQuery={extra?.searchQuery}
					searchActiveMessageId={extra?.searchActiveMessageId}
				/>,
			);
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
		// tool-only assistant messages fold into a MetaGroup (no .message row)
		expect(container.querySelectorAll(".meta-group, .meta-bare").length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Row windowing (virtualization) — only engages above VIRTUALIZE_THRESHOLD.
// ---------------------------------------------------------------------------

/** A transcript long enough to cross the 150-row threshold. */
function longTranscript(turns: number): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < turns; i++) {
		out.push({
			id: i * 2 + 1,
			role: "user",
			blocks: [{ kind: "text", text: `question ${i}` }],
			streaming: false,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
		});
		out.push({
			id: i * 2 + 2,
			role: "assistant",
			blocks: [{ kind: "text", text: `answer ${i}` }],
			streaming: false,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i) + 500).toISOString(),
		});
	}
	return out;
}

const spacerHeights = () =>
	Array.from(container.querySelectorAll<HTMLElement>("[data-spacer]")).map((el) =>
		Number.parseFloat(el.style.height),
	);

describe("row windowing", () => {
	it("does not window below the threshold: no spacers, every row mounted", async () => {
		await mount();
		const messages = longTranscript(20); // 40 rows
		await render(messages, null, false);
		expect(spacerHeights()).toEqual([]);
		expect(rows().length).toBe(40);
	});

	it("mounts a bounded window with honest spacers above the threshold", async () => {
		await mount();
		const messages = longTranscript(120); // 240 rows
		await render(messages, null, false);
		expect(messages.length).toBeGreaterThan(150);

		// The window is the tail, so the bottom pad is 0 and only the top spacer
		// is emitted — the total padded height must still account for every row
		// that is not mounted, or the scrollbar lies about the transcript length.
		const pads = spacerHeights();
		expect(pads.length).toBeGreaterThanOrEqual(1);
		const totalPad = pads.reduce((a, b) => a + b, 0);
		expect(totalPad).toBeGreaterThan(0);

		const mounted = rows().length;
		expect(mounted).toBeGreaterThan(0);
		expect(mounted).toBeLessThan(messages.length);
		// The initial view is the tail: a session load lands at the bottom.
		expect(container.textContent).toContain("answer 119");
		expect(container.textContent).not.toContain("question 0");
	});

	it("keeps the streaming tail mounted while windowed", async () => {
		await mount();
		const messages = longTranscript(120);
		await render(messages, null, false);
		// The tail window starts on `question 100`'s row.
		expect(container.textContent).toContain("question 100");
		const before = rows();
		const lastBefore = before[before.length - 1];

		await render(
			messages,
			{
				id: 99999,
				role: "assistant",
				blocks: [{ kind: "text", text: "live tail" }],
				streaming: true,
				timestamp: new Date().toISOString(),
			},
			true,
		);
		// The window slid by exactly one row to make room for the in-flight
		// message: `question 100` scrolled out of the mounted slice, so the tail
		// is what got the slot — the stream is never blanked while following.
		expect(container.textContent).not.toContain("question 100");
		expect(container.textContent).toContain("answer 100");
		const after = rows();
		// Still a bounded slice, and its last row is the new tail (a different
		// DOM node than the previous last row).
		expect(after.length).toBeLessThan(messages.length);
		expect(after[after.length - 1]).not.toBe(lastBefore);
		// markstream-react does not emit text synchronously under happy-dom, so
		// assert on the renderer being mounted rather than on its text.
		expect(after[after.length - 1].querySelector(".markdown-host")).toBeTruthy();
	});

	it("force-includes the active search target even when it is far off-screen", async () => {
		await mount();
		const messages = longTranscript(120);
		// The active hit is an early message, far above the initial tail window.
		await render(messages, null, false, {
			searchQuery: "question 3",
			searchActiveMessageId: messages[6].id,
		});
		expect(container.textContent).toContain("question 3");
		// Still bounded — the force-include widens the window, it does not
		// disable windowing.
		expect(rows().length).toBeLessThan(messages.length);
	});
});
