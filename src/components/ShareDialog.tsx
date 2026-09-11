import { useState } from "react";
import type { MessageCatalog } from "../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckIcon, CopyIcon } from "../icons";
import { Modal } from "./Modal";

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
		<Modal open onClose={onClose} title={t.share.title} closeLabel={t.app.close}>
			<p className="extension-message">{t.share.hint}</p>
			<div className="share-url mono" title={url}>
				{url}
			</div>
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={() => void copy()}>
					{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
					<span>{copied ? t.chat.copied : t.share.copy}</span>
				</button>
				<button className="btn primary" onClick={() => void openUrl(url).catch(() => {})}>
					{t.share.open}
				</button>
			</div>
		</Modal>
	);
}
