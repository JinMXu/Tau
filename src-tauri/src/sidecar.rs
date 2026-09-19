//! Tau SDK sidecar: a long-lived Node process running the vendored pi
//! runtime, giving the Rust host direct access to pi SDK APIs over a JSONL
//! stdio protocol. The vendored runtime (installed by `npm run vendor:pi`)
//! makes this possible without any user-side node/pi installation.
//!
//! Protocol (see resources/agent-sidecar/sidecar.mjs):
//!   request  {"id":1,"method":"ping","params":{}}
//!   response {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"..."}

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::Value;

use crate::pi::{no_console_window, vendored_layout, vendored_runtime_dirs};

/// Hard deadline for one sidecar round-trip. session.parse reads whole JSONL
/// files (can be MBs) but parseSessionEntries is fast. 30s covers the worst
/// case: the very first spawn of the vendored node.exe while antivirus scans
/// it and the full SDK bundle (observed >15s cold on Windows Defender).
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Package install/remove can download npm or git dependencies — far past the
/// 30s round-trip budget that covers local-only calls.
const PACKAGE_CALL_TIMEOUT: Duration = Duration::from_secs(600);

struct Conn {
	child: Child,
	stdin: ChildStdin,
	pending: Arc<Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, String>>>>>,
	next_id: AtomicU64,
	/// Set by the reader thread once stdout closes (sidecar exited).
	dead: Arc<Mutex<Option<String>>>,
}

static CONN: Mutex<Option<Conn>> = Mutex::new(None);

