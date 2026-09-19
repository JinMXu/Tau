// @vitest-environment happy-dom
// Regression guard for the MetaGroup memo comparator: a live group's tool
// entries must re-render while the call's args stream in (toolcall_delta) and
// when the result attaches — the comparator compares tool blocks by reference
// (deltas create fresh block objects), otherwise the group freezes on its
// first args snapshot and the preview / summary never update.
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
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

const user: ChatMessage = {
	id: 1,
	role: "user",
	blocks: [{ kind: "text", text: "run something" }],
	streaming: false,
};

async function render(stream: ChatMessage, messages: ChatMessage[] = [user]) {
	await act(async () => {
		root.render(
			<div className="chat-scroll">
				<MessageList messages={messages} stream={stream} streaming working t={t} />
			</div>,
		);
	});
}

describe("live meta group streaming", () => {
	it("updates the running tool summary as args stream in", async () => {
		const base: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [{ kind: "tool", name: "bash", args: "" }],
			streaming: true,
		};
		await render(base);
		expect(container.textContent).not.toContain("git status");

		// toolcall_delta batches land as fresh block objects
		await render({ ...base, blocks: [{ kind: "tool", name: "bash", args: '{"comm' }] });
		await render({
			...base,
			blocks: [{ kind: "tool", name: "bash", args: '{"command":"git status --short"}' }],
		});
		expect(container.textContent).toContain("git status");
	});

	it("reflects the attached result streaming flag and content", async () => {
		const assistant: ChatMessage = {
			id: 2,
			role: "assistant",
			blocks: [{ kind: "tool", name: "bash", args: '{"command":"ls"}' }],
			streaming: true,
		};
		await render(assistant);
		// the result message streams in and attaches to the call
		await render({ id: 3, role: "tool", blocks: [], streaming: true }, [user, assistant]);
		await render(
			{
				id: 3,
				role: "tool",
				blocks: [{ kind: "tool", name: "bash", args: "file one\n", result: true }],
				streaming: true,
			},
			[user, assistant],
		);
		// the group's expanded body shows the output text
		expect(container.textContent).toContain("file one");
	});
});
