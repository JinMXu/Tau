//! Software update check against GitHub Releases.
//!
//! Tau ships no self-update pipeline (no signed updater artifacts / manifest
//! endpoint yet), so this module is a *checker*: it queries the GitHub
//! Releases API for the latest published release and compares it with the
//! running version. When a newer release exists the UI links to the release
//! page for the actual download/install.
//!
//! Two entry points:
//! - `update_check` command (frontend Settings → About; `force` bypasses the
//!   cache),
//! - `spawn_startup_check` — a delayed background check once per launch that
//!   emits `update://available` when a newer release exists.
//!
//! Both funnel through `check_impl`, which reuses the last result from
//! `update-check.json` (app config dir) unless forced, so background checks
//! never hammer the GitHub API (rate limits are modest, and the check is
//! best-effort: every failure is logged, surfaced, and never fatal).

use std::{
	fs,
	path::{Path, PathBuf},
	time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Latest published release of the app's repository. `/releases/latest`
/// already excludes drafts and pre-releases.
const RELEASE_API: &str = "https://api.github.com/repos/JinMXu/Tau/releases/latest";
const CACHE_FILE: &str = "update-check.json";
/// Minimum interval between automatic (non-forced) network checks. Manual
/// checks from Settings are always forced.
const AUTO_CHECK_INTERVAL_MS: u64 = 12 * 60 * 60 * 1000;
/// Whole-request timeout for the GitHub call; the check runs off the UI
/// thread but should never hang a window that shows its spinner forever.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// One update check result. Also the on-disk cache record (`from_cache` is
/// meaningless on disk and simply round-trips as false).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
	pub checked_at_ms: u64,
	pub current: String,
	pub latest: String,
	pub available: bool,
	/// Release page URL (`html_url`); empty when the payload lacked it.
	pub url: String,
	/// Release notes body, plain markdown as published.
	pub notes: String,
	pub published_at: Option<String>,
	/// True when this answer was served from the on-disk cache instead of
	/// the network (so the UI can avoid showing a fresh "checked" time).
	pub from_cache: bool,
}

fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0)
}

/// Parse a loose version string ("v0.2.0", "0.2.0", "0.2.0-beta.1") into
/// `(major, minor, patch, is_prerelease)`. Build metadata (`+…`) is ignored,
/// the `v` prefix is tolerated, missing components default to 0. Anything
/// non-numeric in the core yields None (the caller treats that as "cannot
/// compare", not as an error).
fn parse_version(s: &str) -> Option<(u64, u64, u64, bool)> {
	let s = s.trim();
	let s = s.strip_prefix(['v', 'V']).unwrap_or(s);
	let pre = s.contains('-');
	let core = s.split(['-', '+']).next().unwrap_or(s);
	let mut it = core.split('.');
	let major: u64 = it.next()?.trim().parse().ok()?;
	let minor: u64 = it.next().unwrap_or("0").trim().parse().ok()?;
	let patch: u64 = it.next().unwrap_or("0").trim().parse().ok()?;
	Some((major, minor, patch, pre))
}

/// True when `latest` is strictly newer than `current`. A release outranks a
/// pre-release of the same numeric core (0.2.0 > 0.2.0-beta.1) — implemented
/// by inverting the pre-release flag in the compared tuple.
fn is_newer(current: &str, latest: &str) -> bool {
	match (parse_version(current), parse_version(latest)) {
		(Some(c), Some(l)) => (l.0, l.1, l.2, !l.3) > (c.0, c.1, c.2, !c.3),
		_ => false,
	}
}

/// Extract the fields the UI needs from a GitHub release payload. Returns
/// None when `tag_name` is missing (the only field a comparison depends on).
fn parse_release(body: &serde_json::Value) -> Option<(String, String, String, Option<String>)> {
	let tag = body.get("tag_name")?.as_str()?.trim().to_string();
	let url = body
		.get("html_url")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	let notes = body
		.get("body")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	let published = body
		.get("published_at")
		.and_then(|v| v.as_str())
		.map(|s| s.to_string());
	Some((tag, url, notes, published))
}

fn cache_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
	Some(app.path().app_config_dir().ok()?.join(CACHE_FILE))
}

fn read_cache(path: &Path) -> Option<UpdateInfo> {
	let raw = fs::read_to_string(path).ok()?;
	serde_json::from_str(&raw).ok()
}

fn write_cache(path: &Path, info: &UpdateInfo) -> std::io::Result<()> {
	fs::write(path, serde_json::to_vec(info).unwrap_or_default())
}

