import { useCallback, useRef, useState } from "react";

/** Keep only the tail: the stderr panel shows the last 30 lines anyway. */
const MAX_LINES = 200;

/**
 * Buffered stderr lines for the debug panel.
 *
 * pi tools that print progress or spinners emit dozens of lines per second,
 * and every `setState` here re-renders the whole App (stderr lives in the
 * root state). Flushing once per animation frame collapses a burst into a
 * single render.
 *
 * Extracted from App.tsx: the two refs, the rAF handle and the flush logic
 * are a self-contained mechanism with no dependency on the rest of the root
 * component, and they were sitting in the middle of the state declarations.
 */
export function useStderrBuffer() {
	const [stderr, setStderr] = useState<string[]>([]);
	const pendingRef = useRef<string[]>([]);
	const flushRef = useRef<number | null>(null);

	const pushStderr = useCallback((line: string) => {
		pendingRef.current.push(line);
		if (flushRef.current !== null) return;
		flushRef.current = requestAnimationFrame(() => {
			flushRef.current = null;
			const lines = pendingRef.current;
			pendingRef.current = [];
			if (lines.length === 0) return;
			setStderr((prev) => [...prev, ...lines].slice(-MAX_LINES));
		});
	}, []);

	return { stderr, pushStderr };
}
