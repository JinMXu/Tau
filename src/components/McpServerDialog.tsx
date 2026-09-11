import { useEffect, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { piMcpRemoveServer, piMcpUpsertServer, type McpServerEntry } from "../pi";
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon } from "../icons";
import { ScopeSelect } from "./ScopeSelect";
import { Modal } from "./Modal";

type McpTransport = "stdio" | "http";
type DialogMode = "form" | "json";

interface McpServerForm {
	name: string;
	/** "" = user (global) scope; otherwise a project path. */
	scope: string;
	transport: McpTransport;
	command: string;
	/** Space-separated args. */
	argsText: string;
	cwd: string;
	/** KEY=VALUE per line. */
	envText: string;
	url: string;
	/** KEY=VALUE per line. */
	headersText: string;
	/** Optional requestTimeoutMs (empty = adapter default). */
	timeout: string;
}

type FormError =
	"nameRequired" | "nameExists" | "commandRequired" | "urlRequired" | "urlInvalid" | "envFormat";

const BLANK_FORM: McpServerForm = {
	name: "",
	scope: "",
	transport: "stdio",
	command: "",
	argsText: "",
	cwd: "",
	envText: "",
	url: "",
	headersText: "",
	timeout: "",
};

function parseArgs(text: string): string[] {
	return text.split(/\s+/).filter((a) => a.length > 0);
}

/** Parses KEY=VALUE lines; returns null when any line is malformed. */
function linesToRecord(text: string): Record<string, string> | null {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) return null;
		out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

function recordToLines(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	return Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => typeof v === "string")
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
}

function formFromEntry(entry: McpServerEntry, scopeProject: string | null): McpServerForm {
	const c = entry.config;
	const args = Array.isArray(c.args)
		? c.args.filter((a): a is string => typeof a === "string").join(" ")
		: "";
	const timeout =
		typeof c.requestTimeoutMs === "number" && c.requestTimeoutMs > 0
			? String(c.requestTimeoutMs)
			: "";
	return {
		name: entry.name,
		scope: entry.source === "shared-project" ? (scopeProject ?? "") : "",
		transport: entry.transport === "http" ? "http" : "stdio",
		command: typeof c.command === "string" ? c.command : "",
		argsText: args,
		cwd: typeof c.cwd === "string" ? c.cwd : "",
		envText: recordToLines(c.env),
		url: typeof c.url === "string" ? c.url : "",
		headersText: recordToLines(c.headers),
		timeout,
	};
}

