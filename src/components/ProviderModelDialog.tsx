import { useState } from "react";
import type { MessageCatalog } from "../i18n";
import {
	piProviderModelOverrideUpsert,
	piProviderModelUpsert,
	type PiProviderModel,
	type PiProviderModelPatch,
	type PiProviderModelUpsert,
} from "../pi";
import { LoaderIcon } from "../icons";
import { Modal } from "./Modal";

/**
 * Add/edit one model of a provider. Custom models are upserted into
 * models.json `models`; editing a built-in model writes a `modelOverrides`
 * metadata patch instead (the catalog entry itself stays untouched).
 */
export function ProviderModelDialog({
	t,
	provider,
	providerLabel,
	mode,
	initial,
	onSaved,
	onClose,
}: {
	t: MessageCatalog;
	provider: string;
	/** Display name used in the dialog title. */
	providerLabel: string;
	mode: "add-custom" | "edit-custom" | "edit-override";
	/** Current effective values; undefined in add mode. */
	initial?: PiProviderModel;
	onSaved: (msg: string) => void;
	/** Reserved for parity with the other dialogs; save errors surface in
	 * the in-dialog banner instead of a toast so the form stays readable. */
	onError?: (msg: string) => void;
	onClose: () => void;
}) {
	const idLocked = mode !== "add-custom";
	const [id, setId] = useState(initial?.id ?? "");
	const [name, setName] = useState(initial?.name ?? "");
	const [reasoning, setReasoning] = useState(initial?.reasoning ?? false);
	const [image, setImage] = useState(initial?.image ?? false);
	const [contextWindow, setContextWindow] = useState(
		initial?.contextWindow ? String(initial.contextWindow) : "",
	);
	const [maxTokens, setMaxTokens] = useState(initial?.maxTokens ? String(initial.maxTokens) : "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		const trimmedId = id.trim();
		if (!trimmedId) {
			setError(t.settings.cpErrModelIdRequired);
			return;
		}
		const cw = contextWindow.trim();
		const mt = maxTokens.trim();
		const cwNum = cw ? Number(cw) : undefined;
		const mtNum = mt ? Number(mt) : undefined;
		if (
			(cwNum !== undefined && (!Number.isInteger(cwNum) || cwNum <= 0)) ||
			(mtNum !== undefined && (!Number.isInteger(mtNum) || mtNum <= 0))
		) {
			setError(t.settings.cpErrPositiveInt);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (mode === "edit-override") {
				// Partial-patch semantics: name/context limits only when set, the
				// booleans always (they always have a value to express).
				const patch: PiProviderModelPatch = {
					reasoning,
					input: image ? ["text", "image"] : ["text"],
				};
				const trimmedName = name.trim();
				if (trimmedName) patch.name = trimmedName;
				if (cwNum !== undefined) patch.contextWindow = cwNum;
				if (mtNum !== undefined) patch.maxTokens = mtNum;
				await piProviderModelOverrideUpsert(provider, trimmedId, patch);
			} else {
				// Upsert replaces the whole models.json entry, so omitted fields
				// are cleared — only write fields that carry a value.
				const model: PiProviderModelUpsert = {
					id: trimmedId,
					input: image ? ["text", "image"] : ["text"],
				};
				const trimmedName = name.trim();
				if (trimmedName) model.name = trimmedName;
				if (reasoning) model.reasoning = true;
				if (cwNum !== undefined) model.contextWindow = cwNum;
				if (mtNum !== undefined) model.maxTokens = mtNum;
				await piProviderModelUpsert(provider, model);
			}
			onSaved(t.settings.modelSaved);
			onClose();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open
			onClose={onClose}
			title={(mode === "add-custom" ? t.settings.pmTitleAdd : t.settings.pmTitleEdit).replace(
				"{provider}",
				providerLabel,
			)}
			closeLabel={t.app.close}
			className="provider-model-dialog"
		>
			{mode === "edit-override" && <p className="cp-note">{t.settings.pmOverrideNote}</p>}

			<div className="cp-grid">
				<div className="cp-field">
					<label className="cp-label">{t.settings.cpModelId}</label>
					<input
						className="mono"
						value={id}
						disabled={idLocked}
						spellCheck={false}
						onChange={(e) => setId(e.target.value)}
					/>
				</div>
				<div className="cp-field">
					<label className="cp-label">{t.settings.cpModelName}</label>
					<input value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
				</div>
			</div>

			<div className="cp-model-line cp-model-meta pm-form-meta">
				<label className="cp-check" title={t.settings.cpReasoning}>
					<input
						type="checkbox"
						checked={reasoning}
						onChange={(e) => setReasoning(e.target.checked)}
					/>
					{t.settings.cpReasoning}
				</label>
				<label className="cp-check" title={t.settings.cpImage}>
					<input type="checkbox" checked={image} onChange={(e) => setImage(e.target.checked)} />
					{t.settings.cpImage}
				</label>
				<label className="cp-num">
					<span>{t.settings.cpContextWindow}</span>
					<input
						type="number"
						min={1}
						value={contextWindow}
						onChange={(e) => setContextWindow(e.target.value)}
					/>
				</label>
				<label className="cp-num">
					<span>{t.settings.cpMaxTokens}</span>
					<input
						type="number"
						min={1}
						value={maxTokens}
						onChange={(e) => setMaxTokens(e.target.value)}
					/>
				</label>
			</div>

			{error && <div className="error-banner">{error}</div>}

			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onClose} disabled={busy}>
					{t.app.cancel}
				</button>
				<button className="btn primary" disabled={busy} onClick={() => void save()}>
					{busy && <LoaderIcon size={12} className="spin" />}
					{t.settings.saveKey}
				</button>
			</div>
		</Modal>
	);
}
