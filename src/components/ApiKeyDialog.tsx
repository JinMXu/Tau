import { useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { Modal } from "./Modal";

/**
 * Inline API-key prompt shown when a send targets a provider with no key
 * configured — saving here avoids a detour through the settings page.
 * Extracted from App.tsx so the root component is not also a dialog library.
 */
export function ApiKeyDialog({
	provider,
	t,
	onSave,
	onCancel,
}: {
	provider: string;
	t: MessageCatalog;
	onSave: (provider: string, key: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const save = async () => {
		if (!key.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onSave(provider, key.trim());
		} catch (e) {
			setError(String(e));
			setBusy(false);
		}
	};

	return (
		<Modal
			open
			onClose={onCancel}
			title={t.keyDialog.title}
			closeLabel={t.app.close}
			showClose={false}
			initialFocusRef={inputRef}
		>
			<p className="extension-message">{t.keyDialog.body.replace("{provider}", provider)}</p>
			<input
				ref={inputRef}
				type="password"
				value={key}
				placeholder={t.keyDialog.placeholder}
				onChange={(e) => setKey(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") void save();
				}}
			/>
			{error && <p className="extension-error">{error}</p>}
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onCancel}>
					{t.keyDialog.cancelSend}
				</button>
				<button className="btn primary" disabled={!key.trim() || busy} onClick={() => void save()}>
					{t.keyDialog.save}
				</button>
			</div>
		</Modal>
	);
}
