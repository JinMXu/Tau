import { useCallback, useEffect, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { XIcon } from "../icons";

/** Everything inside the panel that can hold focus, in DOM order. */
const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog shell for every overlay in the app.
 *
 * Each of the nine `*Dialog` components (plus three inline modals in App.tsx)
 * used to hand-roll the same
 * `overlay-backdrop > extension-dialog > tree-dialog-header` skeleton. Twelve
 * copies had drifted apart: most lacked `role="dialog"`, a few closed on
 * Escape but only while a textarea inside them had focus, and none trapped
 * Tab, so focus escaped into the page behind the backdrop. Routing them all
 * through one component is what makes that behaviour consistent instead of
 * accidental — and it is the single place to fix when it is wrong.
 *
 * The visual contract is unchanged: same class names, so the existing CSS
 * (`.overlay-backdrop`, `.extension-dialog`, `.tree-dialog-header`, …) applies
 * as before. `className` is appended to the panel for per-dialog sizing.
 */
export function Modal({
	open,
	onClose,
	title,
	closeLabel,
	children,
	className,
	headerActions,
	showClose = true,
	closeOnBackdrop = true,
	closeOnEscape = true,
	initialFocusRef,
}: {
	open: boolean;
	onClose: () => void;
	/** Visible heading; also becomes the dialog's accessible name. */
	title?: ReactNode;
	/** Accessible label for the close button (already localized). */
	closeLabel?: string;
	children: ReactNode;
	/** Extra class on the panel, e.g. `hotkeys-dialog`. */
	className?: string;
	/** Rendered between the title and the close button. */
	headerActions?: ReactNode;
	/** Set false for dialogs that must be answered (no close affordance). */
	showClose?: boolean;
	closeOnBackdrop?: boolean;
	closeOnEscape?: boolean;
	/** Element to focus on open. Defaults to the panel itself. */
	initialFocusRef?: RefObject<HTMLElement | null>;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const titleId = useId();

	// Escape closes the dialog. The listener is on the bubble phase so a
	// nested control (an open dropdown inside the dialog) gets the event
	// first: if it calls preventDefault — meaning it consumed Escape to close
	// itself — the dialog stays open. Otherwise the dialog closes and
	// stopPropagation keeps the event from reaching the app-level Escape
	// handler, which would otherwise interrupt the running turn.
	useEffect(() => {
		if (!open || !closeOnEscape) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (e.defaultPrevented) return;
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, closeOnEscape, onClose]);

	// Move focus into the dialog on open and hand it back to whatever had it
	// before on close — without this, dismissing a dialog dropped focus on
	// <body> and keyboard users lost their place.
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		const target = initialFocusRef?.current ?? panelRef.current;
		target?.focus({ preventScroll: true });
		return () => {
			if (previous && previous.isConnected) {
				previous.focus({ preventScroll: true });
			}
		};
	}, [open, initialFocusRef]);

	// Focus trap: Tab cycles inside the panel instead of walking out to the
	// page behind the backdrop.
	const onKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key !== "Tab") return;
		const panel = panelRef.current;
		if (!panel) return;
		const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
		if (items.length === 0) {
			e.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || active === panel)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}, []);

	if (!open) return null;

	return (
		<div
			className="overlay-backdrop"
			// mousedown, not click: a text selection that starts inside the
			// panel and ends on the backdrop must not dismiss the dialog.
			onMouseDown={(e) => {
				if (closeOnBackdrop && e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={panelRef}
				className={className ? `extension-dialog ${className}` : "extension-dialog"}
				role="dialog"
				aria-modal="true"
				aria-labelledby={title != null ? titleId : undefined}
				tabIndex={-1}
				onKeyDown={onKeyDown}
			>
				{title != null && (
					<div className="tree-dialog-header">
						<h3 id={titleId}>{title}</h3>
						{headerActions}
						{showClose && (
							<button
								className="icon-btn"
								title={closeLabel}
								aria-label={closeLabel}
								onClick={onClose}
							>
								<XIcon size={15} />
							</button>
						)}
					</div>
				)}
				{children}
			</div>
		</div>
	);
}
