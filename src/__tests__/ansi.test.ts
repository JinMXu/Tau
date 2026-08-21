import { describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/ansi";

describe("stripAnsi", () => {
	it("strips truecolor SGR sequences (the reported MCP status case)", () => {
		const raw = "\u001B[38;2;138;190;183m🖥 MCP: 1 server enabled\u001B[39m";
		expect(stripAnsi(raw)).toBe("🖥 MCP: 1 server enabled");
	});

	it("strips simple color and style codes", () => {
		expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
		expect(stripAnsi("\u001B[1m\u001B[4mbold underline\u001B[22m\u001B[24m")).toBe(
			"bold underline",
		);
		expect(stripAnsi("\u001B[38;5;208m256color\u001B[39m")).toBe("256color");
	});

	it("strips cursor movement and erase sequences", () => {
		expect(stripAnsi("\u001B[2K\u001B[1Gdone")).toBe("done");
		expect(stripAnsi("a\u001B[1Db")).toBe("ab");
	});

	it("strips OSC sequences with BEL and ST terminators", () => {
		expect(stripAnsi("\u001B]0;window title\u0007rest")).toBe("rest");
		expect(stripAnsi("\u001B]8;;https://example.com\u001B\\link\u001B]8;;\u001B\\")).toBe("link");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("MCP: 1 server enabled")).toBe("MCP: 1 server enabled");
		expect(stripAnsi("普通文本")).toBe("普通文本");
		expect(stripAnsi("")).toBe("");
	});

	it("leaves text with brackets but no escape introducer untouched", () => {
		expect(stripAnsi("[38;2;138;190;183m not an escape")).toBe("[38;2;138;190;183m not an escape");
	});

	it("strips every occurrence in a multi-code string", () => {
		const raw = "\u001B[32mok\u001B[0m \u001B[2m·\u001B[0m \u001B[33mwarn\u001B[0m";
		expect(stripAnsi(raw)).toBe("ok · warn");
	});
});
