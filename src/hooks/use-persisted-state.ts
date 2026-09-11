import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

const defaultSerialize = (value: unknown): string => JSON.stringify(value);
const defaultDeserialize = (raw: string): unknown => JSON.parse(raw);

/**
 * `useState` whose value survives a restart, backed by localStorage.
 *
 * App.tsx used to pair every persisted field with two separate pieces of
 * code: a `useState(() => localStorage.getItem(...))` initialiser and a
 * `useEffect(() => localStorage.setItem(...), [value])` writer, ten times
 * over. Reading the file you had to match them up by eye to know whether a
 * value actually persists — and a field that had one without the other
 * looked identical to one that had both. One hook removes the pairing.
 *
 * `serialize`/`deserialize` cover the cases JSON alone cannot: `Set`s, and
 * values that need validation on read (a corrupt width must fall back to the
 * default rather than propagate).
 */
export function usePersistedState<T>(
	key: string,
	initial: T | (() => T),
	options?: {
		serialize?: (value: T) => string;
		deserialize?: (raw: string) => T;
	},
): [T, Dispatch<SetStateAction<T>>] {
	// Kept in refs so an inline arrow passed at the call site cannot restart
	// the write effect on every render.
	const serializeRef = useRef<(value: T) => string>(defaultSerialize as (v: T) => string);
	const deserializeRef = useRef<(raw: string) => T>(defaultDeserialize as (r: string) => T);
	serializeRef.current = options?.serialize ?? (defaultSerialize as (v: T) => string);
	deserializeRef.current = options?.deserialize ?? (defaultDeserialize as (r: string) => T);

	const fallback = () => (typeof initial === "function" ? (initial as () => T)() : initial);

	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			if (raw === null) return fallback();
			return deserializeRef.current(raw);
		} catch {
			// Unreadable or unparseable storage: fall back rather than throw —
			// a bad value here used to take the whole render down.
			return fallback();
		}
	});

	// Skip the first write: it would only echo back the value just read, and
	// when reading failed it would overwrite the stored value with the
	// default, silently discarding whatever the user had.
	const settled = useRef(false);
	useEffect(() => {
		if (!settled.current) {
			settled.current = true;
			return;
		}
		try {
			localStorage.setItem(key, serializeRef.current(value));
		} catch {
			/* quota or privacy mode — the value still works in memory */
		}
	}, [key, value]);

	return [value, setValue];
}

/** Serializer pair for a `Set<string>` persisted as a JSON array. */
export const stringSetCodec = {
	serialize: (value: Set<string>) => JSON.stringify([...value]),
	deserialize: (raw: string) => new Set(JSON.parse(raw) as string[]),
};

/** Serializer pair for a boolean persisted as `"1"` / `"0"`. */
export const flagCodec = {
	serialize: (value: boolean) => (value ? "1" : "0"),
	deserialize: (raw: string) => raw === "1",
};
