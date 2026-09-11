import { useEffect, useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { PlusIcon, TrashIcon } from "../icons";
import { Modal } from "./Modal";

/**
 * `/scoped-models` equivalent: model patterns used for Ctrl+P cycling
 * (`--models` flag, passed at pi spawn). Takes effect on the next connect.
 */
export function ScopedModelsDialog({
	open,
	models,
	t,
	onClose,
	onSave,
}: {
	open: boolean;
	models: string[];
	t: MessageCatalog;
	onClose: () => void;
	onSave: (patterns: string[]) => void;
}) {
	const [patterns, setPatterns] = useState<string[]>(models);
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			setPatterns(models);
			setDraft("");
		}
	}, [open, models]);

	if (!open) return null;

	const add = () => {
		const p = draft.trim();
		if (!p) return;
		setPatterns((prev) => (prev.includes(p) ? prev : [...prev, p]));
		setDraft("");
		inputRef.current?.focus();
	};

	const remove = (p: string) => setPatterns((prev) => prev.filter((x) => x !== p));

	return (
		<Modal
			open
			onClose={onClose}
			title={t.scopedModels.title}
			closeLabel={t.app.close}
			className="scoped-models-dialog"
			initialFocusRef={inputRef}
		>
			<p className="extension-message">{t.scopedModels.hint}</p>
			<div className="scoped-models-input">
				<input
					ref={inputRef}
					value={draft}
					placeholder={t.scopedModels.placeholder}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
				/>
				<button className="btn secondary" onClick={add} disabled={!draft.trim()}>
					<PlusIcon size={13} />
					<span>{t.scopedModels.add}</span>
				</button>
			</div>
			<div className="scoped-models-list">
				{patterns.length === 0 && <div className="menu-empty">{t.scopedModels.empty}</div>}
				{patterns.map((p) => (
					<div className="scoped-models-item" key={p}>
						<span className="mono">{p}</span>
						<button className="icon-btn" title={t.scopedModels.remove} onClick={() => remove(p)}>
							<TrashIcon size={12} />
						</button>
					</div>
				))}
			</div>
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onClose}>
					{t.app.cancel}
				</button>
				<button
					className="btn primary"
					onClick={() => {
						onSave(patterns);
						onClose();
					}}
				>
					{t.app.confirm}
				</button>
			</div>
		</Modal>
	);
}