/// Lock that survives a poisoned mutex (a panicking reader thread must not
/// take the whole sidecar module down with it).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
	m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Directories that may hold the bundled `agent-sidecar` scripts (committed
/// source, mapped into the bundle via tauri.conf.json resources).
fn sidecar_dirs() -> Vec<PathBuf> {
	let mut dirs: Vec<PathBuf> = Vec::new();
	if let Ok(exe) = std::env::current_exe() {
		if let Some(parent) = exe.parent() {
			// Windows/Linux installs place resources next to the executable;
			// the second form covers builds that keep the `resources/` prefix.
			dirs.push(parent.join("agent-sidecar"));
			dirs.push(parent.join("resources").join("agent-sidecar"));
			// macOS .app: exe is Contents/MacOS/tau, resources are Contents/Resources.
			if let Some(contents) = parent.parent() {
				dirs.push(contents.join("Resources").join("agent-sidecar"));
			}
		}
	}
	dirs.push(
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("resources")
			.join("agent-sidecar"),
	);
	dirs
}

pub(crate) fn locate_sidecar_script(name: &str) -> Option<PathBuf> {
	sidecar_dirs().into_iter().find_map(|dir| {
		let candidate = dir.join(name);
		candidate.is_file().then_some(candidate)
	})
}

/// (node.exe, sidecar.mjs, pi package dist/index.js) from the vendored
/// runtime. Errors when the runtime is missing or incomplete — dev
/// environments without `npm run vendor:pi` get "sidecar unavailable", never
/// a system node (the sidecar's SDK import must match the vendored pi
/// exactly).
fn runtime_triple() -> Result<(PathBuf, PathBuf, PathBuf), String> {
	let dirs = vendored_runtime_dirs();
	let (node, cli) = dirs
		.iter()
		.find_map(|dir| vendored_layout(dir))
		.ok_or_else(|| "vendored pi runtime not found — run `npm run vendor:pi`".to_string())?;
	let dist = cli
		.parent()
		.and_then(|p| p.parent())
		.ok_or_else(|| "unexpected vendored pi layout".to_string())?;
	let pkg_index = dist.join("index.js");
	if !pkg_index.is_file() {
		return Err(format!("pi SDK entry not found: {}", pkg_index.display()));
	}
	let script = locate_sidecar_script("sidecar.mjs")
		.ok_or_else(|| "sidecar.mjs not found in bundled agent-sidecar resources".to_string())?;
	Ok((node, script, pkg_index))
}

/// (tau-extension.mjs, pi package dist/index.js) for wiring the desktop-tool
/// extension into the RPC session. None when the vendored runtime or the
/// extension script is missing — pi then runs without Tau tools, exactly
/// like before this module existed.
pub(crate) fn tau_extension_paths() -> Option<(PathBuf, PathBuf)> {
	let ext = locate_sidecar_script("tau-extension.mjs")?;
	let dirs = vendored_runtime_dirs();
	let (_, cli) = dirs.iter().find_map(|dir| vendored_layout(dir))?;
	let pkg_index = cli.parent()?.parent()?.join("index.js");
	pkg_index.is_file().then_some((ext, pkg_index))
}

fn spawn_conn() -> Result<Conn, String> {
	let (node, script, pkg_index) = runtime_triple()?;
	let mut cmd = Command::new(&node);
	cmd.arg(&script)
		.env("TAU_PI_PKG", &pkg_index)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::null());
	let mut child = no_console_window(&mut cmd)
		.spawn()
		.map_err(|e| format!("failed to spawn sidecar: {e}"))?;
	let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
	let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
	let conn = Conn {
		child,
		stdin,
		pending: Arc::new(Mutex::new(HashMap::new())),
		next_id: AtomicU64::new(1),
		dead: Arc::new(Mutex::new(None)),
	};
	let pending = conn.pending.clone();
	let dead = conn.dead.clone();
	std::thread::spawn(move || {
		let reader = BufReader::new(stdout);
		for line in reader.lines() {
			let Ok(line) = line else { break };
			let Ok(msg) = serde_json::from_str::<Value>(&line) else {
				continue;
			};
			let Some(id) = msg.get("id").and_then(|v| v.as_u64()) else {
				continue;
			};
			let reply = if msg.get("ok").and_then(|v| v.as_bool()) == Some(true) {
				Ok(msg.get("result").cloned().unwrap_or(Value::Null))
			} else {
				Err(msg
					.get("error")
					.and_then(|v| v.as_str())
					.unwrap_or("sidecar error")
					.to_string())
			};
			if let Some(tx) = lock(&pending).remove(&id) {
				let _ = tx.send(reply);
			}
		}
		// stdout closed: the sidecar is gone. Fail everything still pending.
		*lock(&dead) = Some("sidecar process exited".to_string());
		for (_, tx) in lock(&pending).drain() {
			let _ = tx.send(Err("sidecar process exited".to_string()));
		}
	});
	Ok(conn)
}

/// One JSONL round-trip. Respawns the sidecar transparently on first use or
/// after a crash.
fn call(method: &str, params: Value) -> Result<Value, String> {
	call_with_timeout(method, params, CALL_TIMEOUT)
}

fn call_with_timeout(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
	let mut guard = lock(&CONN);
	let needs_spawn = match guard.as_mut() {
		Some(conn) => {
			let dead = lock(&conn.dead).is_some();
			if dead {
				let _ = conn.child.kill();
				let _ = conn.child.wait();
			}
			dead
		}
		None => true,
	};
	if needs_spawn {
		*guard = Some(spawn_conn()?);
	}
	let conn = guard.as_mut().expect("just spawned");
	let id = conn.next_id.fetch_add(1, Ordering::SeqCst);
	let (tx, rx) = mpsc::sync_channel(1);
	lock(&conn.pending).insert(id, tx);
	let line = serde_json::json!({ "id": id, "method": method, "params": params }).to_string();
	let write_result = (|| -> std::io::Result<()> {
		writeln!(conn.stdin, "{line}")?;
		conn.stdin.flush()
	})()
	.map_err(|e| {
		lock(&conn.pending).remove(&id);
		format!("sidecar write failed: {e}")
	});
	if let Err(e) = write_result {
		// Mark dead so the next call respawns a fresh process.
		*lock(&conn.dead) = Some(e.clone());
		return Err(e);
	}
	// Drop the connection lock while waiting so concurrent callers can queue
	// their own requests instead of serializing behind this one.
	drop(guard);
	match rx.recv_timeout(timeout) {
		Ok(reply) => reply,
		Err(_) => {
			// Timeout: clean up only our own pending entry — the reader may
			// still deliver a late reply for it.
			if let Some(conn) = lock(&CONN).as_ref() {
				lock(&conn.pending).remove(&id);
			}
			Err("sidecar call timed out".to_string())
		}
	}
}

