import { describe, expect, it } from "vitest";
import { getMessages, messages } from "../i18n";

describe("i18n catalog", () => {
	it("zh and en expose the same key shape", () => {
		const zh = getMessages("zh");
		const en = getMessages("en");
		const keys = (o: object, prefix = ""): string[] =>
			Object.entries(o).flatMap(([k, v]) =>
				typeof v === "object" && v !== null
					? keys(v as object, `${prefix}${k}.`)
					: [`${prefix}${k}`],
			);
		const zhKeys = keys(zh).sort();
		const enKeys = keys(en).sort();
		expect(zhKeys).toEqual(enKeys);
		expect(zhKeys.length).toBeGreaterThan(50);
	});

	it("translations differ between languages", () => {
		expect(messages.zh.app.search).not.toBe(messages.en.app.search);
		expect(messages.zh.chat.send).not.toBe(messages.en.chat.send);
	});

	it("interpolation placeholders match across languages", () => {
		const zh = getMessages("zh");
		const en = getMessages("en");
		const entries = (o: object, prefix = ""): [string, string][] =>
			Object.entries(o).flatMap(([k, v]) =>
				typeof v === "object" && v !== null
					? entries(v as object, `${prefix}${k}.`)
					: [[`${prefix}${k}`, String(v)]],
			);
		// Deliberate asymmetry: English pluralizes through a {unit} placeholder
		// while Chinese bakes the counter word into the template ("读取 {n} 个
		// 文件"). fmt is given both values, so the side whose template lacks the
		// token simply has nothing to replace. Registered here so the check
		// stays strict everywhere else — a placeholder that is NOT registered
		// and appears on one side only is a translation bug: the other language
		// renders it as a literal {…} in the UI.
		const optional: Record<string, string[]> = {
			"chat.summaryRead": ["{unit}"],
			"chat.summaryEdit": ["{unit}"],
			"chat.summaryExplore": ["{unit}"],
			"chat.summarySearch": ["{unit}"],
			"chat.summaryBash": ["{unit}"],
			"chat.summarySubagents": ["{unit}"],
			"diff.filesChanged": ["{unit}"],
		};
		const enByKey = new Map(entries(en));
		const placeholders = (key: string, s: string) => {
			const exempt = new Set(optional[key] ?? []);
			return (s.match(/\{\w+\}/g) ?? []).filter((p) => !exempt.has(p)).sort();
		};
		for (const [key, text] of entries(zh)) {
			expect(enByKey.get(key), `en is missing ${key}`).toBeDefined();
			expect(placeholders(key, text), `placeholder mismatch at ${key}`).toEqual(
				placeholders(key, enByKey.get(key)!),
			);
		}
	});
});
