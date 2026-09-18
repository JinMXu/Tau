import { useEffect, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { XIcon } from "../icons";
import { CenterMorphModal, CenterMorphModalContent } from "./motion/center-morph-modal";

/**
 * Shared dialog shell for every overlay in the app.
 *
 * The surface and its animation come from beui's CenterMorphModal: the panel
 * unfolds from its center via a clip-path while the backdrop fades. The
 * `.extension-dialog` class (plus any per-dialog `className`) keeps owning the
 * visual contract — width, background, border, padding — with one exception:
 * the corner radius now reads at beui's 30px because the unfolding clip-path
 * itself is cut at that radius.
 *
 * Two pieces of behaviour deliberately stay here instead of delegating:
 * - Escape is handled on `document` with `stopPropagation`, so dismissing a
 *   dialog can never reach the app-level Escape handler (which would
 *   interrupt a running turn) and a nested control can still consume the key
 *   first. beui's own Escape listener sits on `window`, after ours, and never
 *   fires for the same event.
 * - Focus is restored to whatever held it before the dialog opened. beui
 *   restores to its trigger element, but every dialog here opens
 *   programmatically — no trigger exists.
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
	/** Element to focus on open. Defaults to the first focusable in the panel. */
	initialFocusRef?: RefObject<HTMLElement | null>;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const titleId = useId();

	// Escape closes the dialog. The listener is on the bubble phase so a
	// nested control (an open dropdown inside the dialog) gets the event
	// first: if it calls preventDefault — meaning it consumed Escape to close
	// itself — the dialog stays open. Otherwise the dialog closes and
	// stopPropagation keeps the event from reaching the app-level Escape
	// handler, which would otherwise interrupt the running turn. It also
	// starves beui's own window-level Escape listener: closeOnEscape=false
	// swallows the key instead of closing, and beui never sees it.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (e.defaultPrevented) return;
			if (!closeOnEscape) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, closeOnEscape, onClose]);

	// Move focus into the dialog on open and hand it back to whatever had it
	// before on close — without this, dismissing a dialog dropped focus on
	// <body> and keyboard users lost their place. beui focuses its first
	// focusable element from its own rAF; scheduling ours the same way (and
	// after theirs) means an initialFocusRef target wins that race, matching
	// the pre-beui behaviour where the named target got focus.
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		const frame = requestAnimationFrame(() => {
			const target = initialFocusRef?.current ?? panelRef.current;
			target?.focus({ preventScroll: true });
		});
		return () => {
			cancelAnimationFrame(frame);
			if (previous && previous.isConnected) {
				previous.focus({ preventScroll: true });
			}
		};
	}, [open, initialFocusRef]);

	return (
		<CenterMorphModal
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<CenterMorphModalContent
				ariaLabel={typeof title === "string" ? title : "Dialog"}
				// Backdrop presses close through beui; Escape is ours (above).
				// ExtensionDialog, which must be answered, opts out entirely.
				dismissible={closeOnBackdrop}
				showCloseButton={false}
				className="max-w-none w-auto rounded-[inherit] border-0 bg-transparent"
			>
				<div
					ref={panelRef}
					className={className ? `extension-dialog ${className}` : "extension-dialog"}
					aria-labelledby={title != null ? titleId : undefined}
					tabIndex={-1}
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
			</CenterMorphModalContent>
		</CenterMorphModal>
	);
}