/// Export a session JSONL to a styled HTML file via the SDK's
/// `exportFromFile` — the same code path as `pi --export`, without spawning
/// a one-shot CLI. Returns the sidecar's `{ outPath }` result.
pub(crate) fn export_html(path: &Path, out_path: &Path) -> Result<Value, String> {
	call(
		"session.export_html",
		serde_json::json!({
			"path": path.to_string_lossy(),
			"outPath": out_path.to_string_lossy(),
		}),
	)
}

/// Configured packages (`DefaultPackageManager.listConfiguredPackages`) as a
/// JSON array of `{ source, scope, filtered, installedPath? }`.
pub(crate) fn package_list(cwd: &Path) -> Result<Value, String> {
	call(
		"package.list",
		serde_json::json!({ "cwd": cwd.to_string_lossy() }),
	)
}

/// `installAndPersist(source, { local })` — `local: false` writes user
/// (global) settings, matching `pi install` without `--local`.
pub(crate) fn package_install(cwd: &Path, source: &str, local: bool) -> Result<Value, String> {
	call_with_timeout(
		"package.install",
		serde_json::json!({
			"cwd": cwd.to_string_lossy(),
			"source": source,
			"local": local,
		}),
		PACKAGE_CALL_TIMEOUT,
	)
}

/// `removeAndPersist(source, { local })` — returns whether a matching
/// package was actually removed (the CLI exits non-zero when it wasn't).
pub(crate) fn package_remove(cwd: &Path, source: &str, local: bool) -> Result<bool, String> {
	let result = call_with_timeout(
		"package.remove",
		serde_json::json!({
			"cwd": cwd.to_string_lossy(),
			"source": source,
			"local": local,
		}),
		PACKAGE_CALL_TIMEOUT,
	)?;
	Ok(result
		.get("removed")
		.and_then(|v| v.as_bool())
		.unwrap_or(false))
}

/// Snapshot of a sidecar OAuth login flow. `event` is the latest
/// `AuthEvent` (device_code/auth_url/progress/info), `prompt` the pending
/// `AuthPrompt` projection (`{ message, kind, options, placeholder }`) while
/// `phase == "awaiting_prompt"`. Both stay `None` until the flow emits them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OAuthFlowStatus {
	pub phase: String,
	pub event: Option<Value>,
	pub prompt: Option<Value>,
	pub error: Option<String>,
}

/// Start `modelRuntime.login(provider_id, "oauth", …)` in the sidecar and
/// return its flowId. The flow itself runs in the background — the real wait
/// is driven by the frontend polling `oauth_status`.
pub(crate) fn oauth_begin_call(provider_id: &str) -> Result<String, String> {
	let result = call(
		"oauth.begin",
		serde_json::json!({ "providerId": provider_id }),
	)?;
	result
		.get("flowId")
		.and_then(|v| v.as_str())
		.map(str::to_string)
		.ok_or_else(|| "sidecar oauth.begin returned no flowId".to_string())
}

pub(crate) fn oauth_status_call(flow_id: &str) -> Result<OAuthFlowStatus, String> {
	let result = call("oauth.status", serde_json::json!({ "flowId": flow_id }))?;
	serde_json::from_value(result).map_err(|e| format!("invalid oauth.status result: {e}"))
}

pub(crate) fn oauth_prompt_response_call(flow_id: &str, value: &str) -> Result<(), String> {
	call(
		"oauth.prompt_response",
		serde_json::json!({ "flowId": flow_id, "value": value }),
	)?;
	Ok(())
}

