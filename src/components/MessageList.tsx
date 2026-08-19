import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Block, ChatMessage } from "../chat-types";
import type { SubagentRun } from "../pi";
import type { MessageCatalog } from "../i18n";
import {
	BoltIcon,
	BranchIcon,
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	FileIcon,
	FolderOpenIcon,
	SearchIcon,
	SparkleIcon,
	TerminalIcon,
} from "../icons";
import { Markdown } from "./Markdown";
import {
	diffBlocksFromArgs,
	splitOnQuery,
	chatMessageToMarkdown,
	chatMessageToPlainText,
	toolSummary,
	type DiffLine,
} from "./message-utils";

const toolIcon = (name: string, size = 14) => {
	const key = name.toLowerCase();
	if (key.startsWith("bash") || key.startsWith("exec") || key.startsWith("shell"))
		return <TerminalIcon size={size} />;
	if (key.startsWith("read") || key.startsWith("ls") || key.startsWith("find"))
		return <FolderOpenIcon size={size} />;
	if (key.startsWith("write") || key.startsWith("edit")) return <FileIcon size={size} />;
	if (key.startsWith("grep") || key.startsWith("search") || key.startsWith("web"))
		return <SearchIcon size={size} />;
	if (key.includes("apply") || key.includes("patch")) return <BoltIcon size={size} />;
	return <SparkleIcon size={size} />;
};

type ToolBlockT = Extract<Block, { kind: "tool" }>;

/**
 * Read-only / low-signal tools whose result content nobody reads (cd, read,
 * grep, ls, find…). Their output is hidden behind a click instead of
 * occupying the stream with content that only contributes visual noise.
 */
function isQuietTool(name: string): boolean {
	const key = name.toLowerCase();
	return (
		key === "cd" ||
		key.startsWith("read") ||
		key.startsWith("grep") ||
		key.startsWith("ls") ||
		key.startsWith("find") ||
		key === "pwd" ||
		key.startsWith("glob") ||
		key.startsWith("search") ||
		key.startsWith("cat") ||
		key.startsWith("head") ||
		key.startsWith("tail") ||
		key.startsWith("wc") ||
		key.startsWith("tree") ||
		key.startsWith("which") ||
		key.startsWith("where") ||
		key.startsWith("type")
	);
}

/**
 * Tools whose body renders as a structured line diff (not raw io JSON).
 * For these the card waits until the diff is ready and then opens directly
 * onto the final form — no partial-JSON → diff content swap mid-stream.
 */
function isDiffTool(name: string): boolean {
	const key = name.toLowerCase();
	return (
		key === "edit" ||
		key === "write" ||
		key.includes("apply") ||
		key.includes("patch")
	);
}

