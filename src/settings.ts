export type Theme = "light" | "dark" | "system";
export type ColorScale = "mist" | "paper" | "sand" | "gray" | "forest" | "ocean";
export type Density = "compact" | "comfortable" | "relaxed";

/** Pi built-in agent tool names (matches pi's `--tools` allowlist). */
export type AgentToolName =
	| "read"
	| "write"
	| "edit"
	| "bash"
	| "grep"
	| "find"
	| "ls";

export const ALL_AGENT_TOOLS: AgentToolName[] = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
];

/** Chat typography options (mirrors the Ousia settings surface). */
export type ChatFontFamily = "system" | "lxgwWenkai" | "zhuqueFangsong";
export type ChatContentWidth = "standard" | "wide" | "extraWide";
export type ChatLineSpacing = "compact" | "standard" | "relaxed";

export interface AppSettings {
	theme: Theme;
	colorScale: ColorScale;
	fontSize: number;
	density: Density;
	language: "zh" | "en";
	thinkingLevel: string;
	systemPrompt: string;
	/** Tools Pi is allowed to use. Empty array = all tools enabled. */
	customTools: AgentToolName[];
	/** Tools Pi is explicitly forbidden from using (--exclude-tools). */
	excludedTools: AgentToolName[];
	/** Appended to the system prompt without replacing it (--append-system-prompt). */
	appendSystemPrompt: string;
	/** llama.cpp router server URL (/llama). */
	llamaServerUrl: string;
	/** Optional API key for the llama.cpp router. */
	llamaApiKey: string;
	/** After an interrupt, keep delivering the queued follow-up messages. */
	continueQueuedAfterInterrupt: boolean;
	/** Chat font family (chat messages only; falls back to system fonts). */
	chatFontFamily: ChatFontFamily;
	/** Max width of the chat column. */
	chatContentWidth: ChatContentWidth;
	/** Chat line-height. */
	chatLineSpacing: ChatLineSpacing;
	/** Default send behavior while the agent is running. */
	sendDuringRunMode: "steer" | "queue";
	/** Steering delivery mode (TUI `set_steering_mode`). */
	steeringMode: "all" | "one-at-a-time";
	/** Follow-up delivery mode (TUI `set_follow_up_mode`). */
	followUpMode: "all" | "one-at-a-time";
	/** Ask pi to compact the context automatically at the threshold. */
	autoCompaction: boolean;
	/** Model patterns for Ctrl+P cycling (TUI `/scoped-models`, `--models`). */
	scopedModels: string[];
	/** Show the context-window usage badge in the chat header. */
	showContextUsage: boolean;
	/** Ask pi to auto-retry transient failures (overload, rate limit, 5xx). */
	autoRetryOnFailure: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
	theme: "system",
	colorScale: "mist",
	fontSize: 14,
	density: "comfortable",
	language: "zh",
	thinkingLevel: "medium",
	systemPrompt: "",
	customTools: [],
	excludedTools: [],
	appendSystemPrompt: "",
	llamaServerUrl: "http://127.0.0.1:8080",
	llamaApiKey: "",
	continueQueuedAfterInterrupt: true,
	chatFontFamily: "system",
	chatContentWidth: "standard",
	chatLineSpacing: "standard",
	sendDuringRunMode: "steer",
	steeringMode: "all",
	followUpMode: "one-at-a-time",
	autoCompaction: true,
	scopedModels: [],
	showContextUsage: true,
	autoRetryOnFailure: true,
};

export const SETTINGS_KEY = "pi-gui.settings.v5";

const ALL_TOOL_SET = new Set<string>(ALL_AGENT_TOOLS);

