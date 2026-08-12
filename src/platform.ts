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

/** Modifier key label: "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD_KEY = isMac ? "⌘" : "Ctrl";
