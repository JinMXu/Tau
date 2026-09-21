import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AutoRetryState, Block, ChatMessage } from "../chat-types";
import type { SubagentRun } from "../pi";
import type { MessageCatalog } from "../i18n";
import { BranchIcon, CheckIcon, CopyIcon, SparkleIcon, UndoIcon } from "../icons";
import { Button } from "./motion/button";
import { MessageBoundary } from "./MessageBoundary";
import { ErrorNote } from "./ErrorNote";
import { formatClockDuration } from "../format";
import { splitOnQuery } from "./message-utils";
import { ToolCard, ThinkingBlock } from "./ToolCard";
import { MetaGroup, TurnDiffRow } from "./MetaGroup";
import { ThinkingOrb } from "thinking-orbs";
import { PreviewTicker } from "./PreviewTicker";
import {
	attachWithPending,
	buildChatRows,
	deriveTurnChanges,
	deriveTurnTimings,
	extendAttachPass,
	searchBypassIds,
	type ChatRow,
	type MessageItem,
	type TurnChanges,
} from "./chat-rows";
import { Markdown } from "./Markdown";

/**
 * Chat transcript renderer. Messages are folded into rows (see chat-rows.ts):
 * assistant thinking/tool calls collapse into MetaGroup lines, turns close
 * with a timer + file-changes footer row, text stays as regular message rows.
 * All the scroll-follow / search / copy machinery is unchanged.
 */

/**
 * working→done hysteresis (percho useShownWorking): the live signal lingers
 * for HYSTERESIS_MS after `working` drops so turn/tool gaps don't flicker
 * the group shell; `endImmediately` (final-answer text streaming) flips it
 * right away. `resetKey` change (session switch) resets instantly without
 * leaking the previous session's pending timer.
 */
const HYSTERESIS_MS = 1500;

function useShownWorking(working: boolean, endImmediately: boolean, resetKey?: number): boolean {
	const [shown, setShown] = useState(working);
	const timerRef = useRef<number | null>(null);
	const prevKeyRef = useRef<number | undefined>(resetKey);
	useEffect(() => {
		if (prevKeyRef.current !== resetKey) {
			prevKeyRef.current = resetKey;
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShown(working);
			return;
		}
		if (working) {
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShown(true);
		} else if (shown) {
			if (endImmediately) {
				setShown(false);
				return;
			}
			if (timerRef.current === null) {
				timerRef.current = window.setTimeout(() => {
					timerRef.current = null;
					setShown(false);
				}, HYSTERESIS_MS);
			}
		}
	}, [working, endImmediately, shown, resetKey]);
	// Clear the pending timer on unmount.
	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);
	return shown;
}

/**
 * Live panel for in-flight pi-subagents runs (the extension publishes run
 * state to status.json; the backend polls it). Rendered at the end of the
 * chat column so the user can see what a detached/background subagent is
 * doing — per-step status, latest tool call and turn/tool counts — instead
 * of staring at a static "running" tool card for minutes.
 */
