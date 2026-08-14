import { useEffect, useState } from "react";
import type { MessageCatalog } from "../i18n";
import type { SessionStats } from "../chat-types";
import { XIcon, CopyIcon, CheckIcon } from "../icons";

interface ModelInfo {
	id?: string;
	name?: string;
	provider?: string;
	contextWindow?: number;
}

/**
 * `/session` equivalent: shows the session file, id, name, model, thinking
 * level, queue modes and token/cost statistics.
 */
export function SessionInfoDialog({
	open,
	data,
	t,
	onClose,
}: {
	open: boolean;
	data: { state: Record<string, unknown>; stats: SessionStats | null } | null;
	t: MessageCatalog;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState<string | null>(null);

	useEffect(() => {
		if (open) setCopied(null);
	}, [open]);

	if (!open || !data) return null;

	const s = data.state;
	const model = s.model as ModelInfo | null | undefined;
	const stats = data.stats;

	const copy = async (label: string, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(label);
			setTimeout(() => setCopied(null), 1500);
		} catch {
			/* ignore */
		}
	};

	const Row = ({
		label,
		value,
		copyKey,
		mono,
	}: {
		label: string;
		value: string;
		copyKey?: string;
		mono?: boolean;
	}) => (
		<div className="session-info-row">
			<span className="session-info-label">{label}</span>
			<span className={`session-info-value${mono ? " mono" : ""}`} title={value}>
				{value || "—"}
			</span>
			{copyKey && (
				<button
					className="icon-btn session-info-copy"
					title={t.chat.copy} aria-label={t.chat.copy}
					onClick={() => void copy(copyKey, value)}
				>
					{copied === copyKey ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
				</button>
			)}
		</div>
	);

	const thinkingLabel = (level: string) =>
		(t.chat.thinkingLevels as Record<string, string>)[level] ?? level;

	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog session-info-dialog">
				<div className="tree-dialog-header">
					<h3>{t.chat.sessionInfo}</h3>
					<button className="icon-btn" title={t.app.close} aria-label={t.app.close} onClick={onClose}>
						<XIcon size={15} />
					</button>
				</div>
				<div className="session-info-body">
					<Row
						label={t.sessionInfo.name}
						value={String(s.sessionName ?? "")}
						copyKey="name"
					/>
					<Row
						label={t.sessionInfo.file}
						value={String(s.sessionFile ?? "")}
						copyKey="file"
						mono
					/>
					<Row
						label={t.sessionInfo.id}
						value={String(s.sessionId ?? "")}
						copyKey="id"
						mono
					/>
					<Row
						label={t.sessionInfo.model}
						value={
							model
								? `${model.name ?? model.id ?? ""} (${model.provider ?? ""}/${model.id ?? ""})`.trim()
								: ""
						}
						copyKey="model"
					/>
					<Row
						label={t.sessionInfo.thinking}
						value={s.thinkingLevel ? thinkingLabel(String(s.thinkingLevel)) : ""}
					/>
					<Row
						label={t.sessionInfo.messages}
						value={String(s.messageCount ?? 0)}
					/>
					<Row
						label={t.sessionInfo.pending}
						value={String(s.pendingMessageCount ?? 0)}
					/>
					<Row
						label={t.sessionInfo.steeringMode}
						value={String(s.steeringMode ?? "")}
					/>
					<Row
						label={t.sessionInfo.followUpMode}
						value={String(s.followUpMode ?? "")}
					/>
					<Row
						label={t.sessionInfo.autoCompaction}
						value={
							s.autoCompactionEnabled === false
								? t.sessionInfo.off
								: t.sessionInfo.on
						}
					/>
					{stats && (
						<>
							<div className="session-info-sep" />
							<Row
								label={t.sessionInfo.tokensIn}
								value={stats.tokens?.input?.toLocaleString() ?? "—"}
							/>
							<Row
								label={t.sessionInfo.tokensOut}
								value={stats.tokens?.output?.toLocaleString() ?? "—"}
							/>
							<Row
								label={t.sessionInfo.tokensCache}
								value={stats.tokens?.cacheRead?.toLocaleString() ?? "—"}
							/>
							<Row
								label={t.sessionInfo.cost}
								value={
									stats.cost != null ? `$${stats.cost.toFixed(4)}` : "—"
								}
							/>
							{stats.contextUsage && (
								<Row
									label={t.sessionInfo.context}
									value={`${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} (${Math.round(stats.contextUsage.percent)}%)`}
								/>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
