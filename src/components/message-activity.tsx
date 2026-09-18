import { memo, useEffect, useMemo, useReducer, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
	Check,
	ChevronDown,
	Clock,
	FileText,
	Sparkles,
} from "lucide-react";
import type { MessageCatalog } from "../i18n";
import type { AutoRetryState } from "../chat-types";
import type { SubagentRun } from "../pi";
import { formatClockDuration, formatDuration } from "../format";
import { SPRING_LAYOUT, SPRING_SWAP } from "../lib/ease";
import { cn } from "../lib/utils";
import { AgentDisclosure } from "./agents/agent-disclosure";
import { ThinkingShimmer } from "./agents/loading-states/thinking-shimmer";
import { PreviewTicker, type LivePreviewItem } from "./PreviewTicker";
import {
	summarizeCategories,
	type GroupEntry,
	type ToolCategory,
	type TurnChanges,
} from "./chat-rows";

/**
 * Message-area activity chrome on beUI primitives (direction C): the Percho
 * fold stays one collapsed summary line, but the expanded body is an beUI
 * agent-activity list — status icon + bold tool name + mono target chip +
 * per-row disclosure for args/output. Live states (gap wait, auto-retry,
 * running tool, subagents) share the same card skin with a breathing dot,
 * and the turn footer becomes a centered pill with an inline file list.
 * All motion comes from the vendored beUI ease/spring vocabulary.
 */

/** en plural units (zh templates ignore the {unit} param). */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const fmt = (s: string, params: Record<string, string | number>): string =>
	s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ""));

export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);/** Percho summarizeArgs verbatim: command → filePath/path/file → url; while
 * args stream in as partial JSON, fall back to priority regex extraction. */
export function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
		const url = parsed.url;
		if (typeof url === "string") return url;
	} catch {
		// 流式中的不完整 JSON：按优先级正则抽取字段值（值允许未闭合，随流式增长原地更新）
		for (const key of ["command", "cmd", "filePath", "path", "file", "url"]) {
			const value = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
			if (value) return value;
		}
	}
	const trimmed = args.slice(0, 120);
	return trimmed.length < args.length ? `${trimmed}…` : trimmed;
}

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
	return { kind: "tool", name: displayName(block.name), text };
}

/** beUI StepRow active dot: breathing halo around a solid core. */
export function PulseDot() {
	return (
		<span className="act-pulse" aria-hidden="true">
			<motion.span
				className="act-pulse-halo"
				animate={{ opacity: [0.3, 0.75, 0.3] }}
				transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
			/>
			<span className="act-pulse-core" />
		</span>
	);
}

function StatusIcon({ running, error }: { running: boolean; error?: boolean }) {
	if (error) return <span className="act-dot err" aria-hidden="true" />;
	if (running) return <PulseDot />;
	return (
		<span className="act-status-ok" aria-hidden="true">
			<Check size={12} strokeWidth={2} />
		</span>
	);
}

function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
	return (
		<motion.span
			aria-hidden="true"
			className="act-chev"
			animate={{ rotate: open ? 180 : 0 }}
			transition={SPRING_SWAP}
		>
			<ChevronDown size={size} />
		</motion.span>
	);
}

/** One expanded activity row: a tool call with its attached output. Clicking
 * the row discloses the raw args + output (beUI tool-result behaviour in a
 * row costume). */
export const ToolRow = memo(function ToolRow({
	entry,
	running,
	t,
}: {
	entry: GroupEntry;
	running: boolean;
	t: MessageCatalog;
}) {
	const [open, setOpen] = useState(false);
	const block = entry.block!;
	const error = block.error || entry.result?.error;
	// orphan result（无配对调用的纯结果消息）：args 本身就是输出文本
	const callArgs = block.result ? "" : block.args;
	const output = (block.result ? block.args : (entry.result?.args ?? "")).replace(/\n+$/, "");
	const summary = summarizeArgs(block.args);
	return (
		<div className={cn("act-row", open && "open")}>
			<button
				type="button"
				className="act-row-head"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<StatusIcon running={running} error={error} />
				<span className="act-row-name">{displayName(block.name)}</span>
				{summary && (
					<span className="act-row-target" title={summary}>
						{summary}
					</span>
				)}
				{running && (
					<span className="act-badge running">{t.chat.subagentStatus.running}</span>
				)}
				<Chevron open={open} size={11} />
			</button>
			<AgentDisclosure open={open} className="act-row-detail">
				{callArgs && <pre className="act-pre">{callArgs}</pre>}
				{output && <pre className={cn("act-pre", error && "err")}>{output}</pre>}
			</AgentDisclosure>
		</div>
	);
});

/** One expanded activity row: a thinking block (sparkles trace row, the full
 * text discloses beneath). */
