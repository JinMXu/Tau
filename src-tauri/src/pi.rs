use std::{
	fs::File,
	io::{BufRead, BufReader, Write},
	path::{Path, PathBuf},
	process::{Child, ChildStdin, Command, Stdio},
	sync::{Arc, Mutex},
	thread,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

pub struct PiState {
	inner: Arc<Mutex<PiProcess>>,
}

impl Default for PiState {
	fn default() -> Self {
		Self { inner: Arc::new(Mutex::new(PiProcess::default())) }
	}
}

#[derive(Default)]
struct PiProcess {
	child: Option<Child>,
	stdin: Option<ChildStdin>,
	workspace: Option<PathBuf>,
	session_file: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiBinaryInfo {
	pub(crate) bin: String,
	pub(crate) version: String,
	/// Whether the binary must be launched through `cmd /C` (Windows .cmd/.bat shims).
	#[serde(skip)]
	pub(crate) via_cmd: bool,
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

fn probe(bin: &str) -> Option<String> {
	let out = Command::new(bin).arg("--version").output().ok()?;
	if !out.status.success() {
		return None;
	}
	let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
	if version.is_empty() {
		return None;
	}
	Some(version)
}

fn probe_via_cmd(bin: &str) -> Option<String> {
	let out = Command::new("cmd").args(["/C", bin, "--version"]).output().ok()?;
	if !out.status.success() {
		return None;
	}
	let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
	if version.is_empty() {
		return None;
	}
	Some(version)
}

pub(crate) fn probe_pi() -> Option<PiBinaryInfo> {
	let mut candidates: Vec<(&str, bool)> = vec![("pi", false)];
	if cfg!(windows) {
		candidates.extend([("pi.exe", false), ("pi.cmd", true), ("pi.bat", true)]);
	}
	if let Ok(env_bin) = std::env::var("PI_BIN") {
		let via_cmd = env_bin.ends_with(".cmd") || env_bin.ends_with(".bat");
		candidates.insert(0, (Box::leak(env_bin.into_boxed_str()), via_cmd));
	}
	for (bin, via_cmd) in candidates {
		let version = if via_cmd { probe_via_cmd(bin) } else { probe(bin) };
		if let Some(version) = version {
			return Some(PiBinaryInfo { bin: bin.to_string(), version, via_cmd });
		}
	}
	None
}

impl PiProcess {
	fn spawn(
		&mut self,
		info: &PiBinaryInfo,
		workspace: &str,
		session_file: Option<&str>,
		fork_of: Option<&str>,
		session_name: Option<&str>,
		system_prompt: Option<&str>,
		tools: Option<&[String]>,
		state: Arc<Mutex<PiProcess>>,
		app: &AppHandle,
	) -> Result<(), String> {
		self.kill();

		let mut cmd = if info.via_cmd {
			let mut c = Command::new("cmd");
			c.arg("/C").arg(&info.bin);
			c
		} else {
			Command::new(&info.bin)
		};
		cmd.arg("--mode")
			.arg("rpc")
			.arg("--session-dir")
			.arg(default_session_dir());
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
		// Tool allowlist: Some([]) = disable all tools, Some([...]) = allowlist,
		// None = keep pi defaults (all tools).
		if let Some(tools) = tools {
			if tools.is_empty() {
				cmd.arg("--no-tools");
			} else {
				cmd.arg("--tools").arg(tools.join(","));
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

		let mut child = cmd.spawn().map_err(|e| format!("failed to spawn pi: {e}"))?;
		let stdin = child.stdin.take().ok_or("failed to take pi stdin")?;
		let stdout = child.stdout.take().ok_or("failed to take pi stdout")?;
		let stderr = child.stderr.take().ok_or("failed to take pi stderr")?;
		let pid = child.id();

		let app_stdout = app.clone();
		let app_stderr = app.clone();
		let state = state.clone();
		thread::spawn(move || {
			let reader = BufReader::new(stdout);
			for line in reader.lines() {
				let line = match line {
					Ok(line) => line,
					Err(_) => break,
				};
				if line.trim().is_empty() {
					continue;
				}
				let payload: Value =
					serde_json::from_str(&line).unwrap_or_else(|_| Value::String(line));
				let _ = app_stdout.emit("pi://event", &payload);
			}
			let mut guard = state.lock().unwrap();
			let is_current = guard.child.as_ref().is_some_and(|c| c.id() == pid);
			if is_current {
				guard.child = None;
				guard.stdin = None;
			}
			drop(guard);
			// Only report the exit when the *current* pi process died. Processes
			// replaced by a newer `pi_start` are killed on purpose; reporting
			// them would make the frontend think the connection dropped.
			if is_current {
				crate::runtime_log::log_error(&app_stdout, "pi process exited");
				let _ = app_stdout.emit("pi://exit", ());
			}
		});

		thread::spawn(move || {
			let reader = BufReader::new(stderr);
			for line in reader.lines() {
				let line = match line {
					Ok(line) => line,
					Err(_) => break,
				};
				let _ = app_stderr.emit("pi://stderr", line);
			}
		});

		self.child = Some(child);
		self.stdin = Some(stdin);
		self.workspace = Some(PathBuf::from(workspace));
		self.session_file = session_file.map(PathBuf::from);
		Ok(())
	}

	fn kill(&mut self) {
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

	fn send(&mut self, command: &Value) -> Result<(), String> {
		let stdin = self.stdin.as_mut().ok_or("pi is not running")?;
		let mut line = serde_json::to_string(command).map_err(|e| e.to_string())?;
		line.push('\n');
		stdin
			.write_all(line.as_bytes())
			.and_then(|_| stdin.flush())
			.map_err(|e| format!("failed to write to pi stdin: {e}"))
	}
}

fn unix_ms(t: std::time::SystemTime) -> u64 {
	t.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0)
}

fn file_stem(path: &Path) -> String {
	path.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or_default()
		.to_string()
}

fn parse_iso_ms(s: &str) -> Option<u64> {
	// Accept "2026-08-10T06:31:02.384Z" style timestamps.
	let s = s.trim();
	let s = s.strip_suffix('Z').unwrap_or(s);
	let (date, time) = s.split_once('T')?;
	let mut dp = date.split('-');
	let y: i64 = dp.next()?.parse().ok()?;
	let mo: i64 = dp.next()?.parse().ok()?;
	let d: i64 = dp.next()?.parse().ok()?;
	if !(1..=12).contains(&mo) {
		return None;
	}
	if !(1..=31).contains(&d) {
		return None;
	}
	let mut tp = time.split(':');
	let h: i64 = tp.next()?.parse().ok()?;
	let mi: i64 = tp.next()?.parse().ok()?;
	let sec: i64 = tp.next()?.split('.').next()?.parse().ok()?;
	let days = y * 365 + y / 4 - y / 100 + y / 400
		+ [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][(mo - 1) as usize]
		+ (d - 1);
	let secs = days * 86400 + h * 3600 + mi * 60 + sec;
	// Sub-second precision is irrelevant here; epoch in ms.
	Some((secs as u64).saturating_mul(1000))
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
	for line in reader.lines().take(limit).flatten() {
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

fn collect_sessions(dir: &Path, out: &mut Vec<PiSessionInfo>) {
	let entries = match std::fs::read_dir(dir) {
		Ok(entries) => entries,
		Err(_) => return,
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			if is_aux_dir(&path.file_name().unwrap_or_default().to_string_lossy()) {
				continue;
			}
			collect_sessions(&path, out);
		} else if path.extension().is_some_and(|ext| ext == "jsonl") {
			let meta = entry.metadata().ok();
			let scan = scan_session(&path, 400);
			out.push(PiSessionInfo {
				path: path.to_string_lossy().into_owned(),
				name: file_stem(&path),
				project: scan.project,
				title: if scan.title.is_empty() {
					file_stem(&path)
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
			});
		}
	}
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
	for line in reader.lines().flatten() {
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
				let Some(msg) = v.get("message") else { continue };
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
				let name = v
					.get("name")
					.and_then(|x| x.as_str())
					.unwrap_or("tool");
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
							format!("{}…", &text[..8000])
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
		"pi binary not found. Install pi (see https://github.com/earendil-works/pi) or set PI_BIN.".into()
	})
}

#[tauri::command]
fn pi_start(
	app: AppHandle,
	state: State<'_, PiState>,
	workspace: String,
	session_file: Option<String>,
	fork_of: Option<String>,
	session_name: Option<String>,
	system_prompt: Option<String>,
	tools: Option<Vec<String>>,
) -> Result<(), String> {
	let info = probe_pi().ok_or("pi binary not found")?;
	let mut inner = state.inner.lock().unwrap();
	crate::runtime_log::log_info(
		&app,
		&format!(
			"pi_start workspace={workspace} session={} fork={} tools={}",
			session_file.as_deref().unwrap_or("<new>"),
			fork_of.as_deref().unwrap_or(""),
			tools.as_deref().map(|t| t.join(",")).unwrap_or_else(|| "default".into()),
		),
	);
	inner.spawn(
		&info,
		&workspace,
		session_file.as_deref(),
		fork_of.as_deref(),
		session_name.as_deref(),
		system_prompt.as_deref(),
		tools.as_deref(),
		state.inner.clone(),
		&app,
	)
}

#[tauri::command]
fn pi_stop(state: State<'_, PiState>) -> Result<(), String> {
	let mut inner = state.inner.lock().unwrap();
	inner.kill();
	Ok(())
}

#[tauri::command]
fn pi_send(state: State<'_, PiState>, command: Value) -> Result<(), String> {
	let mut inner = state.inner.lock().unwrap();
	inner.send(&command)
}

#[tauri::command]
fn pi_status(state: State<'_, PiState>) -> Result<PiStatus, String> {
	let inner = state.inner.lock().unwrap();
	Ok(PiStatus {
		running: inner.child.is_some(),
		workspace: inner.workspace.as_ref().map(|p| p.to_string_lossy().into_owned()),
		session_file: inner.session_file.as_ref().map(|p| p.to_string_lossy().into_owned()),
	})
}

#[tauri::command]
fn pi_list_sessions() -> Result<Vec<PiSessionInfo>, String> {
	let mut out = Vec::new();
	collect_sessions(&default_session_dir(), &mut out);
	out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
	Ok(out)
}

#[tauri::command]
fn pi_read_session(path: String) -> Result<Vec<PiParsedMessage>, String> {
	let p = PathBuf::from(&path);
	if !p.exists() {
		return Err(format!("session not found: {path}"));
	}
	Ok(read_session_messages(&p))
}

#[tauri::command]
fn pi_search_sessions(query: String, limit: Option<usize>) -> Result<Vec<PiSearchHit>, String> {
	let query = query.trim().to_lowercase();
	let mut hits = Vec::new();
	if query.is_empty() {
		return Ok(hits);
	}
	let limit = limit.unwrap_or(50).min(200);
	let mut sessions = Vec::new();
	collect_sessions(&default_session_dir(), &mut sessions);
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
				snippet: if title_hit { String::new() } else { snippet_hit },
				updated_at: session.mtime_ms,
			});
		}
	}
	hits.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
	Ok(hits)
}

/// Find the first line containing the query (case-insensitive) and return a
/// short snippet of message text around it.
fn search_snippet(path: &Path, query: &str) -> Option<String> {
	let file = File::open(path).ok()?;
	let reader = BufReader::new(file);
	for line in reader.lines().flatten() {
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
					snippet.insert_str(0, "…");
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
	let _ = std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default());
	Ok(())
}

fn move_with_sidecar(path: &Path, target_dir: &Path) -> Result<(), String> {
	let file_name = path
		.file_name()
		.ok_or_else(|| "invalid session path".to_string())?;
	if !path.exists() {
		return Err(format!("session not found: {}", path.display()));
	}
	std::fs::create_dir_all(target_dir)
		.map_err(|e| format!("failed to create dir: {e}"))?;
	let target = target_dir.join(file_name);
	if target.exists() {
		let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
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

#[tauri::command]
fn pi_archive_session(path: String) -> Result<(), String> {
	move_with_sidecar(&PathBuf::from(&path), &archive_dir())
}

#[tauri::command]
fn pi_delete_session(path: String) -> Result<(), String> {
	move_with_sidecar(&PathBuf::from(&path), &trash_dir())
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
	out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
	Ok(out)
}

#[tauri::command]
fn pi_restore_session(path: String) -> Result<(), String> {
	let path = PathBuf::from(&path);
	let file_name = path
		.file_name()
		.ok_or_else(|| "invalid session path".to_string())?;
	let target_dir = if path.parent().is_some_and(|p| p == archive_dir().as_path()) {
		archive_dir()
	} else {
		trash_dir()
	};
	let original = meta_original_path(&target_dir, &file_name.to_string_lossy());
	let restore_to = original
		.map(PathBuf::from)
		.filter(|p| p.starts_with(&aux_root()))
		.unwrap_or_else(|| aux_root().join(file_name));
	if restore_to.exists() {
		let stamp = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_millis())
			.unwrap_or(0);
		let stem = file_name.to_string_lossy();
		let renamed = PathBuf::from(format!("{stem}-{stamp}"));
		let _ = std::fs::rename(&restore_to, &renamed);
	}
	if let Some(parent) = restore_to.parent() {
		let _ = std::fs::create_dir_all(parent);
	}
	std::fs::rename(&path, &restore_to)
		.map_err(|e| format!("failed to restore session: {e}"))?;
	let _ = std::fs::remove_file(target_dir.join(format!(
		"{}.meta",
		file_name.to_string_lossy()
	)));
	Ok(())
}

#[tauri::command]
fn pi_purge_session(path: String) -> Result<(), String> {
	let path = PathBuf::from(&path);
	if !(path.starts_with(&archive_dir()) || path.starts_with(&trash_dir())) {
		return Err("only archived/trashed sessions can be purged".into());
	}
	if path.exists() {
		std::fs::remove_file(&path)
			.map_err(|e| format!("failed to delete session: {e}"))?;
	}
	let meta_path = path.with_extension("jsonl.meta");
	let _ = std::fs::remove_file(meta_path);
	Ok(())
}

#[tauri::command]
fn pi_reveal_session(path: String) -> Result<(), String> {
	let path = PathBuf::from(&path);
	if !path.exists() {
		return Err(format!("session not found: {}", path.display()));
	}
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
fn pi_export_chat(
	app: AppHandle,
	session_path: String,
	markdown: Option<String>,
	format: String,
) -> Result<serde_json::Value, String> {
	use tauri_plugin_dialog::DialogExt;

	let path = PathBuf::from(&session_path);
	if !path.exists() {
		return Err(format!("session not found: {session_path}"));
	}
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

	if format == "jsonl" {
		std::fs::copy(&path, &target)
			.map_err(|e| format!("failed to copy session: {e}"))?;
	} else {
		let markdown = markdown.unwrap_or_default();
		std::fs::write(&target, markdown)
			.map_err(|e| format!("failed to write export: {e}"))?;
	}
	Ok(serde_json::json!({
		"ok": true,
		"canceled": false,
		"path": target.to_string_lossy().into_owned()
	}))
}

/// Export a session JSONL to a styled HTML file via `pi --export` (one-shot
/// CLI run; the running RPC session is untouched).
#[tauri::command]
fn pi_export_html(
	app: AppHandle,
	session_path: String,
) -> Result<serde_json::Value, String> {
	use tauri_plugin_dialog::DialogExt;

	let path = PathBuf::from(&session_path);
	if !path.exists() {
		return Err(format!("session not found: {session_path}"));
	}
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

	let info = probe_pi().ok_or("pi binary not found")?;
	let mut cmd = if info.via_cmd {
		let mut c = Command::new("cmd");
		c.arg("/C").arg(&info.bin);
		c
	} else {
		Command::new(&info.bin)
	};
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
fn collect_usage(dir: &Path, out: &mut Vec<PiUsageEntry>) {
	let Ok(entries) = std::fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			if is_aux_dir(&path.file_name().unwrap_or_default().to_string_lossy()) {
				continue;
			}
			collect_usage(&path, out);
		} else if path.extension().is_some_and(|e| e == "jsonl") {
			let Ok(file) = File::open(&path) else { continue };
			let reader = BufReader::new(file);
			let mut project: Option<String> = None;
			for line in reader.lines().flatten() {
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
						let num = |key: &str| {
							usage.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
						};
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
		}
	}
}

#[tauri::command]
fn pi_usage_stats() -> Result<Vec<PiUsageEntry>, String> {
	let mut out = Vec::new();
	collect_usage(&default_session_dir(), &mut out);
	Ok(out)
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
			pi_binary,
			pi_start,
			pi_stop,
			pi_send,
			pi_status,
			pi_export_chat,
			pi_export_html,
			pi_usage_stats,
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
			crate::extras::git_branch_state,
			crate::extras::git_checkout_branch,
			crate::extras::git_create_branch,
			crate::extras::pi_packages,
			crate::extras::pi_package_install,
			crate::extras::pi_package_remove,
			crate::extras::pi_installed_skills,
			crate::extras::pi_move_session,
			crate::rebuild_menu,
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
	fn parses_tool_result_messages() {
		let path = write_temp_session("scan-toolresult", &[
			r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo hi"}}]}}"#,
			r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-10T06:31:16.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"hi\n"}]}}"#,
		]);
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
		let path = write_temp_session("scan-header", &[
			r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:\\projects\\demo"}"#,
			r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-08-10T06:31:02.438Z","provider":"kimi-coding","modelId":"k3"}"#,
			r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-08-10T06:31:10.660Z","message":{"role":"user","content":[{"type":"text","text":"Fix the flaky test in the auth module please"}]}}"#,
			r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"internal note"},{"type":"text","text":"Done."}]}}"#,
		]);
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
	fn parses_tool_calls_and_search_snippets() {
		let path = write_temp_session("scan-tools", &[
			r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:\\projects\\demo"}"#,
			r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-10T06:31:10.660Z","message":{"role":"user","content":[{"type":"text","text":"hello world unique-token-xyz"}]}}"#,
			r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo hi"}},{"type":"text","text":"ran it"}]}}"#,
		]);
		let messages = read_session_messages(&path);
		assert_eq!(messages[1].blocks[0].kind, "tool");
		assert_eq!(messages[1].blocks[0].name.as_deref(), Some("bash"));
		assert!(messages[1].blocks[0].text.contains("echo hi"));

		let snippet = search_snippet(&path, "unique-token-xyz").unwrap();
		assert!(snippet.contains("unique-token-xyz"));

		let _ = std::fs::remove_file(&path);
	}
}
