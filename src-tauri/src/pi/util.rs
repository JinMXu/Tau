use std::{
	fs::File,
	io::Write,
	path::{Path, PathBuf},
	process::Command,
};

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

/// `Command` for a well-known system tool, resolved to its absolute system
/// path when possible. Windows' search order includes the exe's directory and
/// (unless NoDefaultCurrentDirectoryInExePath is set) the current directory,
/// so a bare `Command::new("curl")` could be shadowed by a same-user binary
/// parked next to the (per-user installable) app. Only fixed system tools go
/// through here — user-installed tools (git, gh) stay on PATH.
pub(crate) fn system_command(tool: &str) -> Command {
	let absolute = if cfg!(windows) {
		std::env::var_os("WINDIR").map(|w| {
			PathBuf::from(w)
				.join("System32")
				.join(format!("{tool}.exe"))
		})
	} else {
		match tool {
			"open" => Some(PathBuf::from("/usr/bin/open")),
			"xdg-open" => Some(PathBuf::from("/usr/bin/xdg-open")),
			_ => None,
		}
	};
	match absolute.filter(|p| p.is_file()) {
		Some(p) => Command::new(p),
		None => Command::new(tool),
	}
}

/// Write `data` to `path`, restricted to the current user on Unix. Temp files
/// carrying session drafts / shared sessions / request bodies must not fall
/// out world-readable through the default umask.
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
	let mut f =
		File::create(path).map_err(|e| format!("failed to create {}: {e}", path.display()))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
	}
	f.write_all(data)
		.map_err(|e| format!("failed to write {}: {e}", path.display()))
}

pub fn unix_ms(t: std::time::SystemTime) -> u64 {
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

/// Runs a blocking closure on the dedicated blocking thread pool so the UI
/// thread is never frozen while scanning session files or running the pi
/// CLI. (Sync Tauri commands run on the main thread — every window would
/// freeze while a large session directory is scanned.)
pub async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, String> + Send + 'static,
{
	tauri::async_runtime::spawn_blocking(f)
		.await
		.map_err(|e| format!("background task failed: {e}"))?
}
