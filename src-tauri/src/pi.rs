use std::collections::HashMap;
use std::{
	fs::File,
	io::{BufRead, BufReader, Read, Write},
	path::{Path, PathBuf},
	process::{Child, ChildStdin, Command, Stdio},
	sync::atomic::{AtomicBool, Ordering},
	sync::{Arc, Mutex},
	thread,
	time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// One independent pi RPC process per window (multi-window support).
pub struct PiState {
	inner: Arc<Mutex<HashMap<String, PiProcess>>>,
}

/// Serializes the tests that mutate process-global env vars (PI_SESSION_DIR,
/// PI_AGENT_DIR, PI_BIN): cargo runs tests in parallel and env is
/// process-global, so a concurrent test could observe another test's
/// temporary values. Test-only: the release build has no use for it.
#[cfg(test)]
pub(crate) static ENV_GUARD: Mutex<()> = Mutex::new(());

impl PiState {
	/// Clone of the process map handle (for window-destroy handlers that must
	/// outlive the borrowed `State`).
	pub(crate) fn handle(&self) -> Arc<Mutex<HashMap<String, PiProcess>>> {
		self.inner.clone()
	}
}

impl Default for PiState {
	fn default() -> Self {
		Self {
			inner: Arc::new(Mutex::new(HashMap::new())),
		}
	}
}

#[derive(Default)]
pub(crate) struct PiProcess {
	child: Option<Child>,
	stdin: Option<ChildStdin>,
	workspace: Option<PathBuf>,
	session_file: Option<PathBuf>,
	/// Set when the current child is stopped on purpose (`pi_stop`, or being
	/// replaced by a newer `pi_start`); the exit reader reports a crash only
	/// when the flag is still false.
	explicit_stop: Arc<AtomicBool>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiBinaryInfo {
	pub(crate) bin: String,
	pub(crate) version: String,
	/// Resolved (node, script) pair when pi is an npm-style `.cmd`/`.bat` shim
	/// (Windows) or when `PI_BIN` points at a JS entrypoint. Spawning node
	/// directly keeps cmd.exe from re-interpreting `&`, `|`, `%VAR%`, … inside
	/// our arguments (system prompts, session names, package sources).
	#[serde(skip)]
	pub(crate) direct: Option<(String, String)>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionInfo {
	path: String,
	name: String,
	/// Project directory the session ran in (from the session header `cwd`).
	project: Option<String>,
	/// Human title derived from the first user message.
	title: String,
	/// Last known provider/model (from `model_change` events).
	model: Option<String>,
	created_at: Option<u64>,
	message_count: u64,
	mtime_ms: u64,
	size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiParsedBlock {
	kind: String,
	text: String,
	name: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiParsedMessage {
	role: String,
	timestamp: Option<String>,
	entry_id: Option<String>,
	blocks: Vec<PiParsedBlock>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiArchivedSession {
	path: String,
	original_path: String,
	title: String,
	project: Option<String>,
	mtime_ms: u64,
	size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSearchHit {
	path: String,
	title: String,
	project: Option<String>,
	snippet: String,
	updated_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStatus {
	running: bool,
	workspace: Option<String>,
	session_file: Option<String>,
}

pub(crate) fn home_dir() -> Option<PathBuf> {
	if cfg!(windows) {
		std::env::var_os("USERPROFILE").map(PathBuf::from)
	} else {
		std::env::var_os("HOME").map(PathBuf::from)
	}
}

fn default_session_dir() -> PathBuf {
	if let Some(dir) = std::env::var_os("PI_SESSION_DIR") {
		return PathBuf::from(dir);
	}
	home_dir()
		.map(|h| h.join(".pi").join("agent").join("sessions"))
		.unwrap_or_else(|| PathBuf::from(".pi/agent/sessions"))
}

/// Resolve an npm/yarn-style Windows command shim (`.cmd`/`.bat`) to the node
/// binary and JS entrypoint it would run, so pi can be spawned directly
/// without cmd.exe mangling arguments that contain `&`, `|`, `%VAR%`, ….
fn resolve_shim_target(shim: &Path) -> Option<(PathBuf, PathBuf)> {
	let content = std::fs::read_to_string(shim).ok()?;
	let dir = shim.parent()?.to_path_buf();
	let mut node: Option<PathBuf> = None;
	let mut script: Option<PathBuf> = None;
	for line in content.lines() {
		let mut rest = line;
		while let Some(start) = rest.find('"') {
			let after = &rest[start + 1..];
			let Some(end) = after.find('"') else { break };
			let mut quoted = &after[..end];
			if quoted.contains("%_prog%") {
				// Node binary resolved by the shim's own logic; see fallback below.
			} else if quoted.starts_with("%dp0%") || quoted.starts_with("%~dp0") {
				quoted = quoted
					.trim_start_matches("%dp0%")
					.trim_start_matches("%~dp0")
					.trim_start_matches(['\\', '/']);
				let candidate = dir.join(quoted);
				if candidate
					.file_name()
					.is_some_and(|n| n == "node" || n == "node.exe")
				{
					node = Some(candidate);
				} else {
					script = Some(candidate);
				}
			}
			rest = &after[end + 1..];
		}
	}
	// The shim only uses a node.exe next to itself when it exists
	// (`IF EXIST "%dp0%\node.exe"`); otherwise node resolves via PATH.
	let mut node = node.filter(|n| n.exists());
	if node.is_none() {
		let local = dir.join("node.exe");
		if local.exists() {
			node = Some(local);
		}
	}
	let node = node.unwrap_or_else(|| PathBuf::from("node"));
	Some((node, script?))
}

/// Find `bin` in PATH (or return it as-is when it has a directory component).
/// On Windows, bare names are also matched against the PATHEXT extensions
/// (`.COM;.EXE;.BAT;.CMD`) so a `pi.cmd` shim is found the same way
/// CreateProcess would find it — without this, the bare "pi" candidate in
/// `probe_pi_uncached` would bypass shim resolution entirely.
fn resolve_in_path(bin: &str) -> Option<PathBuf> {
	if bin.contains('\\') || bin.contains('/') {
		return Some(PathBuf::from(bin));
	}
	let path = std::env::var_os("PATH")?;
	for dir in std::env::split_paths(&path) {
		#[cfg(windows)]
		{
			// On Windows, an extensionless npm shim (`pi` shell script) next
			// to `pi.cmd` shadows the real launcher: CreateProcess can't run
			// a shell script, so a bare `Command::new("pi")` would hit the
			// script first and fail. Prefer the PATHEXT extensions (.COM;
			// .EXE;.BAT;.CMD) — same order as cmd.exe — and only fall back to
			// the bare name when nothing else matches.
			let candidate = dir.join(bin);
			if candidate.extension().is_some() {
				if candidate.is_file() {
					return Some(candidate);
				}
			} else {
				let pathext =
					std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
				for ext in pathext.split(';') {
					let ext = ext.trim();
					if ext.is_empty() {
						continue;
					}
					let with_ext = dir.join(format!("{bin}{ext}"));
					if with_ext.is_file() {
						return Some(with_ext);
					}
				}
				if candidate.is_file() {
					return Some(candidate);
				}
			}
		}
		#[cfg(not(windows))]
		{
			let candidate = dir.join(bin);
			if candidate.is_file() {
				return Some(candidate);
			}
		}
	}
	None
}

/// Probe one pi candidate and figure out how to launch it safely.
fn probe_candidate(bin: &str) -> Option<PiBinaryInfo> {
	let (mut cmd, direct) =
		if bin.ends_with(".js") || bin.ends_with(".mjs") || bin.ends_with(".cjs") {
			// `PI_BIN` may point straight at the JS entrypoint.
			let node = find_node(None).unwrap_or_else(|| PathBuf::from("node"));
			let node_s = node.to_string_lossy().into_owned();
			let mut c = Command::new(&node);
			c.arg(bin);
			(c, Some((node_s, bin.to_string())))
		} else if bin.ends_with(".cmd") || bin.ends_with(".bat") {
			// Probe candidates are bare names; resolve the shim's full path so its
			// directory (and the node_modules tree next to it) can be found.
			let shim = resolve_in_path(bin)?;
			let (node, script) = resolve_shim_target(&shim)?;
			let mut c = Command::new(&node);
			c.arg(&script);
			(
				c,
				Some((
					node.to_string_lossy().into_owned(),
					script.to_string_lossy().into_owned(),
				)),
			)
		} else {
			// A bare name may still resolve to a `.cmd`/`.bat` shim on PATH
			// (npm global installs ship only the shim, no `pi.exe`). Resolve it
			// to node + script so pi is never launched through cmd.exe (which
			// would reinterpret `&`, `|`, `%VAR%`, … inside our arguments).
			match resolve_in_path(bin) {
				Some(resolved)
					if resolved
						.file_name()
						.and_then(|n| n.to_str())
						.map(|n| n.to_ascii_lowercase())
						.is_some_and(|n| n.ends_with(".cmd") || n.ends_with(".bat")) =>
				{
					match resolve_shim_target(&resolved) {
						Some((node, script)) => {
							let mut c = Command::new(&node);
							c.arg(&script);
							(
								c,
								Some((
									node.to_string_lossy().into_owned(),
									script.to_string_lossy().into_owned(),
								)),
							)
						}
						// Never fall back to Command::new(bin) here: on Windows a
						// .cmd/.bat launched by bare name goes through cmd.exe, which
						// would reinterpret `&`, `|`, `%VAR%`, … inside the arguments
						// we forward (system prompts, session names, package sources).
						// An unresolvable shim is treated as "not found" instead.
						None => return None,
					}
				}
				#[cfg(not(windows))]
				Some(resolved) => {
					// Unix: npm global installs expose `pi` as a symlink to cli.js with
					// a `#!/usr/bin/env node` shebang. From Finder/LaunchServices the
					// GUI inherits a minimal PATH (no node), so the shebang alone can't
					// run. Detect the symlink-to-JS case and spawn `node script`
					// directly.
					match std::fs::canonicalize(&resolved) {
						Ok(real)
							if real
								.extension()
								.and_then(|e| e.to_str())
								.is_some_and(|e| e == "js" || e == "mjs" || e == "cjs") =>
						{
							let Some(node) = find_node(Some(&resolved)) else {
								// Found pi but no node to run it with; treat as not found
								// so the next candidate / known-location probe can try.
								return None;
							};
							let node_s = node.to_string_lossy().into_owned();
							let script = real.to_string_lossy().into_owned();
							let mut c = Command::new(&node);
							c.arg(&script);
							(c, Some((node_s, script)))
						}
						_ => (Command::new(bin), None),
					}
				}
				_ => (Command::new(bin), None),
			}
		};
	let out = no_console_window(&mut cmd).arg("--version").output().ok()?;
	if !out.status.success() {
		return None;
	}
	let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
	if version.is_empty() {
		return None;
	}
	Some(PiBinaryInfo {
		bin: bin.to_string(),
		version,
		direct,
	})
}

/// Cached pi probe result. Successful probes are cached for the app's
/// lifetime (pi doesn't change underneath a running app — restart to pick up
/// an upgrade). Failed probes are retried after a short backoff so a
/// late-installed pi is still picked up without paying the spawn cost on
/// every `pi_start`/`pi list` call.
struct ProbeCacheEntry {
	info: Option<PiBinaryInfo>,
	checked_at: Instant,
}

static PROBE_CACHE: Mutex<Option<ProbeCacheEntry>> = Mutex::new(None);

const PROBE_FAIL_RETRY: Duration = Duration::from_secs(10);

pub(crate) fn probe_pi() -> Option<PiBinaryInfo> {
	if let Ok(guard) = PROBE_CACHE.lock() {
		if let Some(entry) = guard.as_ref() {
			if entry.info.is_some() || entry.checked_at.elapsed() < PROBE_FAIL_RETRY {
				return entry.info.clone();
			}
		}
	}
	let info = probe_pi_uncached();
	if let Ok(mut guard) = PROBE_CACHE.lock() {
		*guard = Some(ProbeCacheEntry {
			info: info.clone(),
			checked_at: Instant::now(),
		});
	}
	info
}

fn probe_pi_uncached() -> Option<PiBinaryInfo> {
	if let Ok(env_bin) = std::env::var("PI_BIN") {
		if let Some(info) = probe_candidate(&env_bin) {
			return Some(info);
		}
	}
	let mut candidates: Vec<&str> = vec!["pi"];
	if cfg!(windows) {
		candidates.extend(["pi.exe", "pi.cmd", "pi.bat"]);
	}
	if let Some(info) = candidates.iter().find_map(|bin| probe_candidate(bin)) {
		return Some(info);
	}
	// PATH search came up empty (e.g. the GUI inherited a stale explorer
	// environment that predates the pi install). Fall back to well-known
	// install locations before giving up.
	probe_known_locations()
}

/// Look for pi in places it is typically installed even when PATH doesn't
/// cover them: the npm global bin dir, and any PATH directory that holds
/// node.exe (npm's prefix is usually the node install dir, and pi is a
/// sibling of node there). On Unix this also covers the well-known npm-global
/// / nvm / brew roots (a .app launched from Finder inherits only
/// /usr/bin:/bin:/usr/sbin:/sbin, which none of them live in).
fn probe_known_locations() -> Option<PiBinaryInfo> {
	let mut dirs: Vec<PathBuf> = Vec::new();
	#[cfg(windows)]
	if let Some(appdata) = std::env::var_os("APPDATA") {
		dirs.push(PathBuf::from(appdata).join("npm"));
	}
	if let Some(path) = std::env::var_os("PATH") {
		for dir in std::env::split_paths(&path) {
			if dir.join("node.exe").is_file() && !dirs.contains(&dir) {
				dirs.push(dir);
			}
		}
	}
	#[cfg(not(windows))]
	for dir in known_bin_dirs() {
		if !dirs.contains(&dir) {
			dirs.push(dir);
		}
	}
	for dir in dirs {
		for name in ["pi.cmd", "pi.bat", "pi.exe", "pi"] {
			let candidate = dir.join(name);
			if candidate.is_file() {
				if let Some(info) = probe_candidate(&candidate.to_string_lossy()) {
					return Some(info);
				}
			}
		}
	}
	None
}

/// Well-known directories that hold npm-global binaries (and the node that
/// runs them) when the GUI's inherited PATH is too minimal to include them.
#[cfg(not(windows))]
fn known_bin_dirs() -> Vec<PathBuf> {
	let mut dirs: Vec<PathBuf> = Vec::new();
	if let Some(home) = std::env::var_os("HOME") {
		let home = PathBuf::from(home);
		dirs.push(home.join(".npm-global").join("bin"));
		dirs.push(home.join(".local").join("bin"));
		dirs.push(home.join(".volta").join("bin"));
		dirs.push(home.join(".asdf").join("shims"));
		// nvm: ~/.nvm/versions/node/<v>/bin (all installed versions, newest last).
		if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
			let mut vers: Vec<PathBuf> = entries
				.filter_map(|e| e.ok().map(|e| e.path().join("bin")))
				.collect();
			vers.sort();
			dirs.extend(vers);
		}
		// Laravel Herd bundles its own nvm tree under Application Support.
		let herd = home
			.join("Library")
			.join("Application Support")
			.join("Herd")
			.join("config")
			.join("nvm")
			.join("versions")
			.join("node");
		if let Ok(entries) = std::fs::read_dir(herd) {
			let mut vers: Vec<PathBuf> = entries
				.filter_map(|e| e.ok().map(|e| e.path().join("bin")))
				.collect();
			vers.sort();
			dirs.extend(vers);
		}
	}
	dirs.push(PathBuf::from("/opt/homebrew/bin"));
	dirs.push(PathBuf::from("/usr/local/bin"));
	dirs.push(PathBuf::from("/opt/local/bin"));
	dirs
}

/// Locate a node binary able to run pi's JS entrypoint. Called when pi is a
/// symlink-to-JS shim (npm global installs on Unix): the `#!/usr/bin/env
/// node` shebang can't resolve node when the GUI inherited a minimal PATH, so
/// we spawn `node script` directly. `near` is the pi shim path — npm puts
/// node next to the shim in the same prefix bin dir.
#[cfg(not(windows))]
fn find_node(near: Option<&Path>) -> Option<PathBuf> {
	if let Some(dir) = near.and_then(|s| s.parent()) {
		let c = dir.join("node");
		if c.is_file() {
			return Some(c);
		}
	}
	if let Some(path) = std::env::var_os("PATH") {
		for dir in std::env::split_paths(&path) {
			let c = dir.join("node");
			if c.is_file() {
				return Some(c);
			}
		}
	}
	known_bin_dirs()
		.into_iter()
		.find(|dir| dir.join("node").is_file())
}

/// Base `Command` for launching pi. Never goes through cmd.exe argument
/// parsing: npm shims are resolved to node + script at probe time.
pub(crate) fn pi_command(info: &PiBinaryInfo) -> Command {
	if let Some((node, script)) = &info.direct {
		let mut c = Command::new(node);
		c.arg(script);
		c
	} else {
		Command::new(&info.bin)
	}
}

/// Suppress the console window for a child process on Windows. Without this,
/// every console-subsystem child (node, git, …) spawned from the borderless
/// GUI (windows_subsystem = "windows", no console of its own) would pop a
/// black cmd window that flashes open and closed.
#[cfg(windows)]
pub(crate) fn no_console_window(cmd: &mut Command) -> &mut Command {
	use std::os::windows::process::CommandExt;
	const CREATE_NO_WINDOW: u32 = 0x08000000;
	cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub(crate) fn no_console_window(cmd: &mut Command) -> &mut Command {
	cmd
}

/// Maximum size of a single RPC event line we are willing to buffer. pi
/// sends one JSON event per line; a huge tool result can make a single line
/// tens of MB. BufRead::lines() would allocate that unboundedly — combined
/// with the webview's render spike at message_end that is exactly the OOM
/// window the crashes were reported in. Lines beyond the cap are dropped
/// (the UI degrades gracefully; the process survives).
const MAX_EVENT_LINE: usize = 64 * 1024 * 1024;

impl PiProcess {
	// Many launch options (session/fork/name/prompts/tools/models) are passed
	// through individually from the Tauri command payload.
	#[allow(clippy::too_many_arguments)]
	fn spawn(
		&mut self,
		info: &PiBinaryInfo,
		workspace: &str,
		session_file: Option<&str>,
		fork_of: Option<&str>,
		session_name: Option<&str>,
		system_prompt: Option<&str>,
		append_system_prompt: Option<&str>,
		tools: Option<&[String]>,
		excluded_tools: Option<&[String]>,
		models: Option<&str>,
		state: Arc<Mutex<HashMap<String, PiProcess>>>,
		label: String,
		window: &WebviewWindow,
	) -> Result<(), String> {
		self.kill();

		let mut cmd = pi_command(info);
		cmd.arg("--mode")
			.arg("rpc")
			.arg("--session-dir")
			.arg(default_session_dir());
		// Scoped model patterns for Ctrl+P cycling (/scoped-models equivalent).
		if let Some(models) = models {
			let models = models.trim();
			if !models.is_empty() {
				cmd.arg("--models").arg(models);
			}
		}
		if let Some(path) = fork_of {
			cmd.arg("--fork").arg(path);
		} else if let Some(path) = session_file {
			cmd.arg("--session").arg(path);
		}
		if let Some(name) = session_name {
			if !name.trim().is_empty() {
				cmd.arg("--name").arg(name);
			}
		}
		if let Some(prompt) = system_prompt {
			let prompt = prompt.trim();
			if !prompt.is_empty() {
				if prompt.len() > 30000 {
					return Err("system prompt is too long (max 30000 chars)".into());
				}
				cmd.arg("--system-prompt").arg(prompt);
			}
		}
		if let Some(prompt) = append_system_prompt {
			let prompt = prompt.trim();
			if !prompt.is_empty() {
				if prompt.len() > 30000 {
					return Err("append-system-prompt is too long (max 30000 chars)".into());
				}
				cmd.arg("--append-system-prompt").arg(prompt);
			}
		}
		// Tool allowlist: Some([]) = disable all tools, Some([...]) = allowlist,
		// None = keep pi defaults (all tools).
		if let Some(tools) = tools {
			if tools.is_empty() {
				cmd.arg("--no-tools");
			} else {
				cmd.arg("--tools").arg(tools.join(","));
			}
		}
		// Tool exclude list: Some([...]) = --exclude-tools (keeps everything
		// else enabled, works alongside the allowlist above).
		if let Some(tools) = excluded_tools {
			if !tools.is_empty() {
				cmd.arg("--exclude-tools").arg(tools.join(","));
			}
		}
		cmd.current_dir(workspace)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		#[cfg(windows)]
		{
			use std::os::windows::process::CommandExt;
			const CREATE_NO_WINDOW: u32 = 0x08000000;
			cmd.creation_flags(CREATE_NO_WINDOW);
		}

		let mut child = cmd
			.spawn()
			.map_err(|e| format!("failed to spawn pi: {e}"))?;
		let stdin = child.stdin.take().ok_or("failed to take pi stdin")?;
		let stdout = child.stdout.take().ok_or("failed to take pi stdout")?;
		let stderr = child.stderr.take().ok_or("failed to take pi stderr")?;
		let pid = child.id();
		// Per-child flag: `kill()` sets it so the reader thread can tell an
		// intentional stop apart from a crash.
		let stop_flag = Arc::new(AtomicBool::new(false));

		let app_stdout = window.app_handle().clone();
		let win_stdout = window.clone();
		let win_stderr = window.clone();
		let state = state.clone();
		let label_thread = label.clone();
		let stop_flag_thread = stop_flag.clone();
		thread::spawn(move || {
			let reader = BufReader::new(stdout);
			for line in LimitedLines::new(reader, MAX_EVENT_LINE) {
				let line = match line {
					Ok(line) => line,
					Err(_) => break,
				};
				if line.trim().is_empty() {
					continue;
				}
				let line_len = line.len();
				let payload: Value = serde_json::from_str(&line).unwrap_or(Value::String(line));
				// Best-effort slim for get_tree responses (deeply nested pi trees
				// usually fail serde_json's default 128-level parse, so the
				// frontend reads trees from the JSONL file via pi_read_tree).
				let mut payload = if payload.get("type").and_then(|x| x.as_str())
					== Some("response")
					&& payload.get("command").and_then(|x| x.as_str()) == Some("get_tree")
				{
					slim_get_tree_payload(&payload)
				} else {
					payload
				};
				// Cap huge payloads before emitting: a single oversized line must
				// not be serialized to the webview at its full size.
				if line_len > 4 * 1024 * 1024 {
					cap_strings(&mut payload, 1024 * 1024);
				}
				let _ = win_stdout.emit("pi://event", &payload);
			}
			let mut guard = lock_state(&state);
			let is_current = guard
				.get(&label_thread)
				.and_then(|p| p.child.as_ref())
				.is_some_and(|c| c.id() == pid);
			let child = if is_current {
				if let Some(p) = guard.get_mut(&label_thread) {
					p.stdin = None;
					p.child.take()
				} else {
					None
				}
			} else {
				None
			};
			drop(guard);
			// Reap the child OUTSIDE the lock (wait() blocks): dropping the
			// Child handle without wait() would leave a naturally-exited pi as
			// a zombie on Unix.
			if let Some(mut child) = child {
				let _ = child.wait();
			}
			// Only report the exit when the *current* pi process died and it
			// was not stopped on purpose. Processes replaced by a newer
			// `pi_start` or killed by `pi_stop` must not make the frontend
			// think the connection dropped.
			if is_current && !stop_flag_thread.load(Ordering::Relaxed) {
				crate::runtime_log::log_error(&app_stdout, "pi process exited");
				let _ = win_stdout.emit("pi://exit", ());
			}
		});

		thread::spawn(move || {
			let reader = BufReader::new(stderr);
			for line in reader.lines() {
				let line = match line {
					Ok(line) => line,
					Err(_) => break,
				};
				// Window-scoped emit: each window only sees its own pi's stderr
				// (an app-level emit would leak every window's logs into every
				// window's stderr panel).
				let _ = win_stderr.emit("pi://stderr", line);
			}
		});

		self.child = Some(child);
		self.stdin = Some(stdin);
		self.workspace = Some(PathBuf::from(workspace));
		self.session_file = session_file.map(PathBuf::from);
		self.explicit_stop = stop_flag;
		Ok(())
	}

	fn kill(&mut self) {
		// Mark the (about to die) child as intentionally stopped so its
		// stdout reader doesn't report a crash to the frontend.
		self.explicit_stop.store(true, Ordering::Relaxed);
		self.stdin.take();
		if let Some(mut child) = self.child.take() {
			// When spawned via `cmd /C`, killing only the cmd process would orphan
			// the node child, so kill the whole process tree on Windows.
			#[cfg(windows)]
			{
				use std::os::windows::process::CommandExt;
				const CREATE_NO_WINDOW: u32 = 0x08000000;
				let _ = Command::new("taskkill")
					.args(["/PID", &child.id().to_string(), "/T", "/F"])
					.stdin(Stdio::null())
					.stdout(Stdio::null())
					.stderr(Stdio::null())
					.creation_flags(CREATE_NO_WINDOW)
					.status();
			}
			let _ = child.kill();
			let _ = child.wait();
		}
		self.workspace = None;
		self.session_file = None;
	}
}

fn unix_ms(t: std::time::SystemTime) -> u64 {
	t.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0)
}

/// A time + counter based unique suffix for temporary files, so concurrent
/// operations on the same target can't collide (compact vs. move) and a
/// predictable name can't be symlinked by a same-user local attacker.
pub(crate) fn unique_suffix() -> String {
	use std::sync::atomic::{AtomicU64, Ordering};
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	format!("{nanos}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn file_stem(path: &Path) -> String {
	path.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or_default()
		.to_string()
}

fn canonical_dir(p: &Path) -> Option<PathBuf> {
	std::fs::canonicalize(p).ok()
}

/// Canonicalize `path`, falling back to the raw path when canonicalization
/// fails (e.g. the file doesn't exist). Used for running-session comparisons:
/// `PiProcess.session_file` stores the path as the frontend sent it (raw,
/// possibly without the `\\?\` prefix canonicalize adds on Windows), so both
/// sides must be canonicalized before comparing.
fn canonical_or(path: &Path) -> PathBuf {
	std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Resolve `path` and require it to live under the sessions directory.
pub(crate) fn require_session_path(path: &Path) -> Result<PathBuf, String> {
	let base = std::fs::canonicalize(default_session_dir())
		.map_err(|e| format!("sessions directory unavailable: {e}"))?;
	let full = std::fs::canonicalize(path)
		.map_err(|e| format!("session not found: {}: {e}", path.display()))?;
	if !full.starts_with(&base) {
		return Err("session path is outside the sessions directory".into());
	}
	Ok(full)
}

/// Lock the per-window process map, recovering from a poisoned mutex instead
/// of panicking: a panic on the main thread while holding this lock would
/// otherwise cascade into every later command (`.unwrap()` on a poisoned
/// lock) and kill the whole app.
fn lock_state(
	map: &Mutex<HashMap<String, PiProcess>>,
) -> std::sync::MutexGuard<'_, HashMap<String, PiProcess>> {
	map.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `path` is the session file of a running pi process in ANY window.
/// Paths are compared canonicalized on both sides: the stored session file is
/// the raw string the frontend sent, while callers pass canonicalized paths
/// (Windows canonicalize adds a `\\?\` prefix, so a raw-vs-canonical string
/// comparison would silently never match).
pub(crate) fn is_running_session(state: &PiState, path: &Path) -> bool {
	let full = canonical_or(path);
	// Recover from a poisoned lock (lock_state) instead of failing open: a
	// poisoned mutex here must NOT read as "not running" — that would let
	// archive/delete/compact proceed against a session pi is still appending.
	lock_state(&state.inner).values().any(|p| {
		p.session_file
			.as_deref()
			.is_some_and(|s| canonical_or(s) == full)
	})
}

/// Kill the pi process belonging to a window label (called when a window is
/// destroyed). Takes the cloned process-map handle so window-destroy handlers
/// can outlive the borrowed `State`.
pub(crate) fn kill_window_process_inner(
	inner: &Arc<Mutex<HashMap<String, PiProcess>>>,
	label: &str,
) {
	// Remove the entry under the lock (a destroyed window's process is gone
	// for good — this also keeps the map from growing without bound) and kill
	// outside it: kill() waits for the child to exit and must not block other
	// windows' RPC commands.
	let proc = inner.lock().ok().and_then(|mut map| map.remove(label));
	if let Some(mut p) = proc {
		p.kill();
	}
}

/// Monotonic sequence so window labels stay unique even when two windows
/// are created within the same millisecond.
static WINDOW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Open another Tau window (each window runs its own pi process/session).
/// Generic over the runtime so it works with the mock runtime in tests.
#[tauri::command]
fn pi_new_window<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
	let label = format!("main-{stamp}-{seq}");
	let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::default())
		.title("Tau")
		.inner_size(1280.0, 800.0)
		.min_inner_size(960.0, 640.0)
		.center()
		.visible(false);
	#[cfg(target_os = "macos")]
	{
		// Native traffic lights (like the main window).
		builder = builder
			.decorations(true)
			.title_bar_style(tauri::TitleBarStyle::Overlay)
			.hidden_title(true)
			.traffic_light_position(tauri::LogicalPosition::new(20.0, 17.0));
	}
	#[cfg(not(target_os = "macos"))]
	{
		builder = builder.decorations(false);
	}
	let win = builder.build().map_err(|e| e.to_string())?;
	let _ = win.show();
	crate::window_state::restore(&win);
	crate::window_state::attach(&win);
	// Kill the window's pi process when its window closes (the app itself
	// may stay alive with other windows open).
	let inner = app.state::<PiState>().handle();
	let label_clone = label.clone();
	win.on_window_event(move |event| {
		if let tauri::WindowEvent::Destroyed = event {
			if let Ok(mut map) = inner.lock() {
				if let Some(p) = map.get_mut(&label_clone) {
					p.kill();
				}
			}
		}
	});
	Ok(())
}

fn is_leap_year(y: i64) -> bool {
	(y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn parse_iso_ms(s: &str) -> Option<u64> {
	// Accept "2026-08-10T06:31:02.384Z" style timestamps.
	let s = s.trim();
	let s = s.strip_suffix('Z').unwrap_or(s);
	let (date, time) = s.split_once('T')?;
	let mut dp = date.split('-');
	let y: i64 = dp.next()?.parse().ok()?;
	// Reject pre-epoch years: a negative `secs` below would wrap through
	// `as u64` into a garbage huge epoch value.
	if y < 1970 {
		return None;
	}
	let mo: i64 = dp.next()?.parse().ok()?;
	let d: i64 = dp.next()?.parse().ok()?;
	if !(1..=12).contains(&mo) {
		return None;
	}
	// Real per-month day counts (leap-aware) so "Feb 30" style dates fail.
	let leap = is_leap_year(y);
	let days_in_month = [
		31,
		if leap { 29 } else { 28 },
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	if !(1..=days_in_month[(mo - 1) as usize]).contains(&d) {
		return None;
	}
	let mut tp = time.split(':');
	let h: i64 = tp.next()?.parse().ok()?;
	let mi: i64 = tp.next()?.parse().ok()?;
	let sec: i64 = tp.next()?.split('.').next()?.parse().ok()?;
	if !(0..=23).contains(&h) || !(0..=59).contains(&mi) || !(0..=60).contains(&sec) {
		return None;
	}
	// Days since the (proleptic Gregorian) year 0; the leap-day offset for
	// dates after February is folded into the day-of-year value below.
	let mut day_of_year =
		[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][(mo - 1) as usize] + (d - 1);
	if leap && mo > 2 {
		day_of_year += 1;
	}
	// Days since the (proleptic Gregorian) year 0. The day count uses
	// `y - 1`: `y*365 + y/4 - y/100 + y/400` also counts year y's own leap
	// day, i.e. it resolves to Jan 1 of year y+1 — every parsed timestamp
	// would come out ~365 days too large. The leap-day offset for dates
	// after February in year y is folded into day_of_year above.
	let y0 = y - 1;
	let days = y0 * 365 + y0 / 4 - y0 / 100 + y0 / 400 + day_of_year;
	let secs = days * 86400 + h * 3600 + mi * 60 + sec;
	// Sub-second precision is irrelevant here; epoch in ms.
	Some((secs as u64).saturating_mul(1000))
}

/// Maximum size of a single JSONL line we are willing to hold in memory.
/// Lines larger than this (typically huge base64 image messages) are skipped;
/// without this a single pathological line could balloon memory use while
/// listing/searching sessions.
pub(crate) const MAX_JSONL_LINE: usize = 16 * 1024 * 1024;

/// Like `BufRead::lines`, but skips lines larger than `max` bytes so a
/// pathological session file can't allocate unbounded memory.
struct LimitedLines<R> {
	reader: R,
	max: usize,
	buf: Vec<u8>,
}

impl<R> LimitedLines<R> {
	fn new(reader: R, max: usize) -> Self {
		Self {
			reader,
			max,
			buf: Vec::with_capacity(8 * 1024),
		}
	}
}

impl<R: BufRead> Iterator for LimitedLines<R> {
	type Item = std::io::Result<String>;

	fn next(&mut self) -> Option<Self::Item> {
		loop {
			self.buf.clear();
			let mut limited = (&mut self.reader).take((self.max + 1) as u64);
			match limited.read_until(b'\n', &mut self.buf) {
				Ok(0) => return None,
				Ok(n) if n > self.max => {
					// Discard the remainder of the oversized line so the next
					// iteration stays aligned on a line boundary.
					loop {
						self.buf.clear();
						let mut sink = (&mut self.reader).take(64 * 1024);
						match sink.read_until(b'\n', &mut self.buf) {
							Ok(0) => break,
							Ok(_) if self.buf.last() == Some(&b'\n') => break,
							Ok(_) => {}
							Err(_) => break,
						}
					}
				}
				Ok(_) => {
					if self.buf.last() == Some(&b'\n') {
						self.buf.pop();
					}
					if self.buf.last() == Some(&b'\r') {
						self.buf.pop();
					}
					return Some(Ok(String::from_utf8_lossy(&self.buf).into_owned()));
				}
				Err(e) => return Some(Err(e)),
			}
		}
	}
}

fn extract_block_text(content: Option<&serde_json::Value>) -> Option<String> {
	let arr = content?.as_array()?;
	let mut out = String::new();
	for item in arr {
		let kind = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
		if kind == "text" {
			if let Some(s) = item.get("text").and_then(|x| x.as_str()) {
				out.push_str(s);
			}
		}
	}
	let out = out.trim().to_string();
	if out.is_empty() {
		None
	} else {
		Some(out)
	}
}

fn make_title(text: &str) -> String {
	let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
	let mut chars = one_line.chars();
	let mut out: String = chars.by_ref().take(60).collect();
	if chars.next().is_some() {
		out.push('…');
	}
	out
}

struct SessionScan {
	project: Option<String>,
	title: String,
	model: Option<String>,
	created_at: Option<u64>,
	message_count: u64,
}

/// Scan a session JSONL for display metadata. `limit` caps lines scanned
/// (list/search need only the head; message_count stays approximate for
/// very large files, which is acceptable for a sidebar list).
fn scan_session(path: &Path, limit: usize) -> SessionScan {
	let mut scan = SessionScan {
		project: None,
		title: String::new(),
		model: None,
		created_at: None,
		message_count: 0,
	};
	let file = match File::open(path) {
		Ok(f) => f,
		Err(_) => return scan,
	};
	let reader = BufReader::new(file);
	for line in LimitedLines::new(reader, MAX_JSONL_LINE)
		.take(limit)
		.flatten()
	{
		if line.trim().is_empty() {
			continue;
		}
		let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
			continue;
		};
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		match kind {
			"session" => {
				scan.project = v
					.get("cwd")
					.and_then(|x| x.as_str())
					.filter(|s| !s.is_empty())
					.map(|s| s.to_string());
				scan.created_at = v
					.get("timestamp")
					.and_then(|x| x.as_str())
					.and_then(parse_iso_ms);
			}
			"model_change" => {
				let provider = v.get("provider").and_then(|x| x.as_str());
				let model_id = v.get("modelId").and_then(|x| x.as_str());
				if let (Some(p), Some(m)) = (provider, model_id) {
					scan.model = Some(format!("{p}/{m}"));
				}
			}
			"message" => {
				scan.message_count += 1;
				if scan.title.is_empty() {
					let role = v.pointer("/message/role").and_then(|x| x.as_str());
					if role == Some("user") {
						if let Some(text) = extract_block_text(v.pointer("/message/content")) {
							scan.title = make_title(&text);
						}
					}
				}
			}
			_ => {}
		}
	}
	scan
}

fn is_aux_dir(name: &str) -> bool {
	name == ".pi-gui-archive" || name == ".pi-gui-trash"
}

fn aux_root() -> PathBuf {
	default_session_dir()
}

fn archive_dir() -> PathBuf {
	aux_root().join(".pi-gui-archive")
}

fn trash_dir() -> PathBuf {
	aux_root().join(".pi-gui-trash")
}

/// Walk the sessions tree for `*.jsonl` files. Depth-capped and symlink-safe
/// (`DirEntry::file_type` does not follow links), so a symlink cycle in the
/// sessions directory can't cause unbounded recursion.
fn session_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
	if depth > 8 {
		return;
	}
	let Ok(entries) = std::fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		let Ok(ft) = entry.file_type() else { continue };
		if ft.is_dir() {
			if is_aux_dir(&path.file_name().unwrap_or_default().to_string_lossy()) {
				continue;
			}
			session_files(&path, out, depth + 1);
		} else if ft.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
			out.push(path);
		}
	}
}

/// Run `f` over `items` on worker threads (bounded by available parallelism)
/// and collect the results in order. Falls back to a plain loop for tiny
/// inputs.
fn par_map<T: Send>(items: Vec<PathBuf>, f: impl Fn(&Path) -> T + Sync) -> Vec<T> {
	let n = items.len();
	if n <= 1 {
		return items.iter().map(|p| f(p)).collect();
	}
	let threads = std::thread::available_parallelism()
		.map(|p| p.get())
		.unwrap_or(4)
		.min(n);
	let next = std::sync::atomic::AtomicUsize::new(0);
	std::thread::scope(|scope| {
		let mut handles = Vec::with_capacity(threads);
		for _ in 0..threads {
			handles.push(scope.spawn(|| {
				let mut local = Vec::new();
				loop {
					let i = next.fetch_add(1, Ordering::Relaxed);
					if i >= n {
						break;
					}
					local.push((i, f(&items[i])));
				}
				local
			}));
		}
		let mut out: Vec<Option<T>> = (0..n).map(|_| None).collect();
		for h in handles {
			match h.join() {
				Ok(local) => {
					for (i, v) in local {
						out[i] = Some(v);
					}
				}
				// A panicking worker already hits the global panic hook (which
				// logs to tau.log); skip its partial results and leave a trace
				// in the dev console instead of silently dropping them.
				Err(_) => {
					eprintln!("pi-gui: session scan worker panicked (see tau.log)");
				}
			}
		}
		out.into_iter().flatten().collect()
	})
}

fn collect_sessions(dir: &Path, out: &mut Vec<PiSessionInfo>) {
	let mut files = Vec::new();
	session_files(dir, &mut files, 0);
	let infos = par_map(files, |path| {
		let meta = std::fs::metadata(path).ok();
		let scan = scan_session(path, 400);
		PiSessionInfo {
			path: path.to_string_lossy().into_owned(),
			name: file_stem(path),
			project: scan.project,
			title: if scan.title.is_empty() {
				file_stem(path)
			} else {
				scan.title
			},
			model: scan.model,
			created_at: scan.created_at,
			message_count: scan.message_count,
			mtime_ms: meta
				.as_ref()
				.and_then(|m| m.modified().ok())
				.map(unix_ms)
				.unwrap_or(0),
			size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
		}
	});
	out.extend(infos);
}

fn parse_message_blocks(message: &serde_json::Value) -> Vec<PiParsedBlock> {
	let content = message.get("content").and_then(|x| x.as_array());
	let mut blocks = Vec::new();
	if let Some(items) = content {
		for item in items {
			let kind = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
			match kind {
				"text" => {
					if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
						blocks.push(PiParsedBlock {
							kind: "text".into(),
							text: text.to_string(),
							name: None,
						});
					}
				}
				"thinking" => {
					if let Some(text) = item.get("thinking").and_then(|x| x.as_str()) {
						blocks.push(PiParsedBlock {
							kind: "thinking".into(),
							text: text.to_string(),
							name: None,
						});
					}
				}
				"toolCall" | "tool_call" | "toolUse" => {
					let name = item
						.get("name")
						.and_then(|x| x.as_str())
						.unwrap_or("tool")
						.to_string();
					let args = item
						.get("arguments")
						.or_else(|| item.get("input"))
						.map(|a| {
							if a.is_string() {
								a.as_str().unwrap_or_default().to_string()
							} else {
								serde_json::to_string_pretty(a).unwrap_or_default()
							}
						})
						.unwrap_or_default();
					blocks.push(PiParsedBlock {
						kind: "tool".into(),
						text: args,
						name: Some(name),
					});
				}
				_ => {}
			}
		}
	}
	blocks
}

fn read_session_messages(path: &Path) -> Vec<PiParsedMessage> {
	let mut out = Vec::new();
	let file = match File::open(path) {
		Ok(f) => f,
		Err(_) => return out,
	};
	let reader = BufReader::new(file);
	for line in LimitedLines::new(reader, MAX_JSONL_LINE).flatten() {
		if line.trim().is_empty() {
			continue;
		}
		let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
			continue;
		};
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		match kind {
			"message" => {
				let Some(msg) = v.get("message") else {
					continue;
				};
				let role = msg
					.get("role")
					.and_then(|x| x.as_str())
					.unwrap_or("assistant")
					.to_string();
				let timestamp = v
					.get("timestamp")
					.and_then(|x| x.as_str())
					.map(|s| s.to_string());
				let entry_id = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
				let blocks = parse_message_blocks(msg);
				out.push(PiParsedMessage {
					role,
					timestamp,
					entry_id,
					blocks,
				});
			}
			"tool_result" => {
				let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
				let text = v
					.get("content")
					.and_then(|x| x.as_str())
					.unwrap_or("")
					.to_string();
				out.push(PiParsedMessage {
					role: "tool".into(),
					timestamp: None,
					entry_id: None,
					blocks: vec![PiParsedBlock {
						kind: "tool".into(),
						text: if text.len() > 8000 {
							format!(
								"{}…",
								&text[..text
									.char_indices()
									.nth(8000)
									.map(|(i, _)| i)
									.unwrap_or(text.len())]
							)
						} else {
							text
						},
						name: Some(name.to_string()),
					}],
				});
			}
			_ => {}
		}
	}
	out
}

#[tauri::command]
fn pi_binary() -> Result<PiBinaryInfo, String> {
	probe_pi().ok_or_else(|| {
		"pi binary not found. Install pi via npm (https://github.com/earendil-works/pi) or set PI_BIN to the pi executable or its cli.js entrypoint.".into()
	})
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command payload maps 1:1 to args
fn pi_start(
	window: WebviewWindow,
	state: State<'_, PiState>,
	workspace: String,
	session_file: Option<String>,
	fork_of: Option<String>,
	session_name: Option<String>,
	system_prompt: Option<String>,
	tools: Option<Vec<String>>,
	models: Option<String>,
	excluded_tools: Option<Vec<String>>,
	append_system_prompt: Option<String>,
) -> Result<(), String> {
	let info = probe_pi().ok_or("pi binary not found")?;
	let label = window.label().to_string();
	// Conflict check + detach the window's previous process (if any) while
	// holding the lock — but only the detach; the actual kill happens after
	// the lock is released (kill() waits for the child to exit, which would
	// otherwise block every other window's RPC commands).
	let old: Option<PiProcess> = {
		let mut map = lock_state(&state.inner);
		// One pi process per session file: reject a second window opening the
		// same JSONL (concurrent appends would corrupt it). Compare canonicalized
		// paths so alternate spellings (symlinks, `..`, Windows `\\?\` prefixes)
		// can't bypass the guard.
		if let Some(sf) = session_file.as_deref() {
			let full = canonical_or(Path::new(sf));
			if map.values().any(|p| {
				p.session_file
					.as_deref()
					.is_some_and(|s| canonical_or(s) == full)
			}) {
				return Err("session is already open in another window".into());
			}
		}
		// Detach this window's previous process and reserve the session slot in
		// the SAME critical section as the check above. Without the reservation a
		// second window could pass the check after we release the lock but before
		// spawn() registers the child below, and both would append to the file.
		let old = map.remove(&label);
		if let Some(sf) = session_file.as_deref() {
			let placeholder = PiProcess {
				session_file: Some(canonical_or(Path::new(sf))),
				..Default::default()
			};
			map.insert(label.clone(), placeholder);
		}
		old
	};
	if let Some(mut old) = old {
		old.kill();
	}
	crate::runtime_log::log_info(
		window.app_handle(),
		&format!(
			"pi_start window={label} workspace={workspace} session={} fork={} tools={}",
			session_file.as_deref().unwrap_or("<new>"),
			fork_of.as_deref().unwrap_or(""),
			tools
				.as_deref()
				.map(|t| t.join(","))
				.unwrap_or_else(|| "default".into()),
		),
	);
	let mut map = lock_state(&state.inner);
	let entry = map.entry(label.clone()).or_default();
	entry.spawn(
		&info,
		&workspace,
		session_file.as_deref(),
		fork_of.as_deref(),
		session_name.as_deref(),
		system_prompt.as_deref(),
		append_system_prompt.as_deref(),
		tools.as_deref(),
		excluded_tools.as_deref(),
		models.as_deref(),
		state.inner.clone(),
		label,
		&window,
	)
}

#[tauri::command]
fn pi_stop(window: WebviewWindow, state: State<'_, PiState>) -> Result<(), String> {
	let label = window.label().to_string();
	// Remove the process under the lock, then kill it after the lock is
	// released: kill() waits for the child to exit, and doing that while
	// holding the map lock would stall every other window's RPC commands.
	let proc = lock_state(&state.inner).remove(&label);
	if let Some(mut p) = proc {
		p.kill();
	}
	Ok(())
}

/// JSON-RPC command types the GUI is allowed to forward to pi. Anything else
/// is rejected — a compromised webview can't drive the pi pipe beyond this
/// set (defense in depth on top of the CSP).
const ALLOWED_RPC_TYPES: &[&str] = &[
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_bash",
	"abort_retry",
	"new_session",
	"compact",
	"set_model",
	"cycle_model",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_models",
	"get_state",
	"get_available_thinking_levels",
	"set_session_name",
	"switch_session",
	"fork",
	"clone",
	"get_messages",
	"get_session_stats",
	"get_commands",
	"set_auto_retry",
	"set_auto_compaction",
	"set_steering_mode",
	"set_follow_up_mode",
	"bash",
	"get_tree",
	"get_entries",
	"get_fork_messages",
	"get_last_assistant_text",
	"extension_ui_response",
];

#[tauri::command]
fn pi_send(window: WebviewWindow, state: State<'_, PiState>, command: Value) -> Result<(), String> {
	let kind = command.get("type").and_then(|x| x.as_str()).unwrap_or("");
	if !ALLOWED_RPC_TYPES.contains(&kind) {
		return Err(format!("unknown pi command type: {kind}"));
	}
	let label = window.label().to_string();
	// Take the stdin handle out of the map so the write doesn't hold the global
	// process-map lock: a blocked write (pi busy, pipe buffer full) would
	// otherwise stall every other window's RPC commands.
	let mut stdin = {
		let mut map = lock_state(&state.inner);
		let p = map.get_mut(&label).ok_or("pi is not running")?;
		p.stdin.take().ok_or("pi is not running")?
	};
	let mut line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
	line.push('\n');
	let result = stdin
		.write_all(line.as_bytes())
		.and_then(|_| stdin.flush())
		.map_err(|e| format!("failed to write to pi stdin: {e}"));
	// Restore the handle (best-effort): only if the process wasn't replaced in
	// the meantime (a replaced process already has its own stdin set).
	let mut map = lock_state(&state.inner);
	if let Some(p) = map.get_mut(&label) {
		if p.stdin.is_none() {
			p.stdin = Some(stdin);
		}
	}
	result
}

#[tauri::command]
fn pi_status(window: WebviewWindow, state: State<'_, PiState>) -> Result<PiStatus, String> {
	let label = window.label().to_string();
	let map = lock_state(&state.inner);
	// A window that never started pi (fresh multi-window) reports idle
	// instead of an error so the frontend startup probe stays clean.
	let Some(p) = map.get(&label) else {
		return Ok(PiStatus {
			running: false,
			workspace: None,
			session_file: None,
		});
	};
	Ok(PiStatus {
		running: p.child.is_some(),
		workspace: p
			.workspace
			.as_ref()
			.map(|p| p.to_string_lossy().into_owned()),
		session_file: p
			.session_file
			.as_ref()
			.map(|p| p.to_string_lossy().into_owned()),
	})
}

/// Runs a blocking closure on the dedicated blocking thread pool so the UI
/// thread is never frozen while scanning session files or running the pi
/// CLI. (Sync Tauri commands run on the main thread — every window would
/// freeze while a large session directory is scanned.)
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, String> + Send + 'static,
{
	tauri::async_runtime::spawn_blocking(f)
		.await
		.map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn pi_list_sessions() -> Result<Vec<PiSessionInfo>, String> {
	run_blocking(|| {
		let mut out = Vec::new();
		collect_sessions(&default_session_dir(), &mut out);
		out.sort_by_key(|x| std::cmp::Reverse(x.mtime_ms));
		Ok(out)
	})
	.await
}

#[tauri::command]
async fn pi_read_session(path: String) -> Result<Vec<PiParsedMessage>, String> {
	let p = require_session_path(Path::new(&path))?;
	run_blocking(move || Ok(read_session_messages(&p))).await
}

#[tauri::command]
async fn pi_search_sessions(
	query: String,
	limit: Option<usize>,
) -> Result<Vec<PiSearchHit>, String> {
	let query = query.trim().to_lowercase();
	if query.is_empty() {
		return Ok(Vec::new());
	}
	let limit = limit.unwrap_or(50).min(200);
	run_blocking(move || {
		let mut hits = Vec::new();
		let mut sessions = Vec::new();
		collect_sessions(&default_session_dir(), &mut sessions);
		// Newest first, so the `limit` break below fires on recent sessions
		// before re-opening old files for snippet extraction.
		sessions.sort_by_key(|x| std::cmp::Reverse(x.mtime_ms));
		for session in sessions {
			if hits.len() >= limit {
				break;
			}
			let title_hit = session.title.to_lowercase().contains(&query);
			let mut snippet_hit = String::new();
			if !title_hit {
				if let Some(snippet) = search_snippet(&PathBuf::from(&session.path), &query) {
					snippet_hit = snippet;
				}
			}
			if title_hit || !snippet_hit.is_empty() {
				hits.push(PiSearchHit {
					path: session.path,
					title: session.title,
					project: session.project,
					snippet: if title_hit {
						String::new()
					} else {
						snippet_hit
					},
					updated_at: session.mtime_ms,
				});
			}
		}
		hits.sort_by_key(|x| std::cmp::Reverse(x.updated_at));
		Ok(hits)
	})
	.await
}

/// Find the first line containing the query (case-insensitive) and return a
/// short snippet of message text around it.
fn search_snippet(path: &Path, query: &str) -> Option<String> {
	let file = File::open(path).ok()?;
	let reader = BufReader::new(file);
	for line in LimitedLines::new(reader, MAX_JSONL_LINE).flatten() {
		// Case-insensitive search is bounded by the line cap above; lines
		// beyond it (base64 image blobs) are skipped rather than lowercased.
		if line.to_lowercase().contains(query) {
			let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
				continue;
			};
			if v.get("type").and_then(|x| x.as_str()) != Some("message") {
				continue;
			}
			let text = extract_block_text(v.pointer("/message/content")).unwrap_or_default();
			let lower = text.to_lowercase();
			if let Some(idx) = lower.find(query) {
				let start = idx.saturating_sub(40);
				let end = (idx + query.len() + 80).min(text.len());
				if start >= text.len() {
					continue;
				}
				let mut snippet = text[start..end].to_string();
				if start > 0 {
					snippet.insert(0, '…');
				}
				if end < text.len() {
					snippet.push('…');
				}
				return Some(snippet);
			}
		}
	}
	None
}

fn move_to(target_dir: &Path, from: &Path, to: &Path) -> Result<(), String> {
	let original = from.to_string_lossy().into_owned();
	std::fs::rename(from, to).map_err(|e| format!("failed to move session: {e}"))?;
	let meta_path = target_dir.join(format!(
		"{}.meta",
		to.file_name().unwrap_or_default().to_string_lossy()
	));
	let meta = serde_json::json!({ "originalPath": original });
	let _ = std::fs::write(
		&meta_path,
		serde_json::to_string_pretty(&meta).unwrap_or_default(),
	);
	Ok(())
}

fn move_with_sidecar(path: &Path, target_dir: &Path) -> Result<(), String> {
	let file_name = path
		.file_name()
		.ok_or_else(|| "invalid session path".to_string())?;
	if !path.exists() {
		return Err(format!("session not found: {}", path.display()));
	}
	std::fs::create_dir_all(target_dir).map_err(|e| format!("failed to create dir: {e}"))?;
	let target = target_dir.join(file_name);
	if target.exists() {
		let stem = path
			.file_stem()
			.unwrap_or_default()
			.to_string_lossy()
			.into_owned();
		let stamp = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_millis())
			.unwrap_or(0);
		let renamed = target_dir.join(format!("{stem}-{stamp}.jsonl"));
		move_to(target_dir, path, &renamed)
	} else {
		move_to(target_dir, path, &target)
	}
}

fn meta_original_path(dir: &Path, file_name: &str) -> Option<String> {
	let meta_path = dir.join(format!("{file_name}.meta"));
	let content = std::fs::read_to_string(meta_path).ok()?;
	let v: serde_json::Value = serde_json::from_str(&content).ok()?;
	v.get("originalPath")
		.and_then(|x| x.as_str())
		.map(|s| s.to_string())
}

/// Move a session file into the archive (or trash) directory with its
/// original-path sidecar. The path must already be validated as a session
/// file; the command wrapper adds running-session and boundary checks.
fn move_session_to_aux(path: &Path, target_dir: &Path) -> Result<(), String> {
	let full = std::fs::canonicalize(path)
		.map_err(|e| format!("session not found: {}: {e}", path.display()))?;
	let archive = canonical_dir(&archive_dir());
	let trash = canonical_dir(&trash_dir());
	if archive.as_ref().is_some_and(|d| full.starts_with(d))
		|| trash.as_ref().is_some_and(|d| full.starts_with(d))
	{
		return Err("session is already archived".into());
	}
	move_with_sidecar(&full, target_dir)
}

#[tauri::command]
fn pi_archive_session(state: State<'_, PiState>, path: String) -> Result<(), String> {
	let p = require_session_path(Path::new(&path))?;
	if is_running_session(&state, &p) {
		return Err("stop the running session before archiving it".into());
	}
	move_session_to_aux(&p, &archive_dir())
}

#[tauri::command]
fn pi_delete_session(state: State<'_, PiState>, path: String) -> Result<(), String> {
	let p = require_session_path(Path::new(&path))?;
	if is_running_session(&state, &p) {
		return Err("stop the running session before deleting it".into());
	}
	move_session_to_aux(&p, &trash_dir())
}

/// Recursively blank the `data` payload of image content blocks; returns the
/// number of images stripped.
fn strip_image_data(v: &mut serde_json::Value) -> usize {
	let mut n = 0;
	match v {
		serde_json::Value::Object(map) => {
			if map.get("type").and_then(|x| x.as_str()) == Some("image") {
				if let Some(data) = map.get_mut("data") {
					if data.as_str().is_some_and(|s| !s.is_empty()) {
						*data = serde_json::Value::String(String::new());
						n += 1;
					}
				}
			}
			for (_, child) in map.iter_mut() {
				n += strip_image_data(child);
			}
		}
		serde_json::Value::Array(arr) => {
			for child in arr.iter_mut() {
				n += strip_image_data(child);
			}
		}
		_ => {}
	}
	n
}

/// Recursively cap string values at `max` chars, so a pathological event line
/// (e.g. a tool result delivered as one multi-MB delta) is never serialized and
/// pushed to the webview at its full size — the UI degrades gracefully.
fn cap_strings(v: &mut serde_json::Value, max: usize) {
	match v {
		serde_json::Value::String(s) => {
			if s.len() > max {
				if let Some((cut, _)) = s.char_indices().nth(max) {
					s.truncate(cut);
					s.push('…');
				}
			}
		}
		serde_json::Value::Array(arr) => {
			for child in arr.iter_mut() {
				cap_strings(child, max);
			}
		}
		serde_json::Value::Object(map) => {
			for (_, child) in map.iter_mut() {
				cap_strings(child, max);
			}
		}
		_ => {}
	}
}

/// Compact a session file: replace base64 image payloads with an empty
/// placeholder so long-lived sessions with attachments stop ballooning. The
/// session must not be running (pi may be appending to it concurrently).
/// Runs on the blocking pool — a session with hundreds of MB of image data
/// takes a moment to rewrite.
fn compact_session_images_inner(p: &Path) -> Result<serde_json::Value, String> {
	let before = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
	let tmp_path = p.with_extension(format!("jsonl.{}.tmp", unique_suffix()));
	let mut removed = 0usize;
	{
		let file = File::open(p).map_err(|e| format!("failed to read session: {e}"))?;
		let mut reader = BufReader::new(file);
		let mut writer = std::io::BufWriter::new(
			File::create(&tmp_path).map_err(|e| format!("failed to create temp file: {e}"))?,
		);
		let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
		loop {
			buf.clear();
			let mut limited = (&mut reader).take((MAX_JSONL_LINE + 1) as u64);
			let n = limited
				.read_until(b'\n', &mut buf)
				.map_err(|e| format!("failed to read session: {e}"))?;
			if n == 0 {
				break;
			}
			if n > MAX_JSONL_LINE {
				// Oversized line (typically a huge base64 image message): copy
				// it through verbatim without parsing so the session is never
				// corrupted and memory stays bounded, then drain the rest of
				// the line.
				writer
					.write_all(&buf)
					.map_err(|e| format!("failed to write session: {e}"))?;
				loop {
					buf.clear();
					let mut sink = (&mut reader).take(64 * 1024);
					let m = sink
						.read_until(b'\n', &mut buf)
						.map_err(|e| format!("failed to read session: {e}"))?;
					if m == 0 || buf.last() == Some(&b'\n') {
						break;
					}
				}
				continue;
			}
			// Strip the trailing line separator before parsing; the parsed
			// line is written back with a single "\n".
			let mut line = buf.as_slice();
			if line.last() == Some(&b'\n') {
				line = &line[..line.len() - 1];
			}
			if line.last() == Some(&b'\r') {
				line = &line[..line.len() - 1];
			}
			match serde_json::from_slice::<serde_json::Value>(line) {
				Ok(mut v) => {
					removed += strip_image_data(&mut v);
					writer
						.write_all(
							serde_json::to_string(&v)
								.map_err(|e| format!("failed to serialize session: {e}"))?
								.as_bytes(),
						)
						.map_err(|e| format!("failed to write session: {e}"))?;
					writer
						.write_all(b"\n")
						.map_err(|e| format!("failed to write session: {e}"))?;
				}
				Err(_) => {
					// Unparseable line: keep it byte-for-byte (with its
					// original line ending).
					writer
						.write_all(&buf)
						.map_err(|e| format!("failed to write session: {e}"))?;
				}
			}
		}
		writer
			.flush()
			.map_err(|e| format!("failed to write session: {e}"))?;
	}
	if removed == 0 {
		let _ = std::fs::remove_file(&tmp_path);
		return Ok(serde_json::json!({
			"ok": true,
			"removed": 0,
			"before": before,
			"after": before
		}));
	}
	std::fs::rename(&tmp_path, p).map_err(|e| format!("failed to persist session: {e}"))?;
	let after = std::fs::metadata(p).map(|m| m.len()).unwrap_or(before);
	Ok(serde_json::json!({
		"ok": true,
		"removed": removed,
		"before": before,
		"after": after
	}))
}

#[tauri::command]
async fn pi_compact_session_images(
	state: State<'_, PiState>,
	path: String,
) -> Result<serde_json::Value, String> {
	let p = require_session_path(Path::new(&path))?;
	if is_running_session(&state, &p) {
		return Err("stop the running session before compacting it".into());
	}
	run_blocking(move || compact_session_images_inner(&p)).await
}

#[tauri::command]
fn pi_list_archived_sessions() -> Result<Vec<PiArchivedSession>, String> {
	let mut out = Vec::new();
	for dir in [archive_dir(), trash_dir()] {
		let Ok(entries) = std::fs::read_dir(&dir) else {
			continue;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			if path.extension().is_some_and(|ext| ext == "jsonl") {
				let meta = entry.metadata().ok();
				let file_name = path
					.file_name()
					.unwrap_or_default()
					.to_string_lossy()
					.into_owned();
				let original = meta_original_path(&dir, &file_name).unwrap_or_default();
				let scan = scan_session(&path, 200);
				out.push(PiArchivedSession {
					path: path.to_string_lossy().into_owned(),
					original_path: original,
					title: if scan.title.is_empty() {
						file_stem(&path)
					} else {
						scan.title
					},
					project: scan.project,
					mtime_ms: meta
						.as_ref()
						.and_then(|m| m.modified().ok())
						.map(unix_ms)
						.unwrap_or(0),
					size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
				});
			}
		}
	}
	out.sort_by_key(|x| std::cmp::Reverse(x.mtime_ms));
	Ok(out)
}

#[tauri::command]
fn pi_restore_session(path: String) -> Result<(), String> {
	let path = PathBuf::from(&path);
	let full = std::fs::canonicalize(&path)
		.map_err(|e| format!("session not found: {}: {e}", path.display()))?;
	let in_archive = canonical_dir(&archive_dir()).is_some_and(|d| full.starts_with(&d));
	let in_trash = canonical_dir(&trash_dir()).is_some_and(|d| full.starts_with(&d));
	if !in_archive && !in_trash {
		return Err("only archived/trashed sessions can be restored".into());
	}
	let target_dir = if in_archive {
		archive_dir()
	} else {
		trash_dir()
	};
	let file_name = full
		.file_name()
		.ok_or_else(|| "invalid session path".to_string())?;
	let original = meta_original_path(&target_dir, &file_name.to_string_lossy());
	// The original path recorded in the sidecar must stay inside the sessions
	// directory (compare against the canonical base so `..` tricks don't work).
	let base = canonical_dir(&aux_root());
	let restore_to = original
		.map(PathBuf::from)
		.filter(|p| base.as_ref().is_some_and(|b| p.starts_with(b)))
		.unwrap_or_else(|| aux_root().join(file_name));
	if restore_to.exists() {
		// A file already lives at the original location; move it aside INSIDE
		// the sessions directory (previous code used a relative path, which
		// silently moved the session next to the app's cwd).
		let stamp = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_millis())
			.unwrap_or(0);
		let stem = restore_to
			.file_stem()
			.unwrap_or_default()
			.to_string_lossy()
			.into_owned();
		let renamed = restore_to.with_file_name(format!("{stem}-{stamp}.jsonl"));
		std::fs::rename(&restore_to, &renamed)
			.map_err(|e| format!("failed to move existing session aside: {e}"))?;
	}
	if let Some(parent) = restore_to.parent() {
		let _ = std::fs::create_dir_all(parent);
	}
	std::fs::rename(&full, &restore_to).map_err(|e| format!("failed to restore session: {e}"))?;
	let _ = std::fs::remove_file(target_dir.join(format!("{}.meta", file_name.to_string_lossy())));
	Ok(())
}

#[tauri::command]
fn pi_purge_session(path: String) -> Result<(), String> {
	let path = PathBuf::from(&path);
	let full = std::fs::canonicalize(&path)
		.map_err(|e| format!("session not found: {}: {e}", path.display()))?;
	let in_archive = canonical_dir(&archive_dir()).is_some_and(|d| full.starts_with(&d));
	let in_trash = canonical_dir(&trash_dir()).is_some_and(|d| full.starts_with(&d));
	if !(in_archive || in_trash) {
		return Err("only archived/trashed sessions can be purged".into());
	}
	std::fs::remove_file(&full).map_err(|e| format!("failed to delete session: {e}"))?;
	let meta_path = full.with_extension("jsonl.meta");
	let _ = std::fs::remove_file(meta_path);
	Ok(())
}

#[tauri::command]
fn pi_reveal_session(path: String) -> Result<(), String> {
	let path = require_session_path(Path::new(&path))?;
	#[cfg(target_os = "windows")]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x08000000;
		let _ = Command::new("explorer")
			.arg(format!("/select,{}", path.display()))
			.creation_flags(CREATE_NO_WINDOW)
			.spawn();
		Ok(())
	}
	#[cfg(target_os = "macos")]
	{
		let _ = Command::new("open")
			.args(["-R", &path.to_string_lossy()])
			.spawn();
		Ok(())
	}
	#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
	{
		let parent = path.parent().unwrap_or(&path);
		let _ = Command::new("xdg-open").arg(parent).spawn();
		Ok(())
	}
}

#[tauri::command]
async fn pi_export_chat(
	app: AppHandle,
	session_path: String,
	markdown: Option<String>,
	format: String,
) -> Result<serde_json::Value, String> {
	use tauri_plugin_dialog::DialogExt;

	let path = require_session_path(Path::new(&session_path))?;
	let default_name = path
		.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or("session")
		.to_string();
	let ext = if format == "jsonl" { "jsonl" } else { "md" };
	let default_path = path
		.parent()
		.unwrap_or_else(|| Path::new("."))
		.join(format!("{default_name}.{ext}"));

	let picked = app
		.dialog()
		.file()
		.set_file_name(format!("{default_name}.{ext}"))
		.add_filter(if ext == "jsonl" { "JSONL" } else { "Markdown" }, &[ext])
		.set_directory(default_path.parent().unwrap_or(Path::new(".")))
		.blocking_save_file();
	let Some(picked) = picked else {
		return Ok(serde_json::json!({ "ok": true, "canceled": true }));
	};
	let target = match picked {
		tauri_plugin_dialog::FilePath::Path(p) => p,
		tauri_plugin_dialog::FilePath::Url(_) => {
			return Err("unsupported save location".into());
		}
	};

	// Copy/write on the blocking pool: a multi-hundred-MB session copy must
	// not freeze the UI thread.
	let result_target = target.clone();
	run_blocking(move || {
		if format == "jsonl" {
			std::fs::copy(&path, &result_target)
				.map_err(|e| format!("failed to copy session: {e}"))?;
		} else {
			std::fs::write(&result_target, markdown.unwrap_or_default())
				.map_err(|e| format!("failed to write export: {e}"))?;
		}
		Ok(())
	})
	.await?;
	Ok(serde_json::json!({
		"ok": true,
		"canceled": false,
		"path": target.to_string_lossy().into_owned()
	}))
}

/// Export a session JSONL to a styled HTML file via `pi --export` (one-shot
/// CLI run; the running RPC session is untouched). The save dialog stays on
/// the UI thread; the pi CLI run moves to the blocking pool.
#[tauri::command]
async fn pi_export_html(app: AppHandle, session_path: String) -> Result<serde_json::Value, String> {
	use tauri_plugin_dialog::DialogExt;

	let path = require_session_path(Path::new(&session_path))?;
	let default_name = path
		.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or("session")
		.to_string();
	let default_path = path
		.parent()
		.unwrap_or_else(|| Path::new("."))
		.join(format!("{default_name}.html"));

	let picked = app
		.dialog()
		.file()
		.set_file_name(format!("{default_name}.html"))
		.add_filter("HTML", &["html"])
		.set_directory(default_path.parent().unwrap_or(Path::new(".")))
		.blocking_save_file();
	let Some(picked) = picked else {
		return Ok(serde_json::json!({ "ok": true, "canceled": true }));
	};
	let target = match picked {
		tauri_plugin_dialog::FilePath::Path(p) => p,
		tauri_plugin_dialog::FilePath::Url(_) => {
			return Err("unsupported save location".into());
		}
	};

	run_blocking(move || {
		let info = probe_pi().ok_or("pi binary not found")?;
		let mut cmd = pi_command(&info);
		cmd.arg("--export")
			.arg(&path)
			.arg(&target)
			.arg("--offline")
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		#[cfg(windows)]
		{
			use std::os::windows::process::CommandExt;
			const CREATE_NO_WINDOW: u32 = 0x08000000;
			cmd.creation_flags(CREATE_NO_WINDOW);
		}
		let out = cmd.output().map_err(|e| format!("failed to run pi: {e}"))?;
		if !out.status.success() {
			let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
			return Err(if stderr.is_empty() {
				String::from_utf8_lossy(&out.stdout).trim().to_string()
			} else {
				stderr
			});
		}
		if !target.exists() {
			return Err("pi did not produce an export file".into());
		}
		Ok(serde_json::json!({
			"ok": true,
			"canceled": false,
			"path": target.to_string_lossy().into_owned()
		}))
	})
	.await
}

/// List files under a project for `@` file-reference completion. Skips heavy
/// generated directories (node_modules, .git, target, dist, …) and caps the
/// walk so the picker stays fast even in huge repos. Returns relative paths
/// with forward slashes; directories end with "/".
const SKIP_DIRS: &[&str] = &[
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
const MAX_PROJECT_FILES: usize = 8000;

#[tauri::command]
async fn pi_project_files(project: String) -> Result<Vec<String>, String> {
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

/// Sanitize a working directory into pi's per-project session folder name:
/// `--<cwd with [/\\:] -> ->--` (matches pi's session-manager layout).
fn session_project_dir_name(cwd: &str) -> String {
	let trimmed = cwd.trim_start_matches(['/', '\\']);
	format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

/// Import a session from an external JSONL file: pick it with a native file
/// dialog, then copy it into the sessions directory under the project folder
/// matching its header `cwd` (created on demand). Returns the new session
/// path so the frontend can open it.
#[tauri::command]
async fn pi_import_session(app: AppHandle) -> Result<Option<String>, String> {
	use tauri_plugin_dialog::DialogExt;

	let picked = app
		.dialog()
		.file()
		.add_filter("Pi session (JSONL)", &["jsonl", "json"])
		.blocking_pick_file();
	let Some(picked) = picked else {
		return Ok(None);
	};
	let src = match picked {
		tauri_plugin_dialog::FilePath::Path(p) => p,
		tauri_plugin_dialog::FilePath::Url(_) => return Err("unsupported file location".into()),
	};
	// Read the header to learn the cwd (project) and id/timestamp for naming.
	let mut cwd: Option<String> = None;
	let mut session_id: Option<String> = None;
	let mut timestamp: Option<String> = None;
	{
		let Ok(file) = File::open(&src) else {
			return Err(format!("cannot read file: {}", src.display()));
		};
		let reader = BufReader::new(file);
		for line in LimitedLines::new(reader, MAX_JSONL_LINE).flatten() {
			if line.trim().is_empty() {
				continue;
			}
			if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
				if v.get("type").and_then(|x| x.as_str()) == Some("session") {
					cwd = v.get("cwd").and_then(|x| x.as_str()).map(|s| s.to_string());
					session_id = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
					timestamp = v
						.get("timestamp")
						.and_then(|x| x.as_str())
						.map(|s| s.to_string());
				}
				if cwd.is_some() {
					break;
				}
			}
		}
	}
	let project = cwd.unwrap_or_else(|| "unknown".to_string());
	let dir_name = session_project_dir_name(&project);
	let target_dir = default_session_dir().join(dir_name);
	std::fs::create_dir_all(&target_dir)
		.map_err(|e| format!("failed to create session dir: {e}"))?;
	// `<ISO timestamp with : . -> ->_<8-hex id>.jsonl` — same shape pi uses.
	let ts = timestamp
		.unwrap_or_default()
		// Also strip path separators so a crafted header timestamp can't
		// escape the sessions directory (path traversal via `../`).
		.replace([':', '.', '/', '\\'], "-")
		.trim_end_matches('Z')
		.to_string();
	let ts = if ts.is_empty() {
		let now = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_millis())
			.unwrap_or(0);
		format!("session-{now}")
	} else {
		ts
	};
	let id8 = session_id
		.unwrap_or_default()
		.chars()
		.filter(|c| c.is_ascii_hexdigit())
		.take(8)
		.collect::<String>();
	let id8 = if id8.is_empty() {
		format!("{:08x}", std::process::id())
	} else {
		id8
	};
	let file_name = format!("{ts}_{id8}.jsonl");
	let target = target_dir.join(&file_name);
	if target.exists() {
		return Err(format!(
			"a session with this name already exists: {file_name}"
		));
	}
	// Copy on the blocking pool: a large session file must not freeze the UI
	// thread (the header read above is bounded, but the copy is not).
	let result_target = target.clone();
	run_blocking(move || {
		std::fs::copy(&src, &result_target).map_err(|e| format!("failed to import session: {e}"))
	})
	.await?;
	Ok(Some(target.to_string_lossy().into_owned()))
}

/// Share the current session as a private GitHub gist (the TUI's `/share`):
/// requires the `gh` CLI to be installed and logged in. Exports the session
/// to HTML via `pi --export`, uploads it with `gh gist create --private`,
/// and returns the gist URL.
#[tauri::command]
async fn pi_share_session(session_path: String) -> Result<String, String> {
	let path = require_session_path(Path::new(&session_path))?;
	run_blocking(move || {
		// 1. gh installed + logged in?
		let auth = no_console_window(
			Command::new("gh")
				.args(["auth", "status"])
				.stdout(Stdio::null())
				.stderr(Stdio::null()),
		)
		.output();
		match auth {
			Err(_) => return Err("GitHub CLI (gh) 未安装，请先安装 https://cli.github.com/".into()),
			Ok(out) if !out.status.success() => {
				return Err("GitHub CLI 未登录，请先运行 `gh auth login`".into())
			}
			Ok(_) => {}
		}
		// 2. Export to a temp HTML file.
		let tmp = std::env::temp_dir().join(format!("tau-share-{}.html", unique_suffix()));
		let _ = std::fs::remove_file(&tmp);
		let info = probe_pi().ok_or("pi binary not found")?;
		let mut export = pi_command(&info);
		export.arg("--export").arg(&path).arg(&tmp).arg("--offline");
		#[cfg(windows)]
		{
			use std::os::windows::process::CommandExt;
			const CREATE_NO_WINDOW: u32 = 0x08000000;
			export.creation_flags(CREATE_NO_WINDOW);
		}
		let out = export
			.output()
			.map_err(|e| format!("failed to run pi --export: {e}"))?;
		if !out.status.success() {
			return Err(format!(
				"export failed: {}",
				String::from_utf8_lossy(&out.stderr).trim()
			));
		}
		// 3. Create the private gist and read its html_url.
		let gist = no_console_window(
			Command::new("gh")
				.args(["gist", "create", "--private"])
				.arg(&tmp)
				.stdout(Stdio::piped())
				.stderr(Stdio::piped()),
		)
		.output()
		.map_err(|e| format!("failed to run gh gist create: {e}"))?;
		let _ = std::fs::remove_file(&tmp);
		if !gist.status.success() {
			return Err(format!(
				"gist creation failed: {}",
				String::from_utf8_lossy(&gist.stderr).trim()
			));
		}
		// gh prints the gist URL on stdout; also try to extract html_url from
		// the JSON payload (gh prints it when --json isn't given; be tolerant).
		let text = String::from_utf8_lossy(&gist.stdout).trim().to_string();
		let url = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
			v.get("html_url")
				.or_else(|| v.get("url"))
				.and_then(|x| x.as_str())
				.map(|s| s.to_string())
		} else {
			// Fall back to the first URL-looking token on stdout.
			text.split_whitespace()
				.find(|t| t.starts_with("http"))
				.map(|s| s.to_string())
		};
		url.ok_or_else(|| "无法解析 gist URL".into())
	})
	.await
}

/// Fallback tree source: build a slim session tree straight from the JSONL
/// file, bypassing the pi process entirely. Used when the RPC `get_tree` is
/// slow or unavailable (busy/old pi). Returns the same shape as the slimmed
/// get_tree response: `{ tree: [...], leafId }`. The leaf is approximated by
/// the last entry in the file (the RPC path remains authoritative for it).
/// Build a slim session tree straight from a session JSONL file.
/// Build one tree node (and its whole subtree) with an explicit-stack
/// post-order walk. Identical shape to the slimmed get_tree nodes; the
/// frame budget (2x entry count) guards against cyclic parent links in
/// corrupt session files.
/// Maximum depth of the output tree. Deeper chains are truncated (entries
/// beyond the limit become leaves). Keeping the output shallow matters:
/// serde_json's Serialize and Drop are recursive, so a thousands-level
/// Value would overflow the worker stack on the way out.
const MAX_TREE_DEPTH: usize = 512;

fn build_tree_node_iter(
	root_id: &str,
	by_id: &HashMap<String, Value>,
	children: &HashMap<String, Vec<String>>,
	labels: &HashMap<String, String>,
) -> Value {
	struct Frame {
		id: String,
		map: serde_json::Map<String, Value>,
		idx: usize,
		depth: usize,
	}
	let mut stack = vec![Frame {
		id: root_id.to_string(),
		map: serde_json::Map::new(),
		idx: 0,
		depth: 0,
	}];
	let mut completed: Vec<Value> = Vec::new();
	let max_frames = by_id.len().saturating_mul(2) + 8;
	let mut frames = 0usize;
	while let Some(frame) = stack.pop() {
		frames += 1;
		if frames > max_frames {
			break;
		}
		let kids = children.get(&frame.id).cloned().unwrap_or_default();
		let count = kids.len();
		if frame.idx < count && frame.depth < MAX_TREE_DEPTH {
			stack.push(Frame {
				id: frame.id.clone(),
				map: frame.map,
				idx: frame.idx + 1,
				depth: frame.depth,
			});
			stack.push(Frame {
				id: kids[frame.idx].clone(),
				map: serde_json::Map::new(),
				idx: 0,
				depth: frame.depth + 1,
			});
		} else {
			let mut map = frame.map;
			let mut child_nodes = Vec::with_capacity(count);
			for _ in 0..count {
				if let Some(k) = completed.pop() {
					child_nodes.push(k);
				}
			}
			child_nodes.reverse();
			map.insert("children".to_string(), Value::Array(child_nodes));
			if let Some(e) = by_id.get(&frame.id) {
				map.insert("entry".to_string(), e.clone());
			}
			if let Some(l) = labels.get(&frame.id) {
				map.insert("label".to_string(), serde_json::json!(l));
			}
			completed.push(Value::Object(map));
		}
	}
	completed
		.pop()
		.unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}

fn read_tree_from_file(p: &Path) -> Result<serde_json::Value, String> {
	let file = File::open(p).map_err(|e| format!("cannot read session: {e}"))?;
	let reader = BufReader::new(file);
	let mut by_id: HashMap<String, Value> = HashMap::new();
	let mut children: HashMap<String, Vec<String>> = HashMap::new();
	let mut labels: HashMap<String, String> = HashMap::new();
	let mut roots: Vec<String> = Vec::new();
	let mut last_id: Option<String> = None;
	for line in LimitedLines::new(reader, MAX_JSONL_LINE).flatten() {
		if line.trim().is_empty() {
			continue;
		}
		let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
			continue;
		};
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		if kind == "session" {
			continue;
		}
		let Some(id) = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()) else {
			continue;
		};
		if kind == "label" {
			// Label entries are not tree nodes and never the leaf.
			if let Some(target) = v.get("targetId").and_then(|x| x.as_str()) {
				if let Some(label) = v.get("label").and_then(|x| x.as_str()) {
					labels.insert(target.to_string(), label.to_string());
				}
			}
			continue;
		}
		last_id = Some(id.clone());

		// Same slim shape the get_tree forwarder produces.
		let slim = slim_tree_node(&serde_json::json!({ "entry": v, "children": [] }));
		if let Some(entry) = slim.get("entry").cloned() {
			by_id.insert(id.clone(), entry);
		}
		match v.get("parentId").and_then(|x| x.as_str()) {
			Some(parent) if !parent.is_empty() => {
				children.entry(parent.to_string()).or_default().push(id);
			}
			_ => roots.push(id),
		}
	}
	let tree = Value::Array(
		roots
			.iter()
			.map(|r| build_tree_node_iter(r, &by_id, &children, &labels))
			.collect(),
	);
	Ok(serde_json::json!({ "tree": tree, "leafId": last_id }))
}

