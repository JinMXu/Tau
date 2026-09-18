import { memo, useEffect, useMemo, useReducer, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { ChevronDownIcon } from "../icons";
import { useSweepHighlight } from "./use-sweep-highlight";
import { ThinkingOrb } from "thinking-orbs";
import { PreviewTicker, type LivePreviewItem } from "./PreviewTicker";
import { ToolCard, ThinkingBlock } from "./ToolCard";
import { formatDuration } from "../format";
import { AgentActivity, type AgentActivityItem } from "./agents/agent-activity";
import {
	summarizeCategories,
	type GroupEntry,
	type ToolCategory,
	type TurnChanges,
} from "./chat-rows";

/**
 * MetaGroup — the folded work group, now rendered through beui's
 * AgentActivity: while the agent works the header is a ThinkingShimmer line
 * and entries stream in; once settled it folds under a category-summary line
 * ("读取 1 个文件 · 编辑 2 个文件"). Expanding shows the same full thinking
 * rows and tool cards as before (carried as text-type activity items, which
 * render their content verbatim).
 */

/** en plural units (zh templates ignore the {unit} param). */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

const fmt = (s: string, params: Record<string, string | number>): string =>
	s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ""));

/** One category segment's label ("读取 3 个文件" / "Bash ×2"). */
function summaryLabel(
	t: MessageCatalog,
	seg: { category: ToolCategory; name?: string; count: number },
): string {
	const n = seg.count;
	switch (seg.category) {
		case "read":
			return fmt(t.chat.summaryRead, { n, unit: pluralUnit(n, "file", "files") });
		case "edit":
			return fmt(t.chat.summaryEdit, { n, unit: pluralUnit(n, "file", "files") });
		case "explore":
			return fmt(t.chat.summaryExplore, { n, unit: pluralUnit(n, "time", "times") });
		case "search":
			return fmt(t.chat.summarySearch, { n, unit: pluralUnit(n, "time", "times") });
		case "bash":
			return fmt(t.chat.summaryBash, { n, unit: pluralUnit(n, "command", "commands") });
		case "subagent":
			return fmt(t.chat.summarySubagents, { n, unit: pluralUnit(n, "subagent", "subagents") });
		default: {
			const name = (seg.name ?? "")
				.split("_")
				.map((s) => s[0]?.toUpperCase() + s.slice(1))
				.join(" ");
			return `${name} ×${n}`;
		}
	}
}

/** One-line activity preview for the running group's latest entry. */
function previewOf(entry: GroupEntry | undefined): {
	kind: "thinking" | "tool";
	name?: string;
	text: string;
} {
	if (!entry) return { kind: "thinking", text: "" };
	if (entry.kind === "thinking") {
		const trimmed = entry.text?.trimEnd() ?? "";
		const nl = trimmed.lastIndexOf("\n");
		return { kind: "thinking", text: nl === -1 ? trimmed : trimmed.slice(nl + 1) };
	}
	const block = entry.block!;
	let text = "";
	try {
		const parsed = JSON.parse(block.args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") text = command;
		else if (typeof parsed.path === "string") text = parsed.path;
		else if (typeof parsed.query === "string") text = parsed.query;
		else if (typeof parsed.pattern === "string") text = parsed.pattern;
		else if (typeof parsed.url === "string") text = parsed.url;
	} catch {
		/* partial args */
	}
	const name = block.name
		.split("_")
		.map((s) => s[0]?.toUpperCase() + s.slice(1))
		.join(" ");
	return { kind: "tool", name, text };
}

export const MetaGroup = memo(
	function MetaGroup({
		entries,
		live,
		t,
	}: {
		entries: GroupEntry[];
		live: boolean;
		t: MessageCatalog;
	}) {
		const summary = useMemo(() => summarizeCategories(entries), [entries]);
		const lastEntry = entries[entries.length - 1];
		const preview = useMemo(() => previewOf(lastEntry), [lastEntry]);
		const label = preview.kind === "thinking" && live ? t.chat.metaThinking : t.chat.metaWorking;

		// Activity items: one per entry, content = the existing full renderer
		// (ThinkingBlock / ToolCard) so expansion keeps the complete args +
		// output exactly as before. The beui shell contributes the live
		// shimmer, the streaming entrance, and the folded summary.
		const items = useMemo<AgentActivityItem[]>(
			() =>
				entries.map((e) => ({
					id: `${e.msgId}:${e.blockIndex}`,
					type: "text" as const,
					content:
						e.kind === "thinking" ? (
							<ThinkingBlock text={e.text ?? ""} t={t} />
						) : (
							<ToolCard
								block={e.block!}
								result={e.result}
								running={live && e.running}
								t={t}
							/>
						),
				})),
			[entries, live, t],
		);

		// Live preview items: one per activity (thinking text / tool name +
		// summarized args), in arrival order. PreviewTicker shows the newest
		// (latest-wins) and slides rows up as activities change.
		const liveItems = useMemo<LivePreviewItem[]>(
			() =>
				entries.map((e) => {
					const p = previewOf(e);
					const id = `${e.msgId}:${e.blockIndex}`;
					return p.kind === "tool"
						? { kind: "tool" as const, id, name: p.name ?? "", text: p.text }
						: { kind: "thinking" as const, id, text: p.text };
				}),
			[entries],
		);
		// Codex-style sweep highlight shared by the label and the preview's
		// tool name (percho: one band, constant speed, rAF-painted).
		const { labelRef, wrapRef } = useSweepHighlight(live, liveItems.map((i) => i.id).join(","));

		// Working status row: the sweep-highlighted label + per-activity ticker
		// (our orb/ticker language) rendered through beui's working-status slot.
		const summaryLine = (
			<span className="meta-summary-line">
				{summary.map((seg, i) => (
					<span key={i} className="meta-seg">
						{summaryLabel(t, seg)}
					</span>
				))}
			</span>
		);

		// Single settled entry (e.g. one thinking block before the text)
		// renders as a bare row without the folding chrome — same as percho,
		// which only wraps groups of 2+ (or working) in the shell.
		if (entries.length === 1 && !live) {
			const e = entries[0];
			return (
				<div className="meta-bare">
					{e.kind === "thinking" ? (
						<ThinkingBlock text={e.text ?? ""} t={t} />
					) : (
						<ToolCard block={e.block!} result={e.result} running={false} t={t} />
					)}
				</div>
			);
		}

		return (
			<div className={`meta-group${live ? " live" : ""}`}>
				<AgentActivity
					items={items}
					status={live ? "working" : "complete"}
					activeLabel={label}
					summary={summaryLine}
					collapseOnComplete
					renderWorkingStatus={() => (
						<div className="meta-head" style={{ cursor: "default" }}>
							<ThinkingOrb
								state={preview.kind === "tool" ? "connecting" : "working"}
								size={20}
								paused={false}
							/>
							<span ref={labelRef} className="meta-label sweep-target">
								{label}
							</span>
							<span className="meta-preview" ref={wrapRef}>
								<PreviewTicker items={liveItems} reserveSpace />
							</span>
						</div>
					)}
					contentClassName="meta-body"
				/>
			</div>
		);
	},
	(prev, next) => {
		// Cheap equality: same live flag, same length, same per-entry identity —
		// entry text/args are compared by reference where it matters.
		if (prev.live !== next.live || prev.t !== next.t || prev.entries.length !== next.entries.length)
			return false;
		for (let i = 0; i < prev.entries.length; i++) {
			const a = prev.entries[i];
			const b = next.entries[i];
			if (a.kind !== b.kind || a.msgId !== b.msgId || a.blockIndex !== b.blockIndex) return false;
			if (a.running !== b.running) return false;
			if (a.kind === "thinking" && a.text !== b.text) return false;
		}
		return true;
	},
);

/** Compact ticking timer (codex-style): live runs tick every second. */
function TurnTimer({
	startedAt,
	endedAt,
	live,
	liveStart,
}: {
	startedAt: number | null;
	endedAt: number | null;
	live: boolean;
	liveStart: number | null;
}) {
	const [, tick] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (!live) return;
		const id = window.setInterval(tick, 1000);
		return () => window.clearInterval(id);
	}, [live]);
	const elapsed = live
		? Math.max(0, Date.now() - (startedAt ?? liveStart ?? Date.now()))
		: startedAt !== null && endedAt !== null
			? Math.max(0, endedAt - startedAt)
			: null;
	if (elapsed === null || (!live && elapsed < 1000)) return null;
	return (
		<span role="timer" className={`turn-diff-timer${live ? " turn-diff-timer-live" : ""}`}>
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v5l3 3" />
			</svg>
			<span className="turn-diff-timer-num">{formatDuration(elapsed)}</span>
		</span>
	);
}

