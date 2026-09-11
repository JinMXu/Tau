import { useEffect, useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { Modal } from "./Modal";

export interface ExtensionRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
}

export function ExtensionDialog({
	request,
	onRespond,
	t,
}: {
	request: ExtensionRequest | null;
	onRespond: (id: string, payload: Record<string, unknown>) => void;
	t: MessageCatalog;
}) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const editorRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (request) {
			setValue(request.prefill ?? "");
		}
	}, [request]);

	if (!request) return null;

	const respond = (payload: Record<string, unknown>) => onRespond(request.id, payload);

	// Dismissing (Escape or the Cancel button) must answer the request —
	// pi blocks on it — so it maps to the same payload the Cancel button
	// sends, not to a no-op.
	const cancel = () =>
		respond(request.method === "confirm" ? { confirmed: false } : { cancelled: true });

	const title = request.title || t.extension.confirm;

	return (
		<Modal
			open
			onClose={cancel}
			title={title}
			closeLabel={t.extension.cancel}
			showClose={false}
			closeOnBackdrop={false}
			initialFocusRef={request.method === "editor" ? editorRef : inputRef}
		>
			{request.method === "confirm" && <p className="extension-message">{request.message}</p>}
			{request.method === "select" && (
				<div className="extension-options">
					{(request.options ?? []).map((option) => (
						<button
							key={option}
							className="extension-option"
							onClick={() => respond({ value: option })}
						>
							{option}
						</button>
					))}
				</div>
			)}
			{request.method === "input" && (
				<input
					ref={inputRef}
					value={value}
					placeholder={request.placeholder}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") respond({ value });
					}}
				/>
			)}
			{request.method === "editor" && (
				<textarea
					ref={editorRef}
					className="compact-textarea"
					rows={8}
					value={value}
					placeholder={request.placeholder}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							respond({ value });
						}
					}}
				/>
			)}
			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={cancel}>
					{t.extension.cancel}
				</button>
				{(request.method === "confirm" || request.method === "editor") && (
					<button
						className="btn primary"
						onClick={() => respond(request.method === "confirm" ? { confirmed: true } : { value })}
					>
						{t.extension.ok}
					</button>
				)}
				{request.method === "input" && (
					<button
						className="btn primary"
						disabled={!value.trim()}
						onClick={() => respond({ value })}
					>
						{t.extension.ok}
					</button>
				)}
			</div>
		</Modal>
	);
}
