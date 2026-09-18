import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { motion } from "motion/react";
import { BranchIcon, CopyIcon, UndoIcon } from "../icons";
import type { AutoRetryState, Block, ChatMessage } from "../chat-types";
import type { SubagentRun } from "../pi";
import type { MessageCatalog } from "../i18n";
import { ErrorNote } from "./ErrorNote";
import { splitOnQuery } from "./message-utils";
import {
	ActivityCard,
	AutoRetryCard,
	GapLiveCard,
	SubagentLiveCard,
	ThinkingRow,
	ToolRow,
	TurnPill,
} from "./message-activity";
import {
	attachToolResults,
	buildChatRows,
	deriveTurnChanges,
	deriveTurnTimings,
	searchBypassIds,
	type GroupEntry,
	type MessageItem,
	type TurnChanges,
} from "./chat-rows";
import { Markdown } from "./Markdown";
import { Message, MessageContent, MessageScroller } from "./agents/message";
import { MessageBubble, MessageBubbleContent } from "./agents/message-bubble";
import { StreamingResponse } from "./agents/streaming-response";
import { SPRING_PRESS } from "../lib/ease";

/**
 * Chat transcript renderer on beUI primitives (direction C): user messages
 * are soft bubbles, assistant answers stream through StreamingResponse with a
 * resident dim copy/fork footer, thinking/tool work folds into ActivityCards
 * (Percho fold philosophy, beUI activity rows inside), turns close with a
 * centered pill. Rows derive exactly as before (chat-rows.ts); the scroll
 * container is the vendored beUI MessageScroller with the left navigation
 * rail. All motion comes from the beUI ease/spring vocabulary.
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

function HighlightedText({ text, query }: { text: string; query: string }) {
	return (
		<div className="text-block highlighted-text">
			{splitOnQuery(text, query).map((p, j) =>
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

/** Hover-revealed action button (copy / recall) under the user bubble. */
function MessageAction({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<motion.button
			type="button"
			className="message-action"
			aria-label={label}
			title={label}
			onClick={onClick}
			whileTap={{ scale: 0.9 }}
			transition={SPRING_PRESS}
		>
			{children}
		</motion.button>
	);
}

