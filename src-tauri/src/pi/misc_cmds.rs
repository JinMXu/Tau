use super::session_store::{canonical_or, home_dir};
use super::util::{
	no_console_window, run_blocking, system_command, unique_suffix, unix_ms, write_private,
};

use std::{
	path::{Path, PathBuf},
	process::{Child, Command},
	thread,
	time::Duration,
};

use serde::Serialize;
use tauri::AppHandle;

/// Open a DIRECTORY in the system file manager (project folders, the sessions
/// directory). The frontend's `opener` capability is URL-only (https/mailto),
/// so folder reveals go through here instead of `open_path` — one less
/// arbitrary-file-open primitive exposed to the webview.
#[tauri::command]
pub fn pi_reveal_dir(path: String) -> Result<(), String> {
	// Webview-driven and deliberately not contained to a root: the whole point
	// is to reveal a directory the USER picked (a workspace can live anywhere),
	// and the capability granted to a compromised renderer is "open Explorer
	// on a folder" — no file contents are read. Same trust boundary as
	// pi_project_files below; the CSP is the primary control.
	let p = PathBuf::from(&path);
	if !p.is_dir() {
		return Err(format!("not a directory: {path}"));
	}
	#[cfg(target_os = "windows")]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x08000000;
		let _ = system_command("explorer")
			.arg(&p)
			.creation_flags(CREATE_NO_WINDOW)
			.spawn();
		Ok(())
	}
	#[cfg(target_os = "macos")]
	{
		let _ = system_command("open").arg(&p).spawn();
		Ok(())
	}
	#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
	{
		let _ = system_command("xdg-open").arg(&p).spawn();
		Ok(())
	}
}

/// List files under a project for `@` file-reference completion. Skips heavy
/// generated directories (node_modules, .git, target, dist, …) and caps the
/// walk so the picker stays fast even in huge repos. Returns relative paths
/// with forward slashes; directories end with "/".
pub const SKIP_DIRS: &[&str] = &[
	"node_modules",
	".git",
	".hg",
	".svn",
	"target",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".idea",
	".DS_Store",
	".turbo",
	".esbuild",
	"coverage",
	".parcel-cache",
	".yarn",
	".pnpm-store",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".terraform",
	".gradle",
	"vendor",
];
pub const MAX_PROJECT_FILES: usize = 8000;

#[tauri::command]
pub async fn pi_project_files(project: String) -> Result<Vec<String>, String> {
	// Webview-driven and deliberately not contained to a root: it lists the
	// names of a directory the USER picked as a workspace (the file tree
	// panel). The worst a compromised renderer gains is an existence oracle
	// over an arbitrary directory — no file contents are read, and the same
	// information is one folder-picker away for the user anyway. Trust
	// boundary documented rather than fenced: there is no root to fence to.
	run_blocking(move || {
		let root = PathBuf::from(&project);
		if !root.is_dir() {
			return Err(format!("not a directory: {project}"));
		}
		let mut out = Vec::new();
		let mut stack = vec![(root.clone(), String::new())];
		while let Some((dir, prefix)) = stack.pop() {
			let Ok(entries) = std::fs::read_dir(&dir) else {
				continue;
			};
			for entry in entries.flatten() {
				if out.len() >= MAX_PROJECT_FILES {
					break;
				}
				let name = entry.file_name().to_string_lossy().into_owned();
				if SKIP_DIRS.contains(&name.as_str()) {
					continue;
				}
				let rel = if prefix.is_empty() {
					name.clone()
				} else {
					format!("{prefix}/{name}")
				};
				let Ok(ft) = entry.file_type() else { continue };
				if ft.is_dir() {
					out.push(format!("{rel}/"));
					stack.push((entry.path(), rel));
				} else if ft.is_file() {
					out.push(rel);
				}
			}
		}
		// Files before directories, then lexicographic.
		out.sort_by(|a, b| {
			let ad = a.ends_with('/');
			let bd = b.ends_with('/');
			if ad != bd {
				ad.cmp(&bd) // dirs last
			} else {
				a.cmp(b)
			}
		});
		Ok(out)
	})
	.await
}

/// One step of a subagent run, as shown in the chat's live panel.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStepInfo {
	pub label: String,
	pub agent: String,
	pub status: String,
	pub model: Option<String>,
	pub turn_count: u64,
	pub tool_count: u64,
	/// Most recent finished tool call — the "what is it doing" line.
	pub last_tool: Option<String>,
	pub last_tool_args: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunInfo {
	pub run_id: String,
	pub mode: String,
	pub state: String,
	pub started_at: Option<u64>,
	pub steps: Vec<SubagentStepInfo>,
}

