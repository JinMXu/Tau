import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
	fetchSubagentRuns,
	gitBranchState,
	gitCheckoutBranch,
	gitCreateBranch,
	importSession,
	listArchivedSessions,
	listSessions,
	newWindow,
	openWorkspace,
	piMoveSession,
	purgeSession,
	readSession,
	readTree,
	restoreSession,
	revealSession,
	send,
	shareSession,
	start,
	status,
	stop,
	trustDefaultGet,
	trustDefaultSet,
	trustGet,
	trustSet,
	type AuthProviderStatus,
	type GitBranchState,
	type PiArchivedSession,
	type PiBinaryInfo,
	type PiCommand,
	type PiEvent,
	type PiParsedMessage,
	type PiSessionInfo,
	type SubagentRun,
} from "./pi";
import { getMessages, projectNameFromPath } from "./i18n";
import { stripAnsi } from "./lib/ansi";
import { loadSettings, resolveTheme, saveSettings, type AppSettings } from "./settings";
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
import { TitleBar } from "./components/TitleBar";
import { SearchOverlay } from "./components/SearchOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { ArchivedPreview } from "./components/ArchivedPreview";
import { chatMessageToMarkdown, parsedMessagesToMarkdown } from "./components/message-utils";
import { ExtensionDialog, type ExtensionRequest } from "./components/ExtensionDialog";
import { TreePanel, type PiTreeData } from "./components/TreePanel";
import { SessionInfoDialog } from "./components/SessionInfoDialog";
import { HotkeysDialog } from "./components/HotkeysDialog";
import { ScopedModelsDialog } from "./components/ScopedModelsDialog";
import { CompactDialog } from "./components/CompactDialog";
import { ShareDialog } from "./components/ShareDialog";
import { LlamaDialog } from "./components/LlamaDialog";
import type { ModelEntry } from "./components/Composer";
import "./App.css";
import { formatBytes } from "./format";
import { isMac, isWin } from "./platform";

let nextId = 1;

type ConnectOpts = {
	sessionFile?: string | null;
	forkOf?: string | null;
	sessionName?: string | null;
	workspace?: string | null;
};

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
	bash: 600000,
	get_messages: 30000,
	switch_session: 30000,
	fork: 30000,
	clone: 30000,
	new_session: 30000,
	get_tree: 90000,
	get_state: 15000,
	get_session_stats: 15000,
	set_model: 15000,
	set_thinking_level: 15000,
	set_session_name: 15000,
	set_auto_retry: 15000,
};

/**
 * Compare two session-path spellings. On Windows, pi's RPC `sessionFile` and
 * the backend scan can disagree about drive-letter case or path separators;
 * a strict `===` would silently never match and block the new-session
 * promotion, so compare case- and separator-insensitively there. Other
 * platforms compare strictly.
 */
