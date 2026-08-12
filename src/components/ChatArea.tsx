import { useEffect, useRef, useState } from "react";
import type { Attachment, ChatMessage, QueuedChatMessage, SendBehavior, SessionStats } from "../chat-types";
import type { AgentToolName } from "../settings";
import type { PiCommand } from "../pi";
import type { MessageCatalog } from "../i18n";
import type { GitBranchState, PiSessionInfo } from "../pi";
import {
	ArchiveIcon,
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	EditIcon,
	FolderOpenIcon,
	MoreIcon,
	TrashIcon,
} from "../icons";
import { Composer, type ModelEntry } from "./Composer";
import { MessageList, TurnWaitIndicator } from "./MessageList";

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
	onReveal,
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
}: {
	t: MessageCatalog;
	session: PiSessionInfo | null;
	messages: ChatMessage[];
	streaming: boolean;
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
	onReveal: () => void;
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
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const menuRef = useRef<HTMLDivElement>(null);

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
			t={t}
		/>
	);

	if (messages.length === 0) {
		return (
			<main className="chat">
				{error && <div className="error-banner">{error}</div>}
				<div className="chat-scroll welcome">
					<div className="empty-chat">
						<div className="empty-chat-watermark" aria-hidden>
							π
						</div>
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

			<div className="chat-scroll">
				<MessageList
					messages={messages}
					streaming={streaming}
					onFork={onForkFromMessage}
					t={t}
				/>
				{showTurnWait && !streaming && (
					<div className="turn-wait-wrap">
						<TurnWaitIndicator />
					</div>
				)}
			</div>

			{composerEl}
		</main>
	);
}
