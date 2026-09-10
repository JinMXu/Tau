import type { Block, ChatMessage } from "../chat-types";
import type { PiParsedMessage } from "../pi";

/**
 * Pure helpers for message rendering (tool summaries, diffs, in-session
 * search). Kept free of React/DOM imports so they can be unit-tested in a
 * plain node environment.
 */

/** Keys worth surfacing as the one-line summary of a tool call. */
export const SUMMARY_KEYS = ["path", "file_path", "command", "pattern", "query", "url"];

export function toolSummary(args: string): string | null {
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		for (const key of SUMMARY_KEYS) {
			const value = parsed[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
		return null;
	} catch {
		/* args may be partial while streaming */
		return null;
	}
}

export type DiffLine = { type: "ctx" | "del" | "add"; text: string };

/** LCS line diff. Huge inputs degrade to whole-block old/new display. */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
	const a = oldText.replace(/\n$/, "").split("\n");
	const b = newText.replace(/\n$/, "").split("\n");
	const n = a.length;
	const m = b.length;
	if (n * m > 1_000_000) {
		return [
			...a.map((text): DiffLine => ({ type: "del", text })),
			...b.map((text): DiffLine => ({ type: "add", text })),
		];
	}
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? dp[(i + 1) * width + j + 1] + 1
					: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: "ctx", text: a[i] });
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			out.push({ type: "del", text: a[i] });
			i++;
		} else {
			out.push({ type: "add", text: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ type: "del", text: a[i++] });
	while (j < m) out.push({ type: "add", text: b[j++] });
	return out;
}

/**
 * Diff blocks for edit/write-style tool args. Pi's `edit` tool takes an
 * `edits: [{oldText, newText}, …]` array (multiple hunks per call), so each
 * hunk becomes its own block. Returns null for non-file tools or while the
 * JSON is still streaming in.
 */
export function diffBlocksFromArgs(args: string): { label: string; lines: DiffLine[] }[] | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(args) as Record<string, unknown>;
	} catch {
		return null; // args may be partial while streaming
	}
	const { edits, old_string, new_string, content, path, file_path, command } = parsed;
	const blocks: { label: string; lines: DiffLine[] }[] = [];
	if (Array.isArray(edits) && edits.length > 0) {
		const multi = edits.length > 1;
		for (const item of edits) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			const oldText = rec.oldText ?? rec.old_string;
			const newText = rec.newText ?? rec.new_string;
			if (typeof oldText === "string" && typeof newText === "string") {
				blocks.push({
					label: multi ? `edit ${blocks.length + 1}/${edits.length}` : "",
					lines: computeLineDiff(oldText, newText),
				});
			}
		}
		return blocks.length ? blocks : null;
	}
	if (
		(typeof old_string === "string" && typeof new_string === "string") ||
		(typeof parsed.oldText === "string" && typeof parsed.newText === "string")
	) {
		const o = typeof parsed.oldText === "string" ? parsed.oldText : (old_string as string);
		const n = typeof parsed.newText === "string" ? parsed.newText : (new_string as string);
		return [{ label: "", lines: computeLineDiff(o, n) }];
	}
	if (
		typeof content === "string" &&
		typeof command !== "string" &&
		(typeof path === "string" || typeof file_path === "string")
	) {
		return [
			{
				label: "",
				lines: content
					.replace(/\n$/, "")
					.split("\n")
					.map((text): DiffLine => ({ type: "add", text })),
			},
		];
	}
	return null;
}

/** One in-session search hit (message + block + occurrence). */
export interface SearchHit {
	messageIndex: number;
	blockIndex: number;
	start: number;
	end: number;
}

/**
 * Case-insensitive search over the plain text of all message blocks
 * (text/thinking/tool). Returns every occurrence so the UI can navigate and
 * highlight them.
 */
export function searchMessages(messages: ChatMessage[], query: string): SearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: SearchHit[] = [];
	messages.forEach((m, messageIndex) => {
		m.blocks.forEach((b: Block, blockIndex) => {
			let text: string;
			if (b.kind === "text") text = b.text;
			else if (b.kind === "thinking") text = b.text;
			else text = b.args ?? "";
			const lower = text.toLowerCase();
			let from = 0;
			for (;;) {
				const idx = lower.indexOf(q, from);
				if (idx < 0) break;
				hits.push({ messageIndex, blockIndex, start: idx, end: idx + q.length });
				from = idx + q.length;
			}
		});
	});
	return hits;
}

/** Split a plain string on a (case-insensitive) query for <mark> rendering. */
export function splitOnQuery(text: string, query: string): { text: string; match: boolean }[] {
	const q = query.trim();
	if (!q) return [{ text, match: false }];
	const lower = text.toLowerCase();
	const ql = q.toLowerCase();
	const out: { text: string; match: boolean }[] = [];
	let pos = 0;
	for (;;) {
		const idx = lower.indexOf(ql, pos);
		if (idx < 0) {
			if (pos < text.length) out.push({ text: text.slice(pos), match: false });
			break;
		}
		if (idx > pos) out.push({ text: text.slice(pos, idx), match: false });
		out.push({ text: text.slice(idx, idx + q.length), match: true });
		pos = idx + q.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Markdown rendering for copy/export. Single source of truth — App.tsx,
// MessageList.tsx and ArchivedPreview.tsx used to each carry a slightly
// divergent copy of this logic.
// ---------------------------------------------------------------------------

function blockToMarkdown(b: Block): string {
	if (b.kind === "text") return b.text;
	if (b.kind === "thinking") return `<details><summary>thinking</summary>\n\n${b.text}\n</details>`;
	return `<details><summary>tool: ${b.name}</summary>\n\n\`\`\`json\n${b.args}\n\`\`\`\n</details>`;
}

function roleLabel(role: string): string {
	if (role === "user") return "User";
	if (role === "tool") return "Tool";
	return "Pi";
}

/** Render a single live chat message as Markdown (hover copy, exports). */
export function chatMessageToMarkdown(m: ChatMessage): string {
	const parts = m.blocks.map(blockToMarkdown).filter(Boolean);
	if (!parts.length) return "";
	return `**${roleLabel(m.role)}**:\n${parts.join("\n\n")}`;
}

/** Plain-text rendering of a single message (hover “copy plain text”). */
export function chatMessageToPlainText(m: ChatMessage): string {
	return m.blocks
		.filter((b) => b.kind === "text")
		.map((b) => b.text)
		.join("\n\n");
}

/** Render parsed session messages (archived preview/export) as Markdown. */
export function parsedMessagesToMarkdown(messages: PiParsedMessage[]): string {
	const parts = messages
		.map((m) => {
			const body = m.blocks
				.map((b): string => {
					if (b.kind === "text") return b.text;
					if (b.kind === "thinking")
						return `<details><summary>thinking</summary>\n\n${b.text}\n</details>`;
					return `<details><summary>tool: ${b.name ?? "tool"}</summary>\n\n\`\`\`json\n${b.text}\n\`\`\`\n</details>`;
				})
				.filter(Boolean);
			if (!body.length) return "";
			return `**${roleLabel(m.role)}**:\n${body.join("\n\n")}`;
		})
		.filter(Boolean);
	return parts.join("\n\n---\n\n");
}
