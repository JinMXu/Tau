// Tau session host — a drop-in replacement for `pi --mode rpc`, built directly
// on the pi SDK instead of spawning the CLI. Spawned by src-tauri/src/pi.rs
// with the workspace as cwd and configuration passed via env:
//
//   TAU_PI_PKG                abs path to pi-coding-agent/dist/index.js (required)
//   TAU_SESSION_DIR           session directory
//   TAU_SESSION_FILE          open this session file (mutually exclusive with TAU_FORK_OF)
//   TAU_FORK_OF               fork from this session file
//   TAU_SESSION_NAME          optional session name
//   TAU_SYSTEM_PROMPT         optional system prompt override
//   TAU_APPEND_SYSTEM_PROMPT  optional system prompt suffix
//   TAU_TOOLS                 JSON: "null"/unset = defaults, [] = no tools, [...] = allowlist
//   TAU_EXCLUDED_TOOLS        JSON array of tools to exclude
//   TAU_MODELS                comma-separated model patterns (scoped models)
//   TAU_EXTENSION             abs path to tau-extension.mjs
//
// The wire protocol (JSONL on stdin/stdout) is byte-compatible with pi's RPC
// mode; the command handling below is a port of dist/modes/rpc/rpc-mode.js
// with the TUI-only parts removed. Startup mirrors dist/main.js.

import { StringDecoder } from "node:string_decoder";
import * as crypto from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const pkgIndex = process.env.TAU_PI_PKG;
if (!pkgIndex) {
	console.error("[tau-session-host] TAU_PI_PKG is not set");
	process.exit(1);
}
const distDir = dirname(pkgIndex);

// --- stdout takeover ---------------------------------------------------------
// stdout carries only protocol JSON. Anything else (extensions, stray
// console.log) is redirected to stderr, and protocol writes go through a
// serialized write queue so backpressure can be awaited. Same design as pi's
// core/output-guard.js.
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const rawStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, encodingOrCallback, callback) => {
	if (typeof encodingOrCallback === "function") {
		return rawStderrWrite(String(chunk), encodingOrCallback);
	}
	return rawStderrWrite(String(chunk), callback);
};

