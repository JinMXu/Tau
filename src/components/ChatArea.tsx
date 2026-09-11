import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
	Attachment,
	ChatMessage,
	QueuedChatMessage,
	SendBehavior,
	SessionStats,
} from "../chat-types";
import type { AgentToolName } from "../settings";
import type { PiCommand } from "../pi";
import type { MessageCatalog } from "../i18n";
import type { GitBranchState, PiSessionInfo, SubagentRun } from "../pi";
import {
	ArchiveIcon,
	BarChartIcon,
	BoltIcon,
	BranchIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	CopyIcon,
	DownloadIcon,
	EditIcon,
	FolderOpenIcon,
	MoreIcon,
	PanelLeftOpenIcon,
	PlusIcon,
	SearchIcon,
	SparkleIcon,
	TrashIcon,
	XIcon,
} from "../icons";
import { Composer, type ModelEntry } from "./Composer";
import { MessageList, SubagentLivePanel } from "./MessageList";
import { TodoPanel } from "./TodoPanel";
import { DiffSidebar, type DiffScope } from "./DiffSidebar";
import { deriveTurnChanges, extractTodos } from "./chat-rows";
import { searchMessages } from "./message-utils";
import { isMac } from "../platform";

function greeting(t: MessageCatalog): string {
	const h = new Date().getHours();
	if (h < 12) return t.chat.greetingMorning;
	if (h < 18) return t.chat.greetingAfternoon;
	return t.chat.greetingEvening;
}

/**
 * Collapsed-sidebar actions: expand / back / forward / new task. Rendered in
 * the chat header when there are messages AND in a standalone top strip on
 * the welcome view (no header there) — so the buttons survive collapsing
 * even before the first message, and the sidebar can always be expanded
 * back with the mouse.
 */
function CollapsedActions({
	t,
	busy,
	canGoBack,
	canGoForward,
	onToggleSidebar,
	onBack,
	onForward,
	onNewTask,
}: {
	t: MessageCatalog;
	busy: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	onToggleSidebar: () => void;
	onBack: () => void;
	onForward: () => void;
	onNewTask: () => void;
}) {
	return (
		<div className="collapsed-actions">
			<button
				className="icon-btn"
				title={t.sidebar.expand}
				aria-label={t.sidebar.expand}
				onClick={onToggleSidebar}
			>
				<PanelLeftOpenIcon size={16} />
			</button>
			<div className="sidebar-nav-btns">
				<button
					className="icon-btn"
					title={t.sidebar.back}
					aria-label={t.sidebar.back}
					disabled={!canGoBack}
					onClick={onBack}
				>
					<ChevronLeftIcon size={16} />
				</button>
				<button
					className="icon-btn"
					title={t.sidebar.forward}
					aria-label={t.sidebar.forward}
					disabled={!canGoForward}
					onClick={onForward}
				>
					<ChevronRightIcon size={16} />
				</button>
			</div>
			<button
				className="icon-btn"
				title={t.sidebar.newTask}
				aria-label={t.sidebar.newTask}
				disabled={busy}
				onClick={onNewTask}
			>
				<PlusIcon size={16} />
			</button>
		</div>
	);
}

