import { useEffect, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { authSetKey, piUpsertCustomProvider, type CustomProviderEntry } from "../pi";
import {
	PROVIDER_APIS,
	PROVIDER_TEMPLATES,
	blankModel,
	buildProviderConfig,
	formFromConfig,
	formFromTemplate,
	validateProviderForm,
	type CustomProviderForm,
	type FormError,
	type ProviderTemplate,
} from "../custom-provider";
import { LoaderIcon, PlusIcon, TrashIcon } from "../icons";
import { Modal } from "./Modal";

function templateLabel(t: MessageCatalog, key: ProviderTemplate["key"]): string {
	switch (key) {
		case "volcengine":
			return t.settings.cpTemplateVolcengine;
		case "ollama":
			return t.settings.cpTemplateOllama;
		case "vllm":
			return t.settings.cpTemplateVllm;
		default:
			return t.settings.cpTemplateBlank;
	}
}

function errorText(t: MessageCatalog, code: FormError): string {
	switch (code) {
		case "idRequired":
			return t.settings.cpErrIdRequired;
		case "idPattern":
			return t.settings.cpErrIdPattern;
		case "idBuiltin":
			return t.settings.cpErrIdBuiltin;
		case "idExists":
			return t.settings.cpErrIdExists;
		case "baseUrlRequired":
			return t.settings.cpErrBaseUrlRequired;
		case "modelsRequired":
			return t.settings.cpErrModelsRequired;
		case "modelIdRequired":
			return t.settings.cpErrModelIdRequired;
		case "positiveIntRequired":
			return t.settings.cpErrPositiveInt;
	}
}

/**
 * Add/edit a custom provider (writes ~/.pi/agent/models.json). In edit mode
 * unknown config keys (compat, headers, cost, ...) pass through untouched.
 */
export function CustomProviderDialog({
	open,
	editing,
	builtinIds,
	existingIds,
	t,
	onClose,
	onSaved,
	onError,
	onChanged,
}: {
	open: boolean;
	/** Entry being edited; null = add mode. */
	editing: CustomProviderEntry | null;
	/** pi built-in catalog ids, for the friendly collision pre-check. */
	builtinIds: readonly string[];
	/** Other custom providers' ids (collision check in add mode). */
	existingIds: readonly string[];
	t: MessageCatalog;
	onClose: () => void;
	onSaved: (msg: string) => void;
	onError: (msg: string) => void;
	/** Refresh provider/auth lists after a successful save. */
	onChanged: () => void;
}) {
	const [form, setForm] = useState<CustomProviderForm>(() =>
		formFromTemplate(PROVIDER_TEMPLATES[0]),
	);
	const [templateKey, setTemplateKey] = useState<string>("blank");
	const [templateExtra, setTemplateExtra] = useState<Record<string, unknown> | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		setError(null);
		setBusy(false);
		if (editing) {
			setForm(formFromConfig(editing.id, editing.config));
			setTemplateKey("");
			setTemplateExtra(undefined);
		} else {
			const tpl = PROVIDER_TEMPLATES[0];
			setForm(formFromTemplate(tpl));
			setTemplateKey(tpl.key);
			setTemplateExtra(tpl.extra);
		}
	}, [open, editing]);

	if (!open) return null;

	const idLocked = editing !== null;

	const applyTemplate = (key: string) => {
		const tpl = PROVIDER_TEMPLATES.find((p) => p.key === key) ?? PROVIDER_TEMPLATES[0];
		setTemplateKey(tpl.key);
		setTemplateExtra(tpl.extra);
		// Keep any API key the user already typed; templates don't carry one.
		setForm((prev) => ({ ...formFromTemplate(tpl), apiKey: prev.apiKey }));
	};

	const patch = (p: Partial<CustomProviderForm>) => setForm((prev) => ({ ...prev, ...p }));

	const patchModel = (index: number, p: Partial<CustomProviderForm["models"][number]>) =>
		setForm((prev) => ({
			...prev,
			models: prev.models.map((m, i) => (i === index ? { ...m, ...p } : m)),
		}));

	const removeModel = (index: number) =>
		setForm((prev) => ({
			...prev,
			models: prev.models.filter((_, i) => i !== index),
		}));

	const save = async () => {
		const code = validateProviderForm(form, { builtinIds, existingIds, idLocked });
		if (code) {
			setError(errorText(t, code));
			return;
		}
		setBusy(true);
		setError(null);
		const id = form.id.trim();
		try {
			const config = buildProviderConfig(form, editing?.config, templateExtra);
			await piUpsertCustomProvider(id, config);
			// Optional key: stored in auth.json alongside the models.json entry.
			const key = form.apiKey.trim();
			if (key) {
				try {
					await authSetKey(id, key);
				} catch (e) {
					onChanged();
					onClose();
					onError(t.settings.providerKeySaveFailed.replace("{error}", String(e)));
					return;
				}
			}
			onChanged();
			onSaved(t.settings.providerSaved.replace("{id}", id));
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
			title={idLocked ? t.settings.cpTitleEdit : t.settings.cpTitleAdd}
			closeLabel={t.app.close}
			className="custom-provider-dialog"
		>
			{!idLocked && (
				<div className="cp-field">
					<label className="cp-label">{t.settings.cpTemplate}</label>
					<select value={templateKey} onChange={(e) => applyTemplate(e.target.value)}>
						{PROVIDER_TEMPLATES.map((tpl) => (
							<option key={tpl.key} value={tpl.key}>
								{templateLabel(t, tpl.key)}
							</option>
						))}
					</select>
				</div>
			)}

			<div className="cp-grid">
				<div className="cp-field">
					<label className="cp-label">{t.settings.cpId}</label>
					<input
						value={form.id}
						disabled={idLocked}
						placeholder="volcengine"
						spellCheck={false}
						onChange={(e) => patch({ id: e.target.value })}
					/>
					{!idLocked && <p className="cp-note">{t.settings.cpIdHint}</p>}
				</div>
				<div className="cp-field">
					<label className="cp-label">{t.settings.cpApi}</label>
					<select
						value={form.api}
						onChange={(e) => patch({ api: e.target.value as CustomProviderForm["api"] })}
					>
						{PROVIDER_APIS.map((api) => (
							<option key={api} value={api}>
								{api}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="cp-field">
				<label className="cp-label">{t.settings.cpBaseUrl}</label>
				<input
					value={form.baseUrl}
					placeholder="https://ark.cn-beijing.volces.com/api/v3"
					spellCheck={false}
					onChange={(e) => patch({ baseUrl: e.target.value })}
				/>
			</div>

			<div className="cp-field">
				<label className="cp-label">{t.settings.cpApiKey}</label>
				<input
					type="password"
					value={form.apiKey}
					onChange={(e) => patch({ apiKey: e.target.value })}
				/>
				{idLocked && <p className="cp-note">{t.settings.cpApiKeyEditNote}</p>}
			</div>

			<div className="cp-models-head">
				<span className="cp-label">{t.settings.cpModels}</span>
				<button
					className="btn secondary small"
					onClick={() => setForm((prev) => ({ ...prev, models: [...prev.models, blankModel()] }))}
				>
					<PlusIcon size={12} /> {t.settings.cpAddModel}
				</button>
			</div>
			<div className="cp-models">
				{form.models.map((m, i) => (
					<div className="cp-model-row" key={i}>
						<div className="cp-model-line">
							<input
								className="cp-model-id mono"
								value={m.id}
								placeholder={t.settings.cpModelId}
								spellCheck={false}
								onChange={(e) => patchModel(i, { id: e.target.value })}
							/>
							<input
								className="cp-model-name"
								value={m.name}
								placeholder={t.settings.cpModelName}
								spellCheck={false}
								onChange={(e) => patchModel(i, { name: e.target.value })}
							/>
							<button
								className="icon-btn"
								title={t.settings.deleteProvider}
								aria-label={t.settings.deleteProvider}
								onClick={() => removeModel(i)}
							>
								<TrashIcon size={13} />
							</button>
						</div>
						<div className="cp-model-line cp-model-meta">
							<label className="cp-check" title={t.settings.cpReasoning}>
								<input
									type="checkbox"
									checked={m.reasoning}
									onChange={(e) => patchModel(i, { reasoning: e.target.checked })}
								/>
								{t.settings.cpReasoning}
							</label>
							<label className="cp-check" title={t.settings.cpImage}>
								<input
									type="checkbox"
									checked={m.image}
									onChange={(e) => patchModel(i, { image: e.target.checked })}
								/>
								{t.settings.cpImage}
							</label>
							<label className="cp-num">
								<span>{t.settings.cpContextWindow}</span>
								<input
									type="number"
									min={1}
									value={m.contextWindow}
									onChange={(e) => patchModel(i, { contextWindow: Number(e.target.value) })}
								/>
							</label>
							<label className="cp-num">
								<span>{t.settings.cpMaxTokens}</span>
								<input
									type="number"
									min={1}
									value={m.maxTokens}
									onChange={(e) => patchModel(i, { maxTokens: Number(e.target.value) })}
								/>
							</label>
						</div>
					</div>
				))}
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
