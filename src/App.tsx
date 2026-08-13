import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
	archiveSession as archiveSessionCmd,
	authSetKey,
	authStatus,
	binaryInfo,
	compactSessionImages,
	deleteSession as deleteSessionCmd,
	exportChat,
	exportHtml,
	gitBranchState,
	gitCheckoutBranch,
	gitCreateBranch,
	listArchivedSessions,
	listSessions,
	newWindow,
	openWorkspace,
	piMoveSession,
	purgeSession,
	readSession,
	restoreSession,
	revealSession,
	send,
	start,
	status,
	stop,
	type AuthProviderStatus,
	type GitBranchState,
	type PiArchivedSession,
	type PiBinaryInfo,
	type PiCommand,
	type PiEvent,
	type PiParsedMessage,
	type PiSessionInfo,
} from "./pi";
import {
	getMessages,
} from "./i18n";
import {
	loadSettings,
	resolveTheme,
	saveSettings,
	type AppSettings,
} from "./settings";
import type {
	Attachment,
	Block,
	ChatMessage,
	QueuedChatMessage,
	SendBehavior,
	SessionStats,
} from "./chat-types";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { SearchOverlay } from "./components/SearchOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { ArchivedPreview } from "./components/ArchivedPreview";
import {
	chatMessageToMarkdown,
	parsedMessagesToMarkdown,
} from "./components/message-utils";
import {
	ExtensionDialog,
	type ExtensionRequest,
} from "./components/ExtensionDialog";
import type { ModelEntry } from "./components/Composer";
import "./App.css";
import { TitleBar } from "./components/TitleBar";

let nextId = 1;

const STORAGE_KEYS = {
	expanded: "pi-gui.sidebar.expanded.v1",
	width: "pi-gui.sidebar.width.v1",
	collapsed: "pi-gui.sidebar.collapsed.v1",
	model: "pi-gui.model.v1",
	thinking: "pi-gui.thinking.v1",
	sendMode: "pi-gui.sendMode.v1",
	workspace: "pi-gui.workspace.v1",
	recentWorkspaces: "pi-gui.recentWorkspaces.v1",
	sessionOrder: "pi-gui.sessionOrder.v1",
	lastSession: "pi-gui.lastSession.v1",
	pinned: "pi-gui.pinnedSessions.v1",
};

/**
 * Per-command RPC response timeouts (ms). Provider/model/command discovery
 * can take tens of seconds, compaction can take minutes, while lightweight
 * state reads should fail fast instead of wedging the UI on a stuck pipe.
 */
const RESPONSE_TIMEOUTS: Record<string, number> = {
	get_available_models: 90000,
	get_available_thinking_levels: 90000,
	get_commands: 90000,
	compact: 300000,
	get_messages: 30000,
	switch_session: 30000,
	fork: 30000,
	clone: 30000,
	new_session: 30000,
	get_state: 15000,
	get_session_stats: 15000,
	set_model: 15000,
	set_thinking_level: 15000,
	set_session_name: 15000,
	set_auto_retry: 15000,
};

function loadExpanded(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEYS.expanded);
		if (!raw) return new Set(["__default__"]);
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set(["__default__"]);
	}
}

function formatBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${n} B`;
}

interface ConfirmState {
	title: string;
	body: string;
	confirmLabel?: string;
	onConfirm: () => void;
}

interface RenameState {
	title: string;
	initial: string;
}

export default function App() {
	const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
	const t = useMemo(() => getMessages(settings.language), [settings.language]);
	// Latest translations for event listeners registered once at mount.
	const tRef = useRef(t);
	tRef.current = t;

	const [binary, setBinary] = useState<PiBinaryInfo | null>(null);
	const [binError, setBinError] = useState<string | null>(null);
	const [workspace, setWorkspace] = useState<string | null>(() =>
		localStorage.getItem(STORAGE_KEYS.workspace),
	);
	const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEYS.recentWorkspaces);
			return raw ? (JSON.parse(raw) as string[]) : [];
		} catch {
			return [];
		}
	});
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
	// Optimistic placeholder for a brand-new task: shown in the sidebar the
	// moment a prompt is sent, before pi has flushed the session file to disk.
	const [pendingSession, setPendingSession] = useState<PiSessionInfo | null>(
		null,
	);
	const [archived, setArchived] = useState<PiArchivedSession[]>([]);
	const [selectedSessionPath, setSelectedSessionPath] = useState<string | null>(
		null,
	);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [streaming, setStreaming] = useState(false);
	const [working, setWorking] = useState(false);
	const [models, setModels] = useState<ModelEntry[]>([]);
	const [commands, setCommands] = useState<PiCommand[]>([]);
	const [model, setModel] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.model) ?? "",
	);
	const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
	const [thinkingLevel, setThinkingLevel] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.thinking) ?? settings.thinkingLevel,
	);
	const [sendDuringRun, setSendDuringRun] = useState<"steer" | "followUp">(
		() =>
			(localStorage.getItem(STORAGE_KEYS.sendMode) as "steer" | "followUp") ??
			(settings.sendDuringRunMode === "queue" ? "followUp" : "steer"),
	);
	const [stderr, setStderr] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [aborting, setAborting] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => localStorage.getItem(STORAGE_KEYS.collapsed) === "1",
	);
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		const w = Number(localStorage.getItem(STORAGE_KEYS.width));
		return w >= 200 && w <= 340 ? w : 280;
	});
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
		loadExpanded,
	);
	const [sessionOrder, setSessionOrder] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEYS.sessionOrder);
			return raw ? (JSON.parse(raw) as string[]) : [];
		} catch {
			return [];
		}
	});
	// Read-only preview of an archived session (messages + export).
	const [archivedPreview, setArchivedPreview] = useState<{
		path: string;
		title: string;
		messages: PiParsedMessage[];
	} | null>(null);
	const [pinnedSessions, setPinnedSessions] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEYS.pinned);
			return raw ? (JSON.parse(raw) as string[]) : [];
		} catch {
			return [];
		}
	});
	const [composerFocusRequest, setComposerFocusRequest] = useState(0);
	const [gitState, setGitState] = useState<GitBranchState | null>(null);
	const [stats, setStats] = useState<SessionStats | null>(null);
	const [extensionRequest, setExtensionRequest] =
		useState<ExtensionRequest | null>(null);
	const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
	const [renameState, setRenameState] = useState<RenameState | null>(null);
	const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);

	// ---- follow-up / steering queue (managed locally, delivered one at a time) ----
	const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
	const [queuePaused, setQueuePaused] = useState(false);
	const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
	const queuedRef = useRef<QueuedChatMessage[]>([]);
	const queuePausedRef = useRef(false);
	// Working state mirror for event-handler reads without re-subscribing.
	const workingRef = useRef(false);
	const streamingRef = useRef(false);
	const settingsRef = useRef(settings);
	// Monotonic counter bumped every time a new run starts (submit / queued
	// delivery). The abort watchdog captures the epoch when it arms and only
	// force-kills when the epoch is unchanged — so a run started after the
	// abort can never be killed by the leftover watchdog.
	const runEpochRef = useRef(0);

	// ---- provider API-key gate (chat-time key dialog) ----
	const [authProviders, setAuthProviders] = useState<AuthProviderStatus[]>([]);
	const [apiKeyDialog, setApiKeyDialog] = useState<{ provider: string } | null>(
		null,
	);
	const apiKeyResolveRef = useRef<((saved: boolean) => void) | null>(null);

	useEffect(() => {
		queuedRef.current = queuedMessages;
	}, [queuedMessages]);
	useEffect(() => {
		queuePausedRef.current = queuePaused;
	}, [queuePaused]);
	useEffect(() => {
		workingRef.current = working;
	}, [working]);
	useEffect(() => {
		streamingRef.current = streaming;
	}, [streaming]);
	useEffect(() => {
		settingsRef.current = settings;
	}, [settings]);

	// Hot-apply the auto-retry toggle without reconnecting.
	useEffect(() => {
		if (!connected) return;
		send({ type: "set_auto_retry", enabled: settings.autoRetryOnFailure }).catch(
			() => {
				/* older pi */
			},
		);
	}, [settings.autoRetryOnFailure, connected]);

	const pendingRef = useRef(new Map<string, (v: unknown) => void>());
	const sessionPathRef = useRef<string | null>(null);
	const isNewSessionRef = useRef(false);
	// Guards against overlapping connect() calls (double clicks, racing
	// auto-connect effects): the second caller awaits the in-flight attempt.
	const connectInFlightRef = useRef<Promise<boolean> | null>(null);
	// Cooldown/failure tracking for the auto-connect effect so a broken pi
	// binary doesn't produce a reconnect loop.
	const autoConnectStateRef = useRef({ failures: 0 });

	// ---- settings side effects ----
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const theme = resolveTheme(settings.theme, mq.matches);
			document.documentElement.dataset.theme = theme;
			document.documentElement.dataset.colorScale = settings.colorScale;
			document.documentElement.dataset.density = settings.density;
			// Keep the document language in sync with the UI language
			// (spell-check, screen readers, `<html lang>`).
			document.documentElement.lang =
				settings.language === "zh" ? "zh-CN" : "en";
			document.documentElement.style.setProperty(
				"--ousia-chat-font-size",
				`${settings.fontSize}px`,
			);
			// Typography tokens (chat column).
			const widthMap: Record<string, string> = {
				standard: "760px",
				wide: "920px",
				extraWide: "1080px",
			};
			const lineMap: Record<string, string> = {
				compact: "1.45",
				standard: "1.65",
				relaxed: "1.9",
			};
			const fontMap: Record<string, string> = {
				system: "var(--font-sans)",
				lxgwWenkai: '"LXGW WenKai", "霞鹜文楷", var(--font-sans)',
				zhuqueFangsong: '"Zhuque Fangsong", "朱雀仿宋", var(--font-sans)',
			};
			document.documentElement.style.setProperty(
				"--chat-max-width",
				widthMap[settings.chatContentWidth] ?? "760px",
			);
			document.documentElement.style.setProperty(
				"--ousia-chat-line-height",
				lineMap[settings.chatLineSpacing] ?? "1.65",
			);
			document.documentElement.style.setProperty(
				"--chat-font",
				fontMap[settings.chatFontFamily] ?? "var(--font-sans)",
			);
		};
		apply();
		mq.addEventListener("change", apply);
		saveSettings(settings);
		return () => mq.removeEventListener("change", apply);
	}, [settings]);

	// Settings-page changes to the default send mode also update the live
	// toggle (runtime composer switches only touch the state, not settings).
	useEffect(() => {
		setSendDuringRun(
			settings.sendDuringRunMode === "queue" ? "followUp" : "steer",
		);
		localStorage.setItem(
			STORAGE_KEYS.sendMode,
			settings.sendDuringRunMode === "queue" ? "followUp" : "steer",
		);
	}, [settings.sendDuringRunMode]);

	// Rebuild the native menu when the interface language changes.
	useEffect(() => {
		invoke("rebuild_menu", { lang: settings.language }).catch(() => {
			/* ignore */
		});
	}, [settings.language]);

	// ---- persistence of misc UI state ----
	useEffect(() => {
		localStorage.setItem(
			STORAGE_KEYS.expanded,
			JSON.stringify([...expandedProjects]),
		);
	}, [expandedProjects]);
	useEffect(() => {
		localStorage.setItem(STORAGE_KEYS.sessionOrder, JSON.stringify(sessionOrder));
	}, [sessionOrder]);
	useEffect(() => {
		localStorage.setItem(STORAGE_KEYS.pinned, JSON.stringify(pinnedSessions));
	}, [pinnedSessions]);
	useEffect(() => {
		localStorage.setItem(STORAGE_KEYS.width, String(sidebarWidth));
		localStorage.setItem(STORAGE_KEYS.collapsed, sidebarCollapsed ? "1" : "0");
	}, [sidebarWidth, sidebarCollapsed]);
	useEffect(() => {
		localStorage.setItem(STORAGE_KEYS.model, model);
	}, [model]);
	useEffect(() => {
		localStorage.setItem(STORAGE_KEYS.thinking, thinkingLevel);
	}, [thinkingLevel]);
	useEffect(() => {
		localStorage.setItem(STORAGE_KEYS.sendMode, sendDuringRun);
	}, [sendDuringRun]);
	useEffect(() => {
		if (!workspace) return;
		localStorage.setItem(STORAGE_KEYS.workspace, workspace);
		setRecentWorkspaces((prev) => {
			const next = [workspace, ...prev.filter((w) => w !== workspace)].slice(0, 12);
			localStorage.setItem(STORAGE_KEYS.recentWorkspaces, JSON.stringify(next));
			return next;
		});
	}, [workspace]);

	const toast = useCallback((text: string) => {
		const id = nextId++;
		setToasts((prev) => [...prev, { id, text }]);
		setTimeout(
			() => setToasts((prev) => prev.filter((x) => x.id !== id)),
			2600,
		);
	}, []);

	const refreshSessions = useCallback(async (): Promise<PiSessionInfo[]> => {
		let list: PiSessionInfo[] = [];
		try {
			list = await listSessions();
			setSessions(list);
		} catch {
			/* ignore */
		}
		try {
			setArchived(await listArchivedSessions());
		} catch {
			/* ignore */
		}
		return list;
	}, []);

	const refreshGit = useCallback(async (dir: string | null) => {
		if (!dir) {
			setGitState(null);
			return;
		}
		try {
			setGitState(await gitBranchState(dir));
		} catch {
			setGitState(null);
		}
	}, []);

	useEffect(() => {
		void refreshGit(workspace);
	}, [workspace, refreshGit]);

	// ---- pi event handling ----
	const patchLast = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
		setMessages((prev) => {
			const idx = prev.length - 1;
			if (idx < 0) return prev;
			const role = prev[idx].role;
			if (role !== "assistant" && role !== "tool") return prev;
			const next = [...prev];
			next[idx] = fn(next[idx]);
			return next;
		});
	}, []);

	const handleResponse = useCallback(
		async (command: Record<string, unknown>): Promise<PiEvent> => {
			const id = `gui-${nextId++}`;
			const timeoutMs =
				RESPONSE_TIMEOUTS[String(command.type)] ?? 60000;
			const event = await new Promise<PiEvent>((resolve, reject) => {
				const timer = setTimeout(() => {
					if (pendingRef.current.delete(id))
						reject(new Error("timeout waiting for pi response"));
				}, timeoutMs);
				pendingRef.current.set(id, ((e: PiEvent) => {
					clearTimeout(timer);
					resolve(e);
				}) as (v: unknown) => void);
				send(command, id).catch((e) => {
					clearTimeout(timer);
					pendingRef.current.delete(id);
					reject(e);
				});
			});
			if (!event.success) {
				throw new Error(event.error ?? "pi command failed");
			}
			return event;
		},
		[],
	);

	// Poll for the on-disk session file of a just-created task so the sidebar
	// can promote its optimistic placeholder to the real session as soon as pi
	// flushes the file (usually within a second of the first prompt).
	const discoverNewSession = useCallback(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 350));
			let file: string | null = null;
			try {
				const r = await handleResponse({ type: "get_state" });
				file =
					((r.data as { sessionFile?: string | null } | undefined)
						?.sessionFile as string | null | undefined) ?? null;
			} catch {
				/* pi may still be starting; keep polling */
			}
			// Only touch the refs/selection when the path actually changes
			// (the loop also runs while the user may have switched sessions).
			if (file && sessionPathRef.current !== file) {
				sessionPathRef.current = file;
				setSelectedSessionPath(file);
				localStorage.setItem(STORAGE_KEYS.lastSession, file);
			}
			const list = await refreshSessions();
			if (file && list.some((s) => s.path === file)) {
				setPendingSession(null);
				return;
			}
		}
	}, [handleResponse, refreshSessions]);

	const refreshStats = useCallback(async () => {
		try {
			const r = await handleResponse({ type: "get_session_stats" });
			setStats(r.data as SessionStats);
		} catch {
			/* older pi or no session */
		}
	}, [handleResponse]);

	// Serialize attachments into pi's ImageContent format.
	const attachmentsToImages = useCallback((attachments: Attachment[]) => {
		return attachments
			.filter((a) => a.kind === "image" && a.dataUrl)
			.map((a) => {
				const parts = a.dataUrl!.split(",");
				const mimeType =
					a.dataUrl!
						.split(";")[0]
						.split(":")
						.slice(1)
						.join(":") || "image/png";
				return { type: "image", mimeType, data: parts[1] ?? "" };
			});
	}, []);

	const attachmentsToText = useCallback((attachments: Attachment[]) => {
		let fullText = "";
		for (const a of attachments.filter((x) => x.kind === "file")) {
			if (a.text != null) {
				fullText += `\n<file name="${a.name}">\n${a.text}\n</file>`;
			} else {
				fullText += `\n<file name="${a.path ?? a.name}"></file>`;
			}
		}
		return fullText;
	}, []);

	// Take the first queued message and send it to pi. `sender` picks the RPC
	// command: "steer" when the agent is mid-turn (delivered after the current
	// tool call), "prompt" when it is idle. The queue ref is updated
	// synchronously so back-to-back delivery triggers can't double-send.
	const deliverQueuedNext = useCallback(
		async (sender: "steer" | "prompt") => {
			if (queuePausedRef.current) return;
			const next = queuedRef.current[0];
			if (!next) return;
			queuedRef.current = queuedRef.current.slice(1);
			setQueuedMessages(queuedRef.current);
			if (editingQueueId === next.id) setEditingQueueId(null);
			const message = next.text + attachmentsToText(next.attachments);
			const images = attachmentsToImages(next.attachments);
			// Optimistic user message (pi's message_start echo only attaches the
			// entry id to the latest user message, it doesn't render one).
			setMessages((prev) => [
				...prev,
				{
					id: nextId++,
					role: "user",
					blocks: [{ kind: "text", text: message }],
					streaming: false,
				},
			]);
			runEpochRef.current += 1;
			setWorking(true);
			try {
				if (sender === "steer" && workingRef.current) {
					await send({ type: "steer", message, images });
				} else {
					await send({ type: "prompt", message, images });
				}
			} catch (e) {
				setError(String(e));
				setWorking(false);
			}
		},
		[attachmentsToImages, attachmentsToText, editingQueueId],
	);

	// Queue operations exposed to the composer.
	const queueSendNow = useCallback(
		async (id: string) => {
			const item = queuedRef.current.find((m) => m.id === id);
			if (!item) return;
			queuedRef.current = queuedRef.current.filter((m) => m.id !== id);
			setQueuedMessages(queuedRef.current);
			setQueuePaused(false);
			setEditingQueueId((cur) => (cur === id ? null : cur));
			const message = item.text + attachmentsToText(item.attachments);
			const images = attachmentsToImages(item.attachments);
			setMessages((prev) => [
				...prev,
				{
					id: nextId++,
					role: "user",
					blocks: [{ kind: "text", text: message }],
					streaming: false,
				},
			]);
			runEpochRef.current += 1;
			setWorking(true);
			try {
				if (workingRef.current) {
					await send({ type: "steer", message, images });
				} else {
					await send({ type: "prompt", message, images });
				}
			} catch (e) {
				setError(String(e));
				setWorking(false);
			}
		},
		[attachmentsToImages, attachmentsToText],
	);

	const queueEdit = useCallback((id: string) => {
		setEditingQueueId((cur) => (cur === id ? null : id));
	}, []);

	const queueDelete = useCallback((id: string) => {
		queuedRef.current = queuedRef.current.filter((m) => m.id !== id);
		setQueuedMessages(queuedRef.current);
		setEditingQueueId((cur) => (cur === id ? null : cur));
	}, []);

	const queueReorder = useCallback((activeId: string, overId: string) => {
		if (activeId === overId) return;
		const from = queuedRef.current.findIndex((m) => m.id === activeId);
		const to = queuedRef.current.findIndex((m) => m.id === overId);
		if (from < 0 || to < 0) return;
		const next = [...queuedRef.current];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		queuedRef.current = next;
		setQueuedMessages(next);
	}, []);

	const handleEvent = useCallback(
		(event: PiEvent) => {
			if (event.type === "response") {
				const id = event.id;
				if (id && pendingRef.current.has(id)) {
					const resolve = pendingRef.current.get(id)!;
					pendingRef.current.delete(id);
					resolve(event);
				}
				return;
			}
			if (event.type === "extension_ui_request") {
				const method = event.method as string | undefined;
				if (method === "notify") {
					toast(String(event.message ?? ""));
					return;
				}
				if (method === "select" || method === "confirm" || method === "input") {
					setExtensionRequest({
						id: String(event.id),
						method,
						title: event.title as string | undefined,
						message: event.message as string | undefined,
						options: (event.options as string[] | undefined) ?? [],
						placeholder: event.placeholder as string | undefined,
					});
				}
				return;
			}
			if (event.type === "message_start") {
				const message = event.message as { role?: string; id?: string } | undefined;
				if (message?.role === "assistant") {
					setMessages((prev) => [
						...prev,
						{
							id: nextId++,
							role: "assistant",
							blocks: [],
							streaming: true,
						},
					]);
					setStreaming(true);
				} else if (message?.role === "toolResult") {
					setMessages((prev) => [
						...prev,
						{
							id: nextId++,
							role: "tool",
							blocks: [],
							streaming: true,
						},
					]);
				} else if (message?.role === "user") {
					// Attach the entry id to the most recent user message so it can be
					// forked later.
					const entryId = message.id;
					if (entryId) {
						setMessages((prev) => {
							const idx = [...prev]
								.map((m, i) => ({ m, i }))
								.filter(({ m }) => m.role === "user")
								.pop();
							if (!idx) return prev;
							const next = [...prev];
							next[idx.i] = { ...next[idx.i], entryId };
							return next;
						});
					}
				}
				return;
			}
			if (event.type === "message_end") {
				const message = event.message as
					| {
							role?: string;
							stopReason?: string;
							errorMessage?: string;
							toolName?: string;
							isError?: boolean;
							content?: {
								type?: string;
								text?: string;
								thinking?: string;
								name?: string;
								arguments?: unknown;
							}[];
					  }
					| undefined;
				if (message?.role === "assistant") {
					const blocks: Block[] = (message.content ?? [])
						.map((item): Block | null => {
							if (item.type === "text")
								return { kind: "text", text: item.text ?? "" };
							if (item.type === "thinking")
								return { kind: "thinking", text: item.thinking ?? "" };
							if (item.type === "toolCall" || item.type === "tool_call") {
								return {
									kind: "tool",
									name: item.name ?? "tool",
									args:
										item.arguments !== undefined
											? JSON.stringify(item.arguments, null, 2)
											: "",
								};
							}
							return null;
						})
						.filter((b): b is Block => b !== null);
					const errorMsg =
						message.stopReason === "error"
							? (message.errorMessage ?? "error")
							: undefined;
					patchLast((m) => ({
						...m,
						blocks,
						streaming: false,
						error: errorMsg ?? m.error,
					}));
				} else if (message?.role === "toolResult") {
					const text = (message.content ?? [])
						.filter((item) => item.type === "text")
						.map((item) => item.text ?? "")
						.join("");
					patchLast((m) => ({
						...m,
						blocks: [
							{
								kind: "tool",
								name: message.toolName ?? "tool",
								args: text,
								result: true,
								error: message.isError ? true : undefined,
							},
						],
						streaming: false,
					}));
				}
				setStreaming(false);
				return;
			}
			if (event.type === "message_update") {
				const ame = event.assistantMessageEvent;
				if (!ame) return;
				switch (ame.type) {
					case "text_start":
						patchLast((m) => ({
							...m,
							blocks: [...m.blocks, { kind: "text", text: "" }],
						}));
						break;
					case "text_delta":
						patchLast((m) => {
							const blocks = [...m.blocks];
							const last = blocks[blocks.length - 1];
							if (last?.kind === "text") {
								blocks[blocks.length - 1] = {
									kind: "text",
									text: last.text + (ame.delta ?? ""),
								};
							}
							return { ...m, blocks };
						});
						break;
					case "text_end":
						patchLast((m) => {
							const blocks = [...m.blocks];
							const last = blocks[blocks.length - 1];
							if (last?.kind === "text" && ame.content !== undefined) {
								blocks[blocks.length - 1] = {
									kind: "text",
									text: ame.content,
								};
							}
							return { ...m, blocks };
						});
						break;
					case "thinking_start":
						patchLast((m) => ({
							...m,
							blocks: [...m.blocks, { kind: "thinking", text: "" }],
						}));
						break;
					case "thinking_delta":
						patchLast((m) => {
							const blocks = [...m.blocks];
							const last = blocks[blocks.length - 1];
							if (last?.kind === "thinking") {
								blocks[blocks.length - 1] = {
									kind: "thinking",
									text: last.text + (ame.delta ?? ""),
								};
							}
							return { ...m, blocks };
						});
						break;
					case "toolcall_start":
						patchLast((m) => ({
							...m,
							blocks: [
								...m.blocks,
								{ kind: "tool", name: "…", args: "" },
							],
						}));
						break;
					case "toolcall_delta":
						patchLast((m) => {
							const blocks = [...m.blocks];
							const last = blocks[blocks.length - 1];
							if (last?.kind === "tool") {
								blocks[blocks.length - 1] = {
									kind: "tool",
									name: last.name,
									args: last.args + (ame.delta ?? ""),
								};
							}
							return { ...m, blocks };
						});
						break;
					case "toolcall_end": {
						const toolCall = ame.toolCall as
							| { name?: string; arguments?: unknown }
							| undefined;
						patchLast((m) => {
							const blocks = [...m.blocks];
							const last = blocks[blocks.length - 1];
							if (last?.kind === "tool") {
								blocks[blocks.length - 1] = {
									kind: "tool",
									name: toolCall?.name ?? last.name,
									args:
										toolCall?.arguments !== undefined
											? JSON.stringify(toolCall.arguments, null, 2)
											: last.args,
								};
							}
							return { ...m, blocks };
						});
						break;
					}
				}
				return;
			}
			if (
				event.type === "agent_end" ||
				event.type === "agent_settled" ||
				event.type === "agent_error"
			) {
				patchLast((m) => ({ ...m, streaming: false }));
				setStreaming(false);
				setWorking(false);
				setPendingSession(null);
				setAborting(false);
				void refreshSessions();
				void refreshStats();
				// agent_settled is emitted in a `finally` block after every run
				// (success, error, abort or compaction) — the only reliable point
				// where pi is truly idle, so deliver the next queued message.
				if (event.type === "agent_settled") {
					void deliverQueuedNext("prompt");
				}
				return;
			}
			if (event.type === "tool_execution_end") {
				// Steering messages are delivered between tool calls: if the head
				// of the queue is a steer message, deliver it now (pi waits until
				// the current tool call finishes). Follow-ups wait for settle.
				if (queuedRef.current[0]?.mode === "steer") {
					void deliverQueuedNext("steer");
				}
				return;
			}
			if (event.type === "session_info_changed") {
				void refreshSessions();
				return;
			}
		},
		[deliverQueuedNext, patchLast, refreshSessions, refreshStats, toast],
	);

	useEffect(() => {
		const unlisteners: Promise<() => void>[] = [];
		(async () => {
			unlisteners.push(
				listen<PiEvent>("pi://event", (e) => handleEvent(e.payload)),
				listen<string>("pi://stderr", (e) =>
					setStderr((prev) => [...prev.slice(-200), e.payload]),
				),
				listen<unknown>("pi://exit", () => {
					setConnected(false);
					setStreaming(false);
					setWorking(false);
					setPendingSession(null);
					// The backend only emits this on real crashes (deliberate
					// stops are flagged), so surface it; the auto-connect effect
					// below will try to resume the session.
					toast(tRef.current.app.piExited);
				}),
			);
			try {
				setBinary(await binaryInfo());
				setBinError(null);
			} catch (e) {
				setBinError(String(e));
			}
			await refreshSessions();
			try {
				const s = await status();
				setConnected(s.running);
				setWorkspace((prev) => prev ?? s.workspace);
				if (s.sessionFile) {
					sessionPathRef.current = s.sessionFile;
					setSelectedSessionPath(s.sessionFile);
				}
			} catch {
				/* not running */
			}
		})();
		return () => {
			unlisteners.forEach((p) => p.then((fn) => fn()));
		};
	}, [handleEvent, refreshSessions]);

	// ---- connection ----
	const loadHistory = useCallback(async (path: string) => {
		try {
			const parsed = await readSession(path);
			const items: ChatMessage[] = [];
			// Tool results in the session file don't carry the tool name, so
			// match them to the tool calls of the preceding assistant message,
			// in order.
			let pendingToolNames: string[] = [];
			for (const p of parsed) {
				const role: ChatMessage["role"] =
					p.role === "user"
						? "user"
						: p.role === "tool" || p.role === "toolResult"
							? "tool"
							: "assistant";
				const blocks: Block[] = [];
				let resultText = "";
				for (const b of p.blocks) {
					if (b.kind === "tool") {
						blocks.push({ kind: "tool", name: b.name ?? "tool", args: b.text });
					} else if (b.kind === "thinking") {
						blocks.push({ kind: "thinking", text: b.text });
					} else if (role === "tool") {
						// Result content arrives as plain text blocks; collect it
						// into a single result card below.
						resultText += b.text;
					} else {
						blocks.push({ kind: "text", text: b.text });
					}
				}
				if (role === "tool" && resultText) {
					blocks.push({
						kind: "tool",
						name: pendingToolNames.shift() ?? "tool_result",
						args: resultText,
						result: true,
					});
				}
				if (role === "assistant") {
					pendingToolNames = blocks
						.filter((x): x is Extract<Block, { kind: "tool" }> => x.kind === "tool")
						.map((x) => x.name);
				}
				items.push({
					id: nextId++,
					role,
					blocks,
					streaming: false,
					replay: true,
					timestamp: p.timestamp ?? undefined,
					entryId: p.entryId ?? null,
				});
			}
			setMessages(items);
		} catch {
			setMessages([]);
		}
	}, []);

	const connect = useCallback(
		async (
			opts?: {
				sessionFile?: string | null;
				forkOf?: string | null;
				sessionName?: string | null;
				workspace?: string | null;
			},
		): Promise<boolean> => {
			// Reuse the in-flight attempt instead of killing the pi process the
			// previous connect just spawned (that race wedged the UI on a
			// spurious pi://exit event).
			if (connectInFlightRef.current) return connectInFlightRef.current;
			const task = (async () => {
				setBusy(true);
				setError(null);
				// A fresh pi process starts with no run in flight; reset so a
				// mid-run session switch doesn't leave the working state stuck.
				setStreaming(false);
				setWorking(false);
				try {
					let ws = opts?.workspace ?? workspace;
					const explicitWs = opts?.workspace ?? null;
					if (!ws) {
						ws = await openWorkspace();
						if (!ws) return false;
						setWorkspace(ws);
					}
					const sessionFile = opts?.sessionFile ?? null;
					// When resuming/opening an existing session, its project dir is
					// the source of truth for the workspace — otherwise the composer
					// could show a different directory than the one pi actually
					// runs in (and where the session file lands). An explicitly
					// requested workspace wins (e.g. right after moving a session
					// to a different project).
					if (sessionFile && !explicitWs) {
						const known = sessions.find((s) => s.path === sessionFile);
						if (known?.project && known.project !== ws) {
							ws = known.project;
							setWorkspace(ws);
						}
					}
					if (sessionFile) setPendingSession(null);
					sessionPathRef.current = sessionFile;
					setSelectedSessionPath(sessionFile);
					isNewSessionRef.current = !sessionFile;
					if (sessionFile) {
						localStorage.setItem(STORAGE_KEYS.lastSession, sessionFile);
					} else {
						localStorage.removeItem(STORAGE_KEYS.lastSession);
					}
					const startOpts = {
						forkOf: opts?.forkOf ?? null,
						sessionName: opts?.sessionName ?? null,
						systemPrompt: settings.systemPrompt || null,
						tools: settings.customTools.length
							? settings.customTools
							: null,
					};
					// A session file can only be driven by ONE pi process (the
					// backend rejects a second window opening the same JSONL).
					// Fall back to a fresh session instead so a new window is
					// still usable while the other window owns the session.
					let effectiveSession = sessionFile;
					try {
						await start(ws, effectiveSession, startOpts);
					} catch (e) {
						if (
							effectiveSession &&
							String(e).includes("already open in another window")
						) {
							localStorage.removeItem(STORAGE_KEYS.lastSession);
							sessionPathRef.current = null;
							setSelectedSessionPath(null);
							isNewSessionRef.current = true;
							toast(tRef.current.app.sessionBusy);
							effectiveSession = null;
							await start(ws, null, startOpts);
						} else {
							throw e;
						}
					}
					// The RPC pipe is live as soon as pi spawns — mark connected
					// before loading history so the composer/model picker are
					// usable immediately instead of waiting on a big file read.
					setMessages([]);
					setConnected(true);
					autoConnectStateRef.current.failures = 0;
					if (effectiveSession) {
						await loadHistory(effectiveSession).catch(() => {
							/* history is best-effort; the connection is already up */
						});
					}
					return true;
				} catch (e) {
					setError(String(e));
					autoConnectStateRef.current.failures += 1;
					return false;
				} finally {
					setBusy(false);
				}
			})();
			connectInFlightRef.current = task;
			try {
				return await task;
			} finally {
				if (connectInFlightRef.current === task) {
					connectInFlightRef.current = null;
				}
			}
		},
		[
			workspace,
			loadHistory,
			settings.systemPrompt,
			settings.customTools,
			sessions,
			toast,
		],
	);

	const disconnect = useCallback(async () => {
		await stop();
		setConnected(false);
		setStreaming(false);
		setWorking(false);
		setPendingSession(null);
		setAborting(false);
		// The queue belongs to the running session; drop it on disconnect.
		queuedRef.current = [];
		setQueuedMessages([]);
		setEditingQueueId(null);
		setQueuePaused(false);
	}, []);

	const pickWorkspace = useCallback(async () => {
		const ws = await openWorkspace();
		if (!ws) return;
		setWorkspace(ws);
		if (connected) {
			void (async () => {
				await disconnect();
				setMessages([]);
				await connect({ sessionFile: null, workspace: ws });
			})();
		} else if (busy) {
			// A connect is already in flight; don't silently drop the pick.
			toast(t.chat.busyToast);
		} else {
			void connect({ sessionFile: null, workspace: ws });
		}
	}, [connected, busy, connect, disconnect, toast, t]);

	const selectWorkspace = useCallback(
		(ws: string) => {
			setWorkspace(ws);
			if (connected) {
				// Switching the workspace mid-session restarts into a fresh
				// task in the new workspace, so the session always belongs to
				// the directory shown in the composer picker.
				void (async () => {
					await disconnect();
					setMessages([]);
					await connect({ sessionFile: null, workspace: ws });
				})();
			} else if (busy) {
				toast(t.chat.busyToast);
			} else {
				void connect({ sessionFile: null, workspace: ws });
			}
		},
		[connected, busy, connect, disconnect, toast, t],
	);

	// Workspaces shown in the composer picker: recent picks first, then any
	// project dirs discovered from existing sessions.
	const workspaces = useMemo(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const w of recentWorkspaces) {
			if (!seen.has(w)) {
				seen.add(w);
				out.push(w);
			}
		}
		for (const s of sessions) {
			if (s.project && !seen.has(s.project)) {
				seen.add(s.project);
				out.push(s.project);
			}
		}
		return out;
	}, [recentWorkspaces, sessions]);

	const newTask = useCallback(async () => {
		await disconnect();
		setMessages([]);
		await connect({ sessionFile: null });
	}, [connect, disconnect]);

	const openSession = useCallback(
		async (session: PiSessionInfo) => {
			await connect({ sessionFile: session.path });
		},
		[connect],
	);

	// init effect when connected
	const [modelsLoading, setModelsLoading] = useState(false);
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		const init = async () => {
			setModelsLoading(true);
			// Model discovery probes every configured provider and can take
			// tens of seconds on a cold start — retry a few times before
			// giving up so the model picker is never stuck empty.
			let list: ModelEntry[] = [];
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const resp = await handleResponse({ type: "get_available_models" });
					if (cancelled) return;
					const data = resp.data as {
						models?: (ModelEntry & { thinkingLevels?: string[] })[];
					} | undefined;
					list = (data?.models ?? []).map((m) => ({
						provider: m.provider,
						id: m.id,
						name: m.name,
						thinkingLevels: m.thinkingLevels,
					}));
					break;
				} catch (e) {
					if (attempt === 2) {
						setError(String(e));
						break;
					}
					await new Promise((r) => setTimeout(r, 3000));
				}
			}
			if (cancelled) return;
			setModels(list);
			setModelsLoading(false);
			try {
				const stateResp = await handleResponse({ type: "get_state" });
				if (cancelled) return;
				const stateData = stateResp.data as {
					model?: ModelEntry | null;
					thinkingLevel?: string;
				} | undefined;
				const current = stateData?.model;
				if (current) {
					// pi's actual session model wins over any stale local value.
					setModel(`${current.provider}/${current.id}`);
				} else if (list.length > 0) {
					// Fall back to the persisted choice, but only when it still
					// exists in the available models; otherwise pick the first.
					setModel((prev) => {
						if (
							prev &&
							list.some((m) => `${m.provider}/${m.id}` === prev)
						) {
							return prev;
						}
						return `${list[0].provider}/${list[0].id}`;
					});
				}
				if (stateData?.thinkingLevel) setThinkingLevel(stateData.thinkingLevel);
			} catch (e) {
				setError(String(e));
			}
			try {
				const thinkingResp = await handleResponse({
					type: "get_available_thinking_levels",
				});
				if (cancelled) return;
				const levels =
					(thinkingResp.data as { levels?: string[] } | undefined)?.levels ??
					[];
				if (levels.length) {
					setThinkingLevels(levels);
					setThinkingLevel((prev) => prev || levels[0]);
				}
			} catch {
				/* older pi */
			}
			try {
				const statsResp = await handleResponse({ type: "get_session_stats" });
				if (!cancelled) setStats(statsResp.data as SessionStats);
			} catch {
				/* older pi */
			}
			try {
				// Best-effort auto-retry toggle (transient errors).
				await send({
					type: "set_auto_retry",
					enabled: settingsRef.current.autoRetryOnFailure,
				});
			} catch {
				/* older pi */
			}
			try {
				// Slash commands (extension commands, prompt templates, skills).
				const cmdResp = await handleResponse({ type: "get_commands" });
				if (!cancelled) {
					setCommands(
						(cmdResp.data as { commands?: PiCommand[] } | undefined)
							?.commands ?? [],
					);
				}
			} catch {
				/* older pi */
			}
		};
		void init();
		return () => {
			cancelled = true;
		};
	}, [connected, handleResponse]);

	// ---- actions ----
	const changeModel = useCallback(
		async (value: string) => {
			const slash = value.indexOf("/");
			const provider = value.slice(0, slash);
			const modelId = value.slice(slash + 1);
			setModel(value);
			try {
				await send({ type: "set_model", provider, modelId });
			} catch (e) {
				setError(String(e));
			}
		},
		[],
	);

	const changeThinkingLevel = useCallback(
		async (level: string) => {
			setThinkingLevel(level);
			try {
				await send({ type: "set_thinking_level", level });
			} catch (e) {
				setError(String(e));
			}
		},
		[],
	);

	// Ask the user for the selected provider's API key when it's missing,
	// right in the chat. Returns true when sending may proceed.
	const ensureProviderKey = useCallback(async (): Promise<boolean> => {
		if (!model) return true;
		const slash = model.indexOf("/");
		const provider = slash > 0 ? model.slice(0, slash) : "";
		if (!provider) return true;
		let statuses = authProviders;
		try {
			statuses = await authStatus();
			setAuthProviders(statuses);
		} catch {
			return true; // cannot check — let pi surface the error
		}
		if (statuses.some((s) => s.provider === provider && s.hasKey)) {
			return true;
		}
		return new Promise<boolean>((resolve) => {
			apiKeyResolveRef.current = resolve;
			setApiKeyDialog({ provider });
		});
	}, [model, authProviders]);

	const handleApiKeySave = useCallback(
		async (provider: string, key: string) => {
			await authSetKey(provider, key); // throws on failure
			setAuthProviders(await authStatus());
			apiKeyResolveRef.current?.(true);
			apiKeyResolveRef.current = null;
			setApiKeyDialog(null);
			toast(t.keyDialog.saved);
		},
		[t, toast],
	);

	const handleApiKeyCancel = useCallback(() => {
		apiKeyResolveRef.current?.(false);
		apiKeyResolveRef.current = null;
		setApiKeyDialog(null);
	}, []);

	const exportSession = useCallback(
		async (format: "markdown" | "jsonl") => {
			const path = sessionPathRef.current;
			if (!path) return;
			const markdown =
				format === "markdown"
					? messages.map(chatMessageToMarkdown).filter(Boolean).join("\n\n")
					: null;
			try {
				const result = await exportChat(path, markdown, format);
				if (result.ok && !result.canceled) {
					toast(t.chat.exportDone);
				} else if (result.error) {
					setError(result.error);
				}
			} catch (e) {
				setError(String(e));
			}
		},
		[messages, t, toast],
	);

	const exportSessionHtml = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) return;
		try {
			const result = await exportHtml(path);
			if (result.ok && !result.canceled) {
				toast(t.chat.exportDone);
			} else if (result.error) {
				setError(result.error);
			}
		} catch (e) {
			setError(String(e));
		}
	}, [t, toast]);

	const submit = useCallback(
		async (
			text: string,
			attachments: Attachment[],
			behavior: SendBehavior,
			editingQueueIdArg?: string | null,
		) => {
			if (!text.trim() && attachments.length === 0) return;

			// Editing a queued message: save the draft back into the queue.
			if (editingQueueIdArg) {
				const next = queuedRef.current.map((m) =>
					m.id === editingQueueIdArg ? { ...m, text, attachments } : m,
				);
				queuedRef.current = next;
				setQueuedMessages(next);
				setEditingQueueId(null);
				setQueuePaused(false);
				return;
			}

			// Allow composing as soon as a workspace is chosen: lazily spin up a
			// fresh session on the first send instead of forcing "New task".
			if (!connected) {
				if (!workspace) return;
				const ok = await connect({ sessionFile: null });
				if (!ok) return;
			}
			setError(null);

			// Provider API-key gate: ask inline before sending when missing.
			if (!(await ensureProviderKey())) return;

			// While the agent is running, every message is queued locally
			// (editable, reorderable, send-now) and delivered one at a time —
			// steering between tool calls, follow-ups after the turn. A plain
			// "normal" send during a run follows the composer's active
			// send-during-run mode; pi rejects unqueued prompts mid-run, so a
			// direct `prompt` must never go out while the agent is busy.
			if (working) {
				const mode = behavior === "normal" ? sendDuringRun : behavior;
				if (mode === "steer" || mode === "followUp") {
					const item: QueuedChatMessage = {
						id: `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`,
						text,
						attachments,
						mode,
					};
					const next = [...queuedRef.current, item];
					queuedRef.current = next;
					setQueuedMessages(next);
					setQueuePaused(false);
					return;
				}
			}

			const images = attachmentsToImages(attachments);
			const fullText = text + attachmentsToText(attachments);

			setMessages((prev) => [
				...prev,
				{
					id: nextId++,
					role: "user",
					blocks: [{ kind: "text", text: fullText }],
					streaming: false,
				},
			]);
			runEpochRef.current += 1;
			setWorking(true);

			// New task: show it in the sidebar immediately instead of waiting
			// for pi to flush the session file. discoverNewSession() promotes
			// this placeholder to the real entry once the file exists.
			const isNew = isNewSessionRef.current;
			const title =
				text.trim().slice(0, 60) || (attachments[0]?.name ?? "New session");
			if (isNew && !sessionPathRef.current) {
				setPendingSession({
					path: `pending://${nextId++}`,
					name: title,
					project: workspace,
					title,
					model: null,
					createdAt: Date.now(),
					messageCount: 0,
					mtimeMs: Date.now(),
					size: 0,
					pending: true,
				});
			}

			try {
				await send({ type: "prompt", message: fullText, images });
				if (isNew) {
					isNewSessionRef.current = false;
					try {
						// The name lands in the file when pi processes this command;
						// the resulting session_info_changed event + the polling in
						// discoverNewSession() refresh the sidebar then. A refresh
						// right here would race ahead of pi and scan an empty dir.
						await send({ type: "set_session_name", name: title });
					} catch {
						/* ignore */
					}
					void discoverNewSession();
				}
			} catch (e) {
				setError(String(e));
				setMessages((prev) => {
					const next = [...prev];
					for (let i = next.length - 1; i >= 0; i--) {
						if (next[i].role === "user") {
							next[i] = { ...next[i], error: String(e) };
							break;
						}
					}
					return next;
				});
				setWorking(false);
				setPendingSession(null);
			}
		},
		[connected, workspace, connect, refreshSessions, discoverNewSession, ensureProviderKey, attachmentsToImages, attachmentsToText, working, sendDuringRun],
	);

	const abort = useCallback(async () => {
		// After an interrupt, pause auto-delivery of the queue unless the
		// "continue after interrupt" setting is on.
		setQueuePaused(!settingsRef.current.continueQueuedAfterInterrupt);
		setAborting(true);
		// Best-effort: abort the run, any running bash command, and a pending
		// auto-retry delay — any of these can be the thing that's stuck.
		let alive = true;
		try {
			await send({ type: "abort" });
		} catch {
			alive = false; // pi is already dead — the UI state is stuck
		}
		if (alive) {
			send({ type: "abort_bash" }).catch(() => {});
			send({ type: "abort_retry" }).catch(() => {});
		}
		// Watchdog: if pi hasn't settled shortly after the abort (hung network
		// request, unresponsive provider, unkillable bash), force-kill the
		// process and reconnect to the same session so the UI never stays
		// stuck in "running" with a dead stop button. The epoch guard makes
		// sure a run the user started after aborting is never killed by the
		// leftover watchdog.
		const epoch = runEpochRef.current;
		window.setTimeout(() => {
			if (
				runEpochRef.current !== epoch ||
				(!workingRef.current && !streamingRef.current)
			)
				return;
			void (async () => {
				const resume = sessionPathRef.current;
				try {
					await disconnect();
					await connect({ sessionFile: resume });
					toast(t.chat.forceStopped);
				} finally {
					setAborting(false);
				}
			})();
		}, 5000);
	}, [disconnect, connect, toast, t]);

	const compact = useCallback(async () => {
		try {
			await send({ type: "compact" });
			toast(t.chat.compacting);
		} catch (e) {
			setError(String(e));
		}
	}, [t, toast]);

	const copyConversation = useCallback(async (): Promise<boolean> => {
		const md = messages
			.map(chatMessageToMarkdown)
			.filter(Boolean)
			.join("\n\n");
		if (!md) return false;
		try {
			await navigator.clipboard.writeText(md);
			return true;
		} catch {
			return false;
		}
	}, [messages]);

	const renameSession = useCallback(async (name: string) => {
		if (!connected || !name.trim()) return;
		try {
			await send({ type: "set_session_name", name: name.trim() });
			await refreshSessions();
		} catch (e) {
			setError(String(e));
		}
	}, [connected, refreshSessions]);

	const archiveCurrent = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) return;
		setConfirmState({
			title: t.confirm.deleteTitle,
			body: t.confirm.deleteBody,
			confirmLabel: t.app.delete,
			onConfirm: async () => {
				try {
					// Stop pi first: on Linux/macOS renaming a session file
					// that pi still has open makes later appends land in the
					// moved copy; on Windows the rename just fails.
					await disconnect();
					await archiveSessionCmd(path);
					setMessages([]);
					await refreshSessions();
					// Reconnect to a fresh session so the composer stays usable
					// as long as a workspace is selected.
					if (workspace) void connect({ sessionFile: null });
					toast(t.sidebar.archive);
				} catch (e) {
					setError(String(e));
				}
			},
		});
	}, [t, disconnect, refreshSessions, toast, workspace, connect]);

	// Archive an arbitrary session from the sidebar row hover action.
	const archiveSessionByPath = useCallback(
		(path: string) => {
			setConfirmState({
				title: t.confirm.deleteTitle,
				body: t.confirm.deleteBody,
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					try {
						const wasCurrent = sessionPathRef.current === path;
						if (wasCurrent) {
							await disconnect();
						}
						await archiveSessionCmd(path);
						if (wasCurrent) {
							setMessages([]);
						}
						await refreshSessions();
						if (wasCurrent && workspace)
							void connect({ sessionFile: null });
						toast(t.sidebar.archive);
					} catch (e) {
						setError(String(e));
					}
				},
			});
		},
		[t, disconnect, refreshSessions, toast, workspace, connect],
	);

	const togglePinSession = useCallback((path: string) => {
		setPinnedSessions((prev) =>
			prev.includes(path) ? prev.filter((p) => p !== path) : [path, ...prev],
		);
	}, []);

	const deleteCurrent = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) return;
		setConfirmState({
			title: t.confirm.deleteTitle,
			body: t.confirm.deleteBody,
			confirmLabel: t.app.delete,
			onConfirm: async () => {
				try {
					await disconnect();
					await deleteSessionCmd(path);
					setMessages([]);
					await refreshSessions();
					if (workspace) void connect({ sessionFile: null });
					toast(t.app.delete);
				} catch (e) {
					setError(String(e));
				}
			},
		});
	}, [t, disconnect, refreshSessions, toast, workspace, connect]);

	const revealCurrent = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) return;
		try {
			await revealSession(path);
		} catch (e) {
			setError(String(e));
		}
	}, []);

	const handleRestore = useCallback(
		async (path: string) => {
			try {
				await restoreSession(path);
				await refreshSessions();
				toast(t.sidebar.restore);
			} catch (e) {
				setError(String(e));
			}
		},
		[refreshSessions, toast, t],
	);

	const handlePurge = useCallback(
		(path: string) => {
			setConfirmState({
				title: t.confirm.purgeTitle,
				body: t.confirm.purgeBody,
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					try {
						await purgeSession(path);
						await refreshSessions();
						toast(t.app.delete);
					} catch (e) {
						setError(String(e));
					}
				},
			});
		},
		[refreshSessions, toast, t],
	);

	// Read-only preview + export for archived sessions.
	const openArchivedPreview = useCallback(async (path: string, title: string) => {
		try {
			const parsed = await readSession(path);
			setArchivedPreview({ path, title, messages: parsed });
		} catch (e) {
			setError(String(e));
		}
	}, []);

	const exportArchivedPreview = useCallback(
		async (format: "markdown" | "jsonl" | "html") => {
			const preview = archivedPreview;
			if (!preview) return;
			try {
				if (format === "html") {
					await exportHtml(preview.path);
				} else if (format === "jsonl") {
					await exportChat(preview.path, null, "jsonl");
				} else {
					await exportChat(
						preview.path,
						parsedMessagesToMarkdown(preview.messages),
						"markdown",
					);
				}
			} catch (e) {
				setError(String(e));
			}
		},
		[archivedPreview],
	);

	const handleRevealProject = useCallback(async (path: string) => {
		try {
			await openPath(path);
		} catch {
			/* ignore */
		}
	}, []);

	const handleDeleteProject = useCallback(
		(path: string) => {
			const projectSessions = sessions.filter((s) => s.project === path);
			if (projectSessions.length === 0) return;
			setConfirmState({
				title: t.confirm.deleteProjectTitle,
				body: t.confirm.deleteProjectBody.replace(
					"{count}",
					String(projectSessions.length),
				),
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					const current = sessionPathRef.current;
					const includesCurrent =
						current != null &&
						projectSessions.some((s) => s.path === current);
					if (includesCurrent) {
						await disconnect();
					}
					for (const s of projectSessions) {
						try {
							await archiveSessionCmd(s.path);
						} catch {
							/* continue */
						}
					}
					if (includesCurrent) {
						setMessages([]);
					}
					await refreshSessions();
					if (workspace) void connect({ sessionFile: null });
					toast(t.sidebar.deleteProject);
				},
			});
		},
		[sessions, t, disconnect, refreshSessions, toast, workspace, connect],
	);

	const handleRestoreAll = useCallback(async () => {
		for (const a of archived) {
			try {
				await restoreSession(a.path);
			} catch {
				/* continue */
			}
		}
		await refreshSessions();
	}, [archived, refreshSessions]);

	const handleMoveSession = useCallback(
		async (path: string) => {
			const dir = await openWorkspace();
			if (!dir) return;
			const wasCurrent = sessionPathRef.current === path;
			try {
				// Rewriting a JSONL that the running pi process may append to
				// concurrently would corrupt it — stop the session first.
				if (wasCurrent) {
					await disconnect();
				}
				await piMoveSession(path, dir);
				await refreshSessions();
				if (wasCurrent) {
					setMessages([]);
					// Explicit workspace: the session header now points at the
					// new project, but the (stale) cached session entry would
					// steer connect back to the old directory.
					await connect({ sessionFile: path, workspace: dir });
				}
				toast(t.chat.moved);
			} catch (e) {
				setError(String(e));
			}
		},
		[refreshSessions, toast, t, disconnect, connect],
	);

	const handleCompactImages = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) return;
		setConfirmState({
			title: t.confirm.compactImagesTitle,
			body: t.confirm.compactImagesBody,
			confirmLabel: t.app.confirm,
			onConfirm: async () => {
				try {
					// The backend refuses to touch a session the running pi
					// process may append to, so stop it first and reconnect
					// afterwards.
					await disconnect();
					const r = await compactSessionImages(path);
					await refreshSessions();
					await connect({ sessionFile: path });
					if (r.removed > 0) {
						const saved = Math.max(0, r.before - r.after);
						toast(
							t.chat.imagesCompacted
								.replace("{n}", String(r.removed))
								.replace("{size}", formatBytes(saved)),
						);
					} else {
						toast(t.chat.imagesCompactedNone);
					}
				} catch (e) {
					setError(String(e));
				}
			},
		});
	}, [t, disconnect, refreshSessions, connect, toast]);

	const handleExtensionRespond = useCallback(
		async (id: string, payload: Record<string, unknown>) => {
			setExtensionRequest(null);
			try {
				await send({ type: "extension_ui_response", id, ...payload });
			} catch (e) {
				setError(String(e));
			}
		},
		[],
	);

	const handleForkFromMessage = useCallback(
		async (entryId: string) => {
			try {
				await handleResponse({ type: "fork", entryId });
				const state = await handleResponse({ type: "get_state" });
				const sessionFile = (
					state.data as { sessionFile?: string | null } | undefined
				)?.sessionFile;
				setMessages([]);
				setStreaming(false);
				setWorking(false);
				await refreshSessions();
				if (sessionFile) {
					sessionPathRef.current = sessionFile;
					setSelectedSessionPath(sessionFile);
					await loadHistory(sessionFile);
				}
				toast(t.chat.forked);
			} catch (e) {
				setError(String(e));
			}
		},
		[handleResponse, refreshSessions, loadHistory, toast, t],
	);

	const handleSearchSelect = useCallback(
		async (path: string) => {
			const s = sessions.find((x) => x.path === path);
			await connect({ sessionFile: s?.path ?? path });
		},
		[connect, sessions],
	);

	const handleCheckoutBranch = useCallback(
		async (name: string) => {
			if (!workspace) return;
			try {
				setGitState(await gitCheckoutBranch(workspace, name));
			} catch (e) {
				setError(String(e));
			}
		},
		[workspace],
	);

	const handleCreateBranch = useCallback(
		async (name: string) => {
			if (!workspace) return;
			try {
				setGitState(await gitCreateBranch(workspace, name));
				toast(t.chat.forked);
			} catch (e) {
				setError(String(e));
			}
		},
		[workspace, t, toast],
	);

	const focusComposer = useCallback(() => {
		if (connected) setComposerFocusRequest((n) => n + 1);
	}, [connected]);

	const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);

	// Sidebar peek: hovering the titlebar toggle while collapsed reveals the sidebar as a temporary overlay.
	const [sidebarPeek, setSidebarPeek] = useState(false);
	const peekTimer = useRef<number | null>(null);
	const openSidebarPeek = useCallback(() => {
		if (peekTimer.current !== null) {
			clearTimeout(peekTimer.current);
			peekTimer.current = null;
		}
		if (sidebarCollapsed) setSidebarPeek(true);
	}, [sidebarCollapsed]);
	const closeSidebarPeekSoon = useCallback(() => {
		if (peekTimer.current !== null) clearTimeout(peekTimer.current);
		peekTimer.current = window.setTimeout(() => setSidebarPeek(false), 180);
	}, []);

	// Deep links: "#settings" / "#search" open the matching surface on mount.
	useEffect(() => {
		const hash = window.location.hash;
		if (hash === "#settings") setSettingsOpen(true);
		if (hash === "#search") setSearchOpen(true);
	}, []);

	// Auto-connect / auto-resume: whenever the app is idle and a workspace is
	// known, (re)connect to the current/last session (or a fresh one).
	// Failures back off exponentially (3s, 6s, 12s… capped at 30s) instead of
	// giving up permanently.
	useEffect(() => {
		if (connected || busy || !workspace) return;
		const st = autoConnectStateRef.current;
		const backoff =
			st.failures === 0 ? 0 : Math.min(30000, 3000 * 2 ** (st.failures - 1));
		const last = localStorage.getItem(STORAGE_KEYS.lastSession);
		const target = sessionPathRef.current ?? last;
		const timer = setTimeout(() => {
			void connect({ sessionFile: target });
		}, 300 + backoff);
		return () => clearTimeout(timer);
	}, [connected, busy, workspace, connect]);

	// Escape interrupts the running turn (like the pi TUI). Skipped while
	// typing in an input or when a dialog/search overlay is open.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const el = e.target as HTMLElement | null;
			if (
				el &&
				(el.tagName === "INPUT" ||
					el.tagName === "TEXTAREA" ||
					el.isContentEditable)
			) {
				return;
			}
			if (
				confirmState ||
				renameState ||
				apiKeyDialog ||
				extensionRequest ||
				searchOpen ||
				archivedPreview
			) {
				return;
			}
			if (!workingRef.current || !connected) return;
			e.preventDefault();
			void abort();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		confirmState,
		renameState,
		apiKeyDialog,
		extensionRequest,
		searchOpen,
		archivedPreview,
		connected,
		abort,
	]);

	// ---- keyboard shortcuts ----
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) return;
			const key = e.key.toLowerCase();
			if (key === "k") {
				e.preventDefault();
				setSearchOpen((v) => !v);
			} else if (key === "n") {
				e.preventDefault();
				if (e.shiftKey) {
					// Ctrl+Shift+N: new window (own pi process + session).
					void newWindow().catch((err) => setError(String(err)));
				} else if (busy) {
					// A connect is in flight; newTask would kill the process it
					// just spawned and wedge the UI (the sidebar button is
					// disabled while busy, the shortcut needs the same guard).
					toast(t.chat.busyToast);
				} else {
					void newTask();
				}
			} else if (e.key === ",") {
				e.preventDefault();
				setSettingsOpen((v) => !v);
			} else if (key === "b") {
				e.preventDefault();
				toggleSidebar();
			} else if (key === "l") {
				e.preventDefault();
				focusComposer();
			} else if (e.shiftKey && key === "a") {
				e.preventDefault();
				void archiveCurrent();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [newTask, toggleSidebar, focusComposer, archiveCurrent, busy, toast, t]);

	// ---- sidebar resize ----
	const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
	const startResize = useCallback((e: React.PointerEvent) => {
		resizeRef.current = { startX: e.clientX, startW: sidebarWidth };
		const onMove = (ev: PointerEvent) => {
			if (!resizeRef.current) return;
			const w = Math.min(
				340,
				Math.max(200, resizeRef.current.startW + ev.clientX - resizeRef.current.startX),
			);
			setSidebarWidth(w);
		};
		const onUp = () => {
			resizeRef.current = null;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [sidebarWidth]);

	const openSessionDir = useCallback(async () => {
		try {
			await openPath(sessionDirRef.current);
		} catch {
			/* ignore */
		}
	}, []);

	// Compute session dir label from the first session's parent, fallback to default.
	const sessionDirRef = useRef("~/.pi/agent/sessions");
	useEffect(() => {
		if (sessions[0]) {
			const p = sessions[0].path.replace(/[\\/][^\\/]+\.jsonl$/, "");
			sessionDirRef.current = p;
		}
	}, [sessions]);

	const selectedSession = useMemo(
		() =>
			sessions.find((s) => s.path === selectedSessionPath) ??
			(sessionPathRef.current
				? sessions.find((s) => s.path === sessionPathRef.current) ??
				  null
				: null),
		[sessions, selectedSessionPath],
	);

	// Merge the optimistic new-task placeholder into the sidebar list, and
	// treat it as the selected session until its real file is discovered.
	const sidebarSessions = useMemo<PiSessionInfo[]>(() => {
		if (!pendingSession) return sessions;
		return [pendingSession, ...sessions];
	}, [sessions, pendingSession]);
	const effectiveSelectedPath =
		selectedSessionPath ?? pendingSession?.path ?? null;
	const workingPath = working ? effectiveSelectedPath : null;

	const showTurnWait = working && !streaming && connected;

	const sidebarEl = (
		<Sidebar
			t={t}
			lang={settings.language}
			sessions={sidebarSessions}
			selectedPath={effectiveSelectedPath}
			workingPath={workingPath}
			expandedProjects={expandedProjects}
			sessionOrder={sessionOrder}
			onReorderSession={setSessionOrder}
			onToggleProject={(key) =>
				setExpandedProjects((prev) => {
					const next = new Set(prev);
					if (next.has(key)) next.delete(key);
					else next.add(key);
					return next;
				})
			}
			onSelectSession={openSession}
			pinnedSessions={pinnedSessions}
			onTogglePin={togglePinSession}
			onArchiveSession={archiveSessionByPath}
			onNewTask={newTask}
			onOpenWorkspace={pickWorkspace}
			onOpenSettings={() => setSettingsOpen(true)}
			onOpenSearch={() => setSearchOpen(true)}
			onMoveSession={handleMoveSession}
			onRevealProject={handleRevealProject}
			onDeleteProject={handleDeleteProject}
			busy={busy}
			binary={binary}
			binError={binError}
		/>
	);

	return (
		<div className="app">
			<TitleBar
				t={t}
				onOpenSettings={() => setSettingsOpen(true)}
				onNewWindow={() => void newWindow().catch((e) => setError(String(e)))}
				sidebarCollapsed={sidebarCollapsed}
				onToggleSidebar={toggleSidebar}
				onPeekSidebar={openSidebarPeek}
				onPeekSidebarLeave={closeSidebarPeekSoon}
			/>
			<div className="shell">
				{!sidebarCollapsed && !settingsOpen && (
					<>
						<div className="sidebar-shell" style={{ width: sidebarWidth }}>
							{sidebarEl}
						</div>
						<div className="sidebar-resizer" onPointerDown={startResize} />
					</>
				)}

				{settingsOpen ? (
					<SettingsPanel
						t={t}
						settings={settings}
						onChange={setSettings}
						binary={binary}
						sessionDir={sessionDirRef.current}
						archived={archived}
						onRestore={handleRestore}
						onPurge={handlePurge}
						onRestoreAll={handleRestoreAll}
						onViewArchived={openArchivedPreview}
						onClose={() => setSettingsOpen(false)}
						onOpenSessionDir={openSessionDir}
					/>
				) : (
					<ChatArea
						t={t}
						session={selectedSession}
						messages={messages}
						streaming={streaming}
						connected={connected}
						busy={busy}
						error={error}
						models={models}
						model={model}
						onModelChange={changeModel}
						thinkingLevel={thinkingLevel}
						thinkingLevels={thinkingLevels}
						onThinkingLevelChange={changeThinkingLevel}
						sendDuringRun={sendDuringRun}
						onSendDuringRunChange={setSendDuringRun}
						onSubmit={submit}
						onAbort={abort}
						aborting={aborting}
						onCompact={compact}
						onCopy={copyConversation}
						onExport={exportSession}
						onExportHtml={exportSessionHtml}
						onRename={() => setRenameState({ title: t.chat.rename, initial: selectedSession?.title ?? "" })}
						onArchive={archiveCurrent}
						onDelete={deleteCurrent}
						onCompactImages={handleCompactImages}
						onReveal={revealCurrent}
						composerFocusRequest={composerFocusRequest}
						showTurnWait={showTurnWait}
						gitState={gitState}
						onCheckoutBranch={handleCheckoutBranch}
						onCreateBranch={handleCreateBranch}
						onForkFromMessage={handleForkFromMessage}
						stats={stats}
						workspace={workspace}
						workspaces={workspaces}
						onPickWorkspace={pickWorkspace}
						onSelectWorkspace={selectWorkspace}
						queuedMessages={queuedMessages}
						queuePaused={queuePaused}
						editingQueueId={editingQueueId}
						onQueueSendNow={(id) => void queueSendNow(id)}
						onQueueEdit={(item) => queueEdit(item.id)}
						onQueueDelete={(id) => queueDelete(id)}
						onQueueReorder={(a, b) => queueReorder(a, b)}
						onQueueCancelEdit={() => setEditingQueueId(null)}
						customTools={settings.customTools}
						onCustomToolsChange={(tools) =>
							setSettings((prev) => ({ ...prev, customTools: tools }))
						}
						showContextUsage={settings.showContextUsage}
						modelsLoading={modelsLoading}
						commands={commands}
					/>
				)}
			</div>

			{sidebarCollapsed && sidebarPeek && !settingsOpen && (
				<div
					className="sidebar-peek"
					style={{ width: sidebarWidth }}
					onMouseEnter={openSidebarPeek}
					onMouseLeave={closeSidebarPeekSoon}
				>
					{sidebarEl}
				</div>
			)}

			<SearchOverlay
				t={t}
				open={searchOpen}
				onClose={() => setSearchOpen(false)}
				onSelect={handleSearchSelect}
			/>

			<ExtensionDialog
				request={extensionRequest}
				onRespond={handleExtensionRespond}
				t={t}
			/>

			{confirmState && (
				<div className="overlay-backdrop">
					<div className="extension-dialog confirm-dialog">
						<h3>{confirmState.title}</h3>
						<p className="extension-message">{confirmState.body}</p>
						<div className="extension-dialog-actions">
							<button
								className="btn secondary"
								onClick={() => setConfirmState(null)}
							>
								{t.app.cancel}
							</button>
							<button
								className="btn danger"
								onClick={() => {
									const fn = confirmState.onConfirm;
									setConfirmState(null);
									void fn();
								}}
							>
								{confirmState.confirmLabel ?? t.app.confirm}
							</button>
						</div>
					</div>
				</div>
			)}

			{renameState && (
				<RenameDialog
					state={renameState}
					t={t}
					onClose={() => setRenameState(null)}
					onConfirm={(name) => {
						setRenameState(null);
						void renameSession(name);
					}}
				/>
			)}

			{apiKeyDialog && (
				<ApiKeyDialog
					provider={apiKeyDialog.provider}
					t={t}
					onSave={handleApiKeySave}
					onCancel={handleApiKeyCancel}
				/>
			)}

			{archivedPreview && (
				<ArchivedPreview
					title={archivedPreview.title}
					messages={archivedPreview.messages}
					t={t}
					onClose={() => setArchivedPreview(null)}
					onExport={exportArchivedPreview}
				/>
			)}

			<div className="toasts">
				{toasts.map((x) => (
					<div key={x.id} className="toast">
						{x.text}
					</div>
				))}
			</div>

			{stderr.length > 0 && (
				<details className="stderr">
					<summary>pi stderr ({stderr.length} lines)</summary>
					<pre>{stderr.slice(-30).join("\n")}</pre>
				</details>
			)}
		</div>
	);
}

function ApiKeyDialog({
	provider,
	t,
	onSave,
	onCancel,
}: {
	provider: string;
	t: ReturnType<typeof getMessages>;
	onSave: (provider: string, key: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 30);
	}, []);
	const save = async () => {
		if (!key.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onSave(provider, key.trim());
		} catch (e) {
			setError(String(e));
			setBusy(false);
		}
	};
	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog">
				<h3>{t.keyDialog.title}</h3>
				<p className="extension-message">
					{t.keyDialog.body.replace("{provider}", provider)}
				</p>
				<input
					ref={inputRef}
					type="password"
					value={key}
					placeholder={t.keyDialog.placeholder}
					onChange={(e) => setKey(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void save();
						if (e.key === "Escape") onCancel();
					}}
				/>
				{error && <p className="extension-error">{error}</p>}
				<div className="extension-dialog-actions">
					<button className="btn secondary" onClick={onCancel}>
						{t.keyDialog.cancelSend}
					</button>
					<button
						className="btn primary"
						disabled={!key.trim() || busy}
						onClick={() => void save()}
					>
						{t.keyDialog.save}
					</button>
				</div>
			</div>
		</div>
	);
}

function RenameDialog({
	state,
	t,
	onClose,
	onConfirm,
}: {
	state: { title: string; initial: string };
	t: ReturnType<typeof getMessages>;
	onClose: () => void;
	onConfirm: (name: string) => void;
}) {
	const [value, setValue] = useState(state.initial);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, 30);
	}, []);
	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog">
				<h3>{state.title}</h3>
				<input
					ref={inputRef}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && value.trim()) onConfirm(value.trim());
						if (e.key === "Escape") onClose();
					}}
				/>
				<div className="extension-dialog-actions">
					<button className="btn secondary" onClick={onClose}>
						{t.app.cancel}
					</button>
					<button
						className="btn primary"
						disabled={!value.trim()}
						onClick={() => onConfirm(value.trim())}
					>
						{t.app.confirm}
					</button>
				</div>
			</div>
		</div>
	);
}
