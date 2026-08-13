import { describe, expect, it } from "vitest";
import {
	bundledLanguages,
	bundledLanguagesInfo,
	createHighlighter,
} from "../lib/shiki-shim";

describe("shiki shim (lazy bundle facade)", () => {
	it("keeps the metadata the streamdown code plugin relies on", () => {
		expect(bundledLanguagesInfo.length).toBeGreaterThan(200);
		// The plugin builds an alias map from bundledLanguagesInfo.aliases.
		expect(
			bundledLanguagesInfo.some((l) => Array.isArray(l.aliases)),
		).toBe(true);
		// Keys must cover common ids and aliases the plugin checks.
		expect(bundledLanguages).toHaveProperty("typescript");
		expect(bundledLanguages).toHaveProperty("ts");
	});

	it("highlights code with lazily loaded grammars", async () => {
		const highlighter = await createHighlighter({
			themes: ["github-light", "github-dark"],
			langs: ["typescript", "rust"],
		});
		const result = highlighter.codeToTokens("const x: number = 1;", {
			lang: "typescript",
			themes: { light: "github-light", dark: "github-dark" },
		});
		const tokens = result.tokens;
		expect(tokens.length).toBeGreaterThan(0);
		// Tokens carry real styling data (colors), not empty shims.
		const styles = tokens.flat().filter((t) => t.htmlStyle);
		expect(styles.length).toBeGreaterThan(0);
	});

	it("falls back like the original plugin: unknown langs highlight as text", async () => {
		// The streamdown code plugin checks the bundled keys first and swaps
		// unknown languages to "text" before calling codeToTokens.
		expect(bundledLanguages).not.toHaveProperty("not-a-language");
		const highlighter = await createHighlighter({
			themes: ["github-light", "github-dark"],
			langs: ["text"],
		});
		const result = highlighter.codeToTokens("plain", {
			lang: "text",
			themes: { light: "github-light", dark: "github-dark" },
		});
		expect(result.tokens.length).toBeGreaterThan(0);
	});
});
