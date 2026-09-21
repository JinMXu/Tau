import { useCallback } from "react";
import type { RefObject } from "react";
import {
	archiveSession as archiveSessionCmd,
	compactSessionImages,
	deleteSession as deleteSessionCmd,
	exportChat,
	exportHtml,
	openWorkspace,
	piMoveSession,
	purgeSession,
	readSession,
	restoreSession,
	revealDir,
	type PiArchivedSession,
	type PiSessionInfo,
} from "../pi";
import type { MessageCatalog } from "../i18n";
import { formatBytes, projectNameFromPath } from "../format";
import { sameSessionPath } from "../platform";
import { parsedMessagesToMarkdown } from "../components/message-utils";
import type { ArchivedPreviewState } from "./use-dialogs";

export interface SessionActionsDeps {
	t: MessageCatalog;
	workspace: string | null;
	sessions: PiSessionInfo[];
	archived: PiArchivedSession[];
	/** Session currently displayed (a ref — read at call time, not at render). */
	sessionPathRef: RefObject<string | null>;
	disconnect: () => Promise<void>;
	connect: (opts?: { sessionFile?: string | null; workspace?: string | null }) => Promise<boolean>;
	refreshSessions: () => Promise<PiSessionInfo[]>;
	toast: (msg: string) => void;
	setError: (msg: string) => void;
	clearTranscript: () => void;
	/** Ask for confirmation before a destructive action. */
	confirm: (state: {
		title: string;
		body: string;
		confirmLabel: string;
		onConfirm: () => Promise<void> | void;
	}) => void;
	archivedPreview: ArchivedPreviewState | null;
	setArchivedPreview: (preview: ArchivedPreviewState | null) => void;
}

/**
 * Session lifecycle actions that are pure functions of "which sessions exist"
 * plus the connect/disconnect/refresh primitives.
 *
 * Lifted out of App.tsx, where they were ~340 lines of near-identical
 * confirm-then-act-then-refresh callbacks interleaved with the streaming and
 * channel machinery. Every destructive operation still goes through a
 * confirmation first, and most stop the running pi process (or refuse to run
 * while one is alive) because they rename/rewrite a JSONL that pi may be
 * appending to.
 */
