// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../components/MessageList";
import type { ChatMessage } from "../chat-types";
import { getMessages } from "../i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const t = getMessages("en");

const userMsg: ChatMessage = {
	id: 1,
	role: "user",
	blocks: [{ kind: "text", text: "hello" }],
	streaming: false,
};

const assistantMsg: ChatMessage = {
	id: 2,
	role: "assistant",
	blocks: [{ kind: "text", text: "hi there" }],
	streaming: false,
};

const streamingAssistant: ChatMessage = {
	id: 3,
	role: "assistant",
	blocks: [{ kind: "text", text: "stream" }],
	streaming: true,
};

describe("MessageList message actions", () => {
	it("renders Copy + Recall on the last user message", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		await act(async () => {
			root.render(
				<MessageList
					messages={[userMsg, assistantMsg]}
					stream={null}
					streaming={false}
					working={false}
					t={t}
					onCopyMessage={() => {}}
					onRecallMessage={() => {}}
				/>,
			);
		});
		const html = el.innerHTML;
		expect(html).toMatch(/Recall last message/i);
		expect(html).toMatch(/Copy/i);
		await act(async () => {
			root.unmount();
		});
	});

	it("hides actions on the streaming message", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		await act(async () => {
			root.render(
				<MessageList
					messages={[userMsg, streamingAssistant]}
					stream={null}
					streaming={true}
					working={true}
					t={t}
					onCopyMessage={() => {}}
					onRecallMessage={() => {}}
				/>,
			);
		});
		const html = el.innerHTML;
		// Streaming assistant message: no actions, no recall.
		expect(html).not.toMatch(/Recall last message/i);
		await act(async () => {
			root.unmount();
		});
	});

	it("hides recall on non-trailing user messages", async () => {
		const olderUser: ChatMessage = { ...userMsg, id: 1 };
		const newerUser: ChatMessage = { ...userMsg, id: 5 };
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		await act(async () => {
			root.render(
				<MessageList
					messages={[olderUser, assistantMsg, newerUser]}
					stream={null}
					streaming={false}
					working={false}
					t={t}
					onCopyMessage={() => {}}
					onRecallMessage={() => {}}
				/>,
			);
		});
		const recallButtons = el.querySelectorAll('button[aria-label="Recall last message"]');
		expect(recallButtons.length).toBe(1);
		await act(async () => {
			root.unmount();
		});
	});

	it("assistant: actions only on the turn-final message (copy + fork)", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		const mid: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [{ kind: "text", text: "中间叙述" }],
			streaming: false,
		};
		const fin: ChatMessage = {
			id: 3,
			role: "assistant",
			blocks: [{ kind: "text", text: "最终回答" }],
			streaming: false,
			entryId: "entry-1",
		};
		await act(async () => {
			root.render(
				<MessageList
					messages={[userMsg, mid, fin]}
					stream={null}
					streaming={false}
					working={false}
					t={t}
					onRecallMessage={() => {}}
					onForkMessage={() => {}}
				/>,
			);
		});
		// 中间叙述：无任何操作按钮
		expect(el.textContent).not.toContain("中间叙述 ");
		const copyBtns = el.querySelectorAll('button[aria-label="Copy"]');
		const forkBtns = el.querySelectorAll('button[aria-label="Fork"]');
		const recallBtns = el.querySelectorAll('button[aria-label="Recall last message"]');
		expect(copyBtns.length).toBe(2); // 用户消息 + 最终回答
		expect(forkBtns.length).toBe(1); // 仅最终回答
		expect(recallBtns.length).toBe(1); // 仅最后一条用户消息
		await act(async () => {
			root.unmount();
		});
	});

	it("hides all actions mid-run while tools execute (working, not streaming)", async () => {
		const toolMsg: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [
				{ kind: "text", text: "先改数据库表结构" },
				{ kind: "tool", name: "bash", args: "{}" },
			],
			streaming: false,
		};
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		await act(async () => {
			root.render(
				<MessageList
					messages={[userMsg, toolMsg]}
					stream={null}
					streaming={false}
					working={true}
					t={t}
					onCopyMessage={() => {}}
					onRecallMessage={() => {}}
					onForkMessage={() => {}}
				/>,
			);
		});
		expect(el.querySelectorAll(".message-action").length).toBe(0);
		await act(async () => {
			root.unmount();
		});
	});

	it("renders actions only on the split message's last text row", async () => {
		const splitMsg: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [
				{ kind: "text", text: "第一段叙述" },
				{ kind: "tool", name: "bash", args: "{}" },
				{ kind: "text", text: "最终回答" },
			],
			streaming: false,
			entryId: "entry-1",
		};
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		await act(async () => {
			root.render(
				<MessageList
					messages={[userMsg, splitMsg]}
					stream={null}
					streaming={false}
					working={false}
					t={t}
					onForkMessage={() => {}}
				/>,
			);
		});
		// The split message renders two text rows, but only the last one
		// carries Copy + Fork.
		expect(el.querySelectorAll('button[aria-label="Fork"]').length).toBe(1);
		expect(el.querySelectorAll('button[aria-label="Copy"]').length).toBe(2); // 用户 + 最终段
		await act(async () => {
			root.unmount();
		});
	});
});
