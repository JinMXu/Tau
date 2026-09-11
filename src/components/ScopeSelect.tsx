import { useEffect, useId, useRef, useState } from "react";
import { projectNameFromPath } from "../format";
import type { MessageCatalog } from "../i18n";
import { CheckIcon, ChevronDownIcon } from "../icons";

/**
 * MCP scope picker (用户 / 工作区). A custom dropdown so the popup matches the
 * app theme — a native <select> renders with OS chrome on Windows.
 *
 * It behaves like a select, so it exposes listbox semantics: the trigger is
 * `aria-haspopup="listbox"`, the popup is a `role="listbox"` holding
 * `role="option"` children, and the active option is tracked with
 * `aria-activedescendant` so arrow keys move a highlight instead of the DOM
 * focus. Without this a screen reader announced the popup as a bare list of
 * buttons and there was no way to move through it without Tab.
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
	const [activeIdx, setActiveIdx] = useState(0);
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const listId = useId();

	/** Flat option list in render order: user scope first, then workspaces. */
	const values: string[] = ["", ...options];
	const optionId = (i: number) => `${listId}-opt-${i}`;

	const close = (refocus = true) => {
		setOpen(false);
		if (refocus) triggerRef.current?.focus({ preventScroll: true });
	};

	const openMenu = () => {
		// Start the highlight on the current value so Enter re-picks it and
		// arrows move relative to where the user already is.
		const idx = values.indexOf(value);
		setActiveIdx(idx < 0 ? 0 : idx);
		setOpen(true);
	};

	useEffect(() => {
		if (!open) return;
		// Move focus to the listbox so `aria-activedescendant` is honoured;
		// focus is handed back to the trigger on close.
		menuRef.current?.focus({ preventScroll: true });
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const label = value ? projectNameFromPath(value) : t.settings.mcpScopeUser;

	const pick = (v: string) => {
		onChange(v);
		close();
	};

	// Keyboard handling for the listbox. Escape and Tab are handled here too
	// so the surrounding dialog does not have to guess where focus is.
	const onMenuKey = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIdx((i) => Math.min(i + 1, values.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIdx((i) => Math.max(i - 1, 0));
		} else if (e.key === "Home") {
			e.preventDefault();
			setActiveIdx(0);
		} else if (e.key === "End") {
			e.preventDefault();
			setActiveIdx(values.length - 1);
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			pick(values[activeIdx]);
		} else if (e.key === "Tab") {
			close(false);
		}
	};

	return (
		<div className={`mcp-scope ${fullWidth ? "full" : ""}`} ref={wrapRef}>
			<button
				ref={triggerRef}
				className={`mcp-scope-btn ${open ? "open" : ""}`}
				disabled={disabled}
				title={value || undefined}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				onClick={() => (open ? close() : openMenu())}
				onKeyDown={(e) => {
					if (open) return;
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						openMenu();
					}
				}}
			>
				<span className="mcp-scope-btn-label">{label}</span>
				<ChevronDownIcon size={13} />
			</button>
			{open && (
				<div
					id={listId}
					ref={menuRef}
					className="mcp-scope-menu"
					role="listbox"
					aria-label={t.settings.mcpScope}
					aria-activedescendant={optionId(activeIdx)}
					tabIndex={-1}
					onKeyDown={onMenuKey}
				>
					<div
						id={optionId(0)}
						role="option"
						aria-selected={value === ""}
						className={`mcp-scope-item ${value === "" ? "active" : ""} ${
							activeIdx === 0 ? "focused" : ""
						}`}
						onClick={() => pick("")}
						onMouseEnter={() => setActiveIdx(0)}
					>
						<span className="mcp-scope-item-name">{t.settings.mcpScopeUser}</span>
						{value === "" && <CheckIcon size={13} />}
					</div>
					{options.length > 0 && (
						<>
							<div className="mcp-scope-group">{t.settings.mcpScopeWorkspaces}</div>
							{options.map((p, i) => {
								const idx = i + 1;
								return (
									<div
										key={p}
										id={optionId(idx)}
										role="option"
										aria-selected={value === p}
										className={`mcp-scope-item ${value === p ? "active" : ""} ${
											activeIdx === idx ? "focused" : ""
										}`}
										title={p}
										onClick={() => pick(p)}
										onMouseEnter={() => setActiveIdx(idx)}
									>
										<span className="mcp-scope-item-name">{projectNameFromPath(p)}</span>
										{value === p && <CheckIcon size={13} />}
									</div>
								);
							})}
						</>
					)}
				</div>
			)}
		</div>
	);
}
