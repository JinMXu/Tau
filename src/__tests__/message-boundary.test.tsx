// @vitest-environment happy-dom
import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MessageBoundary } from "../components/MessageBoundary";
import { getMessages } from "../i18n";

const t = getMessages("en");

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** A child that throws on demand, so the boundary can be exercised. */
function Bomb({ explode }: { explode: boolean }) {
	if (explode) throw new Error("boom");
	return <div className="ok">fine</div>;
}

async function render(ui: React.ReactNode) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	await act(async () => {
		root.render(ui);
	});
	return {
		el,
		rerender: async (next: React.ReactNode) => {
			await act(async () => {
				root.render(next);
			});
		},
	};
}

describe("MessageBoundary", () => {
	it("renders children directly (no wrapper node) when nothing throws", async () => {
		const { el } = await render(
			<MessageBoundary t={t}>
				<div className="child">hi</div>
			</MessageBoundary>,
		);
		expect(el.querySelector(".child")?.textContent).toBe("hi");
		expect(el.querySelector(".markdown-error")).toBeNull();
	});

	it("falls back to plain text instead of unmounting the tree", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { el } = await render(
			<MessageBoundary text="the raw content" t={t}>
				<Bomb explode />
			</MessageBoundary>,
		);
		const fallback = el.querySelector(".markdown-error");
		expect(fallback).not.toBeNull();
		expect(fallback?.getAttribute("role")).toBe("alert");
		expect(el.querySelector("pre.markdown-plain")?.textContent).toBe("the raw content");
		expect(el.querySelector(".ok")).toBeNull();
		spy.mockRestore();
	});

	it("offers a Retry that re-attempts the rich render", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const view = await render(
			<MessageBoundary text="raw" t={t}>
				<Bomb explode />
			</MessageBoundary>,
		);
		await act(async () => {
			view.el.querySelector<HTMLButtonElement>(".markdown-error-retry")?.click();
		});
		// Still throwing, so it degrades again rather than leaving a blank row.
		expect(view.el.querySelector(".markdown-error")).not.toBeNull();
		spy.mockRestore();
	});

	it("clears the error when the content changes (a streamed delta)", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const view = await render(
			<MessageBoundary text="v1" t={t}>
				<Bomb explode />
			</MessageBoundary>,
		);
		expect(view.el.querySelector(".markdown-error")).not.toBeNull();
		await view.rerender(
			<MessageBoundary text="v2" t={t}>
				<div className="ok">recovered</div>
			</MessageBoundary>,
		);
		expect(view.el.querySelector(".markdown-error")).toBeNull();
		expect(view.el.querySelector(".ok")?.textContent).toBe("recovered");
		spy.mockRestore();
	});

	it("does not evaluate the text thunk on the happy path", async () => {
		let calls = 0;
		await render(
			<MessageBoundary
				t={t}
				text={() => {
					calls++;
					return "raw";
				}}
			>
				<div className="child">hi</div>
			</MessageBoundary>,
		);
		expect(calls).toBe(0);
	});
});
