//! Session JSONL file format: reading a pi session file and turning its lines
//! into messages, blocks and usage records.
//!
//! Split out of `pi.rs`, which had become one ~4.9k-line module mixing process
//! management, the RPC bridge, session storage, archiving, search and the
//! MCP/trust/usage integrations. This is the file-format layer, and it is
//! deliberately free of Tauri state so it can be read (and tested) on its own.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiParsedImage {
	pub(crate) mime_type: String,
	pub(crate) data: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiParsedBlock {
	pub(crate) kind: String,
	pub(crate) text: String,
	pub(crate) name: Option<String>,
	pub(crate) image: Option<PiParsedImage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiParsedMessage {
	pub(crate) role: String,
	pub(crate) timestamp: Option<String>,
	pub(crate) entry_id: Option<String>,
	pub(crate) blocks: Vec<PiParsedBlock>,
	/// pi's assistant-message stopReason ("error", "aborted", …) when the
	/// turn failed — the frontend rebuilds its UiError envelope from it so
	/// replayed history shows the failure like the live stream did.
	pub(crate) stop_reason: Option<String>,
	pub(crate) error_message: Option<String>,
}

fn is_leap_year(y: i64) -> bool {
	(y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub(crate) fn parse_iso_ms(s: &str) -> Option<u64> {
	// Accept "2026-08-10T06:31:02.384Z" style timestamps.
	let s = s.trim();
	let s = s.strip_suffix('Z').unwrap_or(s);
	let (date, time) = s.split_once('T')?;
	let mut dp = date.split('-');
	let y: i64 = dp.next()?.parse().ok()?;
	// Reject pre-epoch years: a negative `secs` below would wrap through
	// `as u64` into a garbage huge epoch value.
	if y < 1970 {
		return None;
	}
	let mo: i64 = dp.next()?.parse().ok()?;
	let d: i64 = dp.next()?.parse().ok()?;
	if !(1..=12).contains(&mo) {
		return None;
	}
	// Real per-month day counts (leap-aware) so "Feb 30" style dates fail.
	let leap = is_leap_year(y);
	let days_in_month = [
		31,
		if leap { 29 } else { 28 },
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	if !(1..=days_in_month[(mo - 1) as usize]).contains(&d) {
		return None;
	}
	let mut tp = time.split(':');
	let h: i64 = tp.next()?.parse().ok()?;
	let mi: i64 = tp.next()?.parse().ok()?;
	let sec: i64 = tp.next()?.split('.').next()?.parse().ok()?;
	if !(0..=23).contains(&h) || !(0..=59).contains(&mi) || !(0..=60).contains(&sec) {
		return None;
	}
	// Days since the (proleptic Gregorian) year 0; the leap-day offset for
	// dates after February is folded into the day-of-year value below.
	let mut day_of_year =
		[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][(mo - 1) as usize] + (d - 1);
	if leap && mo > 2 {
		day_of_year += 1;
	}
	// Days since the (proleptic Gregorian) year 0. The day count uses
	// `y - 1`: `y*365 + y/4 - y/100 + y/400` also counts year y's own leap
	// day, i.e. it resolves to Jan 1 of year y+1 — every parsed timestamp
	// would come out ~365 days too large. The leap-day offset for dates
	// after February in year y is folded into day_of_year above.
	let y0 = y - 1;
	let days = y0 * 365 + y0 / 4 - y0 / 100 + y0 / 400 + day_of_year;
	let secs = days * 86400 + h * 3600 + mi * 60 + sec;
	// Sub-second precision is irrelevant here; epoch in ms.
	Some((secs as u64).saturating_mul(1000))
}

/// Maximum size of a single JSONL line we are willing to hold in memory.
/// Lines larger than this (typically huge base64 image messages) are skipped;
/// without this a single pathological line could balloon memory use while
/// listing/searching sessions.
pub(crate) const MAX_JSONL_LINE: usize = 16 * 1024 * 1024;

/// Like `BufRead::lines`, but skips lines larger than `max` bytes so a
/// pathological session file can't allocate unbounded memory.
pub(crate) struct LimitedLines<R> {
	reader: R,
	max: usize,
	buf: Vec<u8>,
}

impl<R> LimitedLines<R> {
	pub(crate) fn new(reader: R, max: usize) -> Self {
		Self {
			reader,
			max,
			buf: Vec::with_capacity(8 * 1024),
		}
	}
}

impl<R: BufRead> Iterator for LimitedLines<R> {
	type Item = std::io::Result<String>;

	fn next(&mut self) -> Option<Self::Item> {
		loop {
			self.buf.clear();
			let mut limited = (&mut self.reader).take((self.max + 1) as u64);
			match limited.read_until(b'\n', &mut self.buf) {
				Ok(0) => return None,
				Ok(n) if n > self.max => {
					// Discard the remainder of the oversized line so the next
					// iteration stays aligned on a line boundary.
					loop {
						self.buf.clear();
						let mut sink = (&mut self.reader).take(64 * 1024);
						match sink.read_until(b'\n', &mut self.buf) {
							Ok(0) => break,
							Ok(_) if self.buf.last() == Some(&b'\n') => break,
							Ok(_) => {}
							Err(_) => break,
						}
					}
				}
				Ok(_) => {
					if self.buf.last() == Some(&b'\n') {
						self.buf.pop();
					}
					if self.buf.last() == Some(&b'\r') {
						self.buf.pop();
					}
					return Some(Ok(String::from_utf8_lossy(&self.buf).into_owned()));
				}
				Err(e) => return Some(Err(e)),
			}
		}
	}
}

/// Iterate the JSON objects in a session JSONL file.
///
/// Six readers of session files (scan, parse, fork, import, tree, usage) all
/// repeated the same preamble — open, wrap in `LimitedLines`, skip blank
/// lines, skip lines that don't parse — and had drifted slightly apart while
/// doing so. This is that preamble in one place.
///
/// Blank and unparseable lines are skipped rather than reported: session
/// files are append-only, so a torn final line (crash mid-write) must not
/// invalidate everything before it.
///
/// `limit` caps how many *raw lines* are read, not how many objects are
/// yielded — oversized lines are dropped by `LimitedLines` first, and a
/// caller that only wants a cheap scan should not pay to read the whole file.
///
/// Opening the file is deliberately the caller's decision: this returns `Err`
/// on failure so each call site keeps its own error text (some treat an
/// unreadable session as "no data", others as a hard error).
pub(crate) fn session_values(
	path: &Path,
	limit: Option<usize>,
) -> Result<impl Iterator<Item = serde_json::Value>, std::io::Error> {
	let file = File::open(path)?;
	let reader = BufReader::new(file);
	// `.take(usize::MAX)` when unbounded keeps both branches the same type,
	// so the return can stay `impl Iterator` instead of a boxed trait object.
	let lines = LimitedLines::new(reader, MAX_JSONL_LINE).take(limit.unwrap_or(usize::MAX));
	Ok(lines.flatten().filter_map(|line| {
		if line.trim().is_empty() {
			return None;
		}
		serde_json::from_str::<serde_json::Value>(&line).ok()
	}))
}

pub(crate) fn extract_block_text(content: Option<&serde_json::Value>) -> Option<String> {
	let arr = content?.as_array()?;
	let mut out = String::new();
	for item in arr {
		let kind = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
		if kind == "text" {
			if let Some(s) = item.get("text").and_then(|x| x.as_str()) {
				out.push_str(s);
			}
		}
	}
	let out = out.trim().to_string();
	if out.is_empty() {
		None
	} else {
		Some(out)
	}
}

pub(crate) fn make_title(text: &str) -> String {
	let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
	let mut chars = one_line.chars();
	let mut out: String = chars.by_ref().take(60).collect();
	if chars.next().is_some() {
		out.push('…');
	}
	out
}

pub(crate) struct SessionScan {
	pub(crate) project: Option<String>,
	pub(crate) title: String,
	pub(crate) model: Option<String>,
	pub(crate) created_at: Option<u64>,
	pub(crate) message_count: u64,
}

/// Scan a session JSONL for display metadata. `limit` caps lines scanned
/// (list/search need only the head; message_count stays approximate for
/// very large files, which is acceptable for a sidebar list).
pub(crate) fn scan_session(path: &Path, limit: usize) -> SessionScan {
	let mut scan = SessionScan {
		project: None,
		title: String::new(),
		model: None,
		created_at: None,
		message_count: 0,
	};
	let Ok(values) = session_values(path, Some(limit)) else {
		return scan;
	};
	for v in values {
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		match kind {
			"session" => {
				scan.project = v
					.get("cwd")
					.and_then(|x| x.as_str())
					.filter(|s| !s.is_empty())
					.map(|s| s.to_string());
				scan.created_at = v
					.get("timestamp")
					.and_then(|x| x.as_str())
					.and_then(parse_iso_ms);
			}
			"model_change" => {
				let provider = v.get("provider").and_then(|x| x.as_str());
				let model_id = v.get("modelId").and_then(|x| x.as_str());
				if let (Some(p), Some(m)) = (provider, model_id) {
					scan.model = Some(format!("{p}/{m}"));
				}
			}
			"message" => {
				scan.message_count += 1;
				if scan.title.is_empty() {
					let role = v.pointer("/message/role").and_then(|x| x.as_str());
					if role == Some("user") {
						if let Some(text) = extract_block_text(v.pointer("/message/content")) {
							scan.title = make_title(&text);
						}
					}
				}
			}
			_ => {}
		}
	}
	scan
}

pub(crate) fn parse_message_blocks(message: &serde_json::Value) -> Vec<PiParsedBlock> {
	let content = message.get("content").and_then(|x| x.as_array());
	let mut blocks = Vec::new();
	if let Some(items) = content {
		for item in items {
			let kind = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
			match kind {
				"text" => {
					if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
						blocks.push(PiParsedBlock {
							kind: "text".into(),
							text: text.to_string(),
							name: None,
							image: None,
						});
					}
				}
				"thinking" => {
					if let Some(text) = item.get("thinking").and_then(|x| x.as_str()) {
						blocks.push(PiParsedBlock {
							kind: "thinking".into(),
							text: text.to_string(),
							name: None,
							image: None,
						});
					}
				}
				"toolCall" | "tool_call" | "toolUse" => {
					let name = item
						.get("name")
						.and_then(|x| x.as_str())
						.unwrap_or("tool")
						.to_string();
					let args = item
						.get("arguments")
						.or_else(|| item.get("input"))
						.map(|a| {
							if a.is_string() {
								a.as_str().unwrap_or_default().to_string()
							} else {
								serde_json::to_string_pretty(a).unwrap_or_default()
							}
						})
						.unwrap_or_default();
					blocks.push(PiParsedBlock {
						kind: "tool".into(),
						text: args,
						name: Some(name),
						image: None,
					});
				}
				"image" => {
					let mime = item
						.get("mime_type")
						.or_else(|| item.get("mimeType"))
						.and_then(|x| x.as_str())
						.unwrap_or("image/png")
						.to_string();
					if let Some(data) = item.get("data").and_then(|x| x.as_str()) {
						blocks.push(PiParsedBlock {
							kind: "image".into(),
							text: String::new(),
							name: None,
							image: Some(PiParsedImage {
								mime_type: mime,
								data: data.to_string(),
							}),
						});
					}
				}
				_ => {}
			}
		}
	}
	blocks
}

pub(crate) fn read_session_messages(path: &Path) -> Vec<PiParsedMessage> {
	let mut out = Vec::new();
	let Ok(values) = session_values(path, None) else {
		return out;
	};
	for v in values {
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		match kind {
			"message" => {
				let Some(msg) = v.get("message") else {
					continue;
				};
				let role = msg
					.get("role")
					.and_then(|x| x.as_str())
					.unwrap_or("assistant")
					.to_string();
				let timestamp = v
					.get("timestamp")
					.and_then(|x| x.as_str())
					.map(|s| s.to_string());
				let entry_id = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
				let blocks = parse_message_blocks(msg);
				let stop_reason = msg
					.get("stopReason")
					.and_then(|x| x.as_str())
					.map(|s| s.to_string());
				let error_message = msg
					.get("errorMessage")
					.and_then(|x| x.as_str())
					.map(|s| s.to_string());
				out.push(PiParsedMessage {
					role,
					timestamp,
					entry_id,
					blocks,
					stop_reason,
					error_message,
				});
			}
			"tool_result" => {
				let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
				let text = v
					.get("content")
					.and_then(|x| x.as_str())
					.unwrap_or("")
					.to_string();
				out.push(PiParsedMessage {
					role: "tool".into(),
					timestamp: None,
					entry_id: None,
					blocks: vec![PiParsedBlock {
						kind: "tool".into(),
						text: if text.len() > 8000 {
							format!(
								"{}…",
								&text[..text
									.char_indices()
									.nth(8000)
									.map(|(i, _)| i)
									.unwrap_or(text.len())]
							)
						} else {
							text
						},
						name: Some(name.to_string()),
						image: None,
					}],
					stop_reason: None,
					error_message: None,
				});
			}
			_ => {}
		}
	}
	out
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUsageEntry {
	pub(crate) date: String,
	pub(crate) provider: String,
	pub(crate) model: String,
	pub(crate) project: Option<String>,
	pub(crate) session_path: String,
	pub(crate) input: u64,
	pub(crate) output: u64,
	pub(crate) cache_read: u64,
	pub(crate) reasoning: u64,
	pub(crate) total: u64,
	pub(crate) cost: f64,
	/// Message timestamp (epoch ms) — the stats page derives per-session chat
	/// durations from these.
	pub(crate) ts: u64,
}

/// Scan every session JSONL for LLM `usage` records (one per assistant
/// message). The frontend aggregates by day/model/project for the usage
/// dashboard.
/// Scan one session file for LLM `usage` records (one per assistant message).
pub(crate) fn usage_from_file(path: &Path) -> Vec<PiUsageEntry> {
	let mut out = Vec::new();
	let Ok(values) = session_values(path, None) else {
		return out;
	};
	let mut project: Option<String> = None;
	for v in values {
		let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
			continue;
		};
		match kind {
			"session" => {
				project = v
					.get("cwd")
					.and_then(|x| x.as_str())
					.filter(|s| !s.is_empty())
					.map(|s| s.to_string());
			}
			"message" => {
				let Some(usage) = v.pointer("/message/usage") else {
					continue;
				};
				let date = v
					.get("timestamp")
					.and_then(|x| x.as_str())
					.map(|s| s.chars().take(10).collect::<String>())
					.unwrap_or_default();
				let provider = v
					.pointer("/message/provider")
					.and_then(|x| x.as_str())
					.unwrap_or("")
					.to_string();
				let model = v
					.pointer("/message/model")
					.and_then(|x| x.as_str())
					.unwrap_or("")
					.to_string();
				let num = |key: &str| usage.get(key).and_then(|x| x.as_u64()).unwrap_or(0);
				let cost = usage
					.pointer("/cost/total")
					.and_then(|x| x.as_f64())
					.unwrap_or(0.0);
				out.push(PiUsageEntry {
					date,
					provider,
					model,
					project: project.clone(),
					session_path: path.to_string_lossy().into_owned(),
					input: num("input"),
					output: num("output"),
					cache_read: num("cacheRead"),
					reasoning: num("reasoning"),
					total: usage
						.get("totalTokens")
						.and_then(|x| x.as_u64())
						.unwrap_or(0),
					cost,
					ts: v
						.get("timestamp")
						.and_then(|x| x.as_str())
						.and_then(parse_iso_ms)
						.unwrap_or(0),
				});
			}
			_ => {}
		}
	}
	out
}