function validateForm(
	form: McpServerForm,
	existingNames: readonly string[],
	nameLocked: boolean,
): FormError | null {
	const name = form.name.trim();
	if (!name) return "nameRequired";
	if (!nameLocked && existingNames.includes(name)) return "nameExists";
	if (form.transport === "stdio") {
		if (!form.command.trim()) return "commandRequired";
	} else {
		const url = form.url.trim();
		if (!url) return "urlRequired";
		if (!/^https?:\/\//i.test(url)) return "urlInvalid";
	}
	if (linesToRecord(form.envText) === null) return "envFormat";
	if (form.transport === "http" && linesToRecord(form.headersText) === null) return "envFormat";
	return null;
}

/** Keys the form manages; everything else in an edited entry passes through. */
const FORM_KEYS = ["command", "args", "cwd", "env", "url", "headers", "requestTimeoutMs"] as const;

function buildConfig(form: McpServerForm, editing: McpServerEntry | null): Record<string, unknown> {
	// In edit mode keep unknown keys (lifecycle, directTools, oauth, ...)
	// untouched, exactly like the custom provider dialog.
	const config: Record<string, unknown> = { ...(editing?.config ?? {}) };
	for (const key of FORM_KEYS) delete config[key];
	if (form.transport === "stdio") {
		config.command = form.command.trim();
		const args = parseArgs(form.argsText);
		if (args.length) config.args = args;
		if (form.cwd.trim()) config.cwd = form.cwd.trim();
		const env = linesToRecord(form.envText);
		if (env && Object.keys(env).length) config.env = env;
	} else {
		config.url = form.url.trim();
		const headers = linesToRecord(form.headersText);
		if (headers && Object.keys(headers).length) config.headers = headers;
	}
	const timeout = Number.parseInt(form.timeout, 10);
	if (Number.isFinite(timeout) && timeout > 0) config.requestTimeoutMs = timeout;
	return config;
}

/** Accepts {"name": {...}} or {"mcpServers": {...}} pastes. */
function parseJsonServers(text: string): Record<string, Record<string, unknown>> {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("root must be an object");
	let map = parsed as Record<string, unknown>;
	if ("mcpServers" in map) {
		const inner = map.mcpServers;
		if (!inner || typeof inner !== "object" || Array.isArray(inner))
			throw new Error("mcpServers must be an object");
		map = inner as Record<string, unknown>;
	}
	const out: Record<string, Record<string, unknown>> = {};
	for (const [name, config] of Object.entries(map)) {
		if (!name.trim()) throw new Error("server name must not be empty");
		if (!config || typeof config !== "object" || Array.isArray(config))
			throw new Error(`server "${name}" must be an object`);
		out[name.trim()] = config as Record<string, unknown>;
	}
	if (Object.keys(out).length === 0) throw new Error("no servers defined");
	return out;
}

function errorText(t: MessageCatalog, code: FormError): string {
	switch (code) {
		case "nameRequired":
			return t.settings.mcpErrNameRequired;
		case "nameExists":
			return t.settings.mcpErrNameExists;
		case "commandRequired":
			return t.settings.mcpErrCommandRequired;
		case "urlRequired":
			return t.settings.mcpErrUrlRequired;
		case "urlInvalid":
			return t.settings.mcpErrUrlInvalid;
		case "envFormat":
			return t.settings.mcpErrEnvFormat;
	}
}

/**
 * Add/edit an MCP server. User scope writes ~/.pi/agent/mcp.json, a workspace
 * scope writes <project>/.mcp.json — both shared with pi and the TUI.
 */
export function McpServerDialog({
	open,
	editing,
	existingNames,
	projects,
	scopeProject,
	t,
	onClose,
	onSaved,
	onError,
	onChanged,
}: {
	open: boolean;
	/** Entry being edited; null = add mode. */
	editing: McpServerEntry | null;
	/** Other servers' names (collision check in add mode). */
	existingNames: readonly string[];
	/** Known workspace paths for the scope dropdown. */
	projects: readonly string[];
	/** Project context of the current list view (null = user scope). */
	scopeProject: string | null;
	t: MessageCatalog;
	onClose: () => void;
	onSaved: (msg: string) => void;
	onError: (msg: string) => void;
	/** Refresh the server list after a successful save. */
	onChanged: () => void;
}) {
	const [mode, setMode] = useState<DialogMode>("form");
	const [form, setForm] = useState<McpServerForm>(BLANK_FORM);
	const [jsonText, setJsonText] = useState("");
	const [showEnv, setShowEnv] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		setError(null);
		setBusy(false);
		setMode("form");
		if (editing) {
			const f = formFromEntry(editing, scopeProject);
			setForm(f);
			setShowEnv(Boolean(f.envText || f.headersText));
			setJsonText(JSON.stringify({ [editing.name]: editing.config }, null, 2));
		} else {
			setForm({ ...BLANK_FORM, scope: scopeProject ?? "" });
			setShowEnv(false);
			setJsonText(JSON.stringify({ "my-mcp-server": { command: "npx", args: [] } }, null, 2));
		}
	}, [open, editing, scopeProject]);

	if (!open) return null;

	const nameLocked = editing !== null;
	const patch = (p: Partial<McpServerForm>) => setForm((prev) => ({ ...prev, ...p }));

	const switchToJson = () => {
		// Carry the current form over so nothing typed is lost.
		const name = form.name.trim() || "my-mcp-server";
		setJsonText(JSON.stringify({ [name]: buildConfig(form, editing) }, null, 2));
		setMode("json");
		setError(null);
	};

	const saveForm = async (): Promise<string | null> => {
		const code = validateForm(form, existingNames, nameLocked);
		if (code) {
			setError(errorText(t, code));
			return null;
		}
		const name = form.name.trim();
		const config = buildConfig(form, editing);
		await piMcpUpsertServer(form.scope ? "project" : "global", form.scope || null, name, config);
		return name;
	};

	const saveJson = async (): Promise<string | null> => {
		let servers: Record<string, Record<string, unknown>>;
		try {
			servers = parseJsonServers(jsonText);
		} catch (e) {
			setError(
				t.settings.mcpJsonInvalid.replace("{error}", e instanceof Error ? e.message : String(e)),
			);
			return null;
		}
		const scope = form.scope ? "project" : "global";
		const project = form.scope || null;
		for (const [name, config] of Object.entries(servers)) {
			await piMcpUpsertServer(scope, project, name, config);
		}
		// In edit mode a rename shows up as the old name going missing.
		if (editing && !(editing.name in servers)) {
			await piMcpRemoveServer(
				editing.source === "shared-project" ? "project" : "global",
				scopeProject,
				editing.name,
			);
		}
		return Object.keys(servers).join(", ");
	};

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const saved = mode === "form" ? await saveForm() : await saveJson();
			if (saved === null) return;
			onChanged();
			onSaved(t.settings.mcpSaved.replace("{name}", saved));
			onClose();
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open
			onClose={onClose}
			title={nameLocked ? t.settings.mcpTitleEdit : t.settings.mcpTitleAdd}
			closeLabel={t.app.close}
			className="custom-provider-dialog"
			headerActions={
				<div className="segmented">
					<button
						className={mode === "form" ? "active" : ""}
						onClick={() => {
							setMode("form");
							setError(null);
						}}
					>
						{t.settings.mcpFormTab}
					</button>
					<button className={mode === "json" ? "active" : ""} onClick={switchToJson}>
						{t.settings.mcpJsonTab}
					</button>
				</div>
			}
		>
			<div className="cp-field">
				<label className="cp-label">{t.settings.mcpScope}</label>
				<ScopeSelect
					value={form.scope}
					options={projects}
					disabled={nameLocked}
					fullWidth
					t={t}
					onChange={(v) => patch({ scope: v })}
				/>
			</div>

			{mode === "form" ? (
				<>
					<div className="cp-grid">
						<div className="cp-field">
							<label className="cp-label">{t.settings.mcpName}</label>
							<input
								value={form.name}
								disabled={nameLocked}
								placeholder="my-mcp-server"
								spellCheck={false}
								onChange={(e) => patch({ name: e.target.value })}
							/>
							{!nameLocked && <p className="cp-note">{t.settings.mcpNameHint}</p>}
						</div>
						<div className="cp-field">
							<label className="cp-label">{t.settings.mcpTransport}</label>
							<select
								value={form.transport}
								onChange={(e) => patch({ transport: e.target.value as McpTransport })}
							>
								<option value="stdio">{t.settings.mcpTransportStdio}</option>
								<option value="http">{t.settings.mcpTransportHttp}</option>
							</select>
						</div>
					</div>

					{form.transport === "stdio" ? (
						<>
							<div className="cp-field">
								<label className="cp-label">{t.settings.mcpCommand}</label>
								<input
									className="mono"
									value={form.command}
									placeholder="npx"
									spellCheck={false}
									onChange={(e) => patch({ command: e.target.value })}
								/>
							</div>
							<div className="cp-field">
								<label className="cp-label">{t.settings.mcpArgs}</label>
								<input
									className="mono"
									value={form.argsText}
									placeholder={t.settings.mcpArgsPlaceholder}
									spellCheck={false}
									onChange={(e) => patch({ argsText: e.target.value })}
								/>
							</div>
						</>
					) : (
						<div className="cp-field">
							<label className="cp-label">{t.settings.mcpUrl}</label>
							<input
								className="mono"
								value={form.url}
								placeholder="https://example.com/mcp"
								spellCheck={false}
								onChange={(e) => patch({ url: e.target.value })}
							/>
						</div>
					)}

					<div className="cp-field">
						<label className="cp-label">{t.settings.mcpTimeout}</label>
						<input
							className="mono"
							type="number"
							min={1}
							value={form.timeout}
							placeholder="30000"
							onChange={(e) => patch({ timeout: e.target.value })}
						/>
					</div>

					<button className="mcp-collapsible" onClick={() => setShowEnv((v) => !v)}>
						{showEnv ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
						<span>
							{form.transport === "stdio"
								? t.settings.mcpEnvOptional
								: t.settings.mcpHeadersOptional}
						</span>
					</button>
					{showEnv && (
						<div className="cp-field">
							<textarea
								className="compact-textarea mono"
								rows={3}
								value={form.transport === "stdio" ? form.envText : form.headersText}
								placeholder={form.transport === "stdio" ? "API_KEY=…" : "Authorization=Bearer …"}
								spellCheck={false}
								onChange={(e) =>
									patch(
										form.transport === "stdio"
											? { envText: e.target.value }
											: { headersText: e.target.value },
									)
								}
							/>
						</div>
					)}
				</>
			) : (
				<>
					<div className="cp-field">
						<textarea
							className="compact-textarea mono mcp-json-editor"
							rows={12}
							value={jsonText}
							spellCheck={false}
							onChange={(e) => setJsonText(e.target.value)}
						/>
						<p className="cp-note">{t.settings.mcpJsonHint}</p>
					</div>
				</>
			)}

			{error && <div className="error-banner">{error}</div>}

			<div className="extension-dialog-actions">
				<button className="btn secondary" onClick={onClose} disabled={busy}>
					{t.app.cancel}
				</button>
				<button className="btn primary" disabled={busy} onClick={() => void save()}>
					{busy && <LoaderIcon size={12} className="spin" />}
					{t.settings.saveKey}
				</button>
			</div>
		</Modal>
	);
}
