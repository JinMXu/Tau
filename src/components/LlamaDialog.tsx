import { useCallback, useEffect, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { llamaLoad, llamaModels, llamaUnload } from "../pi";
import { LoaderIcon, RefreshIcon, TerminalIcon, TrashIcon } from "../icons";
import { Modal } from "./Modal";

/** `/llama` equivalent: manage models on a llama.cpp router server. */
export function LlamaDialog({
	open,
	url,
	apiKey,
	t,
	onClose,
}: {
	open: boolean;
	url: string;
	apiKey: string;
	t: MessageCatalog;
	onClose: () => void;
}) {
	const [models, setModels] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyName, setBusyName] = useState<string | null>(null);
	const [loadName, setLoadName] = useState("");
	const [connected, setConnected] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const ids = await llamaModels(url, apiKey);
			setModels(ids);
			setConnected(true);
		} catch (e) {
			setModels([]);
			setConnected(false);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [url, apiKey]);

	useEffect(() => {
		if (open) {
			setLoadName("");
			void refresh();
		}
	}, [open, refresh]);

	if (!open) return null;

	const load = async () => {
		const name = loadName.trim();
		if (!name || busyName) return;
		setBusyName(name);
		setError(null);
		try {
			await llamaLoad(url, apiKey, name);
			setLoadName("");
			await refresh();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusyName(null);
		}
	};

	const unload = async (name: string) => {
		if (busyName) return;
		setBusyName(name);
		setError(null);
		try {
			await llamaUnload(url, apiKey, name);
			await refresh();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusyName(null);
		}
	};

	return (
		<Modal
			open
			onClose={onClose}
			title={t.llama.title}
			closeLabel={t.app.close}
			className="llama-dialog"
			headerActions={
				<div className="tree-dialog-header-actions">
					<span className={`llama-status ${connected ? "on" : ""}`}>
						<span className="dot-status" />
						{connected ? t.llama.connected : t.llama.disconnected}
					</span>
					<button
						className="icon-btn"
						title={t.llama.refresh}
						aria-label={t.llama.refresh}
						onClick={() => void refresh()}
					>
						<RefreshIcon size={14} />
					</button>
				</div>
			}
		>
			<p className="extension-message mono">{url}</p>
			{error && <div className="error-banner">{error}</div>}
			<div className="llama-models">
				<div className="llama-models-label">{t.llama.loaded}</div>
				{loading ? (
					<div className="llama-empty">
						<LoaderIcon size={14} className="spin" />
						<span>{t.settings.loading}</span>
					</div>
				) : models.length === 0 ? (
					<div className="llama-empty">{t.llama.noModels}</div>
				) : (
					models.map((m) => (
						<div className="llama-model-row" key={m}>
							<TerminalIcon size={13} />
							<span className="mono llama-model-name" title={m}>
								{m}
							</span>
							<button
								className="icon-btn"
								title={t.llama.unload}
								disabled={busyName !== null}
								onClick={() => void unload(m)}
							>
								{busyName === m ? (
									<LoaderIcon size={12} className="spin" />
								) : (
									<TrashIcon size={12} />
								)}
							</button>
						</div>
					))
				)}
			</div>
			<div className="llama-load-row">
				<input
					value={loadName}
					placeholder={t.llama.loadPlaceholder}
					disabled={busyName !== null}
					onChange={(e) => setLoadName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void load();
					}}
				/>
				<button
					className="btn primary"
					disabled={!loadName.trim() || busyName !== null}
					onClick={() => void load()}
				>
					{busyName ? <LoaderIcon size={13} className="spin" /> : null}
					<span>{t.llama.load}</span>
				</button>
			</div>
			<p className="settings-hint">{t.llama.hint}</p>
		</Modal>
	);
}
