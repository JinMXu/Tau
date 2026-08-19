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
