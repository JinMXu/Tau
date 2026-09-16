mod extras;
mod pi;
mod pi_session;
mod runtime_log;
mod sidecar;
mod update;
mod window_state;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

/// Build the native application menu in the given interface language.
/// The renderer calls `rebuild_menu` after a language change so the menu
/// follows the UI without an app restart.
///
/// macOS: the menu lives in the system menu bar (there is no in-window
/// title bar; traffic lights are drawn natively over the content). The
/// custom items (About / Session details / Session tree / Toggle sidebar)
/// are forwarded to the renderer as `menu://command` events; New window is
/// handled in Rust directly. Windows/Linux use the standard window
/// decorations; Windows renders its menu inside the app (brand row in the
/// chat header), so no native menu bar is attached here.
fn build_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
	let menu = build_menu_items(app, lang)?;
	#[cfg(target_os = "macos")]
	{
		app.set_menu(menu)?;
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = menu;
	}
	Ok(())
}

/// Build the App / Edit / View menu structure shared by the platforms that
/// show a native menu. `lang` selects the display language: "zh" renders
/// Chinese labels, anything else English. The renderer re-invokes
/// `rebuild_menu` after a language change so the menu follows the UI
/// without an app restart.
fn build_menu_items<R: tauri::Runtime>(
	app: &tauri::AppHandle<R>,
	lang: &str,
) -> tauri::Result<tauri::menu::Menu<R>> {
	let zh = lang == "zh";
	let (
		app_menu_label,
		about_label,
		new_window_label,
		edit_label,
		undo_label,
		redo_label,
		cut_label,
		copy_label,
		paste_label,
		select_all_label,
		view_label,
		fullscreen_label,
		session_info_label,
		tree_label,
		toggle_sidebar_label,
		check_updates_label,
	) = if zh {
		(
			"应用",
			"关于 Tau",
			"新窗口",
			"编辑",
			"撤销",
			"重做",
			"剪切",
			"复制",
			"粘贴",
			"全选",
			"视图",
			"切换全屏",
			"会话详情",
			"会话树",
			"切换侧边栏",
			"检查更新…",
		)
	} else {
		(
			"App",
			"About Tau",
			"New window",
			"Edit",
			"Undo",
			"Redo",
			"Cut",
			"Copy",
			"Paste",
			"Select All",
			"View",
			"Toggle Fullscreen",
			"Session details",
			"Session tree",
			"Toggle Sidebar",
			"Check for Updates…",
		)
	};
	let edit_menu = Submenu::with_items(
		app,
		edit_label,
		true,
		&[
			&PredefinedMenuItem::undo(app, Some(undo_label))?,
			&PredefinedMenuItem::redo(app, Some(redo_label))?,
			&PredefinedMenuItem::separator(app)?,
			&PredefinedMenuItem::cut(app, Some(cut_label))?,
			&PredefinedMenuItem::copy(app, Some(copy_label))?,
			&PredefinedMenuItem::paste(app, Some(paste_label))?,
			&PredefinedMenuItem::select_all(app, Some(select_all_label))?,
		],
	)?;
	let view_menu = Submenu::with_items(
		app,
		view_label,
		true,
		&[
			&PredefinedMenuItem::fullscreen(app, Some(fullscreen_label))?,
			&PredefinedMenuItem::separator(app)?,
			&MenuItem::with_id(
				app,
				"toggle-sidebar",
				toggle_sidebar_label,
				true,
				None::<&str>,
			)?,
			&MenuItem::with_id(app, "session-info", session_info_label, true, None::<&str>)?,
			&MenuItem::with_id(app, "tree", tree_label, true, None::<&str>)?,
		],
	)?;
	let new_window_item = MenuItem::with_id(
		app,
		"new-window",
		new_window_label,
		true,
		Some("CmdOrCtrl+Shift+N"),
	)?;
	let check_updates_item = MenuItem::with_id(
		app,
		"check-updates",
		check_updates_label,
		true,
		None::<&str>,
	)?;
	let about_item = MenuItem::with_id(app, "about", about_label, true, None::<&str>)?;
	let app_menu = Submenu::with_items(
		app,
		app_menu_label,
		true,
		&[
			&new_window_item,
			&PredefinedMenuItem::separator(app)?,
			&check_updates_item,
			&PredefinedMenuItem::separator(app)?,
			&about_item,
		],
	)?;
	Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu])
}

#[tauri::command]
fn rebuild_menu(app: AppHandle, lang: String) -> Result<(), String> {
	build_menu(&app, &lang).map_err(|e| e.to_string())
}

