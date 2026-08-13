import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Block, ChatMessage } from "../chat-types";
import type { MessageCatalog } from "../i18n";
import {
	BoltIcon,
	BranchIcon,
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	FileIcon,
	FolderOpenIcon,
	LoaderIcon,
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
	if (key.startsWith("write") || key.startsWith("edit"))
		return <FileIcon size={size} />;
	if (key.startsWith("grep") || key.startsWith("search") || key.startsWith("web"))
		return <SearchIcon size={size} />;
	if (key.includes("apply") || key.includes("patch"))
		return <BoltIcon size={size} />;
	return <SparkleIcon size={size} />;
};

type ToolBlockT = Extract<Block, { kind: "tool" }>;

/** Lines of tool output shown inline before the rest is tucked behind a toggle. */
const OUTPUT_PREVIEW_LINES = 8;

function ToolOutput({
	text,
	error,
	t,
}: {
	text: string;
	error?: boolean;
	t: MessageCatalog;
}) {
	const [expanded, setExpanded] = useState(false);
	const body = text.replace(/\n+$/, "");
	const lineCount = body ? body.split("\n").length : 0;
	const truncated = lineCount > OUTPUT_PREVIEW_LINES;
	// Only put the preview slice into the DOM while collapsed — rendering a
	// multi-megabyte tool dump (even clipped by CSS) can freeze or crash the
	// webview when a task finishes.
	const visible =
		truncated && !expanded
			? body.split("\n").slice(0, OUTPUT_PREVIEW_LINES).join("\n")
			: body;
	return (
		<div className={`tool-output${error ? " error" : ""}`}>
			{body.trim() ? (
				<pre className={truncated && !expanded ? "clamped" : undefined}>
					{visible}
				</pre>
			) : (
				<div className="tool-output-empty">{t.chat.noOutput}</div>
			)}
			{truncated && (
				<button
					className="tool-output-toggle"
					onClick={() => setExpanded((v) => !v)}
				>
					{expanded
						? t.chat.showLess
						: t.chat.showAllLines.replace("{count}", String(lineCount))}
				</button>
			)}
		</div>
	);
}

