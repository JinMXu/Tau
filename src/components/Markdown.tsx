import MarkdownRender, { type SmoothMarkdownStreamOptions } from "markstream-react";
import "markstream-react/index.css";
import { memo, useRef, type MouseEvent } from "react";
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
/**
 * 代码块外观（percho 同款）：标题栏按钮只留复制 —— 字号三键/全屏/预览/折叠全部关掉
 * （showHeader:false 会把复制键一起干掉，所以逐个关）。monacoOptions 的首行灰底修复：
 * 库对 diff 块默认关掉了 renderLineHighlight，普通块裸奔 → 只读编辑器光标恒停第一行，
 * 当前行高亮让首行比其他行多一层灰底；右侧概览标尺同理（只读块无导航价值，光标行在
 * 右缘留一枚黑短杠）。App.css 的「纯净化」注释就是按这些 props 写的。
 */
const CODE_BLOCK_PROPS = {
	showFontSizeButtons: false,
	showExpandButton: false,
	showPreviewButton: false,
	showCollapseButton: false,
	monacoOptions: {
		renderLineHighlight: "none",
		overviewRulerLanes: 0,
		renderOverviewRuler: false,
		overviewRulerBorder: false,
		hideCursorInOverviewRuler: true,
	},
} as const;

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

export const Markdown = memo(function Markdown({
	text,
	streaming,
}: {
	text: string;
	streaming?: boolean;
}) {
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
			    bug leaves placeholder bars behind once streaming stops.
			    indexKey：必须给一个「跨渲染恒定」的值。库用它在两处做身份判定 ——
			      · indexPrefix → 顶层节点的 React key 前缀；
			      · 是否丢弃「已播过入场淡入的节点」集合：
			          const reset = props.indexKey !== undefined
			            ? props.indexKey !== prev.key
			            : nodes.length !== prev.total;
			          if (reset) { fadedNodes.clear(); ... }
			    不传 indexKey 时走 nodes.length 分支：流式回答的顶层节点数几乎每段都在变
			    （段落收尾、列表项出现、代码围栏闭合……），于是每变一次，之后的渲染就把
			    **整篇**已渲染节点重新打上 .fade-node（opacity:0 → 280ms 淡入）——
			    观感就是「输出完了之后整段回答从头到尾又渲染了一遍」。恒定 indexKey 让
			    reset 恒为 false，只有真正新出现的节点播一次淡入。 */}
			<MarkdownRender
				content={text}
				final={!streaming}
				fade={!REDUCED_MOTION}
				smoothStreaming={smoothableRef.current}
				smoothStreamingOptions={SMOOTH_OPTIONS}
				isDark={isDark}
				indexKey="tau-markdown"
				codeBlockLightTheme="vitesse-light"
				codeBlockDarkTheme="vitesse-dark"
				codeBlockProps={CODE_BLOCK_PROPS}
				deferNodesUntilVisible={false}
			/>
		</div>
	);
});