/// macOS: the fullscreen transition animates the window for ~0.5s and
/// `Resized` fires at the start (frame change), so the renderer cannot tell
/// when the animation starts or ends. Observe the native fullscreen
/// notifications and forward them as `window://fullscreen` events:
///   "will-enter" / "will-exit" — posted BEFORE the animation starts (the
///     renderer fades the header buttons out so the old+new window states
///     shown simultaneously during the transition can't duplicate them);
///   "enter" / "exit" — posted when the animation finishes (the renderer
///     flips the layout and fades the buttons back in at the new position).
#[cfg(target_os = "macos")]
fn watch_fullscreen_transitions(win: &tauri::WebviewWindow, app: &tauri::AppHandle) {
	use block2::RcBlock;
	use objc2::rc::Retained;
	use objc2::runtime::ProtocolObject;
	use objc2_app_kit::{
		NSWindow, NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
		NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
	};
	use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
	use std::ptr::NonNull;

	let Ok(raw) = win.ns_window() else {
		return;
	};
	let Some(ns_window) = (unsafe { Retained::retain(raw.cast::<NSWindow>()) }) else {
		return;
	};
	let center = NSNotificationCenter::defaultCenter();

	let make_observer = |name: &'static objc2_foundation::NSNotificationName,
	                     payload: &'static str| {
		let app = app.clone();
		let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
			let _ = app.emit("window://fullscreen", payload);
		});
		// Safety: name/obj/queue are valid; the block is Send.
		unsafe {
			center.addObserverForName_object_queue_usingBlock(
				Some(name),
				Some(&ns_window),
				None,
				&block,
			)
		}
	};

	// Keep the observer tokens (and the retained NSWindow) alive for the
	// whole app lifetime; NSNotificationCenter removes the observation as
	// soon as the returned token is deallocated.
	let will_enter: Retained<ProtocolObject<dyn NSObjectProtocol>> =
		unsafe { make_observer(NSWindowWillEnterFullScreenNotification, "will-enter") };
	let did_enter: Retained<ProtocolObject<dyn NSObjectProtocol>> =
		unsafe { make_observer(NSWindowDidEnterFullScreenNotification, "enter") };
	let will_exit: Retained<ProtocolObject<dyn NSObjectProtocol>> =
		unsafe { make_observer(NSWindowWillExitFullScreenNotification, "will-exit") };
	let did_exit: Retained<ProtocolObject<dyn NSObjectProtocol>> =
		unsafe { make_observer(NSWindowDidExitFullScreenNotification, "exit") };
	Box::leak(Box::new((
		will_enter, did_enter, will_exit, did_exit, ns_window,
	)));
}

/// macOS: wry's `trafficLightPosition.y` is a no-op for vertical placement
/// (it only stretches the transparent title-bar container; the standard
/// window buttons keep the system's fixed Y). Reposition the buttons natively
/// so their centers line up with the chat title bar content (y = 23 — where
/// the 26px top-aligned header buttons sit, padding-top 10px).
///
/// Reads the current frame (which already carries wry's X inset) and only
/// adjusts Y, so horizontal placement stays intact. Re-applied on every
/// resize (fullscreen toggles reset the frames).
#[cfg(target_os = "macos")]
fn align_traffic_lights(win: &tauri::WebviewWindow) {
	use objc2::rc::Retained;
	use objc2_app_kit::{NSWindow, NSWindowButton};

	// 26px header buttons sit top-aligned at padding-top 10 → center y=23
	// from the window top; move the lights to the same line as the chat
	// title bar content.
	const TARGET_CENTER_Y: f64 = 23.0;

	let Ok(raw) = win.ns_window() else {
		return;
	};
	let Some(ns_window) = (unsafe { Retained::retain(raw.cast::<NSWindow>()) }) else {
		return;
	};
	// Position relative to the content view (fills the window in overlay
	// mode, top = window top). convertRect handles flipped intermediate
	// views, so the math is: bottom-origin content view, center at
	// content_h - 23 from the bottom.
	let Some(content_view) = ns_window.contentView() else {
		return;
	};
	let content_h = content_view.frame().size.height;
	for kind in [
		NSWindowButton::CloseButton,
		NSWindowButton::MiniaturizeButton,
		NSWindowButton::ZoomButton,
	] {
		let Some(btn) = ns_window.standardWindowButton(kind) else {
			continue;
		};
		let Some(superview) = (unsafe { btn.superview() }) else {
			continue;
		};
		// Current rect in content view coordinates (btn.frame() lives in the
		// superview's space, so convert from there).
		let in_cv = superview.convertRect_toView(btn.frame(), Some(&content_view));
		// Target origin in content view coordinates (keep x, set y so the
		// center lands at content_h - 23).
		let mut target = in_cv;
		target.origin.y = (content_h - TARGET_CENTER_Y) - in_cv.size.height / 2.0;
		// Convert back into the button's superview space and apply.
		let in_super = superview.convertRect_fromView(target, Some(&content_view));
		let mut f = btn.frame();
		f.origin.y = in_super.origin.y;
		btn.setFrame(f);
	}
}