/// The pi-subagents extension keeps live run state under
/// `%TEMP%/pi-subagents*/async-subagent-runs/<run-id>/status.json`. The
/// extension dir suffix carries the OS user when several share a machine,
/// so match the prefix instead of an exact name.
pub fn subagent_run_dirs() -> Vec<PathBuf> {
	let mut out = Vec::new();
	let Ok(temp_entries) = std::fs::read_dir(std::env::temp_dir()) else {
		return out;
	};
	for entry in temp_entries.flatten() {
		if !entry
			.file_name()
			.to_string_lossy()
			.starts_with("pi-subagents")
		{
			continue;
		}
		let Ok(run_entries) = std::fs::read_dir(entry.path().join("async-subagent-runs")) else {
			continue;
		};
		for run in run_entries.flatten() {
			if run.path().join("status.json").is_file() {
				out.push(run.path());
			}
		}
	}
	out
}

/// Terminal states of a run; anything else counts as active.
pub fn subagent_run_terminal(state: &str) -> bool {
	matches!(
		state,
		"complete"
			| "completed"
			| "failed"
			| "error" | "cancelled"
			| "canceled"
			| "timeout"
			| "aborted"
	)
}

/// Parse a status.json into a run summary. Returns None for runs belonging
/// to another session, terminal runs, and stale "active" runs: a crashed
/// extension leaves status.json behind mid-state, and without the freshness
/// check the panel would show a dead run forever.
pub fn parse_subagent_status(
	v: &serde_json::Value,
	session_lower: &str,
	now_ms: u64,
) -> Option<SubagentRunInfo> {
	let sid = v.get("sessionId").and_then(|x| x.as_str())?;
	if canonical_or(Path::new(sid))
		.to_string_lossy()
		.to_lowercase()
		!= session_lower
	{
		return None;
	}
	let state = v
		.get("state")
		.and_then(|x| x.as_str())
		.unwrap_or("")
		.to_string();
	if subagent_run_terminal(&state) {
		return None;
	}
	let last_update = v.get("lastUpdate").and_then(|x| x.as_u64());
	if now_ms.saturating_sub(last_update.unwrap_or(0)) > 15 * 60 * 1000 {
		return None;
	}
	let steps = v
		.get("steps")
		.and_then(|x| x.as_array())
		.map(|arr| {
			arr.iter()
				.map(|s| {
					let last = s
						.get("recentTools")
						.and_then(|x| x.as_array())
						.and_then(|tools| tools.last());
					SubagentStepInfo {
						label: s
							.get("label")
							.and_then(|x| x.as_str())
							.unwrap_or("")
							.to_string(),
						agent: s
							.get("agent")
							.and_then(|x| x.as_str())
							.unwrap_or("")
							.to_string(),
						status: s
							.get("status")
							.and_then(|x| x.as_str())
							.unwrap_or("")
							.to_string(),
						model: s
							.get("model")
							.and_then(|x| x.as_str())
							.map(|m| m.to_string()),
						turn_count: s.get("turnCount").and_then(|x| x.as_u64()).unwrap_or(0),
						tool_count: s.get("toolCount").and_then(|x| x.as_u64()).unwrap_or(0),
						last_tool: last
							.and_then(|t| t.get("tool"))
							.and_then(|x| x.as_str())
							.map(|n| n.to_string()),
						last_tool_args: last
							.and_then(|t| t.get("args"))
							.and_then(|x| x.as_str())
							.map(|a| a.chars().take(120).collect()),
					}
				})
				.collect()
		})
		.unwrap_or_default();
	Some(SubagentRunInfo {
		run_id: v
			.get("runId")
			.and_then(|x| x.as_str())
			.unwrap_or("")
			.to_string(),
		mode: v
			.get("mode")
			.and_then(|x| x.as_str())
			.unwrap_or("")
			.to_string(),
		state,
		started_at: v.get("startedAt").and_then(|x| x.as_u64()),
		steps,
	})
}

/// Live status of the subagent runs belonging to a session, for the chat's
/// subagent panel. The frontend polls this while a task is working.
#[tauri::command]
pub async fn pi_subagent_runs(session: String) -> Result<Vec<SubagentRunInfo>, String> {
	run_blocking(move || {
		let session_lower = canonical_or(Path::new(&session))
			.to_string_lossy()
			.to_lowercase();
		let now_ms = unix_ms(std::time::SystemTime::now());
		let mut runs: Vec<SubagentRunInfo> = subagent_run_dirs()
			.iter()
			.filter_map(|dir| {
				let raw = std::fs::read_to_string(dir.join("status.json")).ok()?;
				let v = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
				parse_subagent_status(&v, &session_lower, now_ms)
			})
			.collect();
		runs.sort_by_key(|r| std::cmp::Reverse(r.started_at));
		Ok(runs)
	})
	.await
}

