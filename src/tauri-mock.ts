/* Tauri IPC mock (dev-only) — must be imported BEFORE any @tauri-apps/api
 * consumer so window.__TAURI_INTERNALS__ exists at module init. */

// ---- localStorage preset (before App reads it) -----------------------------
localStorage.setItem("pi-gui.workspace.v1", "D:/agents/pi-gui");
localStorage.setItem("pi-gui.model.v1", "mock-model");
localStorage.setItem("pi-gui.sidebar.collapsed.v1", "1");

// ---- Tauri IPC mock ---------------------------------------------------------
type Cb = (payload: unknown) => void;
const cbs = new Map<number, Cb>();
const listeners = new Map<string, Set<number>>();
let cbSeq = 0;
let eventSeq = 0;
const invoked: { cmd: string; args: unknown }[] = [];

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
	metadata: {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	},
	transformCallback(cb: Cb, _once?: boolean) {
		const id = ++cbSeq;
		cbs.set(id, cb);
		return id;
	},
	invoke(cmd: string, args?: unknown) {
		invoked.push({ cmd, args });
		switch (cmd) {
			case "plugin:event|listen": {
				const a = args as { event: string; handler: number };
				const set = listeners.get(a.event) ?? new Set<number>();
				set.add(a.handler);
				listeners.set(a.event, set);
				return Promise.resolve(++eventSeq);
			}
			case "plugin:event|unlisten":
				return Promise.resolve(null);
			case "pi_binary":
				return Promise.resolve({ bin: "pi-mock", version: "0.0.0-mock", builtin: true });
			case "plugin:app|version":
				return Promise.resolve("0.1.0-mock");
			case "update_check":
				return Promise.resolve({
					checkedAtMs: Date.now(),
					current: "0.1.0-mock",
					latest: "v0.1.0-mock",
					available: false,
					url: "https://github.com/JinMXu/Tau/releases",
					notes: "",
					publishedAt: null,
					fromCache: false,
				});
			case "pi_list_sessions":
				return Promise.resolve([]);
			case "pi_list_archived_sessions":
				return Promise.resolve([]);
			case "pi_status":
				return Promise.resolve({
					running: false,
					workspace: "D:/agents/pi-gui",
					sessionFile: null,
				});
			case "pi_subagent_runs":
				return Promise.resolve([]);
			case "pi_start":
				return Promise.resolve(null);
			case "pi_send":
				// Response envelope arrives as a pi://event of type "response".
				setTimeout(() => {
					const a = args as { id?: string; chan?: string };
					emit("pi://event", {
						chan: a?.chan,
						ev: { type: "response", id: a?.id, success: true, data: {} },
					});
				}, 0);
				return Promise.resolve(null);
			case "pi_stop":
			case "rebuild_menu":
			case "pi_new_window":
				return Promise.resolve(null);
			default:
				console.warn("[mock] unhandled invoke:", cmd, args);
				return Promise.resolve(null);
		}
	},
};

function emit(event: string, payload: unknown) {
	const set = listeners.get(event);
	if (!set) return;
	for (const id of set) {
		const cb = cbs.get(id);
		if (cb) cb({ event, id: ++eventSeq, payload });
	}
}

(window as unknown as { __emit: typeof emit }).__emit = emit;
(window as unknown as { __invoked: typeof invoked }).__invoked = invoked;
