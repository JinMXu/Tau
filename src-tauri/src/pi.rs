//! The pi session layer, split out of what had become one ~4.9k-line module:
//!
//! - [`pi_process`]  — one pi RPC child per channel: spawn/kill, the stdout and
//!   stderr readers, start/stop/send/status, the vendored-runtime probe
//! - [`session_store`] — session JSONL discovery and listing, archive / trash /
//!   restore / purge, the meta sidecar, imports
//! - [`session_ops`] — fork, image compaction, the tree and slim layers,
//!   export/share, search, usage stats
//! - [`llama`] — the curl proxy for the llama.cpp router (the CSP forbids
//!   direct fetches, and the stored key never reaches the webview)
//! - [`misc_cmds`] — folder reveal, the project file tree, subagent runs,
//!   trust settings, external edit
//! - [`util`] — shared helpers: owner-only writes, unique suffixes,
//!   no-console-window spawns
//!
//! This module keeps the tauri command registration and the test suites; the
//! glob imports below keep `super::*` in those tests resolving exactly as it
//! did when everything shared one file.

mod llama;
mod misc_cmds;
mod pi_process;
mod session_ops;
mod session_store;
mod util;

// Internal surface: the globs keep this module's namespace a superset of the
// old flat file, so the test suites (and cross-module calls) resolve as before.
use llama::*;
use misc_cmds::*;
use pi_process::*;
use session_ops::*;
use session_store::*;

