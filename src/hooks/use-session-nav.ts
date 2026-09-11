import { useCallback, useRef, useState } from "react";

/**
 * Session back/forward history.
 *
 * Extracted from App.tsx. The state and its ref mirror have to stay in step —
 * the callbacks must never read a stale index while `setState` is still in
 * flight — and keeping that invariant next to the two functions that rely on
 * it is what makes it checkable. Nothing outside this hook touches the
 * history.
 */
export function useSessionNav() {
	const [history, setHistory] = useState<string[]>([]);
	const [index, setIndex] = useState(-1);
	const historyRef = useRef<string[]>([]);
	const indexRef = useRef(-1);

	const pushNav = useCallback((path: string) => {
		// Clicking the session already on screen doesn't add a duplicate.
		if (historyRef.current[indexRef.current] === path) return;
		indexRef.current += 1;
		// Truncate any forward entries: navigating away starts a new branch,
		// exactly like a browser.
		historyRef.current = [...historyRef.current.slice(0, indexRef.current), path];
		setHistory(historyRef.current);
		setIndex(indexRef.current);
	}, []);

	/**
	 * Move one step through the history and return the session path to open,
	 * or null when already at the end. Committing the new index here (rather
	 * than in the caller) keeps the ref and the state from drifting apart if
	 * the connect that follows fails.
	 */
	const stepNav = useCallback((dir: -1 | 1): string | null => {
		const next = indexRef.current + dir;
		const target = historyRef.current[next];
		if (next < 0 || next >= historyRef.current.length || !target) return null;
		indexRef.current = next;
		setIndex(next);
		return target;
	}, []);

	return {
		canGoBack: index > 0,
		canGoForward: index >= 0 && index < history.length - 1,
		pushNav,
		stepNav,
	};
}
