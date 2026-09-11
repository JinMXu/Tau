import { useEffect, useMemo, useRef, useState } from "react";
import type { PiParsedMessage } from "../pi";
import type { MessageCatalog } from "../i18n";
import { Markdown } from "./Markdown";
import { splitOnQuery } from "./message-utils";
import { ChevronDownIcon, ChevronUpIcon, DownloadIcon, SearchIcon, XIcon } from "../icons";

export function parsedMessagesToMarkdown(messages: PiParsedMessage[]): string {
	const parts = messages
		.map((m) => {
			const role = m.role === "user" ? "User" : m.role === "tool" ? "Tool" : "Pi";
			const body = m.blocks
				.map((b) => {
					if (b.kind === "text") return b.text;
					if (b.kind === "thinking")
						return `<details><summary>thinking</summary>\n\n${b.text}\n</details>`;
					return `<details><summary>tool: ${b.name ?? "tool"}</summary>\n\n\`\`\`json\n${b.text}\n\`\`\`\n</details>`;
				})
				.filter(Boolean);
			if (!body.length) return "";
			return `**${role}**:\n${body.join("\n\n")}`;
		})
		.filter(Boolean);
	return parts.join("\n\n---\n\n");
}

/** Flat text of one parsed message (for search + plain rendering). */
function messageText(m: PiParsedMessage): string {
	return m.blocks
		.map((b) => (b.kind === "tool" ? `${b.name ?? "tool"}: ${b.text}` : b.text))
		.join("\n");
}

export function ArchivedPreview({
	title,
	messages,
	t,
	onClose,
	onExport,
}: {
	title: string;
	messages: PiParsedMessage[];
	t: MessageCatalog;
	onClose: () => void;
	onExport: (format: "markdown" | "jsonl" | "html") => void;
}) {
	const markdown = useMemo(() => parsedMessagesToMarkdown(messages), [messages]);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const msgElsRef = useRef(new Map<number, HTMLDivElement>());

	// Messages (by index) that contain the query.
	const hitIndexes = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [] as number[];
		return messages
			.map((m, i) => ({ m, i }))
			.filter(({ m }) => messageText(m).toLowerCase().includes(q))
			.map(({ i }) => i);
	}, [messages, query]);

	const activeMessageIndex =
		hitIndexes.length > 0 ? hitIndexes[Math.min(active, hitIndexes.length - 1)] : null;

	const step = (delta: number) => {
		if (hitIndexes.length === 0) return;
		setActive((cur) => (cur + delta + hitIndexes.length) % hitIndexes.length);
	};

	const closeSearch = () => {
		setSearchOpen(false);
		setQuery("");
		setActive(0);
	};

	// Ctrl+F opens search; capture-phase Escape closes it before other
	// global handlers (e.g. the session interrupt) see the key.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && searchOpen) {
				e.stopPropagation();
				closeSearch();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				setSearchOpen(true);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [searchOpen]);

	useEffect(() => {
		if (searchOpen) searchInputRef.current?.focus();
	}, [searchOpen]);

	// Scroll the active hit into view.
	useEffect(() => {
		if (activeMessageIndex == null) return;
		msgElsRef.current
			.get(activeMessageIndex)
			?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [activeMessageIndex]);

	const searching = searchOpen && query.trim().length > 0;

	return (
		<div className="overlay-backdrop" onClick={onClose}>
			<div
				className="archived-preview"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
			>
				<div className="archived-preview-header">
					<h3>{title}</h3>
					<div className="archived-preview-actions">
						{searchOpen && (
							<>
								<SearchIcon size={14} />
								<input
									ref={searchInputRef}
									className="archived-search-input"
									value={query}
									placeholder={t.chat.searchInSession}
									onChange={(e) => {
										setQuery(e.target.value);
										setActive(0);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											step(e.shiftKey ? -1 : 1);
										}
									}}
								/>
								<span className="session-search-count">
									{query
										? hitIndexes.length
											? `${Math.min(active + 1, hitIndexes.length)}/${hitIndexes.length}`
											: t.chat.noMatches
										: ""}
								</span>
								<button
									className="icon-btn"
									title={t.chat.searchPrev}
									disabled={hitIndexes.length === 0}
									onClick={() => step(-1)}
								>
									<ChevronUpIcon size={14} />
								</button>
								<button
									className="icon-btn"
									title={t.chat.searchNext}
									disabled={hitIndexes.length === 0}
									onClick={() => step(1)}
								>
									<ChevronDownIcon size={14} />
								</button>
								<button
									className="icon-btn"
									title={t.app.close}
									aria-label={t.app.close}
									onClick={closeSearch}
								>
									<XIcon size={14} />
								</button>
								<span className="menu-sep" />
							</>
						)}
						<button
							className="icon-btn"
							title={t.chat.searchInSession}
							onClick={() => setSearchOpen((v) => !v)}
						>
							<SearchIcon size={14} />
						</button>
						<button className="btn secondary" onClick={() => onExport("markdown")}>
							<DownloadIcon size={14} />
							{t.chat.exportMarkdown}
						</button>
						<button className="btn secondary" onClick={() => onExport("jsonl")}>
							<DownloadIcon size={14} />
							{t.chat.exportJsonl}
						</button>
						<button className="btn secondary" onClick={() => onExport("html")}>
							<DownloadIcon size={14} />
							{t.chat.exportHtml}
						</button>
						<button
							className="icon-btn"
							title={t.app.close}
							aria-label={t.app.close}
							onClick={onClose}
						>
							<XIcon size={16} />
						</button>
					</div>
				</div>
				<div className="archived-preview-body">
					{messages.length === 0 ? (
						<div className="settings-empty">{t.chat.empty}</div>
					) : searching ? (
						<div className="archived-preview-plain">
							{messages.map((m, i) => {
								const isActive = i === activeMessageIndex;
								return (
									<div
										key={i}
										ref={(el) => {
											if (el) msgElsRef.current.set(i, el);
											else msgElsRef.current.delete(i);
										}}
										className={`archived-plain-message${isActive ? " message-search-target" : ""}`}
									>
										{m.blocks.map((b, j) => (
											<div key={j} className="text-block highlighted-text">
												{splitOnQuery(
													b.kind === "tool" ? `${b.name ?? "tool"}: ${b.text}` : b.text,
													query,
												).map((p, k) =>
													p.match ? (
														<mark key={k} className="session-search-hit">
															{p.text}
														</mark>
													) : (
														<span key={k}>{p.text}</span>
													),
												)}
											</div>
										))}
									</div>
								);
							})}
						</div>
					) : (
						<Markdown text={markdown} />
					)}
				</div>
			</div>
		</div>
	);
}
