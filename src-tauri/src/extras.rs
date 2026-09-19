use std::{
	fs,
	io::{BufRead, BufReader, BufWriter, Read, Write},
	path::{Path, PathBuf},
	process::Command,
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderInfo {
	/// Provider id as pi knows it (catalog file name, models.json key, or
	/// auth.json key).
	id: String,
	/// True when the provider ships with pi's built-in model catalog; false
	/// for custom providers (models.json) or extension-registered ones.
	known: bool,
	/// True when pi-ai ships an OAuth login flow for this provider.
	oauth: bool,
}

/// Providers pi-ai ships an OAuth flow for. Source of truth: the
/// `dist/auth/oauth/` directory inside the vendored pi-ai package (one module
/// per provider) — cross-check this list against that directory whenever the
/// vendored pi runtime is upgraded.
const OAUTH_PROVIDERS: &[&str] = &[
	"anthropic",
	"github-copilot",
	"kimi-coding",
	"openai-codex",
	"openrouter",
	"radius",
	"xai",
];

fn pi_agent_dir() -> PathBuf {
	pi::agent_dir()
}

fn auth_file_path() -> PathBuf {
	pi_agent_dir().join("auth.json")
}

/// All provider ids pi can configure, in one list: the built-in catalog
/// shipped inside the pi package, plus custom providers from models.json,
/// plus any provider that already has a stored credential (covers
/// extension-registered providers). This mirrors what the TUI's `/login`
/// and `/logout` dialogs enumerate.
#[tauri::command]
pub fn pi_providers() -> Result<Vec<PiProviderInfo>, String> {
	let mut merged: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();

	// 1) Built-in catalog: pi-ai ships one JSON file per provider.
	if let Some(dir) = pi_ai_providers_data_dir() {
		for id in read_catalog_provider_ids(&dir) {
			merged.insert(id, true);
		}
	}

	// 2) Custom providers (Ollama, vLLM, proxies, ...) from models.json.
	let mut custom: Vec<String> = Vec::new();
	if let Ok(raw) = fs::read_to_string(pi_agent_dir().join("models.json")) {
		if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
			if let Some(map) = v.get("providers").and_then(|p| p.as_object()) {
				custom.extend(map.keys().cloned());
			}
		}
	}

	// 3) Providers that already hold a credential in auth.json.
	custom.extend(read_auth_map().keys().cloned());
	custom.sort();
	custom.dedup();
	for id in custom {
		merged.entry(id).or_insert(false);
	}

	Ok(merged
		.into_iter()
		.map(|(id, known)| PiProviderInfo {
			oauth: OAUTH_PROVIDERS.contains(&id.as_str()),
			id,
			known,
		})
		.collect())
}

/// Locate pi-ai's provider catalog (`dist/providers/data/.manifest.json`)
/// inside the vendored pi package: nested under pi-coding-agent's own
/// node_modules first (the layout `npm run vendor:pi` produces), then the
/// hoisted layout at the runtime root. Returns None when no vendored runtime
/// is installed.
fn pi_ai_providers_data_dir() -> Option<PathBuf> {
	let dirs = crate::pi::vendored_runtime_dirs();
	let (_, cli) = dirs
		.iter()
		.find_map(|dir| crate::pi::vendored_layout(dir))?;
	// cli = <pkg>/dist/bundle/cli.js — the package root is three levels up.
	let pkg = cli.parent()?.parent()?.parent()?;
	let data = |base: &Path| {
		base.join("node_modules")
			.join("@earendil-works")
			.join("pi-ai")
			.join("dist")
			.join("providers")
			.join("data")
	};
	let mut candidates = vec![data(pkg)];
	// Hoisted: <runtime>/node_modules/@earendil-works/pi-ai/...
	if let Some(prefix) = pkg.parent().and_then(Path::parent).and_then(Path::parent) {
		candidates.push(data(prefix));
	}
	candidates
		.into_iter()
		.find(|d| d.join(".manifest.json").is_file())
}

/// Provider ids from the catalog: the manifest's `files` map (file name minus
/// `.json`), or any `*.json` file in the data dir as a fallback.
fn read_catalog_provider_ids(data_dir: &Path) -> Vec<String> {
	let mut ids = Vec::new();
	if let Ok(raw) = fs::read_to_string(data_dir.join(".manifest.json")) {
		if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
			if let Some(files) = v.get("files").and_then(|f| f.as_object()) {
				ids.extend(
					files
						.keys()
						.filter_map(|k| k.strip_suffix(".json"))
						.map(str::to_string),
				);
			}
		}
	}
	if ids.is_empty() {
		if let Ok(entries) = fs::read_dir(data_dir) {
			for entry in entries.flatten() {
				let Some(name) = entry.file_name().to_str().map(str::to_string) else {
					continue;
				};
				if let Some(id) = name.strip_suffix(".json") {
					if id != ".manifest" {
						ids.push(id.to_string());
					}
				}
			}
		}
	}
	ids.sort();
	ids
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
	fs::rename(tmp, path).map_err(|e| format!("failed to persist auth: {e}"))
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
			// API-key entries store the secret under `key`; OAuth entries store
			// tokens under `access`/`refresh`. Either counts as configured.
			let has_key = value
				.get("key")
				.map(|v| v.as_str().is_some_and(|s| !s.is_empty()))
				.unwrap_or(false)
				|| value
					.get("access")
					.map(|v| v.as_str().is_some_and(|s| !s.is_empty()))
					.unwrap_or(false);
			AuthProviderStatus {
				provider: provider.clone(),
				has_key,
				kind,
			}
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
	map.insert(
		provider,
		serde_json::json!({ "type": "api_key", "key": key }),
	);
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
// models.json custom provider management
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderEntry {
	/// Provider id (the `providers` map key in models.json).
	id: String,
	/// Raw provider config JSON (baseUrl/api/models/compat/...). The GUI edits
	/// the fields it knows and passes unknown ones through untouched.
	config: serde_json::Value,
}

fn models_file_path() -> PathBuf {
	pi_agent_dir().join("models.json")
}

/// Serializes models.json read-modify-write updates (same rationale as
/// AUTH_MUTEX: the write is atomic, the read+write pair is not).
static MODELS_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Reads models.json as a JSON object. A missing file yields an empty object;
/// a malformed file is an error so a bad edit never gets clobbered.
fn read_models_doc() -> Result<serde_json::Map<String, serde_json::Value>, String> {
	let path = models_file_path();
	let Ok(raw) = fs::read_to_string(&path) else {
		return Ok(serde_json::Map::new());
	};
	let value: serde_json::Value =
		serde_json::from_str(&raw).map_err(|e| format!("models.json is not valid JSON: {e}"))?;
	value
		.as_object()
		.cloned()
		.ok_or_else(|| "models.json root must be an object".to_string())
}

fn write_models_doc(doc: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
	let path = models_file_path();
	if let Some(dir) = path.parent() {
		fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
	}
	let raw = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
	let tmp = path.with_extension("json.tmp");
	fs::write(&tmp, raw).map_err(|e| format!("failed to write models.json: {e}"))?;
	fs::rename(tmp, path).map_err(|e| format!("failed to persist models.json: {e}"))
}

#[tauri::command]
pub fn pi_custom_providers() -> Result<Vec<CustomProviderEntry>, String> {
	let doc = read_models_doc()?;
	let mut out: Vec<CustomProviderEntry> = doc
		.get("providers")
		.and_then(|p| p.as_object())
		.map(|map| {
			map.iter()
				.map(|(id, config)| CustomProviderEntry {
					id: id.clone(),
					config: config.clone(),
				})
				.collect()
		})
		.unwrap_or_default();
	out.sort_by(|a, b| a.id.cmp(&b.id));
	Ok(out)
}

/// Provider id rules shared by every models.json write path.
fn validate_provider_id(id: &str) -> Result<(), String> {
	if id.is_empty() {
		return Err("provider id must not be empty".into());
	}
	let valid = id.chars().enumerate().all(|(i, c)| {
		c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && (c == '-' || c == '_'))
	});
	if !valid {
		return Err(
			"provider id may only contain lowercase letters, digits, '-' and '_' (not leading)"
				.into(),
		);
	}
	Ok(())
}

