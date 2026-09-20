import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Protocol whitelist for URLs the webview may hand to the OS shell. The
 * backend opener capability is scoped the same way, but validating here too
 * keeps model-controlled markdown links and third-party strings (OAuth
 * events, gh output, release metadata) from ever reaching ShellExecute with
 * dangerous schemes (file:, ms-msdt:, search-ms:, custom protocol handlers).
 */
const SAFE_EXTERNAL_URL = /^(https?:|mailto:|tel:)/i;

export function isSafeExternalUrl(url: string): boolean {
	return SAFE_EXTERNAL_URL.test(url.trim());
}

/**
 * Open a URL in the system handler. Silently no-ops for URLs outside the
 * whitelist (callers treat opening as best-effort anyway).
 */
export async function openExternal(url: string): Promise<void> {
	const trimmed = url.trim();
	if (!isSafeExternalUrl(trimmed)) return;
	await openUrl(trimmed);
}
