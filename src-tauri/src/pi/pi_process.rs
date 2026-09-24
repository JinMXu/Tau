use super::session_ops::{cap_strings, slim_get_tree_payload};
use super::session_store::{canonical_or, default_session_dir, require_session_path};
use super::util::run_blocking;

use std::collections::HashMap;
use std::{
	io::{BufRead, BufReader, Write},
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

use crate::pi_session::LimitedLines;

/// One independent pi RPC process per session channel; channels are keyed
/// by `"{window_label}\u{1}{chan}"` so a single window can keep several
/// sessions running concurrently (switching away no longer kills the run).
pub struct PiState {
	pub inner: Arc<Mutex<HashMap<String, PiProcess>>>,
}

/// Map key for one session channel inside a window. `\u{1}` can never
/// appear in a window label, so `{label}\u{1}…` prefixes can't collide with
/// another window whose label merely starts with the same text.
pub fn channel_key(label: &str, chan: &str) -> String {
	format!("{label}\u{1}{chan}")
}

/// Prefix shared by every channel of one window.
pub fn window_prefix(label: &str) -> String {
	format!("{label}\u{1}")
}

/// Serializes the tests that mutate process-global env vars (PI_SESSION_DIR,
/// PI_AGENT_DIR): cargo runs tests in parallel and env is process-global, so
/// a concurrent test could observe another test's temporary values. Test-only:
/// the release build has no use for it.
#[cfg(test)]
pub(crate) static ENV_GUARD: Mutex<()> = Mutex::new(());

impl PiState {
	/// Clone of the process map handle (for window-destroy handlers that must
	/// outlive the borrowed `State`).
	pub(crate) fn handle(&self) -> Arc<Mutex<HashMap<String, PiProcess>>> {
		self.inner.clone()
	}
}

#[derive(Default)]
pub(crate) struct PiProcess {
	pub child: Option<Child>,
	pub stdin: Option<ChildStdin>,
	pub workspace: Option<PathBuf>,
	pub session_file: Option<PathBuf>,
	/// Set when the current child is stopped on purpose (`pi_stop`, or being
	/// replaced by a newer `pi_start`); the exit reader reports a crash only
	/// when the flag is still false.
	pub explicit_stop: Arc<AtomicBool>,
	/// Frontend-facing channel id (without the window-label prefix). Tagged
	/// onto every emitted event so the webview can route events per session.
	pub chan_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiBinaryInfo {
	pub(crate) bin: String,
	pub(crate) version: String,
	/// Resolved (node, cli.js) pair of the vendored runtime. Spawning node
	/// directly keeps cmd.exe from re-interpreting `&`, `|`, `%VAR%`, … inside
	/// our arguments (system prompts, session names, package sources).
	#[serde(skip)]
	pub(crate) direct: Option<(String, String)>,
	/// True when pi comes from the runtime vendored into the installer
	/// (`npm run vendor:pi`) — no system-wide pi install is required.
	#[serde(default)]
	pub(crate) builtin: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStatus {
	pub running: bool,
	pub workspace: Option<String>,
	pub session_file: Option<String>,
}

/// Cached pi probe result. Successful probes are cached for the app's
/// lifetime (pi doesn't change underneath a running app — restart to pick up
/// an upgrade). Failed probes are retried after a short backoff so a
/// late-installed pi is still picked up without paying the spawn cost on
/// every `pi_start`/`pi list` call.
pub struct ProbeCacheEntry {
	pub info: Option<PiBinaryInfo>,
	pub checked_at: Instant,
}

pub static PROBE_CACHE: Mutex<Option<ProbeCacheEntry>> = Mutex::new(None);

pub const PROBE_FAIL_RETRY: Duration = Duration::from_secs(10);

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

/// Directories that may hold the vendored pi runtime (installed by
/// `npm run vendor:pi` into `src-tauri/resources/pi-runtime` and mapped by
/// tauri.conf.json into the bundle as `<resource_dir>/pi-runtime`). Most
/// specific candidate first. `TAU_PI_RUNTIME` overrides everything.
pub(crate) fn vendored_runtime_dirs() -> Vec<PathBuf> {
	let mut dirs: Vec<PathBuf> = Vec::new();
	if let Some(env_dir) = std::env::var_os("TAU_PI_RUNTIME") {
		dirs.push(PathBuf::from(env_dir));
	}
	if let Ok(exe) = std::env::current_exe() {
		if let Some(parent) = exe.parent() {
			// Windows/Linux installs place resources next to the executable;
			// the second form covers builds that keep the `resources/` prefix.
			dirs.push(parent.join("pi-runtime"));
			dirs.push(parent.join("resources").join("pi-runtime"));
			// macOS .app: exe is Contents/MacOS/tau, resources are Contents/Resources.
			if let Some(contents) = parent.parent() {
				dirs.push(contents.join("Resources").join("pi-runtime"));
			}
		}
	}
	// Dev builds run from target/debug — fall back to the source tree layout.
	dirs.push(
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("resources")
			.join("pi-runtime"),
	);
	dirs
}

/// Vendored runtime layout inside `dir`: `node/node(.exe)` plus the
/// npm-installed pi package entry. Returns (node, cli.js) when both exist.
pub(crate) fn vendored_layout(dir: &Path) -> Option<(PathBuf, PathBuf)> {
	let node_names: &[&str] = if cfg!(windows) {
		&["node.exe", "node"]
	} else {
		&["node", "node.exe"]
	};
	let node = node_names.iter().find_map(|n| {
		let c = dir.join("node").join(n);
		c.is_file().then_some(c)
	})?;
	let cli = dir
		.join("node_modules")
		.join("@earendil-works")
		.join("pi-coding-agent")
		.join("dist")
		.join("bundle")
		.join("cli.js");
	cli.is_file().then_some((node, cli))
}

/// pi version for the vendored runtime, read from the package.json next to
/// cli.js's package root (cli.js = `<pkg>/dist/bundle/cli.js`). No process is
/// spawned: a complete vendored layout is considered usable as-is.
pub fn vendored_version(cli: &Path) -> Option<String> {
	let pkg = cli.parent()?.parent()?.parent()?;
	let raw = std::fs::read_to_string(pkg.join("package.json")).ok()?;
	let json: Value = serde_json::from_str(&raw).ok()?;
	let version = json.get("version")?.as_str()?.trim().to_string();
	(!version.is_empty()).then_some(version)
}

/// Probe the vendored runtime in `dir`: a complete (node, cli.js) layout is
/// usable, and the version comes from the package's package.json. No
/// `--version` spawn — cold first launches paid seconds of antivirus scanning
/// per probe candidate, and the vendored files are ours anyway.
pub fn probe_vendored_dir(dir: &Path) -> Option<PiBinaryInfo> {
	let (node, cli) = vendored_layout(dir)?;
	let node_s = node.to_string_lossy().into_owned();
	let cli_s = cli.to_string_lossy().into_owned();
	Some(PiBinaryInfo {
		bin: cli_s.clone(),
		version: vendored_version(&cli).unwrap_or_else(|| "unknown".to_string()),
		direct: Some((node_s, cli_s)),
		builtin: true,
	})
}

pub fn probe_pi_uncached() -> Option<PiBinaryInfo> {
	// Only the vendored runtime bundled with the installer (`npm run
	// vendor:pi`) is supported: the session host imports the pi SDK from this
	// exact tree, so a system-wide pi install can no longer substitute.
	vendored_runtime_dirs()
		.iter()
		.find_map(|dir| probe_vendored_dir(dir))
}

/// Base `Command` for launching pi through the vendored runtime. Never goes
/// through cmd.exe argument parsing: the probe already resolved node +
/// cli.js.
pub(crate) fn pi_command(info: &PiBinaryInfo) -> Command {
	if let Some((node, script)) = &info.direct {
		let mut c = Command::new(node);
		c.arg(script);
		c
	} else {
		Command::new(&info.bin)
	}
}

/// Maximum size of a single RPC event line we are willing to buffer. pi
/// sends one JSON event per line; a huge tool result can make a single line
/// tens of MB. BufRead::lines() would allocate that unboundedly — combined
/// with the webview's render spike at message_end that is exactly the OOM
/// window the crashes were reported in. Lines beyond the cap are dropped
/// (the UI degrades gracefully; the process survives).
pub const MAX_EVENT_LINE: usize = 64 * 1024 * 1024;

/// CREATE_NO_WINDOW for spawns that don't go through `no_console_window`
/// (windows-only; kept next to its use sites for readability).
#[cfg(windows)]
pub const CREATE_NO_WINDOW_KILL: u32 = 0x08000000;

/// Env for the SDK session host (resources/agent-sidecar/session-host.mjs),
/// assembled from the same launch options the old CLI flags carried. Pure so
/// the three-state tools encoding, fork-over-session priority and the prompt
/// size cap can be unit-tested without spawning anything.
#[allow(clippy::too_many_arguments)]
pub fn session_host_env(
	pkg_index: &Path,
	session_dir: &Path,
	session_file: Option<&str>,
	fork_of: Option<&str>,
	session_name: Option<&str>,
	system_prompt: Option<&str>,
	append_system_prompt: Option<&str>,
	tools: Option<&[String]>,
	excluded_tools: Option<&[String]>,
	models: Option<&str>,
	extension: Option<&Path>,
) -> Result<Vec<(String, String)>, String> {
	let mut env: Vec<(String, String)> = vec![
		(
			"TAU_PI_PKG".to_string(),
			pkg_index.to_string_lossy().into_owned(),
		),
		(
			"TAU_SESSION_DIR".to_string(),
			session_dir.to_string_lossy().into_owned(),
		),
	];
	// Fork wins over open, exactly like the old --fork / --session pair.
	if let Some(path) = fork_of {
		env.push(("TAU_FORK_OF".to_string(), path.to_string()));
	} else if let Some(path) = session_file {
		env.push(("TAU_SESSION_FILE".to_string(), path.to_string()));
	}
	if let Some(name) = session_name {
		if !name.trim().is_empty() {
			env.push(("TAU_SESSION_NAME".to_string(), name.to_string()));
		}
	}
	for (key, prompt, what) in [
		("TAU_SYSTEM_PROMPT", system_prompt, "system prompt"),
		(
			"TAU_APPEND_SYSTEM_PROMPT",
			append_system_prompt,
			"append-system-prompt",
		),
	] {
		if let Some(prompt) = prompt {
			let prompt = prompt.trim();
			if !prompt.is_empty() {
				if prompt.len() > 30000 {
					return Err(format!("{what} is too long (max 30000 chars)"));
				}
				env.push((key.to_string(), prompt.to_string()));
			}
		}
	}
	// Tool allowlist three-state: None = pi defaults, Some([]) = no tools,
	// Some([...]) = allowlist (the host JSON.parses the value).
	let tools_json = match tools {
		None => "null".to_string(),
		Some(tools) => serde_json::to_string(tools).map_err(|e| e.to_string())?,
	};
	env.push(("TAU_TOOLS".to_string(), tools_json));
	// Tool exclude list (keeps everything else enabled, works alongside the
	// allowlist above).
	if let Some(tools) = excluded_tools {
		if !tools.is_empty() {
			env.push((
				"TAU_EXCLUDED_TOOLS".to_string(),
				serde_json::to_string(tools).map_err(|e| e.to_string())?,
			));
		}
	}
	// Scoped model patterns for Ctrl+P cycling (/scoped-models equivalent).
	if let Some(models) = models {
		let models = models.trim();
		if !models.is_empty() {
			env.push(("TAU_MODELS".to_string(), models.to_string()));
		}
	}
	if let Some(ext) = extension {
		env.push((
			"TAU_EXTENSION".to_string(),
			ext.to_string_lossy().into_owned(),
		));
	}
	Ok(env)
}

/// Command launching the SDK session host: vendored node + session-host.mjs,
/// all options passed via env. The wire protocol on stdin/stdout is identical
/// to `pi --mode rpc`, so the reader/pump below needs no changes.
#[allow(clippy::too_many_arguments)]
pub fn session_host_command(
	info: &PiBinaryInfo,
	session_file: Option<&str>,
	fork_of: Option<&str>,
	session_name: Option<&str>,
	system_prompt: Option<&str>,
	append_system_prompt: Option<&str>,
	tools: Option<&[String]>,
	excluded_tools: Option<&[String]>,
	models: Option<&str>,
) -> Result<Command, String> {
	let (node, _) = info
		.direct
		.as_ref()
		.ok_or_else(|| "vendored pi runtime not found — run `npm run vendor:pi`".to_string())?;
	let host = crate::sidecar::locate_sidecar_script("session-host.mjs").ok_or_else(|| {
		"session-host.mjs not found in bundled agent-sidecar resources".to_string()
	})?;
	// bin = <pkg>/dist/bundle/cli.js — the SDK entry is dist/index.js.
	let cli = Path::new(&info.bin);
	let pkg_index = cli
		.parent()
		.and_then(|p| p.parent())
		.map(|dist| dist.join("index.js"))
		.filter(|p| p.is_file())
		.ok_or_else(|| {
			"pi SDK entry (dist/index.js) not found in the vendored runtime".to_string()
		})?;
	// Tau desktop tools extension: only when the vendored runtime is available
	// (same condition the old --extension flag had).
	let extension = crate::sidecar::tau_extension_paths().map(|(ext, _)| ext);
	let env = session_host_env(
		&pkg_index,
		&default_session_dir(),
		session_file,
		fork_of,
		session_name,
		system_prompt,
		append_system_prompt,
		tools,
		excluded_tools,
		models,
		extension.as_deref(),
	)?;
	let mut cmd = Command::new(node);
	cmd.arg(&host);
	for (key, value) in env {
		cmd.env(key, value);
	}
	Ok(cmd)
}

/// Legacy `pi --mode rpc` CLI launch, kept as the `TAU_PI_RPC=cli` escape
/// hatch in case the SDK session host misbehaves in the field.
#[allow(clippy::too_many_arguments)]
pub fn cli_legacy_command(
	info: &PiBinaryInfo,
	session_file: Option<&str>,
	fork_of: Option<&str>,
	session_name: Option<&str>,
	system_prompt: Option<&str>,
	append_system_prompt: Option<&str>,
	tools: Option<&[String]>,
	excluded_tools: Option<&[String]>,
	models: Option<&str>,
) -> Result<Command, String> {
	let mut cmd = pi_command(info);
	cmd.arg("--mode")
		.arg("rpc")
		.arg("--session-dir")
		.arg(default_session_dir());
	// Tau desktop tools: load the bundled extension (registered via the
	// SDK's registerTool) into the RPC session when the vendored runtime
	// is available. TAU_PI_PKG lets the extension resolve typebox from
	// pi's own dependency tree.
	if let Some((ext, pkg_index)) = crate::sidecar::tau_extension_paths() {
		cmd.arg("--extension").arg(ext);
		cmd.env("TAU_PI_PKG", pkg_index);
	}
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
	Ok(cmd)
}

/// Build the pi launch command: the SDK session host by default
/// (`TAU_PI_RPC=cli` is the escape hatch back to the legacy CLI launch).
///
/// Every deterministic launch failure — a missing runtime piece, an
/// unwritable workspace, a bad argument — surfaces here, before anything is
/// killed or spawned. `PiProcess::spawn` builds through this too, so the
/// pre-flight in `pi_start_inner` and the real spawn can never disagree about
/// what a valid command looks like.
#[allow(clippy::too_many_arguments)]
pub fn build_pi_command(
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
) -> Result<Command, String> {
	let legacy = std::env::var("TAU_PI_RPC").as_deref() == Ok("cli");
	let mut cmd = if legacy {
		cli_legacy_command(
			info,
			session_file,
			fork_of,
			session_name,
			system_prompt,
			append_system_prompt,
			tools,
			excluded_tools,
			models,
		)?
	} else {
		session_host_command(
			info,
			session_file,
			fork_of,
			session_name,
			system_prompt,
			append_system_prompt,
			tools,
			excluded_tools,
			models,
		)?
	};
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
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt;
		// Own process group: kill() can then take down the whole tree
		// (bash/tool children pi spawned), not just the node process.
		cmd.process_group(0);
	}
	Ok(cmd)
}

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
		// Full map key (`{window_label}\u{1}{chan}`).
		key: String,
		// Frontend-facing channel id used to tag emitted events.
		chan_id: String,
		window: &WebviewWindow,
	) -> Result<(), String> {
		self.kill();

		// Default: the SDK session host (session-host.mjs) — a drop-in
		// replacement for `pi --mode rpc`, configured entirely through env.
		// `TAU_PI_RPC=cli` is the escape hatch back to the legacy CLI launch.
		// (pi_start_inner pre-flights this same builder before killing the
		// previous process, so a construction failure never costs a session.)
		let mut cmd = build_pi_command(
			info,
			workspace,
			session_file,
			fork_of,
			session_name,
			system_prompt,
			append_system_prompt,
			tools,
			excluded_tools,
			models,
		)?;

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
		let key_thread = key.clone();
		let chan_thread = chan_id.clone();
		let chan_stderr = chan_id.clone();
		let stop_flag_thread = stop_flag.clone();
		// Keep the last stderr line around so a pi exit can be diagnosed from
		// tau.log alone (the stdout thread logs it on unexpected exits).
		let last_stderr = Arc::new(Mutex::new(String::new()));
		let last_stderr_stdout = Arc::clone(&last_stderr);
		thread::spawn(move || {
			let reader = BufReader::new(stdout);
			// Stream diagnostics: how many events were forwarded and how many
			// emits failed. When a freeze happens mid-stream, the last of these
			// lines shows the stream rate right before it.
			let mut streamed: u64 = 0;
			let mut emit_errors: u64 = 0;
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
				// Envelope: tag every event with the session channel so a window
				// running several sessions can route each event to its own UI.
				let envelope = serde_json::json!({ "chan": chan_thread, "ev": payload });
				// emit_to (not emit): `emit` broadcasts to EVERY webview, and
				// chan ids are per-window counters (two windows both start at
				// c1) — a broadcast would let window B apply window A's stream
				// events to its own same-named channel.
				if win_stdout
					.emit_to(win_stdout.label(), "pi://event", &envelope)
					.is_err()
				{
					emit_errors += 1;
				}
				streamed += 1;
				if streamed.is_multiple_of(250) {
					crate::runtime_log::log_info(
						&app_stdout,
						&format!(
							"pi stream: {streamed} events, {emit_errors} emit errors channel={key_thread}"
						),
					);
				}
			}
			let mut guard = lock_state(&state);
			let is_current = guard
				.get(&key_thread)
				.and_then(|p| p.child.as_ref())
				.is_some_and(|c| c.id() == pid);
			let mut child = if is_current {
				if let Some(p) = guard.get_mut(&key_thread) {
					p.stdin = None;
					p.child.take()
				} else {
					None
				}
			} else {
				None
			};
			// The process is gone for good: release the session occupancy now.
			// A stale `{child: None, session_file: Some}` entry would make every
			// later pi_start / archive / compact on this session fail with
			// "already open / stop the running session" until the app restarts.
			// Only the fields are cleared (not the entry removed): a concurrent
			// pi_start on the same channel key may have installed a fresh
			// process while we were reaping, and removing the entry could
			// clobber it.
			if is_current {
				if let Some(p) = guard.get_mut(&key_thread) {
					if p.child.is_none() {
						p.session_file = None;
						p.workspace = None;
					}
				}
			}
			drop(guard);
			// Reap the child OUTSIDE the lock (wait() blocks): dropping the
			// Child handle without wait() would leave a naturally-exited pi as
			// a zombie on Unix.
			let exit_code = child
				.as_mut()
				.and_then(|c| c.wait().ok())
				.and_then(|s| s.code());
			drop(child);
			// Only report the exit when the *current* pi process died and it
			// was not stopped on purpose. Processes replaced by a newer
			// `pi_start` or killed by `pi_stop` must not make the frontend
			// think the connection dropped.
			if is_current && !stop_flag_thread.load(Ordering::Relaxed) {
				let code = exit_code
					.map(|c| c.to_string())
					.unwrap_or_else(|| "signal".to_string());
				let last_err = last_stderr_stdout
					.lock()
					.map(|s| s.clone())
					.unwrap_or_default();
				crate::runtime_log::log_error(
					&app_stdout,
					&format!("pi process exited (code={code}) stderr-last: {last_err}"),
				);
				let _ = win_stdout.emit_to(
					win_stdout.label(),
					"pi://exit",
					serde_json::json!({ "chan": chan_thread }),
				);
			}
		});

		let last_stderr_thread = Arc::clone(&last_stderr);
		thread::spawn(move || {
			let reader = BufReader::new(stderr);
			for line in reader.lines() {
				let line = match line {
					Ok(line) => line,
					Err(_) => break,
				};
				if let Ok(mut slot) = last_stderr_thread.lock() {
					*slot = line.clone();
				}
				// Channel-scoped emit: each channel's stderr is tagged so the
				// webview can attribute diagnostics to the right session.
				// emit_to keeps it in the owning window (see the stdout note).
				let _ = win_stderr.emit_to(
					win_stderr.label(),
					"pi://stderr",
					serde_json::json!({ "chan": chan_stderr, "line": line }),
				);
			}
		});

		self.child = Some(child);
		self.stdin = Some(stdin);
		self.workspace = Some(PathBuf::from(workspace));
		self.session_file = session_file.map(PathBuf::from);
		self.explicit_stop = stop_flag;
		self.chan_id = chan_id;
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
				use super::util::system_command;
				use std::os::windows::process::CommandExt;
				let mut taskkill = system_command("taskkill");
				let _ = taskkill
					.args(["/PID", &child.id().to_string(), "/T", "/F"])
					.stdin(Stdio::null())
					.stdout(Stdio::null())
					.stderr(Stdio::null())
					.creation_flags(CREATE_NO_WINDOW_KILL)
					.status();
			}
			// Unix: the child was spawned with its own process group, so a
			// negative pid signals the whole tree — `child.kill()` alone would
			// orphan tool children (npm installs, dev servers, …).
			#[cfg(unix)]
			unsafe {
				let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
			}
			let _ = child.kill();
			let _ = child.wait();
		}
		self.workspace = None;
		self.session_file = None;
	}
}