/// Every model entry in a `models` array needs a non-empty id.
fn validate_model_ids(models: &serde_json::Value) -> Result<(), String> {
	let arr = models
		.as_array()
		.ok_or("provider 'models' must be an array")?;
	for model in arr {
		let mid = model.get("id").and_then(|v| v.as_str()).unwrap_or("");
		if mid.trim().is_empty() {
			return Err("every model requires a non-empty id".into());
		}
	}
	Ok(())
}

/// Validates a custom provider entry before it lands in models.json. Built-in
/// catalog ids are allowed: the entry then acts as a partial overlay (extra
/// models, metadata overrides, credentials) merged onto the built-in
/// provider, so any single meaningful key is enough. Custom ids describe a
/// whole provider and still need a baseUrl plus at least one model.
fn validate_custom_provider(id: &str, config: &serde_json::Value) -> Result<(), String> {
	validate_provider_id(id)?;
	let obj = config
		.as_object()
		.ok_or("provider config must be an object")?;
	let builtin = pi_ai_providers_data_dir()
		.map(|dir| read_catalog_provider_ids(&dir).iter().any(|b| b == id))
		.unwrap_or(false);
	if builtin {
		const OVERLAY_KEYS: &[&str] = &[
			"models",
			"baseUrl",
			"headers",
			"compat",
			"modelOverrides",
			"apiKey",
			"oauth",
			"authHeader",
		];
		if !OVERLAY_KEYS.iter().any(|k| obj.contains_key(*k)) {
			return Err(
				"provider config requires at least one of: models, baseUrl, headers, compat, \
				 modelOverrides, apiKey, oauth, authHeader"
					.into(),
			);
		}
		if let Some(models) = obj.get("models") {
			validate_model_ids(models)?;
		}
		return Ok(());
	}
	let base_url_ok = obj
		.get("baseUrl")
		.and_then(|v| v.as_str())
		.is_some_and(|s| !s.trim().is_empty());
	if !base_url_ok {
		return Err("provider config requires a non-empty baseUrl".into());
	}
	let models = obj
		.get("models")
		.filter(|m| m.as_array().is_some_and(|a| !a.is_empty()))
		.ok_or("provider config requires at least one model")?;
	validate_model_ids(models)
}

#[tauri::command]
pub fn pi_upsert_custom_provider(id: String, config: serde_json::Value) -> Result<(), String> {
	let id = id.trim().to_string();
	validate_custom_provider(&id, &config)?;
	let _guard = MODELS_MUTEX
		.lock()
		.map_err(|e| format!("models lock poisoned: {e}"))?;
	let mut doc = read_models_doc()?;
	let providers = doc
		.entry("providers".to_string())
		.or_insert_with(|| serde_json::json!({}));
	let map = providers
		.as_object_mut()
		.ok_or("models.json 'providers' must be an object")?;
	map.insert(id, config);
	write_models_doc(&doc)
}

#[tauri::command]
pub fn pi_remove_custom_provider(id: String) -> Result<(), String> {
	let _guard = MODELS_MUTEX
		.lock()
		.map_err(|e| format!("models lock poisoned: {e}"))?;
	let mut doc = read_models_doc()?;
	if let Some(map) = doc.get_mut("providers").and_then(|p| p.as_object_mut()) {
		map.remove(&id);
	}
	write_models_doc(&doc)
}

// ---------------------------------------------------------------------------
// Provider model listing / per-model editing (catalog + models.json overlay)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelEntry {
	id: String,
	name: String,
	reasoning: bool,
	/// True when the model's `input` list contains "image".
	image: bool,
	context_window: u64,
	max_tokens: u64,
	/// From the models.json `models` array (user-defined), not the catalog.
	custom: bool,
	/// A `modelOverrides` patch exists for this model id.
	overridden: bool,
}

/// Display fields extracted from a catalog / models.json model object.
/// Returns None when the entry has no usable id.
fn model_entry(v: &serde_json::Value, custom: bool) -> Option<ProviderModelEntry> {
	let id = v
		.get("id")
		.and_then(|x| x.as_str())
		.filter(|s| !s.is_empty())?;
	Some(ProviderModelEntry {
		id: id.to_string(),
		name: v
			.get("name")
			.and_then(|x| x.as_str())
			.unwrap_or(id)
			.to_string(),
		reasoning: v
			.get("reasoning")
			.and_then(|x| x.as_bool())
			.unwrap_or(false),
		image: v
			.get("input")
			.and_then(|x| x.as_array())
			.is_some_and(|a| a.iter().any(|i| i.as_str() == Some("image"))),
		context_window: v.get("contextWindow").and_then(|x| x.as_u64()).unwrap_or(0),
		max_tokens: v.get("maxTokens").and_then(|x| x.as_u64()).unwrap_or(0),
		custom,
		overridden: false,
	})
}

/// Flattens a catalog provider file (`{ "<api>": { "<modelId>": Model } }`)
/// into entries. Unknown group/model shapes are skipped.
fn catalog_model_entries(value: &serde_json::Value) -> Vec<ProviderModelEntry> {
	let mut out = Vec::new();
	let Some(root) = value.as_object() else {
		return out;
	};
	for group in root.values() {
		let Some(models) = group.as_object() else {
			continue;
		};
		for model in models.values() {
			if let Some(entry) = model_entry(model, false) {
				out.push(entry);
			}
		}
	}
	out
}

/// Overlays one models.json provider entry onto the catalog-derived list:
/// `models` upserts by id (replacing the display values and flipping the
/// custom flag), then `modelOverrides` patches name/reasoning/context limits
/// in place. Overrides referencing unknown model ids are ignored — there is
/// nothing to display them on.
fn apply_models_json(entries: &mut Vec<ProviderModelEntry>, entry: Option<&serde_json::Value>) {
	let Some(obj) = entry.and_then(|e| e.as_object()) else {
		return;
	};
	if let Some(models) = obj.get("models").and_then(|m| m.as_array()) {
		for model in models {
			let Some(custom) = model_entry(model, true) else {
				continue;
			};
			match entries.iter_mut().find(|e| e.id == custom.id) {
				Some(slot) => *slot = custom,
				None => entries.push(custom),
			}
		}
	}
	if let Some(overrides) = obj.get("modelOverrides").and_then(|o| o.as_object()) {
		for (id, patch) in overrides {
			let Some(slot) = entries.iter_mut().find(|e| &e.id == id) else {
				continue;
			};
			slot.overridden = true;
			let Some(p) = patch.as_object() else {
				continue;
			};
			if let Some(name) = p.get("name").and_then(|v| v.as_str()) {
				slot.name = name.to_string();
			}
			if let Some(r) = p.get("reasoning").and_then(|v| v.as_bool()) {
				slot.reasoning = r;
			}
			if let Some(cw) = p.get("contextWindow").and_then(|v| v.as_u64()) {
				slot.context_window = cw;
			}
			if let Some(mt) = p.get("maxTokens").and_then(|v| v.as_u64()) {
				slot.max_tokens = mt;
			}
		}
	}
}

/// Effective model list for one provider: built-in catalog entries (when a
/// vendored runtime ships them) overlaid with the provider's models.json
/// `models` / `modelOverrides`. Custom providers simply get their models.json
/// entries back.
#[tauri::command]
pub fn pi_provider_models(provider: String) -> Result<Vec<ProviderModelEntry>, String> {
	let provider = provider.trim().to_string();
	validate_provider_id(&provider)?;
	let mut entries = Vec::new();
	if let Some(dir) = pi_ai_providers_data_dir() {
		let path = dir.join(format!("{provider}.json"));
		if let Ok(raw) = fs::read_to_string(&path) {
			if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
				entries = catalog_model_entries(&v);
			}
		}
	}
	let doc = read_models_doc()?;
	let entry = doc
		.get("providers")
		.and_then(|p| p.as_object())
		.and_then(|m| m.get(&provider));
	apply_models_json(&mut entries, entry);
	Ok(entries)
}