export function SubagentLivePanel({ runs, t }: { runs: SubagentRun[]; t: MessageCatalog }) {
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
							<span className="subagent-step-status">{statusLabels[s.status] ?? s.status}</span>
							{(s.turnCount > 0 || s.toolCount > 0) && (
								<span className="subagent-step-counts">
									{s.turnCount} {t.chat.subagentTurns} · {s.toolCount} {t.chat.subagentTools}
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

type MessageImage = { mimeType: string; data: string };

const imageSrc = (img: MessageImage) => `data:${img.mimeType};base64,${img.data}`;

/** Percho UserMessage image grid: 1 = contain (144/192px), <=3 = 96px
 * squares, <=6 = 80px, else 64px; click opens the fullscreen overlay. */
function MessageImages({ images, t }: { images: MessageImage[]; t: MessageCatalog }) {
	const [preview, setPreview] = useState<number | null>(null);
	const count = images.length;
	const sizeCls =
		count === 1
			? "msg-img single"
			: count <= 3
				? "msg-img md"
				: count <= 6
					? "msg-img sm"
					: "msg-img xs";
	useEffect(() => {
		if (preview === null) return;
		const onKey = (e: KeyboardEvent) => {
			// Consume the event at document level so it never reaches App's
			// window-level Escape handler — that one aborts the running turn,
			// and closing the preview must not kill the agent's output.
			e.stopPropagation();
			if (e.key === "Escape") setPreview(null);
			if (e.key === "ArrowRight") setPreview((v) => (v === null ? v : (v + 1) % images.length));
			if (e.key === "ArrowLeft")
				setPreview((v) => (v === null ? v : (v - 1 + images.length) % images.length));
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [preview, images.length]);
	return (
		<>
			<div className="msg-images">
				{images.map((img, i) => (
					<button
						key={i}
						type="button"
						className="msg-img-btn"
						aria-label={t.chat.imageIndex
							.replace("{n}", String(i + 1))
							.replace("{total}", String(count))}
						onClick={() => setPreview(i)}
					>
						{/* biome-ignore lint/suspicious/noArrayIndexKey: image list is immutable */}
						<img src={imageSrc(img)} alt="" className={sizeCls} />
					</button>
				))}
			</div>
			{preview !== null && (
				<div
					className="img-overlay"
					onClick={() => setPreview(null)}
					role="dialog"
					aria-modal="true"
					aria-label={t.chat.imagePreview}
				>
					<img src={imageSrc(images[preview])} alt="" />
					{count > 1 && (
						<span className="img-overlay-count">
							{preview + 1} / {count}
						</span>
					)}
				</div>
			)}
		</>
	);
}

function messageText(m: ChatMessage): string {
	return m.blocks
		.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
		.map((b) => b.text)
		.join("\n\n")
		.trim();
}

function MessageActions({
	text,
	canRecall,
	canFork,
	onCopy,
	onRecall,
	onFork,
	t,
}: {
	text: string;
	canRecall: boolean;
	canFork: boolean;
	onCopy?: (text: string) => void;
	onRecall?: () => void;
	onFork?: () => void;
	t: MessageCatalog;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);
	if (!text || (!canRecall && !canFork)) return null;
	const copy = () => {
		if (!text) return;
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				if (timerRef.current !== null) window.clearTimeout(timerRef.current);
				timerRef.current = window.setTimeout(() => setCopied(false), 1200);
			})
			.catch(() => {});
		onCopy?.(text);
	};
	return (
		<div className="message-actions">
			{text && (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="message-action size-7 rounded-[var(--r-sm)]"
					aria-label={copied ? t.chat.copied : t.chat.copyText}
					title={copied ? t.chat.copied : t.chat.copyText}
					onClick={copy}
				>
					{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
				</Button>
			)}
			{canFork && (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="message-action size-7 rounded-[var(--r-sm)]"
					aria-label={t.chat.fork}
					title={t.chat.fork}
					onClick={() => onFork?.()}
				>
					<BranchIcon size={14} />
				</Button>
			)}
			{canRecall && (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="message-action size-7 rounded-[var(--r-sm)]"
					aria-label={t.chat.recall}
					title={t.chat.recall}
					onClick={() => onRecall?.()}
				>
					<UndoIcon size={14} />
				</Button>
			)}
		</div>
	);
}

/** One message row (user / assistant text / orphan tool results) with search
 * highlighting and the streaming cursor. `skip` lists block indices folded
 * into a meta group. Layout is beui's Message: the user turn renders as a
 * tinted end-aligned bubble, assistant/tool turns stay an open transcript
 * column — matching the beui chat design. */
const MessageRow = memo(function MessageRow({
	item,
	skip,
	textAllow,
	last,
	t,
	searchQuery,
	searchActiveMessageId,
	refCb,
	onCopy,
	onRecall,
	canRecall,
	canFork,
	onFork,
	onRetry,
	onCompact,
	onOpenSettings,
}: {
	item: MessageItem;
	skip: Set<number>;
	/** When the message was split into text segments, only these text blocks
	 * render on this row. */
	textAllow?: Set<number>;
	/** The message's final row: carries the streaming cursor and error. */
	last: boolean;
	t: MessageCatalog;
	searchQuery?: string;
	searchActiveMessageId?: number | null;
	refCb: (id: number, el: HTMLDivElement | null) => void;
	onCopy?: (text: string) => void;
	onRecall?: (msg: ChatMessage) => void;
	canRecall: boolean;
	canFork: boolean;
	/** Take the message so the row can build a stable handler internally (see
	 *  the useCallbacks below) instead of receiving a fresh arrow per render. */
	onFork?: (msg: ChatMessage) => void;
	onRetry?: (msg: ChatMessage) => void;
	onCompact?: () => void;
	onOpenSettings?: () => void;
}) {
	const m = item.msg;
	const isSearchTarget =
		searchQuery != null && searchActiveMessageId != null && m.id === searchActiveMessageId;
	const highlight = (text: string) =>
		splitOnQuery(text, searchQuery ?? "").map((p, j) =>
			p.match ? (
				<mark key={j} className="session-search-hit">
					{p.text}
				</mark>
			) : (
				<span key={j}>{p.text}</span>
			),
		);

	// Handlers are built here, from the stable callback props, rather than as
	// inline arrows at the call site: `m` keeps its identity while a stream runs
	// (App only ever replaces the in-flight message), so these stay referentially
	// stable for committed rows and MessageRow's memo actually hits. Inline
	// arrows in MessageList gave every row a new onRecall/onFork/onRetry identity
	// on each frame, re-rendering the whole transcript per token.
	const handleRecall = useCallback(() => onRecall?.(m), [onRecall, m]);
	const handleFork = useCallback(() => onFork?.(m), [onFork, m]);
	const handleRetry = useCallback(() => onRetry?.(m), [onRetry, m]);

	const blocks = m.blocks.map((b: Block, i: number) => {
		if (item.consumed.has(i) || skip.has(i)) return null;
		if (b.kind === "text") {
			if (textAllow && !textAllow.has(i)) return null;
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
							{highlight(b.text)}
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
						{highlight(b.text)}
					</div>
				);
			}
			return (
				<div className="text-block" key={i}>
					{/* Percho UserMessage: user input is always plain text
						    (whitespace-pre-wrap) - no markdown pass. */}
					{m.role === "user" ? (
						<div className="whitespace-pre-wrap">{b.text}</div>
					) : (
						<Markdown text={b.text} streaming={m.streaming} />
					)}
				</div>
			);
		}
		if (b.kind === "thinking") {
			if (isSearchTarget && searchQuery) {
				// Highlight matches inside thinking blocks too, so a
				// hit there is visible (not just counted).
				return (
					<div className="text-block thinking highlighted-text" key={i}>
						{highlight(b.text)}
					</div>
				);
			}
			return <ThinkingBlock key={i} text={b.text} t={t} />;
		}
		return (
			<ToolCard
				key={i}
				block={b}
				result={b.result ? b : (item.attached.get(i) ?? null)}
				running={
					(m.streaming && i === m.blocks.length - 1) || (item.attachedStreaming.get(i) ?? false)
				}
				t={t}
			/>
		);
	});

	const actions =
		last && !m.streaming && (m.role === "user" || canFork) ? (
			<MessageActions
				text={messageText(m)}
				canRecall={m.role === "user" && canRecall}
				canFork={canFork}
				onCopy={onCopy}
				onRecall={handleRecall}
				onFork={handleFork}
				t={t}
			/>
		) : null;

	return (
		// A throw inside one message's renderer (markstream / shiki / mermaid run
		// on every streamed delta) must not take the whole app down — the root
		// boundary would unmount the tree and lose the transcript. The boundary
		// renders its children directly, so this adds no DOM node.
		<MessageBoundary text={() => messageText(m)} t={t}>
			{/* Plain elements, not beui's Message/MessageBubble: those are motion
			    components whose layout measurement rewrites style attributes on
			    every streaming re-render of the list — the transcript's perf
			    contract (stream mutations never touch committed rows' DOM, guarded
			    by stream-split.test) forbids that. The existing .message.user CSS
			    already renders the tinted end-aligned user bubble. */}
			<div
				ref={(el) => refCb(m.id, el)}
				className={`message ${m.role}${isSearchTarget ? " message-search-target" : ""}`}
			>
				{m.role === "user" && m.images && m.images.length > 0 && (
					<MessageImages images={m.images} t={t} />
				)}
				{blocks}
				{actions}
				{/* Error cards render on ANY role that carries one: the assistant
				    (LLM failure), the user message (send failure) and the bash tool
				    message (direct-command failure). onRetry resends the turn's
				    user text in every case (retryTextFor). */}
				{last && m.error && typeof m.error !== "string" && (
					<ErrorNote
						error={m.error}
						t={t}
						onRetry={handleRetry}
						onCompact={onCompact}
						onOpenSettings={onOpenSettings}
					/>
				)}
				{last && typeof m.error === "string" && <div className="msg-error">error: {m.error}</div>}
			</div>
		</MessageBoundary>
	);
});

// ---------------------------------------------------------------------------
// Row windowing (virtualization)
// ---------------------------------------------------------------------------

/** Below this row count the list renders exactly as a plain map: no spacers, no
 *  measurement, no window state. Typical sessions never pay for this. */
const VIRTUALIZE_THRESHOLD = 150;
/** Height assumed for a row that has not been measured yet. */
const ROW_ESTIMATE_PX = 140;
/** Rows kept rendered above and below the viewport. */
const OVERSCAN = 6;
/** Rows rendered before the first measurement/scroll lands (a session load
 *  always starts at the bottom, so the tail is the right first view). */
const INITIAL_ROWS = 60;

interface RowWindow {
	start: number;
	end: number;
	/** Height of the rows above the window (top spacer). */
	topPad: number;
	/** Height of the rows below the window (bottom spacer). */
	bottomPad: number;
}

/** Live chip shown whenever the run is live but nothing is producing output * right now — the submit gap (first-token wait) and mid-run LLM waits / long
 * tool executions that used to read as dead air. Same visual as MetaGroup's
 * live header, so the hand-off is seamless. Announced politely (like the
 * auto-retry / subagent panels) so the first-token wait isn't silent for
 * screen readers. */
const GapLiveChip = memo(function GapLiveChip({ label }: { label: string }) {
	return (
		<div className="meta-group live" role="status" aria-live="polite">
			<div className="meta-head" style={{ cursor: "default" }}>
				<ThinkingOrb state="working" size={20} paused={false} />
				<span className="meta-label">{label}</span>
				<span className="meta-preview">
					<PreviewTicker items={[]} reserveSpace />
				</span>
			</div>
		</div>
	);
});

/** Live chip for pi's auto-retry backoff window: the LLM request failed with
 * a retryable error (timeout / overloaded / unresponsive provider), the run
 * ended with agent_end(willRetry) and reopens after an exponential backoff.
 * `working` stays true through the window (no idle teardown, no copy/fork
 * buttons); this chip keeps the wait legible — orb + attempt + countdown +
 * error preview — instead of dead air that reads as the conversation having
 * ended, only for output to "resume by itself" seconds later. */
const AutoRetryChip = memo(function AutoRetryChip({
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
		<div className="meta-group live auto-retry" role="status" aria-live="polite">
			<div className="meta-head" style={{ cursor: "default" }}>
				<ThinkingOrb state="working" size={20} paused={false} />
				<span className="meta-label">{t.chat.autoRetryWaiting}</span>
				{state.maxAttempts > 0 && (
					<span className="auto-retry-count">
						{state.attempt}/{state.maxAttempts}
					</span>
				)}
				{remainingMs > 0 && (
					<span className="auto-retry-clock" aria-hidden="true">
						{formatClockDuration(remainingMs)}
					</span>
				)}
				{state.errorMessage && (
					<span className="meta-preview auto-retry-error" title={state.errorMessage}>
						{state.errorMessage}
					</span>
				)}
			</div>
		</div>
	);
});

export const MessageList = memo(function MessageList({
	messages,
	stream,
	streaming,
	working,
	autoRetry,
	textStreaming,
	autoScroll,
	t,
	searchQuery,
	searchActiveMessageId,
	turnStartTime,
	turnChanges,
	onOpenDiff,
	onCopyMessage,
	onRecallMessage,
	onForkMessage,
	onRetryMessage,
	onCompact,
	onOpenSettings,
}: {
	messages: ChatMessage[];
	/** The in-flight pi message (kept out of `messages`; see App.tsx). */
	stream: ChatMessage | null;
	streaming: boolean;
	/** Whether the agent is mid-run (drives live group / live turn flags). */
	working: boolean;
	/** pi auto-retry backoff window (null when the run is not retrying). */
	autoRetry?: AutoRetryState | null;
	/** Whether assistant TEXT is streaming right now (percho streaming.text):
	 * ends the live group immediately when the final answer starts. */
	textStreaming?: boolean;
	autoScroll?: boolean;
	t: MessageCatalog;
	searchQuery?: string;
	searchActiveMessageId?: number | null;
	/** Live turn anchor (Date.now at submit) for the ticking footer timer. */
	turnStartTime?: number | null;
	/** Shared per-turn changes (same source as the diff sidebar). */
	turnChanges?: TurnChanges[];
	/** Open the diff sidebar (turn footer file rows / chips). */
	onOpenDiff?: () => void;
	/** Copy a message's plain text to the system clipboard. */
	onCopyMessage?: (text: string) => void;
	/** Recall (delete) a specific user message and put its text back into the composer. */
	onRecallMessage?: (msg: ChatMessage) => void;
	/** Fork a new session ending at the given assistant message. */
	onForkMessage?: (msg: ChatMessage) => void;
	/** Retry (resend) the user message that preceded a failed turn. */
	onRetryMessage?: (msg: ChatMessage) => void;
	onCompact?: () => void;
	onOpenSettings?: () => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const msgElsRef = useRef(new Map<number, HTMLDivElement>());
	// ---- row windowing state ----
	/** Measured height per row key. Only rows that have been on screen are in
	 *  here; everything else uses ROW_ESTIMATE_PX. */
	const heightsRef = useRef(new Map<string, number>());
	const [rowWindow, setRowWindow] = useState<RowWindow | null>(null);
	/** offsets[window.start] as of the last commit — used to keep the viewport
	 *  anchored when corrected heights shift the rows above the window. */
	const prevTopRef = useRef<number | null>(null);
	/**
	 * What the transcript renders: the committed messages plus the in-flight
	 * one. App keeps the two apart so `messages` (and therefore every item,
	 * row and memo downstream) stays identity-stable while tokens stream; the
	 * in-flight message is appended here, at the last moment, exactly like
	 * percho's buildChatRows folds its StreamingState container in.
	 */
	const all = useMemo(() => (stream ? [...messages, stream] : messages), [messages, stream]);
	// working→done hysteresis (percho useShownWorking): keep the live group
	// (orb + label + dots) through turn/tool gaps so it never flickers; end
	// immediately once the final answer text starts streaming. Switching
	// sessions resets instantly (first message id changes).
	const shownWorking = useShownWorking(working, textStreaming ?? false, all[0]?.id);
	// Start "stuck" so the view lands at the latest message when a session
	// (or history) is loaded; only the user's own scrolling can unstick it.
	const stickRef = useRef(true);

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
	}, [all, streaming, autoScroll, follow]);

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

	const refCb = useCallback((id: number, el: HTMLDivElement | null) => {
		if (el) msgElsRef.current.set(id, el);
		else msgElsRef.current.delete(id);
	}, []);

	// ---- row derivation ----
	// The committed transcript is identity-stable for the whole run (App keeps
	// the in-flight message in `stream`), so the prefix pass is memoized on it
	// and reused on every streamed frame; only the tail message is re-folded.
	// A fresh attachToolResults(all) allocated new MessageItems for the whole
	// transcript per delta, which gave every row new prop identities and made
	// MessageRow's memo useless.
	const committedPass = useMemo(() => attachWithPending(messages), [messages]);
	const items = useMemo(
		() => (stream ? extendAttachPass(committedPass, stream).items : committedPass.items),
		[committedPass, stream],
	);
	const changes = useMemo(() => turnChanges ?? deriveTurnChanges(all), [turnChanges, all]);
	const timings = useMemo(() => deriveTurnTimings(all), [all]);
	// Percho's turn-entrance baseline: only a turn that newly appeared while
	// this session was on screen plays the footer pop. The baseline is aligned
	// on session switch and never on a plain re-render — otherwise the extra
	// render that follows turn_end would strip the animation class again.
	const sessionKey = messages[0]?.id ?? null;
	const turnBaselineRef = useRef<{ key: number | null; count: number }>({
		key: sessionKey,
		count: 0,
	});
	if (turnBaselineRef.current.key !== sessionKey) {
		turnBaselineRef.current = { key: sessionKey, count: timings.length };
	}
	const enteringTurn = timings.length > turnBaselineRef.current.count ? timings.length - 1 : null;
	const rows = useMemo(
		() =>
			buildChatRows(items, {
				working,
				streaming,
				bypassIds: searchBypassIds(all, searchQuery),
				turnChanges: changes,
				turnTimings: timings,
				enteringTurn,
			}),
		[items, working, streaming, all, searchQuery, changes, timings, enteringTurn],
	);

	// ---- which rows are on screen ----
	const windowing = rows.length > VIRTUALIZE_THRESHOLD;

	/** Prefix sums of measured/estimated heights; offs[i] = top of row i. */
	const offsetsFor = useCallback(
		(list: ChatRow[]): number[] => {
			const offs = new Array<number>(list.length + 1);
			offs[0] = 0;
			for (let i = 0; i < list.length; i++) {
				offs[i + 1] = offs[i] + (heightsRef.current.get(list[i].key) ?? ROW_ESTIMATE_PX);
			}
			return offs;
		},
		[],
	);

	/** Widen a window so the active in-session search hit is mounted — the
	 *  scroll-into-view effect looks its element up in msgElsRef, and the user
	 *  explicitly asked to go there. Widening only; it never narrows. */
	const withActive = useCallback(
		(w: RowWindow, list: ChatRow[], activeId: number | null): RowWindow => {
			if (activeId == null) return w;
			const idx = list.findIndex((r) => r.kind === "msg" && r.item.msg.id === activeId);
			if (idx < 0) return w;
			const start = Math.min(w.start, Math.max(0, idx - OVERSCAN));
			const end = Math.max(w.end, Math.min(list.length, idx + OVERSCAN + 1));
			const offs = offsetsFor(list);
			return { start, end, topPad: offs[start], bottomPad: offs[list.length] - offs[end] };
		},
		[offsetsFor],
	);

	const computeWindow = useCallback(
		(
			list: ChatRow[],
			scrollTop: number,
			viewport: number,
			activeId: number | null,
		): RowWindow => {
			const offs = offsetsFor(list);
			// First row whose bottom edge sits at/below the viewport top.
			let lo = 0;
			let hi = list.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (offs[mid + 1] <= scrollTop) lo = mid + 1;
				else hi = mid;
			}
			const start = Math.max(0, lo - OVERSCAN);
			let end = lo;
			while (end < list.length && offs[end] < scrollTop + viewport) end++;
			end = Math.min(list.length, end + OVERSCAN);
			return withActive({ start, end, topPad: offs[start], bottomPad: offs[list.length] - offs[end] }, list, activeId);
		},
		[offsetsFor, withActive],
	);

	const updateWindow = useCallback(() => {
		const scroller = scrollRef.current?.parentElement;
		if (!scroller) return;
		const next = computeWindow(
			rows,
			scroller.scrollTop,
			scroller.clientHeight,
			searchActiveMessageId ?? null,
		);
		// Equality guard: heights converge, so this terminates instead of
		// feeding back through measure → setWindow → render → measure.
		setRowWindow((prev) =>
			prev && prev.start === next.start && prev.end === next.end ? prev : next,
		);
	}, [computeWindow, rows, searchActiveMessageId]);

	// Re-window on scroll, coalesced to one update per frame.
	useEffect(() => {
		if (!windowing) return;
		const scroller = scrollRef.current?.parentElement;
		if (!scroller) return;
		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				updateWindow();
			});
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			if (raf) cancelAnimationFrame(raf);
			scroller.removeEventListener("scroll", onScroll);
		};
	}, [windowing, updateWindow]);

	// The effective window. `rowWindow` is null until the first scroll or
	// measurement lands, so a pure fallback keeps the FIRST paint bounded too —
	// a session load always lands at the bottom, so the tail is the right view.
	// The active search hit is force-included here as well, not just in
	// computeWindow, so it is mounted even before any scroll happens.
	const win = useMemo<RowWindow | null>(() => {
		if (!windowing) return null;
		if (rowWindow) return rowWindow;
		const offs = offsetsFor(rows);
		const end = rows.length;
		const start = Math.max(0, end - INITIAL_ROWS);
		return withActive(
			{ start, end, topPad: offs[start], bottomPad: offs[end] - offs[end] },
			rows,
			searchActiveMessageId ?? null,
		);
	}, [windowing, rowWindow, rows, offsetsFor, withActive, searchActiveMessageId]);
	// Measure the rows that are actually mounted, keep the viewport anchored
	// while the estimates converge, and re-window if the totals moved.
	useLayoutEffect(() => {
		if (!windowing || !win) return;
		const container = scrollRef.current;
		const scroller = container?.parentElement;
		if (!container || !scroller) return;
		let changed = false;
		let idx = win.start;
		for (const child of Array.from(container.children)) {
			const el = child as HTMLElement;
			// Spacers and the transient gap chip are not rows.
			if (el.dataset.spacer !== undefined || el.dataset.gapChip !== undefined) continue;
			const row = rows[idx];
			if (!row) break;
			const h = el.offsetHeight;
			if (h > 0 && heightsRef.current.get(row.key) !== h) {
				heightsRef.current.set(row.key, h);
				changed = true;
			}
			idx++;
		}
		if (!changed) return;
		const offs = offsetsFor(rows);
		const nextTop = offs[win.start];
		const delta = prevTopRef.current === null ? 0 : nextTop - prevTopRef.current;
		prevTopRef.current = nextTop;
		// Correcting heights ABOVE the window would slide the content the user is
		// looking at; compensate. While following, follow() re-pins instead.
		if (delta !== 0 && !stickRef.current) scroller.scrollTop += delta;
		updateWindow();
	}, [windowing, win, rows, offsetsFor, updateWindow]);

	// Leaving the windowed regime (a short session, or a session switch) drops
	// the measurements — they are keyed by row key and would otherwise leak
	// across sessions.
	useEffect(() => {
		if (windowing) return;
		heightsRef.current.clear();
		prevTopRef.current = null;
		setRowWindow(null);
	}, [windowing]);

	const visibleRows = win ? rows.slice(win.start, win.end) : rows;

	// Live groups self-identify: chat-rows marks an entry `running` only when
	// it is the last block of a message that is streaming right now, so the
	// MetaGroup holding that entry (and only that one) lights up while the
	// agent works. No position-based scan — a position scan lit up the
	// previous turn's group in the gap between submit and message_start,
	// and could flash a thinking fold at the top of the transcript.

	// The most recent user message id — the only one that can be recalled
	// (percho: recallMessage applies to the trailing user turn; older ones
	// stay in place). Frozen for the whole run (not just text streaming —
	// `streaming` is false during mid-turn tool execution) so the action
	// buttons never surface while the agent is still working.
	const lastUserMessageId = useMemo(() => {
		if (working || streaming) return null;
		for (let i = all.length - 1; i >= 0; i--) {
			if (all[i].role === "user") return all[i].id;
		}
		return null;
	}, [all, streaming, working]);

	// Live wait chip: shown while the run is live but NOTHING is producing
	// output right now — the first-token wait (the last message is still the
	// user's own) and mid-run pauses (LLM request in flight after tool
	// results, long tool executions) that otherwise read as dead air: the
	// transcript looks finished, then output "resumes by itself". Once any
	// entry runs again — or the final answer text streams, which ends the
	// live shell via `endImmediately` — it disappears. The auto-retry chip
	// takes precedence during retry backoff windows.
	const gapLive =
		shownWorking &&
		!autoRetry &&
		!rows.some((r) => r.kind === "group" && r.entries.some((e) => e.running));
	// First-token wait (nothing but the user's own message so far) reads as
	// "Thinking"; any other contentless window reads as "Working".
	const gapLabel =
		all.length > 0 && all[all.length - 1].role === "user" ? t.chat.metaThinking : t.chat.metaWorking;
	// The last assistant message carrying text — the ONLY one that gets
	// actions (percho showActions = turn-final text id): intermediate
	// narration between tool bursts renders bare; the turn's final answer
	// carries Copy + Fork. Gated on the whole run (`working`), not just
	// text streaming: `streaming` is false while tools execute mid-turn,
	// which let the buttons flash on mid-run narration.
	const turnFinalAssistantId = useMemo(() => {
		if (working || streaming) return null;
		for (let i = all.length - 1; i >= 0; i--) {
			const m = all[i];
			if (m.role === "assistant" && m.blocks.some((b) => b.kind === "text" && b.text.trim())) {
				return m.id;
			}
		}
		return null;
	}, [all, streaming, working]);

	return (
		<div ref={scrollRef} className="messages">
			{/* Windowing spacers keep the scroll height (and therefore the
			    scrollbar and any auto-scroll to the bottom) honest while only a
			    slice of the rows is mounted. */}
			{win && win.topPad > 0 && (
				<div data-spacer="" aria-hidden="true" style={{ height: win.topPad }} />
			)}
			{visibleRows.map((row, vi) => {
				const i = win ? win.start + vi : vi;
				if (row.kind === "turn") {
					// The gap chip sits immediately above the final turn footer, and
					// only ever for the last row — see the fallback below for the
					// case where the list ends on something else.
					const gapChip =
						gapLive && i === rows.length - 1 ? (
							<div data-gap-chip="">
								<GapLiveChip label={gapLabel} />
							</div>
						) : null;
					return (
						<Fragment key={row.key}>
							{gapChip}
							<TurnDiffRow
								changes={row.changes}
								startedAt={row.startedAt}
								endedAt={row.endedAt}
								live={row.live}
								entering={row.entering}
								liveStart={turnStartTime ?? null}
								onOpenDiff={onOpenDiff}
								t={t}
							/>
						</Fragment>
					);
				}
				if (row.kind === "group") {
					return (
						<MetaGroup
							key={row.key}
							entries={row.entries}
							live={shownWorking && row.entries.some((e) => e.running)}
							t={t}
						/>
					);
				}
				return (
					<MessageRow
						key={row.key}
						item={row.item}
						skip={row.skip}
						textAllow={row.textAllow}
						last={row.last}
						t={t}
						searchQuery={searchQuery}
						searchActiveMessageId={searchActiveMessageId}
						refCb={refCb}
						onCopy={onCopyMessage}
						onRecall={onRecallMessage}
						canRecall={row.item.msg.id === lastUserMessageId}
						canFork={row.item.msg.role === "assistant" && row.item.msg.id === turnFinalAssistantId}
						onFork={onForkMessage}
						onRetry={onRetryMessage}
						onCompact={onCompact}
						onOpenSettings={onOpenSettings}
					/>
				);
			})}
			{win && win.bottomPad > 0 && (
				<div data-spacer="" aria-hidden="true" style={{ height: win.bottomPad }} />
			)}
			{/* Auto-retry backoff: the retry chip replaces the gap chip so the
			 * wait stays legible instead of reading as the conversation's end. */}
			{autoRetry && <AutoRetryChip state={autoRetry} t={t} />}
			{/* Fallback: same chip when the list ends without a turn row. */}
			{!autoRetry && gapLive && (rows.length === 0 || rows[rows.length - 1].kind !== "turn") && (
				<GapLiveChip label={gapLabel} />
			)}
		</div>
	);
});
