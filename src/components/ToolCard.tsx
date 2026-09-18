import { memo, useState } from "react";
import type { Block } from "../chat-types";
import type { MessageCatalog } from "../i18n";
import { ChevronRightIcon } from "../icons";
import { ToolResult, ToolResultOutput } from "./agents/tool-result";

/**
 * Tool call / thinking rendering, shared by the message rows and the folded
 * meta groups. The card is beui's ToolResult: a status pill (running spinner
 * / success check / error cross) with an ActionSwapRoll on the title, a
 * collapsible body whose output renders through AgentCode (shiki), and a
 * built-in copy action. Streaming runs auto-open the body and pin the scroll
 * to the newest output; completing auto-collapses back to the one-liner.
 *
 * summarizeArgs stays the Percho port: command → filePath/path/file → url,
 * with regex fallback while args stream in as partial JSON.
 */

export type ToolBlockT = Extract<Block, { kind: "tool" }>;

/** Percho summarizeArgs verbatim: command → filePath/path/file → url; while
 * args stream in as partial JSON, fall back to priority regex extraction. */
export function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
		const url = parsed.url;
		return typeof url === "string" ? url : "";
	} catch {
		// 流式中的不完整 JSON：按优先级正则抽取字段值（值允许未闭合，随流式增长原地更新）
		for (const key of ["command", "cmd", "filePath", "path", "file", "url"]) {
			const value = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
			if (value) return value;
		}
	}
	const trimmed = args.slice(0, 120);
	return trimmed.length < args.length ? `${trimmed}…` : trimmed;
}

export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export const ToolCard = memo(function ToolCard({
	block,
	result,
	running,
}: {
	block: ToolBlockT;
	/** The call's output — attached from the following tool-result message,
	 * or the block itself when this card renders an orphan result. */
	result?: ToolBlockT | null;
	running: boolean;
	/** Kept for call-site compatibility; the beui card needs no labels. */
	t?: MessageCatalog;
}) {
	const summary = summarizeArgs(block.args);
	const error = block.error || result?.error;
	// orphan result（无配对调用的纯结果消息）：args 本身就是输出文本
	const callArgs = block.result ? "" : block.args;
	const output = (block.result ? block.args : (result?.args ?? "")).replace(/\n+$/, "");

	return (
		<ToolResult
			tool={displayName(block.name)}
			title={summary}
			status={running ? "running" : error ? "error" : "success"}
			kind={/bash|command|exec|shell/i.test(block.name) ? "terminal" : "custom"}
			defaultOpen={false}
			maxHeight={260}
			copyText={output || undefined}
		>
			{callArgs ? (
				<div className="mb-2">
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
						args
					</div>
					<ToolResultOutput language="json">{callArgs}</ToolResultOutput>
				</div>
			) : null}
			{output ? (
				<div>
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
						output
					</div>
					<ToolResultOutput language="bash">{output}</ToolResultOutput>
				</div>
			) : null}
		</ToolResult>
	);
});

export const ThinkingBlock = memo(function ThinkingBlock({
	text,
	t,
}: {
	text: string;
	t: MessageCatalog;
}) {
	// Percho ThinkingRow verbatim: a bare "思考过程" label row (no icon, the
	// arrow only appears on hover, rotates 90° when open) with the raw
	// thinking text indented beneath. No streaming variants — inside a live
	// group the label stays put while the body grows.
	const [open, setOpen] = useState(false);
	return (
		<details
			className="think-row"
			open={open}
			onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
		>
			<summary className="think-row-head">
				<span className="think-row-label">{t.chat.thinking}</span>
				<ChevronRightIcon size={12} className="think-row-arrow" />
			</summary>
			<div className="think-row-text">{text}</div>
		</details>
	);
});
