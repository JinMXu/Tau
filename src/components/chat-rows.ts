import type { Block, ChatMessage } from "../chat-types";
import { computeLineDiff, searchMessages, type DiffLine } from "./message-utils";

/**
 * Chat row derivation (pure): messages → render rows for MessageList.
 * Port of the "grouping brain" from the Percho desktop UI:
 *
 * - An assistant message's thinking + tool blocks fold into a MetaGroup row;
 *   the first text block closes the group and renders as its own message row
 *   (text is the boundary). This is what turns a noisy stream of thinking /
 *   tool cards into one collapsible "Worked" line with category stats.
 * - A turn-diff row is emitted at each turn boundary (the next user message):
 *   timer + "modified N files +X −Y" derived from edit/write tool calls.
 * - Everything is derived, zero storage: history replays and live streams
 *   pass through the same code path.
 */

export type ToolBlockT = Extract<Block, { kind: "tool" }>;

/** Per-message attachment view (tool result message → its call). */
export interface MessageItem {
	msg: ChatMessage;
	attached: Map<number, ToolBlockT>;
	attachedStreaming: Map<number, boolean>;
	consumed: Set<number>;
}

/** One folded entry inside a meta group. */
export interface GroupEntry {
	kind: "thinking" | "tool";
	msgId: number;
	blockIndex: number;
	/** thinking text (kind: thinking). */
	text?: string;
	/** tool call block (kind: tool). */
	block?: ToolBlockT;
	result?: ToolBlockT | null;
	resultStreaming: boolean;
	running: boolean;
}

export type ChatRow =
	| {
			kind: "group";
			key: string;
			entries: GroupEntry[];
			/** The group the agent is currently working in (orb + preview + dots). */
			live: boolean;
	  }
	| {
			kind: "msg";
			key: string;
			item: MessageItem;
			/** Block indices lifted into a meta group (skipped by the row). */
			skip: Set<number>;
			/** When the message was split into text segments (text → tool → text),
			 * only these text blocks render on THIS row. */
			textAllow?: Set<number>;
			/** The last row of a message: carries the streaming cursor + error. */
			last: boolean;
	  }
	| {
			kind: "turn";
			key: string;
			changes: TurnChanges | null;
			startedAt: number | null;
			endedAt: number | null;
			/** The turn in flight right now — timer ticks live. */
			live: boolean;
			/** Chip that just appeared while the user watched (turn-end pop). */
			entering: boolean;
	  };

// ---------------------------------------------------------------------------
// Numbered diff (double-gutter rendering for the diff sidebar)
// ---------------------------------------------------------------------------

export interface NumDiffLine {
	kind: "ctx" | "add" | "del";
	text: string;
	oldNo: number | null;
	newNo: number | null;
}

/** Assign old/new line numbers to a plain +/- diff (ctx: both advance). */
export function numberDiff(lines: DiffLine[]): NumDiffLine[] {
	let oldNo = 1;
	let newNo = 1;
	return lines.map((l) => {
		if (l.type === "add")
			return { kind: "add" as const, text: l.text, oldNo: null, newNo: newNo++ };
		if (l.type === "del")
			return { kind: "del" as const, text: l.text, oldNo: oldNo++, newNo: null };
		return { kind: "ctx" as const, text: l.text, oldNo: oldNo++, newNo: newNo++ };
	});
}

// ---------------------------------------------------------------------------
// Turn file changes (edit/write tool calls → per-turn per-file diffs)
// ---------------------------------------------------------------------------

export interface TurnFileChange {
	path: string;
	added: number;
	removed: number;
	/** One section per tool call touching the file (rendered with separators). */
	sections: NumDiffLine[][];
}

export interface TurnChanges {
	turnIndex: number;
	files: TurnFileChange[];
	totalAdded: number;
	totalRemoved: number;
}

