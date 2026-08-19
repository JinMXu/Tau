import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";

/**
 * Report renderer-side failures to the Rust runtime log. Without this a
 * React render error unmounts the whole tree (blank window — users read it
 * as a crash) and an uncaught exception vanishes silently, leaving no
 * evidence for debugging.
 */
function reportError(where: string, err: unknown) {
	try {
		const msg =
			err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
		void invoke("log_frontend", { message: `${where}: ${msg}` }).catch(() => {});
	} catch {
		/* never let reporting itself crash */
	}
}

class ErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		reportError("react-boundary", `${error}\n${info.componentStack ?? ""}`);
	}

	render() {
		if (this.state.error) {
			return (
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						height: "100vh",
						gap: 12,
						fontFamily: "system-ui, sans-serif",
						color: "var(--text-1, #23211e)",
						background: "var(--app-bg, #f6f4f1)",
					}}
				>
					<h2 style={{ margin: 0 }}>Something went wrong</h2>
					<pre
						style={{
							maxWidth: 640,
							maxHeight: "40vh",
							overflow: "auto",
							whiteSpace: "pre-wrap",
							fontSize: 12,
							padding: 12,
							borderRadius: 8,
							background: "rgba(0,0,0,0.06)",
						}}
					>
						{String(this.state.error)}
					</pre>
					<button
						style={{
							padding: "8px 20px",
							borderRadius: 8,
							border: "1px solid rgba(0,0,0,0.2)",
							background: "var(--accent, #2b2824)",
							color: "#fff",
							cursor: "pointer",
						}}
						onClick={() => window.location.reload()}
					>
						Reload
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

// Global error / unhandled-rejection reporting so renderer crashes leave a
// trail in tau.log instead of vanishing silently.
window.addEventListener("error", (e) =>
	reportError("window.onerror", e.error ?? e.message),
);
window.addEventListener("unhandledrejection", (e) =>
	reportError("unhandledrejection", e.reason),
);
// Distinguishes a real window close (fires beforeunload) from a webview
// renderer crash (never fires — the process just dies).
window.addEventListener("beforeunload", () => {
	void invoke("log_frontend", { message: "beforeunload: renderer closing" }).catch(
		() => {},
	);
});

// Freeze diagnostics (investigating "window occluded + session streaming =>
// app stops responding"). Three ping sources with different dependencies let
// the log show exactly which piece wedged:
//   - Rust background heartbeat: keeps logging unless the whole process died;
//   - Rust main-thread probe: stops when the UI thread is blocked;
//   - this renderer ping: needs BOTH a live renderer and a main thread that
//     still processes IPC.
// Whichever line stops first in tau.log identifies the frozen piece.
setInterval(() => {
	void invoke("log_frontend_info", {
		message: `renderer alive (${document.visibilityState})`,
	}).catch(() => {});
}, 15000);

// Chromium marks a fully-occluded WebView2 page hidden (native window
// occlusion tracking), so these transitions timestamp exactly when the
// window got covered/uncovered — the condition linked to the freezes.
document.addEventListener("visibilitychange", () => {
	void invoke("log_frontend_info", {
		message: `renderer visibility: ${document.visibilityState}`,
	}).catch(() => {});
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</React.StrictMode>,
);