export function loadSettings(): AppSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return DEFAULT_SETTINGS;
		const parsed = JSON.parse(raw) as Partial<AppSettings>;
		const customTools = Array.isArray(parsed.customTools)
			? parsed.customTools.filter(
					(t): t is AgentToolName =>
						typeof t === "string" && ALL_TOOL_SET.has(t),
				)
			: DEFAULT_SETTINGS.customTools;
		const chatFontFamily =
			parsed.chatFontFamily === "lxgwWenkai" ||
			parsed.chatFontFamily === "zhuqueFangsong"
				? parsed.chatFontFamily
				: DEFAULT_SETTINGS.chatFontFamily;
		const chatContentWidth =
			parsed.chatContentWidth === "wide" ||
			parsed.chatContentWidth === "extraWide"
				? parsed.chatContentWidth
				: DEFAULT_SETTINGS.chatContentWidth;
		const chatLineSpacing =
			parsed.chatLineSpacing === "compact" ||
			parsed.chatLineSpacing === "relaxed"
				? parsed.chatLineSpacing
				: DEFAULT_SETTINGS.chatLineSpacing;
		return {
			...DEFAULT_SETTINGS,
			...parsed,
			language:
				parsed.language === "en" || parsed.language === "zh"
					? parsed.language
					: DEFAULT_SETTINGS.language,
			customTools,
			excludedTools: Array.isArray(parsed.excludedTools)
				? parsed.excludedTools.filter(
						(t): t is AgentToolName =>
							typeof t === "string" && ALL_TOOL_SET.has(t),
					)
				: DEFAULT_SETTINGS.excludedTools,
			appendSystemPrompt:
				typeof parsed.appendSystemPrompt === "string"
					? parsed.appendSystemPrompt
					: DEFAULT_SETTINGS.appendSystemPrompt,
			llamaServerUrl:
				typeof parsed.llamaServerUrl === "string" && parsed.llamaServerUrl.trim()
					? parsed.llamaServerUrl
					: DEFAULT_SETTINGS.llamaServerUrl,
			llamaApiKey:
				typeof parsed.llamaApiKey === "string"
					? parsed.llamaApiKey
					: DEFAULT_SETTINGS.llamaApiKey,
			continueQueuedAfterInterrupt:
				typeof parsed.continueQueuedAfterInterrupt === "boolean"
					? parsed.continueQueuedAfterInterrupt
					: DEFAULT_SETTINGS.continueQueuedAfterInterrupt,
			chatFontFamily,
			chatContentWidth,
			chatLineSpacing,
			sendDuringRunMode:
				parsed.sendDuringRunMode === "queue"
					? "queue"
					: DEFAULT_SETTINGS.sendDuringRunMode,
			steeringMode:
				parsed.steeringMode === "all" || parsed.steeringMode === "one-at-a-time"
					? parsed.steeringMode
					: DEFAULT_SETTINGS.steeringMode,
			followUpMode:
				parsed.followUpMode === "all" || parsed.followUpMode === "one-at-a-time"
					? parsed.followUpMode
					: DEFAULT_SETTINGS.followUpMode,
			autoCompaction:
				typeof parsed.autoCompaction === "boolean"
					? parsed.autoCompaction
					: DEFAULT_SETTINGS.autoCompaction,
			scopedModels: Array.isArray(parsed.scopedModels)
				? parsed.scopedModels.filter(
						(m): m is string => typeof m === "string" && m.trim().length > 0,
					)
				: DEFAULT_SETTINGS.scopedModels,
			showContextUsage:
				typeof parsed.showContextUsage === "boolean"
					? parsed.showContextUsage
					: DEFAULT_SETTINGS.showContextUsage,
			autoRetryOnFailure:
				typeof parsed.autoRetryOnFailure === "boolean"
					? parsed.autoRetryOnFailure
					: DEFAULT_SETTINGS.autoRetryOnFailure,
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(settings: AppSettings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		/* ignore */
	}
}

export function resolveTheme(
	theme: Theme,
	prefersDark: boolean,
): "light" | "dark" {
	if (theme === "system") return prefersDark ? "dark" : "light";
	return theme;
}