/** Parse one tool call's args into { path, numbered diff lines }; null otherwise. */
function fileChangeFromArgs(
	name: string,
	args: string,
): { path: string; lines: NumDiffLine[]; added: number; removed: number } | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(args) as Record<string, unknown>;
	} catch {
		return null; // args may be partial while streaming
	}
	const path =
		typeof parsed.path === "string"
			? parsed.path
			: typeof parsed.file_path === "string"
				? parsed.file_path
				: null;
	if (!path) return null;
	const key = name.toLowerCase();

	if (key === "edit" || key.includes("apply") || key.includes("patch")) {
		const { edits, oldText, newText, old_string, new_string } = parsed;
		const lines: NumDiffLine[] = [];
		if (Array.isArray(edits)) {
			for (const item of edits) {
				if (!item || typeof item !== "object") continue;
				const rec = item as Record<string, unknown>;
				const o = rec.oldText ?? rec.old_string;
				const n = rec.newText ?? rec.new_string;
				if (typeof o === "string" && typeof n === "string") {
					lines.push(...numberDiff(computeLineDiff(o, n)));
				}
			}
		} else {
			// Single replacement: pi sends { oldText, newText }; other tools
			// spell it { old_string, new_string }.
			const o = oldText ?? old_string;
			const n = newText ?? new_string;
			if (typeof o === "string" && typeof n === "string") {
				lines.push(...numberDiff(computeLineDiff(o, n)));
			}
		}
		if (lines.length === 0) return null;
		return { path, lines, added: count(lines, "add"), removed: count(lines, "del") };
	}

	if (key === "write") {
		// Full-file write: every line counts as added.
		const content = typeof parsed.content === "string" ? parsed.content : null;
		if (content === null || typeof parsed.command === "string") return null;
		const lines: NumDiffLine[] = content
			.replace(/\n$/, "")
			.split("\n")
			.map((text, i) => ({ kind: "add" as const, text, oldNo: null, newNo: i + 1 }));
		if (lines.length === 0) return null;
		return { path, lines, added: lines.length, removed: 0 };
	}

	return null;
}

function count(lines: NumDiffLine[], kind: "add" | "del"): number {
	let n = 0;
	for (const l of lines) if (l.kind === kind) n++;
	return n;
}

// Parsed file changes per (tool, args): deriveTurnChanges re-runs on every
// streamed delta, and a committed call's args never change, so the bounded
// cache turns the repeated JSON.parse + LCS work into map hits — only the
// in-flight call re-parses while its args grow. Partial-args keys churn, so
// the cache must stay bounded.
const FILE_CHANGE_CACHE_MAX = 512;
const fileChangeCache: Map<string, ReturnType<typeof fileChangeFromArgs>> = new Map();

function cachedFileChangeFromArgs(
	name: string,
	args: string,
): ReturnType<typeof fileChangeFromArgs> {
	const key = `${name}\u0000${args}`;
	const hit = fileChangeCache.get(key);
	if (hit !== undefined) return hit;
	const parsed = fileChangeFromArgs(name, args);
	// Re-insert to refresh recency (Map iterates in insertion order).
	fileChangeCache.delete(key);
	fileChangeCache.set(key, parsed);
	if (fileChangeCache.size > FILE_CHANGE_CACHE_MAX) {
		const oldest = fileChangeCache.keys().next().value;
		if (oldest !== undefined) fileChangeCache.delete(oldest);
	}
	return parsed;
}

/**
 * Per-turn file changes derived from edit/write tool calls. Turn boundary =
 * user message (same rule as the row builder). Messages before the first
 * user message belong to turn 0.
 */
export function deriveTurnChanges(messages: ChatMessage[]): TurnChanges[] {
	const turns: TurnChanges[] = [];
	let turnIndex = -1;
	let current: TurnChanges | null = null;
	const flush = () => {
		if (current && current.files.length > 0) turns.push(current);
		current = null;
	};
	for (const msg of messages) {
		if (msg.role === "user") {
			flush();
			turnIndex++;
			current = { turnIndex, files: [], totalAdded: 0, totalRemoved: 0 };
			continue;
		}
		if (turnIndex < 0 || !current) continue;
		if (msg.role !== "assistant") continue;
		for (const b of msg.blocks) {
			if (b.kind !== "tool" || b.result) continue;
			const change = cachedFileChangeFromArgs(b.name, b.args);
			if (!change) continue;
			let file = current.files.find((f) => f.path === change.path);
			if (!file) {
				file = { path: change.path, added: 0, removed: 0, sections: [] };
				current.files.push(file);
			}
			file.sections.push(change.lines);
			file.added += change.added;
			file.removed += change.removed;
			current.totalAdded += change.added;
			current.totalRemoved += change.removed;
		}
	}
	flush();
	return turns;
}