// ===================================================================
// Project trust (/trust): read/write ~/.pi/agent/trust.json with the same
// shape pi uses — a map of canonical absolute directory → true|false — and
// the global `defaultProjectTrust` fallback in ~/.pi/agent/settings.json.
// ===================================================================
pub(crate) fn agent_dir() -> PathBuf {
	// Respect PI_AGENT_DIR like extras::pi_agent_dir, so trust.json/settings.json
	// and auth.json land in the same directory when the env var is set.
	if let Some(dir) = std::env::var_os("PI_AGENT_DIR") {
		return PathBuf::from(dir);
	}
	home_dir()
		.map(|h| h.join(".pi").join("agent"))
		.unwrap_or_else(|| PathBuf::from(".pi/agent"))
}

pub fn trust_file_path() -> PathBuf {
	agent_dir().join("trust.json")
}

pub fn settings_file_path() -> PathBuf {
	agent_dir().join("settings.json")
}

pub fn read_json_map(path: &Path) -> serde_json::Map<String, serde_json::Value> {
	let Ok(content) = std::fs::read_to_string(path) else {
		return serde_json::Map::new();
	};
	serde_json::from_str(&content).unwrap_or_default()
}

/// Serializes trust/settings read-modify-write so concurrent calls can't
/// clobber each other (mirrors AUTH_MUTEX for auth.json in extras.rs).
pub static TRUST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn write_json_map(
	path: &Path,
	map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
	if let Some(dir) = path.parent() {
		let _ = std::fs::create_dir_all(dir);
	}
	let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
	// Atomic write (tmp + rename): a torn write would corrupt the JSON and
	// silently drop trust decisions (pi itself also reads/writes these files).
	// Unique tmp suffix so concurrent writers (incl. the pi CLI touching the
	// same files) can't collide, and a failed rename never leaves a stale tmp.
	let tmp = path.with_extension(format!("json.{}.tmp", unique_suffix()));
	std::fs::write(&tmp, raw).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
	if let Err(e) = std::fs::rename(&tmp, path) {
		let _ = std::fs::remove_file(&tmp);
		return Err(format!("failed to persist {}: {e}", path.display()));
	}
	Ok(())
}

/// Nearest saved decision for a directory, walking up its parents (mirrors
/// pi's findNearestTrustEntry). Keys are stored as-is (absolute paths).
pub fn find_nearest_trust(
	map: &serde_json::Map<String, serde_json::Value>,
	dir: &Path,
) -> Option<bool> {
	let mut current = dir;
	loop {
		if let Some(v) = map.get(current.to_string_lossy().as_ref()) {
			return v.as_bool();
		}
		match current.parent() {
			Some(p) if p != current => current = p,
			_ => return None,
		}
	}
}

#[tauri::command]
pub fn pi_trust_get(project: String) -> Result<Option<bool>, String> {
	let map = read_json_map(&trust_file_path());
	Ok(find_nearest_trust(&map, Path::new(&project)))
}

/// decision: Some(true) = trust, Some(false) = deny, None = clear the entry.
#[tauri::command]
pub fn pi_trust_set(project: String, decision: Option<bool>) -> Result<(), String> {
	let _guard = TRUST_MUTEX
		.lock()
		.map_err(|e| format!("trust lock poisoned: {e}"))?;
	let mut map = read_json_map(&trust_file_path());
	match decision {
		Some(d) => {
			map.insert(project.clone(), serde_json::json!(d));
		}
		None => {
			map.remove(&project);
		}
	}
	write_json_map(&trust_file_path(), &map)
}

#[tauri::command]
pub fn pi_trust_default_get() -> Result<String, String> {
	let map = read_json_map(&settings_file_path());
	Ok(map
		.get("defaultProjectTrust")
		.and_then(|x| x.as_str())
		.unwrap_or("ask")
		.to_string())
}

#[tauri::command]
pub fn pi_trust_default_set(value: String) -> Result<(), String> {
	if !["ask", "always", "never"].contains(&value.as_str()) {
		return Err("invalid trust mode: expected ask/always/never".into());
	}
	let path = settings_file_path();
	let _guard = TRUST_MUTEX
		.lock()
		.map_err(|e| format!("trust lock poisoned: {e}"))?;
	let mut map = read_json_map(&path);
	map.insert("defaultProjectTrust".into(), serde_json::json!(value));
	write_json_map(&path, &map)
}

