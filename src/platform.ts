/** Platform detection for keyboard shortcut labels. */
export const isMac =
	typeof navigator !== "undefined" &&
	/mac/i.test(
		(
			navigator as Navigator & {
				userAgentData?: { platform?: string };
			}
		).userAgentData?.platform ?? navigator.platform,
	);

/** Windows detection (custom title bar + in-app menu bar). */
export const isWin =
	typeof navigator !== "undefined" &&
	/win/i.test(
		(
			navigator as Navigator & {
				userAgentData?: { platform?: string };
			}
		).userAgentData?.platform ?? navigator.platform,
	);

/** Modifier key label: "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD_KEY = isMac ? "⌘" : "Ctrl";
/** Separator used between modifier key and the next key in displayed shortcuts.
 *  On macOS the ⌘ glyph already acts as a visual separator; on other platforms
 *  we insert "+" so "CtrlN" reads as "Ctrl+N". */
export const MOD_KEY_SEP = isMac ? "" : "+";

/**
 * Compare two session-path spellings. On Windows, pi's RPC `sessionFile` and
 * the backend scan can disagree about drive-letter case or path separators;
 * a strict `===` would silently never match and block the new-session
 * promotion, so compare case- and separator-insensitively there. Other
 * platforms compare strictly.
 */
export function sameSessionPath(a: string, b: string): boolean {
	if (a === b) return true;
	if (!isWin) return false;
	// 归一 verbatim 前缀（canonicalize 产物）、斜杠与大小写
	const norm = (p: string) =>
		p
			.replace(/^\\\\\?\\UNC\\/, "\\\\")
			.replace(/^\\\\\?\\/, "")
			.replace(/\//g, "\\")
			.toLowerCase();
	return norm(a) === norm(b);
}