export interface TurnTiming {
	startedAt: number | null;
	endedAt: number | null;
}

/**
 * Per-turn wall-clock timing from message timestamps: startedAt = the user
 * message time, endedAt = the newest timestamp inside the turn. History
 * turns settle; the live turn's endedAt stays null (timer ticks from
 * startedAt — or from the caller-provided live anchor when the session's
 * messages carry no timestamps at all, e.g. mid-first-run).
 */
export function deriveTurnTimings(messages: ChatMessage[]): TurnTiming[] {
	const timings: TurnTiming[] = [];
	let startedAt: number | null = null;
	let endedAt: number | null = null;
	let open = false;
	const toMs = (ts?: string): number | null => {
		if (!ts) return null;
		const d = new Date(ts).getTime();
		return Number.isNaN(d) ? null : d;
	};
	const push = () => timings.push({ startedAt, endedAt });
	for (const msg of messages) {
		if (msg.role === "user") {
			if (open) push();
			startedAt = toMs(msg.timestamp);
			endedAt = null;
			open = true;
			continue;
		}
		if (!open) continue;
		const ts = toMs(msg.timestamp);
		if (ts !== null && (endedAt === null || ts > endedAt)) endedAt = ts;
	}
	if (open) push();
	return timings;
}

// ---------------------------------------------------------------------------
// Todo list extraction (todo tool calls → task list panel)
// ---------------------------------------------------------------------------

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * Latest valid `todo` tool call args → task list (full-replace protocol,
 * TodoWrite-style). Returns [] when the session never used the tool, so the
 * panel can hide itself. Accepts the common spellings ("todo", "todowrite",
 * "todo_write") and ignores partial/streaming args.
 */
export function extractTodos(messages: ChatMessage[]): TodoItem[] {
	let latest: TodoItem[] | null = null;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const b of msg.blocks) {
			if (b.kind !== "tool" || b.result) continue;
			const key = b.name.toLowerCase();
			if (key !== "todo" && key !== "todowrite" && key !== "todo_write") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(b.args);
			} catch {
				continue; // partial args while streaming
			}
			const todos = (parsed as { todos?: unknown } | null)?.todos;
			if (!Array.isArray(todos)) continue;
			const items: TodoItem[] = [];
			for (const raw of todos) {
				if (!raw || typeof raw !== "object") continue;
				const rec = raw as Record<string, unknown>;
				if (typeof rec.content !== "string" || rec.content.length === 0) continue;
				if (typeof rec.status !== "string" || !TODO_STATUSES.has(rec.status)) continue;
				items.push({ content: rec.content, status: rec.status as TodoItem["status"] });
			}
			latest = items;
		}
	}
	return latest ?? [];
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

/** Tool call categories for the folded summary line (Percho-style). */
export type ToolCategory = "read" | "edit" | "explore" | "search" | "bash" | "subagent" | "other";

function categoryOf(toolName: string): ToolCategory {
	const key = toolName.toLowerCase();
	if (key === "read") return "read";
	if (key === "edit" || key === "write" || key.includes("apply") || key.includes("patch"))
		return "edit";
	if (
		key.startsWith("ls") ||
		key.startsWith("glob") ||
		key.startsWith("find") ||
		key.startsWith("tree")
	)
		return "explore";
	if (key.startsWith("grep") || key.startsWith("search")) return "search";
	if (key.startsWith("bash") || key.startsWith("exec") || key.startsWith("shell") || key === "cmd")
		return "bash";
	if (key.includes("subagent") || key.includes("agent")) return "subagent";
	return "other";
}

export interface SummarySegment {
	category: ToolCategory;
	/** Original tool name (other category only). */
	name?: string;
	count: number;
}

