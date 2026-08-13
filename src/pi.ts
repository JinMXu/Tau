import { invoke } from "@tauri-apps/api/core";

export interface PiBinaryInfo {
	bin: string;
	version: string;
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
	kind: "text" | "thinking" | "tool";
	text: string;
	name?: string | null;
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

export function send(command: Record<string, unknown>, id?: string): Promise<unknown> {
	return invoke("pi_send", {
		command: { ...command, id },
	});
}

export async function binaryInfo(): Promise<PiBinaryInfo> {
	return invoke("pi_binary");
}

export async function start(
	workspace: string,
	sessionFile?: string | null,
	opts?: {
		forkOf?: string | null;
		sessionName?: string | null;
		systemPrompt?: string | null;
		/** Tool allowlist; empty array disables all tools, undefined = all tools. */
		tools?: string[] | null;
	},
): Promise<void> {
	await invoke("pi_start", {
		workspace,
		sessionFile,
		forkOf: opts?.forkOf ?? null,
		sessionName: opts?.sessionName ?? null,
		systemPrompt: opts?.systemPrompt ?? null,
		tools: opts?.tools ?? null,
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

export async function stop(): Promise<void> {
	await invoke("pi_stop");
}

export async function newWindow(): Promise<void> {
	await invoke("pi_new_window");
}

export async function status(): Promise<PiStatus> {
	return invoke("pi_status");
}

export async function listSessions(): Promise<PiSessionInfo[]> {
	return invoke("pi_list_sessions");
}

export async function readSession(path: string): Promise<PiParsedMessage[]> {
	return invoke("pi_read_session", { path });
}

export async function searchSessions(
	query: string,
	limit?: number,
): Promise<PiSearchHit[]> {
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

export async function authSetKey(provider: string, key: string): Promise<void> {
	return invoke("pi_auth_set_key", { provider, key });
}

export async function authRemove(provider: string): Promise<void> {
	return invoke("pi_auth_remove", { provider });
}

export async function gitBranchState(project: string): Promise<GitBranchState> {
	return invoke("git_branch_state", { project });
}

export async function gitCheckoutBranch(
	project: string,
	branch: string,
): Promise<GitBranchState> {
	return invoke("git_checkout_branch", { project, branch });
}

export async function gitCreateBranch(
	project: string,
	branch: string,
): Promise<GitBranchState> {
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

export async function piInstalledSkills(
	packages: PiPackageEntry[],
): Promise<PiSkillEntry[]> {
	return invoke("pi_installed_skills", { packages });
}

export async function piMoveSession(
	path: string,
	newProject: string,
): Promise<void> {
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