/// Upserts one model into `providers[provider].models` by id. Only the
/// `models` array is touched; every other key of the provider entry
/// (apiKey/baseUrl/compat/headers/...) passes through untouched.
#[tauri::command]
pub fn pi_provider_model_upsert(provider: String, model: serde_json::Value) -> Result<(), String> {
	let provider = provider.trim().to_string();
	validate_provider_id(&provider)?;
	{
		let obj = model.as_object().ok_or("model must be an object")?;
		let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
		if id.trim().is_empty() {
			return Err("model id must not be empty".into());
		}
		for key in ["contextWindow", "maxTokens"] {
			if let Some(v) = obj.get(key) {
				if v.as_u64().is_none_or(|n| n == 0) {
					return Err(format!("model {key} must be a positive integer"));
				}
			}
		}
	}
	let _guard = MODELS_MUTEX
		.lock()
		.map_err(|e| format!("models lock poisoned: {e}"))?;
	let mut doc = read_models_doc()?;
	let providers = doc
		.entry("providers".to_string())
		.or_insert_with(|| serde_json::json!({}));
	let map = providers
		.as_object_mut()
		.ok_or("models.json 'providers' must be an object")?;
	let model_id = model
		.get("id")
		.and_then(|v| v.as_str())
		.unwrap_or("")
		.to_string();
	let entry = map.entry(provider).or_insert_with(|| serde_json::json!({}));
	let entry_obj = entry
		.as_object_mut()
		.ok_or("provider entry must be an object")?;
	let models = entry_obj
		.entry("models".to_string())
		.or_insert_with(|| serde_json::json!([]));
	let arr = models
		.as_array_mut()
		.ok_or("provider 'models' must be an array")?;
	match arr
		.iter_mut()
		.find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model_id.as_str()))
	{
		Some(slot) => *slot = model,
		None => arr.push(model),
	}
	write_models_doc(&doc)
}

/// Removes one model from `providers[provider].models`. A provider entry left
/// as an empty object is dropped from `providers` entirely.
#[tauri::command]
pub fn pi_provider_model_remove(provider: String, model_id: String) -> Result<(), String> {
	let _guard = MODELS_MUTEX
		.lock()
		.map_err(|e| format!("models lock poisoned: {e}"))?;
	let mut doc = read_models_doc()?;
	if let Some(map) = doc.get_mut("providers").and_then(|p| p.as_object_mut()) {
		let mut drop_entry = false;
		if let Some(entry) = map.get_mut(&provider).and_then(|e| e.as_object_mut()) {
			if let Some(models) = entry.get_mut("models").and_then(|m| m.as_array_mut()) {
				models.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(model_id.as_str()));
				if models.is_empty() {
					entry.remove("models");
				}
			}
			drop_entry = entry.is_empty();
		}
		if drop_entry {
			map.remove(&provider);
		}
	}
	write_models_doc(&doc)
}

/// Writes `providers[provider].modelOverrides[modelId] = patch`. An empty
/// patch object is the same as removing the override.
#[tauri::command]
pub fn pi_provider_model_override_upsert(
	provider: String,
	model_id: String,
	patch: serde_json::Value,
) -> Result<(), String> {
	let provider = provider.trim().to_string();
	validate_provider_id(&provider)?;
	let model_id = model_id.trim().to_string();
	if model_id.is_empty() {
		return Err("model id must not be empty".into());
	}
	if patch
		.as_object()
		.ok_or("override patch must be an object")?
		.is_empty()
	{
		return pi_provider_model_override_remove(provider, model_id);
	}
	let _guard = MODELS_MUTEX
		.lock()
		.map_err(|e| format!("models lock poisoned: {e}"))?;
	let mut doc = read_models_doc()?;
	let providers = doc
		.entry("providers".to_string())
		.or_insert_with(|| serde_json::json!({}));
	let map = providers
		.as_object_mut()
		.ok_or("models.json 'providers' must be an object")?;
	let entry = map.entry(provider).or_insert_with(|| serde_json::json!({}));
	let entry_obj = entry
		.as_object_mut()
		.ok_or("provider entry must be an object")?;
	let overrides = entry_obj
		.entry("modelOverrides".to_string())
		.or_insert_with(|| serde_json::json!({}));
	let obj = overrides
		.as_object_mut()
		.ok_or("provider 'modelOverrides' must be an object")?;
	obj.insert(model_id, patch);
	write_models_doc(&doc)
}

/// Deletes `providers[provider].modelOverrides[modelId]`; an emptied
/// `modelOverrides` map and an emptied provider entry are cleaned up too.
#[tauri::command]
pub fn pi_provider_model_override_remove(provider: String, model_id: String) -> Result<(), String> {
	let _guard = MODELS_MUTEX
		.lock()
		.map_err(|e| format!("models lock poisoned: {e}"))?;
	let mut doc = read_models_doc()?;
	if let Some(map) = doc.get_mut("providers").and_then(|p| p.as_object_mut()) {
		let mut drop_entry = false;
		if let Some(entry) = map.get_mut(&provider).and_then(|e| e.as_object_mut()) {
			let mut drop_key = false;
			if let Some(overrides) = entry
				.get_mut("modelOverrides")
				.and_then(|o| o.as_object_mut())
			{
				overrides.remove(&model_id);
				drop_key = overrides.is_empty();
			}
			if drop_key {
				entry.remove("modelOverrides");
			}
			drop_entry = entry.is_empty();
		}
		if drop_entry {
			map.remove(&provider);
		}
	}
	write_models_doc(&doc)
}

// ---------------------------------------------------------------------------
// MCP server config management (pi-mcp-adapter layers)
// ---------------------------------------------------------------------------

/// One MCP server as the GUI sees it: the effective config merged across all
/// config layers, plus where the top definition lives.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
	name: String,
	/// Effective per-field merged config (highest-precedence layer wins).
	config: serde_json::Value,
	disabled: bool,
	/// Layer id of the highest-precedence file defining this server.
	source: String,
	/// Absolute path of that source file (display / reveal).
	source_path: String,
	/// True when the top layer is one the GUI writes to in place
	/// (pi-global ~/.pi/agent/mcp.json or shared-project .mcp.json).
	editable: bool,
	/// Inferred transport: "stdio" | "http" | "socket".
	transport: String,
}

/// One config layer, in adapter precedence order (low → high).
struct McpLayer {
	id: &'static str,
	path: PathBuf,
	/// Layers the GUI may edit/delete entries in directly.
	editable: bool,
}

fn mcp_layers(project: Option<&str>) -> Vec<McpLayer> {
	let home = dirs_home();
	let agent = pi_agent_dir().join("mcp.json");
	let mut layers: Vec<McpLayer> = Vec::new();
	let mut push = |id: &'static str, path: PathBuf, editable: bool| {
		// The adapter dedupes layers whose paths coincide (e.g. when the
		// agent dir IS ~/.config/mcp); mirror that to avoid double merges.
		if !layers.iter().any(|l: &McpLayer| l.path == path) {
			layers.push(McpLayer { id, path, editable });
		}
	};
	if let Some(home) = home.as_ref() {
		push(
			"shared-global",
			home.join(".config").join("mcp").join("mcp.json"),
			false,
		);
		push(
			"agents-global",
			home.join(".agents").join("mcp.json"),
			false,
		);
		push(
			"agents-nested-global",
			home.join(".agents").join("mcp").join("mcp.json"),
			false,
		);
	}
	push("pi-global", agent, true);
	if let Some(project) = project.filter(|p| !p.trim().is_empty()) {
		let root = PathBuf::from(project);
		push("shared-project", root.join(".mcp.json"), true);
		push("pi-project", root.join(".pi").join("mcp.json"), false);
	}
	layers
}

