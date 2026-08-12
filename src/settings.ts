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
	continueQueuedAfterInterrupt: true,
	chatFontFamily: "system",
	chatContentWidth: "standard",
	chatLineSpacing: "standard",
	sendDuringRunMode: "steer",
	showContextUsage: true,
	autoRetryOnFailure: true,
};

export const SETTINGS_KEY = "pi-gui.settings.v4";

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
