import { useEffect, useRef, useState } from "react";
import type { MessageCatalog } from "../i18n";

export interface ExtensionRequest {
	id: string;
	method: "select" | "confirm" | "input";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
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

	useEffect(() => {
		if (request) {
			setValue("");
			setTimeout(() => inputRef.current?.focus(), 30);
		}
	}, [request]);

	if (!request) return null;

	const respond = (payload: Record<string, unknown>) =>
		onRespond(request.id, payload);

	const title = request.title || t.extension.confirm;

	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog">
				<h3>{title}</h3>
				{request.method === "confirm" && (
					<p className="extension-message">{request.message}</p>
				)}
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
							if (e.key === "Escape") respond({ cancelled: true });
						}}
					/>
				)}
				<div className="extension-dialog-actions">
					<button
						className="btn secondary"
						onClick={() =>
							respond(
								request.method === "confirm"
									? { confirmed: false }
									: { cancelled: true },
							)
						}
					>
						{t.extension.cancel}
					</button>
					{request.method === "confirm" && (
						<button
							className="btn primary"
							onClick={() => respond({ confirmed: true })}
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
			</div>
		</div>
	);
}
