// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PreviewTicker } from "../components/PreviewTicker";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("PreviewTicker", () => {
	it("shows the latest item after mount", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		await act(async () => {
			root.render(
				<PreviewTicker
					items={[{ kind: "tool", id: "a", name: "Edit", text: "src/x.ts" }]}
					reserveSpace
				/>,
			);
		});
		expect(el.textContent).toContain("Edit");
		await act(async () => {
			root.unmount();
		});
	});
});
