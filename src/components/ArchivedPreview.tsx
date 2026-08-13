import { useEffect, useMemo } from "react";
import type { PiParsedMessage } from "../pi";
import type { MessageCatalog } from "../i18n";
import { Markdown } from "./Markdown";
import { DownloadIcon, XIcon } from "../icons";

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

	// Escape closes the preview. The App-level Escape handler exempts the
	// archived preview so a stray Esc never interrupts a running session.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
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
						<button
							className="btn secondary"
							onClick={() => onExport("markdown")}
						>
							<DownloadIcon size={14} />
							{t.chat.exportMarkdown}
						</button>
						<button
							className="btn secondary"
							onClick={() => onExport("jsonl")}
						>
							<DownloadIcon size={14} />
							{t.chat.exportJsonl}
						</button>
						<button
							className="btn secondary"
							onClick={() => onExport("html")}
						>
							<DownloadIcon size={14} />
							{t.chat.exportHtml}
						</button>
						<button
							className="icon-btn"
							title={t.app.close}
							onClick={onClose}
						>
							<XIcon size={16} />
						</button>
					</div>
				</div>
				<div className="archived-preview-body">
					{messages.length === 0 ? (
						<div className="settings-empty">{t.chat.empty}</div>
					) : (
						<Markdown text={markdown} />
					)}
				</div>
			</div>
		</div>
	);
}
