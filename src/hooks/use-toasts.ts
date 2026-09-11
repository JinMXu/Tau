import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
	id: number;
	text: string;
}

/** How long a toast stays on screen before it removes itself. */
const TOAST_TTL_MS = 2600;

let nextToastId = 1;

/**
 * Transient status messages (the little pills at the bottom of the window).
 *
 * Extracted from App.tsx, where the state, the `toast()` helper and the
 * auto-dismiss timer were three separate pieces of the root component. The
 * timers are tracked so they can be cleared on unmount — previously a toast
 * scheduled right before the window closed left a timer holding a reference
 * to the state setter.
 */
export function useToasts() {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const timersRef = useRef<Set<number>>(new Set());

	const dismiss = useCallback((id: number) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	const toast = useCallback(
		(text: string) => {
			const id = nextToastId++;
			setToasts((prev) => [...prev, { id, text }]);
			const timer = window.setTimeout(() => {
				timersRef.current.delete(timer);
				dismiss(id);
			}, TOAST_TTL_MS);
			timersRef.current.add(timer);
		},
		[dismiss],
	);

	useEffect(() => {
		const timers = timersRef.current;
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
			timers.clear();
		};
	}, []);

	return { toasts, toast, dismiss };
}