/// Lock the per-window process map, recovering from a poisoned mutex instead
/// of panicking: a panic on the main thread while holding this lock would
/// otherwise cascade into every later command (`.unwrap()` on a poisoned
/// lock) and kill the whole app.
pub fn lock_state(
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

/// Kill every pi process belonging to a window label (called when a window
/// is destroyed). Takes the cloned process-map handle so window-destroy
/// handlers can outlive the borrowed `State`.
pub(crate) fn kill_window_process_inner(
	inner: &Arc<Mutex<HashMap<String, PiProcess>>>,
	label: &str,
) {
	// Remove the entries under the lock (a destroyed window's processes are
	// gone for good — this also keeps the map from growing without bound) and
	// kill outside it: kill() waits for the child to exit and must not block
	// other windows' RPC commands. lock_state recovers a poisoned mutex — an
	// `.unwrap_or_default()` here would silently skip the kill and leak the
	// window's pi processes.
	let prefix = window_prefix(label);
	let procs: Vec<PiProcess> = {
		let mut map = lock_state(inner);
		let keys: Vec<String> = map
			.keys()
			.filter(|k| k.starts_with(&prefix))
			.cloned()
			.collect();
		keys.iter().filter_map(|k| map.remove(k)).collect()
	};
	for mut p in procs {
		p.kill();
	}
}

/// Kill every pi process in the map (app-exit fallback). Window-destroy
/// handlers normally do this per window; quit paths that skip window
/// destruction (Cmd+Q edge cases) need a sweep of their own.
pub(crate) fn kill_all_processes(inner: &Arc<Mutex<HashMap<String, PiProcess>>>) {
	let procs: Vec<PiProcess> = {
		let mut map = lock_state(inner);
		map.drain().map(|(_, p)| p).collect()
	};
	for mut p in procs {
		p.kill();
	}
}

/// Monotonic sequence so window labels stay unique even when two windows
/// are created within the same millisecond.
pub static WINDOW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Open another Tau window (each window runs its own pi process/session).
/// Generic over the runtime so it works with the mock runtime in tests.
#[tauri::command]
pub(crate) fn pi_new_window<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {
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
			.traffic_light_position(tauri::LogicalPosition::new(20.0, 25.0));
	}
	#[cfg(target_os = "windows")]
	{
		// Undecorated: the renderer draws a custom title bar (menu bar and
		// window controls on one row) and handles dragging/resizing.
		builder = builder.decorations(false);
	}
	#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
	{
		builder = builder.decorations(false);
	}
	let win = builder.build().map_err(|e| e.to_string())?;
	let _ = win.show();
	crate::window_state::restore(&win);
	crate::window_state::attach(&win);
	// Kill the window's pi processes when its window closes (the app itself
	// may stay alive with other windows open). This must go through
	// kill_window_process_inner: the process map is keyed by
	// `channel_key(label, chan)` = `"{label}\u{1}{chan}"`, so looking up the
	// bare label never matched and every sub-window leaked its pi child.
	let inner = app.state::<PiState>().handle();
	let label_clone = label.clone();
	win.on_window_event(move |event| {
		if let tauri::WindowEvent::Destroyed = event {
			kill_window_process_inner(&inner, &label_clone);
		}
	});
	Ok(())
}