/** One message row (user bubble / assistant response / orphan tool results)
 * with search highlighting and the streaming cursor. `skip` lists block
 * indices folded into an activity card. */
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
	animateIn,
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
	/** Plays the beUI bubble/response entrance once (messages that arrived
	 * while the session was open — never on history load or session switch). */
	animateIn: boolean;
}) {
	const m = item.msg;
	const isSearchTarget =
		searchQuery != null && searchActiveMessageId != null && m.id === searchActiveMessageId;
	const from = m.role === "user" ? ("user" as const) : ("assistant" as const);
	const text = messageText(m);
	return (
		<Message
			ref={(el) => refCb(m.id, el as unknown as HTMLDivElement | null)}
			from={from}
			className={`message${isSearchTarget ? " message-search-target" : ""}`}
		>
			<MessageContent>
				{m.role === "user" && m.images && m.images.length > 0 && (
					<MessageImages images={m.images} t={t} />
				)}
				{m.blocks.map((b: Block, i: number) => {
					if (item.consumed.has(i) || skip.has(i)) return null;
					if (b.kind === "text") {
						if (textAllow && !textAllow.has(i)) return null;
						if (m.role === "tool") {
							// Tool result text streaming in. Nobody reads
							// this mid-stream — the running activity row
							// already shows the state. Keep the message
							// empty until the authoritative tool result
							// replaces it. Exception: in-session search.
							if (isSearchTarget && searchQuery) {
								return <HighlightedText key={i} text={b.text} query={searchQuery} />;
							}
							return null;
						}
						if (m.role === "user") {
							// Percho UserMessage: user input is always plain
							// text (whitespace-pre-wrap) — no markdown pass.
							return isSearchTarget && searchQuery ? (
								<HighlightedText key={i} text={b.text} query={searchQuery} />
							) : (
								<MessageBubble key={i} variant="soft" animateIn={animateIn}>
									<MessageBubbleContent className="user-bubble-text">{b.text}</MessageBubbleContent>
								</MessageBubble>
							);
						}
						return isSearchTarget && searchQuery ? (
							<HighlightedText key={i} text={b.text} query={searchQuery} />
						) : (
							<StreamingResponse
								key={i}
								status={m.streaming ? "streaming" : "complete"}
								showFeedback={false}
								showActions={canFork && last}
								copyText={canFork && last ? text : undefined}
								onCopy={canFork && last ? () => onCopy?.(text) : undefined}
								copyLabel={t.chat.copyText}
								copiedLabel={t.chat.copied}
								contentClass="text-block"
								actions={
									canFork && last ? (
										<motion.button
											type="button"
											className="message-action"
											aria-label={t.chat.fork}
											title={t.chat.fork}
											onClick={() => onFork?.()}
											whileTap={{ scale: 0.9 }}
											transition={SPRING_PRESS}
										>
											<BranchIcon size={14} />
										</motion.button>
									) : undefined
								}
							>
								<Markdown text={b.text} streaming={m.streaming} />
							</StreamingResponse>
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
						// Non-search thinking reaches here only for bypass rows
						// (search targets); render it as a bare activity row.
						const entry: GroupEntry = {
							kind: "thinking",
							msgId: m.id,
							blockIndex: i,
							text: b.text,
							result: null,
							resultStreaming: false,
							running: m.streaming && i === m.blocks.length - 1,
						};
						return <ThinkingRow key={i} entry={entry} t={t} />;
					}
					// Tool call (orphan results / bypass rows): bare activity row.
					const entry: GroupEntry = {
						kind: "tool",
						msgId: m.id,
						blockIndex: i,
						block: b,
						result: b.result ? b : (item.attached.get(i) ?? null),
						resultStreaming: item.attachedStreaming.get(i) ?? false,
						running:
							(m.streaming && i === m.blocks.length - 1) ||
							(item.attachedStreaming.get(i) ?? false),
					};
					return <ToolRow key={i} entry={entry} running={entry.running} t={t} />;
				})}
				{last && m.error && typeof m.error !== "string" && (
					<ErrorNote
						error={m.error}
						t={t}
						onRetry={onRetry}
						onCompact={onCompact}
						onOpenSettings={onOpenSettings}
					/>
				)}
				{last && typeof m.error === "string" && <div className="msg-error">error: {m.error}</div>}
				{last && !m.streaming && m.role === "user" && canRecall && (
					<div className="message-actions">
						{text && (
							<MessageAction
								label={t.chat.copyText}
								onClick={() => {
									void navigator.clipboard?.writeText(text).catch(() => {});
									onCopy?.(text);
								}}
							>
								<CopyIcon size={13} />
							</MessageAction>
						)}
						{canRecall && (
							<MessageAction label={t.chat.recall} onClick={() => onRecall?.()}>
								<UndoIcon size={13} />
							</MessageAction>
						)}
					</div>
				)}
			</MessageContent>
		</Message>
	);
}, (prev, next) => {
	// Value-based equality: a committed row re-renders only when its own
	// content or gating actually changes — never on stream deltas. motion's
	// layout projection writes inline styles on every render, so re-rendering
	// the whole transcript per token would dirty committed rows (the
	// stream/committed split guarantee) and thrash layout. Callback props are
	// intentionally not compared: they close over app-level useCallbacks
	// (verified stable in App.tsx) and the row's own msg object.
	if (prev.t !== next.t) return false;
	if (prev.last !== next.last || prev.animateIn !== next.animateIn) return false;
	if (prev.canRecall !== next.canRecall || prev.canFork !== next.canFork) return false;
	if (prev.searchQuery !== next.searchQuery || prev.searchActiveMessageId !== next.searchActiveMessageId)
		return false;
	if (prev.item.msg !== next.item.msg) return false;
	if (prev.skip.size !== next.skip.size) return false;
	for (const v of prev.skip) if (!next.skip.has(v)) return false;
	const pa = prev.textAllow;
	const na = next.textAllow;
	if ((pa?.size ?? -1) !== (na?.size ?? -1)) return false;
	if (pa) for (const v of pa) if (!na!.has(v)) return false;
	if (prev.item.attached.size !== next.item.attached.size) return false;
	for (const [k, v] of prev.item.attached) if (next.item.attached.get(k) !== v) return false;
	if (prev.item.attachedStreaming.size !== next.item.attachedStreaming.size) return false;
	for (const [k, v] of prev.item.attachedStreaming) if (next.item.attachedStreaming.get(k) !== v) return false;
	if (prev.item.consumed.size !== next.item.consumed.size) return false;
	for (const v of prev.item.consumed) if (!next.item.consumed.has(v)) return false;
	return true;
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
	subagentRuns,
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
	/** Live turn anchor (Date.now at submit) for the ticking pill timer. */
	turnStartTime?: number | null;
	/** Shared per-turn changes (same source as the diff sidebar). */
	turnChanges?: TurnChanges[];
	/** In-flight pi-subagent runs (rendered at the end of the transcript). */
	subagentRuns?: SubagentRun[];
	/** Open the diff sidebar (turn pill file rows / chips). */
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
	const viewportRef = useRef<HTMLElement | null>(null);
	const msgElsRef = useRef(new Map<number, HTMLDivElement>());
	/**
	 * What the transcript renders: the committed messages plus the in-flight
	 * one. App keeps the two apart so `messages` (and therefore every item,
	 * row and memo downstream) stays identity-stable while tokens stream; the
	 * in-flight message is appended here, at the last moment, exactly like
	 * percho's buildChatRows folds its StreamingState container in.
	 */
	const all = useMemo(() => (stream ? [...messages, stream] : messages), [messages, stream]);
	// working→done hysteresis (percho useShownWorking): keep the live card
	// (dot + shimmer + ticker) through turn/tool gaps so it never flickers;
	// end immediately once the final answer text starts streaming. Switching
	// sessions resets instantly (first message id changes).
	const shownWorking = useShownWorking(working, textStreaming ?? false, all[0]?.id);

	// Scroll the active search hit into view within the MessageScroller
	// viewport. Jumping to a hit is explicit user intent; the scroller's own
	// scroll handler then sees the view away from the live edge and stops
	// following (its programmatic-scroll guard only covers its own scrolls).
	useEffect(() => {
		if (searchActiveMessageId == null) return;
		const el = msgElsRef.current.get(searchActiveMessageId);
		const scroller = viewportRef.current;
		if (el && scroller) {
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
	const items = useMemo(() => attachToolResults(all), [all]);
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
	// Live cards self-identify: chat-rows marks an entry `running` only when
	// it is the last block of a message that is streaming right now, so the
	// ActivityCard holding that entry (and only that one) lights up while the
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

	// Live wait card: shown while the run is live but NOTHING is producing
	// output right now — the first-token wait and mid-run pauses that
	// otherwise read as dead air. Once any entry runs again — or the final
	// answer text streams, which ends the live shell via `endImmediately` —
	// it disappears. The auto-retry card takes precedence during retry
	// backoff windows.
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

	// Entrance-animation baseline: message ids at mount (and on session
	// switch, via the MessageScroller remount key) never animate; ids that
	// appear afterwards — a sent message, the in-flight reply — play the beUI
	// pop once. History loads and session switches stay still.
	const maxId = useMemo(() => all.reduce((mx, m) => Math.max(mx, m.id), 0), [all]);
	const animateBaselineRef = useRef<{ key: number | null; max: number }>({
		key: sessionKey,
		max: maxId,
	});
	if (animateBaselineRef.current.key !== sessionKey) {
		animateBaselineRef.current = { key: sessionKey, max: maxId };
	}
	const animateFromId = animateBaselineRef.current.max;

	return (
		<MessageScroller
			key={sessionKey ?? "empty"}
			className="flex-1 min-h-0"
			followOutput={autoScroll !== false}
			followThreshold={120}
			busy={working || streaming}
			label={t.chat.railLabel}
			navigation="rail"
			railSide="left"
			navigationLabel={t.chat.railNavLabel}
			viewportRef={viewportRef}
			viewportClassName="chat-scroll"
			contentClassName="messages"
		>
			{rows.map((row, i) => {
				if (row.kind === "turn") {
					const gapChip =
						gapLive && i === rows.length - 1 ? <GapLiveCard label={gapLabel} /> : null;
					return (
						<Fragment key={row.key}>
							{gapChip}
							<TurnPill
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
						<ActivityCard
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
						onRecall={
							row.item.msg.role === "user" ? () => onRecallMessage?.(row.item.msg) : undefined
						}
						canRecall={row.item.msg.id === lastUserMessageId}
						canFork={row.item.msg.role === "assistant" && row.item.msg.id === turnFinalAssistantId}
						onFork={
							row.item.msg.role === "assistant" ? () => onForkMessage?.(row.item.msg) : undefined
						}
						onRetry={
							row.item.msg.error && typeof row.item.msg.error !== "string"
								? () => onRetryMessage?.(row.item.msg)
								: undefined
						}
						onCompact={onCompact}
						onOpenSettings={onOpenSettings}
						animateIn={row.item.msg.id > animateFromId}
					/>
				);
			})}
			{/* Auto-retry backoff: the retry card replaces the gap card so the
			 * wait stays legible instead of reading as the conversation's end. */}
			{autoRetry && <AutoRetryCard state={autoRetry} t={t} />}
			{/* Fallback: same card when the list ends without a turn row. */}
			{!autoRetry && gapLive && (rows.length === 0 || rows[rows.length - 1].kind !== "turn") && (
				<GapLiveCard label={gapLabel} />
			)}
			{subagentRuns && subagentRuns.length > 0 && <SubagentLiveCard runs={subagentRuns} t={t} />}
		</MessageScroller>
	);
});
