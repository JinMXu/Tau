import { useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { Modal } from "./Modal";

export interface RenameState {
	title: string;
	initial: string;
}

/**
 * Session-rename prompt (also used for the initial naming of a new session).
 * Extracted from App.tsx; the text is selected on open so the user can just
 * type over the existing name.
 */
export function RenameDialog({
	state,
	t,
	onClose,
	onConfirm,
}: {
	state: RenameState;
	t: MessageCatalog;
	onClose: () => void;
	onConfirm: (name: string) => void;
}) {
	const [value, setValue] = useState(state.initial);
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<Modal
			open
			onClose={onClose}
			title={state.title}
			closeLabel={t.app.close}
			showClose={false}
			initialFocusRef={inputRef}
		>
			<input
				ref={inputRef}
				onFocus={(e) => e.currentTarget.select()}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && value.trim()) onConfirm(value.trim());
				}}
			/>
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onClose}>
					{t.app.cancel}
				</button>
				<button
					className="btn primary"
					disabled={!value.trim()}
					onClick={() => onConfirm(value.trim())}
				>
					{t.app.confirm}
				</button>
			</div>
		</Modal>
	);
}
