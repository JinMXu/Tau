import { invoke } from "@tauri-apps/api/core";

/**
 * Report a renderer-side failure to the Rust runtime log.
 *
 * Shared by main.tsx (root boundary + global handlers) and the per-message
 * boundary, so every crash path leaves the same trail in tau.log. Without this
 * a React render error either unmounts the whole tree (blank window — users
 * read it as a crash) or vanishes silently, leaving no evidence.
 */
export function reportFrontendError(where: string, err: unknown): void {
	try {
		const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
		void invoke("log_frontend", { message: `${where}: ${msg}` }).catch(() => {
			/* never let reporting itself crash */
		});
	} catch {
		/* never let reporting itself crash */
	}
}