#[tauri::command]
async fn pi_read_tree(path: String) -> Result<serde_json::Value, String> {
	let p = require_session_path(Path::new(&path))?;
	run_blocking(move || read_tree_from_file(&p)).await
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

fn trust_file_path() -> PathBuf {
	agent_dir().join("trust.json")
}

fn settings_file_path() -> PathBuf {
	agent_dir().join("settings.json")
}

fn read_json_map(path: &Path) -> serde_json::Map<String, serde_json::Value> {
	let Ok(content) = std::fs::read_to_string(path) else {
		return serde_json::Map::new();
	};
	serde_json::from_str(&content).unwrap_or_default()
}

/// Serializes trust/settings read-modify-write so concurrent calls can't
/// clobber each other (mirrors AUTH_MUTEX for auth.json in extras.rs).
static TRUST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn write_json_map(
	path: &Path,
	map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
	if let Some(dir) = path.parent() {
		let _ = std::fs::create_dir_all(dir);
	}
	let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
	// Atomic write (tmp + rename): a torn write would corrupt the JSON and
	// silently drop trust decisions (pi itself also reads/writes these files).
	let tmp = path.with_extension("json.tmp");
	std::fs::write(&tmp, raw).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
	std::fs::rename(&tmp, path).map_err(|e| format!("failed to persist {}: {e}", path.display()))
}

/// Nearest saved decision for a directory, walking up its parents (mirrors
/// pi's findNearestTrustEntry). Keys are stored as-is (absolute paths).
fn find_nearest_trust(
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
fn pi_trust_get(project: String) -> Result<Option<bool>, String> {
	let map = read_json_map(&trust_file_path());
	Ok(find_nearest_trust(&map, Path::new(&project)))
}

/// decision: Some(true) = trust, Some(false) = deny, None = clear the entry.
#[tauri::command]
fn pi_trust_set(project: String, decision: Option<bool>) -> Result<(), String> {
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
fn pi_trust_default_get() -> Result<String, String> {
	let map = read_json_map(&settings_file_path());
	Ok(map
		.get("defaultProjectTrust")
		.and_then(|x| x.as_str())
		.unwrap_or("ask")
		.to_string())
}

#[tauri::command]
fn pi_trust_default_set(value: String) -> Result<(), String> {
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
#[tauri::command]
async fn pi_external_edit(text: Option<String>) -> Result<String, String> {
	run_blocking(move || {
		// Unique name (pid + nanos): avoids concurrent-edit collisions and the
		// predictable-path symlink race a fixed `tau-editor-{pid}.md` invites.
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let tmp =
			std::env::temp_dir().join(format!("tau-editor-{}-{unique}.md", std::process::id()));
		std::fs::write(&tmp, text.unwrap_or_default())
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
			no_console_window(&mut cmd).status()
		} else {
			#[cfg(target_os = "macos")]
			{
				Command::new("open")
					.args(["-W", "-a", "TextEdit"])
					.arg(&tmp)
					.status()
			}
			#[cfg(not(target_os = "macos"))]
			{
				let mut cmd = Command::new(if cfg!(windows) { "notepad.exe" } else { "nano" });
				cmd.arg(&tmp);
				#[cfg(windows)]
				no_console_window(&mut cmd);
				cmd.status()
			}
		};
		let result = std::fs::read_to_string(&tmp);
		let _ = std::fs::remove_file(&tmp);
		match (status, result) {
			(Ok(s), Ok(content)) if s.success() => Ok(content),
			(Ok(s), Ok(_)) => Err(format!("editor exited with status {s}")),
			(Ok(_), Err(e)) => Err(format!("failed to read draft back: {e}")),
			(Err(e), _) => Err(format!("failed to launch editor: {e}")),
		}
	})
	.await
}

// ===================================================================
// llama.cpp router (/llama): thin HTTP proxy to llama-server via curl.
// The webview CSP forbids direct fetches, so all calls go through here.
// ===================================================================
fn run_curl(args: &[String], timeout_secs: u32) -> Result<String, String> {
	let mut cmd = Command::new("curl");
	cmd.args(["-s", "-m", &timeout_secs.to_string()])
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	no_console_window(&mut cmd);
	let out = cmd
		.output()
		.map_err(|e| format!("curl unavailable: {e}（管理 llama.cpp 需要 curl）"))?;
	if !out.status.success() {
		let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
		let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
		return Err(if !stderr.is_empty() {
			stderr
		} else if !stdout.is_empty() {
			stdout
		} else {
			format!("curl exited with status {}", out.status)
		});
	}
	Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn llama_curl_args(
	url: &str,
	api_key: &Option<String>,
	suffix: &str,
) -> Result<(Vec<String>, Option<PathBuf>), String> {
	// Only allow http(s) URLs and never one that could be parsed as a curl
	// option: curl would otherwise accept `-o`, `-K`, `--config`, `file://`…
	// (argument injection / SSRF) from a user-supplied router address.
	let trimmed = url.trim();
	if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
		return Err("llama.cpp router URL must start with http:// or https://".into());
	}
	let mut args = Vec::new();
	if let Some(k) = api_key.as_deref().filter(|k| !k.is_empty()) {
		args.push("-H".to_string());
		args.push(format!("Authorization: Bearer {k}"));
	}
	// `--` terminates option parsing so the URL is always treated as a
	// positional argument even if it contained a leading `-`.
	args.push("--".to_string());
	args.push(format!("{trimmed}{suffix}"));
	Ok((args, None))
}

#[tauri::command]
async fn pi_llama_models(url: String, api_key: Option<String>) -> Result<Vec<String>, String> {
	run_blocking(move || {
		let (args, _) = llama_curl_args(&url, &api_key, "/v1/models")?;
		let body = run_curl(&args, 10)?;
		let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
			format!(
				"unexpected router response: {e} — {}",
				body.chars().take(160).collect::<String>()
			)
		})?;
		let ids = v
			.get("models")
			.and_then(|m| m.as_array())
			.map(|arr| {
				arr.iter()
					.filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
					.collect::<Vec<_>>()
			})
			.unwrap_or_default();
		Ok(ids)
	})
	.await
}

#[tauri::command]
async fn pi_llama_load(url: String, api_key: Option<String>, name: String) -> Result<(), String> {
	run_blocking(move || {
		let (mut args, _) = llama_curl_args(&url, &api_key, "/v1/load")?;
		args.insert(0, "-X".to_string());
		args.insert(1, "POST".to_string());
		args.insert(2, "-H".to_string());
		args.insert(3, "Content-Type: application/json".to_string());
		let body = serde_json::json!({ "name": name }).to_string();
		let tmp = std::env::temp_dir().join(format!("tau-llama-{}.json", unique_suffix()));
		std::fs::write(&tmp, &body).map_err(|e| format!("failed to write request: {e}"))?;
		let mut data_args = vec!["-d".to_string(), format!("@{}", tmp.display())];
		data_args.append(&mut args);
		let result = run_curl(&data_args, 300);
		let _ = std::fs::remove_file(&tmp);
		result.map(|_| ())
	})
	.await
}

#[tauri::command]
async fn pi_llama_unload(url: String, api_key: Option<String>, name: String) -> Result<(), String> {
	run_blocking(move || {
		let (mut args, _) = llama_curl_args(&url, &api_key, "/v1/unload")?;
		args.insert(0, "-X".to_string());
		args.insert(1, "POST".to_string());
		args.insert(2, "-H".to_string());
		args.insert(3, "Content-Type: application/json".to_string());
		let body = serde_json::json!({ "name": name }).to_string();
		let tmp = std::env::temp_dir().join(format!("tau-llama-{}.json", unique_suffix()));
		std::fs::write(&tmp, &body).map_err(|e| format!("failed to write request: {e}"))?;
		let mut data_args = vec!["-d".to_string(), format!("@{}", tmp.display())];
		data_args.append(&mut args);
		let result = run_curl(&data_args, 300);
		let _ = std::fs::remove_file(&tmp);
		result.map(|_| ())
	})
	.await
}

/// Keep only the fields the tree viewer needs, dropping tool outputs,
/// thinking blocks, image data and usage records. Text content is kept as a
/// short preview so node labels still make sense.
fn slim_tree_node(root: &Value) -> Value {
	// Iterative post-order DFS with an explicit stack. Sessions are linear
	// chains thousands of entries deep; recursion would overflow the 2 MB
	// worker stack (observed: STATUS_STACK_OVERFLOW on a 1000-level session).
	let mut stack: Vec<(&Value, serde_json::Map<String, Value>, usize)> =
		vec![(root, serde_json::Map::new(), 0)];
	let mut completed: Vec<Value> = Vec::new();
	while let Some((node, mut map, idx)) = stack.pop() {
		let children = node.get("children").and_then(|x| x.as_array());
		let count = children.map(|c| c.len()).unwrap_or(0);
		if idx < count {
			stack.push((node, map, idx + 1));
			stack.push((&children.unwrap()[idx], serde_json::Map::new(), 0));
		} else {
			let mut kids = Vec::with_capacity(count);
			for _ in 0..count {
				if let Some(k) = completed.pop() {
					kids.push(k);
				}
			}
			kids.reverse();
			map.insert("children".to_string(), Value::Array(kids));
			if let Some(entry) = node.get("entry") {
				let mut e = serde_json::Map::new();
				for key in [
					"type",
					"id",
					"parentId",
					"timestamp",
					"provider",
					"modelId",
					"thinkingLevel",
					"name",
					"customType",
					"fromId",
				] {
					if let Some(x) = entry.get(key) {
						e.insert(key.to_string(), x.clone());
					}
				}
				if let Some(summary) = entry.get("summary").and_then(|x| x.as_str()) {
					e.insert(
						"summary".to_string(),
						serde_json::json!(summary.chars().take(400).collect::<String>()),
					);
				}
				if let Some(m) = entry.get("message") {
					let mut mm = serde_json::Map::new();
					for key in ["role", "toolName", "model", "provider", "customType"] {
						if let Some(x) = m.get(key) {
							mm.insert(key.to_string(), x.clone());
						}
					}
					if let Some(content) = m.get("content") {
						let preview = tree_text_preview(content, 400);
						if !preview.is_empty() {
							mm.insert("content".to_string(), serde_json::json!(preview));
						}
					}
					e.insert("message".to_string(), Value::Object(mm));
				}
				map.insert("entry".to_string(), Value::Object(e));
			}
			for key in ["label", "labelTimestamp"] {
				if let Some(x) = node.get(key) {
					map.insert(key.to_string(), x.clone());
				}
			}
			completed.push(Value::Object(map));
		}
	}
	completed
		.pop()
		.unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}

/// Concatenate text/thinking blocks up to `max` chars (what the tree labels
/// show); drops tool-call arguments, image data and everything else.
fn tree_text_preview(content: &Value, max: usize) -> String {
	let mut s = String::new();
	if let Some(arr) = content.as_array() {
		for b in arr {
			let text = match b.get("type").and_then(|x| x.as_str()) {
				Some("text") => b.get("text").and_then(|x| x.as_str()),
				Some("thinking") => b.get("thinking").and_then(|x| x.as_str()),
				_ => None,
			};
			if let Some(t) = text {
				s.push_str(t);
				if s.chars().count() >= max {
					break;
				}
			}
		}
	} else if let Some(t) = content.as_str() {
		s.push_str(t);
	}
	s.chars().take(max).collect()
}

/// Rewrite a `get_tree` response payload: keep the envelope (id/type/command/
/// success/error) plus a slimmed `data.tree` and `data.leafId`.
fn slim_get_tree_payload(payload: &Value) -> Value {
	let is_tree_response = payload.get("type").and_then(|x| x.as_str()) == Some("response")
		&& payload.get("command").and_then(|x| x.as_str()) == Some("get_tree");
	if !is_tree_response {
		return payload.clone();
	}
	let mut out = serde_json::Map::new();
	for key in ["id", "type", "command", "success", "error"] {
		if let Some(x) = payload.get(key) {
			out.insert(key.to_string(), x.clone());
		}
	}
	if let Some(data) = payload.get("data") {
		let mut d = serde_json::Map::new();
		if let Some(tree) = data.get("tree").and_then(|x| x.as_array()) {
			d.insert(
				"tree".to_string(),
				Value::Array(tree.iter().map(slim_tree_node).collect()),
			);
		}
		if let Some(leaf) = data.get("leafId") {
			d.insert("leafId".to_string(), leaf.clone());
		}
		out.insert("data".to_string(), Value::Object(d));
	}
	Value::Object(out)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUsageEntry {
	date: String,
	provider: String,
	model: String,
	project: Option<String>,
	session_path: String,
	input: u64,
	output: u64,
	cache_read: u64,
	reasoning: u64,
	total: u64,
	cost: f64,
}

/// Scan every session JSONL for LLM `usage` records (one per assistant
/// message). The frontend aggregates by day/model/project for the usage
/// dashboard.
/// Scan one session file for LLM `usage` records (one per assistant message).
fn usage_from_file(path: &Path) -> Vec<PiUsageEntry> {
	let mut out = Vec::new();
	let Ok(file) = File::open(path) else {
		return out;
	};
	let reader = BufReader::new(file);
	let mut project: Option<String> = None;
	for line in LimitedLines::new(reader, MAX_JSONL_LINE).flatten() {
		if line.trim().is_empty() {
			continue;
		}
		let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
			continue;
		};
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		match kind {
			"session" => {
				project = v
					.get("cwd")
					.and_then(|x| x.as_str())
					.filter(|s| !s.is_empty())
					.map(|s| s.to_string());
			}
			"message" => {
				let Some(usage) = v.pointer("/message/usage") else {
					continue;
				};
				let date = v
					.get("timestamp")
					.and_then(|x| x.as_str())
					.map(|s| s.chars().take(10).collect::<String>())
					.unwrap_or_default();
				let provider = v
					.pointer("/message/provider")
					.and_then(|x| x.as_str())
					.unwrap_or("")
					.to_string();
				let model = v
					.pointer("/message/model")
					.and_then(|x| x.as_str())
					.unwrap_or("")
					.to_string();
				let num = |key: &str| usage.get(key).and_then(|x| x.as_u64()).unwrap_or(0);
				let cost = usage
					.pointer("/cost/total")
					.and_then(|x| x.as_f64())
					.unwrap_or(0.0);
				out.push(PiUsageEntry {
					date,
					provider,
					model,
					project: project.clone(),
					session_path: path.to_string_lossy().into_owned(),
					input: num("input"),
					output: num("output"),
					cache_read: num("cacheRead"),
					reasoning: num("reasoning"),
					total: usage
						.get("totalTokens")
						.and_then(|x| x.as_u64())
						.unwrap_or(0),
					cost,
				});
			}
			_ => {}
		}
	}
	out
}

/// Scan every session JSONL for LLM `usage` records (one per assistant
/// message). The frontend aggregates by day/model/project for the usage
/// dashboard. Files are scanned on worker threads so a large session set
/// doesn't block the UI thread.
fn collect_usage(dir: &Path, out: &mut Vec<PiUsageEntry>) {
	let mut files = Vec::new();
	session_files(dir, &mut files, 0);
	let entries = par_map(files, usage_from_file);
	out.extend(entries.into_iter().flatten());
}

#[tauri::command]
async fn pi_usage_stats() -> Result<Vec<PiUsageEntry>, String> {
	run_blocking(|| {
		let mut out = Vec::new();
		collect_usage(&default_session_dir(), &mut out);
		Ok(out)
	})
	.await
}

#[tauri::command]
fn pi_open_workspace(app: AppHandle) -> Result<Option<String>, String> {
	use tauri_plugin_dialog::DialogExt;
	let picked = app.dialog().file().blocking_pick_folder();
	Ok(picked.map(|p| p.to_string()))
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
	builder
		.manage(PiState::default())
		.invoke_handler(tauri::generate_handler![
			pi_new_window,
			pi_binary,
			pi_start,
			pi_stop,
			pi_send,
			pi_status,
			pi_export_chat,
			pi_export_html,
			pi_project_files,
			pi_import_session,
			pi_share_session,
			pi_read_tree,
			pi_external_edit,
			pi_trust_get,
			pi_trust_set,
			pi_trust_default_get,
			pi_trust_default_set,
			pi_llama_models,
			pi_llama_load,
			pi_llama_unload,
			pi_usage_stats,
			pi_compact_session_images,
			pi_list_sessions,
			pi_open_workspace,
			pi_read_session,
			pi_search_sessions,
			pi_archive_session,
			pi_delete_session,
			pi_list_archived_sessions,
			pi_restore_session,
			pi_purge_session,
			pi_reveal_session,
			crate::extras::pi_auth_status,
			crate::extras::pi_auth_set_key,
			crate::extras::pi_auth_remove,
			crate::extras::pi_providers,
			crate::extras::git_branch_state,
			crate::extras::git_checkout_branch,
			crate::extras::git_create_branch,
			crate::extras::pi_packages,
			crate::extras::pi_package_install,
			crate::extras::pi_package_remove,
			crate::extras::pi_installed_skills,
			crate::extras::pi_move_session,
			crate::rebuild_menu,
			crate::log_frontend,
		])
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;

	fn write_temp_session(name: &str, lines: &[&str]) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("pi-gui-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join(format!("{name}.jsonl"));
		let mut file = File::create(&path).unwrap();
		for line in lines {
			writeln!(file, "{line}").unwrap();
		}
		path
	}

	#[test]
	fn builds_tree_from_file() {
		let dir = std::env::temp_dir().join(format!("tau-tree-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("tree.jsonl");
		{
			use std::io::Write;
			let mut f = File::create(&path).unwrap();
			writeln!(f, "{}", r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"C:/tmp"}"#).unwrap();
			writeln!(f, "{}", r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#).unwrap();
			writeln!(f, "{}", r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-12T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"reply"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}]}}"#).unwrap();
			writeln!(f, "{}", r#"{"type":"message","id":"a2","parentId":"u1","timestamp":"2026-08-12T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"other branch"}]}}"#).unwrap();
			writeln!(f, "{}", r#"{"type":"label","id":"l1","parentId":"a1","timestamp":"2026-08-12T00:00:04.000Z","targetId":"a1","label":"checkpoint"}"#).unwrap();
		}
		let out = read_tree_from_file(&path).unwrap();
		let tree = out["tree"].as_array().unwrap();
		assert_eq!(tree.len(), 1, "single root");
		assert_eq!(tree[0]["entry"]["id"], "u1");
		assert_eq!(
			tree[0]["children"].as_array().unwrap().len(),
			2,
			"two branches"
		);
		assert_eq!(tree[0]["children"][0]["entry"]["id"], "a1");
		assert_eq!(tree[0]["children"][0]["label"], "checkpoint");
		// Tool-call args dropped; content collapsed to a plain text preview.
		assert!(tree[0]["children"][0]["entry"]["message"]["content"].is_string());
		assert_eq!(
			tree[0]["children"][0]["entry"]["message"]["content"],
			"reply"
		);
		assert_eq!(out["leafId"], "a2", "leaf approximated by last entry");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn deep_chains_do_not_overflow_the_stack() {
		// A 5000-level linear chain used to blow the worker stack. The file
		// builder is iterative AND depth-limited, so the output Value stays
		// shallow enough for serde_json's recursive serialize/drop.
		let dir = std::env::temp_dir().join(format!("tau-deep-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("deep.jsonl");
		{
			use std::io::Write;
			let mut f = File::create(&path).unwrap();
			writeln!(f, "{}", r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"C:/tmp"}"#).unwrap();
			for i in 0..5000 {
				let parent = if i == 0 {
					"null".to_string()
				} else {
					format!(r#""n{}""#, i - 1)
				};
				writeln!(f, "{}", format!(r#"{{"type":"message","id":"n{i}","parentId":{parent},"timestamp":"2026-08-12T00:00:00.000Z","message":{{"role":"user","content":[{{"type":"text","text":"x"}}]}}}}"#)).unwrap();
			}
		}
		let out = read_tree_from_file(&path).unwrap();
		assert_eq!(out["tree"][0]["entry"]["id"], "n0");
		assert_eq!(out["leafId"], "n4999");
		// The chain is truncated at MAX_TREE_DEPTH so the nested Value stays
		// shallow enough to serialize and drop safely.
		let mut node = &out["tree"][0];
		let mut depth = 1;
		while let Some(kids) = node["children"].as_array() {
			if kids.is_empty() {
				break;
			}
			node = &kids[0];
			depth += 1;
			assert!(depth <= MAX_TREE_DEPTH + 2, "depth exceeded limit");
		}
		assert!(
			depth >= MAX_TREE_DEPTH - 1,
			"expected the chain to reach the limit, got {depth}"
		);
		// Serialize the result — recursive in serde_json — must not overflow.
		let text = serde_json::to_string(&out).unwrap();
		assert!(text.len() > 1000);
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn slims_get_tree_responses() {
		let raw = serde_json::json!({
			"id": "gui-1",
			"type": "response",
			"command": "get_tree",
			"success": true,
			"data": {
				"leafId": "a1",
				"tree": [{
					"entry": {
						"type": "message",
						"id": "a1",
						"parentId": null,
						"timestamp": "2026-08-10T06:31:15.165Z",
						"message": {
							"role": "assistant",
							"model": "m1",
							"content": [
								{"type": "thinking", "thinking": "internal reasoning..."},
								{"type": "text", "text": "Hello world"},
								{"type": "toolCall", "id": "t1", "name": "bash", "arguments": {"command": "ls"}}
							],
							"usage": {"input": 1, "output": 1}
						}
					},
					"children": [{
						"entry": {
							"type": "message",
							"id": "r1",
							"parentId": "a1",
							"message": {
								"role": "toolResult",
								"toolName": "bash",
								"content": [{"type": "text", "text": "huge output..."}]
							}
						},
						"children": []
					}],
					"label": "checkpoint"
				}]
			}
		});
		let slim = slim_get_tree_payload(&raw);
		// Envelope preserved.
		assert_eq!(slim["command"], "get_tree");
		assert_eq!(slim["data"]["leafId"], "a1");
		// Tree structure + label kept.
		let node = &slim["data"]["tree"][0];
		assert_eq!(node["entry"]["id"], "a1");
		assert_eq!(node["label"], "checkpoint");
		assert_eq!(node["children"][0]["entry"]["message"]["toolName"], "bash");
		// Content collapsed to a text preview; heavy fields dropped.
		assert_eq!(
			node["entry"]["message"]["content"],
			"internal reasoning...Hello world"
		);
		assert!(node["entry"]["message"].get("usage").is_none());
		// The content is now a plain string — no block array, no toolCall/thinking.
		assert!(node["entry"]["message"]["content"].is_string());
		assert!(slim.to_string().len() < 500);
	}

	#[test]
	fn parses_tool_result_messages() {
		let path = write_temp_session(
			"scan-toolresult",
			&[
				r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo hi"}}]}}"#,
				r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-10T06:31:16.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"hi\n"}]}}"#,
			],
		);
		let messages = read_session_messages(&path);
		assert_eq!(messages.len(), 2);
		assert_eq!(messages[1].role, "toolResult");
		assert_eq!(messages[1].blocks.len(), 1);
		assert_eq!(messages[1].blocks[0].kind, "text");
		assert_eq!(messages[1].blocks[0].text, "hi\n");
		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn scans_session_header_and_title() {
		let path = write_temp_session(
			"scan-header",
			&[
				r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:\\projects\\demo"}"#,
				r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-08-10T06:31:02.438Z","provider":"kimi-coding","modelId":"k3"}"#,
				r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-08-10T06:31:10.660Z","message":{"role":"user","content":[{"type":"text","text":"Fix the flaky test in the auth module please"}]}}"#,
				r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"internal note"},{"type":"text","text":"Done."}]}}"#,
			],
		);
		let scan = scan_session(&path, 400);
		assert_eq!(scan.project.as_deref(), Some("D:\\projects\\demo"));
		assert_eq!(scan.model.as_deref(), Some("kimi-coding/k3"));
		assert_eq!(scan.message_count, 2);
		assert!(scan.title.contains("Fix the flaky test"));
		assert!(scan.created_at.is_some());

		let messages = read_session_messages(&path);
		assert_eq!(messages.len(), 2);
		assert_eq!(messages[0].role, "user");
		assert_eq!(messages[0].blocks.len(), 1);
		assert_eq!(messages[0].blocks[0].kind, "text");
		assert_eq!(messages[1].role, "assistant");
		assert_eq!(messages[1].blocks.len(), 2);
		assert_eq!(messages[1].blocks[0].kind, "thinking");
		assert_eq!(messages[1].blocks[1].kind, "text");
	}

	#[test]
	fn collects_usage_records() {
		let dir = std::env::temp_dir().join(format!("pi-gui-usage-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("usage.jsonl");
		let mut file = File::create(&path).unwrap();
		writeln!(file, "{}", r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"D:\\proj"}"#).unwrap();
		writeln!(file, "{}", r#"{"type":"message","id":"a1","timestamp":"2026-08-12T01:00:00.000Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-v4","usage":{"input":100,"output":50,"cacheRead":200,"reasoning":10,"totalTokens":360,"cost":{"total":0.001}}}}"#).unwrap();
		writeln!(file, "{}", r#"{"type":"message","id":"a2","timestamp":"2026-08-13T01:00:00.000Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-v4","usage":{"input":10,"output":5,"cacheRead":0,"reasoning":0,"totalTokens":15,"cost":{"total":0.0001}}}}"#).unwrap();
		writeln!(file, "{}", r#"{"type":"message","id":"u1","timestamp":"2026-08-13T02:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#).unwrap();

		let mut out = Vec::new();
		collect_usage(&dir, &mut out);
		assert_eq!(out.len(), 2);
		assert_eq!(out[0].date, "2026-08-12");
		assert_eq!(out[0].provider, "deepseek");
		assert_eq!(out[0].model, "deepseek-v4");
		assert_eq!(out[0].project.as_deref(), Some("D:\\proj"));
		assert_eq!(out[0].total, 360);
		assert_eq!(out[0].input, 100);
		assert_eq!(out[0].cache_read, 200);
		assert!((out[0].cost - 0.001).abs() < 1e-9);
		assert_eq!(out[1].total, 15);

		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn resolves_npm_command_shims() {
		let dir = std::env::temp_dir().join(format!("pi-gui-shim-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		std::fs::write(
			dir.join("pi.cmd"),
			"@ECHO off\r\n\
			 GOTO start\r\n\
			 :start\r\n\
			 SETLOCAL\r\n\
			 IF EXIST \"%dp0%\\node.exe\" (SET \"_prog=%dp0%\\node.exe\") ELSE (SET \"_prog=node\")\r\n\
			 endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\pkg\\dist\\cli.js\" %*\r\n",
		)
		.unwrap();
		let (node, script) = resolve_shim_target(&dir.join("pi.cmd")).unwrap();
		assert_eq!(node, PathBuf::from("node"));
		assert_eq!(
			script,
			dir.join("node_modules")
				.join("pkg")
				.join("dist")
				.join("cli.js")
		);
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[cfg(not(windows))]
	#[test]
	fn resolves_unix_js_symlink_shims() {
		// Simulate an npm global install layout: `prefix/bin/pi` is a symlink to
		// the package's dist/cli.js. probe_candidate must resolve it to
		// node + script instead of relying on the `#!/usr/bin/env node` shebang,
		// which cannot resolve node when the GUI inherits a minimal PATH.
		let Some(node) = find_node(None) else {
			eprintln!("node not found on this machine — skipping");
			return;
		};
		let dir = std::env::temp_dir().join(format!("pi-gui-unix-shim-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let bin = dir.join("bin");
		let dist = dir
			.join("lib")
			.join("node_modules")
			.join("pkg")
			.join("dist");
		std::fs::create_dir_all(&bin).unwrap();
		std::fs::create_dir_all(&dist).unwrap();
		let script = dist.join("cli.js");
		std::fs::write(&script, "console.log('1.2.3-test');\n").unwrap();
		std::os::unix::fs::symlink(&script, bin.join("pi")).unwrap();
		let info = probe_candidate(&bin.join("pi").to_string_lossy()).unwrap();
		assert_eq!(info.version, "1.2.3-test");
		let (node_bin, script_bin) = info.direct.as_ref().unwrap();
		assert_eq!(Path::new(node_bin), node);
		assert_eq!(Path::new(script_bin), script.canonicalize().unwrap());
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Finder/LaunchServices launches a .app with a minimal PATH
	/// (/usr/bin:/bin:/usr/sbin:/sbin) that contains neither pi nor node.
	/// The probe must still find a pi that lives in one of the well-known
	/// npm-global / nvm / brew roots, resolve its symlink-to-JS shim, and
	/// pick a node able to run it. Skipped when no node is installed at all
	/// (then pi could never run either way).
	#[cfg(not(windows))]
	#[test]
	fn probe_finds_pi_with_minimal_path_via_known_locations() {
		if find_node(None).is_none() {
			eprintln!("no node found — skipping");
			return;
		}
		let _g = ENV_GUARD.lock().unwrap();
		let old_path = std::env::var_os("PATH");
		let old_pi_bin = std::env::var_os("PI_BIN");
		std::env::remove_var("PI_BIN");
		// Minimal Finder-like PATH, plus a non-existent dir to prove the
		// probe cannot be succeeding through PATH resolution.
		std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
		let info = probe_pi_uncached();
		match old_pi_bin {
			Some(v) => std::env::set_var("PI_BIN", v),
			None => std::env::remove_var("PI_BIN"),
		}
		match old_path {
			Some(v) => std::env::set_var("PATH", v),
			None => std::env::remove_var("PATH"),
		}
		let Some(info) = info else {
			eprintln!("pi not installed in a known location on this machine — skipping");
			return;
		};
		// Must launch node + cli.js directly: the shebang can't resolve node
		// under the minimal PATH.
		assert!(info.direct.is_some(), "expected node+script direct launch");
		assert!(!info.version.is_empty());
	}

	#[test]
	fn parses_iso_timestamps_with_leap_days() {
		// 2024-02-29 (leap year) vs 2023-02-28: exactly one year apart.
		let leap = parse_iso_ms("2024-02-29T00:00:00.000Z").unwrap();
		let prev = parse_iso_ms("2023-02-28T00:00:00.000Z").unwrap();
		assert_eq!(leap - prev, 366 * 86400 * 1000);
		// A non-leap Feb 29 must be rejected.
		assert!(parse_iso_ms("2023-02-29T00:00:00.000Z").is_none());
		// Out-of-range dates and clock values must be rejected.
		assert!(parse_iso_ms("2024-04-31T00:00:00.000Z").is_none());
		assert!(parse_iso_ms("2024-13-01T00:00:00.000Z").is_none());
		assert!(parse_iso_ms("2024-01-01T24:00:00.000Z").is_none());
		assert!(parse_iso_ms("2024-01-01T00:60:00.000Z").is_none());
		// Sub-second precision is ignored (both resolve to the same ms).
		assert_eq!(
			parse_iso_ms("2024-01-01T00:00:00.123Z"),
			parse_iso_ms("2024-01-01T00:00:00.999Z")
		);
	}

	#[test]
	fn parses_tool_calls_and_search_snippets() {
		let path = write_temp_session(
			"scan-tools",
			&[
				r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:\\projects\\demo"}"#,
				r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-10T06:31:10.660Z","message":{"role":"user","content":[{"type":"text","text":"hello world unique-token-xyz"}]}}"#,
				r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo hi"}},{"type":"text","text":"ran it"}]}}"#,
			],
		);
		let messages = read_session_messages(&path);
		assert_eq!(messages[1].blocks[0].kind, "tool");
		assert_eq!(messages[1].blocks[0].name.as_deref(), Some("bash"));
		assert!(messages[1].blocks[0].text.contains("echo hi"));

		let snippet = search_snippet(&path, "unique-token-xyz").unwrap();
		assert!(snippet.contains("unique-token-xyz"));

		let _ = std::fs::remove_file(&path);
	}

	/// Exercises the session-dir boundary checks against a temp session dir
	/// (PI_SESSION_DIR is process-global, so all scenarios run in one test).
	#[test]
	fn session_commands_enforce_boundaries() {
		// Env is process-global and cargo runs tests in parallel — hold the
		// shared guard for the whole env-mutating section.
		let _guard = ENV_GUARD.lock().unwrap();
		let old_session_dir = std::env::var_os("PI_SESSION_DIR");
		let old_pi_bin = std::env::var_os("PI_BIN");
		let dir = std::env::temp_dir().join(format!("pi-gui-sess-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_SESSION_DIR", &dir);
		std::env::remove_var("PI_BIN");

		let session = dir.join("abc.jsonl");
		std::fs::write(
			&session,
			"{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"cwd\":\"D:\\\\demo\"}\n",
		)
		.unwrap();

		// require_session_path: inside is fine, outside is rejected.
		// (canonicalize returns `\\?\`-prefixed paths on Windows)
		let full = require_session_path(&session).unwrap();
		assert_eq!(full.file_name().and_then(|n| n.to_str()), Some("abc.jsonl"));
		assert!(full.starts_with(std::fs::canonicalize(&dir).unwrap()));
		let outside = std::env::temp_dir().join(format!("pi-gui-outside-{}", std::process::id()));
		std::fs::write(&outside, "{}").unwrap();
		assert!(require_session_path(&outside).is_err());
		assert!(require_session_path(&dir.join("missing.jsonl")).is_err());

		// is_running_session: false by default, true when a window's process
		// state points at the file.
		let state = PiState::default();
		assert!(!is_running_session(&state, &session));
		{
			let mut map = state.inner.lock().unwrap();
			let mut proc = PiProcess::default();
			proc.session_file = Some(session.clone());
			map.insert("main".to_string(), proc);
		}
		assert!(is_running_session(&state, &session));
		state.inner.lock().unwrap().remove("main");

		// Archive: works once, rejects double-archive and the trash copy.
		move_session_to_aux(&session, &archive_dir()).unwrap();
		assert!(!session.exists());
		let archived = archive_dir().join("abc.jsonl");
		assert!(archived.exists());
		assert!(move_session_to_aux(&archived, &archive_dir()).is_err());

		// Restore: only archive/trash paths are accepted.
		assert!(pi_restore_session(outside.to_string_lossy().into_owned()).is_err());
		pi_restore_session(archived.to_string_lossy().into_owned()).unwrap();
		assert!(session.exists());
		assert!(!archived.exists());

		// Delete -> trash, then purge.
		move_session_to_aux(&session, &trash_dir()).unwrap();
		let trashed = trash_dir().join("abc.jsonl");
		assert!(trashed.exists());
		assert!(pi_purge_session(session.to_string_lossy().into_owned()).is_err());
		pi_purge_session(trashed.to_string_lossy().into_owned()).unwrap();
		assert!(!trashed.exists());

		let _ = std::fs::remove_file(&outside);
		let _ = std::fs::remove_dir_all(&dir);
		// Restore the caller's environment (best effort — a failing test
		// leaves the guard dropped but the env may keep the temp values).
		match old_session_dir {
			Some(v) => std::env::set_var("PI_SESSION_DIR", v),
			None => std::env::remove_var("PI_SESSION_DIR"),
		}
		match old_pi_bin {
			Some(v) => std::env::set_var("PI_BIN", v),
			None => std::env::remove_var("PI_BIN"),
		}
	}

	#[test]
	fn resolve_in_path_prefers_pathext_over_extensionless() {
		// npm installs BOTH an extensionless `pi` shell script and `pi.cmd`
		// next to each other. CreateProcess cannot run a shell script, so the
		// resolver must prefer the PATHEXT match — otherwise a bare
		// `Command::new("pi")` hits the script and the probe fails (the
		// original report behind this test).
		let _guard = ENV_GUARD.lock().unwrap();
		let old_path = std::env::var_os("PATH");
		let dir = std::env::temp_dir().join(format!("pi-gui-path-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		std::fs::write(dir.join("pi"), "#!/bin/sh\necho hi\n").unwrap();
		std::fs::write(dir.join("pi.cmd"), "@echo off\r\necho hi\r\n").unwrap();
		std::env::set_var("PATH", &dir);

		let resolved = resolve_in_path("pi").expect("pi should resolve via PATHEXT");
		assert!(resolved.starts_with(&dir));
		assert_eq!(
			resolved
				.file_name()
				.and_then(|n| n.to_str())
				.map(|n| n.to_ascii_lowercase()),
			Some("pi.cmd".to_string())
		);

		let _ = std::fs::remove_dir_all(&dir);
		match old_path {
			Some(v) => std::env::set_var("PATH", v),
			None => std::env::remove_var("PATH"),
		}
	}

	#[test]
	fn limited_lines_skips_oversized_lines() {
		let path = std::env::temp_dir().join(format!("pi-gui-lines-test-{}", std::process::id()));
		let mut file = File::create(&path).unwrap();
		writeln!(file, "small-a").unwrap();
		writeln!(file, "{}", "x".repeat(1024)).unwrap(); // oversized
		writeln!(file, "small-b").unwrap();
		drop(file);

		let file = File::open(&path).unwrap();
		let lines: Vec<String> = LimitedLines::new(BufReader::new(file), 64)
			.flatten()
			.collect();
		assert_eq!(lines, vec!["small-a".to_string(), "small-b".to_string()]);
		let _ = std::fs::remove_file(&path);
	}
}

#[cfg(test)]
mod e2e_tests {
	use super::*;
	use std::io::Write;

	/// End-to-end: spawn the real pi binary in RPC mode against a temp
	/// session, request the tree, run it through the slim layer and assert
	/// the response arrives quickly and stays small. Mirrors the exact
	/// forwarding path the GUI uses (minus the webview emit).
	#[test]
	fn e2e_get_tree_slims_responses() {
		let _g = ENV_GUARD.lock().unwrap();
		// A small but realistic session with tool output and thinking.
		let dir = std::env::temp_dir().join(format!("tau-e2e-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let session = dir.join("session.jsonl");
		{
			let mut f = File::create(&session).unwrap();
			let cwd = std::env::temp_dir().to_string_lossy().replace('\\', "/");
			writeln!(f, "{}", format!(r#"{{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"{cwd}"}}"#)).unwrap();
			writeln!(f, "{}", r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello pi"}]}}"#).unwrap();
			writeln!(f, "{}", r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-12T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"Hi!"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls -la"}}]}}"#).unwrap();
			writeln!(f, "{}", r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-12T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"total 48\ndrwxr-xr-x ..."}]}}"#).unwrap();
		}
		let Some(info) = probe_pi() else {
			eprintln!("pi binary not found in PATH — skipping e2e test");
			return;
		};
		let mut cmd = pi_command(&info);
		cmd.arg("--mode")
			.arg("rpc")
			.arg("--session")
			.arg(&session)
			.arg("--no-context-files")
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		#[cfg(windows)]
		no_console_window(&mut cmd);
		let mut child = match cmd.spawn() {
			Ok(c) => c,
			Err(e) => {
				eprintln!("failed to spawn pi: {e} — skipping");
				return;
			}
		};
		let mut stdin = child.stdin.take().unwrap();
		stdin
			.write_all(br#"{"type":"get_tree","id":"e2e-1"}"#)
			.and_then(|_| stdin.write_all(b"\n"))
			.unwrap();
		let stdout = child.stdout.take().unwrap();
		let reader = BufReader::new(stdout);
		let start = Instant::now();
		let mut got_tree = false;
		for line in LimitedLines::new(reader, MAX_EVENT_LINE) {
			let Ok(line) = line else { break };
			if line.trim().is_empty() {
				continue;
			}
			let payload: Value =
				serde_json::from_str(&line).unwrap_or_else(|_| Value::String(line));
			if payload.get("type").and_then(|x| x.as_str()) != Some("response") {
				continue;
			}
			let id = payload.get("id").and_then(|x| x.as_str()).unwrap_or("");
			if id != "e2e-1" {
				continue;
			}
			assert_eq!(
				payload.get("command").and_then(|x| x.as_str()),
				Some("get_tree")
			);
			assert_eq!(payload.get("success").and_then(|x| x.as_bool()), Some(true));
			let slim = slim_get_tree_payload(&payload);
			let slim_len = slim.to_string().len();
			let raw_len = payload.to_string().len();
			assert!(slim_len < raw_len, "slimmed response must be smaller");
			assert!(
				slim_len < 2000,
				"slimmed response should be tiny, got {slim_len}"
			);
			let tree = &slim["data"]["tree"];
			assert!(tree.is_array() && !tree.as_array().unwrap().is_empty());
			assert!(slim["data"]["leafId"].is_string(), "leafId must be present");
			got_tree = true;
			break;
		}
		assert!(got_tree, "no get_tree response arrived");
		assert!(
			start.elapsed() < Duration::from_secs(20),
			"get_tree response took {:?}",
			start.elapsed()
		);
		drop(stdin);
		let _ = child.kill();
		let _ = child.wait();
		let _ = std::fs::remove_dir_all(&dir);
	}
}
