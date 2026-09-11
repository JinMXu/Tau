/**
 * 统一错误信封 UiError（移植自 Percho `packages/shared/src/errors.ts`）。
 * reducer / 历史回放 / 内联错误条 / Toast 共享同一份结构。
 *
 * 设计约束：
 * - detail 只做纯文本展示（绝不 dangerouslySetInnerHTML），构造时截断到
 *   DETAIL_MAX_LENGTH；
 * - i18n 插值参数只放 provider/model/时间等安全值，禁止把 detail 塞进 titleParams。
 */

export type UiErrorSeverity = "error" | "warning" | "info";

/** 责任域（meta 行 + 后续面板的分类维度） */
export type UiErrorSource = "llm" | "session" | "tool" | "extension" | "app" | "network";

export type UiErrorAction = "retry" | "compact" | "openSettings" | "copyDetail";

export interface UiError {
	severity: UiErrorSeverity;
	source: UiErrorSource;
	/** i18n key（error.title.*）+ 插值参数（只放 provider/model 等安全值） */
	titleKey: string;
	titleParams?: Record<string, string | number>;
	/** 原始错误文本，折叠区展示；构造时截断到 DETAIL_MAX_LENGTH */
	detail?: string;
	/** 建议动作 i18n key（error.hint.*；无建议时缺省） */
	hintKey?: string;
	/** 操作行；有 detail 时恒含 copyDetail */
	actions: UiErrorAction[];
	timestamp: number;
}

/** detail 展示截断上限（防巨错误文本进渲染树） */
export const DETAIL_MAX_LENGTH = 4096;

/** 用户主动中断（abort）的错误消息判定：与 Percho 同源。 */
export function isUserAbortError(errorMessage: string): boolean {
	return /was aborted|request aborted/i.test(errorMessage);
}

export interface LlmErrorClass {
	titleKey: string;
	hintKey?: string;
	source: UiErrorSource;
	actions: UiErrorAction[];
}

/** 截断 detail：超长时在末尾保留截断标记（多字节安全：按 code point 切） */
function truncateDetail(detail: string): string {
	if (detail.length <= DETAIL_MAX_LENGTH) return detail;
	return `${[...detail].slice(0, DETAIL_MAX_LENGTH).join("")}\n…[已截断]`;
}

/**
 * LLM 错误归类（按序首个命中，大小写不敏感）。
 * 误判只影响标题/建议措辞，detail 原样可见。
 */
const LLM_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; cls: LlmErrorClass }> = [
	{
		pattern: /401|unauthorized|invalid\s+api\s+key|authentication/i,
		cls: {
			titleKey: "error.title.llmAuth",
			hintKey: "error.hint.checkApiKey",
			source: "llm",
			actions: ["retry", "openSettings", "copyDetail"],
		},
	},
	{
		pattern: /429|rate\s*limit|too\s+many\s*requests/i,
		cls: {
			titleKey: "error.title.llmRateLimit",
			hintKey: "error.hint.rateLimit",
			source: "llm",
			actions: ["retry", "copyDetail"],
		},
	},
	{
		pattern: /context_length|context\s+length|maximum\s+context|too\s+many\s+tokens/i,
		cls: {
			titleKey: "error.title.llmOverflow",
			hintKey: "error.hint.compact",
			source: "llm",
			actions: ["compact", "copyDetail"],
		},
	},
	{
		pattern: /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch\s+failed|\bnetwork\b|\btimeout\b/i,
		cls: {
			titleKey: "error.title.llmNetwork",
			hintKey: "error.hint.network",
			source: "network",
			actions: ["retry", "copyDetail"],
		},
	},
];

const LLM_ERROR_FALLBACK: LlmErrorClass = {
	titleKey: "error.title.llmGeneric",
	source: "llm",
	actions: ["retry", "copyDetail"],
};

export function classifyLlmError(errorMessage: string): LlmErrorClass {
	for (const { pattern, cls } of LLM_ERROR_PATTERNS) {
		if (pattern.test(errorMessage)) return cls;
	}
	return LLM_ERROR_FALLBACK;
}

/** 由 LLM 错误消息构造完整 UiError 信封（live 与历史回放共用）。 */
export function buildLlmUiError(errorMessage: string, now: number = Date.now()): UiError {
	const cls = classifyLlmError(errorMessage);
	return {
		severity: "error",
		source: cls.source,
		titleKey: cls.titleKey,
		detail: truncateDetail(errorMessage),
		...(cls.hintKey ? { hintKey: cls.hintKey } : {}),
		actions: cls.actions.includes("copyDetail") ? cls.actions : [...cls.actions, "copyDetail"],
		timestamp: now,
	};
}
