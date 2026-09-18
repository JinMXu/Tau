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
				// Sample data so the sidebar/projects UI can be eyeballed in the
				// browser preview (app-mock.html) without a real pi install.
				return Promise.resolve([
					{
						path: "D:/agents/pi-gui/.pi/sessions/alpha.jsonl",
						name: "alpha",
						project: "D:/agents/pi-gui",
						title: "重构侧边栏为 beUI 组件",
						model: "mock-model",
						messageCount: 12,
						mtimeMs: Date.now() - 3 * 60_000,
						pending: false,
					},
					{
						path: "D:/agents/pi-gui/.pi/sessions/beta.jsonl",
						name: "beta",
						project: "D:/agents/pi-gui",
						title: "修复 diff 侧栏拖拽宽度",
						model: "mock-model",
						messageCount: 4,
						mtimeMs: Date.now() - 26 * 60_000,
						pending: false,
					},
					{
						path: "D:/agents/tau-docs/.pi/sessions/gamma.jsonl",
						name: "gamma",
						project: "D:/agents/tau-docs",
						title: "Draft release notes",
						model: "mock-model",
						messageCount: 7,
						mtimeMs: Date.now() - 5 * 3600_000,
						pending: false,
					},
				]);
			case "pi_list_archived_sessions":
				// Sample archived rows so the archived-page toolbar (project and
				// time filter selects) renders in the browser preview.
				return Promise.resolve([
					{
						path: "D:/agents/pi-gui/.pi/archived/old1.jsonl",
						originalPath: "D:/agents/pi-gui/.pi/sessions/old1.jsonl",
						title: "旧的调试会话",
						project: "D:/agents/pi-gui",
						mtimeMs: Date.now() - 3 * 86_400_000,
						size: 18_432,
					},
					{
						path: "D:/agents/tau-docs/.pi/archived/old2.jsonl",
						originalPath: "D:/agents/tau-docs/.pi/sessions/old2.jsonl",
						title: "Draft outline",
						project: "D:/agents/tau-docs",
						mtimeMs: Date.now() - 20 * 86_400_000,
						size: 5_120,
					},
				]);
			case "pi_auth_status":
				// Pretend every provider has a key so the composer's send gate
				// (ensureProviderKey) lets scripted sends through.
				return Promise.resolve([
					{ provider: "anthropic", hasKey: true },
					{ provider: "openai", hasKey: true },
				]);
			case "pi_providers":
			case "pi_provider_models":
			case "pi_custom_providers":
			case "pi_mcp_servers":
			case "pi_packages":
				// Empty lists: the settings panel falls back to its bundled
				// provider catalog and renders empty MCP/packages sections.
				return Promise.resolve([]);
			case "pi_installed_skills":
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
				// RPC payloads the UI needs are dispatched by request type so
				// the model/thinking pickers have data to render.
				setTimeout(() => {
					const a = args as {
						id?: string;
						chan?: string;
						command?: { type?: string; id?: string };
					};
					let data: unknown = {};
					if (a.command?.type === "get_available_models") {
						data = {
							models: [
								{
									provider: "anthropic",
									id: "claude-opus-4-6",
									name: "Claude Opus 4.6",
									thinkingLevels: ["off", "low", "high"],
								},
								{
									provider: "anthropic",
									id: "claude-sonnet-4-6",
									name: "Claude Sonnet 4.6",
									thinkingLevels: ["off", "low", "high"],
								},
								{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
								{
									provider: "openai",
									id: "gpt-5.2-mini",
									name: "GPT-5.2 mini",
								},
							],
						};
					} else if (a.command?.type === "get_state") {
						data = {
							model: {
								provider: "anthropic",
								id: "claude-opus-4-6",
								name: "Claude Opus 4.6",
								thinkingLevels: ["off", "low", "high"],
							},
							thinkingLevel: "high",
						};
					}
					emit("pi://event", {
						chan: a?.chan,
						ev: { type: "response", id: a?.command?.id, success: true, data },
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
