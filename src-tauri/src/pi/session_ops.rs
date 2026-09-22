use super::pi_process::{lock_state, PiProcess, PiState};
use super::session_store::{
	canonical_or, clean_session_path, collect_sessions, default_session_dir, par_map,
	require_session_path, session_files, PiSearchHit,
};
use super::util::{no_console_window, run_blocking, unique_suffix};
use crate::pi_session::MAX_JSONL_LINE;

use std::collections::HashMap;
use std::{
	fs::File,
	io::{BufRead, BufReader, Read, Write},
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::pi_session::{
	extract_block_text, read_entries_at, read_session_messages, session_entry_index,
	session_values, usage_from_file, EntryRef, LimitedLines, PiParsedMessage, PiUsageEntry,
};

#[tauri::command]
pub async fn pi_read_session(path: String) -> Result<Vec<PiParsedMessage>, String> {
	let p = require_session_path(Path::new(&path))?;
	// SessionError's Display reaches the user verbatim, so a permission or
	// not-found problem is reported as such instead of an "empty session" that
	// silently hides the cause.
	run_blocking(move || read_session_messages(&p).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiForkResult {
	pub session_file: String,
}

/// 32-hex uuid-v4-style id（无需 uuid 依赖：时间 + 地址熵拼接，仅用于唯一性）
pub fn random_session_id() -> String {
	use std::time::{SystemTime, UNIX_EPOCH};
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	let addr = &nanos as *const u128 as usize;
	let mut acc = (nanos as u64) ^ ((addr as u64) << 17) ^ 0x9E37_79B9_7F4A_7C15;
	let mut next = || {
		acc ^= acc << 13;
		acc ^= acc >> 7;
		acc ^= acc << 17;
		acc
	};
	let mut bytes = [0u8; 16];
	for i in 0..4 {
		let v = next().to_le_bytes();
		bytes[i * 4..i * 4 + 4].copy_from_slice(&v[..4]);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // v4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC4122
	let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
	format!(
		"{}-{}-{}-{}-{}",
		&hex[0..8],
		&hex[8..12],
		&hex[12..16],
		&hex[16..20],
		&hex[20..32]
	)
}

/// UTC ISO-8601（无 chrono：civil-from-days）
pub fn iso_utc_now() -> String {
	let secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);
	let days = (secs / 86_400) as i64;
	let rem = secs % 86_400;
	let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
	// Howard Hinnant 的 civil_from_days
	let z = days + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let month = if mp < 10 { mp + 3 } else { mp - 9 };
	let year = if month <= 2 { y + 1 } else { y };
	format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

pub fn fork_session_at(src: &Path, entry_id: Option<&str>) -> Result<PiForkResult, String> {
	use std::collections::HashMap;
	// Two passes: index the entries (id / parent / byte offset — a few dozen
	// bytes each), then re-read only the chain's lines. The previous single
	// pass parsed every entry into a Vec<Value> — several times the file size
	// in RAM on a long session — just to walk one parent chain.
	let (header, index) =
		session_entry_index(src).map_err(|e| format!("failed to open session: {e}"))?;
	let header = header.ok_or("session file has no header entry")?;
	let cwd = header
		.get("cwd")
		.and_then(|x| x.as_str())
		.unwrap_or("")
		.to_string();
	// 输出路径与 parentSession 用去掉 verbatim 前缀的普通形式
	let cleaned = clean_session_path(src.to_path_buf());
	let src = cleaned.as_path();

	// 未指定条目 → 取文件末尾条目（pi 线性追加，最后一行即当前分支叶）
	let target_id: String = match entry_id {
		Some(id) => id.to_string(),
		None => index
			.last()
			.map(|e| e.id.clone())
			.ok_or("session has no entries")?,
	};

	let by_id: HashMap<&str, &EntryRef> = index.iter().map(|e| (e.id.as_str(), e)).collect();
	let Some(target) = by_id.get(target_id.as_str()) else {
		return Err(format!("entry {target_id} not found in session"));
	};
	// 沿 parentId 走到根（leaf→root），再反转为 root→leaf
	let mut chain: Vec<&EntryRef> = Vec::new();
	let mut cur = Some(*target);
	let mut guard = 0usize;
	while let Some(e) = cur {
		chain.push(e);
		match e.parent_id.as_deref() {
			Some(p) => {
				// A parent that isn't in the file is a broken chain, not a root.
				let Some(parent) = by_id.get(p) else {
					return Err(format!("broken parent chain at {p}"));
				};
				cur = Some(*parent);
			}
			None => cur = None,
		}
		guard += 1;
		if guard > index.len() + 1 {
			return Err("parent chain loop detected".into());
		}
	}
	chain.reverse();
	// 第二遍：只重读链上的行（label 条目依旧丢弃并重接 parentId，pi 同款处理）
	let offsets: Vec<u64> = chain.iter().map(|e| e.offset).collect();
	let values =
		read_entries_at(src, &offsets).map_err(|e| format!("failed to re-read session: {e}"))?;
	// 去掉 label 条目并重接 parentId（pi 同款处理，避免孤儿子树）
	let mut out_entries: Vec<serde_json::Value> = Vec::with_capacity(values.len());
	let mut prev_id: Option<String> = None;
	for mut entry in values {
		if entry.get("type").and_then(|x| x.as_str()) == Some("label") {
			continue;
		}
		if let Some(obj) = entry.as_object_mut() {
			obj.insert(
				"parentId".into(),
				match &prev_id {
					Some(p) => serde_json::Value::String(p.clone()),
					None => serde_json::Value::Null,
				},
			);
		}
		prev_id = entry
			.get("id")
			.and_then(|x| x.as_str())
			.map(|s| s.to_string());
		out_entries.push(entry);
	}

	// 新文件：pi 命名约定 {fileTimestamp}_{sessionId}.jsonl（同一会话目录）
	let new_id = random_session_id();
	let now_iso = iso_utc_now();
	let file_stamp = now_iso.replace([':', '.'], "-");
	let dir = src
		.parent()
		.map(|p| p.to_path_buf())
		.ok_or("session file has no parent dir")?;
	let new_file = dir.join(format!("{file_stamp}_{new_id}.jsonl"));

	let mut new_header = serde_json::Map::new();
	new_header.insert("type".into(), "session".into());
	new_header.insert("version".into(), serde_json::Value::from(3));
	new_header.insert("id".into(), serde_json::Value::from(new_id.clone()));
	new_header.insert("timestamp".into(), serde_json::Value::from(now_iso.clone()));
	if !cwd.is_empty() {
		new_header.insert("cwd".into(), serde_json::Value::from(cwd));
	}
	new_header.insert(
		"parentSession".into(),
		serde_json::Value::from(src.to_string_lossy().to_string()),
	);

	let mut body = String::new();
	body.push_str(
		&serde_json::to_string(&serde_json::Value::Object(new_header))
			.map_err(|e| e.to_string())?,
	);
	body.push('\n');
	for e in &out_entries {
		body.push_str(&serde_json::to_string(e).map_err(|e| e.to_string())?);
		body.push('\n');
	}
	std::fs::write(&new_file, body)
		.map_err(|e| format!("failed to write branched session: {e}"))?;
	Ok(PiForkResult {
		session_file: new_file.to_string_lossy().to_string(),
	})
}

#[tauri::command]
pub async fn pi_fork_session(
	path: String,
	entry_id: Option<String>,
) -> Result<PiForkResult, String> {
	let src = require_session_path(Path::new(&path))?;
	run_blocking(move || fork_session_at(&src, entry_id.as_deref())).await
}

#[tauri::command]
pub async fn pi_search_sessions(
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

/// Largest byte offset <= `i` that is a char boundary of `s`. Unicode case
/// folding can change byte lengths (`İ` lowercases to two chars), so a match
/// offset from the lowercased text can land mid-character in the original —
/// slicing there would panic.
pub fn snap_to_char_boundary(s: &str, i: usize) -> usize {
	if i >= s.len() {
		return s.len();
	}
	let mut i = i;
	while i > 0 && !s.is_char_boundary(i) {
		i -= 1;
	}
	i
}

/// Find the first line containing the query (case-insensitive) and return a
/// short snippet of message text around it.
pub fn search_snippet(path: &Path, query: &str) -> Option<String> {
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
				let start = snap_to_char_boundary(&text, idx.saturating_sub(40));
				let end = snap_to_char_boundary(&text, (idx + query.len() + 80).min(text.len()));
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

/// Recursively blank the `data` payload of image content blocks; returns the
/// number of images stripped.
pub fn strip_image_data(v: &mut serde_json::Value) -> usize {
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
pub fn cap_strings(v: &mut serde_json::Value, max: usize) {
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
pub fn compact_session_images_inner(p: &Path) -> Result<serde_json::Value, String> {
	let before = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
	let tmp_path = p.with_extension(format!("jsonl.{}.tmp", unique_suffix()));
	let mut removed = 0usize;
	let write_result = (|| -> Result<(), String> {
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
		Ok(())
	})();
	// Any error inside the rewrite leaves the tmp behind — remove it so the
	// sessions directory doesn't accumulate orphaned *.tmp copies (they are
	// invisible to the listing and can be hundreds of MB).
	if let Err(e) = write_result {
		let _ = std::fs::remove_file(&tmp_path);
		return Err(e);
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
	if let Err(e) = std::fs::rename(&tmp_path, p) {
		// Don't leave the fully-written tmp behind: it would never be cleaned
		// up (only *.jsonl files are listed) and can be hundreds of MB.
		let _ = std::fs::remove_file(&tmp_path);
		return Err(format!("failed to persist session: {e}"));
	}
	let after = std::fs::metadata(p).map(|m| m.len()).unwrap_or(before);
	Ok(serde_json::json!({
		"ok": true,
		"removed": removed,
		"before": before,
		"after": after
	}))
}

#[tauri::command]
pub async fn pi_compact_session_images(
	state: State<'_, PiState>,
	path: String,
) -> Result<serde_json::Value, String> {
	let p = require_session_path(Path::new(&path))?;
	// Reserve the session for the duration of the rewrite (same mechanism as
	// pi_start's placeholder): the is_running_session check alone leaves a
	// window where pi_start can attach to the same file and append while the
	// rewrite is mid-flight — pi keeps appending to the renamed (old) inode on
	// Unix, corrupting the compaction result.
	let full = p.clone();
	let guard_key = format!("\u{1}compact\u{1}{}", full.display());
	{
		let mut map = lock_state(&state.inner);
		if map.values().any(|proc| {
			proc.session_file
				.as_deref()
				.is_some_and(|s| canonical_or(s) == full)
		}) {
			return Err("session is already open in another window".into());
		}
		map.insert(
			guard_key.clone(),
			PiProcess {
				session_file: Some(full),
				..Default::default()
			},
		);
	}
	let result = run_blocking(move || compact_session_images_inner(&p)).await;
	{
		let mut map = lock_state(&state.inner);
		// Remove only our own placeholder; a concurrent start may have
		// installed a live process under a different key, never this one.
		if map.get(&guard_key).is_some_and(|proc| proc.child.is_none()) {
			map.remove(&guard_key);
		}
	}
	result
}

#[tauri::command]
pub async fn pi_export_chat(
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

/// Export a session JSONL to a styled HTML file via the SDK sidecar (the
/// same `exportFromFile` code path as `pi --export`; the running RPC session
/// is untouched). The save dialog stays on the UI thread; the export itself
/// moves to the blocking pool.
#[tauri::command]
pub async fn pi_export_html(
	app: AppHandle,
	session_path: String,
) -> Result<serde_json::Value, String> {
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
		crate::sidecar::export_html(&path, &target)?;
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

/// Share the current session as a private GitHub gist (the TUI's `/share`):
/// requires the `gh` CLI to be installed and logged in. Exports the session
/// to HTML via the SDK sidecar, uploads it with `gh gist create --private`,
/// and returns the gist URL.
#[tauri::command]
pub async fn pi_share_session(session_path: String) -> Result<String, String> {
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
		// 2. Export to a temp HTML file via the SDK sidecar (owner-only on
		// Unix: the export carries the whole session, secrets included).
		let tmp = std::env::temp_dir().join(format!("tau-share-{}.html", unique_suffix()));
		let _ = std::fs::remove_file(&tmp);
		let export = crate::sidecar::export_html(&path, &tmp);
		if let Err(e) = export {
			let _ = std::fs::remove_file(&tmp);
			return Err(format!("export failed: {e}"));
		}
		// The comment above promised owner-only, but the file is written by the
		// sidecar's Node process under the default umask — on a shared machine
		// that leaves a world-readable copy of the whole session in /tmp.
		// write_private can't help (it creates the file itself), so re-apply
		// its guarantee here. Windows temp ACLs are already user-scoped.
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
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
pub const MAX_TREE_DEPTH: usize = 512;

pub fn build_tree_node_iter(
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

pub fn read_tree_from_file(p: &Path) -> Result<serde_json::Value, String> {
	let values = session_values(p, None).map_err(|e| format!("cannot read session: {e}"))?;
	let mut by_id: HashMap<String, Value> = HashMap::new();
	let mut children: HashMap<String, Vec<String>> = HashMap::new();
	let mut labels: HashMap<String, String> = HashMap::new();
	let mut roots: Vec<String> = Vec::new();
	let mut last_id: Option<String> = None;
	for v in values {
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
pub async fn pi_read_tree(path: String) -> Result<serde_json::Value, String> {
	let p = require_session_path(Path::new(&path))?;
	run_blocking(move || read_tree_from_file(&p)).await
}

// ---- live subagent run status (pi-subagents extension) ----

/// Keep only the fields the tree viewer needs, dropping tool outputs,
/// thinking blocks, image data and usage records. Text content is kept as a
/// short preview so node labels still make sense.
pub fn slim_tree_node(root: &Value) -> Value {
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
pub fn tree_text_preview(content: &Value, max: usize) -> String {
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
pub fn slim_get_tree_payload(payload: &Value) -> Value {
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

/// Scan every session JSONL for LLM `usage` records (one per assistant
/// message). The frontend aggregates by day/model/project for the usage
/// dashboard. Files are scanned on worker threads so a large session set
/// doesn't block the UI thread. Returns how many files were unreadable (the
/// caller logs it — silently skipping them used to under-report the dashboard
/// with no hint why).
pub fn collect_usage(dir: &Path, out: &mut Vec<PiUsageEntry>) -> usize {
	let mut files = Vec::new();
	session_files(dir, &mut files, 0);
	let entries = par_map(files, usage_from_file);
	let mut skipped = 0;
	for entry in entries {
		match entry {
			Ok(e) => out.extend(e),
			Err(e) => {
				skipped += 1;
				eprintln!("pi-gui: usage scan skipped a session file: {e}");
			}
		}
	}
	skipped
}

#[tauri::command]
pub async fn pi_usage_stats(app: AppHandle) -> Result<Vec<PiUsageEntry>, String> {
	run_blocking(move || {
		let mut out = Vec::new();
		let skipped = collect_usage(&default_session_dir(), &mut out);
		if skipped > 0 {
			crate::runtime_log::log_warn(
				&app,
				&format!("usage scan skipped {skipped} unreadable session file(s)"),
			);
		}
		Ok(out)
	})
	.await
}
