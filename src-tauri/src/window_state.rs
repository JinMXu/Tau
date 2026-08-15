use std::{
	fs,
	path::PathBuf,
	sync::{
		atomic::{AtomicBool, Ordering},
		Arc, Mutex,
	},
	thread,
	time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

#[derive(Serialize, Deserialize, Default, Clone)]
struct WindowState {
	width: f64,
	height: f64,
	x: i32,
	y: i32,
	maximized: bool,
}

fn state_path<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) -> PathBuf {
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

/// Clamp a window position so the window stays fully inside the given work
/// area (the monitor's screen minus the taskbar). Returns the corrected
/// position when the window would otherwise end up hidden behind the taskbar
/// or past another screen edge; returns None when the position already fits.
#[allow(clippy::too_many_arguments)]
fn clamp_position(
	wa_x: i32,
	wa_y: i32,
	wa_w: i32,
	wa_h: i32,
	win_w: i32,
	win_h: i32,
	x: i32,
	y: i32,
) -> Option<(i32, i32)> {
	// A window larger than the work area can't fully fit; keep its top-left
	// corner visible instead of letting it drift off-screen.
	let nx = if win_w <= wa_w {
		x.clamp(wa_x, wa_x + wa_w - win_w)
	} else {
		x.max(wa_x)
	};
	let ny = if win_h <= wa_h {
		y.clamp(wa_y, wa_y + wa_h - win_h)
	} else {
		y.max(wa_y)
	};
	if (nx, ny) != (x, y) {
		Some((nx, ny))
	} else {
		None
	}
}

/// Clamp a window position to the work area of the monitor it is currently on.
/// The composer (and its project/branch pickers) live at the bottom of the
/// window, so letting the bottom edge slide under the taskbar makes those
/// controls unreachable — this keeps the whole window visible.
fn clamp_to_work_area<R: tauri::Runtime>(
	window: &tauri::WebviewWindow<R>,
	x: i32,
	y: i32,
) -> Option<(i32, i32)> {
	let Ok(size) = window.outer_size() else {
		return None;
	};
	let Ok(Some(monitor)) = window.current_monitor() else {
		return None;
	};
	let wa = *monitor.work_area();
	clamp_position(
		wa.position.x,
		wa.position.y,
		wa.size.width as i32,
		wa.size.height as i32,
		size.width as i32,
		size.height as i32,
		x,
		y,
	)
}

/// Whether the window's current position intersects any connected monitor.
/// Guards against restoring a window onto a display that has been unplugged
/// (which would leave it unreachable off-screen).
fn on_screen<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
	let Ok(size) = window.outer_size() else {
		return true;
	};
	let Ok(pos) = window.outer_position() else {
		return true;
	};
	let Ok(monitors) = window.available_monitors() else {
		return true;
	};
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
pub fn restore<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
	let path = state_path(window.app_handle(), window.label());
	let Ok(raw) = fs::read_to_string(&path) else {
		return;
	};
	let Ok(state) = serde_json::from_str::<WindowState>(&raw) else {
		return;
	};
	if state.width >= 400.0 && state.height >= 300.0 {
		let _ = window.set_size(PhysicalSize::new(state.width as u32, state.height as u32));
	}
	if state.x != i32::MIN {
		let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
		// Fall back to the center of the primary monitor's work area (the
		// screen minus the taskbar) when the saved spot is no longer on any
		// connected display.
		if !on_screen(window) {
			if let Some(monitor) = window.primary_monitor().ok().flatten() {
				let wa = *monitor.work_area();
				let mp = wa.position;
				let ms = wa.size;
				let w = (state.width.max(400.0) as u32).min(ms.width);
				let h = (state.height.max(300.0) as u32).min(ms.height);
				let x = mp.x + ((ms.width as i32 - w as i32) / 2).max(0);
				let y = mp.y + ((ms.height as i32 - h as i32) / 2).max(0);
				let _ = window.set_position(PhysicalPosition::new(x, y));
			}
		} else if let Some((x, y)) = clamp_to_work_area(window, state.x, state.y) {
			// A previous session may have parked the window so its bottom (the
			// composer with the project/branch pickers) sits behind the
			// taskbar — pull it back into the visible desktop area.
			let _ = window.set_position(PhysicalPosition::new(x, y));
		}
	}
	if state.maximized {
		let _ = window.maximize();
	}
}