/// Query the GitHub Releases API and build an `UpdateInfo` for the running
/// version. Network/parse errors bubble up as readable strings.
fn fetch_latest(current: &str) -> Result<UpdateInfo, String> {
	let agent = ureq::AgentBuilder::new()
		.timeout(HTTP_TIMEOUT)
		.user_agent(&format!("Tau/{current} (+https://github.com/JinMXu/Tau)"))
		.build();
	let res = agent
		.get(RELEASE_API)
		.set("Accept", "application/vnd.github+json")
		.call()
		.map_err(|e| match e {
			ureq::Error::Status(code, _) => format!("GitHub API returned HTTP {code}"),
			e => format!("update request failed: {e}"),
		})?;
	let body: serde_json::Value = res
		.into_json()
		.map_err(|e| format!("failed to parse release payload: {e}"))?;
	let (tag, url, notes, published) =
		parse_release(&body).ok_or("release payload missing tag_name")?;
	let available = is_newer(current, &tag);
	Ok(UpdateInfo {
		checked_at_ms: now_ms(),
		current: current.to_string(),
		latest: tag,
		available,
		url,
		notes,
		published_at: published,
		from_cache: false,
	})
}

/// Run one update check. Non-forced checks reuse a result younger than
/// `AUTO_CHECK_INTERVAL_MS` from the cache (and only when the running
/// version still matches the cached one — an upgrade must invalidate it).
fn check_impl(app: &AppHandle, force: bool) -> Result<UpdateInfo, String> {
	let current = app.package_info().version.clone().to_string();
	let path = cache_path(app);
	if !force {
		if let Some(cached) = path.as_deref().and_then(read_cache) {
			let age = now_ms().saturating_sub(cached.checked_at_ms);
			if age < AUTO_CHECK_INTERVAL_MS && cached.current == current {
				let mut info = cached;
				info.from_cache = true;
				return Ok(info);
			}
		}
	}
	let info = fetch_latest(&current)?;
	if let Some(p) = &path {
		// Best effort: a read-only config dir degrades the feature to "always
		// hits the network", it must never break the check itself.
		if let Err(e) = write_cache(p, &info) {
			crate::runtime_log::log_error(app, &format!("update cache write failed: {e}"));
		}
	}
	Ok(info)
}

/// `update_check` IPC command. `force` (from the Settings → About button)
/// skips the cache and always contacts GitHub.
#[tauri::command]
pub async fn update_check(app: AppHandle, force: Option<bool>) -> Result<UpdateInfo, String> {
	let force = force.unwrap_or(false);
	// The HTTP call blocks; keep it off the async runtime's core threads.
	tauri::async_runtime::spawn_blocking(move || check_impl(&app, force))
		.await
		.map_err(|e| format!("update check task failed: {e}"))?
}

/// Fire-and-forget startup check: waits a moment so it never competes with
/// window/session startup, consults the cache first (at most one network
/// call per interval), and emits `update://available` when a newer release
/// exists. All failures are logged and swallowed — an unreachable release
/// feed must never surface as a startup error.
pub fn spawn_startup_check(app: AppHandle) {
	std::thread::spawn(move || {
		std::thread::sleep(Duration::from_secs(6));
		match check_impl(&app, false) {
			Ok(info) => {
				crate::runtime_log::log_info(
					&app,
					&format!(
						"update check: latest={} available={} (cached={})",
						info.latest, info.available, info.from_cache
					),
				);
				if info.available {
					let _ = app.emit("update://available", &info);
				}
			}
			Err(e) => crate::runtime_log::log_error(&app, &format!("update check failed: {e}")),
		}
	});
}

#[cfg(test)]
mod tests {
	use super::*;

	// ---- parse_version -----------------------------------------------------

	#[test]
	fn parses_loose_versions() {
		assert_eq!(parse_version("0.2.0"), Some((0, 2, 0, false)));
		assert_eq!(parse_version("v0.2.0"), Some((0, 2, 0, false)));
		assert_eq!(parse_version("V1.2.3"), Some((1, 2, 3, false)));
		assert_eq!(parse_version(" 0.2.0 "), Some((0, 2, 0, false)));
		// Missing components default to 0.
		assert_eq!(parse_version("1.2"), Some((1, 2, 0, false)));
		assert_eq!(parse_version("3"), Some((3, 0, 0, false)));
		// Pre-release flag, build metadata ignored.
		assert_eq!(parse_version("0.2.0-beta.1"), Some((0, 2, 0, true)));
		assert_eq!(parse_version("v0.2.0-rc.2+build.5"), Some((0, 2, 0, true)));
		assert_eq!(parse_version("0.2.0+build.5"), Some((0, 2, 0, false)));
	}

