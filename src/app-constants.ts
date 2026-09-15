/**
 * App-wide constants lifted out of App.tsx.
 *
 * They were module-level values buried between the imports and the component,
 * which made them easy to miss and impossible to reuse from anywhere else.
 */

/** localStorage keys for UI state that outlives a restart. */
export const STORAGE_KEYS = {
	expanded: "pi-gui.sidebar.expanded.v1",
	width: "pi-gui.sidebar.width.v1",
	diffWidth: "pi-gui.diff.width.v1",
	collapsed: "pi-gui.sidebar.collapsed.v1",
	model: "pi-gui.model.v1",
	thinking: "pi-gui.thinking.v1",
	sendMode: "pi-gui.sendMode.v1",
	workspace: "pi-gui.workspace.v1",
	recentWorkspaces: "pi-gui.recentWorkspaces.v1",
	sessionOrder: "pi-gui.sessionOrder.v1",
	lastSession: "pi-gui.lastSession.v1",
	pinned: "pi-gui.pinnedSessions.v1",
} as const;

/**
 * Per-command RPC response timeouts (ms). Provider/model/command discovery
 * can take tens of seconds and compaction can take minutes, while lightweight
 * state reads should fail fast instead of wedging the UI on a stuck pipe.
 * Anything not listed falls back to the default in the caller.
 */
export const RESPONSE_TIMEOUTS: Record<string, number> = {
	get_available_models: 90000,
	get_available_thinking_levels: 90000,
	get_commands: 90000,
	compact: 300000,
	bash: 600000,
	get_messages: 30000,
	switch_session: 30000,
	fork: 30000,
	clone: 30000,
	new_session: 30000,
	get_tree: 90000,
	get_state: 15000,
	get_session_stats: 15000,
	set_model: 15000,
	set_thinking_level: 15000,
	set_session_name: 15000,
	set_auto_retry: 15000,
};
