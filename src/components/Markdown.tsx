import { memo, startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

/**
 * Deterministic streaming cadence: render the latest text at most every
 * 80ms while a block streams. This replaces `useDeferredValue`, whose
 * transition scheduling renders in unpredictable bursts — text would freeze
 * and then jump forward, with a final "snap" when the stream settled. The
 * throttle keeps updates small, regular and near-real-time; updates are
 * wrapped in `startTransition` so composer typing can still preempt a heavy
 * parse.
 */
const STREAM_UPDATE_INTERVAL_MS = 80;

const LINK_SAFETY = { enabled: false } as const;
const CONTROLS = {
	code: { copy: true, download: false },
	table: false,
	mermaid: false,
} as const;

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
	// Throttled streaming text (see STREAM_UPDATE_INTERVAL_MS). Settled
	// messages render `text` directly — no stale state, no final burst.
	const [displayText, setDisplayText] = useState(text);
	const latestRef = useRef(text);
	latestRef.current = text;
	useEffect(() => {
		if (!streaming) return;
		let rafId = 0;
		let last = 0;
		const tick = (now: number) => {
			rafId = requestAnimationFrame(tick);
			if (now - last < STREAM_UPDATE_INTERVAL_MS) return;
			last = now;
			const latest = latestRef.current;
			startTransition(() => setDisplayText(latest));
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [streaming]);
	const shown = streaming ? displayText : text;
	const codePlugin = useMemo(() => {
		// Pass the active theme as both entries so token colors work without
		// Tailwind's `dark:` variant (see the CSS shims in App.css).
		const themes: [ThemeInput, ThemeInput] =
			theme === "dark" ? [DARK_THEME, DARK_THEME] : [LIGHT_THEME, LIGHT_THEME];
		return createCodePlugin({ themes });
	}, [theme]);

	// Degraded rendering for very large messages: Streamdown re-parses the
	// whole document (and highlights code) on every update. For huge replies
	// that parse spike is exactly what tips the webview over the edge —
	// render them as plain pre-formatted text instead (still selectable).
	if (shown.length > MAX_MARKDOWN_CHARS) {
		return (
			<div className="markdown-host">
				<pre className="markdown-plain">{shown}</pre>
			</div>
		);
	}

	return (
		<div className="markdown-host" onClick={onMarkdownClick}>
			{/* `mode="streaming"` is kept across the whole lifetime so the
			 * message_end transition never re-parses the document in "static"
			 * mode — that re-render is what made a finished answer visibly
			 * refresh. Streaming-mode parsing is identical for complete
			 * markdown; `isAnimating` only controls the word-by-word typing
			 * animation, which simply stops at the end. */}
			<Streamdown
				mode="streaming"
				animated
				isAnimating={streaming}
				plugins={{ code: codePlugin }}
				controls={CONTROLS}
				linkSafety={LINK_SAFETY}
				lineNumbers={false}
				className="ousia-chat-markdown"
			>
				{shown}
			</Streamdown>
		</div>
	);
});
