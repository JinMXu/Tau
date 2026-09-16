import { invoke } from "@tauri-apps/api/core";

export interface PiBinaryInfo {
	bin: string;
	version: string;
	/** True when pi comes from the runtime vendored into the installer. */
	builtin?: boolean;
}

export interface PiSessionInfo {
	path: string;
	name: string;
	project: string | null;
	title: string;
	model: string | null;
	createdAt: number | null;
	messageCount: number;
	mtimeMs: number;
	size: number;
	/** True for optimistic sidebar entries whose session file isn't on disk yet. */
	pending?: boolean;
}

export interface PiParsedBlock {
	kind: "text" | "thinking" | "tool" | "image";
	text: string;
	name?: string | null;
	/** Present when kind === "image" (session file image content). */
	image?: { mimeType: string; data: string } | null;
}

export interface PiParsedMessage {
	role: string;
	timestamp: string | null;
	entryId?: string | null;
	blocks: PiParsedBlock[];
}

export interface PiArchivedSession {
	path: string;
	originalPath: string;
	title: string;
	project: string | null;
	mtimeMs: number;
	size: number;
}

export interface PiSearchHit {
	path: string;
	title: string;
	project: string | null;
	snippet: string;
	updatedAt: number;
}

export interface PiStatus {
	running: boolean;
	workspace: string | null;
	sessionFile: string | null;
}

export interface AuthProviderStatus {
	provider: string;
	hasKey: boolean;
	kind: string;
}

export interface PiProviderInfo {
	id: string;
	known: boolean;
	/** True when pi-ai ships an OAuth login flow for this provider. */
	oauth: boolean;
}

export interface GitBranchState {
	isRepository: boolean;
	branches: string[];
	currentBranch: string | null;
	dirtyFileCount: number;
}

export interface PiPackageEntry {
	source: string;
	packageName: string | null;
	scope: string;
	installedPath: string | null;
}

export interface PiSkillEntry {
	name: string;
	description: string | null;
	location: string;
}

/** A slash command available via `prompt "/name …"` (pi `get_commands`). */
export interface PiCommand {
	name: string;
	description?: string | null;
	source: "extension" | "prompt" | "skill";
	location?: string | null;
	path?: string | null;
}

/** One LLM usage record from a session file (per assistant message). */
export interface PiUsageEntry {
	date: string;
	provider: string;
	model: string;
	project: string | null;
	sessionPath: string;
	input: number;
	output: number;
	cacheRead: number;
	reasoning: number;
	total: number;
	cost: number;
	/** Message timestamp (epoch ms); used for per-session chat durations. */
	ts: number;
}

export interface AssistantMessageEvent {
	type: "message_update";
	assistantMessageEvent: {
		type: string;
		contentIndex?: number;
		delta?: string;
		content?: string;
		message?: unknown;
		reason?: string;
		error?: unknown;
		[field: string]: unknown;
	};
}

export interface PiEvent {
	id?: string | null;
	type: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
	assistantMessageEvent?: AssistantMessageEvent["assistantMessageEvent"];
	[field: string]: unknown;
}

/**
 * Send an RPC command to the session channel identified by `chan`.
 * Each concurrent session runs on its own channel; omitting `chan` targets
 * the window's only live channel (compat fallback).
 */
export function send(
	command: Record<string, unknown>,
	id?: string,
	chan?: string | null,
): Promise<unknown> {
	return invoke("pi_send", {
		command: { ...command, id },
		chan: chan ?? null,
	});
}

/** Live status of one step in a pi-subagents run (from its status.json). */
export interface SubagentStep {
	label: string;
	agent: string;
	status: string;
	model: string | null;
	turnCount: number;
	toolCount: number;
	lastTool: string | null;
	lastToolArgs: string | null;
}

/** A live (non-terminal) subagent run belonging to the current session. */
export interface SubagentRun {
	runId: string;
	mode: string;
	state: string;
	startedAt: number | null;
	steps: SubagentStep[];
}

export function fetchSubagentRuns(session: string): Promise<SubagentRun[]> {
	return invoke("pi_subagent_runs", { session });
}

/** SDK sidecar ping: vendored node + pi SDK versions + agent dir. */
export async function sidecarPing(): Promise<{
	pi: string;
	node: string;
	agentDir: string;
}> {
	return invoke("sidecar_ping");
}

export async function binaryInfo(): Promise<PiBinaryInfo> {
	return invoke("pi_binary");
}

/**
 * Start (or replace) the pi process for one session channel. Multiple
 * channels per window can run concurrently; `chan` identifies the session
 * slot (an arbitrary frontend-generated id).
 */
