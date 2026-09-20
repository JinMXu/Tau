import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { PiArchivedSession, UpdateInfo } from "../pi";
import {
	authRemove,
	authSetKey,
	authStatus,
	exportDiagnostics,
	llamaHasKey,
	llamaSetKey,
	piCustomProviders,
	piInstalledSkills,
	piMcpRemoveServer,
	piMcpServers,
	piMcpSetDisabled,
	piPackageInstall,
	piPackageRemove,
	piPackages,
	piProviderModelOverrideRemove,
	piProviderModelRemove,
	piProviderModels,
	piProviders,
	piRemoveCustomProvider,
	sidecarPing,
	type AuthProviderStatus,
	type CustomProviderEntry,
	type McpServerEntry,
	type PiPackageEntry,
	type PiProviderModel,
	type PiSkillEntry,
} from "../pi";
import { openExternal } from "../lib/open-external";
import { formatDateTime, projectNameFromPath } from "../format";
import type { MessageCatalog } from "../i18n";
import {
	ArchiveIcon,
	BarChartIcon,
	BoltIcon,
	ChevronLeftIcon,
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
import { cn } from "@/lib/utils";
import { Button, IconActionButton } from "./motion/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./motion/select";
import { Switch } from "./motion/switch";
import { UsageStats } from "./UsageStats";
import { CustomProviderDialog } from "./CustomProviderDialog";
import { ProviderModelDialog } from "./ProviderModelDialog";
import { OAuthDialog } from "./OAuthDialog";
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

export type { SettingsPage };

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

/** OAuth-capable ids, for grouping when `pi_providers` is unavailable and the
 * fallback list is in effect (mirrors the backend's OAUTH_PROVIDERS). */
const FALLBACK_OAUTH_IDS = new Set([
	"anthropic",
	"github-copilot",
	"kimi-coding",
	"openai-codex",
	"openrouter",
	"radius",
	"xai",
]);

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
// re-entering settings doesn't re-run the pi CLI every time. Skills are
// workspace-scoped (project roots depend on it), so a cached scan is only
// reused for the same workspace.
let extensionCache: {
	packages: PiPackageEntry[];
	skills: PiSkillEntry[];
	workspace: string | null;
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
 * Installed-skills list for the extensions page: grouped by discovery root
 * (user / project / package), filtered by the search box. Project paths are
 * shown relative to the workspace, full paths on hover.
 */
function SkillsList({
	skills,
	skillQuery,
	workspace,
	t,
}: {
	skills: PiSkillEntry[];
	skillQuery: string;
	workspace: string | null;
	t: MessageCatalog;
}) {
	const q = skillQuery.trim().toLowerCase();
	const match = (s: PiSkillEntry) => !q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q);
	const groups = [
		{ id: "user", label: t.settings.skillsUser, items: skills.filter((s) => s.location === "user") },
		{
			id: "project",
			label: t.settings.skillsProject,
			items: skills.filter((s) => s.location === "project"),
		},
		{
			id: "package",
			label: t.settings.skillsPackage,
			items: skills.filter((s) => s.location === "package"),
		},
	];
	const visible = groups.filter((g) => g.items.length > 0);
	if (visible.length === 0) {
		return <div className="settings-empty">{t.settings.skillsNoMatches}</div>;
	}
	const shorten = (p?: string | null) => {
		if (!p) return "";
		if (workspace) {
			const norm = p.split("\\").join("/");
			const wsNorm = workspace.split("\\").join("/").replace(/\/$/, "");
			if (norm.toLowerCase().startsWith(`${wsNorm.toLowerCase()}/`)) {
				return norm.slice(wsNorm.length + 1);
			}
		}
		return p;
	};
	return (
		<>
			{visible.map((g) => (
				<div key={g.id} className="skill-group">
					<h4 className="settings-sub">
						{g.label}
						<span className="skill-group-count">{g.items.length}</span>
					</h4>
					<ul className="skill-list">
						{g.items.filter(match).map((s) => (
							<li key={`${s.location}-${s.name}`}>
								<div className="skill-name">{s.name}</div>
								{s.description && <div className="skill-desc">{s.description}</div>}
								{s.path && (
									<div className="skill-path" title={s.path}>
										{shorten(s.path)}
									</div>
								)}
								<span className={`skill-location ${s.location}`}>{s.location}</span>
							</li>
						))}
					</ul>
				</div>
			))}
		</>
	);
}

/**
 * Settings 按钮统一走 beUI Button(motion 按压/悬停反馈);kind 映射旧
 * .btn 的视觉 token——secondary 是灰底、danger 是红底白字,primary 直接用
 * beui 的 accent 底。small 对应旧 .btn.small 的紧凑尺寸。
 */
function Btn({
	kind = "secondary",
	small,
	className,
	...props
}: React.ComponentProps<typeof Button> & {
	kind?: "primary" | "secondary" | "danger";
	small?: boolean;
}) {
	return (
		<Button
			variant={kind === "primary" ? "primary" : "ghost"}
			size={small ? "sm" : "md"}
			{...props}
			className={cn(
				"rounded-[var(--r-md)] text-[length:var(--fs-sm)] font-medium",
				small ? "h-7 px-2.5" : "h-auto px-4 py-2",
				kind === "secondary" &&
					"bg-[color:var(--hover)] text-[color:var(--app-fg)] hover:bg-[color:var(--active)] hover:text-[color:var(--app-fg)]",
				kind === "danger" &&
					"bg-[color:var(--err)] text-white hover:bg-[color:var(--err)] hover:text-white",
				className,
			)}
		/>
	);
}

/**
 * 设置页的下拉选择,统一走 beui Select(粘性展开动画 + 外点/Escape 关闭
 * + 上下自动翻转),替代带系统原生外观的原生 <select>。
 */
function SettingSelect({
	value,
	onChange,
	options,
}: {
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
}) {
	// A null/undefined value (async setting not loaded yet) would flip the
	// Select into uncontrolled mode showing its "Select" placeholder — fall
	// back to the first option instead, matching the old native behaviour.
	const safeValue = value ?? options[0]?.value ?? "";
	// beui pins the panel to the trigger's edges (left-0 right-0); a narrow
	// trigger would squeeze longer option labels into vertical text. Right-
	// align and let the panel shrink-wrap the widest option instead.
	return (
		<Select value={safeValue} onValueChange={onChange}>
			<SelectTrigger className="settings-select h-auto w-auto rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--fs-sm)]">
				<SelectValue />
			</SelectTrigger>
			<SelectContent className="left-auto right-0 w-auto min-w-full">
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value} className="whitespace-nowrap">
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * Themed dropdown for the archived-page toolbar, now on beui Select. The
 * trigger keeps the pill look (icon + label + chevron) via className.
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
	const label = options.find((o) => o.value === value)?.label ?? value;

	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger className="mcp-scope-btn h-auto w-auto rounded-full border-0 bg-[color:var(--hover)] px-2.5 py-1.5 text-[length:var(--fs-sm)] text-[color:var(--app-fg)] hover:bg-[color:var(--active)]">
				{icon}
				<span className="mcp-scope-btn-label">{label}</span>
			</SelectTrigger>
			<SelectContent className="left-auto right-0 w-auto min-w-full">
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value} className="whitespace-nowrap">
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * Inline model list of one provider (built-in rows read-only + override
 * edit/reset, custom rows editable), expanded by the row's "Models" button.
 * The list state lives here so a providers refresh doesn't collapse the
 * panel.
 */
function ProviderModels({
	t,
	provider,
	providerLabel,
	onSaved,
	onError,
	onChanged,
}: {
	t: MessageCatalog;
	provider: string;
	providerLabel: string;
	onSaved: (msg: string) => void;
	onError: (msg: string) => void;
	/** models.json changed: host reconnects the session so pi re-reads it. */
	onChanged: () => void;
}) {
	const [models, setModels] = useState<PiProviderModel[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{
		mode: "add-custom" | "edit-custom" | "edit-override";
		initial?: PiProviderModel;
	} | null>(null);
	/** Two-step delete/reset: first click arms, second click executes. */
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [confirmReset, setConfirmReset] = useState<string | null>(null);

	const load = useCallback(() => {
		piProviderModels(provider)
			.then((list) => {
				setLoadError(null);
				setModels(list);
			})
			.catch((e) => setLoadError(String(e)));
	}, [provider]);
	useEffect(() => {
		load();
	}, [load]);

	// Disarm a stale two-step confirmation automatically.
	useEffect(() => {
		if (!confirmDelete && !confirmReset) return;
		const timer = window.setTimeout(() => {
			setConfirmDelete(null);
			setConfirmReset(null);
		}, 3000);
		return () => window.clearTimeout(timer);
	}, [confirmDelete, confirmReset]);

	const removeModel = async (m: PiProviderModel) => {
		if (confirmDelete !== m.id) {
			setConfirmDelete(m.id);
			return;
		}
		setConfirmDelete(null);
		try {
			await piProviderModelRemove(provider, m.id);
			load();
			onChanged();
			onSaved(t.settings.modelDeleted);
		} catch (e) {
			onError(String(e));
		}
	};

	const resetOverride = async (m: PiProviderModel) => {
		if (confirmReset !== m.id) {
			setConfirmReset(m.id);
			return;
		}
		setConfirmReset(null);
		try {
			await piProviderModelOverrideRemove(provider, m.id);
			load();
			onChanged();
			onSaved(t.settings.modelReset);
		} catch (e) {
			onError(String(e));
		}
	};

	const renderRow = (m: PiProviderModel) => (
		<div className="pm-row" key={m.id}>
			<span className="pm-id mono" title={m.id}>
				{m.id}
			</span>
			{m.name !== m.id && (
				<span className="pm-name" title={m.name}>
					{m.name}
				</span>
			)}
			{m.contextWindow > 0 && <span className="pm-meta">{m.contextWindow}</span>}
			{m.reasoning && <span className="pm-pill">{t.settings.cpReasoning}</span>}
			{m.image && <span className="pm-pill">{t.settings.cpImage}</span>}
			{m.overridden && <span className="pm-pill modified">{t.settings.modelModified}</span>}
			<span className="pm-actions">
				<Btn small
					
					onClick={() =>
						setDialog({ mode: m.custom ? "edit-custom" : "edit-override", initial: m })
					}
				>
					{t.settings.editModel}
				</Btn>
				{m.custom ? (
					<button
						className={`btn small ${confirmDelete === m.id ? "danger" : "secondary"}`}
						onClick={() => void removeModel(m)}
					>
						{confirmDelete === m.id ? t.settings.deleteProviderConfirm : t.settings.deleteProvider}
					</button>
				) : (
					m.overridden && (
						<button
							className={`btn small ${confirmReset === m.id ? "danger" : "secondary"}`}
							onClick={() => void resetOverride(m)}
						>
							{confirmReset === m.id ? t.settings.resetModelConfirm : t.settings.resetModel}
						</button>
					)
				)}
			</span>
		</div>
	);

	if (loadError) return <div className="provider-models error-banner">{loadError}</div>;
	if (models === null) {
		return <div className="provider-models settings-hint">{t.settings.loading}</div>;
	}

	const builtin = models.filter((m) => !m.custom);
	const custom = models.filter((m) => m.custom);

	return (
		<div className="provider-models">
			{builtin.length > 0 && (
				<>
					<p className="settings-hint">{t.settings.builtinModelsHint}</p>
					{builtin.map(renderRow)}
				</>
			)}
			{custom.length > 0 && (
				<>
					<p className="settings-hint">{t.settings.customModelsHint}</p>
					{custom.map(renderRow)}
				</>
			)}
			<div className="pm-footer">
				<Btn small onClick={() => setDialog({ mode: "add-custom" })}>
					<PlusIcon size={12} /> {t.settings.cpAddModel}
				</Btn>
			</div>
			{dialog && (
				<ProviderModelDialog
					t={t}
					provider={provider}
					providerLabel={providerLabel}
					mode={dialog.mode}
					initial={dialog.initial}
					onClose={() => setDialog(null)}
					onSaved={(msg) => {
						load();
						onChanged();
						onSaved(msg);
					}}
					onError={onError}
				/>
			)}
		</div>
	);
}

function ProviderRow({
	provider,
	label,
	status,
	oauth,
	onSaved,
	onError,
	onAuthChanged,
	onOAuthLogin,
	onModelsChanged,
	t,
}: {
	provider: string;
	label: string;
	status: AuthProviderStatus | undefined;
	/** True when pi-ai ships an OAuth login flow for this provider. */
	oauth: boolean;
	onSaved: (msg: string) => void;
	onError: (msg: string) => void;
	onAuthChanged: () => void;
	/** Opens the in-app OAuth login dialog. */
	onOAuthLogin: () => void;
	/** models.json changed through the models panel. */
	onModelsChanged: () => void;
	t: MessageCatalog;
}) {
	const [editing, setEditing] = useState(false);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	/** Expanded inline panel; closes when the Key editor opens. */
	const [panel, setPanel] = useState<"models" | null>(null);
	const configured = Boolean(status?.hasKey);

	const togglePanel = (p: "models") => {
		setEditing(false);
		setPanel((cur) => (cur === p ? null : p));
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
					<Btn kind="primary" small
						
						disabled={busy || !key.trim()}
						onClick={() => void save()}
					>
						{t.settings.saveKey}
					</Btn>
					<Btn small onClick={() => setEditing(false)}>
						{t.app.cancel}
					</Btn>
					{configured && (
						<Btn kind="danger" small disabled={busy} onClick={() => void clear()}>
							{t.settings.clearKey}
						</Btn>
					)}
				</div>
			) : (
				<div className="provider-actions">
					<Btn small onClick={() => togglePanel("models")}>
						{t.settings.providerModels}
					</Btn>
					<Btn small
						
						onClick={() => {
							setPanel(null);
							setEditing(true);
						}}
					>
						{configured ? t.settings.apiKey : t.settings.saveKey}
					</Btn>
					{oauth && (
						// Both signed-out and already-OAuth (re-login / account
						// switch) go through Tau's built-in device-code flow —
						// no pi CLI on the terminal needed.
						<Btn small onClick={onOAuthLogin}>
							{t.settings.oauthLogin}
						</Btn>
					)}
				</div>
			)}
				{panel === "models" && (
				<ProviderModels
					t={t}
					provider={provider}
					providerLabel={label}
					onSaved={onSaved}
					onError={onError}
					onChanged={onModelsChanged}
				/>
			)}
		</li>
	);
}