/** Category counts for the folded group summary line. */
export function summarizeCategories(entries: GroupEntry[]): SummarySegment[] {
	const order: ToolCategory[] = ["read", "edit", "explore", "search", "bash", "subagent"];
	const counts = new Map<string, number>();
	for (const e of entries) {
		if (e.kind !== "tool" || !e.block) continue;
		const cat = categoryOf(e.block.name);
		const key = cat === "other" ? `other:${e.block.name.toLowerCase()}` : cat;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const segs: SummarySegment[] = [];
	for (const cat of order) {
		const n = counts.get(cat);
		if (n) segs.push({ category: cat, count: n });
	}
	for (const [key, n] of counts) {
		if (key.startsWith("other:")) segs.push({ category: "other", name: key.slice(6), count: n });
	}
	return segs;
}

/** Attachment pass (verbatim behaviour from the previous MessageList): attach
 * tool-result messages to the tool calls that produced them. */
export function attachToolResults(messages: ChatMessage[]): MessageItem[] {
	const list: MessageItem[] = [];
	let pending: { item: MessageItem; index: number }[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") pending = [];
		const item: MessageItem = {
			msg,
			attached: new Map(),
			attachedStreaming: new Map(),
			consumed: new Set(),
		};
		if (msg.role === "tool") {
			msg.blocks.forEach((b, i) => {
				if (b.kind !== "tool") return;
				const slot = pending.shift();
				if (slot) {
					slot.item.attached.set(slot.index, b);
					slot.item.attachedStreaming.set(slot.index, msg.streaming);
					item.consumed.add(i);
				}
			});
			// Drop the message entirely once every block was attached.
			if (item.consumed.size < msg.blocks.length) list.push(item);
			continue;
		}
		list.push(item);
		if (msg.role === "assistant") {
			msg.blocks.forEach((b, i) => {
				if (b.kind === "tool" && !b.result) pending.push({ item, index: i });
			});
		}
	}
	return list;
}

/**
 * Build the render rows. `bypassIds` marks messages that must render all
 * blocks inline (in-session search targets — highlights inside folded
 * groups would be invisible otherwise). `working`/`streaming` drive the
 * live-group and live-turn flags.
 */
export function buildChatRows(
	items: MessageItem[],
	opts: {
		working: boolean;
		streaming: boolean;
		bypassIds?: Set<number>;
		turnChanges?: TurnChanges[];
		turnTimings?: TurnTiming[];
		/** The turn whose footer chip should play the entrance pop (percho's
		 *  enteringTurn); null when nothing new appeared while viewing. */
		enteringTurn?: number | null;
	},
): ChatRow[] {
	const bypass = opts.bypassIds ?? new Set<number>();
	const changes = opts.turnChanges ?? deriveTurnChanges(items.map((i) => i.msg));
	const timings = opts.turnTimings ?? deriveTurnTimings(items.map((i) => i.msg));
	const rows: ChatRow[] = [];
	let group: GroupEntry[] | null = null;
	let groupKey = 0;
	let turnCount = 0;

	const flushGroup = () => {
		if (!group || group.length === 0) {
			group = null;
			return;
		}
		rows.push({ kind: "group", key: `g${groupKey++}`, entries: group, live: false });
		group = null;
	};

	const pushTurnRow = (turnIndex: number, live: boolean, force = false) => {
		const change = changes.find((c) => c.turnIndex === turnIndex) ?? null;
		if (!change && !live && !force) return;
		const timing = timings[turnIndex];
		rows.push({
			kind: "turn",
			key: `t${turnIndex}`,
			changes: change,
			startedAt: timing?.startedAt ?? null,
			endedAt: timing?.endedAt ?? null,
			live,
			// 刚出现的那一轮才播入场 pop（percho TurnDiffChip 的 entering 门控：
			// 基线不随渲染更新，否则 turn_end 紧随的二次渲染会把动画类摘掉）。
			entering: turnIndex === (opts.enteringTurn ?? -1),
		});
	};

	for (const item of items) {
		const msg = item.msg;
		if (msg.role === "user") {
			flushGroup();
			// Completed turn's footer row sits right before the next user row.
			// Forced: every turn shows its wall-clock duration, even pure-chat
			// turns with no file changes (the final turn already did this via
			// force — now the rule is uniform, and any turnIndex/changes
			// mismatch can no longer swallow a footer).
			if (turnCount > 0) pushTurnRow(turnCount - 1, false, true);
			turnCount++;
			rows.push({ kind: "msg", key: `m${msg.id}`, item, skip: new Set(), last: true });
			continue;
		}
		if (msg.role === "tool") {
			// Orphan results (unattached) render inline; flush the group —
			// consumed tool messages were dropped by attachToolResults, so
			// reaching here means the result chain broke.
			flushGroup();
			rows.push({ kind: "msg", key: `m${msg.id}`, item, skip: new Set(), last: true });
			continue;
		}
		// assistant message — split into segments at text blocks so the render
		// order matches the stream order: [thinking, text, tool] renders as
		// group → text row → group (a tool after the text must NOT jump above
		// it). Each segment emits its group row (if any meta) then the text
		// row (if any text).
		if (bypass.has(msg.id)) {
			flushGroup();
			rows.push({ kind: "msg", key: `m${msg.id}`, item, skip: new Set(), last: true });
			continue;
		}
		const skip = new Set<number>();
		const segments: { entries: GroupEntry[]; textIdx: number[] }[] = [];
		let cur: { entries: GroupEntry[]; textIdx: number[] } = { entries: [], textIdx: [] };
		const pushSeg = () => {
			if (cur.entries.length > 0 || cur.textIdx.length > 0) segments.push(cur);
		};
		msg.blocks.forEach((b, i) => {
			if (b.kind === "text") {
				// A text block closes the current meta segment…
				if (cur.entries.length > 0) {
					pushSeg();
					cur = { entries: [], textIdx: [] };
				}
				cur.textIdx.push(i);
				return;
			}
			skip.add(i);
			// …and a meta block after text opens a NEW segment (stream order).
			if (cur.textIdx.length > 0) {
				pushSeg();
				cur = { entries: [], textIdx: [] };
			}
			if (b.kind === "thinking") {
				cur.entries.push({
					kind: "thinking",
					msgId: msg.id,
					blockIndex: i,
					text: b.text,
					result: null,
					resultStreaming: false,
					running: msg.streaming && i === msg.blocks.length - 1,
				});
				return;
			}
			// tool call
			cur.entries.push({
				kind: "tool",
				msgId: msg.id,
				blockIndex: i,
				block: b,
				result: b.result ? b : (item.attached.get(i) ?? null),
				resultStreaming: item.attachedStreaming.get(i) ?? false,
				running:
					(msg.streaming && i === msg.blocks.length - 1) ||
					(item.attachedStreaming.get(i) ?? false),
			});
		});
		pushSeg();
		// The cursor + error belong to the message's LAST TEXT row (a trailing
		// meta group renders after it; its live orb is the activity signal).
		let lastTextSeg = -1;
		segments.forEach((seg, si) => {
			if (seg.textIdx.length > 0) lastTextSeg = si;
		});
		segments.forEach((seg, si) => {
			if (seg.entries.length > 0) {
				// Accumulate into the open group instead of emitting one group
				// per message: consecutive assistant messages (their tool-result
				// messages are dropped by attachToolResults) fold into ONE group
				// until a text block closes it — percho's core behaviour, so a
				// burst of calls reads as「执行 13 条命令」rather than 13 rows.
				group ??= [];
				group.push(...seg.entries);
			}
			if (seg.textIdx.length > 0) {
				// Text is the group boundary: close the group first so the
				// narration renders right after everything it narrates.
				flushGroup();
				rows.push({
					kind: "msg",
					// Row key must NOT depend on how many segments the message
					// currently has: mid-stream a thinking/tool block landing
					// after the text flips segments.length 1→2, and a key change
					// makes React unmount + remount the whole row — which
					// remounts <Markdown>, rebuilds markstream's smooth
					// controller and retypes the finished paragraph from an
					// empty buffer (plus replays the enter animation). Percho
					// keys rows by message.id and never remounts; the text
					// segment's ordinal is fixed by the block order, so it is
					// stable across the whole stream.
					key: `m${msg.id}-${si}`,
					item,
					skip,
					textAllow: new Set(seg.textIdx),
					last: si === lastTextSeg,
				});
			}
		});
	}
	flushGroup();
	// Footer row for the final turn: while the agent works it ticks live
	// (timer + files edited so far); once settled, only turns WITH changes
	// get a row — keeps history clean.
	if (turnCount > 0) {
		// force：无论有无文件改动都展示（纯对话轮也要显示运行时长）
		pushTurnRow(turnCount - 1, opts.working, true);
	}
	return rows;
}

/** Message ids containing at least one search hit (for grouping bypass). */
export function searchBypassIds(messages: ChatMessage[], query?: string): Set<number> {
	const ids = new Set<number>();
	if (!query || query.trim() === "") return ids;
	for (const hit of searchMessages(messages, query)) ids.add(messages[hit.messageIndex]?.id);
	return ids;
}