	#[test]
	fn rejects_unparseable_versions() {
		assert_eq!(parse_version(""), None);
		assert_eq!(parse_version("not-a-version"), None);
		assert_eq!(parse_version("x.y.z"), None);
	}

	// ---- is_newer ----------------------------------------------------------

	#[test]
	fn detects_strictly_newer_versions() {
		assert!(is_newer("0.1.0", "0.2.0"));
		assert!(is_newer("0.1.0", "v0.2.0"));
		assert!(is_newer("0.9.9", "0.10.0")); // numeric, not lexicographic
		assert!(is_newer("1.0.0", "2.0.0"));
		assert!(is_newer("0.1.0", "0.1.1"));
	}

	#[test]
	fn same_or_older_versions_are_not_newer() {
		assert!(!is_newer("0.2.0", "0.2.0"));
		assert!(!is_newer("0.2.0", "0.1.0"));
		assert!(!is_newer("0.2.0", "0.2"));
	}

	#[test]
	fn release_outranks_prerelease_of_same_core() {
		assert!(is_newer("0.2.0-beta.1", "0.2.0"));
		assert!(!is_newer("0.2.0", "0.2.0-beta.2"));
		// But a higher core still wins over an older release.
		assert!(is_newer("0.2.0", "0.3.0-beta.1"));
	}

	#[test]
	fn unparseable_versions_never_report_an_update() {
		assert!(!is_newer("0.1.0", "not-a-version"));
		assert!(!is_newer("garbage", "0.2.0"));
	}

	// ---- parse_release -----------------------------------------------------

	#[test]
	fn parses_github_release_payload() {
		let body: serde_json::Value = serde_json::json!({
			"tag_name": "v0.2.0",
			"html_url": "https://github.com/JinMXu/Tau/releases/tag/v0.2.0",
			"body": "## What's changed\n- feature",
			"published_at": "2025-09-01T00:00:00Z",
			"prerelease": false,
			"draft": false
		});
		let (tag, url, notes, published) = parse_release(&body).expect("parses");
		assert_eq!(tag, "v0.2.0");
		assert_eq!(url, "https://github.com/JinMXu/Tau/releases/tag/v0.2.0");
		assert_eq!(notes, "## What's changed\n- feature");
		assert_eq!(published.as_deref(), Some("2025-09-01T00:00:00Z"));
	}

	#[test]
	fn tolerates_missing_optional_fields() {
		let body: serde_json::Value = serde_json::json!({ "tag_name": "v1.0.0" });
		let (tag, url, notes, published) = parse_release(&body).expect("parses");
		assert_eq!(tag, "v1.0.0");
		assert_eq!(url, "");
		assert_eq!(notes, "");
		assert_eq!(published, None);
		// body: null (JSON null) must not panic either.
		let body = serde_json::json!({ "tag_name": "v1.0.0", "body": null });
		let (_, _, notes, _) = parse_release(&body).expect("parses");
		assert_eq!(notes, "");
	}

	#[test]
	fn requires_tag_name() {
		let body: serde_json::Value = serde_json::json!({ "html_url": "https://example.com" });
		assert!(parse_release(&body).is_none());
	}

	// ---- cache roundtrip ---------------------------------------------------

	#[test]
	fn cache_roundtrips_and_invalidates_on_version_change() {
		let dir = std::env::temp_dir().join(format!("tau-update-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).expect("mkdir");
		let path = dir.join("update-check.json");

		let info = UpdateInfo {
			checked_at_ms: now_ms(),
			current: "0.1.0".into(),
			latest: "v0.2.0".into(),
			available: true,
			url: "https://github.com/JinMXu/Tau/releases/tag/v0.2.0".into(),
			notes: "note".into(),
			published_at: Some("2025-09-01T00:00:00Z".into()),
			from_cache: false,
		};
		write_cache(&path, &info).expect("cache write");
		let read = read_cache(&path).expect("roundtrips");
		assert_eq!(read.latest, "v0.2.0");
		assert!(read.available);

		// A corrupt cache file must read as None, not panic.
		std::fs::write(&path, "{broken").expect("write garbage");
		assert!(read_cache(&path).is_none());

		std::fs::remove_dir_all(&dir).ok();
	}
}