export async function start(
	workspace: string,
	sessionFile?: string | null,
	opts?: {
		forkOf?: string | null;
		sessionName?: string | null;
		systemPrompt?: string | null;
		/** Tool allowlist; empty array disables all tools, undefined = all tools. */
		tools?: string[] | null;
		/** Tool exclude list (--exclude-tools); undefined = none excluded. */
		excludedTools?: string[] | null;
		/** Appended to the system prompt without replacing it. */
		appendSystemPrompt?: string | null;
		/** Model patterns for Ctrl+P cycling (--models flag, scoped models). */
		models?: string | null;
	},
	chan?: string,
): Promise<void> {
	await invoke("pi_start", {
		workspace,
		sessionFile,
		forkOf: opts?.forkOf ?? null,
		sessionName: opts?.sessionName ?? null,
		systemPrompt: opts?.systemPrompt ?? null,
		tools: opts?.tools ?? null,
		excludedTools: opts?.excludedTools ?? null,
		appendSystemPrompt: opts?.appendSystemPrompt ?? null,
		models: opts?.models ?? null,
		chan: chan ?? null,
	});
}

export async function exportChat(
	sessionPath: string,
	markdown: string | null,
	format: "markdown" | "jsonl",
): Promise<{ ok: boolean; canceled?: boolean; error?: string; path?: string }> {
	return invoke("pi_export_chat", {
		sessionPath,
		markdown,
		format,
	});
}

export async function exportHtml(
	sessionPath: string,
): Promise<{ ok: boolean; canceled?: boolean; error?: string; path?: string }> {
	return invoke("pi_export_html", { sessionPath });
}

export async function exportDiagnostics(): Promise<{
	ok: boolean;
	canceled?: boolean;
	error?: string;
	path?: string;
}> {
	return invoke("export_diagnostics");
}

/**
 * One update check result: the latest GitHub release vs the running app.
 * `available` is true only when the release tag is strictly newer than the
 * running version (pre-releases sort below their release).
 */
export interface UpdateInfo {
	/** Unix ms when the result was produced by an actual network check. */
	checkedAtMs: number;
	/** Running app version (from the Rust package info). */
	current: string;
	/** Latest release tag, e.g. "v0.2.0". */
	latest: string;
	available: boolean;
	/** Release page URL; empty when the API payload lacked it. */
	url: string;
	/** Release notes (markdown), possibly empty. */
	notes: string;
	publishedAt: string | null;
	/** True when served from the on-disk cache instead of a live request. */
	fromCache: boolean;
}

/**
 * Ask the backend for the latest release. `force` (manual checks from
 * Settings) bypasses the 12h cache; automatic checks reuse it.
 */
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
	return invoke("update_check", { force });
}

/** Stop one session channel; omit `chan` to stop every channel of the window. */
export async function stop(chan?: string | null): Promise<void> {
	await invoke("pi_stop", { chan: chan ?? null });
}

export async function newWindow(): Promise<void> {
	await invoke("pi_new_window");
}

/**
 * Live status. With `chan`: that channel's status. Without: whether any
 * channel of the window is running (aggregate, used by the startup probe).
 */
export async function status(chan?: string | null): Promise<PiStatus> {
	return invoke("pi_status", { chan: chan ?? null });
}

export async function listSessions(): Promise<PiSessionInfo[]> {
	return invoke("pi_list_sessions");
}

export async function readSession(path: string): Promise<PiParsedMessage[]> {
	return invoke("pi_read_session", { path });
}
/** 分叉会话到指定条目（含该条目）；entryId 省略时取当前分支末尾（最后一条 assistant）。 */
export async function forkSessionAt(
	path: string,
	entryId?: string | null,
): Promise<{ sessionFile: string }> {
	return invoke("pi_fork_session", { path, entryId: entryId ?? null });
}

export async function searchSessions(query: string, limit?: number): Promise<PiSearchHit[]> {
	return invoke("pi_search_sessions", { query, limit });
}

export async function archiveSession(path: string): Promise<void> {
	return invoke("pi_archive_session", { path });
}

export async function deleteSession(path: string): Promise<void> {
	return invoke("pi_delete_session", { path });
}

export async function listArchivedSessions(): Promise<PiArchivedSession[]> {
	return invoke("pi_list_archived_sessions");
}

export async function restoreSession(path: string): Promise<void> {
	return invoke("pi_restore_session", { path });
}

export async function purgeSession(path: string): Promise<void> {
	return invoke("pi_purge_session", { path });
}

export async function revealSession(path: string): Promise<void> {
	return invoke("pi_reveal_session", { path });
}

