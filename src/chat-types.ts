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
	error?: string;
	replay?: boolean;
	timestamp?: string;
	/** Pi session entry id — used for message-level forking. */
	entryId?: string | null;
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