/**
 * Turn footer row: timer first (every turn), file-change chip when the turn
 * touched files. With changes the whole row is expandable to a file list;
 * clicking a file opens the diff sidebar.
 */
export function TurnDiffRow({
	changes,
	startedAt,
	endedAt,
	live,
	liveStart,
	/** 该 chip 刚出现（轮末首次渲染）时为 true：最外层额外挂 .turn-diff-enter 播一次入场 pop
	 *  （percho globals.css:988-1002），由 MessageList 传入。 */
	entering,
	onOpenDiff,
	t,
}: {
	changes: TurnChanges | null;
	startedAt: number | null;
	endedAt: number | null;
	live: boolean;
	liveStart: number | null;
	entering?: boolean;
	onOpenDiff?: () => void;
	t: MessageCatalog;
}) {
	const [open, setOpen] = useState(false);
	const enterCls = entering ? " turn-diff-enter" : "";
	const timer = (
		<TurnTimer startedAt={startedAt} endedAt={endedAt} live={live} liveStart={liveStart} />
	);
	if (!changes) {
		return <div className={`turn-diff-plain${live ? " live" : ""}${enterCls}`}>{timer}</div>;
	}
	const fileCount = changes.files.length;
	return (
		<div className={`turn-diff${live ? " live" : ""}${enterCls}`}>
			<button
				type="button"
				className="turn-diff-head"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				{timer}
				<span className="turn-diff-sep" aria-hidden="true">
					·
				</span>
				<span className="turn-diff-title">
					{fmt(t.diff.filesChanged, {
						count: fileCount,
						unit: pluralUnit(fileCount, "file", "files"),
					})}
				</span>
				<span className="turn-diff-stat turn-diff-added">+{changes.totalAdded}</span>
				<span className="turn-diff-stat turn-diff-removed">−{changes.totalRemoved}</span>
				<span className="turn-diff-chev" aria-hidden="true">
					<ChevronDownIcon size={11} className={open ? "open" : ""} />
				</span>
			</button>
			{open && (
				<div className="turn-diff-files">
					{changes.files.map((f) => (
						<button
							key={f.path}
							type="button"
							className="turn-diff-file"
							title={f.path}
							onClick={() => {
								setOpen(false);
								onOpenDiff?.();
							}}
						>
							<span className="turn-diff-path">{`\u200e${f.path}`}</span>
							<span className="turn-diff-stat">
								<span className="turn-diff-added">+{f.added}</span>{" "}
								<span className="turn-diff-removed">−{f.removed}</span>
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