// ===================================================================
// External editor (TUI Ctrl+G): write the draft to a temp file, open the
// system editor, wait for it to close, and read the result back.
// ===================================================================
/// Wait for a spawned editor child to exit, giving up after `EDITOR_WAIT`.
/// `open -W -a TextEdit` on macOS waits for the APP to quit (or returns
/// immediately when TextEdit is already running — reading back an unedited
/// draft); a plain `child.wait()` can therefore hang the command forever.
/// On timeout the child is killed by pid so the blocking thread is not leaked.
pub fn wait_editor_with_timeout(
	mut child: Child,
	timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
	let pid = child.id();
	let (tx, rx) = std::sync::mpsc::channel();
	thread::spawn(move || {
		let status = child.wait();
		let _ = tx.send(status);
	});
	match rx.recv_timeout(timeout) {
		Ok(Ok(status)) => Ok(status),
		Ok(Err(e)) => Err(format!("failed to wait for editor: {e}")),
		Err(_) => {
			#[cfg(windows)]
			{
				use super::pi_process::CREATE_NO_WINDOW_KILL;
				use std::os::windows::process::CommandExt;
				use std::process::Stdio;
				let mut taskkill = system_command("taskkill");
				let _ = taskkill
					.args(["/PID", &pid.to_string(), "/T", "/F"])
					.stdin(Stdio::null())
					.stdout(Stdio::null())
					.stderr(Stdio::null())
					.creation_flags(CREATE_NO_WINDOW_KILL)
					.status();
			}
			#[cfg(not(windows))]
			{
				let _ = Command::new("/bin/kill")
					.args(["-9", &pid.to_string()])
					.status();
			}
			Err(format!(
				"editor did not close within {}s — aborted (save the draft in the editor and paste it manually)",
				timeout.as_secs()
			))
		}
	}
}

pub const EDITOR_WAIT: Duration = Duration::from_secs(30 * 60);

#[tauri::command]
pub async fn pi_external_edit(text: Option<String>) -> Result<String, String> {
	run_blocking(move || {
		// Unique name (pid + nanos): avoids concurrent-edit collisions and the
		// predictable-path symlink race a fixed `tau-editor-{pid}.md` invites.
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let tmp =
			std::env::temp_dir().join(format!("tau-editor-{}-{unique}.md", std::process::id()));
		// The draft can hold anything the user typed — keep it owner-only on
		// Unix instead of the default world-readable umask.
		write_private(&tmp, text.unwrap_or_default().as_bytes())
			.map_err(|e| format!("failed to write draft: {e}"))?;
		let editor = std::env::var("VISUAL")
			.or_else(|_| std::env::var("EDITOR"))
			.ok();
		let status = if let Some(ed) = editor {
			// Split into program + args (e.g. "code --wait"): treating the
			// whole string as one executable path fails for that common form.
			let mut parts = ed.split_whitespace();
			let program = parts.next().unwrap_or(ed.as_str());
			let mut cmd = Command::new(program);
			cmd.args(parts).arg(&tmp);
			no_console_window(&mut cmd)
				.spawn()
				.map_err(|e| format!("failed to launch editor: {e}"))
		} else {
			#[cfg(target_os = "macos")]
			{
				let mut cmd = system_command("open");
				cmd.args(["-W", "-a", "TextEdit"]).arg(&tmp);
				cmd.spawn()
					.map_err(|e| format!("failed to launch editor: {e}"))
			}
			#[cfg(not(target_os = "macos"))]
			{
				let mut cmd = system_command(if cfg!(windows) { "notepad" } else { "nano" });
				cmd.arg(&tmp);
				#[cfg(windows)]
				no_console_window(&mut cmd);
				cmd.spawn()
					.map_err(|e| format!("failed to launch editor: {e}"))
			}
		};
		// Wait on the blocking thread (this whole closure already runs on one)
		// with a watchdog so a wedged editor can't hang the command forever.
		let status = match status {
			Ok(child) => wait_editor_with_timeout(child, EDITOR_WAIT),
			Err(e) => Err(e),
		};
		let result = std::fs::read_to_string(&tmp);
		let _ = std::fs::remove_file(&tmp);
		match (status, result) {
			(Ok(s), Ok(content)) if s.success() => Ok(content),
			(Ok(s), Ok(_)) => Err(format!("editor exited with status {s}")),
			(Ok(_), Err(e)) => Err(format!("failed to read draft back: {e}")),
			(Err(e), _) => Err(e),
		}
	})
	.await
}

/// Pick a workspace folder. The dialog is `blocking` from the plugin's point
/// of view, so run it on a blocking thread: invoked as a sync command it
/// would call `rx.recv()` on the main thread and freeze the window while
/// the dialog is open (the modal run loop stalls behind the blocked main
/// thread).
#[tauri::command]
pub async fn pi_open_workspace(app: AppHandle) -> Result<Option<String>, String> {
	use tauri_plugin_dialog::DialogExt;
	let picked =
		tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
			.await
			.map_err(|e| e.to_string())?;
	Ok(picked.map(|p| p.to_string()))
}