const DiffView = memo(function DiffView({
	lines,
	label,
}: {
	lines: DiffLine[];
	label?: string;
}) {
	// DSH diff card: code-surface block, optional hunk label banner.
	return (
		<div className="tool-diff">
			{label && <div className="diff-label">{label}</div>}
			<pre>
				{lines.map((l, i) => (
					<span key={i} className={`diff-line ${l.type}`}>
						<span className="diff-sign">
							{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
						</span>
						{l.text}
					</span>
				))}
			</pre>
		</div>
	);
});

const ToolCard = memo(function ToolCard({
	block,
	result,
	running,
	t,
}: {
	block: ToolBlockT;
	/** The call's output — attached from the following tool-result message,
	 * or the block itself when this card renders an orphan result. */
	result?: ToolBlockT | null;
	running: boolean;
	t: MessageCatalog;
}) {
	// Stable streaming model (no open/close flapping): the card opens at
	// most once, never auto-closes, and the expanded content stays put when
	// the run settles — the output the user just watched keeps streaming in
	// place instead of vanishing. Collapsing is always the user's choice.
	const [bodyOpen, setBodyOpen] = useState(false);
	const quiet = useMemo(() => isQuietTool(block.name), [block.name]);
	const diffTool = useMemo(() => isDiffTool(block.name), [block.name]);
	const prettyName = useMemo(
		() =>
			block.name
				.split("_")
				.map((s) => s[0]?.toUpperCase() + s.slice(1))
				.join(" "),
		[block.name],
	);
	// For tool results the body is the tool's output, not call arguments, so
	// skip the argument summary and the "open file" quick action.
	const { filePath, summary } = useMemo(() => {
		if (block.result) return { filePath: null, summary: null };
		let fp: string | null = null;
		try {
			const parsed = JSON.parse(block.args) as { path?: unknown };
			if (typeof parsed.path === "string" && parsed.path.trim()) {
				fp = parsed.path.trim();
			}
		} catch {
			/* args may be partial while streaming */
		}
		return { filePath: fp, summary: toolSummary(block.args) };
	}, [block.args, block.result]);
	const resultLineCount = useMemo(() => {
		if (!result || !quiet) return 0;
		return result.args ? result.args.split("\n").length : 0;
	}, [result, quiet]);
	const error = block.error || result?.error;
	// Edit/write-style calls surface their changes as inline line diffs.
	// The diff depends only on the args being complete: while the call
	// streams, args are partial JSON and parse to null; once toolcall_end
	// lands the args are final and the diff becomes stable — it must NOT
	// reset while the attached result streams afterwards, or the body would
	// swap diff ↔ io cards mid-flight (a visible "refresh").
	const diffBlocks = useMemo(
		() => (block.result ? null : diffBlocksFromArgs(block.args)),
		[block.result, block.args],
	);
	// Open-once rule:
	// - quiet tools (read/grep/ls…) never open on their own — the row's live
	//   line count and shimmer carry the activity, exactly like DSH;
	// - diff tools (edit/write/apply/patch) open when the structured diff is
	//   ready, so the final form appears directly (no JSON → diff swap);
	// - everything else (bash, …) opens when the call starts running and the
	//   output then streams into place.
	useEffect(() => {
		if (quiet || block.result) return;
		if (diffTool) {
			if (diffBlocks && diffBlocks.length > 0) setBodyOpen(true);
			return;
		}
		if (running) setBodyOpen(true);
	}, [quiet, diffTool, running, diffBlocks, block.result]);
	const { diffAdd, diffDel } = useMemo(() => {
		let add = 0;
		let del = 0;
		if (diffBlocks) {
			for (const b of diffBlocks) {
				for (const l of b.lines) {
					if (l.type === "add") add++;
					else if (l.type === "del") del++;
				}
			}
		}
		return { diffAdd: add, diffDel: del };
	}, [diffBlocks]);
	const outputText = result?.args ? result.args.replace(/\n+$/, "") : "";
	// Once a diff tool has revealed its structured diff, the remaining result
	// stream is a trivial acknowledgement — keep the settled card still
	// instead of restarting the running shimmer on it.
	const showRunning =
		running && !(diffTool && diffBlocks !== null && diffBlocks.length > 0);
	// Anchored output follow (DSH's anchored max-height output): while the
	// output streams the section stays pinned to the newest line; scrolling
	// up inside it un-pins, scrolling back to the bottom re-pins.
	const outputSectionRef = useRef<HTMLElement>(null);
	const outputAnchorRef = useRef(true);
	useEffect(() => {
		const el = outputSectionRef.current;
		// `bodyOpen` in the deps re-anchors to the newest line when the card
		// is re-opened mid-stream (the remounted section would otherwise
		// start at the top of the buffer).
		if (el && outputAnchorRef.current) el.scrollTop = el.scrollHeight;
	}, [outputText, bodyOpen]);
	const onOutputScroll = useCallback(() => {
		const el = outputSectionRef.current;
		if (!el) return;
		outputAnchorRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
	}, []);
	return (
		<div
			className={`tool-card${showRunning ? " running" : ""}${block.result ? " result" : ""}${quiet && block.result ? " quiet" : ""}${error ? " error" : ""}${bodyOpen ? " open" : ""}`}
			data-state={showRunning ? "running" : error ? "error" : "ok"}
		>
			<button
				type="button"
				className="tool-head"
				aria-expanded={bodyOpen}
				onClick={() => setBodyOpen((v) => !v)}
			>
				<span className="tool-icon">{toolIcon(block.name)}</span>
				<span className="tool-name">{prettyName || t.chat.tool}</span>
				<span className="tool-sep" />
				{summary && <span className="tool-summary">{summary}</span>}
				{result && (
					<span className="tool-summary-suffix">
						{error
							? t.chat.error
							: quiet
								? resultLineCount > 0
									? t.chat.outputLines.replace("{count}", String(resultLineCount))
									: t.chat.noOutput
								: t.chat.result}
					</span>
				)}
				{diffBlocks && (diffAdd > 0 || diffDel > 0) && (
					<span className="diff-stats">
						{diffDel > 0 && <span className="del">-{diffDel}</span>}
						{diffAdd > 0 && <span className="add">+{diffAdd}</span>}
					</span>
				)}
				<ChevronDownIcon size={12} className={`tool-chevron${bodyOpen ? " open" : ""}`} />
			</button>
			{bodyOpen && (
				<>
					{diffBlocks && diffBlocks.length > 0 ? (
						<div className="tool-diffs">
							{diffBlocks.map((b, i) => (
								<DiffView key={i} lines={b.lines} label={b.label || undefined} />
							))}
						</div>
					) : (
						<div className="tool-io-card">
							{!block.result && (
								<section className="io-section">
									<span className="io-label">{t.chat.ioInput}</span>
									<div className="io-text">
										{block.args.trim() ? block.args : t.chat.noOutput}
									</div>
								</section>
							)}
							{result && !quiet && (
								<>
									{!block.result && <div className="io-divider" />}
									<section
										ref={outputSectionRef}
										className="io-section"
										onScroll={onOutputScroll}
									>
										<span className="io-label">{t.chat.ioOutput}</span>
										<div className="io-text" data-error={error || undefined}>
											{outputText ? outputText : t.chat.noOutput}
										</div>
									</section>
								</>
							)}
							{!block.result && filePath && (
								<div className="tool-file-actions">
									<button onClick={() => void openPath(filePath)}>
										<FileIcon size={12} />
										<span>{filePath}</span>
									</button>
								</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
});

const ThinkingBlock = memo(function ThinkingBlock({
	text,
	streaming,
	t,
}: {
	text: string;
	streaming: boolean;
	t: MessageCatalog;
}) {
	// DSH ReasoningRow verbatim behaviour: the block stays collapsed unless
	// the user opens it. While running, the collapsed summary shows the
	// *latest* line and follows its end; once settled it shows the first
	// line, left-aligned. No auto expand/collapse — the user owns the state.
	const [expanded, setExpanded] = useState(false);
	const summaryRef = useRef<HTMLSpanElement>(null);
	const summary = useMemo(() => {
		const trimmed = text.trimEnd();
		if (streaming) {
			const nl = trimmed.lastIndexOf("\n");
			return nl === -1 ? trimmed : trimmed.slice(nl + 1);
		}
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(0, nl);
	}, [text, streaming]);
	// Frame-throttled follow of the collapsed summary, mirroring DSH's
	// useThrottledVisualUpdate (every 3rd frame): streaming deltas arrive
	// faster than a frame, so coalescing avoids a forced layout per token.
	const pendingFrameRef = useRef<number | null>(null);
	const cancelFollow = useCallback(() => {
		if (pendingFrameRef.current !== null) {
			cancelAnimationFrame(pendingFrameRef.current);
			pendingFrameRef.current = null;
		}
	}, []);
	useEffect(() => cancelFollow, [cancelFollow]);
	useEffect(() => {
		cancelFollow();
		if (streaming) {
			let remaining = 3;
			const advance = () => {
				remaining -= 1;
				if (remaining > 0) {
					pendingFrameRef.current = requestAnimationFrame(advance);
					return;
				}
				pendingFrameRef.current = null;
				const el = summaryRef.current;
				if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
			};
			pendingFrameRef.current = requestAnimationFrame(advance);
		} else {
			const el = summaryRef.current;
			if (el) el.scrollLeft = 0;
		}
	}, [summary, streaming, cancelFollow]);
	return (
		<div
			className={`think-card${streaming ? " running" : ""}`}
			data-state={streaming ? "running" : "ok"}
		>
			<button
				type="button"
				className="think-head"
				aria-expanded={expanded}
				onClick={() => setExpanded((v) => !v)}
			>
				<ChevronDownIcon size={12} className={`think-chevron${expanded ? " open" : ""}`} />
				<SparkleIcon size={14} className="think-icon" />
				<span className="think-title">{t.chat.thinking}</span>
				{!expanded && (
					<>
						<span className="think-sep" />
						<span
							ref={summaryRef}
							className={`think-summary${streaming ? " follow-end" : ""}`}
						>
							{summary}
						</span>
					</>
				)}
			</button>
			{expanded && <div className="think-body">{text}</div>}
		</div>
	);
});

function AssistantFooter({ message, t }: { message: ChatMessage; t: MessageCatalog }) {
	return (
		<div className="assistant-footer">
			<span className="assistant-name">Pi</span>
			{message.replay && <span className="replay-badge">{t.chat.history}</span>}
		</div>
	);
}

function formatTime(ts?: string): string | null {
	if (!ts) return null;
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Compact elapsed duration for the live "working…" status: `42s`, `1:05`. */
function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

/**
 * Turn-level activity label shown while the model is working — covering the
 * pre-first-token wait and the streaming phases alike — rendered at the end
 * of the chat column (port of DSH's ChatView TurnStatus pattern). Plain
 * content-font styling; an elapsed clock appears after 15s and counts from
 * the turn start, retained across the thinking / tool / text phases.
 */
export function TurnStatus({ startTime }: { startTime: number }) {
	const [mountedAt] = useState(() => Date.now());
	const anchor = startTime ?? mountedAt;
	const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor));
	useEffect(() => {
		const tick = () => setElapsedMs(Math.max(0, Date.now() - anchor));
		tick();
		const id = window.setInterval(tick, 1000);
		return () => window.clearInterval(id);
	}, [anchor]);
	const showClock = elapsedMs >= 15_000;
	return (
		<div className="turn-status" role="status" aria-live="polite">
			Working...
			{showClock && (
				<span className="turn-status-clock" aria-hidden="true">
					{formatDuration(elapsedMs)}
				</span>
			)}
		</div>
	);
}

/**
 * Live panel for in-flight pi-subagents runs (the extension publishes run
 * state to status.json; the backend polls it). Rendered at the end of the
 * chat column so the user can see what a detached/background subagent is
 * doing — per-step status, latest tool call and turn/tool counts — instead
 * of staring at a static "running" tool card for minutes.
 */
export function SubagentLivePanel({
	runs,
	t,
}: {
	runs: SubagentRun[];
	t: MessageCatalog;
}) {
	const statusLabels = t.chat.subagentStatus as Record<string, string>;
	return (
		<div className="subagent-live" role="status" aria-live="polite">
			{runs.map((run) => (
				<div className="subagent-run" key={run.runId}>
					<div className="subagent-run-head">
						<SparkleIcon size={12} />
						<span className="subagent-run-title">{t.chat.subagents}</span>
						{run.mode && <span className="subagent-run-mode">{run.mode}</span>}
					</div>
					{run.steps.map((s, i) => (
						<div className="subagent-step" key={`${s.label}-${i}`}>
							<span className={`subagent-dot ${s.status || "running"}`} />
							<span className="subagent-step-label">
								{s.label || s.agent}
								{s.agent && s.label && s.agent !== s.label ? (
									<span className="subagent-step-agent"> ({s.agent})</span>
								) : null}
							</span>
							<span className="subagent-step-status">
								{statusLabels[s.status] ?? s.status}
							</span>
							{(s.turnCount > 0 || s.toolCount > 0) && (
								<span className="subagent-step-counts">
									{s.turnCount} {t.chat.subagentTurns} · {s.toolCount}{" "}
									{t.chat.subagentTools}
								</span>
							)}
							{s.lastTool && (
								<span className="subagent-step-activity" title={s.lastToolArgs ?? ""}>
									{s.lastTool}
									{s.lastToolArgs ? `: ${s.lastToolArgs}` : ""}
								</span>
							)}
						</div>
					))}
				</div>
			))}
		</div>
	);
}

export const MessageList = memo(function MessageList({
	messages,
	streaming,
	autoScroll,
	onFork,
	t,
	searchQuery,
	searchActiveMessageId,
}: {
	messages: ChatMessage[];
	streaming: boolean;
	autoScroll?: boolean;
	onFork?: (entryId: string) => void;
	t: MessageCatalog;
	searchQuery?: string;
	searchActiveMessageId?: number | null;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const msgElsRef = useRef(new Map<number, HTMLDivElement>());
	const [copiedId, setCopiedId] = useState<string | null>(null);
	// Start "stuck" so the view lands at the latest message when a session
	// (or history) is loaded; only the user's own scrolling can unstick it.
	const stickRef = useRef(true);
	const copyTimerRef = useRef<number>(0);

	// The ref element (`.messages`) grows with content; the actual scroll
	// container is its parent `.chat-scroll`, so scroll that instead.
	const follow = useCallback(() => {
		if (autoScroll === false) return;
		const el = scrollRef.current;
		const scroller = el?.parentElement;
		if (!el || !scroller) return;
		if (stickRef.current) {
			scroller.scrollTop = scroller.scrollHeight;
		}
	}, [autoScroll]);

	// Follow growth driven by React state (streaming deltas, message end,
	// history load…).
	useEffect(() => {
		follow();
	}, [messages, streaming, autoScroll, follow]);

	// Also follow growth that never re-renders: async content (images, fonts),
	// the working-status row, window resizes.  Both observers are coalesced
	// into a single rAF so that a burst of mutations (e.g. streaming text
	// deltas re-rendering many nodes) produces at most one follow() per frame
	// instead of dozens of forced reflows.
	useEffect(() => {
		const el = scrollRef.current;
		const scroller = el?.parentElement;
		if (!el || !scroller) return;
		let rafId: number | null = null;
		const throttledFollow = () => {
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				follow();
			});
		};
		const resizeObserver = new ResizeObserver(throttledFollow);
		resizeObserver.observe(el);
		resizeObserver.observe(scroller);
		// childList only (no subtree) so the observer fires when direct
		// children are added/removed (e.g. the working-status row) but NOT
		// on every text-node mutation deep inside the streaming markdown.
		const mutationObserver = new MutationObserver(throttledFollow);
		mutationObserver.observe(scroller, { childList: true });
		// User intent: scrolling away unsticks, scrolling back to the bottom
		// re-sticks.
		//
		// Scroll events alone must NOT unstick: follow() scrolls are echoed
		// back as scroll events, and Blink coalesces and dispatches those
		// echoes asynchronously — by the time one arrives the streamed
		// content has usually grown further, so the distance check compares
		// the stale scrollTop against the grown scrollHeight and mistakes
		// the echo for the user scrolling away, killing the follow mid-run.
		// Unstick synchronously from real input (wheel up, touch drag down,
		// scrollbar grab, scroll keys) instead; scroll events only re-stick
		// when the view is back at the bottom.
		const STICK_MARGIN = 120;
		const onScroll = () => {
			if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_MARGIN) {
				stickRef.current = true;
			}
		};
		// Whether a wheel/touch interaction over `target` would actually move
		// the chat scroller, or is consumed by a nested scrollable (expanded
		// tool outputs, code blocks) and must not be read as chat scrolling.
		const chatWillScroll = (target: EventTarget | null): boolean => {
			let node = target instanceof Element ? target : null;
			while (node && node !== scroller) {
				const style = getComputedStyle(node);
				if (
					/(auto|scroll|overlay)/.test(style.overflowY) &&
					node.scrollHeight > node.clientHeight
				) {
					return false;
				}
				node = node.parentElement;
			}
			return true;
		};
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY < 0 && scroller.scrollTop > 0 && chatWillScroll(e.target)) {
				stickRef.current = false;
			}
		};
		let touchStartTarget: EventTarget | null = null;
		let touchStartY: number | null = null;
		const onTouchStart = (e: TouchEvent) => {
			touchStartTarget = e.touches[0]?.target ?? null;
			touchStartY = e.touches[0]?.clientY ?? null;
		};
		const onTouchMove = (e: TouchEvent) => {
			const y = e.touches[0]?.clientY;
			// Finger dragging down reveals older content (scrollTop shrinks).
			if (
				touchStartY !== null &&
				y !== undefined &&
				y - touchStartY > 4 &&
				scroller.scrollTop > 0 &&
				chatWillScroll(touchStartTarget)
			) {
				stickRef.current = false;
			}
		};
		const onPointerDown = (e: PointerEvent) => {
			// Grabbing the vertical scrollbar (custom 9px thumb) is user
			// scrolling that never produces a wheel/touch signal.
			if (e.button !== 0 || scroller.scrollTop <= 0) return;
			const rect = scroller.getBoundingClientRect();
			if (e.clientX >= rect.right - 12) stickRef.current = false;
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (
				(e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") &&
				scroller.scrollTop > 0
			) {
				stickRef.current = false;
			}
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		scroller.addEventListener("wheel", onWheel, { passive: true });
		scroller.addEventListener("touchstart", onTouchStart, { passive: true });
		scroller.addEventListener("touchmove", onTouchMove, { passive: true });
		scroller.addEventListener("pointerdown", onPointerDown);
		scroller.addEventListener("keydown", onKeyDown);
		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			scroller.removeEventListener("scroll", onScroll);
			scroller.removeEventListener("wheel", onWheel);
			scroller.removeEventListener("touchstart", onTouchStart);
			scroller.removeEventListener("touchmove", onTouchMove);
			scroller.removeEventListener("pointerdown", onPointerDown);
			scroller.removeEventListener("keydown", onKeyDown);
		};
	}, [follow]);

	// Attach each tool-result message to the tool call that produced it, so a
	// call and its output render as one card instead of two disconnected
	// strips. Results arrive after the calls, in order; a new assistant
	// message means earlier calls can no longer produce results.
	const items = useMemo(() => {
		const list: {
			msg: ChatMessage;
			attached: Map<number, ToolBlockT>;
			/** Whether the tool-result message feeding this slot is streaming. */
			attachedStreaming: Map<number, boolean>;
			consumed: Set<number>;
		}[] = [];
		let pending: { item: (typeof list)[number]; index: number }[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") pending = [];
			const item = {
				msg,
				attached: new Map<number, ToolBlockT>(),
				attachedStreaming: new Map<number, boolean>(),
				consumed: new Set<number>(),
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
	}, [messages]);

	const copyMessage = useCallback(async (m: ChatMessage, mode: "md" | "text") => {
		const content = mode === "md" ? chatMessageToMarkdown(m) : chatMessageToPlainText(m);
		if (!content) return;
		const key = `${m.id}-${mode}`;
		try {
			await navigator.clipboard.writeText(content);
			setCopiedId(key);
			window.clearTimeout(copyTimerRef.current);
			copyTimerRef.current = window.setTimeout(() => {
				setCopiedId((cur) => (cur === key ? null : cur));
			}, 1200);
		} catch {
			/* clipboard unavailable */
		}
	}, []);

	// Clear the copied-indicator timer on unmount.
	useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

	// Scroll the active search hit into view within the chat scroller (its
	// parent `.chat-scroll`), not via scrollIntoView (which can also scroll
	// ancestor containers). Jumping to a hit is explicit user intent: stop
	// following so the stream can't yank the view back down (scroll events
	// are no longer treated as user scrolling — see the observer effect).
	useEffect(() => {
		if (searchActiveMessageId == null) return;
		const el = msgElsRef.current.get(searchActiveMessageId);
		const scroller = scrollRef.current?.parentElement;
		if (el && scroller) {
			stickRef.current = false;
			const elRect = el.getBoundingClientRect();
			const scrollerRect = scroller.getBoundingClientRect();
			const top =
				scroller.scrollTop +
				(elRect.top - scrollerRect.top) -
				(scrollerRect.height - elRect.height) / 2;
			scroller.scrollTo({ top, behavior: "smooth" });
		}
	}, [searchActiveMessageId]);

	return (
		<div ref={scrollRef} className="messages">
			{items.map(({ msg: m, attached, attachedStreaming, consumed }) => {
				const time = m.role === "user" ? formatTime(m.timestamp) : null;
				const isSearchTarget =
					searchQuery != null && searchActiveMessageId != null && m.id === searchActiveMessageId;
				return (
					<div
						key={m.id}
						ref={(el) => {
							if (el) msgElsRef.current.set(m.id, el);
							else msgElsRef.current.delete(m.id);
						}}
						className={`message ${m.role}${isSearchTarget ? " message-search-target" : ""}`}
					>
						{m.role === "assistant" && <AssistantFooter message={m} t={t} />}
						{(m.role === "assistant" || (m.role === "user" && onFork && m.entryId)) && (
							<div className="message-hover-actions">
								{m.role === "user" && onFork && m.entryId && (
									<button
										className="fork-btn"
										title={t.chat.branch}
										onClick={() => onFork(m.entryId as string)}
									>
										<BranchIcon size={12} />
									</button>
								)}
								<button
									className="fork-btn"
									title={t.chat.copy}
									onClick={() => void copyMessage(m, "md")}
								>
									{copiedId === `${m.id}-md` ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
								</button>
								<button
									className="fork-btn"
									title={t.chat.copyPlainText}
									onClick={() => void copyMessage(m, "text")}
								>
									{copiedId === `${m.id}-text` ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
								</button>
							</div>
						)}
						{m.blocks.map((b, i) => {
							if (consumed.has(i)) return null;
							if (b.kind === "text") {
								if (m.role === "tool") {
									// Tool result text streaming in. Nobody reads
									// this mid-stream — the assistant's running
									// tool card already shows the state. Keep the
									// message empty (only the cursor) until the
									// authoritative ToolOutput replaces it, so the
									// DOM doesn't grow and reflow every frame.
									// Exception: in-session search highlights the
									// content the user is actively looking for.
									if (isSearchTarget && searchQuery) {
										return (
											<div className="text-block highlighted-text" key={i}>
												{splitOnQuery(b.text, searchQuery).map((p, j) =>
													p.match ? (
														<mark key={j} className="session-search-hit">
															{p.text}
														</mark>
													) : (
														<span key={j}>{p.text}</span>
													),
												)}
											</div>
										);
									}
									return null;
								}
								if (isSearchTarget && searchQuery) {
									// Plain-text rendering with highlighted matches for
									// the focused message (markdown stays on elsewhere).
									return (
										<div className="text-block highlighted-text" key={i}>
											{splitOnQuery(b.text, searchQuery).map((p, j) =>
												p.match ? (
													<mark key={j} className="session-search-hit">
														{p.text}
													</mark>
												) : (
													<span key={j}>{p.text}</span>
												),
											)}
										</div>
									);
								}
								return (
									<div className="text-block" key={i}>
										<Markdown text={b.text} streaming={m.streaming} />
									</div>
								);
							}
							if (b.kind === "thinking") {
								if (isSearchTarget && searchQuery) {
									// Highlight matches inside thinking blocks too, so a
									// hit there is visible (not just counted).
									return (
										<div className="text-block thinking highlighted-text" key={i}>
											{splitOnQuery(b.text, searchQuery).map((p, j) =>
												p.match ? (
													<mark key={j} className="session-search-hit">
														{p.text}
													</mark>
												) : (
													<span key={j}>{p.text}</span>
												),
											)}
										</div>
									);
								}
								return <ThinkingBlock key={i} text={b.text} streaming={m.streaming} t={t} />;
							}
							return (
								<ToolCard
									key={i}
									block={b}
									result={b.result ? b : (attached.get(i) ?? null)}
									running={
										(m.streaming && i === m.blocks.length - 1) ||
										(attachedStreaming.get(i) ?? false)
									}
									t={t}
								/>
							);
						})}
						{m.error && <div className="msg-error">error: {m.error}</div>}
						{m.streaming && <span className="cursor" />}
						{time && <div className="message-meta">{time}</div>}
					</div>
				);
			})}
		</div>
	);
});
