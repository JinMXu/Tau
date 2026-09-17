import { memo, useCallback, useEffect, useState } from "react";
import type { PiSessionInfo } from "../pi";
import type { MessageCatalog } from "../i18n";
import {
	AnimatedSidebarContent,
	AnimatedSidebarFooter,
	AnimatedSidebarGroup,
	AnimatedSidebarGroupContent,
	AnimatedSidebarGroupLabel,
	AnimatedSidebarMenu,
	AnimatedSidebarMenuButton,
	AnimatedSidebarMenuItem,
	AnimatedSidebarMenuSub,
	AnimatedSidebarMenuSubItem,
	AnimatedSidebarTrigger,
} from "./motion/animated-sidebar";
import {
	ArchiveIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	FolderIcon,
	FolderOpenIcon,
	MoreIcon,
	PanelLeftCloseIcon,
	PinIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	TrashIcon,
} from "../icons";
import { MOD_KEY, MOD_KEY_SEP, isMac, sameSessionPath } from "../platform";
import { projectNameFromPath } from "../format";

function timeAgo(ms: number, lang: "zh" | "en"): string {
	const diff = Date.now() - ms;
	const min = 60_000;
	const hour = 60 * min;
	const day = 24 * hour;
	if (diff < min) return lang === "zh" ? "刚刚" : "now";
	if (diff < hour)
		return lang === "zh" ? `${Math.floor(diff / min)}分钟` : `${Math.floor(diff / min)}m`;
	if (diff < day)
		return lang === "zh" ? `${Math.floor(diff / hour)}小时` : `${Math.floor(diff / hour)}h`;
	if (diff < 365 * day)
		return lang === "zh" ? `${Math.floor(diff / day)}天` : `${Math.floor(diff / day)}d`;
	return new Date(ms).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
		month: "short",
		day: "numeric",
	});
}

/**
 * The sidebar's inner content. Must be rendered inside <AnimatedSidebar>
 * (which itself sits inside <AnimatedSidebarProvider> in App.tsx) — the beUI
 * menu parts read the panel state from context to drive the collapse
 * animations.
 */
