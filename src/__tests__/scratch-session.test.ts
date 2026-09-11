import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { ChatMessage } from "../chat-types";
import { attachToolResults, buildChatRows } from "../components/chat-rows";

/** Scratch: run the row builder over a real pi session JSONL to debug
 * missing assistant text rows. Not part of the suite's assertions. */

function parse(path: string): ChatMessage[] {
	const out: ChatMessage[] = [];
	let id = 1;
	let pendingToolNames: string[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message as { role: string; content?: unknown[] };
		const role =
			m.role === "toolResult" || m.role === "tool" ? "tool" : (m.role as ChatMessage["role"]);
		const blocks: Record<string, unknown>[] = [];
		let resultText = "";
		for (const raw of m.content ?? []) {
			const c = raw as Record<string, unknown>;
			if (c.type === "text") {
				if (role === "tool") resultText += String(c.text ?? "");
				else blocks.push({ kind: "text", text: c.text });
			} else if (c.type === "thinking") blocks.push({ kind: "thinking", text: c.thinking });
			else if (c.type === "toolCall")
				blocks.push({ kind: "tool", name: c.name, args: JSON.stringify(c.arguments ?? {}) });
		}
		if (role === "tool" && resultText) {
			blocks.push({
				kind: "tool",
				name: pendingToolNames.shift() ?? "tool_result",
				args: resultText,
				result: true,
			});
		}
		if (role === "assistant") {
			pendingToolNames = blocks
				.filter((b) => b.kind === "tool")
				.map((b) => String(b.name ?? "tool"));
		}
		out.push({
			id: id++,
			role,
			blocks: blocks as ChatMessage["blocks"],
			streaming: false,
			timestamp: e.timestamp as string,
		});
	}
	return out;
}

describe("scratch: real session rows", () => {
	it("dumps row kinds", () => {
		const path =
			"C:/Users/xujin/.pi/agent/sessions/.pi-gui-archive/2026-09-09T00-45-33-255Z_01a083a0-90c7-7e46-86fa-803dc8c19c75.jsonl";
		const msgs = parse(path);
		const lines: string[] = [];
		const rows = buildChatRows(attachToolResults(msgs), { working: false, streaming: false });
		for (const r of rows.slice(0, 40)) {
			if (r.kind === "group") {
				lines.push(`GROUP n=${r.entries.length} [${r.entries.map((e) => e.kind).join(",")}]`);
			} else if (r.kind === "turn") {
				lines.push(`TURN files=${r.changes?.files.length ?? 0}`);
			} else {
				const texts = r.item.msg.blocks
					.filter((b, i) => !r.skip.has(i) && b.kind === "text")
					.map((b) => (b as { text: string }).text.slice(0, 36));
				lines.push(
					`MSG role=${r.item.msg.role} blocks=${r.item.msg.blocks.length} skip=${r.skip.size} texts=${JSON.stringify(texts)}`,
				);
			}
		}
		writeFileSync("D:/agents/pi-gui/.scratch-rows.txt", lines.join("\n"));
	});
});
