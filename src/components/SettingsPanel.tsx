import { useCallback, useEffect, useRef, useState } from "react";
import type { PiArchivedSession, PiBinaryInfo } from "../pi";
import {
	authRemove,
	authSetKey,
	authStatus,
	exportDiagnostics,
	piCustomProviders,
	piInstalledSkills,
	piMcpRemoveServer,
	piMcpServers,
	piMcpSetDisabled,
	piPackageInstall,
	piPackageRemove,
	piPackages,
	piProviders,
	piRemoveCustomProvider,
	sidecarPing,
	type AuthProviderStatus,
	type CustomProviderEntry,
	type McpServerEntry,
	type PiPackageEntry,
	type PiSkillEntry,
} from "../pi";
import { formatDateTime, projectNameFromPath } from "../format";
import type { MessageCatalog } from "../i18n";
import {
	ArchiveIcon,
	BarChartIcon,
	BoltIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
	CopyIcon,
	EditIcon,
	EyeIcon,
	FolderIcon,
	GridIcon,
	InfoIcon,
	MoreIcon,
	PlusIcon,
	RefreshIcon,
	SearchIcon,
	SettingsIcon,
	SparkleIcon,
	TerminalIcon,
	TrashIcon,
	WrenchIcon,
} from "../icons";
import type { AppSettings, ColorScale, Density, Theme } from "../settings";
import { ALL_AGENT_TOOLS } from "../settings";
import { PACKAGES_CATALOG, formatDownloads } from "../packages-catalog";
import { UsageStats } from "./UsageStats";
import { CustomProviderDialog } from "./CustomProviderDialog";
import { McpServerDialog } from "./McpServerDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { ScopeSelect } from "./ScopeSelect";

type SettingsPage =
	| "general"
	| "appearance"
	| "providers"
	| "mcp"
	| "prompt"
	| "extensions"
	| "archived"
	| "usage"
	| "about";

const colorScales: { id: ColorScale; label: string; swatch: string[] }[] = [
	{ id: "mist", label: "Mist", swatch: ["#e9eef1", "#c9d6de", "#8fa4ae"] },
	{ id: "paper", label: "Paper", swatch: ["#f2f2ec", "#d9d9cd", "#a5a593"] },
	{ id: "sand", label: "Sand", swatch: ["#ede9e5", "#d5cfc7", "#a29a8e"] },
	{ id: "gray", label: "Gray", swatch: ["#ececec", "#d0d0d0", "#9c9c9c"] },
	{ id: "forest", label: "Forest", swatch: ["#e7ece6", "#c6d4c4", "#8da488"] },
	{ id: "ocean", label: "Ocean", swatch: ["#e6ebef", "#c3d3de", "#8aa3b3"] },
];

/**
 * Display labels for pi's built-in provider catalog (pi-ai `providers/data`).
 * The list itself comes from the installed pi at runtime; this map only
 * decorates ids with human-readable names. Unknown ids (custom providers in
 * models.json, extension-registered providers) fall back to a prettified id.
 */
const PROVIDER_LABELS: Record<string, string> = {
	"amazon-bedrock": "Amazon Bedrock",
	"ant-ling": "Ant Ling",
	anthropic: "Anthropic (Claude)",
	"azure-openai-responses": "Azure OpenAI",
	baseten: "Baseten",
	cerebras: "Cerebras",
	"cloudflare-ai-gateway": "Cloudflare AI Gateway",
	"cloudflare-workers-ai": "Cloudflare Workers AI",
	deepseek: "DeepSeek",
	fireworks: "Fireworks AI",
	"github-copilot": "GitHub Copilot",
	"google-vertex": "Google Vertex AI",
	google: "Google Gemini",
	groq: "Groq",
	huggingface: "Hugging Face",
	"kimi-coding": "Kimi",
	"minimax-cn": "MiniMax (CN)",
	minimax: "MiniMax",
	mistral: "Mistral",
	"moonshotai-cn": "Moonshot AI (CN)",
	moonshotai: "Moonshot AI",
	nvidia: "NVIDIA NIM",
	"openai-codex": "OpenAI Codex",
	openai: "OpenAI",
	"opencode-go": "OpenCode Go",
	opencode: "OpenCode",
	openrouter: "OpenRouter",
	"qwen-token-plan-cn": "Qwen Token Plan (CN)",
	"qwen-token-plan-individual": "Qwen Token Plan (Individual)",
	"qwen-token-plan": "Qwen Token Plan",
	together: "Together AI",
	"vercel-ai-gateway": "Vercel AI Gateway",
	xai: "xAI (Grok)",
	"xiaomi-token-plan-ams": "Xiaomi Token Plan (AMS)",
	"xiaomi-token-plan-cn": "Xiaomi Token Plan (CN)",
	"xiaomi-token-plan-sgp": "Xiaomi Token Plan (SGP)",
	xiaomi: "Xiaomi MiMo",
	"zai-coding-cn": "ZAI Coding (CN)",
	zai: "ZAI",
};

/** Shown when pi's catalog can't be located (standalone pi binaries). */
const FALLBACK_PROVIDER_IDS = Object.keys(PROVIDER_LABELS);

function providerLabel(id: string): string {
	return (
		PROVIDER_LABELS[id] ??
		id
			.split(/[-_]/)
			.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
			.join(" ")
	);
}

// Session-scoped cache: packages + skills survive panel close/reopen so
// re-entering settings doesn't re-run the pi CLI every time.
let extensionCache: {
	packages: PiPackageEntry[];
	skills: PiSkillEntry[];
} | null = null;

function Row({
	label,
	hint,
	children,
	wrap,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	/** Allow the control column to wrap onto multiple lines and shrink. */
	wrap?: boolean;
}) {
	return (
		<div className={`settings-row${wrap ? " wrap" : ""}`}>
			<div className="settings-label">
				{label}
				{hint && <p className="settings-hint">{hint}</p>}
			</div>
			<div className="settings-control">{children}</div>
		</div>
	);
}

/**
 * Themed pill dropdown for the archived-page toolbar. Reuses the mcp-scope
 * styles — a native <select> renders with OS chrome on Windows.
 */
