use std::{
	fs,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
		Mutex,
	},
	thread,
	time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

#[derive(Serialize, Deserialize, Default, Clone)]
struct WindowState {
	width: f64,
	height: f64,
	x: i32,
	y: i32,
	maximized: bool,
}

fn state_path(app: &AppHandle, label: &str) -> PathBuf {
	// One state file per window label: with multi-window support every window
	// used to read/write the same file, so new windows restored the main
	// window's geometry (stacking on top of it) and each window's move/resize
	// clobbered the others' saved state. The main window keeps the legacy
	// file name so existing users don't lose their saved geometry.
	let file = if label == "main" {
		"window-state.json".to_string()
	} else {
		format!("window-state-{label}.json")
	};
	app.path()
		.app_config_dir()
		.unwrap_or_else(|_| PathBuf::from("."))
		.join(file)
}

/// Whether the window's current position intersects any connected monitor.
/// Guards against restoring a window onto a display that has been unplugged
/// (which would leave it unreachable off-screen).
fn on_screen(window: &WebviewWindow) -> bool {
	let Ok(size) = window.outer_size() else { return true };
	let Ok(pos) = window.outer_position() else { return true };
	let Ok(monitors) = window.available_monitors() else { return true };
	monitors.iter().any(|m| {
		let mp = m.position();
		let ms = m.size();
		let w = size.width as i32;
		let h = size.height as i32;
		// The title bar must intersect a monitor so the user can grab it.
		pos.x < mp.x + ms.width as i32
			&& pos.x + w > mp.x
			&& pos.y < mp.y + ms.height as i32
			&& pos.y + h > mp.y
	})
}

/// Restore the window size/position saved from the previous run.
pub fn restore(window: &WebviewWindow) {
	let path = state_path(&window.app_handle(), window.label());
	let Ok(raw) = fs::read_to_string(&path) else { return };
	let Ok(state) = serde_json::from_str::<WindowState>(&raw) else {
		return;
	};
	if state.width >= 400.0 && state.height >= 300.0 {
		let _ = window.set_size(PhysicalSize::new(state.width as u32, state.height as u32));
	}
	if state.x != i32::MIN {
		let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
		// Fall back to the center of the primary monitor when the saved spot
		// is no longer on any connected display.
		if !on_screen(window) {
			if let Some(monitor) = window.primary_monitor().ok().flatten() {
				let mp = monitor.position();
				let ms = monitor.size();
				let w = (state.width.max(400.0) as u32).min(ms.width);
				let h = (state.height.max(300.0) as u32).min(ms.height);
				let x = mp.x + ((ms.width as i32 - w as i32) / 2).max(0);
				let y = mp.y + ((ms.height as i32 - h as i32) / 2).max(0);
				let _ = window.set_position(PhysicalPosition::new(x, y));
			}
		}
	}
	if state.maximized {
		let _ = window.maximize();
	}
}

/// Persist window geometry (debounced) while the window is being resized/moved.
pub fn attach(window: &WebviewWindow) {
	let path = state_path(&window.app_handle(), window.label());
	let state = Arc::new(Mutex::new(WindowState {
		width: 800.0,
		height: 600.0,
		x: i32::MIN,
		y: i32::MIN,
		maximized: false,
	}));
	let saving = Arc::new(AtomicBool::new(false));
	let win = window.clone();

	window.on_window_event(move |event| {
		let mut s = state.lock().unwrap();
		match event {
			WindowEvent::Resized(size) => {
				s.width = size.width as f64;
				s.height = size.height as f64;
			}
			WindowEvent::Moved(pos) => {
				s.x = pos.x;
				s.y = pos.y;
			}
			WindowEvent::CloseRequested { .. } => {
				s.maximized = win.is_maximized().unwrap_or(false);
				let _ = fs::write(&path, serde_json::to_string(&*s).unwrap_or_default());
				return;
			}
			_ => return,
		}
		if saving.swap(true, Ordering::SeqCst) {
			return;
		}
		let snapshot = s.clone();
		let path = path.clone();
		let saving = saving.clone();
		thread::spawn(move || {
			thread::sleep(Duration::from_millis(400));
			let _ = fs::write(&path, serde_json::to_string(&snapshot).unwrap_or_default());
			saving.store(false, Ordering::SeqCst);
		});
	});
}
