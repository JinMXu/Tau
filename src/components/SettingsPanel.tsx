import { useCallback, useEffect, useState } from "react";
import type { PiArchivedSession, PiBinaryInfo } from "../pi";
import {
	authRemove,
	authSetKey,
	authStatus,
	piInstalledSkills,
	piPackageInstall,
	piPackageRemove,
	piPackages,
	piProviders,
	type AuthProviderStatus,
	type PiPackageEntry,
	type PiSkillEntry,
} from "../pi";
import { projectNameFromPath, type MessageCatalog } from "../i18n";
import {
	ArchiveIcon,
	BarChartIcon,
	BoltIcon,
	CheckIcon,
	ChevronLeftIcon,
	CopyIcon,
	EditIcon,
	EyeIcon,
	GridIcon,
	InfoIcon,
	RefreshIcon,
	RestoreIcon,
	SettingsIcon,
	SparkleIcon,
	TerminalIcon,
	TrashIcon,
} from "../icons";
import type { AppSettings, ColorScale, Density, Theme } from "../settings";
import { ALL_AGENT_TOOLS } from "../settings";
import { PACKAGES_CATALOG, formatDownloads } from "../packages-catalog";
import { UsageStats } from "./UsageStats";

type SettingsPage =
	| "general"
	| "appearance"
	| "providers"
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
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="settings-row">
			<div className="settings-label">
				{label}
				{hint && <p className="settings-hint">{hint}</p>}
			</div>
			<div className="settings-control">{children}</div>
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

	const copyLoginCmd = async () => {
		try {
			await navigator.clipboard.writeText(`pi\n/login ${provider}`);
			setCopiedCmd(true);
			setTimeout(() => setCopiedCmd(false), 1500);
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
						<button
							className="btn danger small"
							disabled={busy}
							onClick={() => void clear()}
						>
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
						<button className="icon-btn" title={t.chat.copy} onClick={() => void copyLoginCmd()}>
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
	onRestoreAll,
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
}: {
	t: MessageCatalog;
	settings: AppSettings;
	onChange: (s: AppSettings) => void;
	binary: PiBinaryInfo | null;
	sessionDir: string;
	archived: PiArchivedSession[];
	onRestore: (path: string) => void;
	onPurge: (path: string) => void;
	onRestoreAll: () => void;
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
	const [selectedArchived, setSelectedArchived] = useState<Set<string>>(
		() => new Set(),
	);
	const [packageQuery, setPackageQuery] = useState("");

	// Drop selections whose rows disappeared (restored or purged elsewhere).
	useEffect(() => {
		setSelectedArchived((prev) => {
			const valid = new Set(archived.map((a) => a.path));
			const next = new Set([...prev].filter((p) => valid.has(p)));
			return next.size === prev.size ? prev : next;
		});
	}, [archived]);

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
		navGroups.flatMap((g) => g.items).find((i) => i.id === page)?.label ??
		t.settings.title;

	// ---- provider auth ----
	const [auth, setAuth] = useState<AuthProviderStatus[]>([]);
	const [toastMsg, setToastMsg] = useState<string | null>(null);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	// Provider list mirrors the TUI: whatever the installed pi can configure
	// (built-in catalog + models.json customs + providers with stored keys).
	// Falls back to the bundled list when pi isn't installed or its catalog
	// isn't on disk.
	const [providerIds, setProviderIds] = useState<string[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		piProviders()
			.then((list) => {
				if (cancelled) return;
				const ids = list.some((p) => p.known)
					? list.map((p) => p.id)
					: [
							...new Set([
								...FALLBACK_PROVIDER_IDS,
								...list.map((p) => p.id),
							]),
						];
				setProviderIds(ids);
			})
			.catch(() => {
				if (!cancelled) setProviderIds(FALLBACK_PROVIDER_IDS);
			});
		return () => {
			cancelled = true;
		};
	}, []);
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
		setTimeout(() => setToastMsg(null), 2200);
	}, []);
	const notifyError = useCallback((msg: string) => {
		setErrorMsg(msg);
		setTimeout(() => setErrorMsg(null), 4000);
	}, []);

	// ---- packages & skills ----
	// Cache extension data for the app session so reopening the settings panel
	// renders instantly instead of re-running `pi list` every time.
	const [packages, setPackages] = useState<PiPackageEntry[]>(() =>
		extensionCache?.packages ?? [],
	);
	const [skills, setSkills] = useState<PiSkillEntry[]>(() =>
		extensionCache?.skills ?? [],
	);
	const [packagesLoading, setPackagesLoading] = useState(!extensionCache);
	const [skillsLoading, setSkillsLoading] = useState(!extensionCache);
	const [customSource, setCustomSource] = useState("");
	const [busySource, setBusySource] = useState<string | null>(null);

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
		packages
			.filter((p) => p.packageName)
			.map((p) => p.packageName as string),
	);
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
									onClick={() =>
										onChange({ ...settings, colorScale: c.id })
									}
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
							<span className="switch-track"><span /></span>
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
							<span className="switch-track"><span /></span>
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
							<span className="switch-track"><span /></span>
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
							<span className="switch-track"><span /></span>
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
							<button
								className="btn secondary"
								onClick={onOpenScopedModels}
							>
								{t.settings.scopedModelsEdit}
							</button>
						</div>
					</Row>
					<Row label={t.settings.excludedTools} hint={t.settings.excludedToolsHint}>
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
													excludedTools: ALL_AGENT_TOOLS.filter((x) =>
															next.has(x),
														),
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
					<Row label={t.settings.llama} hint={t.settings.llamaHint}>
						<div className="llama-settings-row">
							<input
								className="llama-url-input mono"
								value={settings.llamaServerUrl}
								placeholder="http://127.0.0.1:8080"
								spellCheck={false}
								onChange={(e) =>
									onChange({ ...settings, llamaServerUrl: e.target.value })
								}
							/>
							<input
								type="password"
								className="llama-key-input mono"
								value={settings.llamaApiKey}
								placeholder={t.settings.llamaApiKeyPlaceholder}
								spellCheck={false}
								onChange={(e) =>
									onChange({ ...settings, llamaApiKey: e.target.value })
								}
							/>
							<button className="btn secondary" onClick={onOpenLlama}>
								<TerminalIcon size={13} />
								<span>{t.settings.llamaManage}</span>
							</button>
						</div>
					</Row>
					<Row label={t.settings.trust} hint={t.settings.trustHint}>
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
					<ul className="provider-list">
						{providers.map((id) => (
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
						onChange={(e) =>
							onChange({ ...settings, systemPrompt: e.target.value })
						}
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
						onChange={(e) =>
							onChange({ ...settings, appendSystemPrompt: e.target.value })
						}
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
									{s.description && (
										<div className="skill-desc">{s.description}</div>
									)}
									<span className={`skill-location ${s.location}`}>
										{s.location}
									</span>
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
									<li key={pkg.name} className={`package-item ${installed ? "installed" : ""}`}>
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
													<span key={ty} className="package-type">{ty}</span>
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
											onClick={() => void handleRemove(p.source)}
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
							{binary ? `${binary.version} · ${binary.bin}` : t.settings.binError}
						</span>
					</Row>
					<Row label={t.settings.sessionDir}>
						<button className="link-btn" onClick={onOpenSessionDir} title={sessionDir}>
							{sessionDir}
						</button>
					</Row>
					</section>
					)}

					{page === "usage" && (
					<section className="settings-section">
						<h3>{t.settings.usage}</h3>
						<UsageStats t={t} />
					</section>
					)}

					{page === "archived" && (
					<section className="settings-section">
						<div className="settings-section-title-row">
							<h3>{t.sidebar.archived}</h3>
						{archived.length > 0 && (
							<div className="settings-section-actions">
								{selectedArchived.size > 0 && (
									<button
										className="link-btn"
										onClick={() => {
												const paths = [...selectedArchived];
												setSelectedArchived(new Set());
												paths.forEach((p) => onRestore(p));
											}}
									>
										{t.settings.restoreSelected} ({selectedArchived.size})
									</button>
								)}
								<button className="link-btn" onClick={onRestoreAll}>
									{t.settings.restoreAll}
								</button>
							</div>
						)}
					</div>
					{archived.length === 0 ? (
						<div className="settings-empty">{t.settings.emptyArchived}</div>
					) : (
						<ul className="archived-list">
							{archived.map((a) => (
								<li
									key={a.path}
									className={
										selectedArchived.has(a.path) ? "archived-row selected" : "archived-row"
									}
								>
									<label className="archived-check">
										<input
											type="checkbox"
											checked={selectedArchived.has(a.path)}
											onChange={(e) =>
												setSelectedArchived((prev) => {
													const next = new Set(prev);
													if (e.target.checked) next.add(a.path);
													else next.delete(a.path);
													return next;
												})
											}
										/>
										<span className="switch-check" />
									</label>
									<div className="archived-info">
										<span className="archived-title">{a.title}</span>
										<span className="archived-path" title={a.path}>
											{a.project ?? a.originalPath}
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
											className="icon-btn"
											title={t.sidebar.restore}
											onClick={() => onRestore(a.path)}
										>
											<RestoreIcon size={14} />
										</button>
										<button
											className="icon-btn danger"
											title={t.settings.deletePermanently}
											onClick={() => onPurge(a.path)}
										>
											<TrashIcon size={14} />
										</button>
									</div>
								</li>
							))}
						</ul>
					)}
					</section>
					)}
				</div>
			</div>
		</div>
	);
}
