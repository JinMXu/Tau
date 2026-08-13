mod extras;
mod pi;
mod runtime_log;
mod window_state;

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

/// Build the native application menu in the given interface language.
/// The renderer calls `rebuild_menu` after a language change so the menu
/// follows the UI without an app restart.
///
/// On Windows/Linux the borderless window renders its own menu inside the
/// custom title bar, so no native menu bar is attached (a native menu bar
/// would stack above the title bar and misalign the sidebar toggle). Only
/// macOS gets a real application menu (system menu bar).
fn build_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
	#[cfg(not(target_os = "macos"))]
	{
		let _ = (app, lang);
		return Ok(());
	}
	#[cfg(target_os = "macos")]
	{
		let zh = lang == "zh";
	let (
		app_menu_label,
		about_label,
		edit_label,
		undo_label,
		redo_label,
		cut_label,
		copy_label,
		paste_label,
		select_all_label,
		view_label,
		fullscreen_label,
	) = if zh {
		(
			"应用",
			"关于 Tau",
			"编辑",
			"撤销",
			"重做",
			"剪切",
			"复制",
			"粘贴",
			"全选",
			"视图",
			"切换全屏",
		)
	} else {
		(
			"App",
			"About Tau",
			"Edit",
			"Undo",
			"Redo",
			"Cut",
			"Copy",
			"Paste",
			"Select All",
			"View",
			"Toggle Fullscreen",
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
			&PredefinedMenuItem::separator(app)?,
			&PredefinedMenuItem::fullscreen(app, Some(fullscreen_label))?,
		],
	)?;
	let app_item = MenuItem::with_id(app, "about", about_label, true, None::<&str>)?;
	let app_menu = Submenu::with_items(app, app_menu_label, true, &[&app_item])?;
	let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu])?;
	app.set_menu(menu)?;
	Ok(())
	}
}

#[tauri::command]
fn rebuild_menu(app: AppHandle, lang: String) -> Result<(), String> {
	build_menu(&app, &lang).map_err(|e| e.to_string())
}

/// Frontend error reporting channel: the renderer catches uncaught
/// exceptions / boundary errors and logs them here so crashes that only
/// manifest in the webview still leave a trail in tau.log.
#[tauri::command]
fn log_frontend(app: AppHandle, message: String) {
	runtime_log::log_error(&app, &format!("frontend: {message}"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	pi::register(tauri::Builder::default())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_dialog::init())
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
			runtime_log::log_info(app.handle(), "app started");
			let _ = build_menu(app.handle(), "zh");
			if let Some(win) = app.get_webview_window("main") {
				window_state::restore(&win);
				window_state::attach(&win);
				// Kill the main window's pi process when the window closes
				// (other windows may keep the app alive).
				let inner = app.state::<crate::pi::PiState>().handle();
				let _ = win.on_window_event(move |event| {
					if let tauri::WindowEvent::Destroyed = event {
						crate::pi::kill_window_process_inner(&inner, "main");
					}
				});
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
