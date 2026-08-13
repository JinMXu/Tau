import { describe, expect, it } from "vitest";
import { getMessages, messages, projectNameFromPath } from "../i18n";

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
});

describe("projectNameFromPath", () => {
	it("extracts the last path segment", () => {
		expect(projectNameFromPath("D:\\projects\\demo")).toBe("demo");
		expect(projectNameFromPath("/home/u/work")).toBe("work");
		expect(projectNameFromPath("C:\\")).toBe("C:");
	});

	it("handles empty values", () => {
		expect(projectNameFromPath(null)).toBe("");
		expect(projectNameFromPath(undefined)).toBe("");
		expect(projectNameFromPath("")).toBe("");
	});
});
