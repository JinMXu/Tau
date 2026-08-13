import { memo, useDeferredValue, useMemo, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import { Streamdown } from "streamdown";
import type { ThemeInput } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";

const LIGHT_THEME: ThemeInput = "github-light";
const DARK_THEME: ThemeInput = "github-dark";

/// Messages longer than this render as plain text instead of going through
/// Streamdown's full re-parse + syntax highlighting (see the degraded branch
/// in the component).
const MAX_MARKDOWN_CHARS = 300_000;

const LINK_SAFETY = { enabled: false } as const;
const CONTROLS = {
	code: { copy: true, download: false },
	table: false,
	mermaid: false,
} as const;

function subscribeTheme(onStoreChange: () => void): () => void {
	const element = document.documentElement;
	const observer = new MutationObserver(onStoreChange);
	observer.observe(element, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	return () => observer.disconnect();
}

function getThemeSnapshot(): "light" | "dark" {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Open external links in the system browser instead of navigating the
 * webview. In-page anchors (#…) fall through to the default scroll
 * behaviour; other non-external links (file:, relative) are swallowed so
 * the webview never navigates away from the app.
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
	streaming = false,
}: {
	text: string;
	streaming?: boolean;
}) {
	const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot);
	// Defer the text so Streamdown's expensive re-parse + syntax-highlight
	// doesn't run on every single animation frame during streaming.  React
	// will render the previous (cheaper) content first and schedule the
	// updated parse as a transition, dropping intermediate renders when
	// deltas arrive faster than the parse can keep up.
	const deferredText = useDeferredValue(text);
	const codePlugin = useMemo(() => {
		// Pass the active theme as both entries so token colors work without
		// Tailwind's `dark:` variant (see the CSS shims in App.css).
		const themes: [ThemeInput, ThemeInput] =
			theme === "dark" ? [DARK_THEME, DARK_THEME] : [LIGHT_THEME, LIGHT_THEME];
		return createCodePlugin({ themes });
	}, [theme]);

	// Degraded rendering for very large messages: Streamdown re-parses the
	// whole document (and highlights code) on every update and again when
	// switching out of streaming mode at message_end. For huge replies that
	// parse spike is exactly what tips the webview over the edge — render
	// them as plain pre-formatted text instead (still selectable/scrolled).
	if (deferredText.length > MAX_MARKDOWN_CHARS) {
		return (
			<div className="markdown-host">
				<pre className="markdown-plain">{deferredText}</pre>
			</div>
		);
	}

	return (
		<div className="markdown-host" onClick={onMarkdownClick}>
			<Streamdown
				mode={streaming ? "streaming" : "static"}
				animated
				isAnimating={streaming}
				plugins={{ code: codePlugin }}
				controls={CONTROLS}
				linkSafety={LINK_SAFETY}
				lineNumbers={false}
				className="ousia-chat-markdown"
			>
				{deferredText}
			</Streamdown>
		</div>
	);
});
