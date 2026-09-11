import type { MessageCatalog } from "../i18n";
import { MOD_KEY, MOD_KEY_SEP } from "../platform";
import { Modal } from "./Modal";

interface HotkeyRow {
	keys: string[];
	label: string;
}

/** `/hotkeys` equivalent: a static reference of Tau + pi shortcuts. */
export function HotkeysDialog({
	open,
	t,
	onClose,
}: {
	open: boolean;
	t: MessageCatalog;
	onClose: () => void;
}) {
	if (!open) return null;

	const mod = MOD_KEY;
	const modSep = MOD_KEY_SEP;
	const groups: { title: string; rows: HotkeyRow[] }[] = [
		{
			title: t.hotkeys.app,
			rows: [
				{ keys: [`${mod}${modSep}K`], label: t.hotkeys.search },
				{ keys: [`${mod}${modSep}N`], label: t.hotkeys.newTask },
				{ keys: [`${mod}${modSep}Shift+N`], label: t.hotkeys.newWindow },
				{ keys: [`${mod}${modSep},`], label: t.hotkeys.settings },
				{ keys: [`${mod}${modSep}B`], label: t.hotkeys.toggleSidebar },
				{ keys: [`${mod}${modSep}L`], label: t.hotkeys.focusComposer },
				{ keys: [`${mod}${modSep}F`], label: t.hotkeys.searchInSession },
				{ keys: [`${mod}${modSep}Shift+A`], label: t.hotkeys.archiveSession },
				{ keys: ["Esc"], label: t.hotkeys.interrupt },
				{ keys: [`${mod}${modSep}P`], label: t.hotkeys.cycleModel },
				{ keys: ["Shift+Tab"], label: t.hotkeys.cycleThinking },
			],
		},
		{
			title: t.hotkeys.editor,
			rows: [
				{ keys: ["Enter"], label: t.hotkeys.send },
				{ keys: ["Shift+Enter"], label: t.hotkeys.newLine },
				{ keys: ["↑", "↓"], label: t.hotkeys.promptHistory },
				{ keys: ["Tab"], label: t.hotkeys.completePath },
				{ keys: ["@"], label: t.hotkeys.referenceFile },
				{ keys: ["!"], label: t.hotkeys.shellCommand },
				{ keys: ["!!"], label: t.hotkeys.shellHidden },
				{ keys: ["Ctrl+G"], label: t.hotkeys.externalEditor },
			],
		},
		{
			title: t.hotkeys.session,
			rows: [
				{ keys: ["/new"], label: t.hotkeys.cmdNew },
				{ keys: ["/tree"], label: t.hotkeys.cmdTree },
				{ keys: ["/fork"], label: t.hotkeys.cmdFork },
				{ keys: ["/clone"], label: t.hotkeys.cmdClone },
				{ keys: ["/compact"], label: t.hotkeys.cmdCompact },
				{ keys: ["/session"], label: t.hotkeys.cmdSession },
				{ keys: ["/scoped-models"], label: t.hotkeys.cmdScopedModels },
				{ keys: ["/export"], label: t.hotkeys.cmdExport },
				{ keys: ["/import"], label: t.hotkeys.cmdImport },
				{ keys: ["/share"], label: t.hotkeys.cmdShare },
				{ keys: ["/hotkeys"], label: t.hotkeys.cmdHotkeys },
			],
		},
	];

	return (
		<Modal
			open
			onClose={onClose}
			title={t.hotkeys.title}
			closeLabel={t.app.close}
			className="hotkeys-dialog"
		>
			<div className="hotkeys-body">
				{groups.map((g) => (
					<div className="hotkeys-group" key={g.title}>
						<div className="hotkeys-group-title">{g.title}</div>
						{g.rows.map((row) => (
							<div className="hotkeys-row" key={row.label}>
								<span className="hotkeys-label">{row.label}</span>
								<span className="hotkeys-keys">
									{row.keys.map((k) => (
										<kbd key={k}>{k}</kbd>
									))}
								</span>
							</div>
						))}
					</div>
				))}
			</div>
		</Modal>
	);
}
