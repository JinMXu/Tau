import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MessageCatalog } from "../i18n";
import { MOD_KEY, MOD_KEY_SEP } from "../platform";
import { MaximizeIcon, MinusIcon, RestoreWindowIcon, XIcon } from "../icons";

/** Mirrors the (non-exported) ResizeDirection union in @tauri-apps/api. */
type ResizeDirection =
	"East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const appWindow = getCurrentWindow();

type MenuEntry =
	{ kind: "item"; label: string; shortcut?: string; action: () => void } | { kind: "sep" };

/**
 * Text-edit menu commands. `document.execCommand` is deprecated but still
 * the only reliable way to cut/copy/paste against the focused selection in
 * WebView2; for copy we additionally fall back to the Clipboard API when
 * execCommand reports failure.
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

// Invisible edge strips that give the borderless window native-feel resizing.
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

async function toggleFullscreen() {
	await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
}

/**
 * Custom window title bar for Windows. Because the windows are undecorated
 * (tauri.windows.conf.json), this bar acts as the title bar: the menu bar
 * (brand + App/Edit/View) sits on the left sharing the SAME row as the
 * minimize / zoom / close window controls on the right. The middle strip is
 * a drag region, and the invisible edge strips enable native resizing.
 */
export function TitleBar({
	t,
	onNewWindow,
	onOpenSettings,
	onToggleSidebar,
	onSessionInfo,
	onTree,
}: {
	t: MessageCatalog;
	onNewWindow: () => void;
	onOpenSettings: () => void;
	onToggleSidebar: () => void;
	onSessionInfo: () => void;
	onTree: () => void;
}) {
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const [maximized, setMaximized] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let mounted = true;
		const refresh = () => {
			void appWindow.isMaximized().then((m) => {
				if (mounted) setMaximized(m);
			});
		};
		refresh();
		const unlisten = appWindow.onResized(refresh);
		return () => {
			mounted = false;
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
				{
					kind: "item",
					label: t.menu.newWindow,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}Shift+N`,
					action: onNewWindow,
				},
				{ kind: "sep" },
				{ kind: "item", label: t.menu.about, action: onOpenSettings },
			],
		},
		{
			id: "edit",
			label: t.menu.edit,
			entries: [
				{
					kind: "item",
					label: t.menu.undo,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}Z`,
					action: () => editCmd("undo"),
				},
				{
					kind: "item",
					label: t.menu.redo,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}Y`,
					action: () => editCmd("redo"),
				},
				{ kind: "sep" },
				{
					kind: "item",
					label: t.menu.cut,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}X`,
					action: () => editCmd("cut"),
				},
				{
					kind: "item",
					label: t.menu.copy,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}C`,
					action: () => editCmd("copy"),
				},
				{
					kind: "item",
					label: t.menu.paste,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}V`,
					action: () => editCmd("paste"),
				},
				{
					kind: "item",
					label: t.menu.selectAll,
					shortcut: `${MOD_KEY}${MOD_KEY_SEP}A`,
					action: () => editCmd("selectAll"),
				},
			],
		},
		{
			id: "view",
			label: t.menu.view,
			entries: [
				{ kind: "item", label: t.menu.fullscreen, action: () => void toggleFullscreen() },
				{ kind: "sep" },
				{ kind: "item", label: t.sidebar.collapse, action: onToggleSidebar },
				{ kind: "item", label: t.chat.sessionInfo, action: onSessionInfo },
				{ kind: "item", label: t.chat.tree, action: onTree },
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
					<span className="app-brand">Tau</span>
					{menus.map((menu) => (
						<div className="app-menu" key={menu.id}>
							<button
								className={`app-menu-btn${openMenu === menu.id ? " open" : ""}`}
								onClick={() => setOpenMenu((v) => (v === menu.id ? null : menu.id))}
								onMouseEnter={() => {
									if (openMenu && openMenu !== menu.id) setOpenMenu(menu.id);
								}}
							>
								{menu.label}
							</button>
							{openMenu === menu.id && (
								<div className="app-menu-pop">
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
				/>
				<div className="titlebar-controls">
					<button
						className="win-btn"
						title={t.menu.minimize}
						aria-label={t.menu.minimize}
						onClick={() => void appWindow.minimize()}
					>
						<MinusIcon size={14} />
					</button>
					<button
						className="win-btn"
						title={maximized ? t.menu.restore : t.menu.maximize}
						aria-label={maximized ? t.menu.restore : t.menu.maximize}
						onClick={() => void appWindow.toggleMaximize()}
					>
						{maximized ? <RestoreWindowIcon size={13} /> : <MaximizeIcon size={13} />}
					</button>
					<button
						className="win-btn close"
						title={t.menu.close}
						aria-label={t.menu.close}
						onClick={() => void appWindow.close()}
					>
						<XIcon size={14} />
					</button>
				</div>
			</div>
		</>
	);
}