/// Frontend error reporting channel: the renderer catches uncaught
/// exceptions / boundary errors and logs them here so crashes that only
/// manifest in the webview still leave a trail in tau.log.
#[tauri::command]
fn log_frontend(app: AppHandle, message: String) {
	runtime_log::log_error(&app, &format!("frontend: {message}"));
}

/// Info-level counterpart of `log_frontend` for renderer liveness and
/// visibility pings — logging those as errors would drown real frontend
/// failures.
#[tauri::command]
fn log_frontend_info(app: AppHandle, message: String) {
	runtime_log::log_info(&app, &format!("frontend: {message}"));
}

/// Settings → About → "导出诊断日志": write tau.log (+ the rotated previous
/// log) with a small environment header to a user-picked file, so crash /
/// freeze reports can be handed to developers. The save dialog stays on the
/// UI thread; the file write moves to the blocking pool.
#[tauri::command]
async fn export_diagnostics(app: AppHandle) -> Result<serde_json::Value, String> {
	use tauri_plugin_dialog::DialogExt;

	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let picked = app
		.dialog()
		.file()
		.set_file_name(format!("tau-diagnostics-{stamp}.log"))
		.add_filter("Log", &["log", "txt"])
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

	let app2 = app.clone();
	let target2 = target.clone();
	tauri::async_runtime::spawn_blocking(move || {
		let bundle = runtime_log::collect_bundle(&app2);
		std::fs::write(&target2, bundle).map_err(|e| format!("failed to write diagnostics: {e}"))
	})
	.await
	.map_err(|e| e.to_string())??;
	Ok(serde_json::json!({
		"ok": true,
		"canceled": false,
		"path": target.to_string_lossy().into_owned()
	}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	pi::register(tauri::Builder::default())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_dialog::init())
		.on_menu_event(|app, event| {
			let id = event.id().as_ref();
			match id {
				// "New Window" already has a Rust-side implementation; open it
				// directly without a renderer round-trip.
				"new-window" => {
					let _ = crate::pi::pi_new_window(app.clone());
				}
				// Everything else is renderer-side state (settings panel,
				// dialogs, sidebar toggle), so forward the command to the
				// focused window.
				"about" | "check-updates" | "session-info" | "tree" | "toggle-sidebar" => {
					let windows = app.webview_windows();
					if let Some(win) = windows.values().find(|w| w.is_focused().unwrap_or(false)) {
						let _ = win.emit("menu://command", id);
					}
				}
				_ => {}
			}
		})
		.setup(|app| {
			// Panics on the main thread kill the whole app with zero evidence
			// (GUI builds have no console and Windows WER doesn't capture
			// Rust unwinds). Hook panic reporting into the runtime log so a
			// crash leaves a trace.
			let handle = app.handle().clone();
			std::panic::set_hook(Box::new(move |info| {
				let msg = format!("panic: {info}");
				eprintln!("{msg}");
				runtime_log::log_error(&handle, &msg);
			}));
			// Pre-warm the SDK sidecar in the background: the first launch
			// after an install pays an antivirus scan of the whole vendored
			// node_modules tree (minutes), which must not surface as a
			// timed-out ping when the user opens Settings.
			sidecar::start_warmup(app.handle().clone());
			// Delayed background update check (GitHub Releases, cache-throttled):
			// emits `update://available` when a newer release exists.
			update::spawn_startup_check(app.handle().clone());
			runtime_log::log_info(app.handle(), "app started");
			let _ = build_menu(app.handle(), "zh");
			// Heartbeat: a hard-killed process leaves no exit trace; the last
			// heartbeat timestamp narrows the crash moment to a 15s window.
			{
				let handle = app.handle().clone();
				std::thread::spawn(move || {
					let mut tick = 0u32;
					loop {
						std::thread::sleep(std::time::Duration::from_secs(15));
						tick += 1;
						runtime_log::log_info(&handle, &format!("heartbeat #{tick}"));
					}
				});
			}
			// Main-thread liveness probe. The background heartbeat above keeps
			// ticking even when the UI thread is wedged (seen in WER AppHang
			// reports: heartbeats ran right up to the hang), so it cannot tell
			// a frozen main thread apart from a live one. This schedules a
			// closure onto the main thread every 15s and logs the dispatch
			// delay: when the UI freezes, the probe lines stop (or show a huge
			// delay) while the background heartbeat continues — and whatever
			// was logged just before the freeze is the suspect.
			{
				let handle = app.handle().clone();
				std::thread::spawn(move || {
					loop {
						let scheduled = std::time::Instant::now();
						let h = handle.clone();
						let _ = handle.run_on_main_thread(move || {
							let delay = scheduled.elapsed().as_millis();
							runtime_log::log_info(
								&h,
								&format!("main-thread alive (dispatch delay {delay}ms)"),
							);
						});
						std::thread::sleep(std::time::Duration::from_secs(15));
					}
				});
			}
			if let Some(win) = app.get_webview_window("main") {
				// macOS: overlay title bar — no native title bar, just the
				// traffic lights drawn over the content (configured in
				// tauri.conf.json). Windows/Linux keep the standard window
				// decorations. The window is created hidden (visible:false)
				// so nothing flashes.
				#[cfg(target_os = "macos")]
				{
					let _ = win.set_title_bar_style(tauri::TitleBarStyle::Overlay);
				}
				let _ = win.show();
				window_state::restore(&win);
				window_state::attach(&win);
				// macOS: align the native traffic lights with the title bar
				// content (wry can't move them vertically). Fullscreen toggles
				// reset the frames, so re-apply after resizing — but debounced:
				// the fullscreen transition animates the window size and fires a
				// burst of Resized events; re-aligning on every one of them
				// fights AppKit's own traffic-light animation on the main thread
				// (the lights stutter / look stuck) and stutters the transition.
				#[cfg(target_os = "macos")]
				{
					align_traffic_lights(&win);
					watch_fullscreen_transitions(&win, app.handle());
					let win_for_events = win.clone();
					let inner = app.state::<crate::pi::PiState>().handle();
					win.on_window_event(move |event| {
						if let tauri::WindowEvent::Destroyed = event {
							crate::pi::kill_window_process_inner(&inner, "main");
						}
						if let tauri::WindowEvent::Resized(_) = event {
							use std::sync::atomic::{AtomicU64, Ordering};
							use std::time::{SystemTime, UNIX_EPOCH};
							static LAST_RESIZE: AtomicU64 = AtomicU64::new(0);
							let stamp = SystemTime::now()
								.duration_since(UNIX_EPOCH)
								.map(|d| d.as_millis() as u64)
								.unwrap_or(0);
							LAST_RESIZE.store(stamp, Ordering::SeqCst);
							let w = win_for_events.clone();
							std::thread::spawn(move || {
								std::thread::sleep(std::time::Duration::from_millis(300));
								// A newer resize superseded this one; it owns the
								// re-align once the burst settles.
								if LAST_RESIZE.load(Ordering::SeqCst) != stamp {
									return;
								}
								let w2 = w.clone();
								let _ = w.run_on_main_thread(move || align_traffic_lights(&w2));
							});
						}
					});
				}
				#[cfg(not(target_os = "macos"))]
				{
					// Kill the main window's pi process when the window closes
					// (other windows may keep the app alive).
					let inner = app.state::<crate::pi::PiState>().handle();
					let app_handle = app.handle().clone();
					win.on_window_event(move |event| {
						if let tauri::WindowEvent::Destroyed = event {
							// This runs on the main thread and blocks until the
							// child tree dies — log the timing so a teardown
							// stall is visible in tau.log.
							let t0 = std::time::Instant::now();
							crate::runtime_log::log_info(&app_handle, "killing pi (main destroyed)");
							crate::pi::kill_window_process_inner(&inner, "main");
							crate::runtime_log::log_info(
								&app_handle,
								&format!("pi killed in {}ms (main destroyed)", t0.elapsed().as_millis()),
							);
						}
					});
				}
			}
			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("error while building tauri application")
		.run(|app_handle, event| match event {
			// Trace every exit path so a "vanishing" window (webview crash vs
			// real close) is distinguishable in tau.log. A hard process death
			// (panic is hooked; SEH crash would appear in WER) triggers none
			// of these — the absence of any log line right before the next
			// "app started" is itself the signal.
			tauri::RunEvent::ExitRequested { code, .. } => {
				runtime_log::log_info(app_handle, &format!("exit requested: code={code:?}"));
			}
			tauri::RunEvent::Exit => {
				runtime_log::log_info(app_handle, "app exiting");
			}
			tauri::RunEvent::WindowEvent {
				label,
				event: tauri::WindowEvent::CloseRequested { .. },
				..
			} => {
				runtime_log::log_info(app_handle, &format!("window close requested: {label}"));
			}
			tauri::RunEvent::WindowEvent {
				label,
				event: tauri::WindowEvent::Destroyed,
				..
			} => {
				runtime_log::log_info(app_handle, &format!("window destroyed: {label}"));
			}
			_ => {}
		});
}
