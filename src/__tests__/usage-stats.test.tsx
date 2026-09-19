// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getMessages } from "../i18n";
import type { PiUsageEntry } from "../pi";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();
const DAY = 86_400_000;

/** Local date key `offset` days before now. The component's trend chart only
 *  covers the rolling last-30-days window, so the fixture must anchor its
 *  dates to the real clock — hardcoded dates fell out of the window as the
 *  calendar advanced and silently zeroed the trend series. Noon-anchored so
 *  day subtraction can't drift across a DST boundary. */
function dateKey(offsetDays: number): string {
	const d = new Date();
	d.setHours(12, 0, 0, 0);
	d.setDate(d.getDate() - offsetDays);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function entry(over: Partial<PiUsageEntry>): PiUsageEntry {
	return {
		date: dateKey(0),
		provider: "volcengine",
		model: "deepseek-v4-pro",
		project: "D:\\agents\\demo",
		sessionPath: "D:\\sessions\\a.jsonl",
		input: 10,
		output: 5,
		cacheRead: 0,
		reasoning: 0,
		total: 1000,
		cost: 0,
		ts: NOW,
		...over,
	};
}

const FAKE: PiUsageEntry[] = [
	// today, two models, one long session
	entry({ ts: NOW - 2 * 3_600_000, total: 5000, model: "glm-5.2" }),
	entry({ ts: NOW, total: 3000 }),
	// yesterday + day before: builds a 3-day streak
	entry({ date: dateKey(1), ts: NOW - DAY, total: 8000, sessionPath: "D:\\sessions\\b.jsonl" }),
	entry({
		date: dateKey(2),
		ts: NOW - 2 * DAY,
		total: 2000,
		sessionPath: "D:\\sessions\\c.jsonl",
	}),
];

vi.mock("../pi", () => ({
	usageStats: async () => FAKE,
}));

// Import after the mock is registered.
const { UsageStats } = await import("../components/UsageStats");

describe("UsageStats page", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container?.remove();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	async function render(lang: "zh" | "en") {
		await act(async () => {
			root.render(<UsageStats t={getMessages(lang)} lang={lang} />);
		});
		// flush the usageStats() promise + state update
		await act(async () => {});
	}

	it("renders cards, heatmap, trend and donut without cost", async () => {
		await render("zh");
		const text = container.textContent ?? "";
		expect(text).toContain("累计 Token 数");
		expect(text).toContain("峰值 Token 数");
		expect(text).toContain("最长聊天时长");
		expect(text).toContain("连续天数");
		expect(text).not.toContain("费用");
		expect(text).not.toContain("$");
		// 万-formatting: 18000 total → 1.8万
		expect(text).toContain("1.8万");
		// longest chat: 2 hours session → "2 小时 00 分钟"
		expect(text).toContain("2 小时");
		// 3-day streaks
		expect(text).toContain("3 天");
		// heatmap cells rendered (52+ weeks × 7)
		expect(container.querySelectorAll(".usage-heatmap-cell").length).toBeGreaterThan(300);
		// trend series polylines: 2 models
		expect(container.querySelectorAll(".usage-trend polyline").length).toBe(2);
		// donut legend rows: 2 models
		expect(container.querySelectorAll(".usage-donut-row").length).toBe(2);
		// legend lists both models
		expect(text).toContain("glm-5.2");
		expect(text).toContain("deepseek-v4-pro");
	});

	it("renders in English with M-formatting", async () => {
		await render("en");
		const text = container.textContent ?? "";
		expect(text).toContain("Total tokens");
		expect(text).toContain("18k");
		expect(text).not.toContain("Cost");
	});

	it("shows a tooltip when hovering a donut segment", async () => {
		await render("zh");
		expect(container.querySelector(".usage-donut-tooltip")).toBeNull();
		const circle = container.querySelector(".usage-donut svg circle");
		expect(circle).not.toBeNull();
		await act(async () => {
			circle!.dispatchEvent(
				new MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }),
			);
		});
		const tooltip = container.querySelector(".usage-donut-tooltip");
		expect(tooltip).not.toBeNull();
		expect(tooltip!.textContent).toContain("deepseek-v4-pro");
		expect(tooltip!.textContent).toContain("72%");
		await act(async () => {
			circle!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
		});
		expect(container.querySelector(".usage-donut-tooltip")).toBeNull();
	});
});