export async function openWorkspace(): Promise<string | null> {
	return invoke("pi_open_workspace");
}

export async function authStatus(): Promise<AuthProviderStatus[]> {
	return invoke("pi_auth_status");
}

export async function piProviders(): Promise<PiProviderInfo[]> {
	return invoke("pi_providers");
}

/** One model of a provider: catalog entry overlaid with models.json data. */
export interface PiProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	/** True when the model's `input` list contains "image". */
	image: boolean;
	contextWindow: number;
	maxTokens: number;
	/** From the models.json `models` array (user-defined), not the catalog. */
	custom: boolean;
	/** A `modelOverrides` patch exists for this model id. */
	overridden: boolean;
}

/** models.json model payload (`ModelsJsonModel`); only set fields are written. */
export interface PiProviderModelUpsert {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** models.json `modelOverrides` patch; an empty patch removes the override. */
export interface PiProviderModelPatch {
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

export async function piProviderModels(provider: string): Promise<PiProviderModel[]> {
	return invoke("pi_provider_models", { provider });
}

export async function piProviderModelUpsert(
	provider: string,
	model: PiProviderModelUpsert,
): Promise<void> {
	return invoke("pi_provider_model_upsert", { provider, model });
}

export async function piProviderModelRemove(provider: string, modelId: string): Promise<void> {
	return invoke("pi_provider_model_remove", { provider, modelId });
}

export async function piProviderModelOverrideUpsert(
	provider: string,
	modelId: string,
	patch: PiProviderModelPatch,
): Promise<void> {
	return invoke("pi_provider_model_override_upsert", { provider, modelId, patch });
}

export async function piProviderModelOverrideRemove(
	provider: string,
	modelId: string,
): Promise<void> {
	return invoke("pi_provider_model_override_remove", { provider, modelId });
}

/** One notification emitted by a running OAuth flow (sidecar oauth.status). */
export interface OAuthFlowEvent {
	type: "auth_url" | "device_code" | "progress" | "info";
	url?: string | null;
	userCode?: string | null;
	verificationUri?: string | null;
	message?: string | null;
	links?: { label?: string | null; url: string }[] | null;
}

/** An interactive prompt the OAuth flow is waiting on. */
export interface OAuthFlowPrompt {
	message: string;
	kind: "text" | "secret" | "select" | "manual_code";
	options?: { id: string; label?: string | null }[] | null;
	placeholder?: string | null;
}

export interface OAuthFlowStatus {
	phase: "running" | "awaiting_prompt" | "done" | "error" | "cancelled";
	event: OAuthFlowEvent | null;
	prompt: OAuthFlowPrompt | null;
	error: string | null;
}

export async function oauthBegin(providerId: string): Promise<string> {
	// Contract returns a bare flowId string; tolerate the sidecar's { flowId }
	// object shape too.
	const r = await invoke<string | { flowId: string }>("oauth_begin", { providerId });
	return typeof r === "string" ? r : r.flowId;
}

export async function oauthStatus(flowId: string): Promise<OAuthFlowStatus> {
	return invoke("oauth_status", { flowId });
}

export async function oauthPromptResponse(flowId: string, value: string): Promise<void> {
	return invoke("oauth_prompt_response", { flowId, value });
}

export async function oauthCancel(flowId: string): Promise<void> {
	return invoke("oauth_cancel", { flowId });
}

/** A custom provider entry from models.json (`providers` map). */
export interface CustomProviderEntry {
	id: string;
	/** Raw provider config JSON; edit known fields, pass the rest through. */
	config: Record<string, unknown>;
}

export async function piCustomProviders(): Promise<CustomProviderEntry[]> {
	return invoke("pi_custom_providers");
}

export async function piUpsertCustomProvider(
	id: string,
	config: Record<string, unknown>,
): Promise<void> {
	return invoke("pi_upsert_custom_provider", { id, config });
}

export async function piRemoveCustomProvider(id: string): Promise<void> {
	return invoke("pi_remove_custom_provider", { id });
}

/** Which config layer defines an MCP server (adapter precedence, low → high). */
export type McpServerSource =
	| "shared-global"
	| "agents-global"
	| "agents-nested-global"
	| "pi-global"
	| "shared-project"
	| "pi-project";

/** One MCP server merged across all pi-mcp-adapter config layers. */
export interface McpServerEntry {
	name: string;
	/** Effective per-field merged config (command/args/env or url/headers…). */
	config: Record<string, unknown>;
	disabled: boolean;
	/** Highest-precedence layer defining this server. */
	source: McpServerSource;
	/** Absolute path of that source file. */
	sourcePath: string;
	/** True when the GUI can edit/delete the entry in place. */
	editable: boolean;
	transport: "stdio" | "http" | "socket";
}

export async function piMcpServers(project: string | null): Promise<McpServerEntry[]> {
	return invoke("pi_mcp_servers", { project });
}

export async function piMcpUpsertServer(
	scope: "global" | "project",
	project: string | null,
	name: string,
	config: Record<string, unknown>,
): Promise<void> {
	return invoke("pi_mcp_upsert_server", { scope, project, name, config });
}

export async function piMcpRemoveServer(
	scope: "global" | "project",
	project: string | null,
	name: string,
): Promise<void> {
	return invoke("pi_mcp_remove_server", { scope, project, name });
}

export async function piMcpSetDisabled(
	name: string,
	disabled: boolean,
	project: string | null,
): Promise<void> {
	return invoke("pi_mcp_set_disabled", { name, disabled, project });
}

export async function authSetKey(provider: string, key: string): Promise<void> {
	return invoke("pi_auth_set_key", { provider, key });
}

export async function authRemove(provider: string): Promise<void> {
	return invoke("pi_auth_remove", { provider });
}

export async function gitBranchState(project: string): Promise<GitBranchState> {
	return invoke("git_branch_state", { project });
}

export async function gitCheckoutBranch(project: string, branch: string): Promise<GitBranchState> {
	return invoke("git_checkout_branch", { project, branch });
}

export async function gitCreateBranch(project: string, branch: string): Promise<GitBranchState> {
	return invoke("git_create_branch", { project, branch });
}

export async function piPackages(): Promise<PiPackageEntry[]> {
	return invoke("pi_packages");
}

export async function piPackageInstall(source: string): Promise<void> {
	return invoke("pi_package_install", { source });
}

export async function piPackageRemove(source: string): Promise<void> {
	return invoke("pi_package_remove", { source });
}

export async function piInstalledSkills(packages: PiPackageEntry[]): Promise<PiSkillEntry[]> {
	return invoke("pi_installed_skills", { packages });
}

export async function piMoveSession(path: string, newProject: string): Promise<void> {
	return invoke("pi_move_session", { path, newProject });
}

export async function usageStats(): Promise<PiUsageEntry[]> {
	return invoke("pi_usage_stats");
}

export async function compactSessionImages(
	path: string,
): Promise<{ ok: boolean; removed: number; before: number; after: number }> {
	return invoke("pi_compact_session_images", { path });
}

/** List project files (relative paths, dirs end with "/") for `@` completion. */
export async function projectFiles(project: string): Promise<string[]> {
	return invoke("pi_project_files", { project });
}

/** Pick an external JSONL session and import it into the sessions directory. */
export async function importSession(): Promise<string | null> {
	return invoke("pi_import_session");
}

/** Share the session as a private GitHub gist (needs `gh` CLI). Returns URL. */
export async function shareSession(sessionPath: string): Promise<string> {
	return invoke("pi_share_session", { sessionPath });
}

/** Build a slim session tree straight from the JSONL (get_tree fallback). */
export async function readTree(sessionPath: string): Promise<unknown> {
	return invoke("pi_read_tree", { path: sessionPath });
}

/** Open the draft in the system editor; returns the edited text. */
export async function externalEdit(text: string): Promise<string> {
	return invoke("pi_external_edit", { text });
}

/** Nearest saved trust decision for a project (true=trust, false=deny). */
export async function trustGet(project: string): Promise<boolean | null> {
	return invoke("pi_trust_get", { project });
}

/** Save/clear a project trust decision (null clears). */
export async function trustSet(project: string, decision: boolean | null): Promise<void> {
	return invoke("pi_trust_set", { project, decision });
}

/** Global fallback trust mode: "ask" | "always" | "never". */
export async function trustDefaultGet(): Promise<string> {
	return invoke("pi_trust_default_get");
}

export async function trustDefaultSet(value: string): Promise<void> {
	return invoke("pi_trust_default_set", { value });
}

/** Loaded model ids from the llama.cpp router (GET /v1/models). */
export async function llamaModels(url: string, apiKey: string): Promise<string[]> {
	return invoke("pi_llama_models", { url, apiKey });
}

export async function llamaLoad(url: string, apiKey: string, name: string): Promise<void> {
	return invoke("pi_llama_load", { url, apiKey, name });
}

export async function llamaUnload(url: string, apiKey: string, name: string): Promise<void> {
	return invoke("pi_llama_unload", { url, apiKey, name });
}