function FilterSelect({
	value,
	options,
	icon,
	onChange,
}: {
	value: string;
	options: { value: string; label: string }[];
	icon?: React.ReactNode;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const label = options.find((o) => o.value === value)?.label ?? value;

	return (
		<div className="mcp-scope" ref={wrapRef}>
			<button
				className={`mcp-scope-btn ${open ? "open" : ""}`}
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				{icon}
				<span className="mcp-scope-btn-label">{label}</span>
				<ChevronDownIcon size={13} />
			</button>
			{open && (
				<div className="mcp-scope-menu">
					{options.map((o) => (
						<button
							key={o.value}
							className={`mcp-scope-item ${value === o.value ? "active" : ""}`}
							onClick={() => {
								onChange(o.value);
								setOpen(false);
							}}
						>
							<span className="mcp-scope-item-name">{o.label}</span>
							{value === o.value && <CheckIcon size={13} />}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function ProviderRow({
	provider,
	label,
	status,
	onSaved,
	onError,
	onAuthChanged,
	t,
}: {
	provider: string;
	label: string;
	status: AuthProviderStatus | undefined;
	onSaved: (msg: string) => void;
	onError: (msg: string) => void;
	onAuthChanged: () => void;
	t: MessageCatalog;
}) {
	const [editing, setEditing] = useState(false);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [oauthHelp, setOauthHelp] = useState(false);
	const [copiedCmd, setCopiedCmd] = useState(false);
	const configured = Boolean(status?.hasKey);
	const isOAuth = status?.kind === "oauth";
	const copyTimerRef = useRef<number>(0);
	useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

	const copyLoginCmd = async () => {
		try {
			await navigator.clipboard.writeText(`pi\n/login ${provider}`);
			setCopiedCmd(true);
			window.clearTimeout(copyTimerRef.current);
			copyTimerRef.current = window.setTimeout(() => setCopiedCmd(false), 1500);
		} catch {
			/* ignore */
		}
	};

	const save = async () => {
		if (!key.trim()) return;
		setBusy(true);
		try {
			await authSetKey(provider, key.trim());
			setKey("");
			setEditing(false);
			onAuthChanged();
			onSaved(t.settings.keySaved);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		try {
			await authRemove(provider);
			setEditing(false);
			onAuthChanged();
			onSaved(t.settings.keyRemoved);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="provider-row">
			<div className="provider-info">
				<span className="provider-name">{label}</span>
				<span className={`provider-status ${configured ? "ok" : ""}`}>
					{configured
						? status?.kind === "oauth"
							? t.settings.providerConfiguredOAuth
							: t.settings.providerConfigured
						: t.settings.providerNotConfigured}
				</span>
			</div>
			{editing ? (
				<div className="provider-edit">
					<input
						type="password"
						autoFocus
						value={key}
						placeholder={t.settings.apiKey}
						onChange={(e) => setKey(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void save();
							if (e.key === "Escape") setEditing(false);
						}}
					/>
					<button
						className="btn primary small"
						disabled={busy || !key.trim()}
						onClick={() => void save()}
					>
						{t.settings.saveKey}
					</button>
					<button className="btn secondary small" onClick={() => setEditing(false)}>
						{t.app.cancel}
					</button>
					{configured && (
						<button className="btn danger small" disabled={busy} onClick={() => void clear()}>
							{t.settings.clearKey}
						</button>
					)}
				</div>
			) : (
				<div className="provider-actions">
					<button className="btn secondary small" onClick={() => setEditing(true)}>
						{configured ? t.settings.apiKey : t.settings.saveKey}
					</button>
					{isOAuth && (
						<button
							className="btn secondary small"
							title={t.settings.oauthLoginHint}
							onClick={() => setOauthHelp((v) => !v)}
						>
							{t.settings.oauthLogin}
						</button>
					)}
				</div>
			)}
			{oauthHelp && (
				<div className="oauth-help">
					<p>{t.settings.oauthHelpBody.replace("{provider}", provider)}</p>
					<div className="oauth-help-cmd mono">
						<span>pi</span>
						<span className="oauth-help-arrow">→</span>
						<span>/login {provider}</span>
						<button
							className="icon-btn"
							title={t.chat.copy}
							aria-label={t.chat.copy}
							onClick={() => void copyLoginCmd()}
						>
							{copiedCmd ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
						</button>
					</div>
				</div>
			)}
		</li>
	);
}

export function SettingsPanel({
	t,
	settings,
	onChange,
	binary,
	sessionDir,
	archived,
	onRestore,
	onPurge,
	onPurgeAll,
	onPurgeProject,
	onViewArchived,
	onCompactArchived,
	onClose,
	onOpenSessionDir,
	onOpenScopedModels,
	onReload,
	onOpenLlama,
	workspace,
	trustDecision,
	trustDefault,
	onSetProjectTrust,
	onSetDefaultTrust,
	projects,
	onCustomProvidersChanged,
}: {
	t: MessageCatalog;
	settings: AppSettings;
	onChange: (s: AppSettings) => void;
	binary: PiBinaryInfo | null;
	sessionDir: string;
	archived: PiArchivedSession[];
	onRestore: (path: string) => void;
	onPurge: (path: string) => void;
	onPurgeAll: () => void;
	onPurgeProject: (project: string | null) => void;
	onViewArchived: (path: string, title: string) => void;
	onCompactArchived: (path: string) => void;
	onClose: () => void;
	onOpenSessionDir: () => void;
	onOpenScopedModels: () => void;
	onReload: () => void;
	onOpenLlama: () => void;
	workspace: string | null;
	trustDecision: boolean | null;
	trustDefault: string;
	onSetProjectTrust: (decision: boolean | null) => void;
	onSetDefaultTrust: (value: string) => void;
	/** Known workspace paths (from sessions), for the MCP scope dropdown. */
	projects: string[];
	/** Fired after a custom provider is added/edited/deleted (models.json
	 * changed). The host uses it to reconnect the running session so pi
	 * re-reads the model catalog. */
	onCustomProvidersChanged?: () => void;
}) {
	const themeOptions: { id: Theme; label: string }[] = [
		{ id: "light", label: t.settings.themeLight },
		{ id: "dark", label: t.settings.themeDark },
		{ id: "system", label: t.settings.themeSystem },
	];
	const densityOptions: { id: Density; label: string }[] = [
		{ id: "compact", label: t.settings.densityCompact },
		{ id: "comfortable", label: t.settings.densityComfortable },
		{ id: "relaxed", label: t.settings.densityRelaxed },
	];

	const [page, setPage] = useState<SettingsPage>("general");
	const [packageQuery, setPackageQuery] = useState("");
	// Archived page: search / sort / project filter / per-project "..." menu.
	const [archivedQuery, setArchivedQuery] = useState("");
	const [archivedSort, setArchivedSort] = useState<"newest" | "oldest">("newest");
	const [archivedProject, setArchivedProject] = useState("all");
	const [archivedMenu, setArchivedMenu] = useState<string | null>(null);
	const archivedMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (archivedMenu === null) return;
		const onDown = (e: MouseEvent) => {
			if (archivedMenuRef.current && !archivedMenuRef.current.contains(e.target as Node)) {
				setArchivedMenu(null);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setArchivedMenu(null);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [archivedMenu]);

	const navGroups: {
		label: string;
		items: { id: SettingsPage; label: string; icon: React.ReactNode }[];
	}[] = [
		{
			label: t.settings.groupBasic,
			items: [
				{ id: "general", label: t.settings.general, icon: <SettingsIcon size={15} /> },
				{ id: "appearance", label: t.settings.appearance, icon: <SparkleIcon size={15} /> },
			],
		},
		{
			label: t.settings.groupAgent,
			items: [
				{ id: "providers", label: t.settings.providers, icon: <BoltIcon size={15} /> },
				{ id: "mcp", label: t.settings.mcp, icon: <WrenchIcon size={15} /> },
				{ id: "prompt", label: t.settings.systemPrompt, icon: <EditIcon size={15} /> },
				{ id: "extensions", label: t.settings.extensions, icon: <GridIcon size={15} /> },
			],
		},
		{
			label: t.settings.groupData,
			items: [
				{ id: "usage", label: t.settings.usage, icon: <BarChartIcon size={15} /> },
				{ id: "archived", label: t.sidebar.archived, icon: <ArchiveIcon size={15} /> },
				{ id: "about", label: t.settings.about, icon: <InfoIcon size={15} /> },
			],
		},
	];
	const activePageLabel =
		navGroups.flatMap((g) => g.items).find((i) => i.id === page)?.label ?? t.settings.title;

	// ---- archived page: filter + group ----
	// "" is the group key for sessions without a project; "all" = no filter.
	const archivedProjects = [...new Set(archived.map((a) => a.project ?? ""))].sort();
	const archivedFiltered = (() => {
		const q = archivedQuery.trim().toLowerCase();
		const list = archived
			.filter((a) => archivedProject === "all" || (a.project ?? "") === archivedProject)
			.filter((a) => !q || a.title.toLowerCase().includes(q));
		list.sort((a, b) =>
			archivedSort === "newest" ? b.mtimeMs - a.mtimeMs : a.mtimeMs - b.mtimeMs,
		);
		return list;
	})();
	const archivedGroups = new Map<string, PiArchivedSession[]>();
	for (const a of archivedFiltered) {
		const key = a.project ?? "";
		const list = archivedGroups.get(key);
		if (list) list.push(a);
		else archivedGroups.set(key, [a]);
	}

	// ---- provider auth ----
	const [auth, setAuth] = useState<AuthProviderStatus[]>([]);
	const [toastMsg, setToastMsg] = useState<string | null>(null);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const toastTimerRef = useRef<number>(0);
	const errorTimerRef = useRef<number>(0);
	useEffect(
		() => () => {
			window.clearTimeout(toastTimerRef.current);
			window.clearTimeout(errorTimerRef.current);
		},
		[],
	);

	// Provider list mirrors the TUI: whatever the installed pi can configure
	// (built-in catalog + models.json customs + providers with stored keys).
	// Falls back to the bundled list when pi isn't installed or its catalog
	// isn't on disk.
	const [providerIds, setProviderIds] = useState<string[] | null>(null);

	const refreshProviders = useCallback(() => {
		piProviders()
			.then((list) => {
				const ids = list.some((p) => p.known)
					? list.map((p) => p.id)
					: [...new Set([...FALLBACK_PROVIDER_IDS, ...list.map((p) => p.id)])];
				setProviderIds(ids);
			})
			.catch(() => setProviderIds(FALLBACK_PROVIDER_IDS));
	}, []);
	useEffect(() => {
		refreshProviders();
	}, [refreshProviders]);
	const providers = providerIds ?? FALLBACK_PROVIDER_IDS;

	const refreshAuth = useCallback(() => {
		authStatus()
			.then(setAuth)
			.catch(() => setAuth([]));
	}, []);
	useEffect(() => {
		refreshAuth();
	}, [refreshAuth]);

	const notify = useCallback((msg: string) => {
		setToastMsg(msg);
		window.clearTimeout(toastTimerRef.current);
		toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 2200);
	}, []);
	const notifyError = useCallback((msg: string) => {
		setErrorMsg(msg);
		window.clearTimeout(errorTimerRef.current);
		errorTimerRef.current = window.setTimeout(() => setErrorMsg(null), 4000);
	}, []);

	// ---- diagnostics export (About page) ----
	const [exportingDiag, setExportingDiag] = useState(false);
	const handleExportDiagnostics = useCallback(async () => {
		setExportingDiag(true);
		try {
			const r = await exportDiagnostics();
			if (r.ok && !r.canceled) {
				notify(t.settings.diagnosticsExported);
			} else if (!r.ok) {
				notifyError(r.error ?? "export failed");
			}
		} catch (e) {
			notifyError(String(e));
		} finally {
			setExportingDiag(false);
		}
	}, [notify, notifyError, t]);

	// ---- custom providers (models.json CRUD) ----
	const [customProviders, setCustomProviders] = useState<CustomProviderEntry[]>([]);
	const [cpDialogOpen, setCpDialogOpen] = useState(false);
	const [cpEditing, setCpEditing] = useState<CustomProviderEntry | null>(null);
	/** Two-step delete: first click arms, second click executes. */
	const [cpConfirmDelete, setCpConfirmDelete] = useState<string | null>(null);

	const refreshCustomProviders = useCallback(() => {
		piCustomProviders()
			.then(setCustomProviders)
			.catch(() => setCustomProviders([]));
	}, []);
	useEffect(() => {
		refreshCustomProviders();
	}, [refreshCustomProviders]);

	// Disarm a stale delete confirmation automatically.
	useEffect(() => {
		if (!cpConfirmDelete) return;
		const timer = window.setTimeout(() => setCpConfirmDelete(null), 3000);
		return () => window.clearTimeout(timer);
	}, [cpConfirmDelete]);

	const onProvidersChanged = useCallback(() => {
		refreshProviders();
		refreshCustomProviders();
		refreshAuth();
		// Let the host reconnect the running session so the pi process
		// re-reads models.json (its model catalog is a startup snapshot).
		onCustomProvidersChanged?.();
	}, [refreshProviders, refreshCustomProviders, refreshAuth, onCustomProvidersChanged]);

	const deleteCustomProvider = async (entry: CustomProviderEntry) => {
		if (cpConfirmDelete !== entry.id) {
			setCpConfirmDelete(entry.id);
			return;
		}
		setCpConfirmDelete(null);
		try {
			await piRemoveCustomProvider(entry.id);
			// Drop the stored key too, or the provider would linger in the list
			// (pi_providers merges auth.json entries).
			await authRemove(entry.id).catch(() => {});
			onProvidersChanged();
			notify(t.settings.providerDeleted.replace("{id}", entry.id));
		} catch (e) {
			notifyError(String(e));
		}
	};
	const customIds = new Set(customProviders.map((c) => c.id));

	// ---- MCP servers (pi-mcp-adapter config layers) ----
	const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
	const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
	const [mcpEditing, setMcpEditing] = useState<McpServerEntry | null>(null);
	/** Two-step delete: first click arms, second click executes. */
	const [mcpConfirmDelete, setMcpConfirmDelete] = useState<string | null>(null);
	/** Scope dropdown: null = not chosen yet (falls back to the open
	 * workspace), "" = user scope, otherwise a project path. */
	const [mcpScopeSel, setMcpScopeSel] = useState<string | null>(null);
	const [mcpQuery, setMcpQuery] = useState("");
	const mcpScope = mcpScopeSel ?? workspace ?? "";

	const refreshMcpServers = useCallback(() => {
		piMcpServers(mcpScope || null)
			.then(setMcpServers)
			.catch(() => setMcpServers([]));
	}, [mcpScope]);
	useEffect(() => {
		refreshMcpServers();
	}, [refreshMcpServers]);

	// Disarm a stale delete confirmation automatically.
	useEffect(() => {
		if (!mcpConfirmDelete) return;
		const timer = window.setTimeout(() => setMcpConfirmDelete(null), 3000);
		return () => window.clearTimeout(timer);
	}, [mcpConfirmDelete]);

	const toggleMcpServer = async (entry: McpServerEntry) => {
		try {
			await piMcpSetDisabled(entry.name, !entry.disabled, mcpScope || null);
			refreshMcpServers();
			notify(
				(entry.disabled ? t.settings.mcpEnabled : t.settings.mcpDisabled).replace(
					"{name}",
					entry.name,
				),
			);
		} catch (e) {
			notifyError(String(e));
		}
	};

	const deleteMcpServer = async (entry: McpServerEntry) => {
		if (mcpConfirmDelete !== entry.name) {
			setMcpConfirmDelete(entry.name);
			return;
		}
		setMcpConfirmDelete(null);
		try {
			await piMcpRemoveServer(
				entry.source === "shared-project" ? "project" : "global",
				mcpScope || null,
				entry.name,
			);
			refreshMcpServers();
			notify(t.settings.mcpDeleted.replace("{name}", entry.name));
		} catch (e) {
			notifyError(String(e));
		}
	};

	const mcpSourceLabel = (source: McpServerEntry["source"]): string => {
		switch (source) {
			case "shared-global":
				return t.settings.mcpSourceSharedGlobal;
			case "agents-global":
			case "agents-nested-global":
				return t.settings.mcpSourceAgentsGlobal;
			case "shared-project":
				return t.settings.mcpSourceProject;
			case "pi-project":
				return t.settings.mcpSourcePiProject;
			default:
				return t.settings.mcpSourcePiGlobal;
		}
	};

	const mcpCommandPreview = (entry: McpServerEntry): string => {
		const c = entry.config;
		if (entry.transport === "http") return typeof c.url === "string" ? c.url : "";
		if (entry.transport === "socket") return typeof c.socket === "string" ? c.socket : "";
		const args = Array.isArray(c.args)
			? c.args.filter((a): a is string => typeof a === "string").join(" ")
			: "";
		return [typeof c.command === "string" ? c.command : "", args].filter(Boolean).join(" ");
	};

	// Scope dropdown options: known projects plus the open workspace (it may
	// have no sessions yet and thus be missing from `projects`).
	const mcpScopeOptions = Array.from(new Set([...projects, ...(workspace ? [workspace] : [])]));

	const mcpFiltered = mcpServers.filter((s) => {
		const q = mcpQuery.trim().toLowerCase();
		if (!q) return true;
		return s.name.toLowerCase().includes(q) || mcpCommandPreview(s).toLowerCase().includes(q);
	});

	// ---- packages & skills ----
	// Cache extension data for the app session so reopening the settings panel
	// renders instantly instead of re-running `pi list` every time.
	const [packages, setPackages] = useState<PiPackageEntry[]>(() => extensionCache?.packages ?? []);
	const [skills, setSkills] = useState<PiSkillEntry[]>(() => extensionCache?.skills ?? []);
	const [packagesLoading, setPackagesLoading] = useState(!extensionCache);
	const [skillsLoading, setSkillsLoading] = useState(!extensionCache);
	const [customSource, setCustomSource] = useState("");
	const [busySource, setBusySource] = useState<string | null>(null);
	// Removing an installed package is destructive and irreversible, so it
	// goes through a confirmation dialog instead of firing on the first click.
	const [pendingRemove, setPendingRemove] = useState<string | null>(null);

	const refreshPackages = useCallback(async () => {
		// Show cached data instantly; refresh in the background on re-open.
		if (!extensionCache) {
			setPackagesLoading(true);
			setSkillsLoading(true);
		}
		try {
			// Fetch packages once and reuse them for the skills scan — running
			// `pi list` twice per settings open is wasted time.
			const pkgs = await piPackages();
			const skillList = await piInstalledSkills(pkgs);
			setPackages(pkgs);
			setSkills(skillList);
			extensionCache = { packages: pkgs, skills: skillList };
		} catch {
			if (!extensionCache) {
				setPackages([]);
				setSkills([]);
			}
		} finally {
			setPackagesLoading(false);
			setSkillsLoading(false);
		}
	}, []);
	useEffect(() => {
		refreshPackages();
	}, [refreshPackages]);

	const installedNames = new Set(
		packages.filter((p) => p.packageName).map((p) => p.packageName as string),
	);
	const mcpAdapterInstalled = installedNames.has("pi-mcp-adapter");
	const installedSources = new Set(packages.map((p) => p.source));

	const handleInstall = async (source: string) => {
		setBusySource(source);
		try {
			await piPackageInstall(source);
			notify(t.settings.installSuccess);
			refreshPackages();
		} catch (e) {
			notifyError(String(e));
		} finally {
			setBusySource(null);
		}
	};

	const handleRemove = async (source: string) => {
		setBusySource(source);
		try {
			await piPackageRemove(source);
			notify(t.settings.removeSuccess);
			refreshPackages();
		} catch (e) {
			notifyError(String(e));
		} finally {
			setBusySource(null);
		}
	};

	return (
		<div className="settings-panel">
			{pendingRemove && (
				<ConfirmDialog
					t={t}
					state={{
						title: t.settings.removeConfirmTitle,
						body: t.settings.removeConfirmBody.replace("{name}", pendingRemove),
						confirmLabel: t.settings.remove,
						onConfirm: () => void handleRemove(pendingRemove),
					}}
					onClose={() => setPendingRemove(null)}
				/>
			)}
			<nav className="settings-nav">
				<button className="settings-back" onClick={onClose}>
					<ChevronLeftIcon size={15} />
					<span>{t.settings.back}</span>
				</button>
				<div className="settings-nav-scroll">
					{navGroups.map((group) => (
						<div className="settings-nav-group" key={group.label}>
							<div className="settings-nav-group-label">{group.label}</div>
							{group.items.map((item) => (
								<button
									key={item.id}
									className={`settings-nav-item ${page === item.id ? "active" : ""}`}
									onClick={() => setPage(item.id)}
								>
									{item.icon}
									<span>{item.label}</span>
								</button>
							))}
						</div>
					))}
				</div>
			</nav>

			<div className="settings-content">
				<header className="settings-content-header">
					<h2>{activePageLabel}</h2>
				</header>

				<div className="settings-body">
					{(toastMsg || errorMsg) && (
						<div className={`settings-flash ${errorMsg ? "error" : ""}`}>
							{errorMsg ?? toastMsg}
						</div>
					)}

					{page === "appearance" && (
						<section className="settings-section">
							<h3>{t.settings.appearance}</h3>
							<Row label={t.settings.theme}>
								<div className="segmented">
									{themeOptions.map((o) => (
										<button
											key={o.id}
											className={settings.theme === o.id ? "active" : ""}
											onClick={() => onChange({ ...settings, theme: o.id })}
										>
											{o.label}
										</button>
									))}
								</div>
							</Row>
							<Row label={t.settings.colorScale}>
								<div className="color-scale-grid">
									{colorScales.map((c) => (
										<button
											key={c.id}
											className={`color-scale ${settings.colorScale === c.id ? "active" : ""}`}
											title={c.label}
											onClick={() => onChange({ ...settings, colorScale: c.id })}
										>
											<span className="swatches">
												{c.swatch.map((color, i) => (
													<span key={i} style={{ background: color }} />
												))}
											</span>
											<span className="scale-name">{c.label}</span>
										</button>
									))}
								</div>
							</Row>
							<Row label={t.settings.fontSize}>
								<select
									value={settings.fontSize}
									onChange={(e) =>
										onChange({
											...settings,
											fontSize: Number(e.target.value),
										})
									}
								>
									{[13, 14, 15, 16, 17].map((n) => (
										<option key={n} value={n}>
											{n}px
										</option>
									))}
								</select>
							</Row>
							<Row label={t.settings.density}>
								<div className="segmented">
									{densityOptions.map((o) => (
										<button
											key={o.id}
											className={settings.density === o.id ? "active" : ""}
											onClick={() => onChange({ ...settings, density: o.id })}
										>
											{o.label}
										</button>
									))}
								</div>
							</Row>
							<Row label={t.settings.chatFontFamily} hint={t.settings.chatFontFamilyHint}>
								<select
									value={settings.chatFontFamily}
									onChange={(e) =>
										onChange({
											...settings,
											chatFontFamily: e.target.value as typeof settings.chatFontFamily,
										})
									}
								>
									<option value="system">{t.settings.fontSystem}</option>
									<option value="lxgwWenkai">{t.settings.fontLxgwWenkai}</option>
									<option value="zhuqueFangsong">{t.settings.fontZhuqueFangsong}</option>
								</select>
							</Row>
							<Row label={t.settings.chatContentWidth}>
								<div className="segmented">
									{[
										{ id: "standard", label: t.settings.chatWidthStandard },
										{ id: "wide", label: t.settings.chatWidthWide },
										{ id: "extraWide", label: t.settings.chatWidthExtraWide },
									].map((o) => (
										<button
											key={o.id}
											className={settings.chatContentWidth === o.id ? "active" : ""}
											onClick={() =>
												onChange({
													...settings,
													chatContentWidth: o.id as typeof settings.chatContentWidth,
												})
											}
										>
											{o.label}
										</button>
									))}
								</div>
							</Row>
							<Row label={t.settings.chatLineSpacing}>
								<div className="segmented">
									{[
										{ id: "compact", label: t.settings.lineSpacingCompact },
										{ id: "standard", label: t.settings.lineSpacingStandard },
										{ id: "relaxed", label: t.settings.lineSpacingRelaxed },
									].map((o) => (
										<button
											key={o.id}
											className={settings.chatLineSpacing === o.id ? "active" : ""}
											onClick={() =>
												onChange({
													...settings,
													chatLineSpacing: o.id as typeof settings.chatLineSpacing,
												})
											}
										>
											{o.label}
										</button>
									))}
								</div>
							</Row>
						</section>
					)}

					{page === "general" && (
						<section className="settings-section">
							<h3>{t.settings.general}</h3>
							<Row label={t.settings.language}>
								<select
									value={settings.language}
									onChange={(e) =>
										onChange({
											...settings,
											language: e.target.value as "zh" | "en",
										})
									}
								>
									<option value="zh">中文</option>
									<option value="en">English</option>
								</select>
							</Row>
							<Row
								label={t.settings.continueQueuedAfterInterrupt}
								hint={t.settings.continueQueuedAfterInterruptHint}
							>
								<label className="switch-row">
									<input
										type="checkbox"
										checked={settings.continueQueuedAfterInterrupt}
										onChange={(e) =>
											onChange({
												...settings,
												continueQueuedAfterInterrupt: e.target.checked,
											})
										}
									/>
									<span className="switch-track">
										<span />
									</span>
								</label>
							</Row>
							<Row label={t.settings.sendDuringRunMode} hint={t.settings.sendDuringRunModeHint}>
								<select
									value={settings.sendDuringRunMode}
									onChange={(e) =>
										onChange({
											...settings,
											sendDuringRunMode: e.target.value as "steer" | "queue",
										})
									}
								>
									<option value="steer">{t.settings.modeSteer}</option>
									<option value="queue">{t.settings.modeQueue}</option>
								</select>
							</Row>
							<Row label={t.settings.showContextUsage} hint={t.settings.showContextUsageHint}>
								<label className="switch-row">
									<input
										type="checkbox"
										checked={settings.showContextUsage}
										onChange={(e) =>
											onChange({
												...settings,
												showContextUsage: e.target.checked,
											})
										}
									/>
									<span className="switch-track">
										<span />
									</span>
								</label>
							</Row>
							<Row label={t.settings.autoRetryOnFailure} hint={t.settings.autoRetryOnFailureHint}>
								<label className="switch-row">
									<input
										type="checkbox"
										checked={settings.autoRetryOnFailure}
										onChange={(e) =>
											onChange({
												...settings,
												autoRetryOnFailure: e.target.checked,
											})
										}
									/>
									<span className="switch-track">
										<span />
									</span>
								</label>
							</Row>
							<Row label={t.settings.autoCompaction} hint={t.settings.autoCompactionHint}>
								<label className="switch-row">
									<input
										type="checkbox"
										checked={settings.autoCompaction}
										onChange={(e) =>
											onChange({
												...settings,
												autoCompaction: e.target.checked,
											})
										}
									/>
									<span className="switch-track">
										<span />
									</span>
								</label>
							</Row>
							<Row label={t.settings.steeringMode} hint={t.settings.steeringModeHint}>
								<select
									value={settings.steeringMode}
									onChange={(e) =>
										onChange({
											...settings,
											steeringMode: e.target.value as "all" | "one-at-a-time",
										})
									}
								>
									<option value="all">{t.settings.queueModeAll}</option>
									<option value="one-at-a-time">{t.settings.queueModeOneAtATime}</option>
								</select>
							</Row>
							<Row label={t.settings.followUpMode} hint={t.settings.followUpModeHint}>
								<select
									value={settings.followUpMode}
									// The TUI default is one-at-a-time; the local queue already
									// serializes delivery, so all/one-at-a-time maps to pi's
									// delivery granularity per turn.
									onChange={(e) =>
										onChange({
											...settings,
											followUpMode: e.target.value as "all" | "one-at-a-time",
										})
									}
								>
									<option value="all">{t.settings.queueModeAll}</option>
									<option value="one-at-a-time">{t.settings.queueModeOneAtATime}</option>
								</select>
							</Row>
							<Row label={t.settings.scopedModels} hint={t.settings.scopedModelsHint}>
								<div className="scoped-models-row">
									<span className="scoped-models-count mono">
										{settings.scopedModels.length
											? settings.scopedModels.join(", ")
											: t.settings.scopedModelsEmpty}
									</span>
									<button className="btn secondary" onClick={onOpenScopedModels}>
										{t.settings.scopedModelsEdit}
									</button>
								</div>
							</Row>
							<Row label={t.settings.excludedTools} hint={t.settings.excludedToolsHint} wrap>
								<div className="excluded-tools">
									{ALL_AGENT_TOOLS.map((tool) => {
										const excluded = settings.excludedTools.includes(tool);
										return (
											<label
												key={tool}
												className={`excluded-tool-chip ${excluded ? "excluded" : ""}`}
											>
												<input
													type="checkbox"
													checked={excluded}
													onChange={(e) => {
														const next = new Set(settings.excludedTools);
														if (e.target.checked) next.add(tool);
														else next.delete(tool);
														onChange({
															...settings,
															excludedTools: ALL_AGENT_TOOLS.filter((x) => next.has(x)),
														});
													}}
												/>
												<span>
													{(t.chat.agentToolNames as Record<string, string>)[tool] ?? tool}
												</span>
											</label>
										);
									})}
								</div>
							</Row>
							<Row label={t.settings.llama} hint={t.settings.llamaHint} wrap>
								<div className="llama-settings-row">
									<input
										className="llama-url-input mono"
										value={settings.llamaServerUrl}
										placeholder="http://127.0.0.1:8080"
										spellCheck={false}
										onChange={(e) => onChange({ ...settings, llamaServerUrl: e.target.value })}
									/>
									<input
										type="password"
										className="llama-key-input mono"
										value={settings.llamaApiKey}
										placeholder={t.settings.llamaApiKeyPlaceholder}
										spellCheck={false}
										onChange={(e) => onChange({ ...settings, llamaApiKey: e.target.value })}
									/>
									<button className="btn secondary" onClick={onOpenLlama}>
										<TerminalIcon size={13} />
										<span>{t.settings.llamaManage}</span>
									</button>
								</div>
							</Row>
							<Row label={t.settings.trust} hint={t.settings.trustHint} wrap>
								<div className="trust-row">
									<span className="trust-project mono" title={workspace ?? undefined}>
										{workspace
											? t.settings.trustFor.replace("{project}", projectNameFromPath(workspace))
											: t.settings.trustNoProject}
									</span>
									<div className="trust-buttons">
										<button
											className={`btn small ${trustDecision === true ? "primary" : "secondary"}`}
											disabled={!workspace}
											onClick={() => onSetProjectTrust(trustDecision === true ? null : true)}
										>
											{t.settings.trustTrust}
										</button>
										<button
											className={`btn small ${trustDecision === false ? "danger" : "secondary"}`}
											disabled={!workspace}
											onClick={() => onSetProjectTrust(trustDecision === false ? null : false)}
										>
											{t.settings.trustDeny}
										</button>
									</div>
									<select
										className="trust-default"
										value={trustDefault}
										title={t.settings.trustDefaultHint}
										onChange={(e) => onSetDefaultTrust(e.target.value)}
									>
										<option value="ask">{t.settings.trustDefaultAsk}</option>
										<option value="always">{t.settings.trustDefaultAlways}</option>
										<option value="never">{t.settings.trustDefaultNever}</option>
									</select>
								</div>
							</Row>
						</section>
					)}

					{page === "providers" && (
						<section className="settings-section">
							<h3>{t.settings.providers}</h3>
							<p className="settings-hint">{t.settings.providersHint}</p>

							<div className="settings-section-title-row">
								<h4 className="settings-sub">{t.settings.customProviders}</h4>
								<button
									className="btn secondary small"
									onClick={() => {
										setCpEditing(null);
										setCpDialogOpen(true);
									}}
								>
									<PlusIcon size={12} /> {t.settings.addProvider}
								</button>
							</div>
							<p className="settings-hint">{t.settings.customProvidersHint}</p>
							{customProviders.length === 0 ? (
								<p className="settings-hint">{t.settings.customProviderEmpty}</p>
							) : (
								<ul className="provider-list">
									{customProviders.map((entry) => {
										const configured = auth.find((a) => a.provider === entry.id)?.hasKey;
										const modelCount = Array.isArray(entry.config.models)
											? entry.config.models.length
											: 0;
										return (
											<li className="provider-row" key={entry.id}>
												<div className="provider-info">
													<span className="provider-name">{entry.id}</span>
													<span className={`provider-status ${configured ? "ok" : ""}`}>
														{configured
															? t.settings.providerConfigured
															: t.settings.providerNotConfigured}
													</span>
													<span className="provider-status">
														{t.settings.modelCount.replace("{count}", String(modelCount))}
													</span>
												</div>
												<div className="provider-actions">
													<button
														className="btn secondary small"
														onClick={() => {
															setCpConfirmDelete(null);
															setCpEditing(entry);
															setCpDialogOpen(true);
														}}
													>
														{t.settings.editProvider}
													</button>
													<button
														className={`btn small ${
															cpConfirmDelete === entry.id ? "danger" : "secondary"
														}`}
														onClick={() => void deleteCustomProvider(entry)}
													>
														{cpConfirmDelete === entry.id
															? t.settings.deleteProviderConfirm
															: t.settings.deleteProvider}
													</button>
												</div>
											</li>
										);
									})}
								</ul>
							)}

							<h4 className="settings-sub">{t.settings.builtinProviders}</h4>
							<ul className="provider-list">
								{providers
									.filter((id) => !customIds.has(id))
									.map((id) => (
										<ProviderRow
											key={id}
											provider={id}
											label={providerLabel(id)}
											status={auth.find((a) => a.provider === id)}
											onSaved={notify}
											onError={notifyError}
											onAuthChanged={refreshAuth}
											t={t}
										/>
									))}
							</ul>

							<CustomProviderDialog
								open={cpDialogOpen}
								editing={cpEditing}
								builtinIds={providers.filter((id) => !customIds.has(id))}
								existingIds={customProviders.map((c) => c.id)}
								t={t}
								onClose={() => setCpDialogOpen(false)}
								onSaved={notify}
								onError={notifyError}
								onChanged={onProvidersChanged}
							/>
						</section>
					)}

					{page === "mcp" && (
						<section className="settings-section">
							<div className="settings-section-title-row">
								<h3>{t.settings.mcp}</h3>
								<div className="settings-section-actions">
									<button className="link-btn" onClick={refreshMcpServers}>
										{t.sidebar.refresh}
									</button>
									<button
										className="btn secondary small"
										onClick={() => {
											setMcpConfirmDelete(null);
											setMcpEditing(null);
											setMcpDialogOpen(true);
										}}
									>
										<PlusIcon size={12} /> {t.settings.mcpAdd}
									</button>
								</div>
							</div>
							<p className="settings-hint">{t.settings.mcpHint}</p>

							{!packagesLoading && !mcpAdapterInstalled && (
								<div className="mcp-adapter-notice">
									<span>{t.settings.mcpAdapterMissing}</span>
									<button
										className="btn secondary small"
										disabled={busySource === "npm:pi-mcp-adapter"}
										onClick={() => void handleInstall("npm:pi-mcp-adapter")}
									>
										{busySource === "npm:pi-mcp-adapter"
											? t.settings.packageBusy
											: t.settings.mcpAdapterInstall}
									</button>
								</div>
							)}

							<div className="mcp-toolbar">
								<ScopeSelect
									value={mcpScope}
									options={mcpScopeOptions}
									t={t}
									onChange={setMcpScopeSel}
								/>
								<input
									className="mcp-search"
									value={mcpQuery}
									placeholder={t.settings.mcpSearchPlaceholder}
									spellCheck={false}
									onChange={(e) => setMcpQuery(e.target.value)}
								/>
							</div>

							{mcpServers.length === 0 ? (
								<p className="settings-hint">{t.settings.mcpEmpty}</p>
							) : (
								<>
									<h4 className="settings-sub">
										{t.settings.mcpInstalled.replace("{count}", String(mcpFiltered.length))}
									</h4>
									<ul className="provider-list">
										{mcpFiltered.map((entry) => (
											<li className="mcp-row" key={entry.name}>
												<span className={`mcp-dot ${entry.disabled ? "off" : ""}`} />
												<div className="mcp-info">
													<div className="mcp-name-line">
														<span className="provider-name">{entry.name}</span>
														<span className="provider-status" title={entry.sourcePath}>
															{mcpSourceLabel(entry.source)}
														</span>
													</div>
													<span className="mcp-cmd mono">
														{entry.transport} · {mcpCommandPreview(entry)}
													</span>
												</div>
												<div className="mcp-actions">
													{entry.editable && (
														<>
															<button
																className="btn secondary small"
																onClick={() => {
																	setMcpConfirmDelete(null);
																	setMcpEditing(entry);
																	setMcpDialogOpen(true);
																}}
															>
																{t.settings.editProvider}
															</button>
															<button
																className={`btn small ${
																	mcpConfirmDelete === entry.name ? "danger" : "secondary"
																}`}
																onClick={() => void deleteMcpServer(entry)}
															>
																{mcpConfirmDelete === entry.name
																	? t.settings.deleteProviderConfirm
																	: t.settings.deleteProvider}
															</button>
														</>
													)}
													<label className="switch-row">
														<input
															type="checkbox"
															checked={!entry.disabled}
															onChange={() => void toggleMcpServer(entry)}
														/>
														<span className="switch-track">
															<span />
														</span>
													</label>
												</div>
											</li>
										))}
									</ul>
									{mcpServers.some((e) => !e.editable) && (
										<p className="settings-hint">{t.settings.mcpReadonlyHint}</p>
									)}
								</>
							)}

							<McpServerDialog
								open={mcpDialogOpen}
								editing={mcpEditing}
								existingNames={mcpServers.map((s) => s.name)}
								projects={mcpScopeOptions}
								scopeProject={mcpScope || null}
								t={t}
								onClose={() => setMcpDialogOpen(false)}
								onSaved={notify}
								onError={notifyError}
								onChanged={refreshMcpServers}
							/>
						</section>
					)}

					{page === "prompt" && (
						<section className="settings-section">
							<h3>{t.settings.systemPrompt}</h3>
							<p className="settings-hint">{t.settings.systemPromptHint}</p>
							<textarea
								className="system-prompt-editor"
								rows={8}
								value={settings.systemPrompt}
								placeholder={t.settings.systemPromptPlaceholder}
								onChange={(e) => onChange({ ...settings, systemPrompt: e.target.value })}
							/>
							{settings.systemPrompt && (
								<button
									className="link-btn"
									onClick={() => onChange({ ...settings, systemPrompt: "" })}
								>
									{t.settings.reset}
								</button>
							)}
							<h4 className="settings-sub">{t.settings.appendSystemPrompt}</h4>
							<p className="settings-hint">{t.settings.appendSystemPromptHint}</p>
							<textarea
								className="system-prompt-editor"
								rows={4}
								value={settings.appendSystemPrompt}
								placeholder={t.settings.appendSystemPromptPlaceholder}
								onChange={(e) => onChange({ ...settings, appendSystemPrompt: e.target.value })}
							/>
							{settings.appendSystemPrompt && (
								<button
									className="link-btn"
									onClick={() => onChange({ ...settings, appendSystemPrompt: "" })}
								>
									{t.settings.reset}
								</button>
							)}
						</section>
					)}

					{page === "extensions" && (
						<section className="settings-section">
							<div className="settings-section-title-row">
								<h3>{t.settings.extensions}</h3>
								<div className="settings-section-actions">
									<button className="link-btn" onClick={onReload}>
										<RefreshIcon size={12} />
										<span>{t.settings.reload}</span>
									</button>
									<button className="link-btn" onClick={refreshPackages}>
										{t.sidebar.refresh}
									</button>
								</div>
							</div>
							<p className="settings-hint">{t.settings.extensionsHint}</p>

							<h4 className="settings-sub">{t.settings.skills}</h4>
							{skillsLoading ? (
								<div className="settings-loading">{t.settings.loading}</div>
							) : skills.length === 0 ? (
								<div className="settings-empty">{t.settings.emptySkills}</div>
							) : (
								<ul className="skill-list">
									{skills.map((s) => (
										<li key={`${s.location}-${s.name}`}>
											<div className="skill-name">{s.name}</div>
											{s.description && <div className="skill-desc">{s.description}</div>}
											<span className={`skill-location ${s.location}`}>{s.location}</span>
										</li>
									))}
								</ul>
							)}

							<h4 className="settings-sub">{t.settings.packages}</h4>
							{packagesLoading ? (
								<div className="settings-loading">{t.settings.loading}</div>
							) : (
								<>
									<div className="package-search-row">
										<input
											value={packageQuery}
											placeholder={t.settings.searchPackages}
											onChange={(e) => setPackageQuery(e.target.value)}
										/>
									</div>
									<ul className="package-list">
										{PACKAGES_CATALOG.filter((pkg) =>
											`${pkg.name} ${pkg.description} ${pkg.author}`
												.toLowerCase()
												.includes(packageQuery.trim().toLowerCase()),
										).map((pkg) => {
											const installed = installedNames.has(pkg.name);
											const source = `npm:${pkg.name}`;
											const busy = busySource === source;
											return (
												<li
													key={pkg.name}
													className={`package-item ${installed ? "installed" : ""}`}
												>
													<div className="package-info">
														<div className="package-name">
															{pkg.name}
															{installed && (
																<span className="package-badge">{t.settings.installed}</span>
															)}
														</div>
														<div className="package-desc">{pkg.description}</div>
														<div className="package-meta">
															<span>{formatDownloads(pkg.downloads)}/mo</span>
															{pkg.types.map((ty) => (
																<span key={ty} className="package-type">
																	{ty}
																</span>
															))}
															<span>{pkg.author}</span>
														</div>
													</div>
													{installed ? (
														<button
															className="btn secondary small"
															disabled={busy}
															onClick={() => void handleRemove(source)}
														>
															{busy ? t.settings.packageBusy : t.settings.remove}
														</button>
													) : (
														<button
															className="btn primary small"
															disabled={busy}
															onClick={() => void handleInstall(source)}
														>
															{busy ? t.settings.packageBusy : t.settings.install}
														</button>
													)}
												</li>
											);
										})}
									</ul>
								</>
							)}

							<h4 className="settings-sub">{t.settings.customSource}</h4>
							<p className="settings-hint">{t.settings.customSourceHint}</p>
							<div className="custom-source-row">
								<input
									value={customSource}
									placeholder={t.settings.customSourcePlaceholder}
									onChange={(e) => setCustomSource(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && customSource.trim()) {
											void handleInstall(customSource.trim());
											setCustomSource("");
										}
									}}
								/>
								<button
									className="btn primary small"
									disabled={!customSource.trim() || busySource === customSource.trim()}
									onClick={() => {
										void handleInstall(customSource.trim());
										setCustomSource("");
									}}
								>
									{t.settings.installSource}
								</button>
							</div>
							{installedSources.size > 0 && (
								<>
									<h4 className="settings-sub">{t.settings.installed}</h4>
									<ul className="installed-source-list">
										{packages.map((p) => (
											<li key={p.source}>
												<span className="installed-source" title={p.installedPath ?? undefined}>
													{p.source}
												</span>
												<button
													className="btn danger small"
													disabled={busySource === p.source}
													onClick={() => setPendingRemove(p.source)}
												>
													{t.settings.remove}
												</button>
											</li>
										))}
									</ul>
								</>
							)}
						</section>
					)}

					{page === "about" && (
						<section className="settings-section">
							<h3>{t.settings.about}</h3>
							<Row label={t.settings.piBinary}>
								<span className="settings-value">
									{binary
										? `${binary.version}${binary.builtin ? ` · ${t.settings.piBuiltin}` : ""} · ${binary.bin}`
										: t.settings.binError}
								</span>
							</Row>
							<Row label={t.settings.sdkSidecar}>
								<SidecarStatus t={t} />
							</Row>
							<Row label={t.settings.sessionDir}>
								<button className="link-btn" onClick={onOpenSessionDir} title={sessionDir}>
									{sessionDir}
								</button>
							</Row>
							<Row label={t.settings.diagnostics} hint={t.settings.diagnosticsHint}>
								<button
									className="btn secondary"
									disabled={exportingDiag}
									onClick={() => void handleExportDiagnostics()}
								>
									{t.settings.exportDiagnostics}
								</button>
							</Row>
						</section>
					)}

					{page === "usage" && (
						<section className="settings-section">
							<h3>{t.settings.usage}</h3>
							<UsageStats t={t} lang={settings.language} />
						</section>
					)}

					{page === "archived" && (
						<section className="settings-section">
							<div className="settings-section-title-row">
								<h3>{t.settings.archivedTitle}</h3>
								{archived.length > 0 && (
									<div className="settings-section-actions">
										<button className="btn danger archived-delete-all" onClick={onPurgeAll}>
											<TrashIcon size={13} />
											{t.settings.deleteAllArchived}
										</button>
									</div>
								)}
							</div>
							{archived.length === 0 ? (
								<div className="settings-empty">{t.settings.emptyArchived}</div>
							) : (
								<>
									<div className="archived-toolbar">
										<div className="archived-search">
											<SearchIcon size={14} />
											<input
												value={archivedQuery}
												onChange={(e) => setArchivedQuery(e.target.value)}
												placeholder={t.settings.searchArchived}
											/>
										</div>
										<FilterSelect
											value={archivedSort}
											options={[
												{ value: "newest", label: t.settings.sortNewest },
												{ value: "oldest", label: t.settings.sortOldest },
											]}
											onChange={(v) => setArchivedSort(v as "newest" | "oldest")}
										/>
										<FilterSelect
											icon={<FolderIcon size={13} />}
											value={archivedProject}
											options={[
												{ value: "all", label: t.settings.allProjects },
												...archivedProjects.map((p) => ({
													value: p,
													label: p === "" ? t.settings.noProject : projectNameFromPath(p),
												})),
											]}
											onChange={setArchivedProject}
										/>
									</div>
									{archivedFiltered.length === 0 ? (
										<div className="settings-empty">{t.settings.emptyArchived}</div>
									) : (
										[...archivedGroups].map(([project, list]) => (
											<div className="archived-group" key={project || "__none__"}>
												<div className="archived-group-header">
													<FolderIcon size={14} />
													<span className="archived-group-name">
														{project === "" ? t.settings.noProject : projectNameFromPath(project)}
													</span>
													<span className="archived-group-count">
														{t.settings.chatsCount.replace("{count}", String(list.length))}
													</span>
													<div
														className="archived-group-menu"
														ref={archivedMenu === project ? archivedMenuRef : undefined}
													>
														<button
															className="icon-btn"
															title={t.settings.deleteProjectArchived}
															onClick={() =>
																setArchivedMenu(archivedMenu === project ? null : project)
															}
														>
															<MoreIcon size={14} />
														</button>
														{archivedMenu === project && (
															<div className="archived-group-dropdown">
																<button
																	className="archived-group-dropdown-item danger"
																	onClick={() => {
																		setArchivedMenu(null);
																		onPurgeProject(project === "" ? null : project);
																	}}
																>
																	<TrashIcon size={13} />
																	{t.settings.deleteProjectArchived}
																</button>
															</div>
														)}
													</div>
												</div>
												<ul className="archived-list">
													{list.map((a) => (
														<li key={a.path} className="archived-row">
															<div className="archived-info">
																<button
																	className="archived-title"
																	title={a.title}
																	onClick={() => onViewArchived(a.path, a.title)}
																>
																	{a.title}
																</button>
																<span className="archived-path">
																	{formatDateTime(a.mtimeMs, settings.language)}
																</span>
															</div>
															<div className="archived-actions">
																<button
																	className="icon-btn"
																	title={t.sidebar.view}
																	onClick={() => onViewArchived(a.path, a.title)}
																>
																	<EyeIcon size={14} />
																</button>
																<button
																	className="icon-btn"
																	title={t.chat.compactImages}
																	onClick={() => onCompactArchived(a.path)}
																>
																	<BoltIcon size={14} />
																</button>
																<button
																	className="icon-btn danger"
																	title={t.settings.deletePermanently}
																	onClick={() => onPurge(a.path)}
																>
																	<TrashIcon size={14} />
																</button>
																<button
																	className="archived-unarchive"
																	onClick={() => onRestore(a.path)}
																>
																	{t.settings.unarchive}
																</button>
															</div>
														</li>
													))}
												</ul>
											</div>
										))
									)}
								</>
							)}
						</section>
					)}
				</div>
			</div>
		</div>
	);
}

function SidecarStatus({ t }: { t: MessageCatalog }) {
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let tries = 0;
		const attempt = () => {
			tries++;
			sidecarPing()
				.then((r) => {
					if (live) setStatus(`pi ${r.pi} · node ${r.node}`);
				})
				.catch(() => {
					if (!live) return;
					// First launch after an install can keep the sidecar busy
					// for minutes (antivirus scanning the vendored runtime);
					// the Rust side also warms it at startup — retry here.
					if (tries < 8) {
						setStatus(t.settings.sdkSidecarWarming);
						timer = setTimeout(attempt, 8000);
					} else {
						setStatus(t.settings.sdkSidecarError);
					}
				});
		};
		attempt();
		return () => {
			live = false;
			if (timer) clearTimeout(timer);
		};
	}, [t]);

	return (
		<span className="settings-value" title={status ?? undefined}>
			{status ?? t.settings.sdkSidecarChecking}
		</span>
	);
}
