import { describe, expect, it } from "vitest";
import { keepStreamedText } from "../session-merge";
import type { Block } from "../chat-types";

const text = (s: string): Block => ({ kind: "text", text: s });
const tool = (name: string): Block => ({ kind: "tool", name }) as unknown as Block;

describe("keepStreamedText", () => {
	it("keeps the streamed text when it is a prefix-extension of the snapshot", () => {
		// pi's snapshot lagged a few characters behind the stream: the longer
		// streamed text must win, otherwise markstream hard-resets the row.
		const streamed = [text("Hello wor")];
		const authoritative = [text("Hello ")];
		const out = keepStreamedText(streamed, authoritative);
		expect(out).toHaveLength(1);
		expect(out[0]).toBe(streamed[0]);
	});

	it("takes the authoritative blocks when the stream is longer than the snapshot", () => {
		// Streamed text is NOT a prefix of the snapshot → pi corrected itself,
		// so the authoritative version wins.
		const streamed = [text("Hello world, extra")];
		const authoritative = [text("Goodbye")];
		const out = keepStreamedText(streamed, authoritative);
		expect(out).toBe(authoritative);
	});

	it("takes the authoritative blocks when the block count differs", () => {
		const streamed = [text("a")];
		const authoritative = [text("a"), tool("bash")];
		expect(keepStreamedText(streamed, authoritative)).toBe(authoritative);
	});

	it("leaves non-text blocks untouched", () => {
		const streamed = [tool("bash")];
		const authoritative = [tool("bash")];
		const out = keepStreamedText(streamed, authoritative);
		expect(out).toBe(authoritative);
	});

	it("keeps only the extended text block and leaves its siblings alone", () => {
		const streamed = [text("Hello wor"), tool("read")];
		const authoritative = [text("Hello "), tool("read")];
		const out = keepStreamedText(streamed, authoritative);
		expect(out[0]).toBe(streamed[0]);
		expect(out[1]).toBe(authoritative[1]);
	});

	it("returns the authoritative array identity when nothing was kept", () => {
		// The identity matters: a new array would re-render the row for nothing.
		const streamed = [text("abc")];
		const authoritative = [text("abc")];
		expect(keepStreamedText(streamed, authoritative)).toBe(authoritative);
	});
});
