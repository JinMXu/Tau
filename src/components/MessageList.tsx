import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, ChatMessage } from "../chat-types";
import type { SubagentRun } from "../pi";
import type { MessageCatalog } from "../i18n";
import { BranchIcon, CheckIcon, CopyIcon, SparkleIcon, UndoIcon } from "../icons";
import { ErrorNote } from "./ErrorNote";
import { splitOnQuery } from "./message-utils";
import { ToolCard, ThinkingBlock } from "./ToolCard";
import { MetaGroup, TurnDiffRow } from "./MetaGroup";
import { ThinkingOrb } from "thinking-orbs";
import { PreviewTicker } from "./PreviewTicker";
import {
	attachToolResults,
	buildChatRows,
	deriveTurnChanges,
	deriveTurnTimings,
	searchBypassIds,
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
 * working→worked hysteresis (port of percho useShownWorking): the live
 * signal lingers for HYSTERESIS_MS after `working` drops so turn/tool gaps
 * don't flicker the group shell; `endImmediately` (final-answer text
 * streaming) flips it right away. `resetKey` change (session switch) resets
 * instantly without leaking the previous session's pending timer.
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

/** Compact elapsed duration for the live "working…" status: `42s`, `1:05`. */
function formatElapsed(ms: number): string {
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
 *
 * Hidden while the turn's live footer row (timer chip) is showing — the two
 * would duplicate each other (see ChatArea).
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
					{formatElapsed(elapsedMs)}
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
function MessageImages({ images }: { images: MessageImage[] }) {
	const [preview, setPreview] = useState<number | null>(null);
	const count = images.length;
	const sizeCls =
		count === 1 ? "msg-img single" : count <= 3 ? "msg-img md" : count <= 6 ? "msg-img sm" : "msg-img xs";
	useEffect(() => {
		if (preview === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPreview(null);
			if (e.key === "ArrowRight") setPreview((v) => (v === null ? v : (v + 1) % images.length));
			if (e.key === "ArrowLeft")
				setPreview((v) => (v === null ? v : (v - 1 + images.length) % images.length));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [preview, images.length]);
	return (
		<>
		<div className="msg-images">
			{images.map((img, i) => (
				<button
					key={i}
					type="button"
					className="msg-img-btn"
					aria-label={`image ${i + 1}/${count}`}
					onClick={() => setPreview(i)}
				>
					{/* biome-ignore lint/suspicious/noArrayIndexKey: image list is immutable */}
					<img src={imageSrc(img)} alt="" className={sizeCls} />
				</button>
			))}
		</div>
		{preview !== null && (
			<div className="img-overlay" onClick={() => setPreview(null)}>
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
	useEffect(() => () => {
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
	}, []);
	if (!text || (!canRecall && !canFork)) return null;
	const copy = () => {
		if (!text) return;
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setCopied(false), 1200);
		}).catch(() => {});
		onCopy?.(text);
	};
	return (
		<div className="message-actions">
			{text && (
				<button type="button" className="message-action" aria-label={copied ? t.chat.copied : t.chat.copyText} title={copied ? t.chat.copied : t.chat.copyText} onClick={copy}>
					{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
				</button>
			)}
			{canFork && (
				<button type="button" className="message-action" aria-label={t.chat.fork} title={t.chat.fork} onClick={() => onFork?.()}>
					<BranchIcon size={14} />
				</button>
			)}
			{canRecall && (
				<button type="button" className="message-action" aria-label={t.chat.recall} title={t.chat.recall} onClick={() => onRecall?.()}>
					<UndoIcon size={14} />
				</button>
			)}
		</div>
	);
}

/** One message row (user / assistant text / orphan tool results) with search
 * highlighting and the streaming cursor. `skip` lists block indices folded
 * into a meta group. No author footer, no hover buttons — matches the
 * Percho transcript (groups + text, nothing else). */
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
	onRecall?: () => void;
	canRecall: boolean;
	canFork: boolean;
	onFork?: () => void;
	onRetry?: () => void;
	onCompact?: () => void;
	onOpenSettings?: () => void;
}) {
	const m = item.msg;
	const isSearchTarget =
		searchQuery != null && searchActiveMessageId != null && m.id === searchActiveMessageId;
	return (
		<div
			ref={(el) => refCb(m.id, el)}
			className={`message ${m.role}${isSearchTarget ? " message-search-target" : ""}`}
		>
			{m.role === "user" && m.images && m.images.length > 0 && (
				<MessageImages images={m.images} />
			)}
			{m.blocks.map((b: Block, i: number) => {
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
								{/* Percho UserMessage: user input is always plain text
								    (whitespace-pre-wrap) - no markdown pass. */}
								{m.role === "user" ? (
									b.text
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
			})}
			{last && m.error && typeof m.error !== "string" && (
				<ErrorNote error={m.error} t={t} onRetry={onRetry} onCompact={onCompact} onOpenSettings={onOpenSettings} />
			)}
			{last && typeof m.error === "string" && <div className="msg-error">error: {m.error}</div>}
			{!m.streaming && (m.role === "user" || canFork) && (
				<MessageActions
					text={messageText(m)}
					canRecall={m.role === "user" && canRecall}
					canFork={canFork}
					onCopy={onCopy}
					onRecall={onRecall}
					onFork={onFork}
					t={t}
				/>
			)}
		</div>
	);
});

/** Live chip shown in the submit gap: the agent is working but the new
 * turn's first assistant block has not arrived yet. Same visual as
 * MetaGroup's live header, so the hand-off is seamless. */
const GapLiveChip = memo(function GapLiveChip({ t }: { t: MessageCatalog }) {
	return (
		<div className="meta-group live" aria-hidden="true">
			<div className="meta-head" style={{ cursor: "default" }}>
				<ThinkingOrb state="working" size={20} paused={false} />
				<span className="meta-label">{t.chat.metaThinking}</span>
				<span className="meta-preview">
					<PreviewTicker items={[]} reserveSpace />
				</span>
			</div>
		</div>
	);
});

export const MessageList = memo(function MessageList({
	messages,
	streaming,
	working,
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
	streaming: boolean;
	/** Whether the agent is mid-run (drives live group / live turn flags). */
	working: boolean;
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
	// working→done hysteresis (percho useShownWorking): keep the live group
	// (orb + label + dots) through turn/tool gaps so it never flickers; end
	// immediately once the final answer text starts streaming. Switching
	// sessions resets instantly (first message id changes).
	const shownWorking = useShownWorking(working, textStreaming ?? false, messages[0]?.id);
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
	const items = useMemo(() => attachToolResults(messages), [messages]);
	const changes = useMemo(
		() => turnChanges ?? deriveTurnChanges(messages),
		[turnChanges, messages],
	);
	const rows = useMemo(
		() =>
			buildChatRows(items, {
				working,
				streaming,
				bypassIds: searchBypassIds(messages, searchQuery),
				turnChanges: changes,
				turnTimings: deriveTurnTimings(messages),
			}),
		[items, working, streaming, messages, searchQuery, changes],
	);
	// Live groups self-identify: chat-rows marks an entry `running` only when
	// it is the last block of a message that is streaming right now, so the
	// MetaGroup holding that entry (and only that one) lights up while the
	// agent works. No position-based scan — a position scan lit up the
	// previous turn's group in the gap between submit and message_start,
	// and could flash a thinking fold at the top of the transcript.

	// The most recent user message id — the only one that can be recalled
	// (percho: recallMessage applies to the trailing user turn; older ones
	// stay in place). Frozen mid-stream so the live group doesn't keep
	// changing the target behind the user's hand.
	const lastUserMessageId = useMemo(() => {
		if (streaming) return null;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") return messages[i].id;
		}
		return null;
	}, [messages, streaming]);

	// Submit-gap live chip: shown ONLY while the current turn has produced
	// no content at all (the last message is still the user's own) — the
	// first-token wait. Once any assistant/tool content arrives it never
	// comes back for the rest of the turn: mid-turn pauses (between tool
	// results and the next message) have their own live signals, and a
	// permanent chip there read as noise.
	const gapLive =
		shownWorking &&
		messages.length > 0 &&
		messages[messages.length - 1].role === "user" &&
		!rows.some((r) => r.kind === "group" && r.entries.some((e) => e.running));
	// The last assistant message carrying text — the ONLY one that gets
	// actions (percho showActions = turn-final text id): intermediate
	// narration between tool bursts renders bare; the turn's final answer
	// carries Copy + Fork.
	const turnFinalAssistantId = useMemo(() => {
		if (streaming) return null;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant" && m.blocks.some((b) => b.kind === "text" && b.text.trim())) {
				return m.id;
			}
		}
		return null;
	}, [messages, streaming]);


	return (
		<div ref={scrollRef} className="messages">
			{rows.map((row, i) => {
				if (row.kind === "turn") {
					const gapChip =
						gapLive && i === rows.length - 1 ? <GapLiveChip t={t} /> : null;
					return (
						<Fragment key={row.key}>
							{gapChip}
							<TurnDiffRow
								changes={row.changes}
								startedAt={row.startedAt}
								endedAt={row.endedAt}
								live={row.live}
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
						onRecall={row.item.msg.role === "user" ? () => onRecallMessage?.(row.item.msg) : undefined}
						canRecall={row.item.msg.id === lastUserMessageId}
						canFork={
							row.item.msg.role === "assistant" &&
							row.item.msg.id === turnFinalAssistantId
						}
						onFork={
							row.item.msg.role === "assistant"
								? () => onForkMessage?.(row.item.msg)
								: undefined
						}
						onRetry={row.item.msg.error && typeof row.item.msg.error !== "string" ? () => onRetryMessage?.(row.item.msg) : undefined}
						onCompact={onCompact}
						onOpenSettings={onOpenSettings}
					/>
				);
			})}
			{/* Fallback: same chip when the list ends without a turn row. */}
			{gapLive && (rows.length === 0 || rows[rows.length - 1].kind !== "turn") && (
				<GapLiveChip t={t} />
			)}
		</div>
	);
});