let writeTail = Promise.resolve();
async function writeChunk(text) {
	while (true) {
		try {
			await new Promise((resolve, reject) => {
				rawStdoutWrite(text, (error) => (error ? reject(error) : resolve()));
			});
			return;
		} catch (error) {
			const code = error?.code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}
function writeRaw(text) {
	if (text.length === 0) return;
	writeTail = writeTail.then(() => writeChunk(text));
	void writeTail.catch(() => process.exit(1));
}
async function waitForBackpressure() {
	while (true) {
		const tail = writeTail;
		await tail;
		if (tail === writeTail) return;
	}
}
async function flushStdout() {
	await waitForBackpressure();
	await writeChunk("");
}

const stderr = (message) => rawStderrWrite(`${message}\n`);

// --- pi SDK + the deep imports startup needs ---------------------------------
const pi = await import(pathToFileURL(pkgIndex));
const { resolveProjectTrusted } = await import(pathToFileURL(join(distDir, "core/project-trust.js")));
const { builtInExtensions } = await import(pathToFileURL(join(distDir, "extensions/index.js")));
const { applyHttpProxySettings, configureHttpDispatcher } = await import(pathToFileURL(join(distDir, "core/http-dispatcher.js")));
const { formatNoModelsAvailableMessage } = await import(pathToFileURL(join(distDir, "core/auth-guidance.js")));
const { runMigrations } = await import(pathToFileURL(join(distDir, "migrations.js")));
const { initTheme, theme } = await import(pathToFileURL(join(distDir, "modes/interactive/theme/theme.js")));
const { killTrackedDetachedChildren } = await import(pathToFileURL(join(distDir, "utils/shell.js")));

// --- startup configuration from env ------------------------------------------
const cwd = process.cwd();
const agentDir = pi.getAgentDir();
const offlineMode = process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";

runMigrations(cwd);

const startupSettingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
// pi >= 0.87 backs `theme` with a Proxy that throws until initTheme() runs;
// extension resource loading (MCP init) reads it, so initialize before any
// session services exist. No file watcher in a headless host.
initTheme(startupSettingsManager.getTheme(), false);
applyHttpProxySettings(startupSettingsManager.getGlobalSettings().httpProxy);
configureHttpDispatcher();

const sessionDir = process.env.TAU_SESSION_DIR || startupSettingsManager.getSessionDir();

let sessionManager;
if (process.env.TAU_FORK_OF) {
	try {
		sessionManager = pi.SessionManager.forkFrom(process.env.TAU_FORK_OF, cwd, sessionDir);
	} catch (error) {
		stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
} else if (process.env.TAU_SESSION_FILE) {
	sessionManager = pi.SessionManager.open(process.env.TAU_SESSION_FILE, sessionDir);
} else {
	sessionManager = pi.SessionManager.create(cwd, sessionDir);
}
if (process.env.TAU_SESSION_NAME && process.env.TAU_SESSION_NAME.trim()) {
	sessionManager.appendSessionInfo(process.env.TAU_SESSION_NAME.trim());
}

// TAU_TOOLS: "null"/unset = pi defaults, [] = --no-tools, [...] = --tools allowlist.
const parsedTools = process.env.TAU_TOOLS ? JSON.parse(process.env.TAU_TOOLS) : null;
const excludedTools = process.env.TAU_EXCLUDED_TOOLS ? JSON.parse(process.env.TAU_EXCLUDED_TOOLS) : [];
const modelPatterns = process.env.TAU_MODELS
	? process.env.TAU_MODELS.split(",").map((p) => p.trim()).filter(Boolean)
	: undefined;
const additionalExtensionPaths = process.env.TAU_EXTENSION ? [process.env.TAU_EXTENSION] : [];
const systemPrompt = process.env.TAU_SYSTEM_PROMPT || undefined;
const appendSystemPrompt = process.env.TAU_APPEND_SYSTEM_PROMPT || undefined;

// --- runtime factory (mirrors main.js createRuntime, minus CLI-only parts) ---
const trustStore = new pi.ProjectTrustStore(agentDir);
const projectTrustByCwd = new Map();

// createProjectTrustContext for a headless RPC host: no UI, notifies go to stderr.
const rpcTrustContext = (trustCwd) => ({
	cwd: trustCwd,
	mode: "rpc",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => stderr(message),
	},
});

const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager: sm, sessionStartEvent, projectTrustContext }) => {
	const diagnostics = [];
	const cachedTrust = projectTrustByCwd.get(runtimeCwd);
	const hasTrustRequiring = pi.hasTrustRequiringProjectResources(runtimeCwd);
	const shouldResolveTrust = cachedTrust === undefined && hasTrustRequiring;
	const projectTrusted = shouldResolveTrust
		? false
		: (cachedTrust ?? (!hasTrustRequiring || trustStore.get(runtimeCwd) === true));
	const settingsManager = pi.SettingsManager.create(runtimeCwd, runtimeAgentDir, { projectTrusted });
	const services = await pi.createAgentSessionServices({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		settingsManager,
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		resourceLoaderReloadOptions: shouldResolveTrust
			? {
				resolveProjectTrust: async ({ extensionsResult }) => {
					const trusted = await resolveProjectTrusted({
						cwd: runtimeCwd,
						trustStore,
						defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
						extensionsResult,
						projectTrustContext: projectTrustContext ?? rpcTrustContext(runtimeCwd),
						onExtensionError: (message) => diagnostics.push({ type: "warning", message }),
					});
					projectTrustByCwd.set(runtimeCwd, trusted);
					return trusted;
				},
			}
			: undefined,
		resourceLoaderOptions: {
			additionalExtensionPaths,
			systemPrompt,
			appendSystemPrompt,
			extensionFactories: [...builtInExtensions],
		},
	});
	diagnostics.push(
		...services.diagnostics,
		...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
			type: "error",
			message: `Failed to load extension "${path}": ${error}`,
		})),
	);

	const patterns = modelPatterns ?? settingsManager.getEnabledModels();
	const scopedModels = patterns && patterns.length > 0
		? (await pi.resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) })).scopedModels
		: [];

	// buildSessionOptions from main.js, reduced to what the env contract carries
	// (no --model/--thinking/--api-key flags): scoped model default + tool sets.
	const sessionOptions = {};
	const hasExistingSession = sm.buildSessionContext().messages.length > 0;
	if (scopedModels.length > 0 && !hasExistingSession) {
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? services.modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel
			? scopedModels.find((sm2) => sm2.model.id === savedModel.id && sm2.model.provider === savedModel.provider)
			: undefined;
		const picked = savedInScope ?? scopedModels[0];
		sessionOptions.model = picked.model;
		if (picked.thinkingLevel) sessionOptions.thinkingLevel = picked.thinkingLevel;
	}
	if (scopedModels.length > 0) {
		sessionOptions.scopedModels = scopedModels.map((sm2) => ({ model: sm2.model, thinkingLevel: sm2.thinkingLevel }));
	}
	if (Array.isArray(parsedTools)) {
		if (parsedTools.length === 0) sessionOptions.noTools = "all";
		else sessionOptions.tools = [...parsedTools];
	}
	if (Array.isArray(excludedTools) && excludedTools.length > 0) {
		sessionOptions.excludeTools = [...excludedTools];
	}

	const created = await pi.createAgentSessionFromServices({
		services,
		sessionManager: sm,
		sessionStartEvent,
		model: sessionOptions.model,
		thinkingLevel: sessionOptions.thinkingLevel,
		scopedModels: sessionOptions.scopedModels,
		tools: sessionOptions.tools,
		excludeTools: sessionOptions.excludeTools,
		noTools: sessionOptions.noTools,
	});
	return { ...created, services, diagnostics };
};