pub(crate) fn oauth_cancel_call(flow_id: &str) -> Result<(), String> {
	call("oauth.cancel", serde_json::json!({ "flowId": flow_id }))?;
	Ok(())
}

/// Background warmup: spawn the sidecar and keep pinging until it answers.
/// On first launch after an install, antivirus scans the whole vendored
/// node_modules tree when node first reads it, which can hold the SDK
/// import for minutes — far past the 30s per-call timeout. Warming at app
/// startup absorbs that cost before any feature needs the sidecar; later
/// calls ride the already-imported process and answer instantly.
pub(crate) fn start_warmup(app: tauri::AppHandle) {
	std::thread::spawn(move || {
		let deadline = std::time::Instant::now() + Duration::from_secs(180);
		let mut attempt = 0u32;
		loop {
			attempt += 1;
			let t0 = std::time::Instant::now();
			match call("ping", serde_json::json!({})) {
				Ok(_) => {
					crate::runtime_log::log_info(
						&app,
						&format!(
							"sidecar warm after {attempt} attempt(s) (last call {}ms)",
							t0.elapsed().as_millis()
						),
					);
					return;
				}
				Err(e) => {
					if std::time::Instant::now() >= deadline {
						crate::runtime_log::log_error(
							&app,
							&format!("sidecar warmup gave up: {e}"),
						);
						return;
					}
					// The timed-out process stays alive (a call timeout does
					// not mark the connection dead) and finishes its import
					// in the background; the next attempt rides it.
					std::thread::sleep(Duration::from_secs(5));
				}
			}
		}
	});
}

/// SDK sidecar liveness/version probe: `pi` (SDK version), `node` runtime,
/// `agentDir` (~/.pi/agent) — proves the vendored-SDK channel end to end.
#[tauri::command]
pub async fn sidecar_ping() -> Result<Value, String> {
	tauri::async_runtime::spawn_blocking(|| call("ping", serde_json::json!({})))
		.await
		.map_err(|e| e.to_string())?
}

/// Structured parse of a session JSONL via the SDK's own
/// `parseSessionEntries` — the canonical interpretation of the file format,
/// replacing hand-rolled parsing where it matters.
///
/// The path is containment-checked exactly like the other session readers
/// (`pi_read_session`, `pi_read_tree`, …): the sidecar parses whatever it is
/// handed, so without this the command was a generic "read any file this
/// process can open" primitive.
#[tauri::command]
pub async fn sidecar_session_info(path: String) -> Result<Value, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let full = crate::pi::require_session_path(std::path::Path::new(&path))?;
		call(
			"session.parse",
			serde_json::json!({ "path": full.to_string_lossy() }),
		)
	})
	.await
	.map_err(|e| e.to_string())?
}

/// Begin an OAuth login flow for a provider (`kimi-coding`, `openai-codex`,
/// …). Returns the flowId used by the other `oauth_*` commands.
#[tauri::command]
pub async fn oauth_begin(provider_id: String) -> Result<String, String> {
	tauri::async_runtime::spawn_blocking(move || oauth_begin_call(&provider_id))
		.await
		.map_err(|e| e.to_string())?
}

/// Poll one flow. Terminal phases (`done`/`error`/`cancelled`) are consumed:
/// the sidecar forgets the flow after this read.
#[tauri::command]
pub async fn oauth_status(flow_id: String) -> Result<OAuthFlowStatus, String> {
	tauri::async_runtime::spawn_blocking(move || oauth_status_call(&flow_id))
		.await
		.map_err(|e| e.to_string())?
}

/// Answer the flow's pending prompt (text input or selected option id).
#[tauri::command]
pub async fn oauth_prompt_response(flow_id: String, value: String) -> Result<(), String> {
	tauri::async_runtime::spawn_blocking(move || oauth_prompt_response_call(&flow_id, &value))
		.await
		.map_err(|e| e.to_string())?
}

