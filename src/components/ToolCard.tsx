import { memo, useEffect, useRef, useState } from "react";
import type { Block } from "../chat-types";
import type { MessageCatalog } from "../i18n";
import { ChevronRightIcon } from "../icons";

/**
 * Tool call / thinking rendering, shared by the message rows and the folded
 * meta groups. ToolCard is a faithful port of Percho's ToolCallCard:
 * borderless one-liner = tool name + single-line summary (gradient fade on
 * overflow) + hover-reveal arrow; expanded = raw args + output <pre>.
 * No icons, no "结果/输出 N 行" suffixes, no diff view — the transcript
 * reads as a flat command list, exactly like Percho.
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
		if (typeof url === "string") return url;
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
	/** Kept for call-site compatibility; the Percho card needs no labels. */
	t?: MessageCatalog;
}) {
	const summary = summarizeArgs(block.args);
	/** 内容是否超过一行（决定渐变 + 箭头是否贴行尾） */
	const [overflowing, setOverflowing] = useState(false);
	const [open, setOpen] = useState(false);
	const textRef = useRef<HTMLSpanElement>(null);
	const rowRef = useRef<HTMLButtonElement>(null);

	// 挂载时 args 可能为空（流式 toolcall，textRef 未渲染）→ 随 summary 变化重测；
	// overflow:hidden 下 scrollWidth 恒为内容全宽，收缩后重测结果依然正确
	// biome-ignore lint/correctness/useExhaustiveDependencies: summary 是刻意的重跑触发器（effect 内只读 ref，args 流式增长时需重测）
	useEffect(() => {
		const check = () => {
			const el = textRef.current;
			const row = rowRef.current;
			if (!el || !row) return;
			const left = el.getBoundingClientRect().left - row.getBoundingClientRect().left;
			setOverflowing(el.scrollWidth > row.clientWidth - left);
		};
		check();
		const row = rowRef.current;
		if (!row) return;
		const ro = new ResizeObserver(check);
		ro.observe(row);
		return () => ro.disconnect();
	}, [summary]);

	const error = block.error || result?.error;
	// orphan result（无配对调用的纯结果消息）：args 本身就是输出文本
	const callArgs = block.result ? "" : block.args;
	const output = (block.result ? block.args : (result?.args ?? "")).replace(/\n+$/, "");

	return (
		<div
			className={`tool-card${running ? " running" : ""}${error ? " error" : ""}${open ? " open" : ""}`}
			data-state={running ? "running" : error ? "error" : "ok"}
		>
			<button
				type="button"
				ref={rowRef}
				className="tool-head"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className={`tool-name${running ? " shimmer-sweep" : ""}`}>
					{displayName(block.name)}
				</span>
				{summary && (
					<span ref={textRef} className={overflowing ? "tool-summary of" : "tool-summary"}>
						{summary}
						{overflowing && <span className="tool-summary-fade" />}
					</span>
				)}
				{running && summary && <span className="tool-ellipsis">…</span>}
				<ChevronRightIcon size={12} className="tool-chevron" />
			</button>
			{open && (
				<div className="tool-body">
					{callArgs && <pre className="tool-pre args">{callArgs}</pre>}
					{output && <pre className={`tool-pre output${error ? " err" : ""}`}>{output}</pre>}
				</div>
			)}
		</div>
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
