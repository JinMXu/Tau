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

fn state_path(app: &AppHandle) -> PathBuf {
	app.path()
		.app_config_dir()
		.unwrap_or_else(|_| PathBuf::from("."))
		.join("window-state.json")
}

/// Restore the window size/position saved from the previous run.
pub fn restore(window: &WebviewWindow) {
	let path = state_path(&window.app_handle());
	let Ok(raw) = fs::read_to_string(&path) else { return };
	let Ok(state) = serde_json::from_str::<WindowState>(&raw) else {
		return;
	};
	if state.width >= 400.0 && state.height >= 300.0 {
		let _ = window.set_size(PhysicalSize::new(state.width as u32, state.height as u32));
	}
	if state.x != i32::MIN {
		let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
	}
	if state.maximized {
		let _ = window.maximize();
	}
}

/// Persist window geometry (debounced) while the window is being resized/moved.
pub fn attach(window: &WebviewWindow) {
	let path = state_path(&window.app_handle());
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
