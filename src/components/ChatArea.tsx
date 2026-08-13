import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ChatMessage, QueuedChatMessage, SendBehavior, SessionStats } from "../chat-types";
import type { AgentToolName } from "../settings";
import type { PiCommand } from "../pi";
import type { MessageCatalog } from "../i18n";
import type { GitBranchState, PiSessionInfo } from "../pi";
import {
	ArchiveIcon,
	BarChartIcon,
	BoltIcon,
	BranchIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	DownloadIcon,
	EditIcon,
	FolderOpenIcon,
	MoreIcon,
	SearchIcon,
	SparkleIcon,
	TrashIcon,
	XIcon,
} from "../icons";
import { Composer, type ModelEntry } from "./Composer";
import { MessageList, TurnWaitIndicator } from "./MessageList";
import { searchMessages } from "./message-utils";

function greeting(t: MessageCatalog): string {
	const h = new Date().getHours();
	if (h < 12) return t.chat.greetingMorning;
	if (h < 18) return t.chat.greetingAfternoon;
	return t.chat.greetingEvening;
}

export function ChatArea({
	t,
	session,
	messages,
	streaming,
	working,
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
	onForkFromMessage,
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
	customTools,
	onCustomToolsChange,
	showContextUsage,
	modelsLoading,
	commands,
	extensionWidgets,
	externalDraft,
	onExternalDraftConsumed,
	onCycleThinking,
}: {
	t: MessageCatalog;
	session: PiSessionInfo | null;
	messages: ChatMessage[];
	streaming: boolean;
	working: boolean;
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
	) => void;
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
	onForkFromMessage: (entryId: string) => void;
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
	customTools: AgentToolName[];
	onCustomToolsChange: (tools: AgentToolName[]) => void;
	showContextUsage: boolean;
	modelsLoading: boolean;
	commands: PiCommand[];
	extensionWidgets: Record<
		string,
		{ lines: string[]; placement: "aboveEditor" | "belowEditor" }
	>;
	externalDraft: string | null;
	onExternalDraftConsumed: () => void;
	onCycleThinking: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const menuRef = useRef<HTMLDivElement>(null);
	// In-session search (Ctrl+F): hits over all message blocks, one active.
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeHit, setActiveHit] = useState(0);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const hits = useMemo(
		() => searchMessages(messages, searchQuery),
		[messages, searchQuery],
	);
	const activeMessageId = useMemo(() => {
		if (!searchOpen || hits.length === 0) return null;
		const hit = hits[Math.min(activeHit, hits.length - 1)];
		return messages[hit.messageIndex]?.id ?? null;
	}, [searchOpen, hits, activeHit, messages]);

	const stepHit = (delta: number) => {
		if (hits.length === 0) return;
		setActiveHit((cur) => (cur + delta + hits.length) % hits.length);
	};

	const closeSearch = () => {
		setSearchOpen(false);
		setSearchQuery("");
		setActiveHit(0);
	};

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

	if (messages.length === 0) {
		return (
			<main className="chat">
				{error && <div className="error-banner">{error}</div>}
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
			<header className="chat-header">
				<div className="chat-header-left">
					<h1 className="chat-title" title={session?.path}>
						{session?.title ?? t.app.newSession}
					</h1>
					{session?.model && (
						<span className="session-model-badge">{session.model}</span>
					)}
					{messages.length === 0 && !session && (
						<span className="session-model-badge neutral">
							{t.app.newSession}
						</span>
					)}
				</div>
				<div className="chat-header-right">
					<span className={`dot ${connected ? "on" : ""}`} />
					{connected && <span className="conn-label">{t.app.connected}</span>}
					<div className="header-menu" ref={menuRef}>
						<button
							className="icon-btn"
							disabled={!session}
							onClick={() => setMenuOpen((v) => !v)}
						>
							<MoreIcon size={17} />
						</button>
						{menuOpen && (
							<div className="header-menu-pop">
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
									{copyState === "copied" ? (
										<CheckIcon size={14} />
									) : (
										<CopyIcon size={14} />
									)}
									<span>
										{copyState === "copied" ? t.chat.copied : t.chat.copy}
									</span>
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
								<button onClick={() => { onRename(); setMenuOpen(false); }}>
									<EditIcon size={14} />
									<span>{t.chat.rename}</span>
								</button>
								<button onClick={() => { onReveal(); setMenuOpen(false); }}>
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
									onClick={() => { onArchive(); setMenuOpen(false); }}
								>
									<ArchiveIcon size={14} />
									<span>{t.chat.archiveSession}</span>
								</button>
								<button
									className="menu-danger"
									onClick={() => { onDelete(); setMenuOpen(false); }}
								>
									<TrashIcon size={14} />
									<span>{t.chat.deleteSession}</span>
								</button>
							</div>
						)}
					</div>
				</div>
			</header>

			{error && <div className="error-banner">{error}</div>}

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
					<button className="icon-btn" title={t.app.close} onClick={closeSearch}>
						<XIcon size={14} />
					</button>
				</div>
			)}

			<div className="chat-scroll">
				<MessageList
					messages={messages}
					streaming={streaming}
					onFork={onForkFromMessage}
					t={t}
					searchQuery={searchOpen ? searchQuery : undefined}
					searchActiveMessageId={activeMessageId}
				/>
				{showTurnWait && !streaming && (
					<div className="turn-wait-wrap">
						<TurnWaitIndicator t={t} />
					</div>
				)}
			</div>

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
		</main>
	);
}
