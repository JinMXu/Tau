use std::{
	fs,
	path::PathBuf,
	sync::Mutex,
	time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

/// Minimal structured runtime log under the app config dir (`logs/tau.log`).
/// Kept intentionally small: startup milestones and command errors only.
static LOG_MUTEX: Mutex<()> = Mutex::new(());

fn log_path(app: &AppHandle) -> PathBuf {
	app.path()
		.app_config_dir()
		.unwrap_or_else(|_| PathBuf::from("."))
		.join("logs")
		.join("tau.log")
}

/// Rotate the log once it exceeds this size, so a long-running app can't grow
/// it without bound (the 15s heartbeat alone would add ~4 MB/month).
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub fn log(app: &AppHandle, level: &str, message: &str) {
	let _guard = match LOG_MUTEX.lock() {
		Ok(g) => g,
		Err(poisoned) => poisoned.into_inner(),
	};
	let path = log_path(app);
	if let Some(dir) = path.parent() {
		let _ = fs::create_dir_all(dir);
	}
	// Single-level rotation: once past the cap, keep the previous log as
	// `tau.log.1` and start fresh.
	if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
		let backup = path.with_extension("log.1");
		let _ = fs::remove_file(&backup);
		let _ = fs::rename(&path, &backup);
	}
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let line = format!("[{now}] [{level}] {message}\n");
	let _ = fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(&path)
		.map(|mut f| {
			use std::io::Write;
			let _ = f.write_all(line.as_bytes());
		});
}

pub fn log_info(app: &AppHandle, message: &str) {
	log(app, "info", message);
}

pub fn log_error(app: &AppHandle, message: &str) {
	log(app, "error", message);
}

/// Build a plain-text diagnostics bundle for the "导出诊断日志" settings
/// action: a small environment header followed by the current log and the
/// rotated previous log (when present), so a crash/freeze report is a single
/// file the user can hand to developers.
pub fn collect_bundle(app: &AppHandle) -> String {
	let info = app.package_info();
	let path = log_path(app);
	let mut out = String::new();
	out.push_str(&format!("app: {} {}\n", info.name, info.version));
	out.push_str(&format!(
		"os: {} {}\n",
		std::env::consts::OS,
		std::env::consts::ARCH
	));
	out.push_str(&format!("log path: {}\n", path.display()));
	out.push_str("\n==== tau.log ====\n");
	match fs::read_to_string(&path) {
		Ok(s) => out.push_str(&s),
		Err(e) => out.push_str(&format!("<unreadable: {e}>\n")),
	}
	let backup = path.with_extension("log.1");
	if backup.exists() {
		out.push_str("\n==== tau.log.1 (rotated) ====\n");
		match fs::read_to_string(&backup) {
			Ok(s) => out.push_str(&s),
			Err(e) => out.push_str(&format!("<unreadable: {e}>\n")),
		}
	}
	out
}