const runtime = await pi.createAgentSessionRuntime(createRuntime, {
	cwd: sessionManager.getCwd(),
	agentDir,
	sessionManager,
});

for (const d of runtime.diagnostics) {
	stderr(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`);
}
if (runtime.diagnostics.some((d) => d.type === "error")) {
	if (runtime.diagnostics.some((d) => d.message.includes("Failed to load extension"))) {
		stderr("Extension load failure — fix or remove the failing extension and restart.");
	}
	process.exit(1);
}
if (!runtime.session.model) {
	stderr(formatNoModelsAvailableMessage());
	process.exit(1);
}

applyHttpProxySettings(runtime.services.settingsManager.getGlobalSettings().httpProxy);
configureHttpDispatcher(runtime.services.settingsManager.getHttpIdleTimeoutMs());

// RPC mode refreshes model catalogs in the background after startup.
if (!offlineMode) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	void runtime.services.modelRuntime.refresh({ signal: controller.signal })
		.catch(() => {})
		.finally(() => clearTimeout(timeout));
}

// --- RPC loop (port of dist/modes/rpc/rpc-mode.js) ----------------------------
let session = runtime.session;
let unsubscribe;
let unsubscribeBackpressure;

const output = (obj) => writeRaw(`${JSON.stringify(obj)}\n`);
const success = (id, command, data) => {
	if (data === undefined) {
		return { id, type: "response", command, success: true };
	}
	return { id, type: "response", command, success: true, data };
};
const error = (id, command, message) => {
	return { id, type: "response", command, success: false, error: message };
};

// message_update events carry a non-serializable `partial` plus tool call
// details that must be flattened — same transform as pi's modes/json-event.js.
function toJsonAssistantMessageEvent(event) {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}
	if (!("partial" in event)) {
		return event;
	}
	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}
function toJsonEvent(event) {
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}
	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}

const pendingExtensionRequests = new Map();
let shutdownRequested = false;
let shuttingDown = false;
const signalCleanupHandlers = [];

function createDialogPromise(opts, defaultValue, request, parseResponse) {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		let timeoutId;
		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			opts?.signal?.removeEventListener("abort", onAbort);
			pendingExtensionRequests.delete(id);
		};
		const onAbort = () => {
			cleanup();
			resolve(defaultValue);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts?.timeout) {
			timeoutId = setTimeout(() => {
				cleanup();
				resolve(defaultValue);
			}, opts.timeout);
		}
		pendingExtensionRequests.set(id, {
			resolve: (response) => {
				cleanup();
				resolve(parseResponse(response));
			},
			reject,
		});
		output({ type: "extension_ui_request", id, ...request });
	});
}

const createExtensionUIContext = () => ({
	select: (title, options, opts) => createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) => "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
	confirm: (title, message, opts) => createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) => "cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
	input: (title, placeholder, opts) => createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) => "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
	notify(message, type) {
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "notify",
			message,
			notifyType: type,
		});
	},
	onTerminalInput() {
		return () => {};
	},
	setStatus(key, text) {
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "setStatus",
			statusKey: key,
			statusText: text,
		});
	},
	setWorkingMessage(_message) {},
	setWorkingVisible(_visible) {},
	setWorkingIndicator(_options) {},
	setHiddenThinkingLabel(_label) {},
	setWidget(key, content, options) {
		if (content === undefined || Array.isArray(content)) {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWidget",
				widgetKey: key,
				widgetLines: content,
				widgetPlacement: options?.placement,
			});
		}
	},
	setFooter(_factory) {},
	setHeader(_factory) {},
	setTitle(title) {
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "setTitle",
			title,
		});
	},
	async custom() {
		return undefined;
	},
	pasteToEditor(text) {
		this.setEditorText(text);
	},
	setEditorText(text) {
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "set_editor_text",
			text,
		});
	},
	getEditorText() {
		return "";
	},
	async editor(title, prefill) {
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			pendingExtensionRequests.set(id, {
				resolve: (response) => {
					if ("cancelled" in response && response.cancelled) {
						resolve(undefined);
					} else if ("value" in response) {
						resolve(response.value);
					} else {
						resolve(undefined);
					}
				},
				reject,
			});
			output({ type: "extension_ui_request", id, method: "editor", title, prefill });
		});
	},
	addAutocompleteProvider() {},
	setEditorComponent() {},
	getEditorComponent() {
		return undefined;
	},
	get theme() {
		return theme;
	},
	getAllThemes() {
		return [];
	},
	getTheme(_name) {
		return undefined;
	},
	setTheme(_theme) {
		return { success: false, error: "Theme switching not supported in RPC mode" };
	},
	getToolsExpanded() {
		return false;
	},
	setToolsExpanded(_expanded) {},
});

runtime.setRebindSession(async () => {
	await rebindSession();
});
const rebindSession = async () => {
	session = runtime.session;
	await session.bindExtensions({
		uiContext: createExtensionUIContext(),
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async (options) => runtime.newSession(options),
			fork: async (entryId, forkOptions) => {
				const result = await runtime.fork(entryId, forkOptions);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => {
				return runtime.switchSession(sessionPath, options);
			},
			reload: async () => {
				await session.reload();
			},
		},
		shutdownHandler: () => {
			shutdownRequested = true;
		},
		onError: (err) => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
	});
	unsubscribe?.();
	unsubscribeBackpressure?.();
	unsubscribe = session.subscribe((event) => {
		output(toJsonEvent(event));
		if (event.type === "agent_settled") {
			void checkShutdownRequested();
		}
	});
	unsubscribeBackpressure = session.agent.subscribe(async () => {
		await waitForBackpressure();
	});
};

const registerSignalHandlers = () => {
	const signals = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	for (const signal of signals) {
		const handler = () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}
};

const handleCommand = async (command) => {
	const id = command.id;
	switch (command.type) {
		case "prompt": {
			let preflightSucceeded = false;
			void session
				.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							preflightSucceeded = true;
							output(success(id, "prompt"));
						}
					},
				})
				.catch((e) => {
					if (!preflightSucceeded) {
						output(error(id, "prompt", e.message));
					}
				});
			return undefined;
		}
		case "steer": {
			await session.steer(command.message, command.images);
			return success(id, "steer");
		}
		case "follow_up": {
			await session.followUp(command.message, command.images);
			return success(id, "follow_up");
		}
		case "abort": {
			await session.abort();
			return success(id, "abort");
		}
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const result = await runtime.newSession(options);
			if (!result.cancelled) {
				await rebindSession();
			}
			return success(id, "new_session", result);
		}
		case "get_state": {
			const state = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.isStreaming,
				isCompacting: session.isCompacting,
				steeringMode: session.steeringMode,
				followUpMode: session.followUpMode,
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				autoCompactionEnabled: session.autoCompactionEnabled,
				messageCount: session.messages.length,
				pendingMessageCount: session.pendingMessageCount,
			};
			return success(id, "get_state", state);
		}
		case "set_model": {
			const models = session.modelRuntime.getAvailableSnapshot();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await session.setModel(model);
			return success(id, "set_model", model);
		}
		case "cycle_model": {
			const result = await session.cycleModel();
			if (!result) {
				return success(id, "cycle_model", null);
			}
			return success(id, "cycle_model", result);
		}
		case "get_available_models": {
			const models = session.modelRuntime.getAvailableSnapshot();
			return success(id, "get_available_models", { models });
		}
		case "set_thinking_level": {
			session.setThinkingLevel(command.level);
			return success(id, "set_thinking_level");
		}
		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			if (!level) {
				return success(id, "cycle_thinking_level", null);
			}
			return success(id, "cycle_thinking_level", { level });
		}
		case "get_available_thinking_levels": {
			const levels = session.getAvailableThinkingLevels();
			return success(id, "get_available_thinking_levels", { levels });
		}
		case "set_steering_mode": {
			session.setSteeringMode(command.mode);
			return success(id, "set_steering_mode");
		}
		case "set_follow_up_mode": {
			session.setFollowUpMode(command.mode);
			return success(id, "set_follow_up_mode");
		}
		case "compact": {
			const result = await session.compact(command.customInstructions);
			return success(id, "compact", result);
		}
		case "set_auto_compaction": {
			session.setAutoCompactionEnabled(command.enabled);
			return success(id, "set_auto_compaction");
		}
		case "set_auto_retry": {
			session.setAutoRetryEnabled(command.enabled);
			return success(id, "set_auto_retry");
		}
		case "abort_retry": {
			session.abortRetry();
			return success(id, "abort_retry");
		}
		case "bash": {
			const eventResult = await session.extensionRunner.emitUserBash({
				type: "user_bash",
				command: command.command,
				excludeFromContext: command.excludeFromContext ?? false,
				cwd: session.sessionManager.getCwd(),
			});
			if (eventResult?.result) {
				session.recordBashResult(command.command, eventResult.result, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "bash", eventResult.result);
			}
			const result = await session.executeBash(command.command, undefined, {
				excludeFromContext: command.excludeFromContext,
				id,
				operations: eventResult?.operations,
			});
			return success(id, "bash", result);
		}
		case "abort_bash": {
			session.abortBash();
			return success(id, "abort_bash");
		}
		case "get_session_stats": {
			const stats = session.getSessionStats();
			return success(id, "get_session_stats", stats);
		}
		case "export_html": {
			const path = await session.exportToHtml(command.outputPath);
			return success(id, "export_html", { path });
		}
		case "switch_session": {
			const result = await runtime.switchSession(command.sessionPath);
			if (!result.cancelled) {
				await rebindSession();
			}
			return success(id, "switch_session", result);
		}
		case "fork": {
			const result = await runtime.fork(command.entryId);
			if (!result.cancelled) {
				await rebindSession();
			}
			return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
		}
		case "clone": {
			const leafId = session.sessionManager.getLeafId();
			if (!leafId) {
				return error(id, "clone", "Cannot clone session: no current entry selected");
			}
			const result = await runtime.fork(leafId, { position: "at" });
			if (!result.cancelled) {
				await rebindSession();
			}
			return success(id, "clone", { cancelled: result.cancelled });
		}
		case "get_fork_messages": {
			const messages = session.getUserMessagesForForking();
			return success(id, "get_fork_messages", { messages });
		}
		case "get_entries": {
			const sm = session.sessionManager;
			let entries = sm.getEntries();
			if (command.since !== undefined) {
				const sinceIndex = entries.findIndex((e) => e.id === command.since);
				if (sinceIndex === -1) {
					return error(id, "get_entries", `Entry not found: ${command.since}`);
				}
				entries = entries.slice(sinceIndex + 1);
			}
			return success(id, "get_entries", { entries, leafId: sm.getLeafId() });
		}
		case "get_tree": {
			const sm = session.sessionManager;
			return success(id, "get_tree", { tree: sm.getTree(), leafId: sm.getLeafId() });
		}
		case "get_last_assistant_text": {
			const text = session.getLastAssistantText();
			return success(id, "get_last_assistant_text", { text });
		}
		case "set_session_name": {
			const name = command.name.trim();
			if (!name) {
				return error(id, "set_session_name", "Session name cannot be empty");
			}
			session.setSessionName(name);
			return success(id, "set_session_name");
		}
		case "get_messages": {
			return success(id, "get_messages", { messages: session.messages });
		}
		case "get_commands": {
			const commands = [];
			for (const cmd of session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
					sourceInfo: cmd.sourceInfo,
				});
			}
			for (const template of session.promptTemplates) {
				commands.push({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}
			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}
			return success(id, "get_commands", { commands });
		}
		default: {
			return error(id, command.type, `Unknown command: ${command.type}`);
		}
	}
};

let detachInput = () => {};
async function shutdown(exitCode = 0, signal) {
	if (shuttingDown) {
		process.exit(exitCode);
	}
	shuttingDown = true;
	for (const cleanup of signalCleanupHandlers) {
		cleanup();
	}
	unsubscribe?.();
	unsubscribeBackpressure?.();
	await runtime.dispose();
	detachInput();
	process.stdin.pause();
	if (signal !== "SIGTERM") {
		await flushStdout();
	}
	process.exit(exitCode);
}
async function checkShutdownRequested() {
	if (!shutdownRequested) return;
	await shutdown();
}

const handleInputLine = async (line) => {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (parseError) {
		output(error(undefined, "parse", `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
		await waitForBackpressure();
		return;
	}
	if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "extension_ui_response") {
		const pending = pendingExtensionRequests.get(parsed.id);
		if (pending) {
			pendingExtensionRequests.delete(parsed.id);
			pending.resolve(parsed);
		}
		return;
	}
	try {
		const response = await handleCommand(parsed);
		if (response) {
			output(response);
			await waitForBackpressure();
		}
		await checkShutdownRequested();
	} catch (commandError) {
		// Optional chaining: a bare `null` line makes handleCommand throw, and
		// dereferencing `parsed.id` here threw a SECOND time — escaping as an
		// unhandledRejection whose process-level handler exits(1), killing the
		// session over one malformed line. Answer with an id-less error like
		// every other malformed shape and keep serving.
		output(error(parsed?.id, parsed?.type, commandError instanceof Error ? commandError.message : String(commandError)));
		await waitForBackpressure();
	}
};

// LF-only JSONL framing (not readline — readline also splits on U+2028/U+2029,
// which are legal inside JSON strings). Same as pi's modes/rpc/jsonl.js.
await rebindSession();
registerSignalHandlers();
const onInputEnd = () => {
	void shutdown();
};
process.stdin.on("end", onInputEnd);
{
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const onData = (chunk) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			void handleInputLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			void handleInputLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
			buffer = "";
		}
	};
	process.stdin.on("data", onData);
	process.stdin.on("end", onEnd);
	detachInput = () => {
		process.stdin.off("data", onData);
		process.stdin.off("end", onEnd);
		process.stdin.off("end", onInputEnd);
	};
}

process.on("uncaughtException", (err) => {
	stderr(`[tau-session-host] uncaughtException: ${err?.stack ?? err}`);
	process.exit(1);
});
process.on("unhandledRejection", (reason) => {
	stderr(`[tau-session-host] unhandledRejection: ${reason?.stack ?? reason}`);
	process.exit(1);
});
