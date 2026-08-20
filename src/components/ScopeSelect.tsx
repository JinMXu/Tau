import { useEffect, useRef, useState } from "react";
import { projectNameFromPath, type MessageCatalog } from "../i18n";
import { CheckIcon, ChevronDownIcon } from "../icons";

/**
 * MCP scope picker (用户 / 工作区). A custom dropdown so the popup matches the
 * app theme — a native <select> renders with OS chrome on Windows.
 */
export function ScopeSelect({
	value,
	options,
	disabled,
	fullWidth,
	t,
	onChange,
}: {
	/** "" = user scope, otherwise a project path. */
	value: string;
	/** Known workspace paths. */
	options: readonly string[];
	disabled?: boolean;
	/** Stretch the trigger to the container width (dialog layout). */
	fullWidth?: boolean;
	t: MessageCatalog;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const label = value ? projectNameFromPath(value) : t.settings.mcpScopeUser;

	const pick = (v: string) => {
		onChange(v);
		setOpen(false);
	};

	return (
		<div className={`mcp-scope ${fullWidth ? "full" : ""}`} ref={wrapRef}>
			<button
				className={`mcp-scope-btn ${open ? "open" : ""}`}
				disabled={disabled}
				title={value || undefined}
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="mcp-scope-btn-label">{label}</span>
				<ChevronDownIcon size={13} />
			</button>
			{open && (
				<div className="mcp-scope-menu">
					<button
						className={`mcp-scope-item ${value === "" ? "active" : ""}`}
						onClick={() => pick("")}
					>
						<span className="mcp-scope-item-name">
							{t.settings.mcpScopeUser}
						</span>
						{value === "" && <CheckIcon size={13} />}
					</button>
					{options.length > 0 && (
						<>
							<div className="mcp-scope-group">
								{t.settings.mcpScopeWorkspaces}
							</div>
							{options.map((p) => (
								<button
									key={p}
									className={`mcp-scope-item ${value === p ? "active" : ""}`}
									title={p}
									onClick={() => pick(p)}
								>
									<span className="mcp-scope-item-name">
										{projectNameFromPath(p)}
									</span>
									{value === p && <CheckIcon size={13} />}
								</button>
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
}
