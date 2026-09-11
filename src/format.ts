/**
 * Single home for display formatting.
 *
 * These helpers used to be scattered as private functions inside the
 * components that first needed them — three different duration renderings,
 * three different timestamp renderings, and a path-splitting rule duplicated
 * between the sidebar and `i18n.ts`. They are genuinely *different* formats
 * (a turn timer, a live ticking status and a "15h 47m" usage total should not
 * look alike), so they are not merged into one function with a mode flag;
 * they are collected here so the next one has an obvious place to live and
 * the differences stay visible side by side.
 */

/** Human-readable byte size (shared by attachment chips and the app shell). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Last segment of a path, with trailing separators stripped.
 * `D:\projects\demo` → `demo`, `C:\` → `C:`, `/home/u/work/` → `work`.
 */
export function projectNameFromPath(path: string | null | undefined): string {
	if (!path) return "";
	const normalized = path.replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/);
	return parts[parts.length - 1] || normalized;
}

/** Compact duration for turn timers: `42s` / `3m 05s` / `1h 02m`. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
	return `${total}s`;
}

/**
 * Duration for the live "working…" status: `42s` / `1:05`.
 * Shorter than `formatDuration` on purpose — it re-renders every second next
 * to a spinner and must not shift the layout around it.
 */
export function formatClockDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

/** Wall-clock time of day, 24-hour: `14:19`. */
export function formatTimeOfDay(ms: number): string {
	try {
		return new Date(ms).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	} catch {
		return "";
	}
}

/** Localized date + time: `2026年8月13日，14:19` / `August 13, 2026, 14:19`. */
export function formatDateTime(ms: number, lang: string): string {
	const d = new Date(ms);
	const locale = lang === "zh" ? "zh-CN" : "en-US";
	const date = d.toLocaleDateString(locale, {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	const time = d.toLocaleTimeString(locale, {
		hour: "2-digit",
		minute: "2-digit",
	});
	return `${date}${lang === "zh" ? "，" : ", "}${time}`;
}