/// Abort the flow: rejects any pending prompt and signals the login's
/// AbortController. No credential is written.
#[tauri::command]
pub async fn oauth_cancel(flow_id: String) -> Result<(), String> {
	tauri::async_runtime::spawn_blocking(move || oauth_cancel_call(&flow_id))
		.await
		.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sidecar_script_resolves_from_manifest_layout() {
		// Dev builds resolve the committed scripts through the source tree.
		let found =
			locate_sidecar_script("sidecar.mjs").expect("sidecar.mjs must ship with the repo");
		assert!(found.is_file());
		assert!(locate_sidecar_script("tau-extension.mjs").is_some());
	}

	#[test]
	fn sidecar_ping_roundtrip() {
		// Full end-to-end: vendored node + sidecar.mjs + SDK import. Skips
		// (like the other runtime-dependent tests) when no vendored runtime
		// exists — CI runs `npm run vendor:pi` before cargo test.
		if runtime_triple().is_err() {
			eprintln!("vendored runtime missing — skipping sidecar e2e");
			return;
		}
		let value = call("ping", serde_json::json!({})).expect("ping must succeed");
		assert!(value["pi"].is_string(), "pi version missing: {value}");
		assert!(value["node"].is_string(), "node version missing: {value}");
		assert!(value["agentDir"].is_string());
	}

	#[test]
	fn oauth_flow_status_deserializes_sidecar_shape() {
		// The exact JSON sidecar.mjs emits for oauth.status, mid-flow.
		let status: OAuthFlowStatus = serde_json::from_value(serde_json::json!({
			"phase": "awaiting_prompt",
			"event": {
				"type": "device_code",
				"userCode": "ABCD-1234",
				"verificationUri": "https://example.com/device",
			},
			"prompt": {
				"message": "Sign in how?",
				"kind": "select",
				"options": [{ "id": "browser", "label": "Browser" }],
				"placeholder": null,
			},
			"error": null,
		}))
		.expect("oauth.status result must deserialize");
		assert_eq!(status.phase, "awaiting_prompt");
		assert_eq!(status.event.unwrap()["type"], "device_code");
		assert_eq!(status.prompt.unwrap()["kind"], "select");
		assert!(status.error.is_none());
	}

	#[test]
	fn oauth_unknown_flow_errors() {
		if runtime_triple().is_err() {
			eprintln!("vendored runtime missing — skipping sidecar e2e");
			return;
		}
		let err = oauth_status_call("no-such-flow").expect_err("unknown flow must error");
		assert!(
			err.contains("unknown oauth flow"),
			"unexpected error: {err}"
		);
		let err = oauth_cancel_call("no-such-flow").expect_err("unknown flow must error");
		assert!(
			err.contains("unknown oauth flow"),
			"unexpected error: {err}"
		);
	}

	#[test]
	fn oauth_begin_unknown_provider_fails_fast() {
		// No network involved: login() rejects unknown provider ids locally,
		// so the flow lands in the error phase on its own.
		if runtime_triple().is_err() {
			eprintln!("vendored runtime missing — skipping sidecar e2e");
			return;
		}
		let flow_id = oauth_begin_call("no-such-provider").expect("begin must return a flowId");
		let mut phase = String::new();
		let mut error = None;
		for _ in 0..50 {
			match oauth_status_call(&flow_id) {
				Ok(status) => {
					phase = status.phase.clone();
					error = status.error;
					if phase != "running" && phase != "awaiting_prompt" {
						break;
					}
				}
				Err(e) => panic!("status polling failed: {e}"),
			}
			std::thread::sleep(Duration::from_millis(200));
		}
		assert_eq!(phase, "error");
		assert!(error.is_some(), "error phase must carry a message");
		// Terminal statuses are single-read: the sidecar forgot the flow.
		let err = oauth_status_call(&flow_id).expect_err("consumed flow must be gone");
		assert!(
			err.contains("unknown oauth flow"),
			"unexpected error: {err}"
		);
	}
}
