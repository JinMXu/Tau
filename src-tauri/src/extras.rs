use std::{
	fs,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};

use crate::pi;

// ---------------------------------------------------------------------------
// auth.json management (provider API keys / OAuth credentials)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProviderStatus {
	provider: String,
	has_key: bool,
	kind: String,
}

fn pi_agent_dir() -> PathBuf {
	if let Some(dir) = std::env::var_os("PI_AGENT_DIR") {
		return PathBuf::from(dir);
	}
	pi::home_dir()
		.map(|h| h.join(".pi").join("agent"))
		.unwrap_or_else(|| PathBuf::from(".pi/agent"))
}

fn auth_file_path() -> PathBuf {
	pi_agent_dir().join("auth.json")
}

/// Serializes read-modify-write updates so concurrent key edits can't clobber
/// each other (write_auth_map is an atomic tmp+rename, but the read+write pair
/// still needs mutual exclusion).
static AUTH_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn read_auth_map() -> serde_json::Map<String, serde_json::Value> {
	let path = auth_file_path();
	let Ok(raw) = fs::read_to_string(&path) else {
		return serde_json::Map::new();
	};
	serde_json::from_str::<serde_json::Value>(&raw)
		.ok()
		.and_then(|v| v.as_object().cloned())
		.unwrap_or_default()
}

fn write_auth_map(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
	let path = auth_file_path();
	if let Some(dir) = path.parent() {
		fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
	}
	let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
	let tmp = path.with_extension("json.tmp");
	fs::write(&tmp, raw).map_err(|e| format!("failed to write auth: {e}"))?;
	fs::rename(&tmp, &path).map_err(|e| format!("failed to persist auth: {e}"))
}

#[tauri::command]
pub fn pi_auth_status() -> Result<Vec<AuthProviderStatus>, String> {
	let map = read_auth_map();
	Ok(map
		.iter()
		.map(|(provider, value)| {
			let kind = value
				.get("type")
				.and_then(|v| v.as_str())
				.unwrap_or("api_key")
				.to_string();
			let has_key = value
				.get("key")
				.map(|v| v.as_str().is_some_and(|s| !s.is_empty()))
				.unwrap_or(false);
			AuthProviderStatus { provider: provider.clone(), has_key, kind }
		})
		.collect())
}

#[tauri::command]
pub fn pi_auth_set_key(provider: String, key: String) -> Result<(), String> {
	let provider = provider.trim().to_string();
	let key = key.trim().to_string();
	if provider.is_empty() || key.is_empty() {
		return Err("provider and key must not be empty".into());
	}
	let _guard = AUTH_MUTEX
		.lock()
		.map_err(|e| format!("auth lock poisoned: {e}"))?;
	let mut map = read_auth_map();
	map.insert(provider, serde_json::json!({ "type": "api_key", "key": key }));
	write_auth_map(&map)
}

#[tauri::command]
pub fn pi_auth_remove(provider: String) -> Result<(), String> {
	let _guard = AUTH_MUTEX
		.lock()
		.map_err(|e| format!("auth lock poisoned: {e}"))?;
	let mut map = read_auth_map();
	map.remove(&provider);
	write_auth_map(&map)
}

// ---------------------------------------------------------------------------
// Git branch support
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchState {
	is_repository: bool,
	branches: Vec<String>,
	current_branch: Option<String>,
	dirty_file_count: usize,
}

