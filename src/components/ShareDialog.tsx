import { useState } from "react";
import type { MessageCatalog } from "../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckIcon, CopyIcon, XIcon } from "../icons";

/** `/share` result: private gist URL with copy/open actions. */
export function ShareDialog({
	url,
	t,
	onClose,
}: {
	url: string | null;
	t: MessageCatalog;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState(false);
	if (!url) return null;

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* ignore */
		}
	};

	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog">
				<div className="tree-dialog-header">
					<h3>{t.share.title}</h3>
					<button className="icon-btn" title={t.app.close} onClick={onClose}>
						<XIcon size={15} />
					</button>
				</div>
				<p className="extension-message">{t.share.hint}</p>
				<div className="share-url mono" title={url}>
					{url}
				</div>
				<div className="extension-dialog-actions">
					<button className="btn secondary" onClick={() => void copy()}>
						{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
						<span>{copied ? t.chat.copied : t.share.copy}</span>
					</button>
					<button
						className="btn primary"
						onClick={() => void openUrl(url).catch(() => {})}
					>
						{t.share.open}
					</button>
				</div>
			</div>
		</div>
	);
}