function DiffView({
	lines,
	label,
	t,
}: {
	lines: DiffLine[];
	label?: string;
	t: MessageCatalog;
}) {
	const [expanded, setExpanded] = useState(false);
	const truncated = lines.length > OUTPUT_PREVIEW_LINES;
	const visible = truncated && !expanded ? lines.slice(0, OUTPUT_PREVIEW_LINES) : lines;
	return (
		<div className="tool-diff">
			{label && <div className="diff-label">{label}</div>}
			<pre className={truncated && !expanded ? "clamped" : undefined}>
				{visible.map((l, i) => (
					<span key={i} className={`diff-line ${l.type}`}>
						<span className="diff-sign">
							{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
						</span>
						{l.text}
					</span>
				))}
			</pre>
			{truncated && (
				<button
					className="tool-output-toggle"
					onClick={() => setExpanded((v) => !v)}
				>
					{expanded
						? t.chat.showLess
						: t.chat.showAllLines.replace("{count}", String(lines.length))}
				</button>
			)}
		</div>
	);
}

function ToolCard({
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
	const [showArgs, setShowArgs] = useState(false);
	const prettyName = block.name
		.split("_")
		.map((s) => s[0]?.toUpperCase() + s.slice(1))
		.join(" ");
	// For tool results the body is the tool's output, not call arguments, so
	// skip the argument summary and the "open file" quick action.
	let filePath: string | null = null;
	let summary: string | null = null;
	if (!block.result) {
		try {
			const parsed = JSON.parse(block.args) as { path?: unknown };
			if (typeof parsed.path === "string" && parsed.path.trim()) {
				filePath = parsed.path.trim();
			}
		} catch {
			/* args may be partial while streaming */
		}
		summary = toolSummary(block.args);
	}
	const error = block.error || result?.error;
	const toggleArgs = block.result
		? undefined
		: () => setShowArgs((v) => !v);
	// Edit/write-style calls surface their changes as inline line diffs.
	const diffBlocks = useMemo(
		() => (block.result ? null : diffBlocksFromArgs(block.args)),
		[block.result, block.args],
	);
	let diffAdd = 0;
	let diffDel = 0;
	if (diffBlocks) {
		for (const b of diffBlocks) {
			for (const l of b.lines) {
				if (l.type === "add") diffAdd++;
				else if (l.type === "del") diffDel++;
			}
		}
	}
	return (
		<div
			className={`tool-card${block.result ? " result" : ""}${error ? " error" : ""}${showArgs ? " args-open" : ""}`}
		>
			<div
				className="tool-head"
				role={toggleArgs ? "button" : undefined}
				tabIndex={toggleArgs ? 0 : undefined}
				aria-expanded={toggleArgs ? showArgs : undefined}
				onClick={toggleArgs}
				onKeyDown={
					toggleArgs
						? (e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									toggleArgs();
								}
							}
						: undefined
				}
			>
				<span
					className={`tool-status${running ? " running" : ""}${error ? " error" : ""}`}
				/>
				<span className="tool-icon">{toolIcon(block.name)}</span>
				<span className="tool-name">{prettyName || "tool"}</span>
				{block.result && (
					<span className="tool-result-label">
						{block.error ? t.chat.error : t.chat.result}
					</span>
				)}
				{summary && <span className="tool-summary">{summary}</span>}
				{diffBlocks && (diffAdd > 0 || diffDel > 0) && (
					<span className="diff-stats">
						{diffDel > 0 && <span className="del">-{diffDel}</span>}
						{diffAdd > 0 && <span className="add">+{diffAdd}</span>}
					</span>
				)}
				{toggleArgs && (
					<ChevronDownIcon
						size={12}
						className={`tool-chevron${showArgs ? " open" : ""}`}
					/>
				)}
			</div>
			{showArgs && !block.result && (
				<>
					<pre className="tool-args">{block.args}</pre>
					{filePath && (
						<div className="tool-file-actions">
							<button onClick={() => void openPath(filePath)}>
								<FileIcon size={12} />
								<span>{filePath}</span>
							</button>
						</div>
					)}
				</>
			)}
			{diffBlocks && diffBlocks.length > 0 && (
				<div className="tool-diffs">
					{diffBlocks.map((b, i) => (
						<DiffView
							key={i}
							lines={b.lines}
							label={b.label || undefined}
							t={t}
						/>
					))}
				</div>
			)}
			{result && <ToolOutput text={result.args} error={result.error} t={t} />}
		</div>
	);
}

function ThinkingBlock({
	text,
	streaming,
	t,
}: {
	text: string;
	streaming: boolean;
	t: MessageCatalog;
}) {
	return (
		<details className="thinking-block">
			<summary>
				<span className={`thinking-dot${streaming ? " pulse" : ""}`} />
				<span className="thinking-label">{t.chat.thinking}</span>
				<ChevronDownIcon size={12} className="tool-chevron" />
			</summary>
			<div className="thinking-body">{text}</div>
		</details>
	);
}

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

export function TurnWaitIndicator({ t }: { t: MessageCatalog }) {
	return (
		<div className="turn-wait">
			<LoaderIcon size={14} className="spin" />
			<span>{t.chat.turnWait}</span>
		</div>
	);
}

export function MessageList({
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
	// the turn-wait indicator, window resizes.
	useEffect(() => {
		const el = scrollRef.current;
		const scroller = el?.parentElement;
		if (!el || !scroller) return;
		const resizeObserver = new ResizeObserver(follow);
		resizeObserver.observe(el);
		resizeObserver.observe(scroller);
		const mutationObserver = new MutationObserver(follow);
		mutationObserver.observe(scroller, { childList: true, subtree: true });
		// User intent: scrolling away unsticks, scrolling back to the bottom
		// re-sticks.
		const onScroll = () => {
			stickRef.current =
				scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
				120;
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			scroller.removeEventListener("scroll", onScroll);
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
			consumed: Set<number>;
		}[] = [];
		let pending: { item: (typeof list)[number]; index: number }[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") pending = [];
			const item = {
				msg,
				attached: new Map<number, ToolBlockT>(),
				consumed: new Set<number>(),
			};
			if (msg.role === "tool") {
				msg.blocks.forEach((b, i) => {
					if (b.kind !== "tool") return;
					const slot = pending.shift();
					if (slot) {
						slot.item.attached.set(slot.index, b);
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
					if (b.kind === "tool" && !b.result)
						pending.push({ item, index: i });
				});
			}
		}
		return list;
	}, [messages]);

	const copyMessage = useCallback(
		async (m: ChatMessage, mode: "md" | "text") => {
			const content =
				mode === "md" ? chatMessageToMarkdown(m) : chatMessageToPlainText(m);
			if (!content) return;
			const key = `${m.id}-${mode}`;
			try {
				await navigator.clipboard.writeText(content);
				setCopiedId(key);
				window.setTimeout(() => {
					setCopiedId((cur) => (cur === key ? null : cur));
				}, 1200);
			} catch {
				/* clipboard unavailable */
			}
		},
		[],
	);

	// Scroll the active search hit into view.
	useEffect(() => {
		if (searchActiveMessageId == null) return;
		const el = msgElsRef.current.get(searchActiveMessageId);
		if (el) {
			el.scrollIntoView({ block: "center", behavior: "smooth" });
		}
	}, [searchActiveMessageId]);

	return (
		<div ref={scrollRef} className="messages">
			{items.map(({ msg: m, attached, consumed }) => {
				const time = m.role === "user" ? formatTime(m.timestamp) : null;
				const isSearchTarget =
					searchQuery != null &&
					searchActiveMessageId != null &&
					m.id === searchActiveMessageId;
				return (
					<div
						key={m.id}
						ref={(el) => {
							if (el) msgElsRef.current.set(m.id, el);
							else msgElsRef.current.delete(m.id);
						}}
						className={`message ${m.role}${isSearchTarget ? " message-search-target" : ""}`}
					>
						{m.role === "assistant" && (
							<AssistantFooter message={m} t={t} />
						)}
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
									{copiedId === `${m.id}-md` ? (
										<CheckIcon size={12} />
									) : (
										<CopyIcon size={12} />
									)}
								</button>
								<button
									className="fork-btn"
									title={t.chat.copyPlainText}
									onClick={() => void copyMessage(m, "text")}
								>
									{copiedId === `${m.id}-text` ? (
										<CheckIcon size={12} />
									) : (
										<CopyIcon size={12} />
									)}
								</button>
							</div>
						)}
						{m.blocks.map((b, i) => {
							if (consumed.has(i)) return null;
						if (b.kind === "text") {
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
										<div
											className="text-block thinking highlighted-text"
											key={i}
										>
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
									<ThinkingBlock
										key={i}
										text={b.text}
										streaming={m.streaming}
										t={t}
									/>
								);
							}
							return (
								<ToolCard
									key={i}
									block={b}
									result={b.result ? b : (attached.get(i) ?? null)}
									running={m.streaming && i === m.blocks.length - 1}
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
}
