import { useCallback, useState } from "react";
import type { SessionStats } from "../chat-types";
import type { ConfirmState } from "../components/ConfirmDialog";
import type { RenameState } from "../components/RenameDialog";
import type { SettingsPage } from "../components/SettingsPanel";
import type { ExtensionRequest } from "../components/ExtensionDialog";
import type { PiTreeData } from "../components/TreePanel";
import type { PiParsedMessage } from "../pi";

export interface ArchivedPreviewState {
	path: string;
	title: string;
	messages: PiParsedMessage[];
}

export interface SessionInfoState {
	state: Record<string, unknown>;
	stats: SessionStats | null;
}

/**
 * Every modal / overlay the app can show, in one place.
 *
 * These were ~16 independent useState calls scattered through App.tsx, which is
 * a large part of what made that component a 4200-line god: adding a dialog
 * meant touching the state block, the Escape-interrupt guard (a 12-way
 * condition that had to enumerate every open surface so Escape closed the
 * dialog instead of aborting the run), and the JSX. Grouping them collapses all
 * three — see `anyOverlayOpen`.
 *
 * Raw setters are exposed where App stores a payload or clears to null; the
 * common open/close pairs get named helpers so call sites read as intent. Every
 * helper is a useCallback so it is safe in effect dependency arrays.
 */
export function useDialogs(extensionRequest: ExtensionRequest | null) {
	const [searchOpen, setSearchOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
	const [treeOpen, setTreeOpen] = useState(false);
	const [treeData, setTreeData] = useState<PiTreeData | null>(null);
	const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
	const [sessionInfoData, setSessionInfoData] = useState<SessionInfoState | null>(null);
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
	const [compactOpen, setCompactOpen] = useState(false);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [llamaOpen, setLlamaOpen] = useState(false);
	const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
	const [renameState, setRenameState] = useState<RenameState | null>(null);
	const [archivedPreview, setArchivedPreview] = useState<ArchivedPreviewState | null>(null);
	const [apiKeyDialog, setApiKeyDialog] = useState<{ provider: string } | null>(null);

	const openSearch = useCallback(() => setSearchOpen(true), []);
	const closeSearch = useCallback(() => setSearchOpen(false), []);
	const toggleSearch = useCallback(() => setSearchOpen((v) => !v), []);
	const openSettings = useCallback((page: SettingsPage | null = null) => {
		setSettingsPage(page);
		setSettingsOpen(true);
	}, []);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	const toggleSettings = useCallback(() => setSettingsOpen((v) => !v), []);
	const openTree = useCallback(() => setTreeOpen(true), []);
	const closeTree = useCallback(() => setTreeOpen(false), []);
	const openSessionInfo = useCallback(() => setSessionInfoOpen(true), []);
	const closeSessionInfo = useCallback(() => setSessionInfoOpen(false), []);
	const openHotkeys = useCallback(() => setHotkeysOpen(true), []);
	const closeHotkeys = useCallback(() => setHotkeysOpen(false), []);
	const openScopedModels = useCallback(() => setScopedModelsOpen(true), []);
	const closeScopedModels = useCallback(() => setScopedModelsOpen(false), []);
	const openCompact = useCallback(() => setCompactOpen(true), []);
	const closeCompact = useCallback(() => setCompactOpen(false), []);
	const openLlama = useCallback(() => setLlamaOpen(true), []);
	const closeLlama = useCallback(() => setLlamaOpen(false), []);

	// Escape must close an open surface rather than abort the running turn.
	// One derived flag replaces the 12-way disjunction this used to be.
	const anyOverlayOpen =
		searchOpen ||
		settingsOpen ||
		treeOpen ||
		sessionInfoOpen ||
		hotkeysOpen ||
		scopedModelsOpen ||
		compactOpen ||
		shareUrl !== null ||
		llamaOpen ||
		confirmState !== null ||
		renameState !== null ||
		archivedPreview !== null ||
		apiKeyDialog !== null ||
		extensionRequest !== null;

	return {
		searchOpen,
		settingsOpen,
		settingsPage,
		treeOpen,
		treeData,
		sessionInfoOpen,
		sessionInfoData,
		hotkeysOpen,
		scopedModelsOpen,
		compactOpen,
		shareUrl,
		llamaOpen,
		confirmState,
		renameState,
		archivedPreview,
		apiKeyDialog,
		anyOverlayOpen,

		setSearchOpen,
		setSettingsOpen,
		setSettingsPage,
		setTreeOpen,
		setTreeData,
		setSessionInfoOpen,
		setSessionInfoData,
		setHotkeysOpen,
		setScopedModelsOpen,
		setCompactOpen,
		setShareUrl,
		setLlamaOpen,
		setConfirmState,
		setRenameState,
		setArchivedPreview,
		setApiKeyDialog,

		openSearch,
		closeSearch,
		toggleSearch,
		openSettings,
		closeSettings,
		toggleSettings,
		openTree,
		closeTree,
		openSessionInfo,
		closeSessionInfo,
		openHotkeys,
		closeHotkeys,
		openScopedModels,
		closeScopedModels,
		openCompact,
		closeCompact,
		openLlama,
		closeLlama,
	};
}
