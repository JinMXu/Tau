import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type DragEvent,
} from "react";
import type { Attachment, SendBehavior } from "../chat-types";
import { formatBytes } from "../format";
import { projectNameFromPath, type MessageCatalog } from "../i18n";
import type { GitBranchState, PiCommand } from "../pi";
import { externalEdit, projectFiles } from "../pi";
import {
	CheckIcon,
	ChevronDownIcon,
	EditIcon,
	FileIcon,
	FolderIcon,
	FolderOpenIcon,
	GripVerticalIcon,
	LoaderIcon,
	PaperclipIcon,
	PlusIcon,
	SearchIcon,
	SendIcon,
	StopIcon,
	TrashIcon,
	WrenchIcon,
	XIcon,
	BoltIcon,
	BrainIcon,
	BranchIcon,
} from "../icons";
import type { AgentToolName } from "../settings";
import { ALL_AGENT_TOOLS } from "../settings";
import type { QueuedChatMessage, SessionStats } from "../chat-types";
export interface ModelEntry {
	provider: string;
	id: string;
	name?: string;
	thinkingLevels?: string[];
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 300 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function AttachmentChip({
	attachment,
	onRemove,
}: {
	attachment: Attachment;
	onRemove: () => void;
}) {
	return (
		<div className="attachment-chip">
			{attachment.kind === "image" && attachment.dataUrl ? (
				<img className="attachment-thumb" src={attachment.dataUrl} alt="" />
			) : (
				<span className="attachment-file-icon">
					<PaperclipIcon size={12} />
				</span>
			)}
			<span className="attachment-name" title={attachment.path ?? attachment.name}>
				{attachment.name}
			</span>
			<span className="attachment-size">{formatBytes(attachment.size)}</span>
			<button className="icon-btn attachment-remove" onClick={onRemove}>
				<XIcon size={12} />
			</button>
		</div>
	);
}

function ContextUsageRing({
	stats,
	t,
}: {
	stats: SessionStats;
	t: MessageCatalog;
}) {
	const usage = stats.contextUsage;
	if (!usage) return null;
	const pct = Math.round(Math.max(0, Math.min(100, usage.percent)));
	const R = 15.5;
	const C = 2 * Math.PI * R;
	const tone = pct >= 80 ? "danger" : pct >= 55 ? "warn" : "ok";
	const remaining = Math.max(0, usage.contextWindow - usage.tokens);
	const fmt = (n: number) => n.toLocaleString();
	const perf = stats.perf;
	const fmtTTFT = (ms: number) =>
		ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
	return (
		<div className={`context-ring-wrap ${tone}`}>
			<svg
				viewBox="0 0 36 36"
				className="context-ring"
				width="16"
				height="16"
				role="img"
				aria-label={`${t.chat.contextUsage}: ${pct}%`}
			>
				<circle cx="18" cy="18" r={R} className="ring-bg" />
				<circle
					cx="18"
					cy="18"
					r={R}
					className="ring-fg"
					strokeDasharray={`${C} ${C}`}
					strokeDashoffset={C - (C * pct) / 100}
					transform="rotate(-90 18 18)"
				/>
			</svg>
			<div className="context-tooltip">
				<div className="context-tooltip-header">
					<span className="context-tooltip-label">
						{t.chat.contextUsage}
					</span>
					<span className="context-tooltip-pct">{pct}%</span>
				</div>
				<div className="context-tooltip-bar">
					<div
						className="context-tooltip-bar-fill"
						style={{ width: `${pct}%` }}
					/>
				</div>
				<div className="context-tooltip-rows">
					<div className="context-tooltip-row">
						<span className="ct-label">{t.chat.contextWindow}</span>
						<span className="ct-value">
							{fmt(usage.tokens)} / {fmt(usage.contextWindow)}
						</span>
					</div>
					<div className="context-tooltip-row">
						<span className="ct-label">{t.chat.remaining}</span>
						<span className="ct-value">{fmt(remaining)}</span>
					</div>
				</div>
				{stats.tokens && (
					<>
						<div className="context-tooltip-divider" />
						<div className="context-tooltip-rows">
							<div className="context-tooltip-row">
								<span className="ct-label">{t.chat.tokensIn}</span>
								<span className="ct-value">{fmt(stats.tokens.input)}</span>
							</div>
							<div className="context-tooltip-row">
								<span className="ct-label">{t.chat.tokensOut}</span>
								<span className="ct-value">{fmt(stats.tokens.output)}</span>
							</div>
							{stats.tokens.cacheRead > 0 && (
								<div className="context-tooltip-row">
									<span className="ct-label">{t.chat.tokensCache}</span>
									<span className="ct-value">
										{fmt(stats.tokens.cacheRead)}
									</span>
								</div>
							)}
						</div>
					</>
				)}
			{perf && (perf.cacheHitRate != null || perf.avgTTFT != null || perf.tokensPerSec != null) && (
				<>
					<div className="context-tooltip-divider" />
					<div className="context-tooltip-rows">
						{perf.cacheHitRate != null && (
							<div className="context-tooltip-row">
								<span className="ct-label">{t.chat.cacheHitRate}</span>
								<span className="ct-value">{perf.cacheHitRate.toFixed(1)}%</span>
							</div>
						)}
						{perf.avgTTFT != null && (
							<div className="context-tooltip-row">
								<span className="ct-label">{t.chat.avgTTFT}</span>
								<span className="ct-value">{fmtTTFT(perf.avgTTFT)}</span>
							</div>
						)}
						{perf.tokensPerSec != null && (
							<div className="context-tooltip-row">
								<span className="ct-label">{t.chat.tokensPerSec}</span>
								<span className="ct-value">
									{perf.tokensPerSec.toFixed(1)} t/s
								</span>
							</div>
						)}
					</div>
				</>
			)}
			</div>
		</div>
	);
}

export function Composer({
	connected,
	streaming,
	working,
	busy,
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
	composerFocusRequest,
	gitState,
	onCheckoutBranch,
	onCreateBranch,
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
	modelsLoading,
	commands,
	showContextUsage,
	stats,
	workspacePath,
	externalDraft,
	onExternalDraftConsumed,
	onCycleThinking,
	t,
}: {
	connected: boolean;
	streaming: boolean;
	working: boolean;
	busy: boolean;
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
	composerFocusRequest: number;
	gitState: GitBranchState | null;
	onCheckoutBranch: (name: string) => void;
	onCreateBranch: (name: string) => void;
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
	modelsLoading: boolean;
	commands: PiCommand[];
	showContextUsage: boolean;
	stats: SessionStats | null;
	workspacePath: string | null;
	externalDraft: string | null;
	onExternalDraftConsumed: () => void;
	onCycleThinking: () => void;
	t: MessageCatalog;
}) {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [modelQuery, setModelQuery] = useState("");
	const [isComposing, setIsComposing] = useState(false);
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
	const [branchCreating, setBranchCreating] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const [branchQuery, setBranchQuery] = useState("");
	const [branchMenuUp, setBranchMenuUp] = useState(false);
	const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
	const [workspaceQuery, setWorkspaceQuery] = useState("");
	const [workspaceMenuUp, setWorkspaceMenuUp] = useState(false);
	const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
	const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
	const [dragQueueId, setDragQueueId] = useState<string | null>(null);
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashDismissed, setSlashDismissed] = useState(false);
	// ---- `@` file reference + prompt history ----
	const [projectFileCache, setProjectFileCache] = useState<string[]>([]);
	const [atIndex, setAtIndex] = useState(0);
	const caretRef = useRef(0);
	// Bumped whenever the caret moves (click/select/keyup) so the `@` menu
	// re-evaluates against the new caret position.
	const [caretTick, setCaretTick] = useState(0);
	const [history, setHistory] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("pi-gui.promptHistory.v1");
			return raw ? (JSON.parse(raw) as string[]) : [];
		} catch {
			return [];
		}
	});
	const historyRef = useRef(history);
	const historyIndexRef = useRef(-1);
	const [extError, setExtError] = useState<string | null>(null);
	const [attachError, setAttachError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const branchMenuRef = useRef<HTMLDivElement>(null);
	const workspaceMenuRef = useRef<HTMLDivElement>(null);
	const thinkingMenuRef = useRef<HTMLDivElement>(null);
	const toolsMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (composerFocusRequest > 0 && connected) {
			textareaRef.current?.focus();
		}
	}, [composerFocusRequest, connected]);

	// Extension `set_editor_text`: prefill the draft and focus the composer.
	useEffect(() => {
		if (externalDraft == null) return;
		setText(externalDraft);
		onExternalDraftConsumed();
		textareaRef.current?.focus();
	}, [externalDraft, onExternalDraftConsumed]);

	// Keep the prompt history ref in sync; persist on change.
	useEffect(() => {
		historyRef.current = history;
		try {
			localStorage.setItem(
				"pi-gui.promptHistory.v1",
				JSON.stringify(history.slice(0, 100)),
			);
		} catch {
			/* ignore */
		}
	}, [history]);

	// Cache the project file list for `@` completion (once per workspace).
	useEffect(() => {
		let cancelled = false;
		if (!workspacePath) {
			setProjectFileCache([]);
			return;
		}
		void projectFiles(workspacePath)
			.then((files) => {
				if (!cancelled) setProjectFileCache(files);
			})
			.catch(() => {
				if (!cancelled) setProjectFileCache([]);
			});
		return () => {
			cancelled = true;
		};
	}, [workspacePath]);

	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (
				modelMenuRef.current &&
				!modelMenuRef.current.contains(e.target as Node)
			) {
				setModelMenuOpen(false);
			}
			if (
				branchMenuRef.current &&
				!branchMenuRef.current.contains(e.target as Node)
			) {
				setBranchMenuOpen(false);
				setBranchCreating(false);
			}
			if (
				workspaceMenuRef.current &&
				!workspaceMenuRef.current.contains(e.target as Node)
			) {
				setWorkspaceMenuOpen(false);
			}
			if (
				thinkingMenuRef.current &&
				!thinkingMenuRef.current.contains(e.target as Node)
			) {
				setThinkingMenuOpen(false);
			}
			if (
				toolsMenuRef.current &&
				!toolsMenuRef.current.contains(e.target as Node)
			) {
				setToolsMenuOpen(false);
			}
		}
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, []);

	const createBranch = useCallback(() => {
		const name = newBranchName.trim();
		if (!name) return;
		onCreateBranch(name);
		setNewBranchName("");
		setBranchCreating(false);
		setBranchMenuOpen(false);
	}, [newBranchName, onCreateBranch]);

	const autoSize = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
	}, []);

	useEffect(() => {
		autoSize();
	}, [text, autoSize]);

	const submit = useCallback(
		async (behavior?: SendBehavior) => {
			const trimmed = text.trim();
			// While the agent is streaming, Enter sends via the active
			// send-during-run mode (steer/followUp); App queues it and
			// delivers it when pi is ready (pi rejects a plain `prompt`
			// mid-stream, so the message must never go out unqueued).
			if (
				(!trimmed && attachments.length === 0) ||
				(!editingQueueId && !connected && !workspace)
			)
				return;
			// App.submit resolves `false` when it rejects the send (no
			// workspace, connect canceled, API-key dialog canceled) — keep the
			// draft so the user's text is never silently destroyed.
			const accepted = await onSubmit(
				trimmed,
				attachments,
				behavior ?? "normal",
				editingQueueId,
			).catch(() => false);
			if (!accepted) return;
			// Prompt history: remember what was actually sent.
			if (trimmed) {
				setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, 100));
			}
			historyIndexRef.current = -1;
			setText("");
			setAttachments([]);
			requestAnimationFrame(autoSize);
			textareaRef.current?.focus();
		},
		[text, attachments, connected, workspace, onSubmit, autoSize, editingQueueId],
	);

	const startQueueEdit = useCallback(
		(item: QueuedChatMessage) => {
			onQueueEdit(item);
			setText(item.text);
			setAttachments(item.attachments);
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			});
		},
		[onQueueEdit],
	);

	const cancelQueueEdit = useCallback(() => {
		onQueueCancelEdit();
		textareaRef.current?.focus();
	}, [onQueueCancelEdit]);

	const toggleCustomTool = useCallback(
		(tool: AgentToolName) => {
			const current = new Set(customTools.length ? customTools : ALL_AGENT_TOOLS);
			// Never allow disabling the last remaining tool (empty list means
			// "all tools enabled" in the settings model).
			if (current.has(tool) && current.size === 1) return;
			if (current.has(tool)) {
				current.delete(tool);
			} else {
				current.add(tool);
			}
			onCustomToolsChange(ALL_AGENT_TOOLS.filter((t) => current.has(t)));
		},
		[customTools, onCustomToolsChange],
	);

	const addFiles = useCallback(
		async (files: File[]) => {
			for (const file of files) {
				if (file.size > MAX_ATTACHMENT_BYTES) {
					// Don't silently drop it — tell the user which file was skipped.
					setAttachError(t.chat.attachTooLarge.replace("{name}", file.name));
					continue;
				}
				const isImage = file.type.startsWith("image/");
				try {
					let attachment: Attachment;
					if (isImage) {
						attachment = {
							id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
							name: file.name,
							kind: "image",
							dataUrl: await readFileAsDataUrl(file),
							size: file.size,
						};
					} else if (file.size <= MAX_TEXT_ATTACHMENT_BYTES) {
						const textContent = await file.text();
						attachment = {
							id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
							name: file.name,
							kind: "file",
							text: textContent,
							size: file.size,
						};
					} else {
						attachment = {
							id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
							name: file.name,
							kind: "file",
							size: file.size,
						};
					}
					setAttachments((prev) => [...prev, attachment]);
				} catch {
					// A FileReader/text() failure must not reject the whole batch
					// (callers fire-and-forget it); surface it instead.
					setAttachError(t.chat.attachFailed.replace("{name}", file.name));
				}
			}
		},
		[t],
	);

	const handlePaste = useCallback(
		async (e: ClipboardEvent<HTMLTextAreaElement>) => {
			const items = Array.from(e.clipboardData.items);
			const images = items.filter((i) => i.type.startsWith("image/"));
			if (images.length === 0) return;
			e.preventDefault();
			const files = images
				.map((i) => i.getAsFile())
				.filter((f): f is File => f !== null);
			if (files.length) await addFiles(files);
		},
		[addFiles],
	);

	const handleDrop = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			const files = Array.from(e.dataTransfer.files);
			if (files.length) void addFiles(files);
		},
		[addFiles],
	);

	const selectedModel = models.find(
		(m) => `${m.provider}/${m.id}` === model,
	);
	const availableThinkingLevels =
		(selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : thinkingLevels) ??
		[];
	const normalizedQuery = modelQuery.trim().toLowerCase();
	const visibleModels = normalizedQuery
		? models.filter((m) =>
				`${m.provider} ${m.id} ${m.name ?? ""}`
					.toLowerCase()
					.includes(normalizedQuery),
			)
		: models;
	const providers = [...new Set(visibleModels.map((m) => m.provider))];

	const normalizedWorkspaceQuery = workspaceQuery.trim().toLowerCase();
	const visibleWorkspaces = normalizedWorkspaceQuery
		? workspaces.filter((w) =>
				`${projectNameFromPath(w)} ${w}`
					.toLowerCase()
					.includes(normalizedWorkspaceQuery),
			)
		: workspaces;

	const normalizedBranchQuery = branchQuery.trim().toLowerCase();
	const visibleBranches = gitState
		? normalizedBranchQuery
			? gitState.branches.filter((b) =>
					b.toLowerCase().includes(normalizedBranchQuery),
				)
			: gitState.branches
		: [];

	const toggleWorkspaceMenu = useCallback(() => {
		if (workspaceMenuOpen) {
			setWorkspaceMenuOpen(false);
		} else {
			// Side effects moved out of the state updater (StrictMode may
			// double-invoke updater bodies).
			setWorkspaceQuery("");
			setBranchMenuOpen(false);
			setBranchCreating(false);
			setWorkspaceMenuOpen(true);
		}
	}, [workspaceMenuOpen]);

	const toggleBranchMenu = useCallback(() => {
		if (branchMenuOpen) {
			setBranchCreating(false);
			setBranchMenuOpen(false);
		} else {
			setBranchQuery("");
			setWorkspaceMenuOpen(false);
			setBranchMenuOpen(true);
		}
	}, [branchMenuOpen]);

	const toggleThinkingMenu = useCallback(() => {
		setThinkingMenuOpen((v) => {
			if (v) return false;
			setModelMenuOpen(false);
			return true;
		});
	}, []);

	// The workspace/branch menus are anchored to the context row above the
	// composer, which hugs the bottom of the window — a downward-opening menu
	// would run past the window edge and get clipped (ending up behind the
	// taskbar). When there isn't enough room below the chip, flip the menu to
	// open upward instead.
	const fitMenuDirection = useCallback(
		(
			open: boolean,
			wrapRef: React.RefObject<HTMLDivElement | null>,
			selector: string,
			setOpenUp: (up: boolean) => void,
		) => {
			if (!open) return;
			const wrap = wrapRef.current;
			const menu = wrap?.querySelector(selector) as HTMLElement | null;
			if (!wrap || !menu) return;
			const rect = wrap.getBoundingClientRect();
			const spaceBelow = window.innerHeight - rect.bottom;
			const spaceAbove = rect.top;
			const height = menu.offsetHeight;
			if (height <= spaceBelow) {
				setOpenUp(false);
				return;
			}
			// Prefer the direction with enough room; when neither fits, pick
			// whichever has more space (the list scrolls either way).
			setOpenUp(spaceAbove >= height || spaceAbove > spaceBelow);
		},
		[],
	);

	useLayoutEffect(() => {
		fitMenuDirection(
			workspaceMenuOpen,
			workspaceMenuRef,
			".workspace-menu",
			setWorkspaceMenuUp,
		);
	}, [workspaceMenuOpen, workspaceQuery, fitMenuDirection]);

	useLayoutEffect(() => {
		fitMenuDirection(branchMenuOpen, branchMenuRef, ".branch-menu", setBranchMenuUp);
	}, [branchMenuOpen, branchQuery, branchCreating, fitMenuDirection]);

	// Level ids come from Pi ("off" | "minimal" | "low" | ...); show a
	// localized name when we know the id, otherwise fall back to the raw id.
	const thinkingLabel = (level: string): string =>
		(t.chat.thinkingLevels as Record<string, string>)[level] ?? level;

	const hasDraft = Boolean(text.trim()) || attachments.length > 0;

	// "Running" = a run is in flight (working spans the whole run, from
	// submit until agent_settled) even between messages, when streaming is
	// briefly false. Streaming alone would make the stop button / busy
	// placeholder flicker on every message boundary (text → tool → result).
	const running = working || streaming;

	// ---- slash commands ----
	// The menu is active while the draft is exactly a `/` prefix (no spaces),
	// so typing arguments after picking a command closes it.
	const slashMatch = text.match(/^\/(\S*)$/);
	const slashQuery = slashMatch?.[1]?.toLowerCase() ?? "";
	const slashOpen =
		Boolean(slashMatch) && commands.length > 0 && !slashDismissed;
	const slashFiltered = slashOpen
		? slashQuery
			? commands.filter(
					(c) =>
						c.name.toLowerCase().includes(slashQuery) ||
						c.description?.toLowerCase().includes(slashQuery),
				)
			: commands
		: [];
	const activeSlash =
		slashFiltered[Math.min(slashIndex, slashFiltered.length - 1)] ?? null;

	// Reset the selection when the query changes; re-open after dismissal
	// once the draft no longer starts with `/`.
	useEffect(() => {
		setSlashIndex(0);
	}, [slashQuery]);
	useEffect(() => {
		if (!slashMatch) setSlashDismissed(false);
	}, [slashMatch]);

	// Keep the highlighted command visible while navigating with ↑/↓.
	const slashListRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const list = slashListRef.current;
		const active = list?.querySelector(".slash-item.active") as
			| HTMLElement
			| null;
		if (!list || !active) return;
		const itemTop = active.offsetTop;
		const itemBottom = itemTop + active.offsetHeight;
		if (itemTop < list.scrollTop) {
			list.scrollTop = itemTop;
		} else if (itemBottom > list.scrollTop + list.clientHeight) {
			list.scrollTop = itemBottom - list.clientHeight;
		}
	}, [slashIndex, slashFiltered.length]);

	const insertSlashCommand = useCallback(
		(command: PiCommand) => {
			setText(`/${command.name} `);
			setSlashIndex(0);
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				el.focus();
				const pos = el.value.length;
				el.setSelectionRange(pos, pos);
			});
		},
		[],
	);

	const slashSourceLabel = useCallback(
		(source: PiCommand["source"]): string => {
			if (source === "extension") return t.chat.slashSourceExtension;
			if (source === "prompt") return t.chat.slashSourcePrompt;
			return t.chat.slashSourceSkill;
		},
		[t],
	);

	// ---- `@` file reference menu ----
	// The menu is active while the text immediately before the caret matches
	// `@query` at a word boundary. Query chars are limited to path characters.
	const atMatch = useMemo(() => {
		const before = text.slice(0, caretRef.current);
		const m = before.match(/(?:^|[\s(])(@[^\s@]*)$/);
		if (!m) return null;
		const token = m[1];
		const query = token.slice(1).toLowerCase();
		return { token, query };
		// caretRef is a ref; caretTick forces re-evaluation on caret moves.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, caretTick]);
	const atOpen = atMatch !== null && projectFileCache.length > 0;
	const atFiltered = useMemo(() => {
		if (!atMatch) return [];
		const q = atMatch.query;
		if (!q) return projectFileCache.slice(0, 60);
		// Match against the full path AND the trailing name part.
		const scored = projectFileCache
			.filter((f) => f.toLowerCase().includes(q))
			.map((f) => {
				const lower = f.toLowerCase();
				const idx = lower.lastIndexOf(q);
				// Prefer matches near the file name, then shorter paths.
				return { f, score: idx + f.length / 1000 };
			})
			.sort((a, b) => a.score - b.score)
			.slice(0, 60)
			.map((x) => x.f);
		return scored;
	}, [atMatch, projectFileCache]);
	const activeAt =
		atFiltered[Math.min(atIndex, atFiltered.length - 1)] ?? null;

	useEffect(() => {
		setAtIndex(0);
	}, [atMatch?.query]);

	const insertAtReference = useCallback((path: string) => {
		if (!atMatch) return;
		const before = text.slice(0, caretRef.current);
		const after = text.slice(caretRef.current);
		const start = before.lastIndexOf(atMatch.token);
		const replacement = path;
		setText(before.slice(0, start) + replacement + after);
		setAtIndex(0);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (!el) return;
			el.focus();
			const pos = start + replacement.length;
			el.setSelectionRange(pos, pos);
			caretRef.current = pos;
		});
	}, [text, atMatch]);

	// ---- prompt history navigation ----
	const historyPrev = useCallback(() => {
		const list = historyRef.current;
		if (list.length === 0) return;
		const next =
			historyIndexRef.current < 0
				? 0
				: Math.min(historyIndexRef.current + 1, list.length - 1);
		historyIndexRef.current = next;
		setText(list[next] ?? "");
		setAttachments([]);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) el.setSelectionRange(el.value.length, el.value.length);
		});
	}, []);
	const historyNext = useCallback(() => {
		if (historyIndexRef.current < 0) return;
		const next = historyIndexRef.current - 1;
		historyIndexRef.current = next;
		setText(next < 0 ? "" : (historyRef.current[next] ?? ""));
		setAttachments([]);
	}, []);

	// Highlight layer for the textarea: known `/command` words get a subtle
	// tinted background rendered *under* the transparent textarea, so typed
	// text itself stays untouched.
	const highlightRef = useRef<HTMLDivElement>(null);
	const slashHighlight = useMemo(() => {
		const known = new Set(commands.map((c) => c.name));
		const out: React.ReactNode[] = [];
		const re = /(\/\S+)/g;
		let last = 0;
		let m: RegExpExecArray | null;
		let key = 0;
		while ((m = re.exec(text))) {
			if (m.index > last) out.push(text.slice(last, m.index));
			const word = m[1];
			// Command name = first token of the word (params follow a space).
			const name = word.slice(1).split(/[^\w:-]/)[0];
			out.push(
				known.has(name) ? (
					<mark key={key++} className="slash-highlight">
						{word}
					</mark>
				) : (
					word
				),
			);
			last = m.index + word.length;
		}
		if (last < text.length) out.push(text.slice(last));
		// Trailing zero-width space keeps the last (empty) line tall so the
		// highlight stays aligned with the textarea when it wraps.
		out.push("\u200b");
		return out;
	}, [text, commands]);

	const syncHighlightScroll = useCallback(() => {
		const el = textareaRef.current;
		const hl = highlightRef.current;
		if (el && hl) hl.scrollTop = el.scrollTop;
	}, []);

	return (
		<div className="composer-wrap" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
			{queuedMessages.length > 0 && (
				<div className="queue-list-wrap">
					<div className="queue-list">
						{queuedMessages.map((item) => (
							<div
								key={item.id}
								className={`queue-item ${editingQueueId === item.id ? "editing" : ""} ${dragQueueId === item.id ? "dragging" : ""}`}
								draggable
								onDragStart={(e) => {
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", item.id);
									setDragQueueId(item.id);
								}}
								onDragOver={(e) => {
									e.preventDefault();
									const activeId = dragQueueId ?? e.dataTransfer.getData("text/plain");
									if (activeId) onQueueReorder(activeId, item.id);
								}}
								onDragEnd={() => setDragQueueId(null)}
							>
								<GripVerticalIcon size={13} className="queue-grip" />
								<span className={`queue-mode ${item.mode}`}>
									{item.mode === "steer" ? t.chat.queueSteerBadge : t.chat.queueFollowUpBadge}
								</span>
								<span className="queue-text" title={item.text}>
									{item.text}
								</span>
								{item.attachments.length > 0 && (
									<span className="queue-attachments">
										{item.attachments.length} {t.chat.attachments}
									</span>
								)}
								<span className="queue-actions">
									<button
										className="icon-btn"
										title={t.chat.queueSendNow}
										onClick={() => onQueueSendNow(item.id)}
									>
										<SendIcon size={12} />
									</button>
									<button
										className="icon-btn"
										title={t.chat.queueEdit}
										onClick={() => startQueueEdit(item)}
									>
										<EditIcon size={12} />
									</button>
									<button
										className="icon-btn"
										title={t.chat.queueDelete}
										onClick={() => onQueueDelete(item.id)}
									>
										<TrashIcon size={12} />
									</button>
								</span>
							</div>
						))}
					</div>
					{queuePaused && (
						<div className="queue-paused-hint">{t.chat.queuePaused}</div>
					)}
				</div>
			)}
			<div className="composer-context">
					<div className="composer-select" ref={workspaceMenuRef}>
						<button
							className={`composer-chip ${workspaceMenuOpen ? "open" : ""}`}
							onClick={toggleWorkspaceMenu} aria-expanded={workspaceMenuOpen}
							title={workspace ?? t.sidebar.workspaceHint}
						>
							<FolderIcon size={13} />
							<span className="composer-chip-name">
								{workspace ? projectNameFromPath(workspace) : t.app.pickWorkspace}
							</span>
							<ChevronDownIcon size={12} />
						</button>
						{workspaceMenuOpen && (
							<div className={`workspace-menu${workspaceMenuUp ? " up" : ""}`}>
								<div className="menu-search">
									<SearchIcon size={13} />
									<input
										autoFocus
										value={workspaceQuery}
										placeholder={t.chat.searchWorkspace}
										onChange={(e) => setWorkspaceQuery(e.target.value)}
										onKeyDown={(e) => {
											e.stopPropagation();
											if (e.key === "Escape") setWorkspaceMenuOpen(false);
											if (e.key === "Enter" && visibleWorkspaces.length > 0) {
												const target = visibleWorkspaces[0];
												if (target !== workspace) onSelectWorkspace(target);
												setWorkspaceMenuOpen(false);
											}
										}}
									/>
								</div>
								<div className="workspace-menu-list">
									{visibleWorkspaces.length === 0 && (
										<div className="menu-empty">{t.chat.noWorkspaces}</div>
									)}
									{visibleWorkspaces.map((w) => {
										const active = w === workspace;
										return (
											<button
												key={w}
												className={`workspace-item ${active ? "active" : ""}`}
												title={w}
												onClick={() => {
													if (!active) onSelectWorkspace(w);
													setWorkspaceMenuOpen(false);
												}}
											>
												<FolderIcon size={13} />
												<span className="workspace-item-name">
													{projectNameFromPath(w)}
												</span>
												{active && <CheckIcon size={13} />}
											</button>
										);
									})}
								</div>
								<div className="menu-sep" />
								<button
									className="workspace-open-btn"
									onClick={() => {
										setWorkspaceMenuOpen(false);
										onPickWorkspace();
									}}
								>
									<FolderOpenIcon size={13} />
									<span>{t.chat.openFolder}</span>
								</button>
							</div>
						)}
					</div>
					{gitState?.isRepository && (
						<div className="composer-select" ref={branchMenuRef}>
							<button
								className={`composer-chip ${branchMenuOpen ? "open" : ""}`}
								disabled={!workspace}
								title={`${t.chat.gitBranch}: ${gitState.currentBranch ?? ""}${gitState.dirtyFileCount > 0 ? ` · ${t.chat.gitDirty.replace("{count}", String(gitState.dirtyFileCount))}` : ""}`}
								onClick={toggleBranchMenu} aria-expanded={branchMenuOpen}
							>
								<BranchIcon size={13} />
								<span className="composer-chip-name mono">
									{gitState.currentBranch ?? t.chat.gitNotRepo}
								</span>
								{gitState.dirtyFileCount > 0 && (
									<span
										className="branch-dirty"
										title={t.chat.gitDirty.replace("{count}", String(gitState.dirtyFileCount))}
									>
										{gitState.dirtyFileCount}
									</span>
								)}
								<ChevronDownIcon size={12} />
							</button>
							{branchMenuOpen && (
								<div className={`branch-menu drop-down${branchMenuUp ? " up" : ""}`}>
									<div className="menu-search">
										<SearchIcon size={13} />
										<input
											autoFocus
											value={branchQuery}
											placeholder={t.chat.searchBranch}
											onChange={(e) => setBranchQuery(e.target.value)}
											onKeyDown={(e) => {
												e.stopPropagation();
												if (e.key === "Escape") {
													setBranchMenuOpen(false);
													setBranchCreating(false);
												}
												if (e.key === "Enter") {
													const target = visibleBranches.find(
														(b) => b !== gitState.currentBranch,
													);
													if (target) {
														onCheckoutBranch(target);
														setBranchMenuOpen(false);
													}
												}
											}}
										/>
									</div>
									<div className="menu-label">{t.chat.branches}</div>
									<div className="branch-menu-list">
										{visibleBranches.length === 0 && (
											<div className="menu-empty">{t.chat.noBranches}</div>
										)}
										{visibleBranches.map((name) => {
												const active = name === gitState.currentBranch;
												return (
													<button
														key={name}
														className={`branch-item ${active ? "active" : ""}`}
														title={t.chat.checkoutBranch}
														onClick={() => {
															if (!active) onCheckoutBranch(name);
															setBranchMenuOpen(false);
														}}
													>
														<BranchIcon size={13} />
														<span className="branch-item-text">
															<span className="branch-item-name">{name}</span>
															{active && gitState.dirtyFileCount > 0 && (
																<span className="branch-item-sub">
																	{t.chat.gitDirtyDetail.replace(
																		"{count}",
																		String(gitState.dirtyFileCount),
																	)}
																</span>
															)}
														</span>
														{active && <CheckIcon size={13} />}
													</button>
												);
											})}
									</div>
									{branchCreating ? (
										<div className="branch-create">
											<input
												autoFocus
												value={newBranchName}
												placeholder={t.chat.newBranchPlaceholder}
												onChange={(e) => setNewBranchName(e.target.value)}
												onKeyDown={(e) => {
													e.stopPropagation();
													if (e.key === "Enter") createBranch();
													if (e.key === "Escape") setBranchCreating(false);
												}}
											/>
										</div>
									) : (
										<button
											className="branch-create-btn"
											onClick={() => setBranchCreating(true)}
										>
											<PlusIcon size={13} />
											<span>{t.chat.createCheckoutBranch}</span>
										</button>
									)}
								</div>
							)}
						</div>
					)}
			</div>
			<div className="composer">
				{atOpen && (
					<div className="at-menu">
						<div className="slash-menu-title">{t.chat.referenceFile}</div>
						{atFiltered.length === 0 ? (
							<div className="slash-menu-empty">{t.chat.slashNoCommands}</div>
						) : (
							<div className="slash-menu-list">
								{atFiltered.map((f, i) => (
									<button
										key={f}
										className={`slash-item ${i === atIndex ? "active" : ""}`}
										onMouseEnter={() => setAtIndex(i)}
										onClick={() => insertAtReference(f)}
									>
										{f.endsWith("/") ? (
											<FolderIcon size={13} />
										) : (
											<FileIcon size={13} />
										)}
										<span className="slash-name mono">{f}</span>
									</button>
								))}
							</div>
						)}
					</div>
				)}
				{slashOpen && (
					<div className="slash-menu">
						<div className="slash-menu-title">{t.chat.slashCommands}</div>
						{slashFiltered.length === 0 ? (
							<div className="slash-menu-empty">{t.chat.slashNoCommands}</div>
						) : (
							<div className="slash-menu-list" ref={slashListRef}>
								{slashFiltered.map((c, i) => (
									<button
										key={`${c.source}:${c.name}`}
										className={`slash-item ${i === slashIndex ? "active" : ""}`}
										onMouseEnter={() => setSlashIndex(i)}
										onClick={() => insertSlashCommand(c)}
									>
										<span className="slash-name">/{c.name}</span>
										<span className="slash-desc">
											{c.description ?? ""}
										</span>
										<span className={`slash-source ${c.source}`}>
											{slashSourceLabel(c.source)}
										</span>
									</button>
								))}
							</div>
						)}
					</div>
				)}
				{editingQueueId && (
					<div className="queue-editing-hint">
						<span>{t.chat.queueEditing}</span>
						<button className="link-btn" onClick={cancelQueueEdit}>
							{t.chat.queueCancelEdit}
						</button>
					</div>
				)}
				{extError && (
					<div className="ext-editor-error">
						<span>{extError}</span>
						<button className="link-btn" onClick={() => setExtError(null)}>
							{t.app.close}
						</button>
					</div>
				)}
				{attachError && (
					<div className="ext-editor-error">
						<span>{attachError}</span>
						<button className="link-btn" onClick={() => setAttachError(null)}>
							{t.app.close}
						</button>
					</div>
				)}
				{attachments.length > 0 && (
					<div className="attachment-strip">
						{attachments.map((a) => (
							<AttachmentChip
								key={a.id}
								attachment={a}
								onRemove={() =>
									setAttachments((prev) =>
										prev.filter((x) => x.id !== a.id),
									)
								}
							/>
						))}
					</div>
				)}
			<div
				className={`composer-input-wrap${isComposing ? " composing" : ""}`}
			>
				<textarea
					ref={textareaRef}
					rows={2}
					value={text}
					disabled={!connected && !workspace}
					placeholder={
						!workspace
							? t.chat.noWorkspace
							: running
								? t.chat.placeholderBusy
								: t.chat.placeholder
					}
					onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
						caretRef.current = e.target.selectionStart;
						setText(e.target.value);
					}}
					onSelect={(e) => {
						caretRef.current = (e.target as HTMLTextAreaElement).selectionStart;
						setCaretTick((n) => n + 1);
					}}
					onClick={(e) => {
						caretRef.current = (e.target as HTMLTextAreaElement).selectionStart;
						setCaretTick((n) => n + 1);
					}}
					onKeyUp={(e) => {
						caretRef.current = (e.target as HTMLTextAreaElement).selectionStart;
						setCaretTick((n) => n + 1);
					}}
					onScroll={syncHighlightScroll}
					onPaste={handlePaste}
					onKeyDown={(e) => {
						// `@` file-reference menu navigation (takes priority).
						if (atOpen) {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setAtIndex((i) => Math.min(i + 1, atFiltered.length - 1));
								return;
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setAtIndex((i) => Math.max(i - 1, 0));
								return;
							}
							if (e.key === "Tab" && activeAt) {
								e.preventDefault();
								insertAtReference(activeAt);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								// Replace the `@query` token with a plain `@` and close.
								setText((cur) => {
									const before = cur.slice(0, caretRef.current);
									const start = atMatch ? before.lastIndexOf(atMatch.token) : -1;
									if (start < 0) return cur;
									return cur.slice(0, start) + "@" + cur.slice(caretRef.current);
								});
								return;
							}
							if (e.key === "Enter" && !e.shiftKey && activeAt) {
								e.preventDefault();
								insertAtReference(activeAt);
								return;
							}
						}
						// Slash-command menu navigation (takes priority over send).
						if (slashOpen) {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setSlashIndex((i) =>
									Math.min(i + 1, slashFiltered.length - 1),
								);
								return;
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setSlashIndex((i) => Math.max(i - 1, 0));
								return;
							}
							if (e.key === "Tab" && activeSlash) {
								e.preventDefault();
								insertSlashCommand(activeSlash);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setSlashDismissed(true);
								setSlashIndex(0);
								return;
							}
							if (
								e.key === "Enter" &&
								!e.shiftKey &&
								!isComposing &&
								!e.nativeEvent.isComposing &&
								activeSlash
							) {
								e.preventDefault();
								insertSlashCommand(activeSlash);
								return;
							}
						}
						if (e.key === "Enter" && !e.shiftKey) {
							if (isComposing || e.nativeEvent.isComposing) return;
							e.preventDefault();
							submit(editingQueueId ? "normal" : (running ? sendDuringRun : "normal"));
							return;
						}
						// Prompt history: ↑ on the first line / empty draft goes
						// back; ↓ returns to newer entries (TUI historyPrevious/Next).
						if (e.key === "ArrowUp") {
							const caret = caretRef.current;
							const atLineStart =
								caret === 0 || text.slice(0, caret).lastIndexOf("\n") === -1;
							if (!e.shiftKey && atLineStart && historyRef.current.length > 0) {
								e.preventDefault();
								historyPrev();
								return;
							}
						}
						if (e.key === "ArrowDown") {
							const caret = caretRef.current;
							const atLineEnd =
								caret === text.length ||
								text.slice(caret).indexOf("\n") === -1;
							if (!e.shiftKey && atLineEnd && historyIndexRef.current >= 0) {
								e.preventDefault();
								historyNext();
								return;
							}
						}
						// Shift+Tab cycles the thinking level (TUI shift+tab) when no
						// completion menu is open.
						if (e.shiftKey && e.key === "Tab" && !slashOpen && !atOpen) {
							e.preventDefault();
							onCycleThinking();
							return;
						}
						// Ctrl+G: edit the draft in the system editor (TUI ctrl+g).
						if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") {
							e.preventDefault();
							void (async () => {
								try {
									const edited = await externalEdit(text);
									setText(edited);
									caretRef.current = edited.length;
									requestAnimationFrame(() => {
										const el = textareaRef.current;
										if (el) {
											el.focus();
											el.setSelectionRange(edited.length, edited.length);
										}
									});
								} catch (err) {
									setExtError(String(err));
								}
							})();
							return;
						}
					}}
					onCompositionStart={() => setIsComposing(true)}
					onCompositionEnd={() => setIsComposing(false)}
				/>
				<div className="composer-highlight" ref={highlightRef} aria-hidden>
					{slashHighlight}
				</div>
				</div>
				<div className="composer-toolbar">
					<div className="composer-left">
					<button
						className="icon-btn"
						title={t.chat.attach}
						disabled={!connected && !workspace}
						onClick={() => fileInputRef.current?.click()}
					>
							<PlusIcon size={16} />
						</button>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							className="hidden-input"
							onChange={(e) => {
								const files = Array.from(e.target.files ?? []);
								e.target.value = "";
								void addFiles(files);
							}}
						/>

						{availableThinkingLevels.length > 0 && (
							<div className="composer-select" ref={thinkingMenuRef}>
								<button
									className={`composer-model-btn ${thinkingMenuOpen ? "open" : ""}`}
									disabled={!connected}
									title={t.app.thinking}
									onClick={toggleThinkingMenu} aria-expanded={thinkingMenuOpen}
								>
									<BrainIcon size={14} />
									<span className="composer-model-name">
										{thinkingLabel(thinkingLevel)}
									</span>
									<ChevronDownIcon size={13} />
								</button>
								{thinkingMenuOpen && (
									<div className="thinking-menu">
										{availableThinkingLevels.map((level) => {
											const active = level === thinkingLevel;
											return (
												<button
													key={level}
													className={`thinking-item ${active ? "active" : ""}`}
													onClick={() => {
														if (!active) onThinkingLevelChange(level);
														setThinkingMenuOpen(false);
													}}
												>
													<span className="thinking-item-name">
														{thinkingLabel(level)}
													</span>
													{active && <CheckIcon size={13} />}
												</button>
											);
										})}
									</div>
								)}
							</div>
						)}

						{running && hasDraft && (
							<div className="send-mode">
								<button
									className={`mode-btn ${sendDuringRun === "steer" ? "active" : ""}`}
									title={t.chat.steer}
									onClick={() => onSendDuringRunChange("steer")}
								>
									<BoltIcon size={14} />
									<span>{t.chat.steer}</span>
								</button>
								<button
									className={`mode-btn ${sendDuringRun === "followUp" ? "active" : ""}`}
									title={t.chat.followUp}
									onClick={() => onSendDuringRunChange("followUp")}
								>
									<span>{t.chat.followUp}</span>
								</button>
							</div>
						)}

						<div className="composer-select" ref={toolsMenuRef}>
							<button
								className={`composer-model-btn ${toolsMenuOpen ? "open" : ""}`}
								title={t.chat.customTools} aria-expanded={toolsMenuOpen}
								onClick={() => {
									setToolsMenuOpen((v) => {
										if (v) return false;
										setModelMenuOpen(false);
										setThinkingMenuOpen(false);
										return true;
									});
								}}
							>
								<WrenchIcon size={14} />
							</button>
							{toolsMenuOpen && (
								<div className="tools-menu">
									<div className="tools-menu-header">
										<span>{t.chat.customTools}</span>
										<button
											className="link-btn"
											onClick={() => onCustomToolsChange(ALL_AGENT_TOOLS)}
										>
											{t.chat.customToolsAll}
										</button>
									</div>
									<p className="tools-menu-hint">{t.chat.customToolsHint}</p>
									{ALL_AGENT_TOOLS.map((tool) => {
										const enabled =
											customTools.length === 0 || customTools.includes(tool);
										return (
											<button
												key={tool}
												className={`tools-item ${enabled ? "enabled" : ""}`}
												onClick={() => toggleCustomTool(tool)}
											>
												<span className="tools-item-name">
													{(t.chat.agentToolNames as Record<string, string>)[tool] ?? tool}
												</span>
												<span className="tools-switch" aria-hidden>
													<span className="tools-knob" />
												</span>
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>

					<div className="composer-right">
						{showContextUsage && stats && (
							<ContextUsageRing stats={stats} t={t} />
						)}
						<div className="composer-select" ref={modelMenuRef}>
							<button
								className="composer-model-btn"
								onClick={() => setModelMenuOpen((v) => !v)} aria-expanded={modelMenuOpen}
							>
								<span className="model-dot" />
								<span className="composer-model-name">
									{modelsLoading
										? t.settings.loading
										: (selectedModel?.name ??
												selectedModel?.id ??
												(model || t.app.model))}
								</span>
								{modelsLoading ? (
									<LoaderIcon size={13} className="spin" />
								) : (
									<ChevronDownIcon size={13} />
								)}
							</button>
							{modelMenuOpen && (
								<div className="model-menu">
									<div className="menu-search">
										<SearchIcon size={13} />
										<input
											autoFocus
											value={modelQuery}
											placeholder={t.chat.searchModels}
											onChange={(e) => setModelQuery(e.target.value)}
											onKeyDown={(e) => {
												e.stopPropagation();
												if (e.key === "Escape") setModelMenuOpen(false);
											}}
										/>
									</div>
									<div className="model-menu-list">
										{!connected ? (
											<div className="model-menu-empty">
												{t.chat.connectToPickModel}
											</div>
										) : providers.length === 0 ? (
											<div className="model-menu-empty">{t.chat.noModels}</div>
										) : providers.map((provider) => (
											<div className="model-group" key={provider}>
												<div className="model-group-label">{provider}</div>
												{visibleModels
													.filter((m) => m.provider === provider)
													.map((m) => {
														const value = `${m.provider}/${m.id}`;
														const active = value === model;
														return (
															<button
																key={value}
																className={`model-item ${active ? "active" : ""}`}
																onClick={() => {
																	onModelChange(value);
																	setModelMenuOpen(false);
																}}
															>
																<span className="model-item-name">
																	{m.name ?? m.id}
																</span>
																<span className="model-item-id">{m.id}</span>
																{active && <CheckIcon size={14} />}
															</button>
														);
													})}
											</div>
										))}
									</div>
								</div>
							)}
						</div>
						{running && (
							<button
								className="send-btn stop"
								onClick={onAbort}
								disabled={aborting}
								title={t.chat.abort}
							>
								{aborting ? (
									<LoaderIcon size={16} className="spin" />
								) : (
									<StopIcon size={16} />
								)}
							</button>
						)}
						{/* The send button stays visible while running only when there
							is something to send — the message is queued
							(steer/followUp) instead of being dropped. With no draft,
							the stop button alone takes the slot. */}
						{(!running || hasDraft) && (
							<button
								className="send-btn"
								disabled={busy || !hasDraft || (!connected && !workspace)}
								onClick={() => submit("normal")}
								title={t.chat.send}
							>
								<SendIcon size={16} />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
