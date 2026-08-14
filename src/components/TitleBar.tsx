import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MessageCatalog } from "../i18n";
import { MOD_KEY } from "../platform";
import {
	MaximizeIcon,
	MinusIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	RestoreWindowIcon,
	XIcon,
} from "../icons";

/** Mirrors the (non-exported) ResizeDirection union in @tauri-apps/api. */
type ResizeDirection =
	| "East"
	| "North"
	| "NorthEast"
	| "NorthWest"
	| "South"
	| "SouthEast"
	| "SouthWest"
	| "West";

const appWindow = getCurrentWindow();

type MenuEntry =
	| { kind: "item"; label: string; shortcut?: string; action: () => void }
	| { kind: "sep" };

/**
 * Text-edit menu commands. `document.execCommand` is deprecated but still
 * the only reliable way to cut/copy/paste against the focused selection in
 * both WebView2 and WKWebView; for copy we additionally fall back to the
 * Clipboard API when execCommand reports failure.
 */
function editCmd(cmd: string) {
	let ok: boolean;
	try {
		ok = document.execCommand(cmd);
	} catch {
		ok = false;
	}
	if (!ok && cmd === "copy") {
		const sel = window.getSelection()?.toString();
		if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
	}
}

async function toggleFullscreen() {
	await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
}

/** Invisible edge strips that give the borderless window native-feel resizing. */
const RESIZE_EDGES: Array<{ dir: ResizeDirection; style: React.CSSProperties }> = [
	{ dir: "North", style: { top: 0, left: 10, right: 10, height: 5, cursor: "n-resize" } },
	{ dir: "South", style: { bottom: 0, left: 10, right: 10, height: 5, cursor: "s-resize" } },
	{ dir: "West", style: { left: 0, top: 10, bottom: 10, width: 5, cursor: "w-resize" } },
	{ dir: "East", style: { right: 0, top: 10, bottom: 10, width: 5, cursor: "e-resize" } },
	{ dir: "NorthWest", style: { top: 0, left: 0, width: 10, height: 10, cursor: "nw-resize" } },
	{ dir: "NorthEast", style: { top: 0, right: 0, width: 10, height: 10, cursor: "ne-resize" } },
	{ dir: "SouthWest", style: { bottom: 0, left: 0, width: 10, height: 10, cursor: "sw-resize" } },
	{ dir: "SouthEast", style: { bottom: 0, right: 0, width: 10, height: 10, cursor: "se-resize" } },
];