export const ThinkingRow = memo(function ThinkingRow({
	entry,
	t,
}: {
	entry: GroupEntry;
	t: MessageCatalog;
}) {
	const [open, setOpen] = useState(false);
	const text = entry.text ?? "";
	const preview = previewOf(entry).text;
	return (
		<div className={cn("act-row", open && "open")}>
			<button
				type="button"
				className="act-row-head"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="act-status-icon" aria-hidden="true">
					<Sparkles size={13} strokeWidth={1.7} />
				</span>
				<span className="act-row-name">{t.chat.thinking}</span>
				{preview && (
					<span className="act-row-target" title={preview}>
						{preview}
					</span>
				)}
				<Chevron open={open} size={11} />
			</button>
			<AgentDisclosure open={open} className="act-row-detail">
				<div className="act-think">{text}</div>
			</AgentDisclosure>
		</div>
	);
});

function rowKey(e: GroupEntry) {
	return `${e.msgId}:${e.blockIndex}`;
}

/**
 * ActivityCard — the folded work group (replaces MetaGroup). Settled: one
 * category-summary line + "N 步" badge; live: breathing dot + shimmer label
 * + preview ticker. Either state expands to the beUI activity list. A single
 * settled entry renders bare (no card chrome) — same rule as Percho.
 */
export const ActivityCard = memo(
	function ActivityCard({
		entries,
		live,
		t,
	}: {
		entries: GroupEntry[];
		live: boolean;
		t: MessageCatalog;
	}) {
		// The user owns the fold state; the card never auto-expands.
		const [open, setOpen] = useState(false);
		const summary = useMemo(() => summarizeCategories(entries), [entries]);
		const lastEntry = entries[entries.length - 1];
		const preview = useMemo(() => previewOf(lastEntry), [lastEntry]);
		const label = preview.kind === "thinking" && live ? t.chat.metaThinking : t.chat.metaWorking;
		const liveItems = useMemo<LivePreviewItem[]>(
			() =>
				entries.map((e) => {
					const p = previewOf(e);
					return p.kind === "tool"
						? { kind: "tool" as const, id: rowKey(e), name: p.name ?? "", text: p.text }
						: { kind: "thinking" as const, id: rowKey(e), text: p.text };
				}),
			[entries],
		);

		if (entries.length === 1 && !live) {
			const e = entries[0];
			return (
				<div className="act-bare">
					{e.kind === "thinking" ? (
						<ThinkingRow entry={e} t={t} />
					) : (
						<ToolRow entry={e} running={false} t={t} />
					)}
				</div>
			);
		}
		return (
			<div className={cn("act-card", live && "live")}>
				<button
					type="button"
					className="act-head"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
				>
					{live ? (
						<>
							<PulseDot />
							<ThinkingShimmer>{label}</ThinkingShimmer>
							<PreviewTicker items={liveItems} reserveSpace />
						</>
					) : (
						<>
							<span className="act-summary">
								{summary.map((seg, i) => (
									<span key={i} className="act-seg">
										{summaryLabel(t, seg)}
									</span>
								))}
							</span>
							<span className="act-badge">{fmt(t.chat.stepsCount, { n: entries.length })}</span>
						</>
					)}
					<Chevron open={open} />
				</button>
				<AgentDisclosure open={open} className="act-body">
					{entries.map((e) =>
						e.kind === "thinking" ? (
							<ThinkingRow key={rowKey(e)} entry={e} t={t} />
						) : (
							<ToolRow key={rowKey(e)} entry={e} running={live && e.running} t={t} />
						),
					)}
				</AgentDisclosure>
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

/** Live chip shown whenever the run is live but nothing is producing output
 * right now — the submit gap and mid-run LLM waits. Same card skin as the
 * live ActivityCard so the hand-off is seamless. */
export const GapLiveCard = memo(function GapLiveCard({ label }: { label: string }) {
	return (
		<div className="act-card live" role="status" aria-live="polite">
			<div className="act-head" style={{ cursor: "default" }}>
				<PulseDot />
				<ThinkingShimmer>{label}</ThinkingShimmer>
				<PreviewTicker items={[]} reserveSpace />
			</div>
		</div>
	);
});

/** Live card for pi's auto-retry backoff window: attempt counter, countdown
 * and the error preview keep the wait legible instead of dead air. */
export const AutoRetryCard = memo(function AutoRetryCard({
	state,
	t,
}: {
	state: AutoRetryState;
	t: MessageCatalog;
}) {
	const [remainingMs, setRemainingMs] = useState(
		() => Math.max(0, state.delayMs - (Date.now() - state.startedAt)),
	);
	useEffect(() => {
		const tick = () =>
			setRemainingMs(Math.max(0, state.delayMs - (Date.now() - state.startedAt)));
		tick();
		const id = window.setInterval(tick, 500);
		return () => window.clearInterval(id);
	}, [state.delayMs, state.startedAt]);
	return (
		<div className="act-card live auto-retry" role="status" aria-live="polite">
			<div className="act-head" style={{ cursor: "default" }}>
				<PulseDot />
				<ThinkingShimmer>{t.chat.autoRetryWaiting}</ThinkingShimmer>
				{state.maxAttempts > 0 && (
					<span className="act-badge">
						{state.attempt}/{state.maxAttempts}
					</span>
				)}
				{remainingMs > 0 && <span className="act-clock">{formatClockDuration(remainingMs)}</span>}
				{state.errorMessage && (
					<span className="act-row-target" title={state.errorMessage}>
						{state.errorMessage}
					</span>
				)}
			</div>
		</div>
	);
});

/** Compact ticking timer for the live/settled turn pill. */
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
		<span role="timer" className={cn("act-clock", live && "live")}>
			<Clock size={11} strokeWidth={1.8} aria-hidden="true" />
			<span className="tabular-nums">{formatDuration(elapsed)}</span>
		</span>
	);
}

/** Turn footer as a centered pill (replaces the left-aligned TurnDiffRow):
 * timer + file count + +/-; clicking discloses the file list inline, clicking
 * a file opens the diff sidebar. */
export function TurnPill({
	changes,
	startedAt,
	endedAt,
	live,
	liveStart,
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
	const reduce = useReducedMotion() ?? false;
	const timer = (
		<TurnTimer startedAt={startedAt} endedAt={endedAt} live={live} liveStart={liveStart} />
	);
	if (!changes) {
		return (
			<motion.div
				className="turn-pill-row"
				initial={entering && !reduce ? { opacity: 0, y: 6, scale: 0.96 } : false}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				transition={SPRING_LAYOUT}
			>
				<div className="turn-pill">{timer}</div>
			</motion.div>
		);
	}
	const fileCount = changes.files.length;
	return (
		<motion.div
			className={cn("turn-pill-row", live && "live")}
			initial={entering && !reduce ? { opacity: 0, y: 6, scale: 0.96 } : false}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			transition={SPRING_LAYOUT}
		>
			<div
				className="turn-pill clickable"
				role="button"
				tabIndex={0}
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen((v) => !v);
					}
				}}
			>
				{timer}
				<span className="turn-pill-sep" aria-hidden="true">
					·
				</span>
				<span className="turn-pill-title">
					{fmt(t.diff.filesChanged, {
						count: fileCount,
						unit: pluralUnit(fileCount, "file", "files"),
					})}
				</span>
				<span className="act-stat add">+{changes.totalAdded}</span>
				<span className="act-stat del">−{changes.totalRemoved}</span>
				<Chevron open={open} size={11} />
			</div>
			<AgentDisclosure open={open} className="turn-pill-files">
				{changes.files.map((f) => (
					<button
						key={f.path}
						type="button"
						className="turn-pill-file"
						title={f.path}
						onClick={() => {
							setOpen(false);
							onOpenDiff?.();
						}}
					>
						<span className="act-status-icon" aria-hidden="true">
							<FileText size={13} strokeWidth={1.7} />
						</span>
						<span className="act-row-target" title={f.path}>{`\u200e${f.path}`}</span>
						<span className="act-stat add">+{f.added}</span>
						<span className="act-stat del">−{f.removed}</span>
					</button>
				))}
			</AgentDisclosure>
		</motion.div>
	);
}

