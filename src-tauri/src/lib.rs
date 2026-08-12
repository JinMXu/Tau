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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	pi::register(tauri::Builder::default())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_dialog::init())
		.setup(|app| {
			runtime_log::log_info(app.handle(), "app started");
			let _ = build_menu(app.handle(), "zh");
			if let Some(win) = app.get_webview_window("main") {
				window_state::restore(&win);
				window_state::attach(&win);
			}
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
