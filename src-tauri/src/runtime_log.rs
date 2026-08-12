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

pub fn log(app: &AppHandle, level: &str, message: &str) {
	let _guard = match LOG_MUTEX.lock() {
		Ok(g) => g,
		Err(poisoned) => poisoned.into_inner(),
	};
	let path = log_path(app);
	if let Some(dir) = path.parent() {
		let _ = fs::create_dir_all(dir);
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