/** Live panel for in-flight pi-subagent runs, on the activity-card skin:
 * per-step status, latest tool call and turn/tool counts. */
export function SubagentLiveCard({ runs, t }: { runs: SubagentRun[]; t: MessageCatalog }) {
	const statusLabels = t.chat.subagentStatus as Record<string, string>;
	return (
		<div className="act-card live subagent" role="status" aria-live="polite">
			{runs.map((run) => (
				<div className="act-sub-run" key={run.runId}>
					<div className="act-head" style={{ cursor: "default" }}>
						<PulseDot />
						<span className="act-row-name">{t.chat.subagents}</span>
						{run.mode && <span className="act-badge">{run.mode}</span>}
					</div>
					<div className="act-sub-steps">
						{run.steps.map((s, i) => (
							<div className="act-row" key={`${s.label}-${i}`}>
								<StatusIcon running={!s.status || s.status === "running"} error={s.status === "failed"} />
								<span className="act-row-name">
									{s.label || s.agent}
									{s.agent && s.label && s.agent !== s.label ? (
										<span className="act-sub-agent"> ({s.agent})</span>
									) : null}
								</span>
								<span className="act-meta">{statusLabels[s.status] ?? s.status}</span>
								{(s.turnCount > 0 || s.toolCount > 0) && (
									<span className="act-meta">
										{s.turnCount} {t.chat.subagentTurns} · {s.toolCount} {t.chat.subagentTools}
									</span>
								)}
								{s.lastTool && (
									<span className="act-row-target" title={s.lastToolArgs ?? ""}>
										{s.lastTool}
										{s.lastToolArgs ? `: ${s.lastToolArgs}` : ""}
									</span>
								)}
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
