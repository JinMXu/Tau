import { useCallback } from "react";
import { useAnimatedToastStack } from "../components/motion/animated-toast-stack";

/** How long a toast stays on screen before it removes itself. */
const TOAST_TTL_MS = 2600;

/**
 * Transient status messages (the little pills at the bottom of the window).
 *
 * State and timers live in beui's useAnimatedToastStack, which owns the
 * auto-dismiss scheduling and the unmount cleanup. `toast(text)` keeps the
 * app's historical call signature — every toast in this app is a plain
 * status line, so it maps onto beui's `title` with the neutral status.
 */
export function useToasts() {
	const { toasts, showToast, dismissToast } = useAnimatedToastStack({
		defaultDuration: TOAST_TTL_MS,
	});

	const toast = useCallback(
		(text: string) => {
			showToast({ title: text });
		},
		[showToast],
	);

	return { toasts, toast, dismiss: dismissToast };
}
