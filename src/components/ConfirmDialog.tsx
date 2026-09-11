import type { MessageCatalog } from "../i18n";
import { Modal } from "./Modal";

export interface ConfirmState {
	title: string;
	body: string;
	confirmLabel?: string;
	onConfirm: () => void;
}

/**
 * Shared destructive-action confirmation (delete session, purge, remove
 * project, …). Extracted from App.tsx.
 *
 * Focus starts on the dialog panel rather than on a button, so a stray Enter
 * cannot trigger the danger action — the user has to Tab (or click) to it
 * first.
 */
export function ConfirmDialog({
	state,
	t,
	onClose,
}: {
	state: ConfirmState;
	t: MessageCatalog;
	onClose: () => void;
}) {
	return (
		<Modal
			open
			onClose={onClose}
			title={state.title}
			closeLabel={t.app.close}
			className="confirm-dialog"
			showClose={false}
		>
			<p className="extension-message">{state.body}</p>
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onClose}>
					{t.app.cancel}
				</button>
				<button
					className="btn danger"
					onClick={() => {
						const fn = state.onConfirm;
						onClose();
						void fn();
					}}
				>
					{state.confirmLabel ?? t.app.confirm}
				</button>
			</div>
		</Modal>
	);
}