fn dirs_home() -> Option<PathBuf> {
	std::env::var_os("USERPROFILE")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

/// Serializes mcp.json read-modify-write updates (same rationale as
/// MODELS_MUTEX).
static MCP_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Reads one layer file's `mcpServers` map. Missing file → empty; malformed
/// file → error (never clobber a hand-edited file on write).
fn read_mcp_servers(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
	let Ok(raw) = fs::read_to_string(path) else {
		return Ok(serde_json::Map::new());
	};
	let value: serde_json::Value = serde_json::from_str(&raw)
		.map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
	let obj = value
		.as_object()
		.ok_or_else(|| format!("{} root must be an object", path.display()))?;
	// The adapter accepts both `mcpServers` and `mcp-servers`.
	let servers = obj.get("mcpServers").or_else(|| obj.get("mcp-servers"));
	match servers {
		Some(serde_json::Value::Object(map)) => Ok(map.clone()),
		Some(_) => Err(format!("{} 'mcpServers' must be an object", path.display())),
		None => Ok(serde_json::Map::new()),
	}
}

/// Read-modify-write one layer file, preserving unknown top-level keys
/// (settings, imports, ...).
fn update_mcp_file(
	path: &Path,
	f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>,
) -> Result<(), String> {
	let mut doc: serde_json::Map<String, serde_json::Value> = match fs::read_to_string(path) {
		Ok(raw) => {
			let value: serde_json::Value = serde_json::from_str(&raw)
				.map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
			value
				.as_object()
				.cloned()
				.ok_or_else(|| format!("{} root must be an object", path.display()))?
		}
		Err(_) => serde_json::Map::new(),
	};
	// Keep the key style the file already uses.
	let key = if doc.contains_key("mcp-servers") && !doc.contains_key("mcpServers") {
		"mcp-servers"
	} else {
		"mcpServers"
	};
	let servers = doc
		.entry(key.to_string())
		.or_insert_with(|| serde_json::json!({}));
	let map = servers
		.as_object_mut()
		.ok_or_else(|| format!("{} '{key}' must be an object", path.display()))?;
	f(map)?;
	if map.is_empty() {
		doc.remove(key);
	}
	if let Some(dir) = path.parent() {
		fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
	}
	let raw = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
	let tmp = path.with_extension("json.tmp");
	fs::write(&tmp, raw).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
	fs::rename(tmp, path).map_err(|e| format!("failed to persist {}: {e}", path.display()))
}

fn mcp_transport(config: &serde_json::Value) -> &'static str {
	let obj = config.as_object();
	if obj.is_some_and(|o| o.get("socket").and_then(|v| v.as_str()).is_some()) {
		"socket"
	} else if obj.is_some_and(|o| o.get("url").and_then(|v| v.as_str()).is_some()) {
		"http"
	} else {
		"stdio"
	}
}