#[tauri::command]
pub async fn pi_binary(app: AppHandle) -> Result<PiBinaryInfo, String> {
	// The probe is a pure filesystem check of the vendored runtime layout (no
	// `--version` spawn), but keep it on the blocking pool so the command
	// never touches the main thread.
	let result = run_blocking(|| {
		probe_pi().ok_or_else(|| {
			"pi runtime not found. The bundled runtime is missing — run `npm run vendor:pi` and rebuild.".into()
		})
	})
	.await;
	// Probe failures are otherwise invisible (the frontend only shows a
	// banner), which made cold-launch antivirus timeouts undebuggable.
	if result.is_err() {
		crate::runtime_log::log_error(&app, "pi probe failed: binary not found");
	}
	result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command payload maps 1:1 to args
pub async fn pi_start(
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
	chan: Option<String>,
) -> Result<(), String> {
	// Probe + spawn (and killing any replaced process) can block for seconds
	// on a cold first launch (antivirus scanning node.exe, slow PATH
	// entries). Sync Tauri commands run on the main thread, which would
	// freeze every window into "(Not Responding)" — run the whole sequence
	// on the blocking pool instead.
	let inner = state.inner.clone();
	run_blocking(move || {
		pi_start_inner(
			&window,
			&inner,
			&workspace,
			session_file,
			fork_of,
			session_name,
			system_prompt,
			tools,
			models,
			excluded_tools,
			append_system_prompt,
			chan.as_deref().unwrap_or("main"),
		)
	})
	.await
}

/// Sync body of `pi_start`, executed on the blocking thread pool.
///
/// Spawns the session on its own channel. Other channels of the same window
/// keep running — that's what makes concurrent sessions possible: switching
/// to another session in the UI starts a new channel instead of killing the
/// previous process. The same session file still can't be attached twice
/// (concurrent appends would corrupt the JSONL).
#[allow(clippy::too_many_arguments)]
pub fn pi_start_inner(
	window: &WebviewWindow,
	inner: &Arc<Mutex<HashMap<String, PiProcess>>>,
	workspace: &str,
	session_file: Option<String>,
	fork_of: Option<String>,
	session_name: Option<String>,
	system_prompt: Option<String>,
	tools: Option<Vec<String>>,
	models: Option<String>,
	excluded_tools: Option<Vec<String>>,
	append_system_prompt: Option<String>,
	chan: &str,
) -> Result<(), String> {
	let info = probe_pi().ok_or("pi binary not found")?;
	// Containment (same rule every other session command enforces): resume and
	// fork targets must live inside the sessions directory. Without this, a
	// compromised webview could point TAU_SESSION_FILE/TAU_FORK_OF at any
	// parseable file and read its lines back as session "messages".
	if let Some(sf) = session_file.as_deref() {
		require_session_path(Path::new(sf))?;
	}
	if let Some(fo) = fork_of.as_deref() {
		require_session_path(Path::new(fo))?;
	}
	// The workspace becomes the pi child's cwd: require an existing directory
	// (canonicalized check only — the original spelling is what gets passed on,
	// so pi's project naming stays byte-identical to previous versions).
	if !Path::new(workspace).is_dir() {
		return Err(format!("workspace is not a directory: {workspace}"));
	}
	// Pre-flight the launch command and throw it away. Every deterministic
	// spawn failure (a missing runtime piece, a bad argument) surfaces here,
	// BEFORE the previous process is killed below: a configuration error must
	// not take the user's running session down with it and leave the channel
	// empty. The residual risk — cmd.spawn() itself failing, e.g. antivirus
	// holding the exe — stays, but that window is now the only one.
	build_pi_command(
		&info,
		workspace,
		session_file.as_deref(),
		fork_of.as_deref(),
		session_name.as_deref(),
		system_prompt.as_deref(),
		append_system_prompt.as_deref(),
		tools.as_deref(),
		excluded_tools.as_deref(),
		models.as_deref(),
	)?;
	let label = window.label().to_string();
	let key = channel_key(&label, chan);
	// Conflict check + detach this channel's previous process (if any) while
	// holding the lock — but only the detach; the actual kill happens after
	// the lock is released (kill() waits for the child to exit, which would
	// otherwise block every other window's RPC commands).
	let old: Option<PiProcess> = {
		let mut map = lock_state(inner);
		// One pi process per session file: reject a second channel (in any
		// window) opening the same JSONL (concurrent appends would corrupt
		// it). Compare canonicalized paths so alternate spellings (symlinks,
		// `..`, Windows `\\?\` prefixes) can't bypass the guard.
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
		// Detach only THIS channel's previous process and reserve the session
		// slot in the SAME critical section as the check above. Other channels
		// of this window are left untouched so their runs continue in the
		// background. Without the reservation a second channel could pass the
		// check after we release the lock but before spawn() registers the
		// child below, and both would append to the file.
		let old = map.remove(&key);
		if let Some(sf) = session_file.as_deref() {
			let placeholder = PiProcess {
				session_file: Some(canonical_or(Path::new(sf))),
				..Default::default()
			};
			map.insert(key.clone(), placeholder);
		}
		old
	};
	if let Some(mut old) = old {
		old.kill();
	}
	crate::runtime_log::log_info(
		window.app_handle(),
		&format!(
			"pi_start window={label} channel={chan} workspace={workspace} session={} fork={} tools={}",
			session_file.as_deref().unwrap_or("<new>"),
			fork_of.as_deref().unwrap_or(""),
			tools
				.as_deref()
				.map(|t| t.join(","))
				.unwrap_or_else(|| "default".into()),
		),
	);
	// Spawn OUTSIDE the process-map lock. `cmd.spawn()` can block for a second
	// or more on a cold start (Windows Defender scanning the vendored
	// node.exe), and holding the global map lock across it would stall every
	// other window's pi_send / pi_status / pi_stop for the same duration. The
	// session-file reservation taken in the critical section above — not this
	// lock — is what keeps two channels off the same JSONL.
	let mut fresh = PiProcess::default();
	let spawned = fresh.spawn(
		&info,
		workspace,
		session_file.as_deref(),
		fork_of.as_deref(),
		session_name.as_deref(),
		system_prompt.as_deref(),
		append_system_prompt.as_deref(),
		tools.as_deref(),
		excluded_tools.as_deref(),
		models.as_deref(),
		inner.clone(),
		key.clone(),
		chan.to_string(),
		window,
	);
	if let Err(e) = spawned {
		// Drop the placeholder so a failed spawn can't shadow later conflict
		// checks (its session_file would look "already open"). The previous
		// process of this channel was already killed above, so the entry
		// cannot hold a live child here.
		let mut map = lock_state(inner);
		if map.get(&key).is_some_and(|p| p.child.is_none()) {
			map.remove(&key);
		}
		return Err(e);
	}
	let mut to_install = Some(fresh);
	{
		let mut map = lock_state(inner);
		// A concurrent pi_start on this same channel may have installed a live
		// process while we were spawning. Never clobber it: the newer process
		// wins and ours is stopped below instead of being leaked. (The
		// frontend hands out a fresh channel id per start, so this is
		// belt-and-braces rather than a path the UI can reach today.)
		if map.get(&key).is_none_or(|p| p.child.is_none()) {
			if let Some(p) = to_install.take() {
				map.insert(key.clone(), p);
			}
		}
	}
	if let Some(mut p) = to_install {
		p.kill();
	}
	Ok(())
}

#[tauri::command]
pub fn pi_stop(
	window: WebviewWindow,
	state: State<'_, PiState>,
	chan: Option<String>,
) -> Result<(), String> {
	let label = window.label().to_string();
	// Remove the process under the lock, then kill it after the lock is
	// released: kill() waits for the child to exit, and doing that while
	// holding the map lock would stall every other window's RPC commands.
	// With a channel: stop just that session. Without: every channel of the
	// window (window-close semantics).
	let procs: Vec<PiProcess> = {
		let mut map = lock_state(&state.inner);
		match chan.as_deref() {
			Some(c) => map.remove(&channel_key(&label, c)).into_iter().collect(),
			None => {
				let prefix = window_prefix(&label);
				let keys: Vec<String> = map
					.keys()
					.filter(|k| k.starts_with(&prefix))
					.cloned()
					.collect();
				keys.iter().filter_map(|k| map.remove(k)).collect()
			}
		}
	};
	for mut p in procs {
		p.kill();
	}
	Ok(())
}

/// JSON-RPC command types the GUI is allowed to forward to pi. Anything else
/// is rejected — a compromised webview can't drive the pi pipe beyond this
/// set (defense in depth on top of the CSP).
pub const ALLOWED_RPC_TYPES: &[&str] = &[
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
pub async fn pi_send(
	window: WebviewWindow,
	state: State<'_, PiState>,
	command: Value,
	chan: Option<String>,
) -> Result<(), String> {
	let kind = command.get("type").and_then(|x| x.as_str()).unwrap_or("");
	if !ALLOWED_RPC_TYPES.contains(&kind) {
		return Err(format!("unknown pi command type: {kind}"));
	}
	let label = window.label().to_string();
	// Resolve the target channel's key. Explicit channel when given (the
	// normal path); otherwise fall back to the window's single live channel
	// so older callers keep working.
	let key = match chan.as_deref() {
		Some(c) => channel_key(&label, c),
		None => {
			let map = lock_state(&state.inner);
			let prefix = window_prefix(&label);
			let live: Vec<String> = map
				.iter()
				.filter(|(k, p)| k.starts_with(&prefix) && p.child.is_some())
				.map(|(k, _)| k.clone())
				.collect();
			if live.len() != 1 {
				return Err("pi is not running".into());
			}
			live.into_iter().next().unwrap()
		}
	};
	// Take the stdin handle out of the map so the write doesn't hold the global
	// process-map lock: a blocked write (pi busy, pipe buffer full) would
	// otherwise stall every other window's RPC commands.
	let stdin = {
		let mut map = lock_state(&state.inner);
		let p = map.get_mut(&key).ok_or("pi is not running")?;
		p.stdin.take().ok_or("pi is not running")?
	};
	let mut line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
	line.push('\n');
	// The pipe write can block for as long as pi stays busy without reading
	// stdin (large prompts overflow the 64KB pipe buffer). On the blocking
	// pool that at worst parks one worker thread; as a sync command it used to
	// run on the MAIN thread and froze every window into "(Not Responding)".
	let t0 = std::time::Instant::now();
	crate::runtime_log::log_info(
		window.app_handle(),
		&format!("pi_send begin type={kind} window={label}"),
	);
	// The handle is restored INSIDE the blocking task, not after the await: if
	// this future is dropped (webview reload, disconnect) the code after the
	// await never runs, and the closure would drop the handle at its end —
	// leaving the channel with p.stdin = None while pi_status still reports
	// running, so every later pi_send fails with "pi is not running" on a
	// perfectly live session. A spawned_blocking task always runs to
	// completion, so restoring there is drop-safe. (A still-blocked write
	// keeps the handle out of the map until it finishes, which is correct:
	// two concurrent writers on one pipe would interleave.)
	let inner_for_restore = state.inner.clone();
	let key_for_restore = key.clone();
	let result = run_blocking(move || {
		let mut stdin = stdin;
		match stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()) {
			Ok(()) => {
				let mut map = lock_state(&inner_for_restore);
				if let Some(p) = map.get_mut(&key_for_restore) {
					if p.stdin.is_none() {
						p.stdin = Some(stdin);
					}
				}
				Ok(())
			}
			// A failed write means the pipe is dead (EPIPE): drop the handle
			// rather than restoring it, so the next attempt reports the real
			// state (the reader thread's exit cleanup) instead of failing the
			// same way one more time.
			Err(e) => Err(format!("failed to write to pi stdin: {e}")),
		}
	})
	.await;
	{
		let elapsed = t0.elapsed().as_millis();
		// Fast writes are the norm; only log completions that were slow or
		// failed, so a healthy session doesn't double the log volume.
		if elapsed > 250 || result.is_err() {
			crate::runtime_log::log_info(
				window.app_handle(),
				&format!(
					"pi_send end type={kind} window={label} ok={} elapsed={elapsed}ms",
					result.is_ok()
				),
			);
		}
	}
	result
}

#[tauri::command]
pub fn pi_status(
	window: WebviewWindow,
	state: State<'_, PiState>,
	chan: Option<String>,
) -> Result<PiStatus, String> {
	let label = window.label().to_string();
	let map = lock_state(&state.inner);
	// A window that never started pi (fresh multi-window) reports idle
	// instead of an error so the frontend startup probe stays clean.
	let lookup = |key: &str| map.get(key);
	if let Some(c) = chan.as_deref() {
		// Per-channel status.
		let Some(p) = lookup(&channel_key(&label, c)) else {
			return Ok(PiStatus {
				running: false,
				workspace: None,
				session_file: None,
			});
		};
		return Ok(PiStatus {
			running: p.child.is_some(),
			workspace: p
				.workspace
				.as_ref()
				.map(|p| p.to_string_lossy().into_owned()),
			session_file: p
				.session_file
				.as_ref()
				.map(|p| p.to_string_lossy().into_owned()),
		});
	}
	// Aggregate for the window: running when any channel's process is alive;
	// workspace/session from a live channel (startup restore only cares that
	// SOMETHING is running after a webview reload).
	let prefix = window_prefix(&label);
	let any = map
		.iter()
		.filter(|(k, p)| k.starts_with(&prefix) && p.child.is_some())
		.map(|(_, p)| p)
		.next();
	let Some(p) = any else {
		return Ok(PiStatus {
			running: false,
			workspace: None,
			session_file: None,
		});
	};
	Ok(PiStatus {
		running: true,
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

impl Default for PiState {
	fn default() -> Self {
		Self {
			inner: Arc::new(Mutex::new(HashMap::new())),
		}
	}
}