export function useSessionActions(deps: SessionActionsDeps) {
	const {
		t,
		workspace,
		sessions,
		archived,
		sessionPathRef,
		disconnect,
		connect,
		refreshSessions,
		toast,
		setError,
		clearTranscript,
		confirm,
		archivedPreview,
		setArchivedPreview,
	} = deps;

	/** Reconnect to a fresh task in the current workspace, if one is selected. */
	const reconnectFresh = useCallback(() => {
		if (workspace) void connect({ sessionFile: null });
	}, [workspace, connect]);

	const archiveCurrent = useCallback(() => {
		const path = sessionPathRef.current;
		if (!path) return;
		confirm({
			title: t.confirm.deleteTitle,
			body: t.confirm.deleteBody,
			confirmLabel: t.app.delete,
			onConfirm: async () => {
				try {
					// Stop pi first: on Linux/macOS renaming a session file
					// that pi still has open makes later appends land in the
					// moved copy; on Windows the rename just fails.
					await disconnect();
					await archiveSessionCmd(path);
					clearTranscript();
					await refreshSessions();
					// Reconnect to a fresh session so the composer stays usable
					// as long as a workspace is selected.
					reconnectFresh();
					toast(t.sidebar.archive);
				} catch (e) {
					setError(String(e));
				}
			},
		});
	}, [
		t,
		sessionPathRef,
		confirm,
		disconnect,
		clearTranscript,
		refreshSessions,
		reconnectFresh,
		toast,
		setError,
	]);

	// Archive an arbitrary session from the sidebar row hover action.
	const archiveSessionByPath = useCallback(
		(path: string) => {
			confirm({
				title: t.confirm.deleteTitle,
				body: t.confirm.deleteBody,
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					try {
						// Was this the DISPLAYED session? Compare via
						// sameSessionPath: sessionPathRef carries the RPC spelling,
						// the sidebar row carries the scan spelling.
						const wasCurrent =
							sessionPathRef.current != null && sameSessionPath(sessionPathRef.current, path);
						if (wasCurrent) {
							await disconnect();
						}
						await archiveSessionCmd(path);
						if (wasCurrent) {
							clearTranscript();
						}
						await refreshSessions();
						if (wasCurrent) reconnectFresh();
						toast(t.sidebar.archive);
					} catch (e) {
						setError(String(e));
					}
				},
			});
		},
		[t, sessionPathRef, confirm, disconnect, clearTranscript, refreshSessions, reconnectFresh, toast, setError],
	);

	const deleteCurrent = useCallback(() => {
		const path = sessionPathRef.current;
		if (!path) return;
		confirm({
			title: t.confirm.deleteTitle,
			body: t.confirm.deleteBody,
			confirmLabel: t.app.delete,
			onConfirm: async () => {
				try {
					await disconnect();
					await deleteSessionCmd(path);
					clearTranscript();
					await refreshSessions();
					reconnectFresh();
					toast(t.app.delete);
				} catch (e) {
					setError(String(e));
				}
			},
		});
	}, [t, sessionPathRef, confirm, disconnect, clearTranscript, refreshSessions, reconnectFresh, toast, setError]);

	const handleRestore = useCallback(
		async (path: string) => {
			try {
				await restoreSession(path);
				await refreshSessions();
				toast(t.sidebar.restore);
			} catch (e) {
				setError(String(e));
			}
		},
		[refreshSessions, toast, t, setError],
	);

	const handlePurge = useCallback(
		(path: string) => {
			confirm({
				title: t.confirm.purgeTitle,
				body: t.confirm.purgeBody,
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					try {
						await purgeSession(path);
						await refreshSessions();
						toast(t.app.delete);
					} catch (e) {
						setError(String(e));
					}
				},
			});
		},
		[refreshSessions, toast, t, confirm, setError],
	);

	const handlePurgeAll = useCallback(() => {
		if (archived.length === 0) return;
		confirm({
			title: t.confirm.purgeAllTitle,
			body: t.confirm.purgeAllBody.replace("{count}", String(archived.length)),
			confirmLabel: t.settings.deleteAllArchived,
			onConfirm: async () => {
				for (const a of archived) {
					try {
						await purgeSession(a.path);
					} catch {
						/* continue */
					}
				}
				await refreshSessions();
				toast(t.app.delete);
			},
		});
	}, [archived, refreshSessions, toast, t, confirm]);

	const handlePurgeProject = useCallback(
		(project: string | null) => {
			const targets = archived.filter((a) => a.project === project);
			if (targets.length === 0) return;
			const name = project ? projectNameFromPath(project) : t.settings.noProject;
			confirm({
				title: t.confirm.purgeProjectTitle,
				body: t.confirm.purgeProjectBody
					.replace("{project}", name)
					.replace("{count}", String(targets.length)),
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					for (const a of targets) {
						try {
							await purgeSession(a.path);
						} catch {
							/* continue */
						}
					}
					await refreshSessions();
					toast(t.app.delete);
				},
			});
		},
		[archived, refreshSessions, toast, t, confirm],
	);

	const handleMoveSession = useCallback(
		async (path: string) => {
			const dir = await openWorkspace();
			if (!dir) return;
			const wasCurrent = sessionPathRef.current === path;
			try {
				// Rewriting a JSONL that the running pi process may append to
				// concurrently would corrupt it — stop the session first.
				if (wasCurrent) {
					await disconnect();
				}
				await piMoveSession(path, dir);
				await refreshSessions();
				if (wasCurrent) {
					clearTranscript();
					// Explicit workspace: the session header now points at the
					// new project, but the (stale) cached session entry would
					// steer connect back to the old directory.
					await connect({ sessionFile: path, workspace: dir });
				}
				toast(t.chat.moved);
			} catch (e) {
				setError(String(e));
			}
		},
		[refreshSessions, toast, t, disconnect, connect, sessionPathRef, clearTranscript, setError],
	);

	const handleCompactImages = useCallback(() => {
		const path = sessionPathRef.current;
		if (!path) return;
		confirm({
			title: t.confirm.compactImagesTitle,
			body: t.confirm.compactImagesBody,
			confirmLabel: t.app.confirm,
			onConfirm: async () => {
				try {
					// The backend refuses to touch a session the running pi
					// process may append to, so stop it first and reconnect
					// afterwards.
					await disconnect();
					const r = await compactSessionImages(path);
					await refreshSessions();
					await connect({ sessionFile: path });
					if (r.removed > 0) {
						const saved = Math.max(0, r.before - r.after);
						toast(
							t.chat.imagesCompacted
								.replace("{n}", String(r.removed))
								.replace("{size}", formatBytes(saved)),
						);
					} else {
						toast(t.chat.imagesCompactedNone);
					}
				} catch (e) {
					setError(String(e));
				}
			},
		});
	}, [t, sessionPathRef, confirm, disconnect, refreshSessions, connect, toast, setError]);

	// Same operation for archived/trashed sessions (never running, so no
	// disconnect/reconnect dance).
	const handleCompactArchived = useCallback(
		(path: string) => {
			confirm({
				title: t.confirm.compactImagesTitle,
				body: t.confirm.compactImagesBodyArchived,
				confirmLabel: t.app.confirm,
				onConfirm: async () => {
					try {
						const r = await compactSessionImages(path);
						await refreshSessions();
						if (r.removed > 0) {
							const saved = Math.max(0, r.before - r.after);
							toast(
								t.chat.imagesCompacted
									.replace("{n}", String(r.removed))
									.replace("{size}", formatBytes(saved)),
							);
						} else {
							toast(t.chat.imagesCompactedNone);
						}
					} catch (e) {
						setError(String(e));
					}
				},
			});
		},
		[t, refreshSessions, toast, confirm, setError],
	);

	const handleDeleteProject = useCallback(
		(path: string) => {
			const projectSessions = sessions.filter((s) => s.project === path);
			if (projectSessions.length === 0) return;
			confirm({
				title: t.confirm.deleteProjectTitle,
				body: t.confirm.deleteProjectBody.replace("{count}", String(projectSessions.length)),
				confirmLabel: t.app.delete,
				onConfirm: async () => {
					const current = sessionPathRef.current;
					const includesCurrent =
						current != null && projectSessions.some((s) => sameSessionPath(s.path, current));
					if (includesCurrent) {
						await disconnect();
					}
					for (const s of projectSessions) {
						try {
							await archiveSessionCmd(s.path);
						} catch {
							/* continue */
						}
					}
					if (includesCurrent) {
						clearTranscript();
					}
					await refreshSessions();
					reconnectFresh();
					toast(t.sidebar.deleteProject);
				},
			});
		},
		[
			sessions,
			t,
			sessionPathRef,
			confirm,
			disconnect,
			clearTranscript,
			refreshSessions,
			reconnectFresh,
			toast,
		],
	);

	const handleRevealProject = useCallback(async (path: string) => {
		try {
			await revealDir(path);
		} catch {
			/* ignore */
		}
	}, []);

	// Read-only preview + export for archived sessions.
	const openArchivedPreview = useCallback(
		async (path: string, title: string) => {
			try {
				const parsed = await readSession(path);
				setArchivedPreview({ path, title, messages: parsed });
			} catch (e) {
				setError(String(e));
			}
		},
		[setArchivedPreview, setError],
	);

	const exportArchivedPreview = useCallback(
		async (format: "markdown" | "jsonl" | "html") => {
			const preview = archivedPreview;
			if (!preview) return;
			try {
				if (format === "html") {
					await exportHtml(preview.path);
				} else if (format === "jsonl") {
					await exportChat(preview.path, null, "jsonl");
				} else {
					await exportChat(preview.path, parsedMessagesToMarkdown(preview.messages), "markdown");
				}
			} catch (e) {
				setError(String(e));
			}
		},
		[archivedPreview, setError],
	);

	return {
		archiveCurrent,
		archiveSessionByPath,
		deleteCurrent,
		handleRestore,
		handlePurge,
		handlePurgeAll,
		handlePurgeProject,
		handleMoveSession,
		handleCompactImages,
		handleCompactArchived,
		handleDeleteProject,
		handleRevealProject,
		openArchivedPreview,
		exportArchivedPreview,
	};
}
