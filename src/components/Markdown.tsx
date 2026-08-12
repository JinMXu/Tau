import { memo, useMemo, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import { Streamdown } from "streamdown";
import type { ThemeInput } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { openUrl } from "@tauri-apps/plugin-opener";

const LIGHT_THEME: ThemeInput = "github-light";
const DARK_THEME: ThemeInput = "github-dark";

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

/** Open external links in the system browser instead of navigating the webview. */
function onMarkdownClick(event: MouseEvent<HTMLDivElement>) {
	const anchor = (event.target as Element | null)?.closest?.("a[href]");
	if (!anchor) return;
	event.preventDefault();
	const href = anchor.getAttribute("href") ?? "";
	if (/^(https?|mailto|tel):/i.test(href)) {
		void openUrl(href).catch(() => {
			/* opening externally is best-effort */
		});
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
	const codePlugin = useMemo(() => {
		// Pass the active theme as both entries so token colors work without
		// Tailwind's `dark:` variant (see the CSS shims in App.css).
		const themes: [ThemeInput, ThemeInput] =
			theme === "dark" ? [DARK_THEME, DARK_THEME] : [LIGHT_THEME, LIGHT_THEME];
		return createCodePlugin({ themes });
	}, [theme]);

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
				{text}
			</Streamdown>
		</div>
	);
});