// The rest of the crate reaches these through `crate::pi::…`, unchanged.
pub(crate) use crate::pi_session::MAX_JSONL_LINE;
pub(crate) use misc_cmds::agent_dir;
#[cfg(test)]
pub(crate) use pi_process::ENV_GUARD;
pub(crate) use pi_process::{
	is_running_session, kill_all_processes, kill_window_process_inner, pi_new_window,
	vendored_layout, vendored_runtime_dirs, PiState,
};
pub(crate) use session_store::{home_dir, require_session_path};
pub(crate) use util::{no_console_window, unique_suffix};

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
	builder
		.manage(PiState::default())
		.invoke_handler(tauri::generate_handler![
			pi_new_window,
			pi_binary,
			pi_start,
			pi_stop,
			pi_send,
			pi_status,
			pi_export_chat,
			pi_export_html,
			pi_project_files,
			pi_import_session,
			pi_share_session,
			pi_read_tree,
			pi_external_edit,
			pi_trust_get,
			pi_trust_set,
			pi_trust_default_get,
			pi_trust_default_set,
			pi_llama_models,
			pi_llama_load,
			pi_llama_unload,
			crate::extras::pi_llama_set_key,
			crate::extras::pi_llama_has_key,
			pi_usage_stats,
			pi_compact_session_images,
			crate::sidecar::sidecar_ping,
			crate::sidecar::sidecar_session_info,
			crate::sidecar::oauth_begin,
			crate::sidecar::oauth_status,
			crate::sidecar::oauth_prompt_response,
			crate::sidecar::oauth_cancel,
			pi_list_sessions,
			pi_open_workspace,
			pi_read_session,
			pi_fork_session,
			pi_search_sessions,
			pi_archive_session,
			pi_delete_session,
			pi_list_archived_sessions,
			pi_restore_session,
			pi_purge_session,
			pi_reveal_session,
			pi_reveal_dir,
			pi_subagent_runs,
			crate::extras::pi_auth_status,
			crate::extras::pi_auth_set_key,
			crate::extras::pi_auth_remove,
			crate::extras::pi_providers,
			crate::extras::pi_custom_providers,
			crate::extras::pi_upsert_custom_provider,
			crate::extras::pi_remove_custom_provider,
			crate::extras::pi_provider_models,
			crate::extras::pi_provider_model_upsert,
			crate::extras::pi_provider_model_remove,
			crate::extras::pi_provider_model_override_upsert,
			crate::extras::pi_provider_model_override_remove,
			crate::extras::pi_mcp_servers,
			crate::extras::pi_mcp_upsert_server,
			crate::extras::pi_mcp_remove_server,
			crate::extras::pi_mcp_set_disabled,
			crate::extras::git_branch_state,
			crate::extras::git_checkout_branch,
			crate::extras::git_create_branch,
			crate::extras::pi_packages,
			crate::extras::pi_package_install,
			crate::extras::pi_package_remove,
			crate::extras::pi_installed_skills,
			crate::extras::pi_move_session,
			crate::rebuild_menu,
			crate::log_frontend,
			crate::log_frontend_info,
			crate::export_diagnostics,
			crate::update::update_check,
		])
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::pi_session::{parse_iso_ms, read_session_messages, scan_session, LimitedLines};
	use std::io::Write;

	// std/serde names the suites use directly (the facade itself no longer
	// needs them outside tests).
	use std::fs::File;
	use std::io::BufReader;
	use std::path::{Path, PathBuf};

	fn write_temp_session(name: &str, lines: &[&str]) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("pi-gui-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join(format!("{name}.jsonl"));
		let mut file = File::create(&path).unwrap();
		for line in lines {
			writeln!(file, "{line}").unwrap();
		}
		path
	}

	#[test]
	fn forks_session_at_leaf() {
		let path = write_temp_session(
			"tau-fork-at",
			&[
				r#"{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"D:/x"}"#,
				r#"{"type":"model_change","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","provider":"p","modelId":"m"}"#,
				r#"{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
				r#"{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-01-01T00:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#,
			],
		);
		let res = fork_session_at(&path, None).expect("fork should succeed");
		let content = std::fs::read_to_string(&res.session_file).unwrap();
		let lines: Vec<serde_json::Value> = content
			.lines()
			.map(|l| serde_json::from_str(l).unwrap())
			.collect();
		// header + 3 entries (model_change, user, assistant)
		assert_eq!(lines.len(), 4);
		let header = &lines[0];
		assert_eq!(header["type"], "session");
		assert_eq!(header["version"], 3);
		assert_eq!(header["cwd"], "D:/x");
		assert_eq!(header["parentSession"], path.to_string_lossy().to_string());
		// 链式重接：根 parentId=null，其余串联到叶
		assert_eq!(lines[1]["id"], "e1");
		assert!(lines[1]["parentId"].is_null());
		assert_eq!(lines[2]["parentId"], "e1");
		assert_eq!(lines[3]["parentId"], "e2");
		assert_eq!(lines[3]["id"], "e3");
		// 非法条目报错
		assert!(fork_session_at(&path, Some("nope")).is_err());
		let _ = std::fs::remove_file(&res.session_file);
		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn forks_session_at_middle_entry_past_an_oversized_line() {
		// Exercises the two-pass fork read: a middle-entry chain must re-read
		// only its own lines, and a line discarded for exceeding MAX_JSONL_LINE
		// must not shift the offsets of the entries after it.
		let dir = std::env::temp_dir().join(format!("pi-gui-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("tau-fork-mid.jsonl");
		let oversized = format!(
			r#"{{"type":"message","id":"e9","parentId":"e2","pad":"{}"}}"#,
			"x".repeat(crate::pi_session::MAX_JSONL_LINE + 64)
		);
		{
			use std::io::Write;
			let mut f = File::create(&path).unwrap();
			writeln!(f, r#"{{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"D:/x"}}"#).unwrap();
			writeln!(f, r#"{{"type":"model_change","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","provider":"p","modelId":"m"}}"#).unwrap();
			writeln!(f, r#"{{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:02Z","message":{{"role":"user","content":[{{"type":"text","text":"hi"}}]}}}}"#).unwrap();
			writeln!(f, "{oversized}").unwrap();
			writeln!(f, r#"{{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-01-01T00:00:04Z","message":{{"role":"assistant","content":[{{"type":"text","text":"hello"}}]}}}}"#).unwrap();
		}
		// Fork at a MIDDLE entry: the chain is e1 → e2 and stops there.
		let res =
			fork_session_at(&path, Some("e2")).expect("fork at a middle entry should succeed");
		let content = std::fs::read_to_string(&res.session_file).unwrap();
		let lines: Vec<serde_json::Value> = content
			.lines()
			.map(|l| serde_json::from_str(l).unwrap())
			.collect();
		assert_eq!(lines.len(), 3, "header + e1 + e2");
		assert_eq!(lines[1]["id"], "e1");
		assert!(lines[1]["parentId"].is_null());
		assert_eq!(lines[2]["id"], "e2");
		assert_eq!(lines[2]["parentId"], "e1");
		// Leaf fork still walks past the discarded line all the way to e3 —
		// this is what breaks if the oversized line's bytes were miscounted.
		let res = fork_session_at(&path, None).expect("fork at the leaf should succeed");
		let content = std::fs::read_to_string(&res.session_file).unwrap();
		let lines: Vec<serde_json::Value> = content
			.lines()
			.map(|l| serde_json::from_str(l).unwrap())
			.collect();
		assert_eq!(lines.len(), 4, "header + e1 + e2 + e3");
		assert_eq!(lines[3]["id"], "e3");
		assert_eq!(lines[3]["parentId"], "e2");
		// The oversized entry is valid JSON but never entered the index: the
		// line cap dropped it, exactly as it is dropped everywhere else.
		assert!(fork_session_at(&path, Some("e9")).is_err());
		let _ = std::fs::remove_file(&res.session_file);
		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn router_host_strips_userinfo_port_and_brackets() {
		assert_eq!(
			router_host("http://127.0.0.1:8080").as_deref(),
			Some("127.0.0.1")
		);
		assert_eq!(
			router_host("https://Box.Lan/v1/models").as_deref(),
			Some("box.lan")
		);
		assert_eq!(
			router_host("http://user:pw@10.0.0.5:9/x").as_deref(),
			Some("10.0.0.5")
		);
		assert_eq!(router_host("http://[::1]:8080").as_deref(), Some("::1"));
		// The last '@' wins, so a userinfo segment can't spoof the host.
		assert_eq!(
			router_host("http://a@b@127.0.0.1").as_deref(),
			Some("127.0.0.1")
		);
		assert!(router_host("not-a-url").is_none());
	}

	#[test]
	fn is_public_host_classifies_local_lan_and_public() {
		// Allowed: loopback, private space, link-local, mDNS.
		for host in [
			"localhost",
			"127.0.0.1",
			"127.5.5.5",
			"::1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.10",
			"169.254.7.7",
			"fc00::1",
			"fe80::1",
			"mybox.local",
		] {
			assert!(!is_public_host(host), "{host} should be allowed");
		}
		// Rejected: public IPs and ordinary DNS names.
		for host in [
			"8.8.8.8",
			"1.1.1.1",
			"172.32.0.1",
			"192.169.1.1",
			"11.0.0.1",
			"2606:4700::1111",
			"attacker.example",
			"attacker.example.com",
		] {
			assert!(is_public_host(host), "{host} should be rejected");
		}
	}

	#[test]
	fn llama_curl_args_refuse_to_send_the_key_to_a_public_host() {
		let key = Some("secret-llama-key".to_string());
		// Local and LAN routers keep working (with the key).
		for url in [
			"http://127.0.0.1:8080",
			"http://192.168.1.50:8080",
			"http://mybox.local:8080",
			"http://[::1]:8080",
		] {
			assert!(
				llama_curl_args(url, &key, "/v1/models").is_ok(),
				"{url} should work"
			);
		}
		// A public host is refused outright — the key never reaches argv.
		for url in [
			"https://attacker.example/v1/models",
			"http://8.8.8.8:8080",
			// userinfo must not launder the check.
			"http://127.0.0.1@attacker.example",
		] {
			let err = llama_curl_args(url, &key, "/v1/models")
				.err()
				.unwrap_or_else(|| panic!("{url} must be refused"));
			assert!(
				err.contains("local or private-network"),
				"unexpected error: {err}"
			);
		}
		// The host rule is unconditional, not a key-only gate: the feature is
		// local/LAN routers, so a public address fails whether or not a key is
		// stored (the error stays the same).
		let err = llama_curl_args("https://attacker.example", &None, "/v1/models")
			.expect_err("a public host must be refused even without a key");
		assert!(err.contains("local or private-network"));
	}

	#[test]
	fn builds_tree_from_file() {
		let dir = std::env::temp_dir().join(format!("tau-tree-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("tree.jsonl");
		{
			use std::io::Write;
			let mut f = File::create(&path).unwrap();
			f.write_all(r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"C:/tmp"}"#.as_bytes()).unwrap();
			f.write_all(
				b"
",
			)
			.unwrap();
			f.write_all(format!("{}
", r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#).as_bytes()).unwrap();
			f.write_all(format!("{}
", r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-12T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"reply"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}]}}"#).as_bytes()).unwrap();
			f.write_all(format!("{}
", r#"{"type":"message","id":"a2","parentId":"u1","timestamp":"2026-08-12T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"other branch"}]}}"#).as_bytes()).unwrap();
			f.write_all(format!("{}
", r#"{"type":"label","id":"l1","parentId":"a1","timestamp":"2026-08-12T00:00:04.000Z","targetId":"a1","label":"checkpoint"}"#).as_bytes()).unwrap();
		}
		let out = read_tree_from_file(&path).unwrap();
		let tree = out["tree"].as_array().unwrap();
		assert_eq!(tree.len(), 1, "single root");
		assert_eq!(tree[0]["entry"]["id"], "u1");
		assert_eq!(
			tree[0]["children"].as_array().unwrap().len(),
			2,
			"two branches"
		);
		assert_eq!(tree[0]["children"][0]["entry"]["id"], "a1");
		assert_eq!(tree[0]["children"][0]["label"], "checkpoint");
		// Tool-call args dropped; content collapsed to a plain text preview.
		assert!(tree[0]["children"][0]["entry"]["message"]["content"].is_string());
		assert_eq!(
			tree[0]["children"][0]["entry"]["message"]["content"],
			"reply"
		);
		assert_eq!(out["leafId"], "a2", "leaf approximated by last entry");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn deep_chains_do_not_overflow_the_stack() {
		// A 5000-level linear chain used to blow the worker stack. The file
		// builder is iterative AND depth-limited, so the output Value stays
		// shallow enough for serde_json's recursive serialize/drop.
		let dir = std::env::temp_dir().join(format!("tau-deep-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("deep.jsonl");
		{
			use std::io::Write;
			let mut f = File::create(&path).unwrap();
			f.write_all(r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"C:/tmp"}"#.as_bytes()).unwrap();
			f.write_all(
				b"
",
			)
			.unwrap();
			for i in 0..5000 {
				let parent = if i == 0 {
					"null".to_string()
				} else {
					format!(r#""n{}""#, i - 1)
				};
				let line = format!(
					r#"{{"type":"message","id":"n{i}","parentId":{parent},"timestamp":"2026-08-12T00:00:00.000Z","message":{{"role":"user","content":[{{"type":"text","text":"x"}}]}}}}"#
				);
				f.write_all(line.as_bytes()).unwrap();
				f.write_all(
					b"
",
				)
				.unwrap();
			}
		}
		let out = read_tree_from_file(&path).unwrap();
		assert_eq!(out["tree"][0]["entry"]["id"], "n0");
		assert_eq!(out["leafId"], "n4999");
		// The chain is truncated at MAX_TREE_DEPTH so the nested Value stays
		// shallow enough to serialize and drop safely.
		let mut node = &out["tree"][0];
		let mut depth = 1;
		while let Some(kids) = node["children"].as_array() {
			if kids.is_empty() {
				break;
			}
			node = &kids[0];
			depth += 1;
			assert!(depth <= MAX_TREE_DEPTH + 2, "depth exceeded limit");
		}
		assert!(
			depth >= MAX_TREE_DEPTH - 1,
			"expected the chain to reach the limit, got {depth}"
		);
		// Serialize the result — recursive in serde_json — must not overflow.
		let text = serde_json::to_string(&out).unwrap();
		assert!(text.len() > 1000);
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn slims_get_tree_responses() {
		let raw = serde_json::json!({
			"id": "gui-1",
			"type": "response",
			"command": "get_tree",
			"success": true,
			"data": {
				"leafId": "a1",
				"tree": [{
					"entry": {
						"type": "message",
						"id": "a1",
						"parentId": null,
						"timestamp": "2026-08-10T06:31:15.165Z",
						"message": {
							"role": "assistant",
							"model": "m1",
							"content": [
								{"type": "thinking", "thinking": "internal reasoning..."},
								{"type": "text", "text": "Hello world"},
								{"type": "toolCall", "id": "t1", "name": "bash", "arguments": {"command": "ls"}}
							],
							"usage": {"input": 1, "output": 1}
						}
					},
					"children": [{
						"entry": {
							"type": "message",
							"id": "r1",
							"parentId": "a1",
							"message": {
								"role": "toolResult",
								"toolName": "bash",
								"content": [{"type": "text", "text": "huge output..."}]
							}
						},
						"children": []
					}],
					"label": "checkpoint"
				}]
			}
		});
		let slim = slim_get_tree_payload(&raw);
		// Envelope preserved.
		assert_eq!(slim["command"], "get_tree");
		assert_eq!(slim["data"]["leafId"], "a1");
		// Tree structure + label kept.
		let node = &slim["data"]["tree"][0];
		assert_eq!(node["entry"]["id"], "a1");
		assert_eq!(node["label"], "checkpoint");
		assert_eq!(node["children"][0]["entry"]["message"]["toolName"], "bash");
		// Content collapsed to a text preview; heavy fields dropped.
		assert_eq!(
			node["entry"]["message"]["content"],
			"internal reasoning...Hello world"
		);
		assert!(node["entry"]["message"].get("usage").is_none());
		// The content is now a plain string — no block array, no toolCall/thinking.
		assert!(node["entry"]["message"]["content"].is_string());
		assert!(slim.to_string().len() < 500);
	}

	#[test]
	fn parses_tool_result_messages() {
		let path = write_temp_session(
			"scan-toolresult",
			&[
				r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo hi"}}]}}"#,
				r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-10T06:31:16.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"hi\n"}]}}"#,
			],
		);
		let messages = read_session_messages(&path);
		assert_eq!(messages.len(), 2);
		assert_eq!(messages[1].role, "toolResult");
		assert_eq!(messages[1].blocks.len(), 1);
		assert_eq!(messages[1].blocks[0].kind, "text");
		assert_eq!(messages[1].blocks[0].text, "hi\n");
		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn scans_session_header_and_title() {
		let path = write_temp_session(
			"scan-header",
			&[
				r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:\\projects\\demo"}"#,
				r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-08-10T06:31:02.438Z","provider":"kimi-coding","modelId":"k3"}"#,
				r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-08-10T06:31:10.660Z","message":{"role":"user","content":[{"type":"text","text":"Fix the flaky test in the auth module please"}]}}"#,
				r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"internal note"},{"type":"text","text":"Done."}]}}"#,
			],
		);
		let scan = scan_session(&path, 400);
		assert_eq!(scan.project.as_deref(), Some("D:\\projects\\demo"));
		assert_eq!(scan.model.as_deref(), Some("kimi-coding/k3"));
		assert_eq!(scan.message_count, 2);
		assert!(scan.title.contains("Fix the flaky test"));
		assert!(scan.created_at.is_some());

		let messages = read_session_messages(&path);
		assert_eq!(messages.len(), 2);
		assert_eq!(messages[0].role, "user");
		assert_eq!(messages[0].blocks.len(), 1);
		assert_eq!(messages[0].blocks[0].kind, "text");
		assert_eq!(messages[1].role, "assistant");
		assert_eq!(messages[1].blocks.len(), 2);
		assert_eq!(messages[1].blocks[0].kind, "thinking");
		assert_eq!(messages[1].blocks[1].kind, "text");
	}

	#[test]
	fn collects_branched_but_not_nested_subagent_sessions() {
		let root = std::env::temp_dir().join(format!("tau-collect-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		let project = root.join("--proj--");
		std::fs::create_dir_all(&project).unwrap();
		// 分支会话：与用户会话同层（depth 1），header 带 parentSession —— 必须列出
		let branched = project.join("2026-01-01T00-00-00-000Z_branched.jsonl");
		std::fs::write(
			&branched,
			r#"{"type":"session","version":3,"id":"b1","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:/demo","parentSession":"C:/p.jsonl"}"#,
		)
		.unwrap();
		// 子代理会话：嵌套目录（<会话uuid>/<agent-id>/…，depth >= 2）—— 必须跳过
		let nested_dir = project
			.join("2026-01-01T00-00-00-000Z_parent")
			.join("11859066");
		std::fs::create_dir_all(&nested_dir).unwrap();
		let nested = nested_dir.join("2026-01-01T00-05-00-000Z_sub.jsonl");
		std::fs::write(
			&nested,
			r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:/demo","parentSession":"C:/p.jsonl"}"#,
		)
		.unwrap();

		let mut out = Vec::new();
		collect_sessions(&root, &mut out);
		assert_eq!(out.len(), 1, "only the same-layer branched session lists");
		assert_eq!(out[0].path, branched.to_string_lossy().to_string());

		// 全量遍历（归档/清理用）仍收集两个文件；嵌套判定交给 is_nested_session
		let mut files = Vec::new();
		session_files(&root, &mut files, 0);
		assert!(files.contains(&nested));
		assert!(files.contains(&branched));
		assert!(is_nested_session(&root, &nested));
		assert!(!is_nested_session(&root, &branched));
		let _ = std::fs::remove_dir_all(&root);
	}

	#[test]
	fn parses_subagent_status() {
		let session = "D:\\sessions\\parent.jsonl";
		let session_lower = canonical_or(Path::new(session))
			.to_string_lossy()
			.to_lowercase();
		let now = 1_800_000_000_000u64;
		let mk = |state: &str, last_update: u64, sid: &str| {
			serde_json::json!({
				"runId": "r1",
				"sessionId": sid,
				"mode": "workflow",
				"state": state,
				"startedAt": now - 60_000,
				"lastUpdate": last_update,
				"steps": [{
					"agent": "worker",
					"label": "boot",
					"status": "running",
					"model": "deepseek-v4-flash",
					"turnCount": 3,
					"toolCount": 5,
					"recentTools": [
						{ "tool": "read", "args": "a.ts", "endMs": 1 },
						{ "tool": "bash", "args": "ls -la", "endMs": 2 }
					]
				}]
			})
		};
		// Active run for this session parses with its step summary.
		let run = parse_subagent_status(&mk("running", now - 1000, session), &session_lower, now)
			.expect("active run should parse");
		assert_eq!(run.run_id, "r1");
		assert_eq!(run.steps.len(), 1);
		assert_eq!(run.steps[0].label, "boot");
		assert_eq!(run.steps[0].last_tool.as_deref(), Some("bash"));
		assert_eq!(run.steps[0].last_tool_args.as_deref(), Some("ls -la"));
		// Terminal, stale and other-session runs are filtered out.
		assert!(
			parse_subagent_status(&mk("complete", now - 1000, session), &session_lower, now)
				.is_none()
		);
		assert!(parse_subagent_status(
			&mk("running", now - 20 * 60 * 1000, session),
			&session_lower,
			now
		)
		.is_none());
		assert!(parse_subagent_status(
			&mk("running", now - 1000, "D:\\sessions\\other.jsonl"),
			&session_lower,
			now
		)
		.is_none());
	}

	#[test]
	fn collects_usage_records() {
		let dir = std::env::temp_dir().join(format!("pi-gui-usage-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("usage.jsonl");
		let mut file = File::create(&path).unwrap();
		file.write_all(format!("{}
", r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"D:\\proj"}"#).as_bytes()).unwrap();
		file.write_all(format!("{}
", r#"{"type":"message","id":"a1","timestamp":"2026-08-12T01:00:00.000Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-v4","usage":{"input":100,"output":50,"cacheRead":200,"reasoning":10,"totalTokens":360,"cost":{"total":0.001}}}}"#).as_bytes()).unwrap();
		file.write_all(format!("{}
", r#"{"type":"message","id":"a2","timestamp":"2026-08-13T01:00:00.000Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-v4","usage":{"input":10,"output":5,"cacheRead":0,"reasoning":0,"totalTokens":15,"cost":{"total":0.0001}}}}"#).as_bytes()).unwrap();
		file.write_all(format!("{}
", r#"{"type":"message","id":"u1","timestamp":"2026-08-13T02:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#).as_bytes()).unwrap();

		let mut out = Vec::new();
		collect_usage(&dir, &mut out);
		assert_eq!(out.len(), 2);
		assert_eq!(out[0].date, "2026-08-12");
		assert_eq!(out[0].provider, "deepseek");
		assert_eq!(out[0].model, "deepseek-v4");
		assert_eq!(out[0].project.as_deref(), Some("D:\\proj"));
		assert_eq!(out[0].total, 360);
		assert_eq!(out[0].input, 100);
		assert_eq!(out[0].cache_read, 200);
		assert!((out[0].cost - 0.001).abs() < 1e-9);
		assert_eq!(out[1].total, 15);

		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn parses_iso_timestamps_with_leap_days() {
		// 2024-02-29 (leap year) vs 2023-02-28: exactly one year apart.
		let leap = parse_iso_ms("2024-02-29T00:00:00.000Z").unwrap();
		let prev = parse_iso_ms("2023-02-28T00:00:00.000Z").unwrap();
		assert_eq!(leap - prev, 366 * 86400 * 1000);
		// A non-leap Feb 29 must be rejected.
		assert!(parse_iso_ms("2023-02-29T00:00:00.000Z").is_none());
		// Out-of-range dates and clock values must be rejected.
		assert!(parse_iso_ms("2024-04-31T00:00:00.000Z").is_none());
		assert!(parse_iso_ms("2024-13-01T00:00:00.000Z").is_none());
		assert!(parse_iso_ms("2024-01-01T24:00:00.000Z").is_none());
		assert!(parse_iso_ms("2024-01-01T00:60:00.000Z").is_none());
		// Sub-second precision is ignored (both resolve to the same ms).
		assert_eq!(
			parse_iso_ms("2024-01-01T00:00:00.123Z"),
			parse_iso_ms("2024-01-01T00:00:00.999Z")
		);
	}

	#[test]
	fn parses_iso_timestamps_with_timezone_offsets() {
		// An explicit offset must be folded to UTC, not silently treated as Z
		// (the old parser dropped everything after the seconds field).
		assert_eq!(
			parse_iso_ms("2026-08-12T08:00:00.000+08:00").unwrap(),
			parse_iso_ms("2026-08-12T00:00:00.000Z").unwrap()
		);
		assert_eq!(
			parse_iso_ms("2026-08-12T01:30:00-02:30").unwrap(),
			parse_iso_ms("2026-08-12T04:00:00.000Z").unwrap()
		);
		assert_eq!(
			parse_iso_ms("2026-08-12T12:00:00+0530").unwrap(),
			parse_iso_ms("2026-08-12T06:30:00.000Z").unwrap()
		);
		// Garbage offsets are rejected rather than mis-parsed.
		assert!(parse_iso_ms("2026-08-12T12:00:00+99:00").is_none());
	}

	#[test]
	fn parses_tool_calls_and_search_snippets() {
		let path = write_temp_session(
			"scan-tools",
			&[
				r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-08-10T06:31:02.384Z","cwd":"D:\\projects\\demo"}"#,
				r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-10T06:31:10.660Z","message":{"role":"user","content":[{"type":"text","text":"hello world unique-token-xyz"}]}}"#,
				r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-10T06:31:15.165Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"echo hi"}},{"type":"text","text":"ran it"}]}}"#,
			],
		);
		let messages = read_session_messages(&path);
		assert_eq!(messages[1].blocks[0].kind, "tool");
		assert_eq!(messages[1].blocks[0].name.as_deref(), Some("bash"));
		assert!(messages[1].blocks[0].text.contains("echo hi"));

		let snippet = search_snippet(&path, "unique-token-xyz").unwrap();
		assert!(snippet.contains("unique-token-xyz"));

		let _ = std::fs::remove_file(&path);
	}

	/// Exercises the session-dir boundary checks against a temp session dir
	/// (PI_SESSION_DIR is process-global, so all scenarios run in one test).
	#[test]
	fn session_commands_enforce_boundaries() {
		// Env is process-global and cargo runs tests in parallel — hold the
		// shared guard for the whole env-mutating section.
		let _guard = ENV_GUARD.lock().unwrap();
		let old_session_dir = std::env::var_os("PI_SESSION_DIR");
		let dir = std::env::temp_dir().join(format!("pi-gui-sess-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_SESSION_DIR", &dir);

		let session = dir.join("abc.jsonl");
		std::fs::write(
			&session,
			"{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"cwd\":\"D:\\\\demo\"}\n",
		)
		.unwrap();

		// require_session_path: inside is fine, outside is rejected.
		// (canonicalize returns `\\?\`-prefixed paths on Windows)
		let full = require_session_path(&session).unwrap();
		assert_eq!(full.file_name().and_then(|n| n.to_str()), Some("abc.jsonl"));
		assert!(full.starts_with(std::fs::canonicalize(&dir).unwrap()));
		let outside = std::env::temp_dir().join(format!("pi-gui-outside-{}", std::process::id()));
		std::fs::write(&outside, "{}").unwrap();
		assert!(require_session_path(&outside).is_err());
		assert!(require_session_path(&dir.join("missing.jsonl")).is_err());

		// is_running_session: false by default, true when a window's process
		// state points at the file.
		let state = PiState::default();
		assert!(!is_running_session(&state, &session));
		{
			let mut map = state.inner.lock().unwrap();
			let proc = PiProcess {
				session_file: Some(session.clone()),
				..Default::default()
			};
			map.insert("main".to_string(), proc);
		}
		assert!(is_running_session(&state, &session));
		state.inner.lock().unwrap().remove("main");

		// Archive: works once, rejects double-archive and the trash copy.
		move_session_to_aux(&session, &archive_dir()).unwrap();
		assert!(!session.exists());
		let archived = archive_dir().join("abc.jsonl");
		assert!(archived.exists());
		assert!(move_session_to_aux(&archived, &archive_dir()).is_err());

		// Restore: only archive/trash paths are accepted. The commands are thin
		// async wrappers; the tests drive the inner bodies directly.
		assert!(restore_session_inner(&outside.to_string_lossy()).is_err());
		restore_session_inner(&archived.to_string_lossy()).unwrap();
		assert!(session.exists());
		assert!(!archived.exists());

		// Delete -> trash, then purge.
		move_session_to_aux(&session, &trash_dir()).unwrap();
		let trashed = trash_dir().join("abc.jsonl");
		assert!(trashed.exists());
		assert!(purge_session_inner(&session.to_string_lossy()).is_err());
		purge_session_inner(&trashed.to_string_lossy()).unwrap();
		assert!(!trashed.exists());

		let _ = std::fs::remove_file(&outside);
		let _ = std::fs::remove_dir_all(&dir);
		// Restore the caller's environment (best effort — a failing test
		// leaves the guard dropped but the env may keep the temp values).
		match old_session_dir {
			Some(v) => std::env::set_var("PI_SESSION_DIR", v),
			None => std::env::remove_var("PI_SESSION_DIR"),
		}
	}

	#[test]
	fn limited_lines_skips_oversized_lines() {
		let path = std::env::temp_dir().join(format!("pi-gui-lines-test-{}", std::process::id()));
		let mut file = File::create(&path).unwrap();
		writeln!(file, "small-a").unwrap();
		writeln!(file, "{}", "x".repeat(1024)).unwrap(); // oversized
		writeln!(file, "small-b").unwrap();
		drop(file);

		let file = File::open(&path).unwrap();
		let lines: Vec<String> = LimitedLines::new(BufReader::new(file), 64)
			.flatten()
			.collect();
		assert_eq!(lines, vec!["small-a".to_string(), "small-b".to_string()]);
		let _ = std::fs::remove_file(&path);
	}

	/// Look up one key in the env vector the session host is spawned with.
	fn env_get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
		env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
	}

	#[allow(clippy::too_many_arguments)]
	fn host_env(
		session_file: Option<&str>,
		fork_of: Option<&str>,
		session_name: Option<&str>,
		system_prompt: Option<&str>,
		append_system_prompt: Option<&str>,
		tools: Option<&[String]>,
		excluded_tools: Option<&[String]>,
		models: Option<&str>,
	) -> Result<Vec<(String, String)>, String> {
		session_host_env(
			Path::new("/runtime/pkg/dist/index.js"),
			Path::new("/sessions"),
			session_file,
			fork_of,
			session_name,
			system_prompt,
			append_system_prompt,
			tools,
			excluded_tools,
			models,
			None,
		)
	}

	#[test]
	fn session_host_env_always_sets_pkg_and_session_dir() {
		let env = host_env(None, None, None, None, None, None, None, None).unwrap();
		assert_eq!(
			env_get(&env, "TAU_PI_PKG"),
			Some("/runtime/pkg/dist/index.js")
		);
		assert_eq!(env_get(&env, "TAU_SESSION_DIR"), Some("/sessions"));
		// Nothing optional leaks in when unset.
		for key in [
			"TAU_SESSION_FILE",
			"TAU_FORK_OF",
			"TAU_SESSION_NAME",
			"TAU_SYSTEM_PROMPT",
			"TAU_APPEND_SYSTEM_PROMPT",
			"TAU_EXCLUDED_TOOLS",
			"TAU_MODELS",
			"TAU_EXTENSION",
		] {
			assert!(env_get(&env, key).is_none(), "{key} must be unset");
		}
	}

	#[test]
	fn session_host_env_tools_three_states() {
		// None = pi defaults ("null"); Some([]) = no tools; Some([...]) = allowlist.
		let env = host_env(None, None, None, None, None, None, None, None).unwrap();
		assert_eq!(env_get(&env, "TAU_TOOLS"), Some("null"));

		let empty: &[String] = &[];
		let env = host_env(None, None, None, None, None, Some(empty), None, None).unwrap();
		assert_eq!(env_get(&env, "TAU_TOOLS"), Some("[]"));

		let list = vec!["read".to_string(), "bash".to_string()];
		let env = host_env(None, None, None, None, None, Some(&list), None, None).unwrap();
		assert_eq!(env_get(&env, "TAU_TOOLS"), Some(r#"["read","bash"]"#));
	}

	#[test]
	fn session_host_env_fork_wins_over_session_file() {
		let env = host_env(
			Some("/sessions/a.jsonl"),
			Some("/sessions/b.jsonl"),
			None,
			None,
			None,
			None,
			None,
			None,
		)
		.unwrap();
		assert_eq!(env_get(&env, "TAU_FORK_OF"), Some("/sessions/b.jsonl"));
		assert!(env_get(&env, "TAU_SESSION_FILE").is_none());

		let env = host_env(
			Some("/sessions/a.jsonl"),
			None,
			None,
			None,
			None,
			None,
			None,
			None,
		)
		.unwrap();
		assert_eq!(env_get(&env, "TAU_SESSION_FILE"), Some("/sessions/a.jsonl"));
		assert!(env_get(&env, "TAU_FORK_OF").is_none());
	}

	#[test]
	fn session_host_env_prompts_trimmed_and_capped() {
		let ok = "x".repeat(30000);
		let env = host_env(None, None, None, Some(&ok), None, None, None, None).unwrap();
		assert_eq!(env_get(&env, "TAU_SYSTEM_PROMPT"), Some(ok.as_str()));

		let too_long = "x".repeat(30001);
		assert!(host_env(None, None, None, Some(&too_long), None, None, None, None).is_err());
		assert!(host_env(None, None, None, None, Some(&too_long), None, None, None).is_err());

		// Blank / whitespace-only prompts are dropped entirely.
		let env = host_env(None, None, None, Some("   "), Some(""), None, None, None).unwrap();
		assert!(env_get(&env, "TAU_SYSTEM_PROMPT").is_none());
		assert!(env_get(&env, "TAU_APPEND_SYSTEM_PROMPT").is_none());
	}

	#[test]
	fn session_host_env_optional_scalars() {
		let excluded = vec!["write".to_string()];
		let env = host_env(
			None,
			None,
			Some("demo"),
			None,
			None,
			None,
			Some(&excluded),
			Some(" deepseek/* , gpt-* "),
		)
		.unwrap();
		assert_eq!(env_get(&env, "TAU_SESSION_NAME"), Some("demo"));
		assert_eq!(env_get(&env, "TAU_EXCLUDED_TOOLS"), Some(r#"["write"]"#));
		assert_eq!(env_get(&env, "TAU_MODELS"), Some("deepseek/* , gpt-*"));

		// Empty exclude list and blank name/models stay unset.
		let empty: &[String] = &[];
		let env = host_env(
			None,
			None,
			Some("  "),
			None,
			None,
			None,
			Some(empty),
			Some("  "),
		)
		.unwrap();
		assert!(env_get(&env, "TAU_SESSION_NAME").is_none());
		assert!(env_get(&env, "TAU_EXCLUDED_TOOLS").is_none());
		assert!(env_get(&env, "TAU_MODELS").is_none());
	}

	#[test]
	fn session_host_env_sets_extension_when_present() {
		let env = session_host_env(
			Path::new("/runtime/pkg/dist/index.js"),
			Path::new("/sessions"),
			None,
			None,
			None,
			None,
			None,
			None,
			None,
			None,
			Some(Path::new("/res/agent-sidecar/tau-extension.mjs")),
		)
		.unwrap();
		assert_eq!(
			env_get(&env, "TAU_EXTENSION"),
			Some("/res/agent-sidecar/tau-extension.mjs")
		);
	}
}

#[cfg(test)]
mod e2e_tests {
	use super::*;
	use crate::pi_session::LimitedLines;
	use serde_json::Value;
	use std::fs::File;
	use std::io::{BufReader, Write};
	use std::path::PathBuf;
	use std::process::Stdio;
	use std::time::{Duration, Instant};

	/// End-to-end: spawn the real pi binary in RPC mode against a temp
	/// session, request the tree, run it through the slim layer and assert
	/// the response arrives quickly and stays small. Mirrors the exact
	/// forwarding path the GUI uses (minus the webview emit).
	#[test]
	fn e2e_get_tree_slims_responses() {
		let _g = ENV_GUARD.lock().unwrap();
		// A small but realistic session with tool output and thinking.
		let dir = std::env::temp_dir().join(format!("tau-e2e-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let session = dir.join("session.jsonl");
		{
			let mut f = File::create(&session).unwrap();
			let cwd = std::env::temp_dir().to_string_lossy().replace('\\', "/");
			let line = format!(
				r#"{{"type":"session","version":3,"id":"s1","timestamp":"2026-08-12T00:00:00.000Z","cwd":"{cwd}"}}"#
			);
			f.write_all(line.as_bytes()).unwrap();
			f.write_all(
				b"
",
			)
			.unwrap();
			f.write_all(format!("{}
", r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello pi"}]}}"#).as_bytes()).unwrap();
			f.write_all(format!("{}
", r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-12T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"Hi!"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls -la"}}]}}"#).as_bytes()).unwrap();
			f.write_all(format!("{}
", r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-12T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"total 48\ndrwxr-xr-x ..."}]}}"#).as_bytes()).unwrap();
		}
		let Some(info) = probe_pi() else {
			eprintln!("pi binary not found in PATH — skipping e2e test");
			return;
		};
		let mut cmd = pi_command(&info);
		cmd.arg("--mode")
			.arg("rpc")
			.arg("--session")
			.arg(&session)
			.arg("--no-context-files")
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		#[cfg(windows)]
		no_console_window(&mut cmd);
		let mut child = match cmd.spawn() {
			Ok(c) => c,
			Err(e) => {
				eprintln!("failed to spawn pi: {e} — skipping");
				return;
			}
		};
		let mut stdin = child.stdin.take().unwrap();
		stdin
			.write_all(br#"{"type":"get_tree","id":"e2e-1"}"#)
			.and_then(|_| stdin.write_all(b"\n"))
			.unwrap();
		let stdout = child.stdout.take().unwrap();
		let reader = BufReader::new(stdout);
		let start = Instant::now();
		let mut got_tree = false;
		for line in LimitedLines::new(reader, MAX_EVENT_LINE) {
			let Ok(line) = line else { break };
			if line.trim().is_empty() {
				continue;
			}
			let payload: Value = serde_json::from_str(&line).unwrap_or(Value::String(line));
			if payload.get("type").and_then(|x| x.as_str()) != Some("response") {
				continue;
			}
			let id = payload.get("id").and_then(|x| x.as_str()).unwrap_or("");
			if id != "e2e-1" {
				continue;
			}
			assert_eq!(
				payload.get("command").and_then(|x| x.as_str()),
				Some("get_tree")
			);
			assert_eq!(payload.get("success").and_then(|x| x.as_bool()), Some(true));
			let slim = slim_get_tree_payload(&payload);
			let slim_len = slim.to_string().len();
			let raw_len = payload.to_string().len();
			assert!(slim_len < raw_len, "slimmed response must be smaller");
			assert!(
				slim_len < 2000,
				"slimmed response should be tiny, got {slim_len}"
			);
			let tree = &slim["data"]["tree"];
			assert!(tree.is_array() && !tree.as_array().unwrap().is_empty());
			assert!(slim["data"]["leafId"].is_string(), "leafId must be present");
			got_tree = true;
			break;
		}
		assert!(got_tree, "no get_tree response arrived");
		assert!(
			start.elapsed() < Duration::from_secs(20),
			"get_tree response took {:?}",
			start.elapsed()
		);
		drop(stdin);
		let _ = child.kill();
		let _ = child.wait();
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn vendored_layout_detects_node_and_cli() {
		let dir = std::env::temp_dir().join(format!("tau-vendored-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let node_dir = dir.join("node");
		std::fs::create_dir_all(&node_dir).unwrap();
		let cli_dir = dir
			.join("node_modules")
			.join("@earendil-works")
			.join("pi-coding-agent")
			.join("dist")
			.join("bundle");
		std::fs::create_dir_all(&cli_dir).unwrap();
		// Incomplete layout: no node, no cli.js yet.
		assert!(vendored_layout(&dir).is_none());
		let node_path = node_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
		std::fs::File::create(&node_path).unwrap();
		assert!(vendored_layout(&dir).is_none(), "cli.js still missing");
		let cli = cli_dir.join("cli.js");
		std::fs::File::create(&cli).unwrap();
		let (node, cli_found) = vendored_layout(&dir).expect("complete layout");
		assert_eq!(node, node_path);
		assert_eq!(cli_found, cli);
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn vendored_dirs_include_cargo_manifest_layout() {
		// Dev builds must be able to find src-tauri/resources/pi-runtime even
		// though the executable lives in target/debug.
		let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
		assert!(
			vendored_runtime_dirs().contains(&manifest_dir.join("resources").join("pi-runtime"))
		);
	}
}