/// Persist window geometry (debounced) while the window is being resized/moved.
pub fn attach<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
	let path = state_path(window.app_handle(), window.label());
	let state = Arc::new(Mutex::new(WindowState {
		width: 1280.0,
		height: 800.0,
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
				// Live guard: never let the window's bottom slide under the
				// taskbar (the composer + project/branch chips would end up
				// hidden). Skipped while maximized — its bounds are the work
				// area already and set_position would fight the
				// restore-from-maximize transition.
				if !win.is_maximized().unwrap_or(false) {
					if let Some((nx, ny)) = clamp_to_work_area(&win, pos.x, pos.y) {
						s.x = nx;
						s.y = ny;
						let _ = win.set_position(PhysicalPosition::new(nx, ny));
					}
				}
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
		let state_arc = state.clone();
		let path = path.clone();
		let saving = saving.clone();
		let win_for_save = win.clone();
		thread::spawn(move || {
			thread::sleep(Duration::from_millis(400));
			// Never persist fullscreen (or mid-transition) geometry: entering
			// fullscreen animates the size and fires continuous Resized events,
			// and saving an intermediate frame would restore a wrong window
			// size on the next launch.
			if win_for_save.is_fullscreen().unwrap_or(false) {
				saving.store(false, Ordering::SeqCst);
				return;
			}
			// Write the LATEST state, not the snapshot captured at spawn: an
			// event arriving during the sleep mutates `state` under the lock
			// and would otherwise be lost if no further event re-triggers.
			let latest = state_arc.lock().unwrap().clone();
			let _ = fs::write(&path, serde_json::to_string(&latest).unwrap_or_default());
			saving.store(false, Ordering::SeqCst);
		});
	});
}

#[cfg(test)]
mod tests {
	use super::clamp_position;

	// 1920x1080 screen with a 48px taskbar at the bottom.
	const WA: (i32, i32, i32, i32) = (0, 0, 1920, 1032);

	#[test]
	fn position_inside_work_area_is_untouched() {
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 100, 100),
			None
		);
		assert_eq!(clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 0, 0), None);
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 1120, 432),
			None,
		);
	}

	#[test]
	fn bottom_edge_cannot_slide_under_the_taskbar() {
		// Window flush with the work-area bottom is fine…
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 0, 432),
			None
		);
		// …but one pixel lower must be pulled back up.
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 0, 433),
			Some((0, 432)),
		);
	}

	#[test]
	fn fully_below_the_taskbar_is_restored_into_view() {
		// The whole window sits in the taskbar zone (e.g. restored after a
		// monitor change): only the left edge is fixed, the top is pulled up.
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 500, 1100),
			Some((500, 432)),
		);
	}

	#[test]
	fn off_screen_edges_are_clamped_back() {
		// Left / top overflow.
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, -50, -20),
			Some((0, 0)),
		);
		// Right overflow keeps the window fully visible.
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 600, 1300, 0),
			Some((1120, 0)),
		);
	}

	#[test]
	fn window_bigger_than_work_area_keeps_top_left_visible() {
		// 1400px-tall window on a 1032px work area: it can't fully fit, so
		// only the top edge is guaranteed on-screen (the title bar stays
		// reachable) and the bottom may overflow.
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 1400, 0, 500),
			None,
		);
		assert_eq!(
			clamp_position(WA.0, WA.1, WA.2, WA.3, 800, 1400, 0, -50),
			Some((0, 0)),
		);
	}

	#[test]
	fn offset_monitors_are_respected() {
		// Secondary monitor left of the primary, 40px taskbar on the bottom.
		let wa = (-1920, 0, 1920, 1040);
		assert_eq!(
			clamp_position(wa.0, wa.1, wa.2, wa.3, 800, 600, -1920, 400),
			None,
		);
		assert_eq!(
			clamp_position(wa.0, wa.1, wa.2, wa.3, 800, 600, -1900, 400),
			None,
		);
		assert_eq!(
			clamp_position(wa.0, wa.1, wa.2, wa.3, 800, 600, -1800, 700),
			Some((-1800, 440)),
		);
	}
}