export const ChatArea = memo(function ChatArea({
	t,
	session,
	messages,
	stream,
	streaming,
	textStreaming,
	working,
	subagentRuns,
	connected,
	busy,
	error,
	models,
	model,
	onModelChange,
	thinkingLevel,
	thinkingLevels,
	onThinkingLevelChange,
	sendDuringRun,
	onSendDuringRunChange,
	onSubmit,
	onAbort,
	aborting,
	onCompact,
	onCopy,
	onExport,
	onExportHtml,
	onRename,
	onArchive,
	onDelete,
	onCompactImages,
	onReveal,
	onTree,
	onSessionInfo,
	onShare,
	onImport,
	onHotkeys,
	composerFocusRequest,
	showTurnWait,
	gitState,
	onCheckoutBranch,
	onCreateBranch,
	stats,
	workspace,
	workspaces,
	onPickWorkspace,
	onSelectWorkspace,
	queuedMessages,
	queuePaused,
	editingQueueId,
	onQueueSendNow,
	onQueueEdit,
	onQueueDelete,
	onQueueReorder,
	onQueueCancelEdit,
	sidebarCollapsed,
	onToggleSidebar,
	onNewTask,
	onBack,
	onForward,
	canGoBack,
	canGoForward,
	customTools,
	onCustomToolsChange,
	showContextUsage,
	modelsLoading,
	commands,
	extensionWidgets,
	extensionStatus,
	externalDraft,
	onExternalDraftConsumed,
	onCycleThinking,
	onCopyMessage,
	onRecallMessage,
	onForkMessage,
	onRetryMessage,
	onCompactSession,
	openSettings,
}: {
	t: MessageCatalog;
	session: PiSessionInfo | null;
	messages: ChatMessage[];
	/** The in-flight pi message (kept out of `messages`; see App.tsx). */
	stream: ChatMessage | null;
	streaming: boolean;
	/** Assistant TEXT streaming (see App) — ends the live group instantly. */
	textStreaming?: boolean;
	working: boolean;
	subagentRuns: SubagentRun[];
	connected: boolean;
	busy: boolean;
	error: string | null;
	models: ModelEntry[];
	model: string;
	onModelChange: (value: string) => void;
	thinkingLevel: string;
	thinkingLevels: string[];
	onThinkingLevelChange: (value: string) => void;
	sendDuringRun: "steer" | "followUp";
	onSendDuringRunChange: (value: "steer" | "followUp") => void;
	onSubmit: (
		text: string,
		attachments: Attachment[],
		behavior: SendBehavior,
		editingQueueId?: string | null,
	) => Promise<boolean>;
	onAbort: () => void;
	aborting: boolean;
	onCompact: () => void;
	onCopy: () => Promise<boolean>;
	onExport: (format: "markdown" | "jsonl") => void;
	onExportHtml: () => void;
	onRename: () => void;
	onArchive: () => void;
	onDelete: () => void;
	onCompactImages: () => void;
	onReveal: () => void;
	onTree: () => void;
	onSessionInfo: () => void;
	onShare: () => void;
	onImport: () => void;
	onHotkeys: () => void;
	composerFocusRequest: number;
	showTurnWait: boolean;
	gitState: GitBranchState | null;
	onCheckoutBranch: (name: string) => void;
	onCreateBranch: (name: string) => void;
	stats: SessionStats | null;
	workspace: string | null;
	workspaces: string[];
	onPickWorkspace: () => void;
	onSelectWorkspace: (path: string) => void;
	queuedMessages: QueuedChatMessage[];
	queuePaused: boolean;
	editingQueueId: string | null;
	onQueueSendNow: (id: string) => void;
	onQueueEdit: (item: QueuedChatMessage) => void;
	onQueueDelete: (id: string) => void;
	onQueueReorder: (activeId: string, overId: string) => void;
	onQueueCancelEdit: () => void;
	sidebarCollapsed: boolean;
	onToggleSidebar: () => void;
	onNewTask: () => void;
	onBack: () => void;
	onForward: () => void;
	canGoBack: boolean;
	canGoForward: boolean;
	customTools: AgentToolName[];
	onCustomToolsChange: (tools: AgentToolName[]) => void;
	showContextUsage: boolean;
	modelsLoading: boolean;
	commands: PiCommand[];
	extensionWidgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	extensionStatus: string[];
	externalDraft: string | null;
	onExternalDraftConsumed: () => void;
	onCycleThinking: () => void;
	/** Copy a single message's plain text (separate from copying the whole conversation). */
	onCopyMessage: (text: string) => void;
	/** Recall (drop) the last user message and put its text back in the composer. */
	onRecallMessage: (msg: ChatMessage) => void;
	onForkMessage: (msg: ChatMessage) => void;
	onRetryMessage: (msg: ChatMessage) => void;
	onCompactSession: () => void;
	openSettings: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuId = useId();
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	const menuRef = useRef<HTMLDivElement>(null);
	// In-session search (Ctrl+F): hits over all message blocks, one active.
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeHit, setActiveHit] = useState(0);
	const searchInputRef = useRef<HTMLInputElement>(null);
	// Committed transcript + the in-flight message: every derivation below (and
	// the rows downstream) has to see the same sequence the user is looking at.
	const liveMessages = useMemo(
		() => (stream ? [...messages, stream] : messages),
		[messages, stream],
	);
	const hits = useMemo(
		() => searchMessages(liveMessages, searchQuery),
		[liveMessages, searchQuery],
	);
	const activeMessageId = useMemo(() => {
		if (!searchOpen || hits.length === 0) return null;
		const hit = hits[Math.min(activeHit, hits.length - 1)];
		return liveMessages[hit.messageIndex]?.id ?? null;
	}, [searchOpen, hits, activeHit, liveMessages]);

	const stepHit = (delta: number) => {
		if (hits.length === 0) return;
		setActiveHit((cur) => (cur + delta + hits.length) % hits.length);
	};

	const closeSearch = () => {
		setSearchOpen(false);
		setSearchQuery("");
		setActiveHit(0);
	};

	// Turn-level status anchor (DSH "Deep diving..."): the elapsed clock
	// counts from when the turn opened — including the pre-first-token wait
	// — and is retained across the thinking / tool / text phases.
	const turnActive = showTurnWait || streaming;
	const [turnStartTime, setTurnStartTime] = useState<number | null>(null);
	useEffect(() => {
		if (turnActive) {
			setTurnStartTime((cur) => cur ?? Date.now());
		} else {
			setTurnStartTime(null);
		}
	}, [turnActive]);

	// ---- task list + turn changes + diff sidebar (Percho ports) ----
	// Todos: the latest `todo` tool call in the stream (empty → panel hidden).
	const todos = useMemo(() => extractTodos(liveMessages), [liveMessages]);
	// Per-turn file changes: one derivation shared by the turn footer rows
	// and the diff sidebar.
	const turnChanges = useMemo(() => deriveTurnChanges(liveMessages), [liveMessages]);
	const [diffOpen, setDiffOpen] = useState(false);
	const [diffScope, setDiffScope] = useState<DiffScope>("all");

	// Ctrl+F opens/focuses the search bar; capture-phase Escape closes it
	// before the global Escape-interrupt handler sees the key.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && searchOpen) {
				e.stopPropagation();
				closeSearch();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				setSearchOpen(true);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [searchOpen]);

	// Focus the input whenever the bar opens.
	useEffect(() => {
		if (searchOpen) {
			searchInputRef.current?.focus();
		}
	}, [searchOpen]);

	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, []);

	const handleCopy = async () => {
		const ok = await onCopy();
		setCopyState(ok ? "copied" : "failed");
		setTimeout(() => setCopyState("idle"), 1500);
		setMenuOpen(false);
	};

	const composerEl = (
		<Composer
			connected={connected}
			streaming={streaming}
			working={working}
			busy={busy}
			models={models}
			model={model}
			onModelChange={onModelChange}
			thinkingLevel={thinkingLevel}
			thinkingLevels={thinkingLevels}
			onThinkingLevelChange={onThinkingLevelChange}
			sendDuringRun={sendDuringRun}
			onSendDuringRunChange={onSendDuringRunChange}
			onSubmit={onSubmit}
			onAbort={onAbort}
			aborting={aborting}
			composerFocusRequest={composerFocusRequest}
			gitState={gitState}
			onCheckoutBranch={onCheckoutBranch}
			onCreateBranch={onCreateBranch}
			workspace={workspace}
			workspaces={workspaces}
			onPickWorkspace={onPickWorkspace}
			onSelectWorkspace={onSelectWorkspace}
			queuedMessages={queuedMessages}
			queuePaused={queuePaused}
			editingQueueId={editingQueueId}
			onQueueSendNow={onQueueSendNow}
			onQueueEdit={onQueueEdit}
			onQueueDelete={onQueueDelete}
			onQueueReorder={onQueueReorder}
			onQueueCancelEdit={onQueueCancelEdit}
			customTools={customTools}
			onCustomToolsChange={onCustomToolsChange}
			modelsLoading={modelsLoading}
			commands={commands}
			showContextUsage={showContextUsage}
			stats={stats}
			workspacePath={workspace}
			externalDraft={externalDraft}
			onExternalDraftConsumed={onExternalDraftConsumed}
			onCycleThinking={onCycleThinking}
			t={t}
		/>
	);

	if (liveMessages.length === 0) {
		return (
			<main className="chat">
				{sidebarCollapsed && (
					<div
						className="collapsed-actions-bar"
						data-tauri-drag-region={isMac ? "deep" : undefined}
					>
						<CollapsedActions
							t={t}
							busy={busy}
							canGoBack={canGoBack}
							canGoForward={canGoForward}
							onToggleSidebar={onToggleSidebar}
							onBack={onBack}
							onForward={onForward}
							onNewTask={onNewTask}
						/>
					</div>
				)}
				{error && (
					<div className="error-banner" role="alert">
						{error}
					</div>
				)}
				{extensionStatus.length > 0 && (
					<div className="chat-header-status empty">
						{extensionStatus.map((s, i) => (
							<span key={i} title={s}>
								{s}
							</span>
						))}
					</div>
				)}
				<div className="chat-scroll welcome">
					<div className="empty-chat">
						<p className="empty-chat-greeting">{greeting(t)}</p>
						{composerEl}
					</div>
				</div>
			</main>
		);
	}

	return (
		<main className="chat">
			<header className="chat-header" data-tauri-drag-region={isMac ? "deep" : undefined}>
				<div className="chat-header-left">
					{sidebarCollapsed && (
						<CollapsedActions
							t={t}
							busy={busy}
							canGoBack={canGoBack}
							canGoForward={canGoForward}
							onToggleSidebar={onToggleSidebar}
							onBack={onBack}
							onForward={onForward}
							onNewTask={onNewTask}
						/>
					)}
					<h1 className="chat-title" title={session?.path}>
						{session?.title ?? t.app.newSession}
					</h1>
					{session?.model && <span className="session-model-badge">{session.model}</span>}
					{messages.length === 0 && !session && (
						<span className="session-model-badge neutral">{t.app.newSession}</span>
					)}
				</div>
				<div className="chat-header-right">
					{extensionStatus.length > 0 && (
						<div className="chat-header-status">
							{extensionStatus.map((s, i) => (
								<span key={i} title={s}>
									{s}
								</span>
							))}
						</div>
					)}
					<span className={`dot ${connected ? "on" : ""}`} />
					{connected && <span className="conn-label">{t.app.connected}</span>}
					<div className="header-menu" ref={menuRef}>
						<button
							className="icon-btn"
							disabled={!session}
							aria-label={t.chat.moreActions}
							title={t.chat.moreActions}
							aria-expanded={menuOpen}
							aria-controls={menuOpen ? menuId : undefined}
							onClick={() => setMenuOpen((v) => !v)}
						>
							<MoreIcon size={17} />
						</button>
						{menuOpen && (
							<div className="header-menu-pop" id={menuId}>
								<button
									disabled={!connected || streaming}
									onClick={() => {
										onCompact();
										setMenuOpen(false);
									}}
								>
									<ArchiveIcon size={14} />
									<span>{t.chat.compact}</span>
								</button>
								<button
									onClick={() => {
										onTree();
										setMenuOpen(false);
									}}
								>
									<BranchIcon size={14} />
									<span>{t.chat.tree}</span>
								</button>
								<button
									onClick={() => {
										onSessionInfo();
										setMenuOpen(false);
									}}
								>
									<BarChartIcon size={14} />
									<span>{t.chat.sessionInfo}</span>
								</button>
								<button onClick={handleCopy}>
									{copyState === "copied" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
									<span>{copyState === "copied" ? t.chat.copied : t.chat.copy}</span>
								</button>
								<button
									onClick={() => {
										onExport("markdown");
										setMenuOpen(false);
									}}
								>
									<DownloadIcon size={14} />
									<span>{t.chat.exportMarkdown}</span>
								</button>
								<button
									onClick={() => {
										onExport("jsonl");
										setMenuOpen(false);
									}}
								>
									<DownloadIcon size={14} />
									<span>{t.chat.exportJsonl}</span>
								</button>
								<button
									onClick={() => {
										onExportHtml();
										setMenuOpen(false);
									}}
								>
									<DownloadIcon size={14} />
									<span>{t.chat.exportHtml}</span>
								</button>
								<button
									onClick={() => {
										onImport();
										setMenuOpen(false);
									}}
								>
									<DownloadIcon size={14} />
									<span>{t.chat.import}</span>
								</button>
								<button
									onClick={() => {
										onShare();
										setMenuOpen(false);
									}}
								>
									<SparkleIcon size={14} />
									<span>{t.chat.share}</span>
								</button>
								<button
									onClick={() => {
										onCompactImages();
										setMenuOpen(false);
									}}
								>
									<BoltIcon size={14} />
									<span>{t.chat.compactImages}</span>
								</button>
								<button
									onClick={() => {
										onRename();
										setMenuOpen(false);
									}}
								>
									<EditIcon size={14} />
									<span>{t.chat.rename}</span>
								</button>
								<button
									onClick={() => {
										onReveal();
										setMenuOpen(false);
									}}
								>
									<FolderOpenIcon size={14} />
									<span>{t.chat.reveal}</span>
								</button>
								<div className="menu-sep" />
								<button
									onClick={() => {
										onHotkeys();
										setMenuOpen(false);
									}}
								>
									<SearchIcon size={14} />
									<span>{t.chat.hotkeys}</span>
								</button>
								<button
									onClick={() => {
										onArchive();
										setMenuOpen(false);
									}}
								>
									<ArchiveIcon size={14} />
									<span>{t.chat.archiveSession}</span>
								</button>
								<button
									className="menu-danger"
									onClick={() => {
										onDelete();
										setMenuOpen(false);
									}}
								>
									<TrashIcon size={14} />
									<span>{t.chat.deleteSession}</span>
								</button>
							</div>
						)}
					</div>
				</div>
			</header>

			{error && (
					<div className="error-banner" role="alert">
						{error}
					</div>
				)}

			{searchOpen && (
				<div className="session-search-bar">
					<SearchIcon size={14} />
					<input
						ref={searchInputRef}
						value={searchQuery}
						placeholder={t.chat.searchInSession}
						onChange={(e) => {
							setSearchQuery(e.target.value);
							setActiveHit(0);
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								closeSearch();
							} else if (e.key === "Enter") {
								e.preventDefault();
								stepHit(e.shiftKey ? -1 : 1);
							}
						}}
					/>
					<span className="session-search-count">
						{searchQuery
							? hits.length
								? `${Math.min(activeHit + 1, hits.length)}/${hits.length}`
								: t.chat.noMatches
							: ""}
					</span>
					<button
						className="icon-btn"
						title={t.chat.searchPrev}
						disabled={hits.length === 0}
						onClick={() => stepHit(-1)}
					>
						<ChevronUpIcon size={14} />
					</button>
					<button
						className="icon-btn"
						title={t.chat.searchNext}
						disabled={hits.length === 0}
						onClick={() => stepHit(1)}
					>
						<ChevronDownIcon size={14} />
					</button>
					<button
						className="icon-btn"
						title={t.app.close}
						aria-label={t.app.close}
						onClick={closeSearch}
					>
						<XIcon size={14} />
					</button>
				</div>
			)}

			<div className="chat-main-row">
				<div className="chat-col">
					<div className="chat-scroll">
						<MessageList
							messages={messages}
							stream={stream}
							streaming={streaming}
							textStreaming={textStreaming}
							working={working}
							t={t}
							searchQuery={searchOpen ? searchQuery : undefined}
							searchActiveMessageId={activeMessageId}
							turnStartTime={turnStartTime}
							turnChanges={turnChanges}
							onOpenDiff={() => setDiffOpen(true)}
							onCopyMessage={onCopyMessage}
							onRecallMessage={onRecallMessage}
							onForkMessage={onForkMessage}
							onRetryMessage={onRetryMessage}
							onCompact={onCompactSession}
							onOpenSettings={openSettings}
						/>
						{subagentRuns.length > 0 && <SubagentLivePanel runs={subagentRuns} t={t} />}
					</div>
					<TodoPanel todos={todos} agentActive={working} t={t} />
					{Object.values(extensionWidgets)
						.filter((w) => w.placement === "aboveEditor")
						.map((w, i) => (
							<div className="ext-widget" key={`above-${i}`}>
								{w.lines.map((line, j) => (
									<div className="ext-widget-line" key={j}>
										{line}
									</div>
								))}
							</div>
						))}

					{composerEl}

					{Object.values(extensionWidgets)
						.filter((w) => w.placement === "belowEditor")
						.map((w, i) => (
							<div className="ext-widget below" key={`below-${i}`}>
								{w.lines.map((line, j) => (
									<div className="ext-widget-line" key={j}>
										{line}
									</div>
								))}
							</div>
						))}
				</div>
				<DiffSidebar
					open={diffOpen}
					turns={turnChanges}
					scope={diffScope}
					onScopeChange={setDiffScope}
					onClose={() => setDiffOpen(false)}
					branch={gitState?.isRepository ? (gitState.currentBranch ?? null) : null}
					t={t}
				/>
			</div>
		</main>
	);
});