function sameSessionPath(a: string, b: string): boolean {
	if (a === b) return true;
	if (!isWin) return false;
	return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

function loadExpanded(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEYS.expanded);
		if (!raw) return new Set(["__default__"]);
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set(["__default__"]);
	}
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
	const [pendingSession, setPendingSession] = useState<PiSessionInfo | null>(null);
	const [archived, setArchived] = useState<PiArchivedSession[]>([]);
	const [selectedSessionPath, setSelectedSessionPath] = useState<string | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [streaming, setStreaming] = useState(false);
	const [working, setWorking] = useState(false);
	// Live pi-subagents runs for the current session (polled while working).
	const [subagentRuns, setSubagentRuns] = useState<SubagentRun[]>([]);
	const [models, setModels] = useState<ModelEntry[]>([]);
	const [commands, setCommands] = useState<PiCommand[]>([]);
	const [model, setModel] = useState<string>(() => localStorage.getItem(STORAGE_KEYS.model) ?? "");
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
	// Buffer stderr lines and flush once per animation frame: pi tools that
	// print progress/spinners can emit dozens of lines per second, and each
	// `setStderr` re-renders the whole App (stderr lives in the root state).
	const pendingStderrRef = useRef<string[]>([]);
	const stderrFlushRef = useRef<number | null>(null);
	const pushStderr = useCallback((line: string) => {
		pendingStderrRef.current.push(line);
		if (stderrFlushRef.current !== null) return;
		stderrFlushRef.current = requestAnimationFrame(() => {
			stderrFlushRef.current = null;
			const lines = pendingStderrRef.current;
			pendingStderrRef.current = [];
			if (lines.length === 0) return;
			setStderr((prev) => [...prev, ...lines].slice(-200));
		});
	}, []);
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
	// Fullscreen: macOS hides the traffic lights natively, so the header
	// buttons move into their spot (CSS via the `.app.fullscreen` class). The
	// transition shows the old + new window states simultaneously, which
	// would duplicate the buttons, so the Rust side forwards the native
	// fullscreen notifications:
	//   "will-enter"/"will-exit" — before the animation: fade the buttons out;
	//   "enter"/"exit" — when it finishes: flip the layout and fade them in.
	const [fullscreen, setFullscreen] = useState(false);
	const [fsTransitioning, setFsTransitioning] = useState(false);
	useEffect(() => {
		let mounted = true;
		const unlisten = listen<string>("window://fullscreen", (e) => {
			if (!mounted) return;
			switch (e.payload) {
				case "will-enter":
				case "will-exit":
					setFsTransitioning(true);
					break;
				case "enter":
					setFsTransitioning(false);
					setFullscreen(true);
					break;
				case "exit":
					setFsTransitioning(false);
					setFullscreen(false);
					break;
			}
		});
		// Initial state (e.g. app relaunched while still in fullscreen).
		void getCurrentWindow()
			.isFullscreen()
			.then((fs) => {
				if (mounted) setFullscreen(fs);
			});
		return () => {
			mounted = false;
			void unlisten.then((f) => f());
		};
	}, []);
	// ---- session navigation history (back / forward) ----
	// Mirrored in refs so pushNav/navGo never read stale closures.
	const [navHistory, setNavHistory] = useState<string[]>([]);
	const [navIndex, setNavIndex] = useState(-1);
	const navHistoryRef = useRef<string[]>([]);
	const navIndexRef = useRef(-1);
	const pushNav = useCallback((path: string) => {
		// Clicking the session already on screen doesn't add a duplicate.
		if (navHistoryRef.current[navIndexRef.current] === path) return;
		navIndexRef.current += 1;
		navHistoryRef.current = [...navHistoryRef.current.slice(0, navIndexRef.current), path];
		setNavHistory(navHistoryRef.current);
		setNavIndex(navIndexRef.current);
	}, []);
	const canGoBack = navIndex > 0;
	const canGoForward = navIndex >= 0 && navIndex < navHistory.length - 1;
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(loadExpanded);
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
	const [extensionRequest, setExtensionRequest] = useState<ExtensionRequest | null>(null);
	// Mirrors `extensionRequest` for the event handler (a ref, so handleEvent
	// doesn't re-subscribe when the dialog changes). Used to cancel a pending
	// request before it is overwritten by a newer one.
	const extensionRequestRef = useRef<ExtensionRequest | null>(null);
	const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
	const [renameState, setRenameState] = useState<RenameState | null>(null);
	const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);

	// ---- extension UI: widgets / status / window title / editor prefill ----
	const [extensionWidgets, setExtensionWidgets] = useState<
		Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>
	>({});
	const [extensionStatus, setExtensionStatus] = useState<Record<string, string>>({});
	const [externalDraft, setExternalDraft] = useState<string | null>(null);

	// ---- session tree (/tree equivalent) ----
	const [treeOpen, setTreeOpen] = useState(false);
	const [treeData, setTreeData] = useState<PiTreeData | null>(null);
	// ---- /session details ----
	const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
	const [sessionInfoData, setSessionInfoData] = useState<{
		state: Record<string, unknown>;
		stats: SessionStats | null;
	} | null>(null);
	// ---- /hotkeys ----
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	// ---- /scoped-models ----
	const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
	// ---- /compact with custom instructions ----
	const [compactOpen, setCompactOpen] = useState(false);
	// ---- /share result ----
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	// ---- direct bash command (!cmd / !!cmd) streaming ----
	const activeBashRef = useRef<{ id: string; messageId: number } | null>(null);
	// ---- /reload (restart pi to reload extensions/skills/prompts) ----
	// ---- /trust (project trust decisions) ----
	const [trustDecision, setTrustDecision] = useState<boolean | null>(null);
	const [trustDefault, setTrustDefault] = useState<string>("ask");
	// ---- /llama ----
	const [llamaOpen, setLlamaOpen] = useState(false);

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
	// Bumped whenever the user navigates to a different session (connect /
	// disconnect / new task). discoverNewSession() captures it so a polling
	// loop for a just-created session can detect the user switching away and
	// stop clobbering the new selection.
	const navEpochRef = useRef(0);

	// ---- perf tracking: TTFT, generation speed, cache hit rate ----
	const turnStartRef = useRef<number | null>(null);
	const firstTokenRef = useRef<number | null>(null);
	const msgGenStartRef = useRef<number | null>(null);
	const totalGenTimeRef = useRef(0);
	const prevOutputTokensRef = useRef(0);
	const ttftHistoryRef = useRef<number[]>([]);
	const statsRef = useRef<SessionStats | null>(null);

	// ---- provider API-key gate (chat-time key dialog) ----
	const [, setAuthProviders] = useState<AuthProviderStatus[]>([]);
	const [apiKeyDialog, setApiKeyDialog] = useState<{ provider: string } | null>(null);
	const apiKeyResolversRef = useRef<((saved: boolean) => void)[]>([]);

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
	useEffect(() => {
		statsRef.current = stats;
	}, [stats]);

	// Hot-apply the auto-retry toggle without reconnecting.
	useEffect(() => {
		if (!connected) return;
		send({ type: "set_auto_retry", enabled: settings.autoRetryOnFailure }).catch(() => {
			/* older pi */
		});
	}, [settings.autoRetryOnFailure, connected]);

	// Hot-apply queue delivery modes + auto-compaction without reconnecting.
	useEffect(() => {
		if (!connected) return;
		send({ type: "set_steering_mode", mode: settings.steeringMode }).catch(() => {
			/* older pi */
		});
	}, [settings.steeringMode, connected]);
	useEffect(() => {
		if (!connected) return;
		send({ type: "set_follow_up_mode", mode: settings.followUpMode }).catch(() => {
			/* older pi */
		});
	}, [settings.followUpMode, connected]);
	useEffect(() => {
		if (!connected) return;
		send({ type: "set_auto_compaction", enabled: settings.autoCompaction }).catch(() => {
			/* older pi */
		});
	}, [settings.autoCompaction, connected]);

	const pendingRef = useRef(new Map<string, (v: unknown) => void>());
	const sessionPathRef = useRef<string | null>(null);
	const isNewSessionRef = useRef(false);

	// ---- streaming delta coalescing ----
	// pi delivers one event per token; applying each delta to React state
	// re-renders (and re-parses markdown for) the whole message, which can
	// pin the webview's CPU for long answers and spike memory when the
	// message completes. Deltas are buffered and applied once per animation
	// frame instead.
	const pendingDeltaRef = useRef<{
		text?: string;
		thinking?: string;
		tool?: string;
	} | null>(null);
	const deltaFlushRef = useRef<number | null>(null);
	const clearPendingDeltas = useCallback(() => {
		if (deltaFlushRef.current !== null) {
			cancelAnimationFrame(deltaFlushRef.current);
			deltaFlushRef.current = null;
		}
		pendingDeltaRef.current = null;
	}, []);
	const scheduleDeltaFlush = useCallback(() => {
		if (deltaFlushRef.current !== null) return;
		deltaFlushRef.current = requestAnimationFrame(() => {
			deltaFlushRef.current = null;
			const d = pendingDeltaRef.current;
			pendingDeltaRef.current = null;
			if (!d) return;
			// Mark as a transition so React can yield to the browser mid-render
			// (keeping input / scroll responsive) and drop stale renders when
			// deltas arrive faster than the parse can keep up.
			startTransition(() => {
				setMessages((prev) => {
					const idx = prev.length - 1;
					if (idx < 0) return prev;
					const role = prev[idx].role;
					if (role !== "assistant" && role !== "tool") return prev;
					const blocks = [...prev[idx].blocks];
					if (d.text) {
						const last = blocks[blocks.length - 1];
						if (last?.kind === "text") {
							blocks[blocks.length - 1] = { kind: "text", text: last.text + d.text };
						} else {
							blocks.push({ kind: "text", text: d.text });
						}
					}
					if (d.thinking) {
						const last = blocks[blocks.length - 1];
						if (last?.kind === "thinking") {
							blocks[blocks.length - 1] = {
								kind: "thinking",
								text: last.text + d.thinking,
							};
						} else {
							blocks.push({ kind: "thinking", text: d.thinking });
						}
					}
					if (d.tool) {
						const last = blocks[blocks.length - 1];
						if (last?.kind === "tool") {
							blocks[blocks.length - 1] = {
								kind: "tool",
								name: last.name,
								args: last.args + d.tool,
							};
						} else {
							blocks.push({ kind: "tool", name: "…", args: d.tool });
						}
					}
					const next = [...prev];
					next[idx] = { ...prev[idx], blocks };
					return next;
				});
			});
		});
	}, []);
	// Guards against overlapping connect() calls (double clicks, racing
	// auto-connect effects): the second caller awaits the in-flight attempt.
	const connectInFlightRef = useRef<Promise<boolean> | null>(null);
	// Latest connect target requested while another connect was in flight;
	// re-run after the in-flight attempt settles so the click isn't dropped.
	const connectPendingRef = useRef<ConnectOpts | null>(null);
	// Cooldown/failure tracking for the auto-connect effect so a broken pi
	// binary doesn't produce a reconnect loop.
	const autoConnectStateRef = useRef({ failures: 0 });

	// ---- settings side effects ----
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const theme = resolveTheme(settings.theme, mq.matches);
			document.documentElement.dataset.theme = theme;
			document.documentElement.dataset.platform = isMac ? "macos" : "other";
			document.documentElement.dataset.colorScale = settings.colorScale;
			document.documentElement.dataset.density = settings.density;
			// Keep the document language in sync with the UI language
			// (spell-check, screen readers, `<html lang>`).
			document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
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
		return () => mq.removeEventListener("change", apply);
	}, [
		settings.theme,
		settings.colorScale,
		settings.density,
		settings.language,
		settings.fontSize,
		settings.chatContentWidth,
		settings.chatLineSpacing,
		settings.chatFontFamily,
	]);

	// Persist settings separately, debounced: typing in a settings editor
	// (system prompt, append prompt, llama key) must not JSON-serialize the
	// whole object — including the plaintext llama API key — to localStorage
	// on every keystroke.
	useEffect(() => {
		const id = window.setTimeout(() => saveSettings(settings), 250);
		return () => window.clearTimeout(id);
	}, [settings]);

	// Settings-page changes to the default send mode also update the live
	// toggle (runtime composer switches only touch the state, not settings).
	useEffect(() => {
		setSendDuringRun(settings.sendDuringRunMode === "queue" ? "followUp" : "steer");
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
		localStorage.setItem(STORAGE_KEYS.expanded, JSON.stringify([...expandedProjects]));
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
		setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 2600);
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
		async (command: Record<string, unknown>, opts?: { id?: string }): Promise<PiEvent> => {
			// A caller-provided id lets `bash` stream events be correlated with
			// the originating command (bash_execution_update carries the id).
			const id = opts?.id ?? `gui-${nextId++}`;
			const timeoutMs = RESPONSE_TIMEOUTS[String(command.type)] ?? 60000;
			const event = await new Promise<PiEvent>((resolve, reject) => {
				const timer = setTimeout(() => {
					if (pendingRef.current.delete(id)) reject(new Error("timeout waiting for pi response"));
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
	const discoverNewSession = useCallback(
		async (navEpoch: number) => {
			for (let i = 0; i < 20; i++) {
				// The user switched sessions / disconnected / started a new task
				// while we were polling — stop promoting the just-created session
				// over their new selection.
				if (navEpochRef.current !== navEpoch) return;
				await new Promise((r) => setTimeout(r, 350));
				let file: string | null = null;
				try {
					const r = await handleResponse({ type: "get_state" });
					file =
						((r.data as { sessionFile?: string | null } | undefined)?.sessionFile as
							string | null | undefined) ?? null;
				} catch {
					/* pi may still be starting; keep polling */
				}
				if (!file) continue;
				const list = await refreshSessions();
				// Promote only once the scan actually lists the file, and swap
				// the selection + drop the placeholder in ONE batched update.
				// Updating the selection first used to open a window where
				// neither the pending row nor the real row matched workingPath,
				// so the running spinner blinked off — and stayed off for the
				// whole first run when the strict match kept failing (Windows
				// path spellings differ between pi's RPC and the scan).
				if (list.some((s) => sameSessionPath(s.path, file))) {
					// Only touch the refs/selection when the path actually changes
					// (the loop also runs while the user may have switched sessions).
					if (sessionPathRef.current !== file) {
						sessionPathRef.current = file;
						setSelectedSessionPath(file);
						localStorage.setItem(STORAGE_KEYS.lastSession, file);
					}
					setPendingSession(null);
					return;
				}
			}
		},
		[handleResponse, refreshSessions],
	);

	const refreshStats = useCallback(
		async (withPerf = false) => {
			try {
				const r = await handleResponse({ type: "get_session_stats" });
				const newStats = r.data as SessionStats;
				if (withPerf && newStats.tokens) {
					const tk = newStats.tokens;
					const totalInput = tk.input + tk.cacheRead;
					const ttft =
						firstTokenRef.current != null && turnStartRef.current != null
							? firstTokenRef.current - turnStartRef.current
							: null;
					if (ttft != null && ttft > 0) {
						ttftHistoryRef.current = [...ttftHistoryRef.current, ttft].slice(-20);
					}
					const avgTTFT =
						ttftHistoryRef.current.length > 0
							? ttftHistoryRef.current.reduce((a, b) => a + b, 0) / ttftHistoryRef.current.length
							: undefined;
					const outputDelta = tk.output - prevOutputTokensRef.current;
					const genTimeSec = totalGenTimeRef.current / 1000;
					const tokensPerSec =
						genTimeSec > 0 && outputDelta > 0 ? outputDelta / genTimeSec : undefined;
					newStats.perf = {
						cacheHitRate: totalInput > 0 ? (tk.cacheRead / totalInput) * 100 : undefined,
						avgTTFT,
						tokensPerSec,
					};
				}
				// Mid-run polls (withPerf=false) must not wipe the perf block
				// computed at the last settle — carry it over so the tooltip's
				// cache-hit/TTFT/t/s rows stay visible while a run is in flight.
				setStats((prev) =>
					!withPerf && prev?.perf ? { ...newStats, perf: prev.perf } : newStats,
				);
			} catch {
				/* older pi or no session */
			}
		},
		[handleResponse],
	);

	// Live context ring: poll session stats while a run is in flight so the
	// composer's context-usage ring advances as each message completes
	// instead of jumping only when the turn settles. pi aggregates stats
	// from in-memory entries, so mid-run reads are cheap and responsive.
	useEffect(() => {
		if (!connected || (!working && !streaming)) return;
		void refreshStats(false);
		const id = window.setInterval(() => void refreshStats(false), 1500);
		return () => window.clearInterval(id);
	}, [connected, working, streaming, refreshStats]);

	// Serialize attachments into pi's ImageContent format.
	const attachmentsToImages = useCallback((attachments: Attachment[]) => {
		return attachments
			.filter((a) => a.kind === "image" && a.dataUrl)
			.map((a) => {
				const parts = a.dataUrl!.split(",");
				const mimeType = a.dataUrl!.split(";")[0].split(":").slice(1).join(":") || "image/png";
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

	// Send one already-dequeued message: push the optimistic user message,
	// bump the run epoch, mark working, and dispatch the RPC. On failure the
	// optimistic message is marked with an error (never left as a silent
	// ghost). Shared by deliverQueuedNext and queueSendNow.
	const sendQueuedMessage = useCallback(
		async (item: QueuedChatMessage, sender: "steer" | "prompt") => {
			const message = item.text + attachmentsToText(item.attachments);
			const images = attachmentsToImages(item.attachments);
			turnStartRef.current = Date.now();
			firstTokenRef.current = null;
			msgGenStartRef.current = null;
			totalGenTimeRef.current = 0;
			prevOutputTokensRef.current = statsRef.current?.tokens?.output ?? 0;
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
				await send({ type: sender, message, images });
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
			}
		},
		[attachmentsToImages, attachmentsToText],
	);

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
			// Resolve the effective sender BEFORE sendQueuedMessage sets
			// working=true: workingRef still reflects the pre-delivery state.
			const effective = sender === "steer" && workingRef.current ? "steer" : "prompt";
			await sendQueuedMessage(next, effective);
		},
		[editingQueueId, sendQueuedMessage],
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
			const effective = workingRef.current ? "steer" : "prompt";
			await sendQueuedMessage(item, effective);
		},
		[sendQueuedMessage],
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
				if (
					method === "select" ||
					method === "confirm" ||
					method === "input" ||
					method === "editor"
				) {
					// A newer request overwrites the dialog; explicitly cancel the
					// still-pending one so its extension doesn't hang waiting for a
					// response that will never come.
					const previous = extensionRequestRef.current;
					if (previous) {
						const payload =
							previous.method === "confirm" ? { confirmed: false } : { cancelled: true };
						void send({
							type: "extension_ui_response",
							id: previous.id,
							...payload,
						}).catch(() => {});
					}
					const next: ExtensionRequest = {
						id: String(event.id),
						method,
						title: event.title as string | undefined,
						message: event.message as string | undefined,
						options: (event.options as string[] | undefined) ?? [],
						placeholder: event.placeholder as string | undefined,
						prefill: event.prefill as string | undefined,
					};
					extensionRequestRef.current = next;
					setExtensionRequest(next);
					return;
				}
				// Fire-and-forget UI methods.
				if (method === "setStatus") {
					const key = String(event.statusKey ?? "");
					// Extension status text often carries ANSI color codes (meant
					// for the TUI); the webview would render the raw escapes as
					// tofu boxes + literal parameters.
					const text = stripAnsi(String(event.statusText ?? "")) || undefined;
					if (!key) return;
					setExtensionStatus((prev) => {
						const next = { ...prev };
						if (text) next[key] = text;
						else delete next[key];
						return next;
					});
					return;
				}
				if (method === "setWidget") {
					const key = String(event.widgetKey ?? "");
					if (!key) return;
					const lines = (event.widgetLines as string[] | undefined)?.map(stripAnsi);
					const placement = event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor";
					setExtensionWidgets((prev) => {
						const next = { ...prev };
						if (lines && lines.length) next[key] = { lines, placement };
						else delete next[key];
						return next;
					});
					return;
				}
				if (method === "setTitle") {
					const title = stripAnsi(String(event.title ?? ""));
					document.title = title || "Tau";
					getCurrentWindow()
						.setTitle(title || "Tau")
						.catch(() => {
							/* ignore */
						});
					return;
				}
				if (method === "set_editor_text") {
					setExternalDraft(String(event.text ?? ""));
					return;
				}
				return;
			}
			if (event.type === "bash_execution_update") {
				// Stream direct `bash` command output into the open bash card.
				const id = event.id;
				const delta = (event.delta as string | undefined) ?? "";
				if (id && activeBashRef.current?.id === id) {
					const messageId = activeBashRef.current.messageId;
					setMessages((prev) => {
						const idx = prev.findIndex((m) => m.id === messageId);
						if (idx < 0) return prev;
						const next = [...prev];
						const m = next[idx];
						next[idx] = {
							...m,
							blocks: [
								{
									kind: "tool",
									name: "bash",
									args: (m.blocks[0]?.kind === "tool" ? m.blocks[0].args : "") + delta,
									result: true,
								},
							],
						};
						return next;
					});
				}
				return;
			}
			if (event.type === "message_start") {
				// A new message begins: drop any deltas that never flushed
				// (they belong to the previous message).
				clearPendingDeltas();
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
				// The authoritative block list replaces the streamed one;
				// discard any deltas still waiting to flush.
				clearPendingDeltas();
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
					if (msgGenStartRef.current !== null) {
						totalGenTimeRef.current += Date.now() - msgGenStartRef.current;
						msgGenStartRef.current = null;
					}
					const blocks: Block[] = (message.content ?? [])
						.map((item): Block | null => {
							if (item.type === "text") return { kind: "text", text: item.text ?? "" };
							if (item.type === "thinking") return { kind: "thinking", text: item.thinking ?? "" };
							if (item.type === "toolCall" || item.type === "tool_call") {
								return {
									kind: "tool",
									name: item.name ?? "tool",
									args: item.arguments !== undefined ? JSON.stringify(item.arguments, null, 2) : "",
								};
							}
							return null;
						})
						.filter((b): b is Block => b !== null);
					const errorMsg =
						message.stopReason === "error" ? (message.errorMessage ?? "error") : undefined;
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
						if (firstTokenRef.current === null) firstTokenRef.current = Date.now();
						if (msgGenStartRef.current === null) msgGenStartRef.current = Date.now();
						pendingDeltaRef.current = {
							...(pendingDeltaRef.current ?? {}),
							text: (pendingDeltaRef.current?.text ?? "") + (ame.delta ?? ""),
						};
						scheduleDeltaFlush();
						break;
					case "text_end":
						// content is the authoritative full text; drop buffered
						// text deltas so they can't append on top of it.
						if (pendingDeltaRef.current) {
							pendingDeltaRef.current.text = undefined;
						}
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
						pendingDeltaRef.current = {
							...(pendingDeltaRef.current ?? {}),
							thinking: (pendingDeltaRef.current?.thinking ?? "") + (ame.delta ?? ""),
						};
						scheduleDeltaFlush();
						break;
					case "toolcall_start":
						patchLast((m) => ({
							...m,
							blocks: [...m.blocks, { kind: "tool", name: "…", args: "" }],
						}));
						break;
					case "toolcall_delta":
						pendingDeltaRef.current = {
							...(pendingDeltaRef.current ?? {}),
							tool: (pendingDeltaRef.current?.tool ?? "") + (ame.delta ?? ""),
						};
						scheduleDeltaFlush();
						break;
					case "toolcall_end": {
						// The full arguments replace the streamed ones; drop
						// buffered tool deltas first.
						if (pendingDeltaRef.current) {
							pendingDeltaRef.current.tool = undefined;
						}
						const toolCall = ame.toolCall as { name?: string; arguments?: unknown } | undefined;
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
				clearPendingDeltas();
				patchLast((m) => ({ ...m, streaming: false }));
				setStreaming(false);
				setWorking(false);
				setPendingSession(null);
				setAborting(false);
				void refreshSessions();
				void refreshStats(true);
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
		[
			deliverQueuedNext,
			patchLast,
			refreshSessions,
			refreshStats,
			toast,
			clearPendingDeltas,
			scheduleDeltaFlush,
		],
	);

	useEffect(() => {
		const unlisteners: Promise<() => void>[] = [];
		(async () => {
			unlisteners.push(
				listen<PiEvent>("pi://event", (e) => handleEvent(e.payload)),
				listen<string>("pi://stderr", (e) => pushStderr(e.payload)),
				listen<unknown>("pi://exit", () => {
					setConnected(false);
					setStreaming(false);
					setWorking(false);
					turnStartRef.current = null;
					firstTokenRef.current = null;
					msgGenStartRef.current = null;
					totalGenTimeRef.current = 0;
					prevOutputTokensRef.current = 0;
					ttftHistoryRef.current = [];
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
	}, [handleEvent, refreshSessions, pushStderr, toast]);

	// The startup probe above runs while a fresh install's antivirus scan can
	// still make `node --version` take tens of seconds — every probe candidate
	// times out and binaryInfo() reports "pi binary not found" even though pi
	// is installed. Keep retrying while the error is shown (the backend cache
	// re-probes after its own backoff) so the banner clears itself once the
	// scan settles instead of sticking until an app restart.
	useEffect(() => {
		if (binError === null) {
			return;
		}
		const id = setInterval(() => {
			binaryInfo()
				.then((info) => {
					setBinary(info);
					setBinError(null);
				})
				.catch(() => {
					/* keep the original error text; retry on the next tick */
				});
		}, 10000);
		return () => clearInterval(id);
	}, [binError]);

	// ---- live subagent runs ----
	// Poll the pi-subagents extension's on-disk run status while the session
	// has activity (working, or a run seen recently). Idle sessions cost
	// nothing: no interval is armed until something is happening.
	useEffect(() => {
		const path = selectedSessionPath;
		if (!path || (!working && subagentRuns.length === 0)) {
			if (subagentRuns.length !== 0) setSubagentRuns([]);
			return;
		}
		let cancelled = false;
		const tick = () => {
			fetchSubagentRuns(path)
				.then((runs) => {
					if (!cancelled) setSubagentRuns(runs);
				})
				.catch(() => {});
		};
		tick();
		const id = setInterval(tick, 2500);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [working, selectedSessionPath, subagentRuns.length]);

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
		async (opts?: ConnectOpts): Promise<boolean> => {
			// Reuse the in-flight attempt instead of killing the pi process the
			// previous connect just spawned (that race wedged the UI on a
			// spurious pi://exit event). Remember the latest requested target so
			// it can be re-run once the in-flight attempt settles — a second
			// click must not be silently dropped.
			if (connectInFlightRef.current) {
				connectPendingRef.current = opts ?? {};
				return connectInFlightRef.current;
			}
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
					const sessionFile = opts?.sessionFile ?? null;
					// When resuming/opening an existing session, its project dir
					// (from the session header) is the source of truth for the
					// workspace — resolve it BEFORE the folder picker so clicking
					// a history session never pops the dialog. The picker is only
					// a fallback for sessions whose project is unknown.
					if (!ws && !explicitWs && sessionFile) {
						const known = sessions.find((s) => s.path === sessionFile);
						if (known?.project) {
							ws = known.project;
							setWorkspace(ws);
						}
					}
					if (!ws) {
						ws = await openWorkspace();
						if (!ws) return false;
						setWorkspace(ws);
					}
					// An explicitly requested workspace wins (e.g. right after
					// moving a session to a different project); otherwise the
					// session's project overrides a stale workspace so the
					// composer shows the directory pi actually runs in.
					if (sessionFile && !explicitWs) {
						const known = sessions.find((s) => s.path === sessionFile);
						if (known?.project && known.project !== ws) {
							ws = known.project;
							setWorkspace(ws);
						}
					}
					if (sessionFile) setPendingSession(null);
					navEpochRef.current += 1;
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
						appendSystemPrompt: settings.appendSystemPrompt || null,
						tools: settings.customTools.length ? settings.customTools : null,
						excludedTools: settings.excludedTools.length ? settings.excludedTools : null,
						// Scoped model patterns for Ctrl+P cycling (/scoped-models).
						models: settings.scopedModels.length ? settings.scopedModels.join(",") : null,
					};
					// A session file can only be driven by ONE pi process (the
					// backend rejects a second window opening the same JSONL).
					// Fall back to a fresh session instead so a new window is
					// still usable while the other window owns the session.
					let effectiveSession = sessionFile;
					try {
						await start(ws, effectiveSession, startOpts);
					} catch (e) {
						if (effectiveSession && String(e).includes("already open in another window")) {
							localStorage.removeItem(STORAGE_KEYS.lastSession);
							navEpochRef.current += 1;
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
					// Context ring: refresh for the session being opened right
					// away. The init effect only reruns when `connected` flips —
					// i.e. never when switching sessions while already connected —
					// and its own stats fetch trails the slow provider probe, so
					// without this the ring would show the previous session's
					// numbers (or nothing on first entry) until a run settles.
					setStats(null);
					void refreshStats(false);
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
					// A connect arrived while this one was in flight: run it now.
					const pending = connectPendingRef.current;
					connectPendingRef.current = null;
					if (pending) {
						void connect(pending);
					}
				}
			}
		},
		[
			workspace,
			loadHistory,
			refreshStats,
			settings.systemPrompt,
			settings.appendSystemPrompt,
			settings.customTools,
			settings.excludedTools,
			settings.scopedModels,
			sessions,
			toast,
		],
	);

	// Back/forward: move through the session navigation history (connect
	// directly so the move itself is never recorded as a new entry).
	const navGo = useCallback(
		async (dir: -1 | 1) => {
			const idx = navIndexRef.current + dir;
			const target = navHistoryRef.current[idx];
			if (idx < 0 || idx >= navHistoryRef.current.length || !target) return;
			navIndexRef.current = idx;
			setNavIndex(idx);
			await connect({ sessionFile: target });
		},
		[connect],
	);

	const disconnect = useCallback(async () => {
		// pi_stop can reject if the process already exited (crash, external
		// kill). disconnect must never throw — several callers fire-and-forget
		// it — so swallow the stop failure and still reset the local state.
		try {
			await stop();
		} catch {
			/* pi already dead; proceed with the local reset */
		}
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
		// Already on a fresh task (no session file yet): nothing to reset —
		// clicking again just disconnects and re-runs the workspace dialog.
		// Hint instead of tearing down the blank task.
		if (!sessionPathRef.current && !pendingSession) {
			toast(t.app.alreadyNewTask);
			return;
		}
		await disconnect();
		setMessages([]);
		await connect({ sessionFile: null });
	}, [connect, disconnect, pendingSession, toast, t]);

	const openSession = useCallback(
		async (session: PiSessionInfo) => {
			pushNav(session.path);
			await connect({ sessionFile: session.path });
		},
		[connect, pushNav],
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
					const data = resp.data as
						| {
								models?: (ModelEntry & { thinkingLevels?: string[] })[];
						  }
						| undefined;
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
				const stateData = stateResp.data as
					| {
							model?: ModelEntry | null;
							thinkingLevel?: string;
					  }
					| undefined;
				const current = stateData?.model;
				if (current) {
					// pi's actual session model wins over any stale local value.
					setModel(`${current.provider}/${current.id}`);
				} else if (list.length > 0) {
					// Fall back to the persisted choice, but only when it still
					// exists in the available models; otherwise pick the first.
					setModel((prev) => {
						if (prev && list.some((m) => `${m.provider}/${m.id}` === prev)) {
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
				const levels = (thinkingResp.data as { levels?: string[] } | undefined)?.levels ?? [];
				if (levels.length) {
					setThinkingLevels(levels);
					setThinkingLevel((prev) => prev || levels[0]);
				}
			} catch {
				/* older pi */
			}
			try {
				const statsResp = await handleResponse({ type: "get_session_stats" });
				if (!cancelled) {
					const loaded = statsResp.data as SessionStats;
					const tk = loaded.tokens;
					if (tk && tk.cacheRead > 0) {
						loaded.perf = {
							...(loaded.perf ?? {}),
							cacheHitRate:
								tk.input + tk.cacheRead > 0
									? (tk.cacheRead / (tk.input + tk.cacheRead)) * 100
									: undefined,
						};
					}
					setStats(loaded);
				}
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
				// Queue delivery modes + auto-compaction (TUI /settings).
				await send({
					type: "set_steering_mode",
					mode: settingsRef.current.steeringMode,
				});
				await send({
					type: "set_follow_up_mode",
					mode: settingsRef.current.followUpMode,
				});
				await send({
					type: "set_auto_compaction",
					enabled: settingsRef.current.autoCompaction,
				});
			} catch {
				/* older pi */
			}
			try {
				// Slash commands (extension commands, prompt templates, skills).
				const cmdResp = await handleResponse({ type: "get_commands" });
				if (!cancelled) {
					setCommands((cmdResp.data as { commands?: PiCommand[] } | undefined)?.commands ?? []);
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
				// Wait for the switch to settle before refetching stats: pi can
				// answer a get_session_stats sent after set_model BEFORE the new
				// model is applied, which would leave the context ring showing
				// the old model's window.
				await handleResponse({ type: "set_model", provider, modelId });
				void refreshStats(false);
			} catch (e) {
				setError(String(e));
			}
		},
		[handleResponse, refreshStats],
	);

	const changeThinkingLevel = useCallback(async (level: string) => {
		setThinkingLevel(level);
		try {
			await send({ type: "set_thinking_level", level });
		} catch (e) {
			setError(String(e));
		}
	}, []);

	// Cycle to the next available model (TUI Ctrl+P). The RPC command only
	// cycles forward; the response carries the new model (or null when there
	// is only one model in scope).
	const cycleModel = useCallback(async () => {
		if (!connected) return;
		try {
			const r = await handleResponse({ type: "cycle_model" });
			const data = r.data as { model?: ModelEntry | null } | undefined;
			if (data?.model) {
				setModel(`${data.model.provider}/${data.model.id}`);
				// cycle_model already resolved, so the new model is applied —
				// safe to refetch the context window right away.
				void refreshStats(false);
			}
		} catch (e) {
			setError(String(e));
		}
	}, [connected, handleResponse, refreshStats]);

	// Cycle to the next thinking level (TUI Shift+Tab).
	const cycleThinkingLevel = useCallback(async () => {
		if (!connected) return;
		try {
			const r = await handleResponse({ type: "cycle_thinking_level" });
			const data = r.data as { level?: string } | null | undefined;
			if (data?.level) setThinkingLevel(data.level);
		} catch (e) {
			setError(String(e));
		}
	}, [connected, handleResponse]);

	// Ask the user for the selected provider's API key when it's missing,
	// right in the chat. Returns true when sending may proceed.
	const ensureProviderKey = useCallback(async (): Promise<boolean> => {
		if (!model) return true;
		const slash = model.indexOf("/");
		const provider = slash > 0 ? model.slice(0, slash) : "";
		if (!provider) return true;
		let statuses: AuthProviderStatus[];
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
			// Queue the resolver instead of storing a single slot: two
			// overlapping sends (Enter + click, queued delivery racing a manual
			// send) each push a resolver, and save/cancel resolves all of them —
			// the first send can no longer hang forever.
			apiKeyResolversRef.current.push(resolve);
			setApiKeyDialog({ provider });
		});
	}, [model]);

	const handleApiKeySave = useCallback(
		async (provider: string, key: string) => {
			await authSetKey(provider, key); // throws on failure
			setAuthProviders(await authStatus());
			const resolvers = apiKeyResolversRef.current;
			apiKeyResolversRef.current = [];
			for (const r of resolvers) r(true);
			setApiKeyDialog(null);
			toast(t.keyDialog.saved);
		},
		[t, toast],
	);

	const handleApiKeyCancel = useCallback(() => {
		const resolvers = apiKeyResolversRef.current;
		apiKeyResolversRef.current = [];
		for (const r of resolvers) r(false);
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

	// Direct shell command (TUI `!cmd` / `!!cmd`): executed via the RPC
	// `bash` command; output streams into a chat card and (for `!`) is
	// included in the next prompt's context. `!!` hides it from context.
	const runBash = useCallback(
		async (command: string, excludeFromContext: boolean) => {
			setError(null);
			const id = `gui-bash-${nextId++}`;
			const messageId = nextId++;
			setMessages((prev) => [
				...prev,
				{
					id: messageId,
					role: "tool",
					blocks: [
						{
							kind: "tool",
							name: "bash",
							args: `$ ${command}\n`,
							result: true,
						},
					],
					streaming: true,
				},
			]);
			activeBashRef.current = { id, messageId };
			runEpochRef.current += 1;
			setWorking(true);
			try {
				const r = await handleResponse(
					{
						type: "bash",
						command,
						excludeFromContext,
					},
					{ id },
				);
				const data = r.data as
					| {
							output?: string;
							exitCode?: number;
							truncated?: boolean;
							cancelled?: boolean;
					  }
					| undefined;
				const output = data?.output ?? "";
				const exitCode = data?.exitCode;
				const suffix = data?.truncated
					? "\n… (output truncated)"
					: exitCode !== undefined && exitCode !== 0
						? `\n[exit ${exitCode}]`
						: "";
				setMessages((prev) =>
					prev.map((m) =>
						m.id === messageId
							? {
									...m,
									streaming: false,
									blocks: [
										{
											kind: "tool",
											name: "bash",
											args: `$ ${command}\n\n${output}${suffix}`,
											result: true,
											error: exitCode !== 0 ? true : undefined,
										},
									],
								}
							: m,
					),
				);
			} catch (e) {
				setMessages((prev) =>
					prev.map((m) => (m.id === messageId ? { ...m, streaming: false, error: String(e) } : m)),
				);
				setError(String(e));
			} finally {
				if (activeBashRef.current?.messageId === messageId) {
					activeBashRef.current = null;
				}
				setWorking(false);
			}
		},
		[handleResponse],
	);

	const submit = useCallback(
		async (
			text: string,
			attachments: Attachment[],
			behavior: SendBehavior,
			editingQueueIdArg?: string | null,
		): Promise<boolean> => {
			if (!text.trim() && attachments.length === 0) return false;

			// Editing a queued message: save the draft back into the queue.
			if (editingQueueIdArg) {
				const next = queuedRef.current.map((m) =>
					m.id === editingQueueIdArg ? { ...m, text, attachments } : m,
				);
				queuedRef.current = next;
				setQueuedMessages(next);
				setEditingQueueId(null);
				setQueuePaused(false);
				return true;
			}

			// Allow composing as soon as a workspace is chosen: lazily spin up a
			// fresh session on the first send instead of forcing "New task".
			if (!connected) {
				if (!workspace) return false;
				const ok = await connect({ sessionFile: null });
				if (!ok) return false;
			}
			setError(null);

			const images = attachmentsToImages(attachments);
			const fullText = text + attachmentsToText(attachments);

			// Direct shell commands: `!cmd` runs and sends the output to the
			// model on the next prompt; `!!cmd` runs without sending it. These
			// don't need a provider API key, so they skip the key gate below.
			if (fullText.startsWith("!") && fullText.length > 1) {
				const excludeFromContext = fullText.startsWith("!!");
				const command = fullText.replace(/^!+/, "").trim();
				if (command) {
					await runBash(command, excludeFromContext);
					return true;
				}
			}

			// Provider API-key gate: ask inline before sending when missing.
			if (!(await ensureProviderKey())) return false;

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
					return true;
				}
			}

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
			turnStartRef.current = Date.now();
			firstTokenRef.current = null;
			msgGenStartRef.current = null;
			totalGenTimeRef.current = 0;
			prevOutputTokensRef.current = statsRef.current?.tokens?.output ?? 0;

			// New task: show it in the sidebar immediately instead of waiting
			// for pi to flush the session file. discoverNewSession() promotes
			// this placeholder to the real entry once the file exists.
			const isNew = isNewSessionRef.current;
			// Capture the navigation epoch before sending: if the user switches
			// sessions while the prompt is in flight (or while discoverNewSession
			// polls), the epoch changes and the poll aborts instead of yanking
			// the selection back to this session.
			const navEpoch = navEpochRef.current;
			const title = text.trim().slice(0, 60) || (attachments[0]?.name ?? "New session");
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
					void discoverNewSession(navEpoch);
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
			return true;
		},
		[
			connected,
			workspace,
			connect,
			discoverNewSession,
			ensureProviderKey,
			attachmentsToImages,
			attachmentsToText,
			working,
			sendDuringRun,
			runBash,
		],
	);

	const abortWatchdogRef = useRef<number>(0);

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
		window.clearTimeout(abortWatchdogRef.current);
		abortWatchdogRef.current = window.setTimeout(() => {
			if (runEpochRef.current !== epoch || (!workingRef.current && !streamingRef.current)) return;
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

	const compact = useCallback(
		async (customInstructions?: string) => {
			try {
				await send({
					type: "compact",
					...(customInstructions ? { customInstructions } : {}),
				});
				toast(t.chat.compacting);
			} catch (e) {
				setError(String(e));
			}
		},
		[t, toast],
	);

	const copyConversation = useCallback(async (): Promise<boolean> => {
		const md = messages.map(chatMessageToMarkdown).filter(Boolean).join("\n\n");
		if (!md) return false;
		try {
			await navigator.clipboard.writeText(md);
			return true;
		} catch {
			return false;
		}
	}, [messages]);

	const renameSession = useCallback(
		async (name: string) => {
			if (!connected || !name.trim()) return;
			try {
				await send({ type: "set_session_name", name: name.trim() });
				await refreshSessions();
			} catch (e) {
				setError(String(e));
			}
		},
		[connected, refreshSessions],
	);

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
						if (wasCurrent && workspace) void connect({ sessionFile: null });
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
					await exportChat(preview.path, parsedMessagesToMarkdown(preview.messages), "markdown");
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
				body: t.confirm.deleteProjectBody.replace("{count}", String(projectSessions.length)),
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					const current = sessionPathRef.current;
					const includesCurrent =
						current != null && projectSessions.some((s) => s.path === current);
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

	const handlePurgeAll = useCallback(() => {
		if (archived.length === 0) return;
		setConfirmState({
			title: t.confirm.purgeAllTitle,
			body: t.confirm.purgeAllBody.replace("{count}", String(archived.length)),
			confirmLabel: t.settings.deleteAllArchived,
			onConfirm: async () => {
				for (const a of archived) {
					try {
						await purgeSession(a.path);
					} catch {
						/* continue */
					}
				}
				await refreshSessions();
				toast(t.app.delete);
			},
		});
	}, [archived, refreshSessions, toast, t]);

	const handlePurgeProject = useCallback(
		(project: string | null) => {
			const targets = archived.filter((a) => a.project === project);
			if (targets.length === 0) return;
			const name = project
				? projectNameFromPath(project)
				: t.settings.noProject;
			setConfirmState({
				title: t.confirm.purgeProjectTitle,
				body: t.confirm.purgeProjectBody
					.replace("{project}", name)
					.replace("{count}", String(targets.length)),
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					for (const a of targets) {
						try {
							await purgeSession(a.path);
						} catch {
							/* continue */
						}
					}
					await refreshSessions();
					toast(t.app.delete);
				},
			});
		},
		[archived, refreshSessions, toast, t],
	);

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

	// Same operation for archived/trashed sessions (never running, so no
	// disconnect/reconnect dance).
	const handleCompactArchived = useCallback(
		async (path: string) => {
			setConfirmState({
				title: t.confirm.compactImagesTitle,
				body: t.confirm.compactImagesBodyArchived,
				confirmLabel: t.app.confirm,
				onConfirm: async () => {
					try {
						const r = await compactSessionImages(path);
						await refreshSessions();
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
		},
		[t, refreshSessions, toast],
	);

	const handleExtensionRespond = useCallback(
		async (id: string, payload: Record<string, unknown>) => {
			extensionRequestRef.current = null;
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
				const sessionFile = (state.data as { sessionFile?: string | null } | undefined)
					?.sessionFile;
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

	// ---- /tree: build the session tree from the JSONL file and open the
	// navigator. The RPC get_tree is not used: pi serializes the tree as one
	// deeply nested JSON line (thousands of levels for long sessions), which
	// serde_json refuses to parse beyond 128 levels and the webview IPC would
	// choke on anyway. Reading the file directly is fast and immune to the
	// pi process state (the leaf marker falls back to the last entry).
	const openTree = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) {
			setError(t.tree.unavailable);
			return;
		}
		try {
			setTreeData((await readTree(path)) as PiTreeData);
			setTreeOpen(true);
		} catch (e) {
			setError(String(e));
		}
	}, [t]);

	// ---- /session: fetch details for the info dialog ----
	const openSessionInfo = useCallback(async () => {
		if (!connected) return;
		try {
			const [stateResp, statsResp] = await Promise.all([
				handleResponse({ type: "get_state" }),
				handleResponse({ type: "get_session_stats" }).catch(() => null),
			]);
			setSessionInfoData({
				state: (stateResp.data as Record<string, unknown>) ?? {},
				stats: (statsResp?.data as SessionStats) ?? null,
			});
			setSessionInfoOpen(true);
		} catch (e) {
			setError(String(e));
		}
	}, [connected, handleResponse]);

	// ---- /share: upload the session as a private GitHub gist ----
	const share = useCallback(async () => {
		const path = sessionPathRef.current;
		if (!path) return;
		try {
			const url = await shareSession(path);
			setShareUrl(url);
		} catch (e) {
			setError(String(e));
		}
	}, []);

	// ---- /import: import a JSONL session file ----
	const importSessionCmd = useCallback(async () => {
		try {
			const path = await importSession();
			if (!path) return;
			await refreshSessions();
			toast(t.chat.imported);
			await connect({ sessionFile: path });
		} catch (e) {
			setError(String(e));
		}
	}, [refreshSessions, connect, toast, t]);

	const handleSearchSelect = useCallback(
		async (path: string) => {
			pushNav(path);
			const s = sessions.find((x) => x.path === path);
			await connect({ sessionFile: s?.path ?? path });
		},
		[connect, sessions, pushNav],
	);

	// ---- /reload: restart pi so extensions/skills/prompts/themes reload ----
	const reload = useCallback(async () => {
		if (busy) {
			toast(t.chat.busyToast);
			return;
		}
		const resume = sessionPathRef.current;
		await disconnect();
		setMessages([]);
		await connect({ sessionFile: resume });
		toast(t.chat.reloaded);
	}, [busy, disconnect, connect, toast, t]);

	// Custom providers live in models.json, which pi reads at process start —
	// the running session's model catalog is a snapshot that only a reconnect
	// refreshes. Reload silently when idle; never interrupt a running agent.
	const handleCustomProvidersChanged = useCallback(() => {
		if (!connected) return;
		if (streaming || working) {
			toast(t.settings.providerSavedNeedsReload);
			return;
		}
		void reload();
	}, [connected, streaming, working, reload, toast, t]);

	// ---- /trust: current project decision + global fallback ----
	const refreshTrust = useCallback(async () => {
		try {
			const [decision, def] = await Promise.all([
				workspace ? trustGet(workspace) : Promise.resolve(null),
				trustDefaultGet(),
			]);
			setTrustDecision(decision);
			setTrustDefault(def);
		} catch {
			/* trust store may not exist yet */
		}
	}, [workspace]);
	useEffect(() => {
		void refreshTrust();
	}, [refreshTrust]);

	const setProjectTrust = useCallback(
		async (decision: boolean | null) => {
			if (!workspace) return;
			try {
				await trustSet(workspace, decision);
				setTrustDecision(decision);
				toast(
					decision === null ? t.chat.trustCleared : decision ? t.chat.trusted : t.chat.trustDenied,
				);
			} catch (e) {
				setError(String(e));
			}
		},
		[workspace, t, toast],
	);

	const setDefaultTrust = useCallback(
		async (value: string) => {
			try {
				await trustDefaultSet(value);
				setTrustDefault(value);
				toast(t.chat.trustDefaultSaved);
			} catch (e) {
				setError(String(e));
			}
		},
		[t, toast],
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

	// Native system menu commands (macOS menu bar) forwarded from Rust. "New
	// Window" is handled in Rust; everything else is renderer-side state.
	useEffect(() => {
		const unlisten = listen<string>("menu://command", (e) => {
			switch (e.payload) {
				case "about":
					setSettingsOpen(true);
					break;
				case "session-info":
					void openSessionInfo();
					break;
				case "tree":
					void openTree();
					break;
				case "toggle-sidebar":
					toggleSidebar();
					break;
			}
		});
		return () => {
			void unlisten.then((f) => f());
		};
	}, [openSessionInfo, openTree, toggleSidebar]);

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
		const backoff = st.failures === 0 ? 0 : Math.min(30000, 3000 * 2 ** (st.failures - 1));
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
			if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
				return;
			}
			if (
				confirmState ||
				renameState ||
				apiKeyDialog ||
				extensionRequest ||
				searchOpen ||
				archivedPreview ||
				treeOpen ||
				sessionInfoOpen ||
				hotkeysOpen ||
				scopedModelsOpen ||
				compactOpen ||
				shareUrl
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
		treeOpen,
		sessionInfoOpen,
		hotkeysOpen,
		scopedModelsOpen,
		compactOpen,
		shareUrl,
		connected,
		abort,
	]);

	// ---- keyboard shortcuts ----
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// Don't fire app-level shortcuts while typing in an input/textarea
			// (composer, settings editors, menu search boxes) — Ctrl+N would
			// otherwise tear down the current session and draft mid-keystroke.
			const el = e.target as HTMLElement | null;
			if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
				return;
			}
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
			} else if (key === "[" && !e.shiftKey) {
				e.preventDefault();
				void navGo(-1);
			} else if (key === "]" && !e.shiftKey) {
				e.preventDefault();
				void navGo(1);
			} else if (key === "l") {
				e.preventDefault();
				focusComposer();
			} else if (e.shiftKey && key === "a") {
				e.preventDefault();
				void archiveCurrent();
			} else if (key === "p" && !e.shiftKey) {
				// Ctrl+P: cycle to the next model (TUI ctrl+p).
				e.preventDefault();
				void cycleModel();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [newTask, toggleSidebar, focusComposer, archiveCurrent, busy, toast, t, cycleModel, navGo]);

	// ---- sidebar resize ----
	const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
	const startResize = useCallback(
		(e: React.PointerEvent) => {
			resizeRef.current = { startX: e.clientX, startW: sidebarWidth };
			// Throttle to one update per animation frame: pointermove can fire far
			// faster than a frame, and each setSidebarWidth re-renders the whole
			// App (the memoized children skip, but the shell still runs).
			let raf = 0;
			let pendingW = 0;
			const onMove = (ev: PointerEvent) => {
				if (!resizeRef.current) return;
				pendingW = Math.min(
					340,
					Math.max(200, resizeRef.current.startW + ev.clientX - resizeRef.current.startX),
				);
				if (raf) return;
				raf = requestAnimationFrame(() => {
					raf = 0;
					setSidebarWidth(pendingW);
				});
			};
			const onUp = () => {
				if (raf) cancelAnimationFrame(raf);
				resizeRef.current = null;
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[sidebarWidth],
	);

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
				? (sessions.find((s) => s.path === sessionPathRef.current) ?? null)
				: null),
		[sessions, selectedSessionPath],
	);

	// Merge the optimistic new-task placeholder into the sidebar list, and
	// treat it as the selected session until its real file is discovered.
	const sidebarSessions = useMemo<PiSessionInfo[]>(() => {
		if (!pendingSession) return sessions;
		return [pendingSession, ...sessions];
	}, [sessions, pendingSession]);
	const effectiveSelectedPath = selectedSessionPath ?? pendingSession?.path ?? null;
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
			onToggleSidebar={toggleSidebar}
			onBack={() => void navGo(-1)}
			onForward={() => void navGo(1)}
			canGoBack={canGoBack}
			canGoForward={canGoForward}
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
			binError={binError}
		/>
	);

	return (
		<div
			className={`app${fullscreen ? " fullscreen" : ""}${fsTransitioning ? " fs-transitioning" : ""}`}
		>
			{isWin && (
				<TitleBar
					t={t}
					onNewWindow={() => void newWindow()}
					onOpenSettings={() => setSettingsOpen(true)}
					onToggleSidebar={toggleSidebar}
					onSessionInfo={() => void openSessionInfo()}
					onTree={() => void openTree()}
				/>
			)}
			<div className={`shell${sidebarCollapsed ? " collapsed" : ""}`}>
				{!settingsOpen && (
					<>
						{/* Always mounted so the collapse/expand animates the width
						    smoothly (the chat area flexes to fill the freed space).
						    The inner wrapper keeps the sidebar content at its real
						    width so it doesn't reflow while the shell shrinks. */}
						<div
							className={`sidebar-shell${sidebarCollapsed ? " collapsed" : ""}`}
							style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
							aria-hidden={sidebarCollapsed}
						>
							<div className="sidebar-fixed" style={{ width: sidebarWidth }}>
								{sidebarEl}
							</div>
						</div>
						<div
							className={`sidebar-resizer${sidebarCollapsed ? " hidden" : ""}`}
							onPointerDown={startResize}
						/>
					</>
				)}

				<div className={`chat-area-shell${settingsOpen ? " hidden" : ""}`}>
					<ChatArea
						t={t}
						session={selectedSession}
						messages={messages}
						streaming={streaming}
						working={working}
						subagentRuns={subagentRuns}
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
						onCompact={() => setCompactOpen(true)}
						onCopy={copyConversation}
						onExport={exportSession}
						onExportHtml={exportSessionHtml}
						onRename={() =>
							setRenameState({ title: t.chat.rename, initial: selectedSession?.title ?? "" })
						}
						onArchive={archiveCurrent}
						onDelete={deleteCurrent}
						onCompactImages={handleCompactImages}
						onReveal={revealCurrent}
						onTree={openTree}
						onSessionInfo={openSessionInfo}
						onShare={share}
						onImport={importSessionCmd}
						onHotkeys={() => setHotkeysOpen(true)}
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
						sidebarCollapsed={sidebarCollapsed}
						onToggleSidebar={toggleSidebar}
						onNewTask={() => void newTask()}
						onBack={() => void navGo(-1)}
						onForward={() => void navGo(1)}
						canGoBack={canGoBack}
						canGoForward={canGoForward}
						customTools={settings.customTools}
						onCustomToolsChange={(tools) =>
							setSettings((prev) => ({ ...prev, customTools: tools }))
						}
						showContextUsage={settings.showContextUsage}
						modelsLoading={modelsLoading}
						commands={commands}
						extensionWidgets={extensionWidgets}
						extensionStatus={Object.values(extensionStatus)}
						externalDraft={externalDraft}
						onExternalDraftConsumed={() => setExternalDraft(null)}
						onCycleThinking={cycleThinkingLevel}
					/>
				</div>
				{settingsOpen && (
					<SettingsPanel
						t={t}
						settings={settings}
						onChange={setSettings}
						binary={binary}
						sessionDir={sessionDirRef.current}
						archived={archived}
						onRestore={handleRestore}
						onPurge={handlePurge}
						onPurgeAll={handlePurgeAll}
						onPurgeProject={handlePurgeProject}
						onViewArchived={openArchivedPreview}
						onCompactArchived={handleCompactArchived}
						onClose={() => setSettingsOpen(false)}
						onOpenSessionDir={openSessionDir}
						onOpenScopedModels={() => setScopedModelsOpen(true)}
						onReload={reload}
						onOpenLlama={() => setLlamaOpen(true)}
						workspace={workspace}
						trustDecision={trustDecision}
						trustDefault={trustDefault}
						onSetProjectTrust={(d) => void setProjectTrust(d)}
						onSetDefaultTrust={(v) => void setDefaultTrust(v)}
						projects={Array.from(
							new Set(
								sessions
									.map((s) => s.project)
									.filter((p): p is string => !!p),
							),
						).sort()}
						onCustomProvidersChanged={handleCustomProvidersChanged}
					/>
				)}
			</div>

			<SearchOverlay
				t={t}
				open={searchOpen}
				onClose={() => setSearchOpen(false)}
				onSelect={handleSearchSelect}
			/>

			<ExtensionDialog request={extensionRequest} onRespond={handleExtensionRespond} t={t} />

			{confirmState && (
				<div className="overlay-backdrop">
					<div
						className="extension-dialog confirm-dialog"
						role="dialog"
						aria-modal="true"
						onKeyDown={(e) => {
							if (e.key === "Escape") setConfirmState(null);
						}}
					>
						<h3>{confirmState.title}</h3>
						<p className="extension-message">{confirmState.body}</p>
						<div className="extension-dialog-actions">
							<button className="btn secondary" autoFocus onClick={() => setConfirmState(null)}>
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

			<TreePanel
				open={treeOpen}
				data={treeData}
				t={t}
				onClose={() => setTreeOpen(false)}
				onFork={async (entryId) => {
					setTreeOpen(false);
					await handleForkFromMessage(entryId);
				}}
			/>

			<SessionInfoDialog
				open={sessionInfoOpen}
				data={sessionInfoData}
				t={t}
				onClose={() => setSessionInfoOpen(false)}
			/>

			<HotkeysDialog open={hotkeysOpen} t={t} onClose={() => setHotkeysOpen(false)} />

			<ScopedModelsDialog
				open={scopedModelsOpen}
				models={settings.scopedModels}
				t={t}
				onClose={() => setScopedModelsOpen(false)}
				onSave={(patterns) => setSettings((prev) => ({ ...prev, scopedModels: patterns }))}
			/>

			<CompactDialog
				open={compactOpen}
				t={t}
				onClose={() => setCompactOpen(false)}
				onConfirm={(instructions) => {
					setCompactOpen(false);
					void compact(instructions || undefined);
				}}
			/>

			<ShareDialog url={shareUrl} t={t} onClose={() => setShareUrl(null)} />

			<LlamaDialog
				open={llamaOpen}
				url={settings.llamaServerUrl}
				apiKey={settings.llamaApiKey}
				t={t}
				onClose={() => setLlamaOpen(false)}
			/>

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
			<div className="extension-dialog" role="dialog" aria-modal="true">
				<h3>{t.keyDialog.title}</h3>
				<p className="extension-message">{t.keyDialog.body.replace("{provider}", provider)}</p>
				<input
					ref={inputRef}
					type="password"
					autoFocus
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
	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog" role="dialog" aria-modal="true">
				<h3>{state.title}</h3>
				<input
					ref={inputRef}
					autoFocus
					onFocus={(e) => e.currentTarget.select()}
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