fn run_git(project: &str, args: &[&str]) -> Result<String, String> {
	let out = Command::new("git")
		.arg("-C")
		.arg(project)
		.args(args)
		.output()
		.map_err(|e| format!("git failed: {e}"))?;
	if !out.status.success() {
		let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
		return Err(if err.is_empty() {
			format!("git {} failed", args.join(" "))
		} else {
			err
		});
	}
	Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn git_branch_state_sync(project: &str) -> Result<GitBranchState, String> {
	let work_tree = run_git(project, &["rev-parse", "--is-inside-work-tree"]);
	let is_repository = work_tree.as_deref().map(|s| s.trim() == "true").unwrap_or(false);
	if !is_repository {
		return Ok(GitBranchState {
			is_repository: false,
			branches: vec![],
			current_branch: None,
			dirty_file_count: 0,
		});
	}
	let branches = run_git(project, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
		.map(|s| {
			s.lines()
				.map(|l| l.trim().to_string())
				.filter(|l| !l.is_empty())
				.collect::<Vec<_>>()
		})
		.unwrap_or_default();
	let current_branch = run_git(project, &["branch", "--show-current"])
		.ok()
		.map(|s| s.trim().to_string())
		.filter(|s| !s.is_empty());
	let dirty_file_count = run_git(project, &["status", "--porcelain=v1"])
		.map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
		.unwrap_or(0);
	Ok(GitBranchState { is_repository: true, branches, current_branch, dirty_file_count })
}

#[tauri::command]
pub async fn git_branch_state(project: String) -> Result<GitBranchState, String> {
	tauri::async_runtime::spawn_blocking(move || git_branch_state_sync(&project))
		.await
		.map_err(|e| e.to_string())?
}

fn validate_branch_name(project: &str, branch: &str) -> Result<String, String> {
	let name = branch.trim().to_string();
	if name.is_empty() {
		return Err("branch name must not be empty".into());
	}
	run_git(project, &["check-ref-format", "--branch", &name])?;
	Ok(name)
}

#[tauri::command]
pub async fn git_checkout_branch(project: String, branch: String) -> Result<GitBranchState, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let name = validate_branch_name(&project, &branch)?;
		run_git(&project, &["switch", &name])?;
		git_branch_state_sync(&project)
	})
	.await
	.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_create_branch(project: String, branch: String) -> Result<GitBranchState, String> {
	tauri::async_runtime::spawn_blocking(move || {
		let name = validate_branch_name(&project, &branch)?;
		run_git(&project, &["switch", "-c", &name])?;
		git_branch_state_sync(&project)
	})
	.await
	.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Pi packages (extensions / skills / prompts / themes) via the pi CLI
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageEntry {
	source: String,
	/// npm package name when the source is `npm:<name>`.
	package_name: Option<String>,
	scope: String,
	installed_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSkillEntry {
	name: String,
	description: Option<String>,
	location: String,
}

fn run_pi_cli(args: &[&str]) -> Result<String, String> {
	let info = pi::probe_pi().ok_or("pi binary not found. Install pi or set PI_BIN.")?;
	let mut cmd = pi::pi_command(&info);
	cmd.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x08000000;
		cmd.creation_flags(CREATE_NO_WINDOW);
	}
	let out = cmd.output().map_err(|e| format!("failed to run pi: {e}"))?;
	let stdout = String::from_utf8_lossy(&out.stdout).to_string();
	if !out.status.success() {
		let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
		return Err(if stderr.is_empty() { stdout.trim().to_string() } else { stderr });
	}
	Ok(stdout)
}

fn strip_ansi(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let mut chars = s.chars().peekable();
	while let Some(c) = chars.next() {
		if c == '\u{1b}' {
			// consume until the end of the escape sequence (letter)
			for c2 in chars.by_ref() {
				if c2.is_ascii_alphabetic() || c2 == '~' {
					break;
				}
			}
		} else {
			out.push(c);
		}
	}
	out
}

fn package_name_from_source(source: &str) -> Option<String> {
	if !source.starts_with("npm:") {
		return None;
	}
	let mut spec = &source["npm:".len()..];
	// drop the " (filtered)" suffix pi prints for filtered packages
	if let Some(idx) = spec.find(' ') {
		spec = &spec[..idx];
	}
	// strip @version suffix (keep scoped name)
	let name = if let Some(rest) = spec.strip_prefix('@') {
		let slash = rest.find('/')?;
		let after = &rest[slash + 1..];
		let ver = after.find('@').map(|i| &after[..i]).unwrap_or(after);
		format!("@{}/{}", &rest[..slash], ver)
	} else {
		spec.split('@').next().unwrap_or(spec).to_string()
	};
	if name.is_empty() {
		None
	} else {
		Some(name)
	}
}

fn parse_pi_list_output(output: &str) -> Vec<PiPackageEntry> {
	let mut entries: Vec<PiPackageEntry> = Vec::new();
	let mut scope = "user";
	for raw_line in output.lines() {
		let line = strip_ansi(raw_line);
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if trimmed == "No packages installed." {
			break;
		}
		if trimmed.ends_with(':') {
			if trimmed.starts_with("Project") {
				scope = "project";
			} else if trimmed.starts_with("User") {
				scope = "user";
			}
			continue;
		}
		// package sources are indented by two spaces; install paths by four.
		let indent = line.chars().take_while(|c| *c == ' ').count();
		if indent >= 4 {
			if let Some(last) = entries.last_mut() {
				last.installed_path = Some(trimmed.to_string());
			}
			continue;
		}
		let source = trimmed.to_string();
		if source.is_empty() || source.starts_with('(') {
			continue;
		}
		let package_name = package_name_from_source(&source);
		entries.push(PiPackageEntry {
			source,
			package_name,
			scope: scope.to_string(),
			installed_path: None,
		});
	}
	entries
}

/// Runs a blocking closure on the dedicated blocking thread pool so the UI
/// thread is never frozen while the pi CLI subprocess is running.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
	T: Send + 'static,
	F: FnOnce() -> Result<T, String> + Send + 'static,
{
	tauri::async_runtime::spawn_blocking(f)
		.await
		.map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
pub async fn pi_packages() -> Result<Vec<PiPackageEntry>, String> {
	let output = run_blocking(|| run_pi_cli(&["list"])).await?;
	Ok(parse_pi_list_output(&output))
}

#[tauri::command]
pub async fn pi_package_install(source: String) -> Result<(), String> {
	let source = source.trim().to_string();
	if source.is_empty() {
		return Err("package source must not be empty".into());
	}
	run_blocking(move || {
		run_pi_cli(&["install", &source])?;
		Ok(())
	})
	.await
}

#[tauri::command]
pub async fn pi_package_remove(source: String) -> Result<(), String> {
	let source = source.trim().to_string();
	if source.is_empty() {
		return Err("package source must not be empty".into());
	}
	run_blocking(move || {
		run_pi_cli(&["remove", &source])?;
		Ok(())
	})
	.await
}

fn scan_skill_dir(dir: &Path, location: &str, out: &mut Vec<PiSkillEntry>) {
	scan_skill_dir_at(dir, location, out, 0)
}

fn scan_skill_dir_at(dir: &Path, location: &str, out: &mut Vec<PiSkillEntry>, depth: usize) {
	// Depth cap + no symlink following (`file_type` doesn't traverse links)
	// so a cycle inside an installed package can't recurse forever.
	if depth > 6 {
		return;
	}
	let Ok(entries) = fs::read_dir(dir) else { return };
	for entry in entries.flatten() {
		let path = entry.path();
		let Ok(ft) = entry.file_type() else { continue };
		if ft.is_dir() {
			if path.join("SKILL.md").is_file() {
				let name = entry.file_name().to_string_lossy().into_owned();
				let description = fs::read_to_string(path.join("SKILL.md"))
					.ok()
					.and_then(|text| {
						text.lines().find(|l| l.starts_with("description:"))
							.map(|l| l.trim_start_matches("description:").trim().trim_matches('"').to_string())
					})
					.filter(|d| !d.is_empty());
				out.push(PiSkillEntry { name, description, location: location.to_string() });
			} else if entry.file_name() != "node_modules" {
				scan_skill_dir_at(&path, location, out, depth + 1);
			}
		} else if ft.is_file()
			&& path.extension().and_then(|e| e.to_str()) == Some("md")
			&& path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md")
		{
			let name = entry
				.file_name()
				.to_string_lossy()
				.trim_end_matches(".md")
				.to_string();
			out.push(PiSkillEntry {
				name: format!("{name}.md"),
				description: None,
				location: location.to_string(),
			});
		}
	}
}

/// List skills available to pi: user skills under `~/.pi/agent/skills` plus
/// skills shipped inside installed packages.
///
/// Takes the package list as an argument so the frontend only needs to run
/// `pi list` once instead of twice when opening the settings panel.
#[tauri::command]
pub async fn pi_installed_skills(packages: Vec<PiPackageEntry>) -> Result<Vec<PiSkillEntry>, String> {
	run_blocking(move || {
		let mut out: Vec<PiSkillEntry> = Vec::new();
		let agent_dir = pi_agent_dir();
		scan_skill_dir(&agent_dir.join("skills"), "user", &mut out);

		for pkg in packages {
			if let Some(installed) = pkg.installed_path {
				let dir = PathBuf::from(&installed);
				scan_skill_dir(&dir.join("skills"), "package", &mut out);
			}
		}
		// de-duplicate by name+location
		let mut seen = std::collections::HashSet::new();
		out.retain(|s| seen.insert((s.name.clone(), s.location.clone())));
		Ok(out)
	})
	.await
}

#[tauri::command]
pub async fn pi_move_session(
	state: tauri::State<'_, crate::pi::PiState>,
	path: String,
	new_project: String,
) -> Result<(), String> {
	let path = pi::require_session_path(Path::new(&path))?;
	if pi::is_running_session(&state, &path) {
		return Err("stop the running session before moving it".into());
	}
	let new_project = new_project.trim().to_string();
	if new_project.is_empty() {
		return Err("target directory must not be empty".into());
	}
	let canonical = fs::canonicalize(&new_project)
		.map_err(|e| format!("invalid target directory: {e}"))?;
	// Rewriting a large session file (with big base64 image lines) takes a
	// moment; keep it off the UI thread.
	run_blocking(move || {
		let raw = fs::read_to_string(&path)
			.map_err(|e| format!("failed to read session: {e}"))?;
		let mut out_lines: Vec<String> = Vec::new();
		let mut changed = false;
		for line in raw.lines() {
			let Ok(mut v) = serde_json::from_str::<serde_json::Value>(line) else {
				out_lines.push(line.to_string());
				continue;
			};
			if v.get("type").and_then(|x| x.as_str()) == Some("session") {
				v["cwd"] =
					serde_json::Value::String(canonical.to_string_lossy().into_owned());
				changed = true;
			}
			out_lines.push(v.to_string());
		}
		if !changed {
			return Err("session header not found in file".into());
		}
		let tmp = path.with_extension("jsonl.tmp");
		fs::write(&tmp, out_lines.join("\n") + "\n")
			.map_err(|e| format!("failed to write session: {e}"))?;
		fs::rename(&tmp, &path).map_err(|e| format!("failed to persist session: {e}"))?;
		Ok(())
	})
	.await
}


#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_pi_list_output() {
		let output = "User packages:\n  npm:@foo/bar (filtered)\n    C:\\Users\\x\\appdata\\npm\\foo\\bar\\1.0.0\\node_modules\\@foo\\bar\n  npm:plain\n    /home/user/.pi/agent/npm/plain\n\nProject packages:\n  npm:proj-pkg\n";
		let entries = parse_pi_list_output(output);
		assert_eq!(entries.len(), 3);
		assert_eq!(entries[0].source, "npm:@foo/bar (filtered)");
		assert_eq!(entries[0].package_name.as_deref(), Some("@foo/bar"));
		assert!(entries[0].installed_path.is_some());
		assert_eq!(entries[1].package_name.as_deref(), Some("plain"));
		assert_eq!(entries[2].scope, "project");
	}

	#[test]
	fn handles_empty_list() {
		let entries = parse_pi_list_output("No packages installed.\n");
		assert!(entries.is_empty());
	}

	#[test]
	fn strips_ansi_codes() {
		let s = "\u{1b}[2mUser packages:\u{1b}[22m";
		assert_eq!(strip_ansi(s), "User packages:");
	}

	#[test]
	fn extracts_package_names() {
		assert_eq!(
			package_name_from_source("npm:@scope/pkg@1.2.3").as_deref(),
			Some("@scope/pkg")
		);
		assert_eq!(
			package_name_from_source("npm:plain@1.0.0").as_deref(),
			Some("plain")
		);
		assert_eq!(package_name_from_source("git:github.com/u/r"), None);
		assert_eq!(
			package_name_from_source("npm:@scope/pkg").as_deref(),
			Some("@scope/pkg")
		);
	}

	#[test]
	fn auth_roundtrip_uses_agent_dir() {
		// Point the agent dir at a temp folder so the real auth.json is untouched.
		let dir =
			std::env::temp_dir().join(format!("pi-gui-auth-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_AGENT_DIR", &dir);

		let _ = pi_auth_set_key("anthropic".into(), "sk-ant-test".into());
		let _ = pi_auth_set_key("openai".into(), "sk-openai-test".into());
		let statuses = pi_auth_status().unwrap();
		assert_eq!(statuses.len(), 2);
		assert!(
			statuses
				.iter()
				.any(|s| s.provider == "anthropic" && s.has_key)
		);
		assert!(statuses.iter().any(|s| s.provider == "openai" && s.has_key));

		let _ = pi_auth_remove("anthropic".into());
		let statuses = pi_auth_status().unwrap();
		assert_eq!(statuses.len(), 1);
		assert_eq!(statuses[0].provider, "openai");

		std::fs::remove_dir_all(&dir).ok();
		std::env::remove_var("PI_AGENT_DIR");
	}

	#[test]
	fn scans_skill_directories() {
		let dir = std::env::temp_dir().join(format!("pi-gui-skill-test-{}", std::process::id()));
		std::fs::create_dir_all(dir.join("skills/my-skill")).unwrap();
		std::fs::write(
			dir.join("skills/my-skill/SKILL.md"),
			"---\ndescription: \"A test skill\"\n---\n\nDo things.",
		)
		.unwrap();
		std::fs::create_dir_all(dir.join("skills/plain")).unwrap();
		std::fs::write(dir.join("skills/plain/notes.md"), "# Notes").unwrap();

		let mut out = Vec::new();
		scan_skill_dir(&dir.join("skills"), "user", &mut out);
		assert!(out.iter().any(|s| s.name == "my-skill" && s.description.as_deref() == Some("A test skill")));
		assert!(out.iter().any(|s| s.name == "notes.md"));

		std::fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn git_state_in_non_repository() {
		let dir = std::env::temp_dir().join(format!("pi-gui-git-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let state =
		tauri::async_runtime::block_on(git_branch_state(dir.to_string_lossy().into_owned())).unwrap();
		assert!(!state.is_repository);
		assert!(state.branches.is_empty());
		std::fs::remove_dir_all(&dir).ok();
	}
}