/// Merges all layers (low → high precedence, per-field shallow merge like the
/// adapter) and returns the effective server list.
fn merged_mcp_servers(project: Option<&str>) -> Result<Vec<McpServerEntry>, String> {
	let mut merged: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
	// Track which layer last defined each server.
	let mut top: std::collections::HashMap<String, (&'static str, PathBuf, bool)> =
		std::collections::HashMap::new();
	for layer in mcp_layers(project) {
		let servers = read_mcp_servers(&layer.path)?;
		for (name, def) in servers {
			if !def.is_object() {
				continue;
			}
			let base = merged
				.get(&name)
				.and_then(|v| v.as_object())
				.cloned()
				.unwrap_or_default();
			let mut next = base;
			for (k, v) in def.as_object().unwrap() {
				next.insert(k.clone(), v.clone());
			}
			merged.insert(name.clone(), serde_json::Value::Object(next));
			top.insert(name, (layer.id, layer.path.clone(), layer.editable));
		}
	}
	let mut out: Vec<McpServerEntry> = merged
		.into_iter()
		.filter_map(|(name, config)| {
			let (source, path, editable) = top.get(&name)?;
			let disabled = config
				.get("disabled")
				.and_then(|v| v.as_bool())
				.unwrap_or(false);
			Some(McpServerEntry {
				transport: mcp_transport(&config).to_string(),
				disabled,
				source: source.to_string(),
				source_path: path.display().to_string(),
				editable: *editable,
				name,
				config,
			})
		})
		.collect();
	out.sort_by(|a, b| a.name.cmp(&b.name));
	Ok(out)
}

#[tauri::command]
pub fn pi_mcp_servers(project: Option<String>) -> Result<Vec<McpServerEntry>, String> {
	merged_mcp_servers(project.as_deref())
}

fn validate_mcp_server(name: &str, config: &serde_json::Value) -> Result<(), String> {
	if name.trim().is_empty() {
		return Err("server name must not be empty".into());
	}
	let obj = config
		.as_object()
		.ok_or("server config must be an object")?;
	let has_command = obj
		.get("command")
		.and_then(|v| v.as_str())
		.is_some_and(|s| !s.trim().is_empty());
	let has_url = obj
		.get("url")
		.and_then(|v| v.as_str())
		.is_some_and(|s| !s.trim().is_empty());
	let has_socket = obj
		.get("socket")
		.and_then(|v| v.as_str())
		.is_some_and(|s| !s.trim().is_empty());
	if !has_command && !has_url && !has_socket {
		return Err("server config requires a command, url or socket".into());
	}
	Ok(())
}

fn mcp_write_path(scope: &str, project: Option<&str>) -> Result<PathBuf, String> {
	match scope {
		"global" => Ok(pi_agent_dir().join("mcp.json")),
		"project" => {
			let raw = project
				.filter(|p| !p.trim().is_empty())
				.ok_or_else(|| "no project open; cannot write project scope".to_string())?;
			let dir = PathBuf::from(raw);
			// Containment guard: only ever drop `.mcp.json` inside a real,
			// existing directory. Without it the command was a "write a file
			// into any directory on disk" primitive for the webview, which is
			// a cheap thing to close and a nasty thing to leave open.
			if !dir.is_dir() {
				return Err(format!("not a directory: {raw}"));
			}
			let dir = std::fs::canonicalize(&dir)
				.map_err(|e| format!("cannot resolve project directory: {e}"))?;
			Ok(dir.join(".mcp.json"))
		}
		_ => Err(format!("unknown scope '{scope}'")),
	}
}

#[tauri::command]
pub fn pi_mcp_upsert_server(
	scope: String,
	project: Option<String>,
	name: String,
	config: serde_json::Value,
) -> Result<(), String> {
	let name = name.trim().to_string();
	validate_mcp_server(&name, &config)?;
	let path = mcp_write_path(&scope, project.as_deref())?;
	let _guard = MCP_MUTEX
		.lock()
		.map_err(|e| format!("mcp lock poisoned: {e}"))?;
	update_mcp_file(&path, |map| {
		map.insert(name, config);
		Ok(())
	})
}

#[tauri::command]
pub fn pi_mcp_remove_server(
	scope: String,
	project: Option<String>,
	name: String,
) -> Result<(), String> {
	let path = mcp_write_path(&scope, project.as_deref())?;
	let _guard = MCP_MUTEX
		.lock()
		.map_err(|e| format!("mcp lock poisoned: {e}"))?;
	update_mcp_file(&path, |map| {
		map.remove(&name);
		Ok(())
	})
}

/// Enables/disables a server. Writes the `disabled` flag into the server's
/// top layer when the GUI owns it (pi-global / shared-project / pi-project);
/// for read-only shared layers it writes an override flag into the highest
/// writable layer (project .pi/mcp.json when a project is open, else the Pi
/// global file) — mirroring the adapter's `/mcp enable|disable` semantics
/// without ever rewriting shared source files.
#[tauri::command]
pub fn pi_mcp_set_disabled(
	name: String,
	disabled: bool,
	project: Option<String>,
) -> Result<(), String> {
	let _guard = MCP_MUTEX
		.lock()
		.map_err(|e| format!("mcp lock poisoned: {e}"))?;
	let layers = mcp_layers(project.as_deref());
	// Merge per layer so we know the top layer and the disabled state below it.
	let mut merged: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
	let mut top_index: Option<usize> = None;
	let mut disabled_below: Vec<bool> = Vec::new();
	for (i, layer) in layers.iter().enumerate() {
		let servers = read_mcp_servers(&layer.path)?;
		if let Some(def) = servers.get(&name).filter(|d| d.is_object()) {
			for (k, v) in def.as_object().unwrap() {
				merged.insert(k.clone(), v.clone());
			}
			top_index = Some(i);
		}
		disabled_below.push(
			merged
				.get("disabled")
				.and_then(|v| v.as_bool())
				.unwrap_or(false),
		);
	}
	let Some(top_index) = top_index else {
		return Err(format!("MCP server '{name}' not found"));
	};
	let top_layer = &layers[top_index];
	// Where the flag lands: in place for layers we own; otherwise an override
	// in the highest writable layer. lower_disabled is the merged disabled
	// state below the target file (an explicit `false` is needed to re-enable
	// when a lower layer disables the server — adapter semantics).
	let disabled_below_index = |i: usize| -> bool {
		if i == 0 {
			false
		} else {
			disabled_below[i - 1]
		}
	};
	let (target_path, lower_disabled) = if top_layer.editable || top_layer.id == "pi-project" {
		(top_layer.path.clone(), disabled_below_index(top_index))
	} else if let Some(pos) = layers.iter().position(|l| l.id == "pi-project") {
		(layers[pos].path.clone(), disabled_below_index(pos))
	} else {
		let pos = layers
			.iter()
			.position(|l| l.id == "pi-global")
			.expect("pi-global layer always exists");
		(layers[pos].path.clone(), disabled_below_index(pos))
	};
	update_mcp_file(&target_path, |map| {
		if disabled {
			let entry = map
				.entry(name.clone())
				.or_insert_with(|| serde_json::json!({}));
			let obj = entry
				.as_object_mut()
				.ok_or("server entry must be an object")?;
			obj.insert("disabled".to_string(), serde_json::Value::Bool(true));
		} else {
			let remove_entry = match map.get_mut(&name).and_then(|e| e.as_object_mut()) {
				Some(obj) => {
					if lower_disabled {
						// A lower layer disables it; an explicit false is needed to
						// re-enable (adapter semantics).
						obj.insert("disabled".to_string(), serde_json::Value::Bool(false));
						false
					} else {
						obj.remove("disabled");
						obj.is_empty()
					}
				}
				None => {
					if lower_disabled {
						map.insert(name.clone(), serde_json::json!({ "disabled": false }));
					}
					false
				}
			};
			if remove_entry {
				map.remove(&name);
			}
		}
		Ok(())
	})
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
	let mut cmd = Command::new("git");
	cmd.arg("-C").arg(project).args(args);
	// Git is a console-subsystem binary: without CREATE_NO_WINDOW every
	// branch probe from the borderless GUI pops a flashing cmd window.
	let out = crate::pi::no_console_window(&mut cmd)
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
	let is_repository = work_tree
		.as_deref()
		.map(|s| s.trim() == "true")
		.unwrap_or(false);
	if !is_repository {
		return Ok(GitBranchState {
			is_repository: false,
			branches: vec![],
			current_branch: None,
			dirty_file_count: 0,
		});
	}
	let branches = run_git(
		project,
		&["for-each-ref", "--format=%(refname:short)", "refs/heads"],
	)
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
	Ok(GitBranchState {
		is_repository: true,
		branches,
		current_branch,
		dirty_file_count,
	})
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
pub async fn git_checkout_branch(
	project: String,
	branch: String,
) -> Result<GitBranchState, String> {
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
// Pi packages (extensions / skills / prompts / themes) via the SDK sidecar
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

/// Map one `ConfiguredPackage` from the sidecar's `package.list` onto the
/// entry shape the frontend already consumes. The CLI printed filtered
/// packages as `<source> (filtered)` and the old text parser kept that suffix
/// in `source` — preserve it so the UI renders exactly what it used to.
fn configured_package_entry(v: &serde_json::Value) -> PiPackageEntry {
	let raw_source = v.get("source").and_then(|s| s.as_str()).unwrap_or_default();
	let filtered = v.get("filtered").and_then(|f| f.as_bool()).unwrap_or(false);
	let source = if filtered {
		format!("{raw_source} (filtered)")
	} else {
		raw_source.to_string()
	};
	PiPackageEntry {
		package_name: package_name_from_source(&source),
		source,
		scope: v
			.get("scope")
			.and_then(|s| s.as_str())
			.unwrap_or("user")
			.to_string(),
		installed_path: v
			.get("installedPath")
			.and_then(|s| s.as_str())
			.map(str::to_string),
	}
}

/// The pi CLI resolved package scope against its working directory, which a
/// GUI-spawned child simply inherited; keep that by passing our own cwd.
fn package_cwd() -> Result<PathBuf, String> {
	std::env::current_dir().map_err(|e| format!("failed to resolve cwd: {e}"))
}

/// Runs a blocking closure on the dedicated blocking thread pool so the UI
/// thread is never frozen while the sidecar round-trip is in flight.
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
	let result = run_blocking(|| {
		let cwd = package_cwd()?;
		crate::sidecar::package_list(&cwd)
	})
	.await?;
	let list = result
		.as_array()
		.ok_or_else(|| "unexpected sidecar package.list result".to_string())?;
	Ok(list.iter().map(configured_package_entry).collect())
}

#[tauri::command]
pub async fn pi_package_install(source: String) -> Result<(), String> {
	let source = source.trim().to_string();
	if source.is_empty() {
		return Err("package source must not be empty".into());
	}
	run_blocking(move || {
		let cwd = package_cwd()?;
		crate::sidecar::package_install(&cwd, &source, false)?;
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
		let cwd = package_cwd()?;
		// The CLI errored ("No matching package found") when removeAndPersist
		// returned false; keep that contract for the frontend.
		if !crate::sidecar::package_remove(&cwd, &source, false)? {
			return Err(format!("No matching package found for {source}"));
		}
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
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		let Ok(ft) = entry.file_type() else { continue };
		if ft.is_dir() {
			if path.join("SKILL.md").is_file() {
				let name = entry.file_name().to_string_lossy().into_owned();
				let description = fs::read_to_string(path.join("SKILL.md"))
					.ok()
					.and_then(|text| {
						text.lines()
							.find(|l| l.starts_with("description:"))
							.map(|l| {
								l.trim_start_matches("description:")
									.trim()
									.trim_matches('"')
									.to_string()
							})
					})
					.filter(|d| !d.is_empty());
				out.push(PiSkillEntry {
					name,
					description,
					location: location.to_string(),
				});
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
pub async fn pi_installed_skills(
	packages: Vec<PiPackageEntry>,
) -> Result<Vec<PiSkillEntry>, String> {
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
	let canonical =
		fs::canonicalize(&new_project).map_err(|e| format!("invalid target directory: {e}"))?;
	// Rewriting a large session file (with big base64 image lines) takes a
	// moment; keep it off the UI thread. Lines are streamed with a size cap:
	// oversized lines are copied through verbatim so memory stays bounded
	// and the file is never corrupted.
	run_blocking(move || {
		let file = fs::File::open(&path).map_err(|e| format!("failed to read session: {e}"))?;
		let mut reader = BufReader::new(file);
		let tmp = path.with_extension(format!("jsonl.{}.tmp", pi::unique_suffix()));
		let mut writer = BufWriter::new(
			fs::File::create(&tmp).map_err(|e| format!("failed to write session: {e}"))?,
		);
		let mut changed = false;
		let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
		loop {
			buf.clear();
			let mut limited = (&mut reader).take((pi::MAX_JSONL_LINE + 1) as u64);
			let n = limited
				.read_until(b'\n', &mut buf)
				.map_err(|e| format!("failed to read session: {e}"))?;
			if n == 0 {
				break;
			}
			if n > pi::MAX_JSONL_LINE {
				// Oversized line: keep it byte-for-byte, then drain the rest
				// of the line.
				writer
					.write_all(&buf)
					.map_err(|e| format!("failed to write session: {e}"))?;
				loop {
					buf.clear();
					let mut sink = (&mut reader).take(64 * 1024);
					let m = sink
						.read_until(b'\n', &mut buf)
						.map_err(|e| format!("failed to read session: {e}"))?;
					if m == 0 || buf.last() == Some(&b'\n') {
						break;
					}
				}
				continue;
			}
			let mut line = buf.as_slice();
			if line.last() == Some(&b'\n') {
				line = &line[..line.len() - 1];
			}
			if line.last() == Some(&b'\r') {
				line = &line[..line.len() - 1];
			}
			match serde_json::from_slice::<serde_json::Value>(line) {
				Ok(mut v) => {
					if v.get("type").and_then(|x| x.as_str()) == Some("session") {
						v["cwd"] =
							serde_json::Value::String(canonical.to_string_lossy().into_owned());
						changed = true;
					}
					writer
						.write_all(
							serde_json::to_string(&v)
								.map_err(|e| format!("failed to serialize session: {e}"))?
								.as_bytes(),
						)
						.map_err(|e| format!("failed to write session: {e}"))?;
					writer
						.write_all(b"\n")
						.map_err(|e| format!("failed to write session: {e}"))?;
				}
				Err(_) => {
					writer
						.write_all(&buf)
						.map_err(|e| format!("failed to write session: {e}"))?;
				}
			}
		}
		if !changed {
			return Err("session header not found in file".into());
		}
		writer
			.flush()
			.map_err(|e| format!("failed to write session: {e}"))?;
		fs::rename(tmp, path).map_err(|e| format!("failed to persist session: {e}"))?;
		Ok(())
	})
	.await
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn catalog_ids_from_manifest_and_fallback() {
		let dir = std::env::temp_dir().join(format!("pi-gui-catalog-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		// Manifest path: ids come from the `files` map (no .json suffix).
		std::fs::write(
			dir.join(".manifest.json"),
			r#"{"files":{"anthropic.json":"a","deepseek.json":"b"}}"#,
		)
		.unwrap();
		let ids = read_catalog_provider_ids(&dir);
		assert_eq!(ids, vec!["anthropic", "deepseek"]);
		// Without a manifest, any *.json file counts (manifest itself excluded).
		std::fs::remove_file(dir.join(".manifest.json")).unwrap();
		std::fs::write(dir.join("ollama.json"), "{}").unwrap();
		let ids = read_catalog_provider_ids(&dir);
		assert_eq!(ids, vec!["ollama"]);
		std::fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn providers_merge_catalog_custom_and_auth() {
		let _guard = crate::pi::ENV_GUARD.lock().unwrap();
		let old_agent_dir = std::env::var_os("PI_AGENT_DIR");
		let dir =
			std::env::temp_dir().join(format!("pi-gui-providers-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_AGENT_DIR", &dir);
		std::fs::write(
			dir.join("models.json"),
			r#"{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","models":[{"id":"llama3.1:8b"}]}}}"#,
		)
		.unwrap();
		let _ = pi_auth_set_key("anthropic".into(), "sk-ant-test".into());

		let providers = pi_providers().unwrap();
		let by_id: std::collections::HashMap<&str, bool> =
			providers.iter().map(|p| (p.id.as_str(), p.known)).collect();
		// Custom provider from models.json is present and marked unknown.
		assert_eq!(by_id.get("ollama"), Some(&false));
		// The built-in catalog exists only when the vendored runtime is
		// installed (CI's cargo test runs without it); count first, then
		// expect the stored credential to read as known exactly when the
		// catalog is present.
		let known = providers.iter().filter(|p| p.known).count();
		assert!(known == 0 || known >= 30, "unexpected known count: {known}");
		// Stored credential is present even without a catalog entry.
		assert_eq!(by_id.get("anthropic"), Some(&(known > 0)));

		std::fs::remove_dir_all(&dir).ok();
		match old_agent_dir {
			Some(v) => std::env::set_var("PI_AGENT_DIR", v),
			None => std::env::remove_var("PI_AGENT_DIR"),
		}
	}

	#[test]
	fn custom_providers_upsert_merge_remove() {
		let _guard = crate::pi::ENV_GUARD.lock().unwrap();
		let old_agent_dir = std::env::var_os("PI_AGENT_DIR");
		let dir = std::env::temp_dir().join(format!("pi-gui-models-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_AGENT_DIR", &dir);

		// Pre-existing content that must survive untouched (here: a provider
		// entry without a models array, e.g. a proxy override).
		std::fs::write(
			dir.join("models.json"),
			r#"{"providers":{"proxy-note":{"baseUrl":"https://proxy.example.com"}}}"#,
		)
		.unwrap();

		// Upsert a new provider.
		pi_upsert_custom_provider(
			"volcengine".into(),
			serde_json::json!({
				"baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
				"api": "openai-completions",
				"models": [{"id": "doubao-seed-1-6-250615", "contextWindow": 256000}]
			}),
		)
		.unwrap();
		let list = pi_custom_providers().unwrap();
		assert_eq!(list.len(), 2);
		assert!(list.iter().any(|p| p.id == "volcengine"));

		// Update replaces the entry; the other entry survives.
		pi_upsert_custom_provider(
			"volcengine".into(),
			serde_json::json!({
				"baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
				"api": "openai-completions",
				"models": [{"id": "deepseek-v3-1-250821"}]
			}),
		)
		.unwrap();
		let list = pi_custom_providers().unwrap();
		assert_eq!(list.len(), 2);
		let v = list.iter().find(|p| p.id == "volcengine").unwrap();
		assert_eq!(v.config["models"][0]["id"], "deepseek-v3-1-250821");
		let other = list.iter().find(|p| p.id == "proxy-note").unwrap();
		assert_eq!(other.config["baseUrl"], "https://proxy.example.com");

		// Remove only the target entry.
		pi_remove_custom_provider("volcengine".into()).unwrap();
		let list = pi_custom_providers().unwrap();
		assert_eq!(list.len(), 1);
		assert_eq!(list[0].id, "proxy-note");

		std::fs::remove_dir_all(&dir).ok();
		match old_agent_dir {
			Some(v) => std::env::set_var("PI_AGENT_DIR", v),
			None => std::env::remove_var("PI_AGENT_DIR"),
		}
	}

	#[test]
	fn custom_provider_validation_errors() {
		let _guard = crate::pi::ENV_GUARD.lock().unwrap();
		let old_agent_dir = std::env::var_os("PI_AGENT_DIR");
		let dir =
			std::env::temp_dir().join(format!("pi-gui-models-validation-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_AGENT_DIR", &dir);

		let good = || {
			serde_json::json!({
				"baseUrl": "http://localhost:8000/v1",
				"api": "openai-completions",
				"models": [{"id": "m1"}]
			})
		};

		// Bad ids.
		assert!(pi_upsert_custom_provider("".into(), good()).is_err());
		assert!(pi_upsert_custom_provider("Volcengine".into(), good()).is_err());
		assert!(pi_upsert_custom_provider("-lead".into(), good()).is_err());
		assert!(pi_upsert_custom_provider("has space".into(), good()).is_err());

		// Missing baseUrl / models / model id.
		assert!(pi_upsert_custom_provider(
			"ok-id".into(),
			serde_json::json!({"api": "openai-completions", "models": [{"id": "m"}]})
		)
		.is_err());
		assert!(pi_upsert_custom_provider(
			"ok-id".into(),
			serde_json::json!({"baseUrl": "http://x", "models": []})
		)
		.is_err());
		assert!(pi_upsert_custom_provider(
			"ok-id".into(),
			serde_json::json!({"baseUrl": "http://x", "models": [{"name": "no id"}]})
		)
		.is_err());

		// A valid upsert works.
		pi_upsert_custom_provider("ok-id".into(), good()).unwrap();
		let list = pi_custom_providers().unwrap();
		assert_eq!(list.len(), 1);
		assert_eq!(list[0].id, "ok-id");

		// Malformed models.json: read and write both refuse, nothing clobbered.
		std::fs::write(dir.join("models.json"), "{not json").unwrap();
		assert!(pi_custom_providers().is_err());
		assert!(pi_upsert_custom_provider("ok-id".into(), good()).is_err());
		assert_eq!(
			std::fs::read_to_string(dir.join("models.json")).unwrap(),
			"{not json"
		);

		std::fs::remove_dir_all(&dir).ok();
		match old_agent_dir {
			Some(v) => std::env::set_var("PI_AGENT_DIR", v),
			None => std::env::remove_var("PI_AGENT_DIR"),
		}
	}

	#[test]
	fn maps_configured_packages_to_entries() {
		let entries: Vec<PiPackageEntry> = [
			serde_json::json!({
				"source": "npm:@foo/bar",
				"scope": "user",
				"filtered": true,
				"installedPath": "/home/user/.pi/agent/npm/@foo/bar",
			}),
			serde_json::json!({
				"source": "npm:plain",
				"scope": "user",
				"filtered": false,
			}),
			serde_json::json!({
				"source": "npm:proj-pkg",
				"scope": "project",
				"filtered": false,
			}),
		]
		.iter()
		.map(configured_package_entry)
		.collect();
		assert_eq!(entries.len(), 3);
		assert_eq!(entries[0].source, "npm:@foo/bar (filtered)");
		assert_eq!(entries[0].package_name.as_deref(), Some("@foo/bar"));
		assert!(entries[0].installed_path.is_some());
		assert_eq!(entries[1].package_name.as_deref(), Some("plain"));
		assert_eq!(entries[2].scope, "project");
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
		// Env is process-global and cargo runs tests in parallel — hold the
		// shared guard for the whole env-mutating section.
		let _guard = crate::pi::ENV_GUARD.lock().unwrap();
		let old_agent_dir = std::env::var_os("PI_AGENT_DIR");
		// Point the agent dir at a temp folder so the real auth.json is untouched.
		let dir = std::env::temp_dir().join(format!("pi-gui-auth-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		std::env::set_var("PI_AGENT_DIR", &dir);

		let _ = pi_auth_set_key("anthropic".into(), "sk-ant-test".into());
		let _ = pi_auth_set_key("openai".into(), "sk-openai-test".into());
		let statuses = pi_auth_status().unwrap();
		assert_eq!(statuses.len(), 2);
		assert!(statuses
			.iter()
			.any(|s| s.provider == "anthropic" && s.has_key));
		assert!(statuses.iter().any(|s| s.provider == "openai" && s.has_key));

		let _ = pi_auth_remove("anthropic".into());
		let statuses = pi_auth_status().unwrap();
		assert_eq!(statuses.len(), 1);
		assert_eq!(statuses[0].provider, "openai");

		std::fs::remove_dir_all(&dir).ok();
		// Restore the caller's environment (best effort).
		match old_agent_dir {
			Some(v) => std::env::set_var("PI_AGENT_DIR", v),
			None => std::env::remove_var("PI_AGENT_DIR"),
		}
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
		assert!(out
			.iter()
			.any(|s| s.name == "my-skill" && s.description.as_deref() == Some("A test skill")));
		assert!(out.iter().any(|s| s.name == "notes.md"));

		std::fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn git_state_in_non_repository() {
		let dir = std::env::temp_dir().join(format!("pi-gui-git-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let state =
			tauri::async_runtime::block_on(git_branch_state(dir.to_string_lossy().into_owned()))
				.unwrap();
		assert!(!state.is_repository);
		assert!(state.branches.is_empty());
		std::fs::remove_dir_all(&dir).ok();
	}

	/// Points PI_AGENT_DIR at a fresh temp dir; restores the old value on drop.
	/// Guards with ENV_GUARD because the agent dir is process-global env.
	struct AgentDirGuard {
		old: Option<std::ffi::OsString>,
		dir: PathBuf,
		_guard: std::sync::MutexGuard<'static, ()>,
	}

	impl AgentDirGuard {
		fn new(tag: &str) -> Self {
			let guard = crate::pi::ENV_GUARD.lock().unwrap();
			let old = std::env::var_os("PI_AGENT_DIR");
			let dir = std::env::temp_dir().join(format!("pi-gui-mcp-{tag}-{}", std::process::id()));
			std::fs::create_dir_all(&dir).unwrap();
			std::env::set_var("PI_AGENT_DIR", &dir);
			AgentDirGuard {
				old,
				dir,
				_guard: guard,
			}
		}
	}

	impl Drop for AgentDirGuard {
		fn drop(&mut self) {
			match &self.old {
				Some(v) => std::env::set_var("PI_AGENT_DIR", v),
				None => std::env::remove_var("PI_AGENT_DIR"),
			}
			std::fs::remove_dir_all(&self.dir).ok();
		}
	}

	#[test]
	fn mcp_servers_merge_layers_by_precedence() {
		let agent = AgentDirGuard::new("merge");
		// Global (pi-global) definition.
		std::fs::write(
			agent.dir.join("mcp.json"),
			r#"{"mcpServers":{"gui-test-srv":{"command":"npx","args":["-y","srv"],"env":{"A":"1"}}}}"#,
		)
		.unwrap();
		// Project layers override per-field and add the disabled flag.
		let project = agent.dir.join("proj");
		std::fs::create_dir_all(project.join(".pi")).unwrap();
		std::fs::write(
			project.join(".mcp.json"),
			r#"{"mcpServers":{"gui-test-srv":{"args":["-y","srv2"]}}}"#,
		)
		.unwrap();
		std::fs::write(
			project.join(".pi").join("mcp.json"),
			r#"{"mcpServers":{"gui-test-srv":{"disabled":true}}}"#,
		)
		.unwrap();

		let servers = merged_mcp_servers(Some(project.to_str().unwrap())).unwrap();
		let entry = servers
			.iter()
			.find(|s| s.name == "gui-test-srv")
			.expect("server from temp layers");
		// Per-field merge: args from the project layer, command/env from global.
		assert_eq!(entry.config["args"], serde_json::json!(["-y", "srv2"]));
		assert_eq!(entry.config["command"], serde_json::json!("npx"));
		assert_eq!(entry.config["env"], serde_json::json!({"A": "1"}));
		assert!(entry.disabled);
		assert_eq!(entry.source, "pi-project");
		assert!(!entry.editable);
		assert_eq!(entry.transport, "stdio");

		// Without a project only the global layer applies.
		let servers = merged_mcp_servers(None).unwrap();
		let entry = servers.iter().find(|s| s.name == "gui-test-srv").unwrap();
		assert_eq!(entry.config["args"], serde_json::json!(["-y", "srv"]));
		assert!(!entry.disabled);
		assert_eq!(entry.source, "pi-global");
		assert!(entry.editable);
	}

	#[test]
	fn mcp_set_disabled_toggles_flag_in_place() {
		let agent = AgentDirGuard::new("toggle");
		std::fs::write(
			agent.dir.join("mcp.json"),
			r#"{"mcpServers":{"gui-test-toggle":{"command":"npx"}}}"#,
		)
		.unwrap();

		pi_mcp_set_disabled("gui-test-toggle".into(), true, None).unwrap();
		let raw: serde_json::Value =
			serde_json::from_str(&std::fs::read_to_string(agent.dir.join("mcp.json")).unwrap())
				.unwrap();
		assert_eq!(
			raw["mcpServers"]["gui-test-toggle"]["disabled"],
			serde_json::json!(true)
		);
		// The command key survived the flag write.
		assert_eq!(
			raw["mcpServers"]["gui-test-toggle"]["command"],
			serde_json::json!("npx")
		);

		pi_mcp_set_disabled("gui-test-toggle".into(), false, None).unwrap();
		let raw: serde_json::Value =
			serde_json::from_str(&std::fs::read_to_string(agent.dir.join("mcp.json")).unwrap())
				.unwrap();
		assert!(raw["mcpServers"]["gui-test-toggle"]
			.get("disabled")
			.is_none());
		assert_eq!(
			raw["mcpServers"]["gui-test-toggle"]["command"],
			serde_json::json!("npx")
		);

		// Unknown server is an error, not a silently created file.
		assert!(pi_mcp_set_disabled("gui-test-missing".into(), true, None).is_err());
	}

	#[test]
	fn mcp_upsert_and_remove_project_scope() {
		let agent = AgentDirGuard::new("project");
		let project = agent.dir.join("proj");
		std::fs::create_dir_all(&project).unwrap();
		let project = project.to_string_lossy().into_owned();

		pi_mcp_upsert_server(
			"project".into(),
			Some(project.clone()),
			"gui-test-http".into(),
			serde_json::json!({"url": "https://example.com/mcp", "headers": {"X": "y"}}),
		)
		.unwrap();
		let servers = merged_mcp_servers(Some(&project)).unwrap();
		let entry = servers.iter().find(|s| s.name == "gui-test-http").unwrap();
		assert_eq!(entry.transport, "http");
		assert_eq!(entry.source, "shared-project");
		assert!(entry.editable);

		pi_mcp_remove_server(
			"project".into(),
			Some(project.clone()),
			"gui-test-http".into(),
		)
		.unwrap();
		assert!(!merged_mcp_servers(Some(&project))
			.unwrap()
			.iter()
			.any(|s| s.name == "gui-test-http"));

		// A config without command/url/socket is rejected.
		assert!(pi_mcp_upsert_server(
			"global".into(),
			None,
			"gui-test-bad".into(),
			serde_json::json!({"args": []}),
		)
		.is_err());
	}

	#[test]
	fn catalog_model_entries_flatten_api_groups() {
		let sample = serde_json::json!({
			"openai-completions": {
				"m-text": {
					"id": "m-text", "name": "Text Model", "reasoning": false,
					"input": ["text"], "contextWindow": 128000, "maxTokens": 4096
				}
			},
			"openai-responses": {
				"m-vision": {
					"id": "m-vision", "name": "Vision Model", "reasoning": true,
					"input": ["text", "image"], "contextWindow": 200000, "maxTokens": 8192
				}
			}
		});
		let entries = catalog_model_entries(&sample);
		assert_eq!(entries.len(), 2);
		let text = entries.iter().find(|e| e.id == "m-text").unwrap();
		assert_eq!(text.name, "Text Model");
		assert!(!text.reasoning && !text.image);
		assert_eq!(text.context_window, 128000);
		assert_eq!(text.max_tokens, 4096);
		assert!(!text.custom && !text.overridden);
		let vision = entries.iter().find(|e| e.id == "m-vision").unwrap();
		assert!(vision.reasoning && vision.image);
		assert_eq!(vision.context_window, 200000);
		assert_eq!(vision.max_tokens, 8192);
		// Entries without an id are skipped, non-object groups are tolerated.
		let weird = serde_json::json!({"api": {"no-id": {"name": "x"}}, "junk": 42});
		assert!(catalog_model_entries(&weird).is_empty());
	}

	#[test]
	fn provider_models_merge_custom_and_overrides() {
		let catalog = serde_json::json!({
			"some-api": {
				"catalog-m": {
					"id": "catalog-m", "name": "Catalog Model", "reasoning": false,
					"input": ["text"], "contextWindow": 128000, "maxTokens": 4096
				}
			}
		});
		let mut entries = catalog_model_entries(&catalog);
		let overlay = serde_json::json!({
			"apiKey": "sk-ignored-by-merge",
			"models": [
				{"id": "catalog-m", "name": "Renamed", "contextWindow": 64000, "maxTokens": 2048},
				{"id": "user-m", "input": ["text", "image"], "contextWindow": 32000, "maxTokens": 1000}
			],
			"modelOverrides": {
				"catalog-m": {"reasoning": true, "contextWindow": 999},
				"ghost": {"name": "no such model"}
			}
		});
		apply_models_json(&mut entries, Some(&overlay));
		assert_eq!(entries.len(), 2);
		// Same-id custom model replaces the display values and is marked
		// custom; the override then patches on top of that.
		let cm = entries.iter().find(|e| e.id == "catalog-m").unwrap();
		assert!(cm.custom && cm.overridden);
		assert_eq!(cm.name, "Renamed");
		assert!(cm.reasoning);
		assert_eq!(cm.context_window, 999);
		assert_eq!(cm.max_tokens, 2048);
		// New id appended from models.json.
		let um = entries.iter().find(|e| e.id == "user-m").unwrap();
		assert!(um.custom && !um.overridden);
		assert!(um.image);
		assert_eq!(um.name, "user-m");
		// Override for an unknown id is ignored.
		assert!(!entries.iter().any(|e| e.id == "ghost"));
	}

	#[test]
	fn provider_model_edit_roundtrip() {
		let agent = AgentDirGuard::new("model-edit");
		// Unknown entry fields that must survive every edit untouched.
		std::fs::write(
			agent.dir.join("models.json"),
			r#"{"providers":{"anthropic":{"apiKey":"sk-x","baseUrl":"https://proxy","compat":{"a":1}}}}"#,
		)
		.unwrap();

		// Validation: bad provider id, missing model id, non-positive limits.
		assert!(
			pi_provider_model_upsert("Bad Id".into(), serde_json::json!({"id": "m"}),).is_err()
		);
		assert!(
			pi_provider_model_upsert("anthropic".into(), serde_json::json!({"name": "no id"}),)
				.is_err()
		);
		assert!(pi_provider_model_upsert(
			"anthropic".into(),
			serde_json::json!({"id": "m", "contextWindow": 0}),
		)
		.is_err());

		// Upsert creates the models array; the other entry keys survive.
		pi_provider_model_upsert(
			"anthropic".into(),
			serde_json::json!({"id": "my-model", "contextWindow": 100000, "maxTokens": 4000}),
		)
		.unwrap();
		let doc = read_models_doc().unwrap();
		let entry = &doc["providers"]["anthropic"];
		assert_eq!(entry["apiKey"], "sk-x");
		assert_eq!(entry["baseUrl"], "https://proxy");
		assert_eq!(entry["compat"], serde_json::json!({"a": 1}));
		assert_eq!(entry["models"][0]["id"], "my-model");

		// Same id replaces in place, array stays length 1.
		pi_provider_model_upsert(
			"anthropic".into(),
			serde_json::json!({"id": "my-model", "contextWindow": 200000, "maxTokens": 8000}),
		)
		.unwrap();
		let doc = read_models_doc().unwrap();
		let models = doc["providers"]["anthropic"]["models"].as_array().unwrap();
		assert_eq!(models.len(), 1);
		assert_eq!(models[0]["contextWindow"], 200000);

		// Override upsert adds modelOverrides without touching models.
		pi_provider_model_override_upsert(
			"anthropic".into(),
			"my-model".into(),
			serde_json::json!({"reasoning": true}),
		)
		.unwrap();
		let doc = read_models_doc().unwrap();
		let entry = &doc["providers"]["anthropic"];
		assert_eq!(entry["modelOverrides"]["my-model"]["reasoning"], true);
		assert_eq!(entry["models"].as_array().unwrap().len(), 1);

		// Empty patch object is a remove; the emptied modelOverrides key goes too.
		pi_provider_model_override_upsert(
			"anthropic".into(),
			"my-model".into(),
			serde_json::json!({}),
		)
		.unwrap();
		let doc = read_models_doc().unwrap();
		assert!(doc["providers"]["anthropic"]
			.get("modelOverrides")
			.is_none());
		assert_eq!(doc["providers"]["anthropic"]["apiKey"], "sk-x");

		// Removing the last model drops the models key; the entry stays
		// because apiKey/baseUrl/compat remain.
		pi_provider_model_remove("anthropic".into(), "my-model".into()).unwrap();
		let doc = read_models_doc().unwrap();
		let entry = &doc["providers"]["anthropic"];
		assert!(entry.get("models").is_none());
		assert_eq!(entry["apiKey"], "sk-x");

		// An entry holding only that model is removed entirely.
		pi_provider_model_upsert("fresh".into(), serde_json::json!({"id": "m1"})).unwrap();
		pi_provider_model_remove("fresh".into(), "m1".into()).unwrap();
		let doc = read_models_doc().unwrap();
		assert!(doc["providers"].get("fresh").is_none());

		// Same cleanup for an override-only entry.
		pi_provider_model_override_upsert(
			"solo".into(),
			"m".into(),
			serde_json::json!({"name": "X"}),
		)
		.unwrap();
		pi_provider_model_override_remove("solo".into(), "m".into()).unwrap();
		let doc = read_models_doc().unwrap();
		assert!(doc["providers"].get("solo").is_none());
		// The untouched provider from the start is still intact.
		assert_eq!(doc["providers"]["anthropic"]["apiKey"], "sk-x");
	}

	#[test]
	fn provider_models_from_models_json_only() {
		let agent = AgentDirGuard::new("models-list");
		std::fs::write(
			agent.dir.join("models.json"),
			r#"{"providers":{"zzz-no-catalog":{"baseUrl":"http://x","models":[{"id":"only-m","input":["text","image"],"contextWindow":64000,"maxTokens":2048}]}}}"#,
		)
		.unwrap();
		// Custom provider: only its models.json entries come back, all custom.
		let models = pi_provider_models("zzz-no-catalog".into()).unwrap();
		assert_eq!(models.len(), 1);
		assert_eq!(models[0].id, "only-m");
		assert!(models[0].custom && models[0].image);
		assert_eq!(models[0].context_window, 64000);
		// Unknown provider yields an empty list, not an error.
		assert!(pi_provider_models("no-such-provider".into())
			.unwrap()
			.is_empty());
		assert!(pi_provider_models("Bad Id".into()).is_err());
	}

	#[test]
	fn custom_provider_validation_builtin_overlay() {
		let agent = AgentDirGuard::new("validate-overlay");
		let _ = &agent;

		// Empty entry and custom id without baseUrl are rejected either way.
		assert!(pi_upsert_custom_provider("whatever".into(), serde_json::json!({})).is_err());
		assert!(pi_upsert_custom_provider(
			"my-custom".into(),
			serde_json::json!({"models": [{"id": "m"}]}),
		)
		.is_err());

		// Built-in ids now pass as partial overlays (only checkable when the
		// vendored runtime with its catalog is installed).
		if pi_ai_providers_data_dir().is_some() {
			pi_upsert_custom_provider(
				"anthropic".into(),
				serde_json::json!({"models": [{"id": "claude-x"}]}),
			)
			.unwrap();
			pi_upsert_custom_provider(
				"anthropic".into(),
				serde_json::json!({"modelOverrides": {"claude-x": {"reasoning": true}}}),
			)
			.unwrap();
			// Still rejected: empty entry, models with missing ids.
			assert!(pi_upsert_custom_provider("anthropic".into(), serde_json::json!({})).is_err());
			assert!(pi_upsert_custom_provider(
				"anthropic".into(),
				serde_json::json!({"models": [{"name": "no id"}]}),
			)
			.is_err());
		}
	}
}