export const Sidebar = memo(function Sidebar({
	t,
	lang,
	sessions,
	selectedPath,
	expandedProjects,
	onToggleProject,
	onSelectSession,
	onBack,
	onForward,
	canGoBack,
	canGoForward,
	pinnedSessions,
	onTogglePin,
	onArchiveSession,
	onNewTask,
	onNewTaskInProject,
	onOpenWorkspace,
	onOpenSettings,
	onOpenSearch,
	onMoveSession,
	onRevealProject,
	onDeleteProject,
	sessionOrder,
	onReorderSession,
	busy,
	binError,
	workingPaths,
}: {
	t: MessageCatalog;
	lang: "zh" | "en";
	sessions: PiSessionInfo[];
	selectedPath: string | null;
	expandedProjects: Set<string>;
	onToggleProject: (project: string) => void;
	onSelectSession: (s: PiSessionInfo) => void;
	onBack: () => void;
	onForward: () => void;
	canGoBack: boolean;
	canGoForward: boolean;
	pinnedSessions: string[];
	onTogglePin: (path: string) => void;
	onArchiveSession: (path: string) => void;
	onNewTask: () => void;
	onNewTaskInProject: (project: string) => void;
	onOpenWorkspace: () => void;
	onOpenSettings: () => void;
	onOpenSearch: () => void;
	onMoveSession: (path: string) => void;
	onRevealProject: (path: string) => void;
	onDeleteProject: (path: string) => void;
	sessionOrder: string[];
	onReorderSession: (order: string[]) => void;
	busy: boolean;
	binError: string | null;
	workingPaths: string[];
}) {
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [dragPath, setDragPath] = useState<string | null>(null);

	// Close the "move to project" popup on outside click or Escape (the popup
	// and its toggle button stop mousedown propagation so they keep working).
	useEffect(() => {
		if (!menuPath) return;
		const onDown = () => setMenuPath(null);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuPath(null);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [menuPath]);

	const orderedList = useCallback(
		(list: PiSessionInfo[]) => {
			const orderMap = new Map(sessionOrder.map((p, i) => [p, i]));
			const pinnedSet = new Set(pinnedSessions);
			return [...list].sort((a, b) => {
				// Pinned sessions float to the top of their project group.
				const ap = pinnedSet.has(a.path) ? 0 : 1;
				const bp = pinnedSet.has(b.path) ? 0 : 1;
				if (ap !== bp) return ap - bp;
				const ai = orderMap.get(a.path);
				const bi = orderMap.get(b.path);
				if (ai === undefined && bi === undefined) return 0;
				if (ai === undefined) return 1;
				if (bi === undefined) return -1;
				return ai - bi;
			});
		},
		[sessionOrder, pinnedSessions],
	);

	const handleDrop = useCallback(
		(dragged: string, target: string) => {
			if (dragged === target) return;
			// Keep global custom order; append any paths not yet ordered.
			const base = sessionOrder.length ? sessionOrder : sessions.map((s) => s.path);
			const next = base.filter((p) => p !== dragged);
			const idx = next.indexOf(target);
			if (idx < 0) next.push(dragged);
			else next.splice(idx, 0, dragged);
			onReorderSession(next);
			setDragPath(null);
		},
		[sessionOrder, sessions, onReorderSession],
	);

	const groups = new Map<string, PiSessionInfo[]>();
	const defaultKey = "__default__";
	for (const s of sessions) {
		const key = s.project ?? defaultKey;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(s);
	}
	const ordered = [...groups.entries()];

	return (
		<>
			<div className="sidebar-brand" data-tauri-drag-region={isMac ? "deep" : undefined}>
				<AnimatedSidebarTrigger
					className="icon-btn size-[26px] rounded-[var(--r-sm)]"
					title={t.sidebar.collapse}
					aria-label={t.sidebar.collapse}
				>
					<PanelLeftCloseIcon size={16} />
				</AnimatedSidebarTrigger>
				<div className="sidebar-nav-btns">
					<button
						className="icon-btn"
						title={t.sidebar.back}
						aria-label={t.sidebar.back}
						disabled={!canGoBack}
						onClick={onBack}
					>
						<ChevronLeftIcon size={16} />
					</button>
					<button
						className="icon-btn"
						title={t.sidebar.forward}
						aria-label={t.sidebar.forward}
						disabled={!canGoForward}
						onClick={onForward}
					>
						<ChevronRightIcon size={16} />
					</button>
				</div>
			</div>

			{binError && <div className="bin-error">{binError}</div>}

			<AnimatedSidebarContent>
				<AnimatedSidebarGroup>
					<AnimatedSidebarMenu>
						<AnimatedSidebarMenuItem>
							<AnimatedSidebarMenuButton
								icon={<PlusIcon size={15} />}
								badge={
									<kbd className="sidebar-kbd">
										{MOD_KEY}
										{MOD_KEY_SEP}N
									</kbd>
								}
								disabled={busy}
								onSelect={onNewTask}
							>
								{t.sidebar.newTask}
							</AnimatedSidebarMenuButton>
						</AnimatedSidebarMenuItem>
						<AnimatedSidebarMenuItem>
							<AnimatedSidebarMenuButton
								icon={<SearchIcon size={15} />}
								badge={
									<kbd className="sidebar-kbd">
										{MOD_KEY}
										{MOD_KEY_SEP}K
									</kbd>
								}
								onSelect={onOpenSearch}
							>
								{t.app.search}
							</AnimatedSidebarMenuButton>
						</AnimatedSidebarMenuItem>
					</AnimatedSidebarMenu>
				</AnimatedSidebarGroup>

				<AnimatedSidebarGroup>
					<AnimatedSidebarGroupLabel className="flex items-center justify-between">
						<span>{t.sidebar.projects}</span>
						<button
							className="icon-btn"
							onClick={onOpenWorkspace}
							title={t.sidebar.addProject}
							aria-label={t.sidebar.addProject}
						>
							<PlusIcon size={14} />
						</button>
					</AnimatedSidebarGroupLabel>
					<AnimatedSidebarGroupContent>
						<AnimatedSidebarMenu>
							{ordered.map(([project, list]) => {
								const key = project === defaultKey ? "__default__" : project;
								const expanded = expandedProjects.has(key);
								const label =
									project === defaultKey
										? t.sidebar.defaultProject
										: projectNameFromPath(project);
								return (
									<AnimatedSidebarMenuItem key={key} className="project-menu-item">
										{/* relative row so the hover actions anchor to the
										    group header even when the session list below is
										    expanded (SharedLayoutBg's wrapper spans it all) */}
										<div className="project-header-row">
										<AnimatedSidebarMenuButton
											icon={
												expanded ? (
													<FolderOpenIcon size={14} />
												) : (
													<FolderIcon size={14} />
												)
											}
											ariaExpanded={expanded}
											onSelect={() => onToggleProject(key)}
										>
											{label}
										</AnimatedSidebarMenuButton>
										{project !== defaultKey && (
											<div className="project-row-actions">
													<button
														className="icon-btn"
														title={t.sidebar.newTaskInProject}
														aria-label={t.sidebar.newTaskInProject}
														onClick={() => onNewTaskInProject(project)}
													>
														<PlusIcon size={13} />
													</button>
													<button
														className="icon-btn"
														title={t.sidebar.showProjectInFolder}
														onClick={() => onRevealProject(project)}
													>
														<FolderOpenIcon size={13} />
													</button>
													<button
														className="icon-btn"
														title={t.sidebar.deleteProject}
														onClick={() => onDeleteProject(project)}
													>
														<TrashIcon size={13} />
													</button>
												</div>
											)}
										</div>
										<AnimatedSidebarMenuSub open={expanded}>
											{orderedList(list).map((s) => {
												const pinned = pinnedSessions.includes(s.path);
												const isWorking = workingPaths.some((p) =>
													sameSessionPath(p, s.path),
												);
												return (
													<AnimatedSidebarMenuSubItem key={s.path}>
														<div
															className={`session-row ${
																s.path === selectedPath ? "active" : ""
															} ${dragPath === s.path ? "dragging" : ""} ${pinned ? "pinned" : ""} ${s.pending ? "pending" : ""}`}
															draggable={!s.pending}
															onDragStart={(e) => {
																setDragPath(s.path);
																e.dataTransfer.effectAllowed = "move";
															}}
															onDragOver={(e) => e.preventDefault()}
															onDrop={(e) => {
																e.preventDefault();
																if (dragPath) handleDrop(dragPath, s.path);
															}}
															onClick={() => onSelectSession(s)}
															// The row is the primary "open this session"
															// target; give it button semantics and make it
															// reachable/operable from the keyboard (the
															// hover actions are focusable but they only
															// pin/archive — they never opened a session).
															role="button"
															tabIndex={s.pending ? -1 : 0}
															aria-current={
																s.path === selectedPath ? "true" : undefined
															}
															onKeyDown={(e) => {
																if (s.pending) return;
																if (e.key === "Enter" || e.key === " ") {
																	e.preventDefault();
																	onSelectSession(s);
																}
															}}
															title={s.pending ? s.title : `${s.title}\n${s.path}`}
														>
															<div className="session-main">
																<span className="session-title">{s.title}</span>
																{isWorking && (
																	<span
																		className="session-spinner"
																		title={t.sidebar.working}
																	/>
																)}
																<span className="session-time">
																	{timeAgo(s.mtimeMs, lang)}
																</span>
															</div>
															{!s.pending && (
																<div
																	className="session-actions"
																	onClick={(e) => e.stopPropagation()}
																>
																	<button
																		className="icon-btn pin-btn"
																		title={pinned ? t.sidebar.unpin : t.sidebar.pin}
																		onClick={() => onTogglePin(s.path)}
																	>
																		<PinIcon size={13} />
																	</button>
																	<button
																		className="icon-btn"
																		title={t.sidebar.archiveSession}
																		onClick={() => onArchiveSession(s.path)}
																	>
																		<ArchiveIcon size={13} />
																	</button>
																	<button
																		className="icon-btn"
																		title={t.sidebar.moveToProject}
																		aria-label={t.sidebar.moreActions}
																		aria-expanded={menuPath === s.path}
																		onMouseDown={(e) => e.stopPropagation()}
																		onClick={() =>
																			setMenuPath(menuPath === s.path ? null : s.path)
																		}
																	>
																		<MoreIcon size={13} />
																	</button>
																	{menuPath === s.path && (
																		<div
																			className="session-pop"
																			onMouseDown={(e) => e.stopPropagation()}
																		>
																			<button
																				onClick={() => {
																					onMoveSession(s.path);
																					setMenuPath(null);
																				}}
																			>
																				<FolderIcon size={13} />
																				<span>{t.sidebar.moveToProject}</span>
																			</button>
																		</div>
																	)}
																</div>
															)}
														</div>
													</AnimatedSidebarMenuSubItem>
												);
											})}
										</AnimatedSidebarMenuSub>
									</AnimatedSidebarMenuItem>
								);
							})}
						</AnimatedSidebarMenu>
					</AnimatedSidebarGroupContent>
				</AnimatedSidebarGroup>

				{ordered.length === 0 && <div className="sidebar-empty">{t.sidebar.noSessions}</div>}
			</AnimatedSidebarContent>

			<AnimatedSidebarFooter>
				<AnimatedSidebarMenu>
					<AnimatedSidebarMenuItem>
						<AnimatedSidebarMenuButton
							icon={<SettingsIcon size={15} />}
							badge={
								<kbd className="sidebar-kbd">
									{MOD_KEY}
									{MOD_KEY_SEP},
								</kbd>
							}
							onSelect={onOpenSettings}
						>
							{t.app.settings}
						</AnimatedSidebarMenuButton>
					</AnimatedSidebarMenuItem>
				</AnimatedSidebarMenu>
			</AnimatedSidebarFooter>
		</>
	);
});
