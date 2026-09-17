import type { UiError } from "./errors";

export type TextBlock = { kind: "text"; text: string };
export type ThinkingBlock = { kind: "thinking"; text: string };
export type ToolBlock = {
	kind: "tool";
	name: string;
	args: string;
	/** Tool *result* (output), as opposed to a tool call (arguments). */
	result?: boolean;
	/** Tool result marked as an error by pi. */
	error?: boolean;
};
export type Block = TextBlock | ThinkingBlock | ToolBlock;

export interface ChatMessage {
	id: number;
	role: "user" | "assistant" | "tool";
	blocks: Block[];
	streaming: boolean;
	error?: UiError | string;
	replay?: boolean;
	timestamp?: string;
	/** Pi session entry id — used for message-level forking. */
	entryId?: string | null;
	/** Attached images (user messages): base64 payload, no data-url prefix. */
	images?: { mimeType: string; data: string }[];
}

export interface Attachment {
	id: string;
	name: string;
	kind: "file" | "image";
	dataUrl?: string;
	path?: string;
	text?: string;
	size: number;
}

export type SendBehavior = "normal" | "steer" | "followUp";

/** pi auto-retry 退避窗口（auto_retry_start → auto_retry_end）的前端快照。
 *  LLM 可重试失败（超时/过载/无响应）后，pi 以 agent_end(willRetry) 结束当前
 *  run、按指数退避等待，再 agent_start 重开 run——期间不 emit agent_settled。
 *  working 全程保持 true，本状态只驱动「重试中」的实时指示。 */
export interface AutoRetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	/** auto_retry_start 到达的本地时刻（倒计时锚点）。 */
	startedAt: number;
}

/** A message waiting in the local follow-up/steering queue above the composer. */
export interface QueuedChatMessage {
	id: string;
	text: string;
	attachments: Attachment[];
	mode: "steer" | "followUp";
}

export interface SessionStats {
	tokens?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost?: number;
	contextUsage?: {
		tokens: number;
		contextWindow: number;
		percent: number;
	};
	perf?: {
		cacheHitRate?: number;
		avgTTFT?: number;
		tokensPerSec?: number;
	};
}
