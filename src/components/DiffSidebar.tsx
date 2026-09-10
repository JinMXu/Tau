import { Fragment, useEffect, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { BranchIcon, ChevronDownIcon, XIcon } from "../icons";
import type { NumDiffLine, TurnChanges } from "./chat-rows";

/**
 * DiffSidebar — right-hand file-changes column (port of the Percho panel).
 * Push layout: opening it compresses the chat column (width transition).
 * Data source: the same deriveTurnChanges() the turn chips use.
 */

const COLLAPSE_LINES = 120;

/** Single diff line: double gutter line numbers + sign column. */
function DiffLineView({ line, index }: { line: NumDiffLine; index: number }) {
	return (
		<div className={`diff-line-row ${line.kind}`} style={{ ["--i" as string]: index }}>
			<span className="diff-g diff-g-old">{line.oldNo ?? ""}</span>
			<span className="diff-g diff-g-new">{line.newNo ?? ""}</span>
			<span className="diff-sign" aria-hidden="true">
				{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
			</span>
			<span className="diff-code">{line.text || " "}</span>
		</div>
	);
}

/** One file card: collapsible, long diffs truncated with an expand-all. */
function DiffFileCard({
	file,
	defaultOpen,
	t,
}: {
	file: TurnChanges["files"][number];
	defaultOpen: boolean;
	t: MessageCatalog;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const totalLines = file.sections.reduce((n, s) => n + s.length, 0);
	const capped = totalLines > COLLAPSE_LINES;
	const [expandedAll, setExpandedAll] = useState(false);
	return (
		<div className={`diff-file-card${open ? " open" : ""}`}>
			<button
				type="button"
				className="diff-file-head"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="diff-file-chev" aria-hidden="true">
					<ChevronDownIcon size={11} className={open ? "open" : ""} />
				</span>
				<span className="diff-file-path" title={file.path}>{`\u200e${file.path}`}</span>
				<span className="turn-diff-stat">
					<span className="turn-diff-added">+{file.added}</span>{" "}
					<span className="turn-diff-removed">−{file.removed}</span>
				</span>
			</button>
			{open && (
				<div className="diff-card-body">
					{file.sections.map((sec, i) => {
						if (capped && !expandedAll) {
							// Show only the first COLLAPSE_LINES lines overall.
							const before = file.sections.slice(0, i).reduce((n, s) => n + s.length, 0);
							if (before >= COLLAPSE_LINES) return null;
							const visible = sec.slice(0, Math.max(0, COLLAPSE_LINES - before));
							return (
								<Fragment key={i}>
									{i > 0 && <div className="diff-section-sep" aria-hidden="true" />}
									<div className="diff-table">
										{visible.map((l, j) => (
											<DiffLineView key={j} line={l} index={j} />
										))}
									</div>
								</Fragment>
							);
						}
						return (
							<Fragment key={i}>
								{i > 0 && <div className="diff-section-sep" aria-hidden="true" />}
								<div className="diff-table">
									{sec.map((l, j) => (
										<DiffLineView key={j} line={l} index={j} />
									))}
								</div>
							</Fragment>
						);
					})}
					{capped && !expandedAll && (
						<button type="button" className="diff-expand-more" onClick={() => setExpandedAll(true)}>
							{t.diff.expandMore.replace("{lines}", String(totalLines - COLLAPSE_LINES))}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export type DiffScope = "all" | "latest";

export function DiffSidebar({
	open,
	turns,
	scope,
	onScopeChange,
	onClose,
	branch,
	t,
}: {
	open: boolean;
	/** All turns' changes, newest last. */
	turns: TurnChanges[];
	scope: DiffScope;
	onScopeChange: (s: DiffScope) => void;
	onClose: () => void;
	/** Current git branch (may be null outside a repo). */
	branch: string | null;
	t: MessageCatalog;
}) {
	// "最近一轮" = the last turn that actually has changes.
	const latestIndex = turns.length > 0 ? turns.length - 1 : -1;
	const visible = scope === "latest" ? (latestIndex >= 0 ? [turns[latestIndex]] : []) : turns;
	const totalFiles = new Set(turns.flatMap((c) => c.files.map((f) => f.path))).size;
	const totalAdded = turns.reduce((n, c) => n + c.totalAdded, 0);
	const totalRemoved = turns.reduce((n, c) => n + c.totalRemoved, 0);
	const hasContent = visible.length > 0;
	// Re-run the slide-in content animation whenever the sidebar opens.
	const [openCount, setOpenCount] = useState(0);
	useEffect(() => {
		if (open) setOpenCount((n) => n + 1);
	}, [open]);
	return (
		<aside className={`diff-sidebar${open ? " open" : ""}`} aria-hidden={!open}>
			<div className="diff-sidebar-in" key={openCount}>
				<div className="diff-side-head">
					<span className="diff-side-title">{t.diff.title}</span>
					{hasContent ? (
						<span className="diff-side-sum">
							<span className="diff-side-files">
								{t.diff.filesSummary.replace("{count}", String(totalFiles))}
							</span>{" "}
							<span className="turn-diff-added">+{totalAdded}</span>{" "}
							<span className="turn-diff-removed">−{totalRemoved}</span>
						</span>
					) : null}
					<div className="diff-side-actions">
						<div className="diff-scope-tabs" role="tablist">
							<button
								type="button"
								role="tab"
								aria-selected={scope === "all"}
								className={scope === "all" ? "on" : ""}
								onClick={() => onScopeChange("all")}
							>
								{t.diff.scopeAll}
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={scope === "latest"}
								className={scope === "latest" ? "on" : ""}
								onClick={() => onScopeChange("latest")}
							>
								{t.diff.scopeLatest}
							</button>
						</div>
						<button type="button" className="diff-close" onClick={onClose} aria-label="close">
							<XIcon size={13} />
						</button>
					</div>
				</div>
				{branch && (
					<div className="diff-side-branch">
						<BranchIcon size={12} />
						<span>{branch}</span>
					</div>
				)}
				<div className="diff-side-scroll">
					{!hasContent ? (
						<div className="diff-empty">{t.diff.empty}</div>
					) : (
						visible.map((tc, gi) => (
							<div className="diff-turn-group" key={tc.turnIndex}>
								<div className="diff-tg-head">
									<span className="diff-tg-title">
										{t.diff.turnLabel.replace("{n}", String(tc.turnIndex + 1))}
									</span>
									<span className="diff-tg-sum">
										<span className="turn-diff-added">+{tc.totalAdded}</span>{" "}
										<span className="turn-diff-removed">−{tc.totalRemoved}</span>
									</span>
								</div>
								{tc.files.map((f, fi) => (
									<DiffFileCard
										// biome-ignore lint/suspicious/noArrayIndexKey: 同一文件在同轮只出现一次
										key={`${tc.turnIndex}:${f.path}`}
										file={f}
										defaultOpen={gi === 0 && fi === 0}
										t={t}
									/>
								))}
							</div>
						))
					)}
				</div>
			</div>
		</aside>
	);
}