export function TitleBar({
	t,
	onOpenSettings,
	onNewWindow,
	sidebarCollapsed,
	onToggleSidebar,
	onPeekSidebar,
	onPeekSidebarLeave,
	extensionStatus = [],
	onOpenSessionInfo,
	onOpenTree,
}: {
	t: MessageCatalog;
	onOpenSettings: () => void;
	onNewWindow: () => void;
	sidebarCollapsed: boolean;
	onToggleSidebar: () => void;
	onPeekSidebar: () => void;
	onPeekSidebarLeave: () => void;
	extensionStatus?: string[];
	onOpenSessionInfo?: () => void;
	onOpenTree?: () => void;
}) {
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const [maximized, setMaximized] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		void appWindow.isMaximized().then(setMaximized);
		const unlisten = appWindow.onResized(() => {
			void appWindow.isMaximized().then(setMaximized);
		});
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	useEffect(() => {
		if (!openMenu) return;
		function onDown(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpenMenu(null);
			}
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpenMenu(null);
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [openMenu]);

	const menus: Array<{ id: string; label: string; entries: MenuEntry[] }> = [
		{
			id: "app",
			label: t.menu.app,
			entries: [
				{ kind: "item", label: t.menu.newWindow, shortcut: `${MOD_KEY}Shift+N`, action: onNewWindow },
				{ kind: "sep" },
				{ kind: "item", label: t.menu.about, action: onOpenSettings },
			],
		},
		{
			id: "edit",
			label: t.menu.edit,
			entries: [
				{ kind: "item", label: t.menu.undo, shortcut: `${MOD_KEY}Z`, action: () => editCmd("undo") },
				{ kind: "item", label: t.menu.redo, shortcut: `${MOD_KEY}Y`, action: () => editCmd("redo") },
				{ kind: "sep" },
				{ kind: "item", label: t.menu.cut, shortcut: `${MOD_KEY}X`, action: () => editCmd("cut") },
				{ kind: "item", label: t.menu.copy, shortcut: `${MOD_KEY}C`, action: () => editCmd("copy") },
				{ kind: "item", label: t.menu.paste, shortcut: `${MOD_KEY}V`, action: () => editCmd("paste") },
				{ kind: "item", label: t.menu.selectAll, shortcut: `${MOD_KEY}A`, action: () => editCmd("selectAll") },
			],
		},
		{
			id: "view",
			label: t.menu.view,
			entries: [
				{ kind: "item", label: t.menu.fullscreen, action: () => void toggleFullscreen() },
				...(onOpenSessionInfo
					? [{ kind: "item" as const, label: t.chat.sessionInfo, action: onOpenSessionInfo }]
					: []),
				...(onOpenTree
					? [{ kind: "item" as const, label: t.chat.tree, action: onOpenTree }]
					: []),
			],
		},
	];

	return (
		<>
			{RESIZE_EDGES.map((e) => (
				<div
					key={e.dir}
					className="resize-edge"
					style={e.style}
					onMouseDown={(ev) => {
						if (ev.button === 0) void appWindow.startResizeDragging(e.dir);
					}}
				/>
			))}
			<div className="titlebar" ref={rootRef}>
				<div className="titlebar-left">
					<button
						className="titlebar-sidebar-btn"
						title={
							sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse
						}
						onClick={onToggleSidebar}
						onMouseEnter={onPeekSidebar}
						onMouseLeave={onPeekSidebarLeave}
					>
						{sidebarCollapsed ? (
							<PanelLeftOpenIcon size={15} />
						) : (
							<PanelLeftCloseIcon size={15} />
						)}
					</button>
					{menus.map((menu) => (
						<div className="titlebar-menu" key={menu.id}>
							<button
								className={`titlebar-menu-btn${openMenu === menu.id ? " open" : ""}`}
								onClick={() =>
									setOpenMenu((v) => (v === menu.id ? null : menu.id))
								}
								onMouseEnter={() => {
									if (openMenu && openMenu !== menu.id) setOpenMenu(menu.id);
								}}
							>
								{menu.label}
							</button>
							{openMenu === menu.id && (
								<div className="titlebar-menu-pop">
									{menu.entries.map((entry, i) =>
										entry.kind === "sep" ? (
											<div className="menu-sep" key={i} />
										) : (
											<button
												key={entry.label}
												onClick={() => {
													setOpenMenu(null);
													entry.action();
												}}
											>
												<span>{entry.label}</span>
												{entry.shortcut && <kbd>{entry.shortcut}</kbd>}
											</button>
										),
									)}
								</div>
							)}
						</div>
					))}
				</div>
				<div
					className="titlebar-drag"
					onMouseDown={(e) => {
						if (e.button === 0) void appWindow.startDragging();
					}}
					onDoubleClick={() => void appWindow.toggleMaximize()}
				>
					{extensionStatus.length > 0 && (
						<div className="titlebar-status">
							{extensionStatus.map((s, i) => (
								<span key={i} className="titlebar-status-item" title={s}>
									{s}
								</span>
							))}
						</div>
					)}
				</div>
				<div className="titlebar-controls">
					<button
						className="win-btn"
						title={t.menu.minimize}
						onClick={() => void appWindow.minimize()}
					>
						<MinusIcon size={13} />
					</button>
					<button
						className="win-btn"
						title={t.menu.maximize}
						onClick={() => void appWindow.toggleMaximize()}
					>
						{maximized ? (
							<RestoreWindowIcon size={12} />
						) : (
							<MaximizeIcon size={12} />
						)}
					</button>
					<button
						className="win-btn close"
						title={t.menu.close}
						onClick={() => void appWindow.close()}
					>
						<XIcon size={13} />
					</button>
				</div>
			</div>
		</>
	);
}