/** llama.cpp router key: lives backend-side (llama-auth.json in the app
 *  config dir) so the plaintext key never enters localStorage. The input
 *  shows a save hint once a key is stored; typing a new value and leaving
 *  the field (or Enter) replaces it. */
function LlamaKeyField({ t }: { t: MessageCatalog }) {
	const [hasKey, setHasKey] = useState(false);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void llamaHasKey()
			.then(setHasKey)
			.catch(() => {});
	}, []);
	const save = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await llamaSetKey(value.trim() ? value : null);
			setHasKey(Boolean(value.trim()));
			setValue("");
		} catch {
			/* persistence errors surface on the next llama call */
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="llama-key-wrap">
			<input
				type="password"
				className="llama-key-input mono"
				value={value}
				placeholder={hasKey ? t.keyDialog.saved : t.settings.llamaApiKeyPlaceholder}
				spellCheck={false}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") void save();
				}}
				onBlur={() => {
					if (value.trim()) void save();
				}}
			/>
			{hasKey && (
				<button
					className="link-btn"
					onClick={() => {
						void llamaSetKey(null)
							.then(() => setHasKey(false))
							.catch(() => {});
					}}
				>
					{t.settings.clearKey}
				</button>
			)}
		</div>
	);
}

export function SettingsPanel({
	t,
	settings,
	onChange,
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
	initialPage,
	updateInfo,
	checkingUpdates,
	onCheckUpdates,
}: {
	t: MessageCatalog;
	settings: AppSettings;
	onChange: (s: AppSettings) => void;
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
	/** Page to open on mount (menu commands jump straight to About). The
	 * panel is conditionally rendered, so this is read once per open. */
	initialPage?: SettingsPage | null;
	/** Latest known update state, owned by the host so the startup check's
	 * result survives opening/closing the panel. */
	updateInfo?: UpdateInfo | null;
	checkingUpdates?: boolean;
	onCheckUpdates?: () => void;
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

	const [page, setPage] = useState<SettingsPage>(initialPage ?? "general");
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
			// Consume Escape at document level so App's window handler (which
			// aborts the running turn) never sees it.
			e.stopPropagation();
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
	/** id → OAuth-capable, from `pi_providers` (fallback set when offline). */
	const [oauthFlags, setOauthFlags] = useState<Record<string, boolean>>({});

	const refreshProviders = useCallback(() => {
		piProviders()
			.then((list) => {
				const flags: Record<string, boolean> = {};
				for (const p of list) flags[p.id] = p.oauth;
				if (list.some((p) => p.known)) {
					setProviderIds(list.map((p) => p.id));
				} else {
					for (const id of FALLBACK_PROVIDER_IDS) {
						if (!(id in flags)) flags[id] = FALLBACK_OAUTH_IDS.has(id);
					}
					setProviderIds([...new Set([...FALLBACK_PROVIDER_IDS, ...list.map((p) => p.id)])]);
				}
				setOauthFlags(flags);
			})
			.catch(() => {
				setProviderIds(FALLBACK_PROVIDER_IDS);
				setOauthFlags(
					Object.fromEntries(FALLBACK_PROVIDER_IDS.map((id) => [id, FALLBACK_OAUTH_IDS.has(id)])),
				);
			});
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

	// ---- update check (About page) ----
	// The running version comes from Tauri directly (works before the first
	// check completes); the host owns the check state so results from the
	// background startup check aren't lost when the panel is closed.
	const [appVersion, setAppVersion] = useState<string | null>(null);
	useEffect(() => {
		getVersion()
			.then(setAppVersion)
			.catch(() => setAppVersion(null));
	}, []);

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

	// ---- built-in providers: OAuth / API Key grouping + per-row panels ----
	/** Provider id currently logging in via the OAuth dialog. */
	const [oauthLoginProvider, setOauthLoginProvider] = useState<string | null>(null);

	// Model edits write models.json too, so the running session needs the
	// same reconnect the custom-provider flow triggers. The model list
	// itself reloads locally inside the row panel, so skipping the
	// provider-list refresh here keeps the expanded panel from re-mounting.
	const onModelsChanged = useCallback(() => {
		onCustomProvidersChanged?.();
	}, [onCustomProvidersChanged]);

	const builtinIds = providers.filter((id) => !customIds.has(id));
	// Configured providers first, then alphabetical by display name.
	const byConfigThenName = (a: string, b: string) => {
		const ac = auth.find((x) => x.provider === a)?.hasKey ? 0 : 1;
		const bc = auth.find((x) => x.provider === b)?.hasKey ? 0 : 1;
		if (ac !== bc) return ac - bc;
		return providerLabel(a).localeCompare(providerLabel(b));
	};
	const oauthProviderIds = builtinIds.filter((id) => oauthFlags[id]).sort(byConfigThenName);
	const apiKeyProviderIds = builtinIds.filter((id) => !oauthFlags[id]).sort(byConfigThenName);

	const renderProviderRow = (id: string) => (
		<ProviderRow
			key={id}
			provider={id}
			label={providerLabel(id)}
			status={auth.find((a) => a.provider === id)}
			oauth={Boolean(oauthFlags[id])}
			onSaved={notify}
			onError={notifyError}
			onAuthChanged={refreshAuth}
			onOAuthLogin={() => setOauthLoginProvider(id)}
			onModelsChanged={onModelsChanged}
			t={t}
		/>
	);

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

	// Async so the header refresh button can show its busy → done animation;
	// callers that ignore the promise are unaffected.
	const refreshMcpServers = useCallback(async () => {
		try {
			setMcpServers(await piMcpServers(mcpScope || null));
		} catch {
			setMcpServers([]);
		}
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
	// renders instantly instead of re-running `pi list` every time. A cached
	// skill scan is only valid for the project it ran against.
	const [skillQuery, setSkillQuery] = useState("");
	// Extensions page tab: installed skills vs package catalog.
	const [extTab, setExtTab] = useState<"skills" | "packages">("skills");
	// Project whose skills are listed; defaults to the open workspace.
	const [skillProjectSel, setSkillProjectSel] = useState<string | null>(null);
	const skillProject = skillProjectSel ?? workspace ?? null;
	const cacheHit = extensionCache && extensionCache.workspace === skillProject;
	const [packages, setPackages] = useState<PiPackageEntry[]>(
		() => extensionCache?.packages ?? [],
	);
	const [skills, setSkills] = useState<PiSkillEntry[]>(() =>
		cacheHit ? extensionCache?.skills ?? [] : [],
	);
	const [packagesLoading, setPackagesLoading] = useState(!extensionCache);
	const [skillsLoading, setSkillsLoading] = useState(!cacheHit);
	const [customSource, setCustomSource] = useState("");
	const [busySource, setBusySource] = useState<string | null>(null);
	// Removing an installed package is destructive and irreversible, so it
	// goes through a confirmation dialog instead of firing on the first click.
	const [pendingRemove, setPendingRemove] = useState<string | null>(null);

	const refreshPackages = useCallback(async () => {
		// Show cached data instantly; refresh in the background on re-open.
		// A skill-scan cache miss (project switch) only reloads skills.
		if (!extensionCache) {
			setPackagesLoading(true);
			setSkillsLoading(true);
		} else if (extensionCache.workspace !== skillProject) {
			setSkillsLoading(true);
		}
		try {
			// Fetch packages once and reuse them for the skills scan — running
			// `pi list` twice per settings open is wasted time.
			const pkgs = await piPackages();
			const skillList = await piInstalledSkills(pkgs, skillProject);
			setPackages(pkgs);
			setSkills(skillList);
			extensionCache = { packages: pkgs, skills: skillList, workspace: skillProject };
		} catch {
			if (!extensionCache) {
				setPackages([]);
				setSkills([]);
			}
		} finally {
			setPackagesLoading(false);
			setSkillsLoading(false);
		}
	}, [skillProject]);
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
								<SettingSelect
									value={String(settings.fontSize)}
									onChange={(v) => onChange({ ...settings, fontSize: Number(v) })}
									options={[13, 14, 15, 16, 17].map((n) => ({
										value: String(n),
										label: `${n}px`,
									}))}
								/>
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
								<SettingSelect
									value={settings.chatFontFamily}
									onChange={(v) =>
										onChange({
											...settings,
											chatFontFamily: v as typeof settings.chatFontFamily,
										})
									}
									options={[
										{ value: "system", label: t.settings.fontSystem },
										{ value: "lxgwWenkai", label: t.settings.fontLxgwWenkai },
										{ value: "zhuqueFangsong", label: t.settings.fontZhuqueFangsong },
									]}
								/>
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
								<SettingSelect
									value={settings.language}
									onChange={(v) => onChange({ ...settings, language: v as "zh" | "en" })}
									options={[
										{ value: "zh", label: "中文" },
										{ value: "en", label: "English" },
									]}
								/>
							</Row>
							<Row
								label={t.settings.continueQueuedAfterInterrupt}
								hint={t.settings.continueQueuedAfterInterruptHint}
							>
								<Switch
									checked={settings.continueQueuedAfterInterrupt}
									onCheckedChange={(v) => onChange({ ...settings, continueQueuedAfterInterrupt: v })}
									ariaLabel={t.settings.continueQueuedAfterInterrupt}
								/>
							</Row>
							<Row label={t.settings.sendDuringRunMode} hint={t.settings.sendDuringRunModeHint}>
								<SettingSelect
									value={settings.sendDuringRunMode}
									onChange={(v) =>
										onChange({ ...settings, sendDuringRunMode: v as "steer" | "queue" })
									}
									options={[
										{ value: "steer", label: t.settings.modeSteer },
										{ value: "queue", label: t.settings.modeQueue },
									]}
								/>
							</Row>
							<Row label={t.settings.showContextUsage} hint={t.settings.showContextUsageHint}>
								<Switch
									checked={settings.showContextUsage}
									onCheckedChange={(v) => onChange({ ...settings, showContextUsage: v })}
									ariaLabel={t.settings.showContextUsage}
								/>
							</Row>
							<Row label={t.settings.autoRetryOnFailure} hint={t.settings.autoRetryOnFailureHint}>
								<Switch
									checked={settings.autoRetryOnFailure}
									onCheckedChange={(v) => onChange({ ...settings, autoRetryOnFailure: v })}
									ariaLabel={t.settings.autoRetryOnFailure}
								/>
							</Row>
							<Row label={t.settings.autoCompaction} hint={t.settings.autoCompactionHint}>
								<Switch
									checked={settings.autoCompaction}
									onCheckedChange={(v) => onChange({ ...settings, autoCompaction: v })}
									ariaLabel={t.settings.autoCompaction}
								/>
							</Row>
							<Row label={t.settings.steeringMode} hint={t.settings.steeringModeHint}>
								<SettingSelect
									value={settings.steeringMode}
									onChange={(v) =>
										onChange({ ...settings, steeringMode: v as "all" | "one-at-a-time" })
									}
									options={[
										{ value: "all", label: t.settings.queueModeAll },
										{ value: "one-at-a-time", label: t.settings.queueModeOneAtATime },
									]}
								/>
							</Row>
							<Row label={t.settings.followUpMode} hint={t.settings.followUpModeHint}>
								<SettingSelect
									value={settings.followUpMode}
									// The TUI default is one-at-a-time; the local queue already
									// serializes delivery, so all/one-at-a-time maps to pi's
									// delivery granularity per turn.
									onChange={(v) =>
										onChange({ ...settings, followUpMode: v as "all" | "one-at-a-time" })
									}
									options={[
										{ value: "all", label: t.settings.queueModeAll },
										{ value: "one-at-a-time", label: t.settings.queueModeOneAtATime },
									]}
								/>
							</Row>
							<Row label={t.settings.scopedModels} hint={t.settings.scopedModelsHint}>
								<div className="scoped-models-row">
									<span className="scoped-models-count mono">
										{settings.scopedModels.length
											? settings.scopedModels.join(", ")
											: t.settings.scopedModelsEmpty}
									</span>
									<Btn onClick={onOpenScopedModels}>
										{t.settings.scopedModelsEdit}
									</Btn>
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
									<LlamaKeyField t={t} />
									<Btn onClick={onOpenLlama}>
										<TerminalIcon size={13} />
										<span>{t.settings.llamaManage}</span>
									</Btn>
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
										<Btn
											kind={trustDecision === true ? "primary" : "secondary"}
											small
											disabled={!workspace}
											onClick={() => onSetProjectTrust(trustDecision === true ? null : true)}
										>
											{t.settings.trustTrust}
										</Btn>
										<Btn
											kind={trustDecision === false ? "danger" : "secondary"}
											small
											disabled={!workspace}
											onClick={() => onSetProjectTrust(trustDecision === false ? null : false)}
										>
											{t.settings.trustDeny}
										</Btn>
									</div>
									<SettingSelect
										value={trustDefault}
										onChange={(v) => onSetDefaultTrust(v)}
										options={[
											{ value: "ask", label: t.settings.trustDefaultAsk },
											{ value: "always", label: t.settings.trustDefaultAlways },
											{ value: "never", label: t.settings.trustDefaultNever },
										]}
									/>
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
								<Btn small
									
									onClick={() => {
										setCpEditing(null);
										setCpDialogOpen(true);
									}}
								>
									<PlusIcon size={12} /> {t.settings.addProvider}
								</Btn>
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
													<Btn small
														
														onClick={() => {
															setCpConfirmDelete(null);
															setCpEditing(entry);
															setCpDialogOpen(true);
														}}
													>
														{t.settings.editProvider}
													</Btn>
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

							{oauthProviderIds.length > 0 && (
								<>
									<h4 className="settings-sub">{t.settings.oauthProviders}</h4>
									<ul className="provider-list">{oauthProviderIds.map(renderProviderRow)}</ul>
								</>
							)}
							{apiKeyProviderIds.length > 0 && (
								<>
									<h4 className="settings-sub">{t.settings.apiKeyProviders}</h4>
									<ul className="provider-list">{apiKeyProviderIds.map(renderProviderRow)}</ul>
								</>
							)}

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
							{oauthLoginProvider && (
								<OAuthDialog
									t={t}
									provider={oauthLoginProvider}
									providerLabel={providerLabel(oauthLoginProvider)}
									onDone={() => {
										refreshAuth();
										notify(
											t.settings.oauthSuccess.replace(
												"{provider}",
												providerLabel(oauthLoginProvider),
											),
										);
									}}
									onClose={() => setOauthLoginProvider(null)}
								/>
							)}
						</section>
					)}

					{page === "mcp" && (
						<section className="settings-section">
							<div className="settings-section-title-row">
								<h3>{t.settings.mcp}</h3>
								<div className="settings-section-actions">
									<IconActionButton
										icon={<RefreshIcon size={12} />}
										onClick={refreshMcpServers}
									>
										{t.sidebar.refresh}
									</IconActionButton>
									<Btn small
										
										onClick={() => {
											setMcpConfirmDelete(null);
											setMcpEditing(null);
											setMcpDialogOpen(true);
										}}
									>
										<PlusIcon size={12} /> {t.settings.mcpAdd}
									</Btn>
								</div>
							</div>
							<p className="settings-hint">{t.settings.mcpHint}</p>

							{!packagesLoading && !mcpAdapterInstalled && (
								<div className="mcp-adapter-notice">
									<span>{t.settings.mcpAdapterMissing}</span>
									<Btn small
										
										disabled={busySource === "npm:pi-mcp-adapter"}
										onClick={() => void handleInstall("npm:pi-mcp-adapter")}
									>
										{busySource === "npm:pi-mcp-adapter"
											? t.settings.packageBusy
											: t.settings.mcpAdapterInstall}
									</Btn>
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
															<Btn small
																
																onClick={() => {
																	setMcpConfirmDelete(null);
																	setMcpEditing(entry);
																	setMcpDialogOpen(true);
																}}
															>
																{t.settings.editProvider}
															</Btn>
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
													<Switch
														checked={!entry.disabled}
														onCheckedChange={() => void toggleMcpServer(entry)}
														ariaLabel={t.settings.mcpEnabled.replace("{name}", entry.name)}
													/>
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
									<IconActionButton icon={<RefreshIcon size={12} />} onClick={onReload}>
										{t.settings.reload}
									</IconActionButton>
									<IconActionButton icon={<RefreshIcon size={12} />} onClick={refreshPackages}>
										{t.sidebar.refresh}
									</IconActionButton>
								</div>
							</div>
							<p className="settings-hint">{t.settings.extensionsHint}</p>

							{/* ---- tab switcher: installed skills vs package catalog ---- */}
							<div className="usage-toggle ext-tabs" role="tablist" aria-label={t.settings.extensions}>
								<button
									role="tab"
									aria-selected={extTab === "skills"}
									className={extTab === "skills" ? "active" : ""}
									onClick={() => setExtTab("skills")}
								>
									{t.settings.skillsTab}
								</button>
								<button
									role="tab"
									aria-selected={extTab === "packages"}
									className={extTab === "packages" ? "active" : ""}
									onClick={() => setExtTab("packages")}
								>
									{t.settings.packagesTab}
								</button>
							</div>

							{extTab === "skills" ? (
								<>
									<p className="settings-hint">{t.settings.skillsHint}</p>
									{mcpScopeOptions.length > 0 && (
										<div className="mcp-toolbar">
											<ScopeSelect
												value={skillProject ?? ""}
												options={mcpScopeOptions}
												allowEmpty={false}
												t={t}
												onChange={setSkillProjectSel}
											/>
											<input
												className="mcp-search"
												value={skillQuery}
												placeholder={t.settings.searchSkills}
												spellCheck={false}
												onChange={(e) => setSkillQuery(e.target.value)}
											/>
										</div>
									)}
									{skillsLoading ? (
										<div className="settings-loading">{t.settings.loading}</div>
									) : skills.length === 0 ? (
										<div className="settings-empty">{t.settings.emptySkills}</div>
									) : (
										<SkillsList
											skills={skills}
											skillQuery={skillQuery}
											workspace={skillProject}
											t={t}
										/>
									)}
								</>
							) : (
								<></>
							)}

							{extTab === "packages" && (
								<>
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
														<Btn small
															
															disabled={busy}
															onClick={() => void handleRemove(source)}
														>
															{busy ? t.settings.packageBusy : t.settings.remove}
														</Btn>
													) : (
														<Btn kind="primary" small
															
															disabled={busy}
															onClick={() => void handleInstall(source)}
														>
															{busy ? t.settings.packageBusy : t.settings.install}
														</Btn>
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
								<Btn kind="primary" small
									
									disabled={!customSource.trim() || busySource === customSource.trim()}
									onClick={() => {
										void handleInstall(customSource.trim());
										setCustomSource("");
									}}
								>
									{t.settings.installSource}
								</Btn>
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
												<Btn kind="danger" small
													
													disabled={busySource === p.source}
													onClick={() => setPendingRemove(p.source)}
												>
													{t.settings.remove}
												</Btn>
												</li>
											))}
										</ul>
									</>
								)}
								</>
							)}
						</section>
					)}

					{page === "about" && (
						<section className="settings-section">
							<h3>{t.settings.about}</h3>
							<Row label={t.settings.currentVersion}>
								<span className="settings-value">{appVersion ?? updateInfo?.current ?? "—"}</span>
							</Row>
							<Row label={t.settings.updates} hint={t.settings.updatesHint}>
								<div className="update-control">
									<IconActionButton
										icon={<RefreshIcon size={12} />}
										busy={checkingUpdates}
										busyLabel={t.settings.checkingUpdates}
										disabled={!onCheckUpdates}
										onClick={() => onCheckUpdates?.()}
									>
										{t.settings.checkUpdates}
									</IconActionButton>
									{updateInfo &&
										(updateInfo.available ? (
											<span className="update-status available">
												{t.settings.updateAvailable}: {updateInfo.latest}
													{updateInfo.url && (
														<button
															className="link-btn"
															onClick={() => void openExternal(updateInfo.url).catch(() => {})}
														>
															{t.settings.downloadUpdate}
														</button>
													)}
											</span>
										) : (
											<span className="update-status">{t.settings.upToDate}</span>
										))}
								</div>
							</Row>
							{updateInfo?.available && updateInfo.notes && (
								<details className="update-notes">
									<summary>{t.settings.releaseNotes}</summary>
									<pre>{updateInfo.notes}</pre>
								</details>
							)}
							<Row label={t.settings.sdkSidecar}>
								<SidecarStatus t={t} />
							</Row>
							<Row label={t.settings.sessionDir}>
								<button className="link-btn" onClick={onOpenSessionDir} title={sessionDir}>
									{sessionDir}
								</button>
							</Row>
							<Row label={t.settings.diagnostics} hint={t.settings.diagnosticsHint}>
								<Btn
									
									disabled={exportingDiag}
									onClick={() => void handleExportDiagnostics()}
								>
									{t.settings.exportDiagnostics}
								</Btn>
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
										<Btn kind="danger" small onClick={onPurgeAll}>
											<TrashIcon size={13} />
											{t.settings.deleteAllArchived}
										</Btn>
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
