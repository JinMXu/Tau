use super::pi_process::{is_running_session, PiState};
use super::util::{run_blocking, system_command, unix_ms};

use std::collections::HashMap;
use std::{
	path::{Path, PathBuf},
	sync::atomic::Ordering,
	sync::{LazyLock, Mutex},
	time::SystemTime,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::pi_session::{scan_session, session_values};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionInfo {
	pub path: String,
	pub name: String,
	/// Project directory the session ran in (from the session header `cwd`).
	pub project: Option<String>,
	/// Human title derived from the first user message.
	pub title: String,
	/// Last known provider/model (from `model_change` events).
	pub model: Option<String>,
	pub created_at: Option<u64>,
	pub message_count: u64,
	pub mtime_ms: u64,
	pub size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiArchivedSession {
	pub path: String,
	pub original_path: String,
	pub title: String,
	pub project: Option<String>,
	pub mtime_ms: u64,
	pub size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSearchHit {
	pub path: String,
	pub title: String,
	pub project: Option<String>,
	pub snippet: String,
	pub updated_at: u64,
}

pub(crate) fn home_dir() -> Option<PathBuf> {
	if cfg!(windows) {
		std::env::var_os("USERPROFILE").map(PathBuf::from)
	} else {
		std::env::var_os("HOME").map(PathBuf::from)
	}
}

pub fn default_session_dir() -> PathBuf {
	if let Some(dir) = std::env::var_os("PI_SESSION_DIR") {
		return PathBuf::from(dir);
	}
	home_dir()
		.map(|h| h.join(".pi").join("agent").join("sessions"))
		.unwrap_or_else(|| PathBuf::from(".pi/agent/sessions"))
}

pub fn file_stem(path: &Path) -> String {
	path.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or_default()
		.to_string()
}

pub fn canonical_dir(p: &Path) -> Option<PathBuf> {
	std::fs::canonicalize(p).ok()
}

/// Canonicalize `path`, falling back to the raw path when canonicalization
/// fails (e.g. the file doesn't exist). Used for running-session comparisons:
/// `PiProcess.session_file` stores the path as the frontend sent it (raw,
/// possibly without the `\\?\` prefix canonicalize adds on Windows), so both
/// sides must be canonicalized before comparing.
pub fn canonical_or(path: &Path) -> PathBuf {
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

pub fn is_aux_dir(name: &str) -> bool {
	name == ".pi-gui-archive" || name == ".pi-gui-trash"
}

pub fn aux_root() -> PathBuf {
	default_session_dir()
}

pub fn archive_dir() -> PathBuf {
	aux_root().join(".pi-gui-archive")
}

pub fn trash_dir() -> PathBuf {
	aux_root().join(".pi-gui-trash")
}

/// Walk the sessions tree for `*.jsonl` files. Depth-capped and symlink-safe
/// (`DirEntry::file_type` does not follow links), so a symlink cycle in the
/// sessions directory can't cause unbounded recursion.
pub fn session_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
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
pub fn par_map<T: Send>(items: Vec<PathBuf>, f: impl Fn(&Path) -> T + Sync) -> Vec<T> {
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

/// 子代理会话存放在嵌套目录（<项目目录>/<会话uuid>/<agent-id>/…）；
/// 分支会话（pi 的 fork 与 Tau 的 pi_fork_session）与用户会话同层，
/// header 也带 parentSession——判据是相对目录深度而非 header。
pub fn is_nested_session(sessions_root: &Path, path: &Path) -> bool {
	path.strip_prefix(sessions_root)
		.map(|r| r.components().count() > 2)
		.unwrap_or(false)
}

/// Session scan results keyed by (mtime, size). `collect_sessions` reads the
/// first 400 lines of every session file, and both the sidebar list and ⌘K
/// search call it on every keystroke pause — while only the files pi is
/// currently appending to actually change between calls. Stat metadata is
/// the change key (an append always moves the size; a rewrite moves the
/// mtime), so a hit turns a full re-scan into an O(changed files) walk.
/// Entries for files that no longer exist are pruned on every pass, which
/// bounds the map by the live session count.
pub struct ScanCacheEntry {
	pub modified: Option<SystemTime>,
	pub size: u64,
	pub info: PiSessionInfo,
}

pub static SCAN_CACHE: LazyLock<Mutex<HashMap<PathBuf, ScanCacheEntry>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn scan_cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, ScanCacheEntry>> {
	SCAN_CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn collect_sessions(dir: &Path, out: &mut Vec<PiSessionInfo>) {
	let mut files = Vec::new();
	session_files(dir, &mut files, 0);
	// 列表只收与用户会话同层的文件；嵌套的子代理产物跳过。
	// （归档/清理等全量遍历场景直接用 session_files。）
	files.retain(|p| !is_nested_session(dir, p));
	let infos = par_map(files, |path| {
		let meta = std::fs::metadata(path).ok();
		let modified = meta.as_ref().and_then(|m| m.modified().ok());
		let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
		// Fast path: unchanged since the last scan — reuse without opening.
		{
			let cache = scan_cache();
			if let Some(hit) = cache.get(path) {
				if hit.size == size && hit.modified == modified {
					return Some(hit.info.clone());
				}
			}
		}
		let scan = scan_session(path, 400);
		let info = PiSessionInfo {
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
			mtime_ms: modified.map(unix_ms).unwrap_or(0),
			size,
		};
		let mut cache = scan_cache();
		cache.insert(
			path.to_path_buf(),
			ScanCacheEntry {
				modified,
				size,
				info: info.clone(),
			},
		);
		Some(info)
	});
	// Drop entries whose file disappeared, so an app that creates and deletes
	// sessions all day doesn't grow the map without bound. Scoped to this
	// directory: a scan of another root (imports) must not evict the entries
	// the sidebar list just warmed.
	let live: std::collections::HashSet<PathBuf> = infos
		.iter()
		.flatten()
		.map(|i| PathBuf::from(&i.path))
		.collect();
	scan_cache().retain(|k, _| !k.starts_with(dir) || live.contains(k));
	out.extend(infos.into_iter().flatten());
}

#[tauri::command]
pub async fn pi_list_sessions() -> Result<Vec<PiSessionInfo>, String> {
	run_blocking(|| {
		let mut out = Vec::new();
		collect_sessions(&default_session_dir(), &mut out);
		out.sort_by_key(|x| std::cmp::Reverse(x.mtime_ms));
		Ok(out)
	})
	.await
}

/// 分叉会话到指定条目（含该条目）：复刻 pi SessionManager.createBranchedSession
/// 的落盘格式。pi 的 fork RPC 固定 position:"before"（只接受 user 条目），无法
/// 用于 assistant 消息的分叉，所以在宿主侧落盘后由前端 switch_session 切换。
/// entry_id 为空时取文件末尾条目（当前分支 leaf，即刚结束的 assistant 消息）。
/// 去掉 Windows verbatim 前缀（`std::fs::canonicalize` 的产物 `\\?\C:\...`）。
/// 返回给前端的路径必须与目录遍历得到的普通形式一致：sameSessionPath 只归一
/// 大小写与斜杠，带前缀的路径会让 re-attach/占用判定失配（点击会话无反应）。
pub fn clean_session_path(p: PathBuf) -> PathBuf {
	let s = p.to_string_lossy().to_string();
	if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
		return PathBuf::from(format!(r"\\{rest}"));
	}
	if let Some(rest) = s.strip_prefix(r"\\?\") {
		return PathBuf::from(rest);
	}
	p
}

pub fn move_to(target_dir: &Path, from: &Path, to: &Path) -> Result<(), String> {
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

pub fn move_with_sidecar(path: &Path, target_dir: &Path) -> Result<(), String> {
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

pub fn meta_original_path(dir: &Path, file_name: &str) -> Option<String> {
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
pub fn move_session_to_aux(path: &Path, target_dir: &Path) -> Result<(), String> {
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
pub fn pi_archive_session(state: State<'_, PiState>, path: String) -> Result<(), String> {
	let p = require_session_path(Path::new(&path))?;
	if is_running_session(&state, &p) {
		return Err("stop the running session before archiving it".into());
	}
	move_session_to_aux(&p, &archive_dir())
}

#[tauri::command]
pub fn pi_delete_session(state: State<'_, PiState>, path: String) -> Result<(), String> {
	let p = require_session_path(Path::new(&path))?;
	if is_running_session(&state, &p) {
		return Err("stop the running session before deleting it".into());
	}
	move_session_to_aux(&p, &trash_dir())
}

#[tauri::command]
pub async fn pi_list_archived_sessions() -> Result<Vec<PiArchivedSession>, String> {
	run_blocking(|| {
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
	})
	.await
}

#[tauri::command]
pub fn pi_restore_session(path: String) -> Result<(), String> {
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
pub fn pi_purge_session(path: String) -> Result<(), String> {
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
pub fn pi_reveal_session(path: String) -> Result<(), String> {
	let path = require_session_path(Path::new(&path))?;
	#[cfg(target_os = "windows")]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x08000000;
		let _ = system_command("explorer")
			.arg(format!("/select,{}", path.display()))
			.creation_flags(CREATE_NO_WINDOW)
			.spawn();
		Ok(())
	}
	#[cfg(target_os = "macos")]
	{
		let _ = system_command("open")
			.args(["-R", &path.to_string_lossy()])
			.spawn();
		Ok(())
	}
	#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
	{
		let parent = path.parent().unwrap_or(&path);
		let _ = system_command("xdg-open").arg(parent).spawn();
		Ok(())
	}
}

/// Sanitize a working directory into pi's per-project session folder name:
/// `--<cwd with [/\\:] -> ->--` (matches pi's session-manager layout).
pub fn session_project_dir_name(cwd: &str) -> String {
	let trimmed = cwd.trim_start_matches(['/', '\\']);
	format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

/// Import a session from an external JSONL file: pick it with a native file
/// dialog, then copy it into the sessions directory under the project folder
/// matching its header `cwd` (created on demand). Returns the new session
/// path so the frontend can open it.
#[tauri::command]
pub async fn pi_import_session(app: AppHandle) -> Result<Option<String>, String> {
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
		let values = session_values(&src, None)
			.map_err(|_| format!("cannot read file: {}", src.display()))?;
		for v in values {
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
