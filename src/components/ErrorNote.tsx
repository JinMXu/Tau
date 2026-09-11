import { useState } from "react";
import type { MessageCatalog } from "../i18n";
import type { UiError } from "../errors";
import { formatTimeOfDay } from "../format";
import { CopyIcon, GearIcon, RefreshIcon } from "../icons";

/**
 * 会话内错误条（移植自 Percho `packages/desktop/src/renderer/src/components/chat/ErrorNote.tsx`）：
 * - 无边框悬浮卡片 + severity 一枚 glyph
 * - 默认折叠；展开后显示 detail + hint + 动作行
 * - 动作：retry（重发本卡之前最后一条 user 消息）/ compact（压缩上下文）/
 *   openSettings（打开设置面板）/ copyDetail（复制原始错误）
 *
 * 当 detail 不存在时不暴露 copyDetail 按钮；actions 由 UiError 携带，调用方决定
 * 如何具体实现 retry / compact / openSettings（需要会话状态）。
 */
export function ErrorNote({
	error,
	onRetry,
	onCompact,
	onOpenSettings,
	t,
}: {
	error: UiError;
	onRetry?: () => void;
	onCompact?: () => void;
	onOpenSettings?: () => void;
	t: MessageCatalog;
}) {
	const [copied, setCopied] = useState(false);
	const [open, setOpen] = useState(false);

	const title =
		t.settings.error.titleKey[error.titleKey as keyof typeof t.settings.error.titleKey] ??
		error.titleKey;
	const hint = error.hintKey
		? t.settings.error.hintKey[error.hintKey as keyof typeof t.settings.error.hintKey]
		: undefined;
	const source = t.settings.error.source[error.source] ?? error.source;
	const time = formatTimeOfDay(error.timestamp);
	const severityClass =
		error.severity === "warning"
			? "error-sev-warn"
			: error.severity === "info"
				? "error-sev-info"
				: "error-sev-error";

	const copyDetail = async () => {
		if (!error.detail) return;
		try {
			await navigator.clipboard.writeText(error.detail);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard API may not be available (insecure context / Tauri
			// webview quirks): silently no-op rather than crashing.
		}
	};

	return (
		<div className={`error-note ${severityClass}`}>
			<button
				type="button"
				className="error-note-summary"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="error-note-glyph" aria-hidden="true">
					●
				</span>
				<span className="error-note-title truncate">{title}</span>
				<span className="error-note-meta">
					{source} · {time}
				</span>
				<span className={`error-note-chev${open ? " open" : ""}`} aria-hidden="true">
					▸
				</span>
			</button>
			{open && (
				<div className="error-note-body">
					{error.detail && (
						<>
							<div className="error-note-section-label">{t.settings.error.detail}</div>
							<pre className="error-note-detail">{error.detail}</pre>
						</>
					)}
					{hint && <p className="error-note-hint">{hint}</p>}
					<div className="error-note-actions">
						{error.actions.map((action) => {
							const label =
								t.settings.error.action[action as keyof typeof t.settings.error.action] ?? action;
							const onClick = () => {
								if (action === "retry") onRetry?.();
								else if (action === "compact") onCompact?.();
								else if (action === "openSettings") onOpenSettings?.();
								else if (action === "copyDetail") void copyDetail();
							};
							const cls = `error-note-act${action === "retry" ? " strong" : ""}`;
							const icon =
								action === "retry" ? (
									<RefreshIcon size={12} />
								) : action === "openSettings" ? (
									<GearIcon size={12} />
								) : action === "copyDetail" ? (
									<CopyIcon size={12} />
								) : null;
							return (
								<button
									key={action}
									type="button"
									className={cls}
									disabled={
										(action === "retry" && !onRetry) ||
										(action === "compact" && !onCompact) ||
										(action === "openSettings" && !onOpenSettings) ||
										(action === "copyDetail" && !error.detail)
									}
									onClick={onClick}
								>
									{icon}
									<span>{label}</span>
								</button>
							);
						})}
						{error.detail && (
							<span className={`error-note-copied${copied ? " on" : ""}`}>
								{t.settings.error.copied}
							</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
