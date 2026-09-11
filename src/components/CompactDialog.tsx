import { useEffect, useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { Modal } from "./Modal";

/** `/compact [prompt]` equivalent: compact with optional custom instructions. */
export function CompactDialog({
	open,
	t,
	onClose,
	onConfirm,
}: {
	open: boolean;
	t: MessageCatalog;
	onClose: () => void;
	onConfirm: (instructions: string) => void;
}) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (open) setValue("");
	}, [open]);

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={t.compact.title}
			closeLabel={t.app.close}
			initialFocusRef={inputRef}
		>
			<p className="extension-message">{t.compact.hint}</p>
			<textarea
				ref={inputRef}
				className="compact-textarea"
				rows={4}
				value={value}
				placeholder={t.compact.placeholder}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						onConfirm(value.trim());
					}
				}}
			/>
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onClose}>
					{t.app.cancel}
				</button>
				<button className="btn primary" onClick={() => onConfirm(value.trim())}>
					{t.chat.compact}
				</button>
			</div>
		</Modal>
	);
}
