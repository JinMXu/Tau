// @vitest-environment happy-dom
// Regression guard for "the whole answer re-renders once the output finishes".
//
// markstream fades every top-level markdown node in with `.fade-node`
// (`opacity: 0` + a 280ms fade-in). Which nodes count as "new" is tracked in a
// Set of node indices that is thrown away whenever the number of parsed
// top-level nodes changes — but ONLY when the renderer gets no `indexKey`:
//
//   const reset = props.indexKey !== undefined
//     ? props.indexKey !== prev.key
//     : nodes.length !== prev.total;
//   if (reset) { fadedNodes.clear(); ... }
//
// A streamed answer changes its node count constantly (a paragraph closes, a
// list item appears, a fence completes…), so the render after each change
// re-applied the fade class to EVERY node of the message: the whole answer
// dipped to transparent and faded back in, right as the output finished.
// Passing a stable `indexKey` keeps that memory intact, so only genuinely new
// nodes fade — and each of them only once.
//
// The class lives for a single render, so it is traced at the DOM-write level
// rather than sampled; happy-dom's MutationObserver misses these writes.
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

const user: ChatMessage = {
	id: 1,
	role: "user",
	blocks: [{ kind: "text", text: "hello" }],
	streaming: false,
};

/** A long answer whose parse tree gains top-level nodes several times. */
const ANSWER = [
	"先说第一段，边写边想。",
	"",
	"## 小标题",
	"",
	"正文解释一下：",
	"",
	"- 第一点",
	"- 第二点",
	"- 第三点",
	"",
	"还有个引用：",
	"",
	"> 引用内容",
	"",
	"最后收个尾。",
].join("\n");

describe("markstream fade memory", () => {
	it(
		"never re-fades a node that already faded in",
		async () => {
			const container = document.createElement("div");
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
			const render = async (
				messages: ChatMessage[],
				stream: ChatMessage | null,
				streaming = stream !== null,
			) => {
				await act(async () => {
					root.render(<Host messages={messages} stream={stream} streaming={streaming} />);
				});
			};
			const settle = async (n = 8) => {
				for (let i = 0; i < n; i++) {
					await act(async () => {
						await new Promise((r) => setTimeout(r, 20));
					});
				}
			};

			// ---- trace every `.fade-node` written into the DOM ----------------
			const firstFades = new WeakSet<Element>();
			const seenNodes = new WeakSet<Element>();
			let applications = 0;
			let refades = 0;
			const note = (el: Element, value: string) => {
				if (!value.includes("fade-node")) return;
				applications++;
				if (seenNodes.has(el)) refades++;
				else firstFades.add(el);
			};
			const origSetAttribute = Element.prototype.setAttribute;
			const origDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "className");
			Element.prototype.setAttribute = function (name: string, value: string) {
				if (name === "class") note(this, String(value));
				return origSetAttribute.call(this, name, value);
			};
			if (origDescriptor?.set) {
				const origSetter = origDescriptor.set;
				Object.defineProperty(Element.prototype, "className", {
					...origDescriptor,
					set(value: string) {
						note(this, String(value));
						origSetter.call(this, value);
					},
				});
			}
			const restore = () => {
				Element.prototype.setAttribute = origSetAttribute;
				if (origDescriptor) Object.defineProperty(Element.prototype, "className", origDescriptor);
			};

			try {
				await render([user], null, false);
				const streamMsg: ChatMessage = {
					id: 2,
					role: "assistant",
					blocks: [{ kind: "text", text: "" }],
					streaming: true,
				};
				for (let cut = 5; cut <= ANSWER.length; cut += 5) {
					await render([user], {
						...streamMsg,
						blocks: [{ kind: "text", text: ANSWER.slice(0, cut) }],
					});
					// let the smooth controller catch up so the parse tree really
					// holds every node of the prefix before the next delta lands
					await settle();
					for (const el of container.querySelectorAll(".node-content")) seenNodes.add(el);
				}
				// message_end: the committed message keeps the same content
				await render(
					[user, { ...streamMsg, blocks: [{ kind: "text", text: ANSWER }], streaming: false }],
					null,
					false,
				);
				await settle(6);
			} finally {
				restore();
			}

			// the mechanism is alive in this environment …
			expect(applications).toBeGreaterThan(0);
			expect(firstFades).toBeTruthy();
			// … and no node is ever faded a second time
			expect(refades).toBe(0);
		},
		60000,
	);
});
