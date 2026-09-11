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
use std::path::PathBuf;
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
			dirs.push(parent.join("agent-sidecar"));
			dirs.push(parent.join("resources").join("agent-sidecar"));
		}
	}
	dirs.push(
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("resources")
			.join("agent-sidecar"),
	);
	dirs
}

fn locate_sidecar_script(name: &str) -> Option<PathBuf> {
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
	match rx.recv_timeout(CALL_TIMEOUT) {
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
						crate::runtime_log::log_error(&app, &format!("sidecar warmup gave up: {e}"));
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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sidecar_script_resolves_from_manifest_layout() {
		// Dev builds resolve the committed scripts through the source tree.
		let found = locate_sidecar_script("sidecar.mjs")
			.expect("sidecar.mjs must ship with the repo");
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
}
