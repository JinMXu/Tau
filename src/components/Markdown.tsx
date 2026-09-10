import MarkdownRender, { type SmoothMarkdownStreamOptions } from "markstream-react";
import "markstream-react/index.css";
import { useRef, type MouseEvent } from "react";
import { useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Markdown 渲染：markstream-react（percho 同款）——增量解析 + 自适应速率的
 * 字符级平滑 streaming（大 chunk 连续滑出而非整块蹦现）+ 新内容淡入。
 * 替换掉之前的 Streamdown 方案（每 80ms 全量 re-parse，文字一格一格跳）。
 *
 * 流式丝滑性（两层，与 percho 相同）：
 * 1. smoothStreaming：内容经自适应速率控制器逐字放出。只对「挂载时就在流式」
 *    的消息启用——历史/固化后打开的消息直出（mount 初值锁定，否则整篇重播）。
 * 2. fade：新块节点 enter 淡入 + 文本节点新增内容交替淡入。
 */

/** 平滑输出速率参数（percho 同值）：小 delta 基速 80cps，backlog <600 字
 * 900ms 内追平；超过则 350ms 快进（≤1000cps）——不积压也不跳变。 */
const SMOOTH_OPTIONS: SmoothMarkdownStreamOptions = {
	minCharsPerSecond: 80,
};

/** 减速动效偏好：直接关闭 pacing（直出）；库 CSS 自带 animation:none 处理淡入 */
const REDUCED_MOTION =
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/// Messages longer than this render as plain text instead of the full
/// incremental renderer (see the degraded branch in the component).
const MAX_MARKDOWN_CHARS = 300_000;

// A single shared theme store: every <Markdown> block subscribes to one
// MutationObserver on <html> instead of each creating its own (a session with
// dozens of messages used to create dozens of observers, and a theme switch
// fired all of them at once).
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function getThemeSnapshot(): "light" | "dark" {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribeTheme(onStoreChange: () => void): () => void {
	themeListeners.add(onStoreChange);
	if (!themeObserver) {
		themeObserver = new MutationObserver(() => {
			for (const listener of themeListeners) listener();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
	}
	return () => {
		themeListeners.delete(onStoreChange);
		if (themeListeners.size === 0 && themeObserver) {
			themeObserver.disconnect();
			themeObserver = null;
		}
	};
}

/**
 * Open external links in the system browser instead of navigating the
 * webview. In-page anchors (#…) fall through to the default scroll
 * behaviour; other non-external links (file:, relative) are swallowed so
 * the webview never navigates away from the app. (markstream renders plain
 * anchors — capture the click at the host div.)
 */
function onMarkdownClick(event: MouseEvent<HTMLDivElement>) {
	const anchor = (event.target as Element | null)?.closest?.("a[href]");
	if (!anchor) return;
	const href = anchor.getAttribute("href") ?? "";
	if (/^(https?|mailto|tel):/i.test(href)) {
		event.preventDefault();
		void openUrl(href).catch(() => {
			/* opening externally is best-effort */
		});
	} else if (!href.startsWith("#")) {
		event.preventDefault();
	}
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	const isDark = useSyncExternalStore(subscribeTheme, getThemeSnapshot) === "dark";
	// Mount-time lock (percho): enable smoothing only for messages that were
	// already streaming when mounted — history messages render instantly and
	// never replay the typing animation.
	const smoothableRef = useRef<boolean>(Boolean(streaming) && !REDUCED_MOTION);
	// Degraded rendering for very large messages.
	if (text.length > MAX_MARKDOWN_CHARS) {
		return (
			<div className="markdown-host">
				<pre className="markdown-plain">{text}</pre>
			</div>
		);
	}
	return (
		<div className="markdown-host markdown-body" onClick={onMarkdownClick}>
			{/* deferNodesUntilVisible=false: markstream 0.0.55's deferred-node
			    bug leaves placeholder bars behind once streaming stops. */}
			<MarkdownRender
				content={text}
				final={!streaming}
				fade={!REDUCED_MOTION}
				smoothStreaming={smoothableRef.current}
				smoothStreamingOptions={SMOOTH_OPTIONS}
				isDark={isDark}
				codeBlockLightTheme="vitesse-light"
				codeBlockDarkTheme="vitesse-dark"
				deferNodesUntilVisible={false}
			/>
		</div>
	);
}
