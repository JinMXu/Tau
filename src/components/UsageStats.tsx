import { useEffect, useMemo, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { usageStats, type PiUsageEntry } from "../pi";

/** 1234 → "1.2k", 1234567 → "1.23M" */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Session timestamps are UTC ("2026-08-12T16:00:00.000Z"); the backend
 * slices the date out as-is, so "today" in the chart would lag by the UTC
 * offset (UTC+8 evenings land on "yesterday"). Convert to the local date
 * so the aggregation matches the local-timezone axis.
 */
function localDayKey(utcDate: string): string {
	const d = new Date(`${utcDate}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return utcDate;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function projectLabel(path: string | null): string {
	if (!path) return "—";
	const normalized = path.replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/);
	return parts[parts.length - 1] || normalized;
}

export function UsageStats({ t }: { t: MessageCatalog }) {
	const [entries, setEntries] = useState<PiUsageEntry[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		usageStats()
			.then((data) => {
				if (!cancelled) setEntries(data);
			})
			.catch(() => {
				if (!cancelled) setEntries([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const agg = useMemo(() => {
		if (!entries) return null;
		let totalTokens = 0;
		let totalCost = 0;
		let calls = 0;
		const sessions = new Set<string>();
		const byDay = new Map<
			string,
			{ tokens: number; cost: number; turns: number }
		>();
		const byModel = new Map<
			string,
			{ tokens: number; cost: number; turns: number }
		>();
		const byProject = new Map<
			string,
			{ tokens: number; cost: number; turns: number }
		>();
		for (const e of entries) {
			totalTokens += e.total;
			totalCost += e.cost;
			calls += 1;
			sessions.add(e.sessionPath);
			const bump = (
				map: Map<string, { tokens: number; cost: number; turns: number }>,
				key: string,
			) => {
				const cur = map.get(key) ?? { tokens: 0, cost: 0, turns: 0 };
				cur.tokens += e.total;
				cur.cost += e.cost;
				cur.turns += 1;
				map.set(key, cur);
			};
			bump(byDay, localDayKey(e.date));
			bump(byModel, e.model ? `${e.provider}/${e.model}` : e.provider || "—");
			bump(byProject, e.project ?? "—");
		}
		// Fill the last 14 days so the chart shows a continuous axis.
		const days: { date: string; tokens: number; cost: number; turns: number }[] =
			[];
		for (let i = 13; i >= 0; i--) {
			const d = new Date(Date.now() - i * 86_400_000);
			const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			const hit = byDay.get(key);
			days.push({ date: key, ...(hit ?? { tokens: 0, cost: 0, turns: 0 }) });
		}
		return {
			totalTokens,
			totalCost,
			calls,
			sessionCount: sessions.size,
			days,
			byModel: [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens),
			byProject: [...byProject.entries()].sort(
				(a, b) => b[1].tokens - a[1].tokens,
			),
		};
	}, [entries]);

	if (agg === null) {
		return <div className="settings-loading">{t.settings.loading}</div>;
	}
	if (entries && entries.length === 0) {
		return <div className="settings-empty">{t.settings.emptyUsage}</div>;
	}

	const maxDay = Math.max(...agg.days.map((d) => d.tokens), 1);
	const maxModel = Math.max(...agg.byModel.map(([, v]) => v.tokens), 1);
	const maxProject = Math.max(...agg.byProject.map(([, v]) => v.tokens), 1);

	return (
		<div className="usage-stats">
			<div className="usage-cards">
				<div className="usage-card">
					<div className="usage-card-num">{formatTokens(agg.totalTokens)}</div>
					<div className="usage-card-label">{t.settings.usageTokens}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">${agg.totalCost.toFixed(4)}</div>
					<div className="usage-card-label">{t.settings.usageCost}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">{agg.calls}</div>
					<div className="usage-card-label">{t.settings.usageCalls}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">{agg.sessionCount}</div>
					<div className="usage-card-label">{t.settings.usageSessions}</div>
				</div>
			</div>

			<h4 className="settings-sub">{t.settings.usageByDay}</h4>
			<div className="usage-bars">
				{agg.days.map((d) => (
					<div
						className="usage-bar-col"
						key={d.date}
						title={`${d.date} · ${formatTokens(d.tokens)} tokens · $${d.cost.toFixed(4)} · ${d.turns} ${t.settings.usageCalls}`}
					>
						<div className="usage-bar-track">
							<div
								className={`usage-bar${d.tokens === 0 ? " empty" : ""}`}
								style={{ height: `${Math.max(3, (d.tokens / maxDay) * 100)}%` }}
							/>
						</div>
						<div className="usage-bar-label">{d.date.slice(5)}</div>
					</div>
				))}
			</div>

			<h4 className="settings-sub">{t.settings.usageByModel}</h4>
			<div className="usage-rows">
				{agg.byModel.map(([name, v]) => (
					<div className="usage-row" key={name}>
						<span className="usage-row-name" title={name}>
							{name}
						</span>
						<div className="usage-row-track">
							<div
								className="usage-row-fill"
								style={{ width: `${(v.tokens / maxModel) * 100}%` }}
							/>
						</div>
						<span className="usage-row-num">
							{formatTokens(v.tokens)} · ${v.cost.toFixed(4)}
						</span>
					</div>
				))}
			</div>

			<h4 className="settings-sub">{t.settings.usageByProject}</h4>
			<div className="usage-rows">
				{agg.byProject.map(([name, v]) => (
					<div className="usage-row" key={name}>
						<span className="usage-row-name" title={name}>
							{projectLabel(name)}
						</span>
						<div className="usage-row-track">
							<div
								className="usage-row-fill"
								style={{ width: `${(v.tokens / maxProject) * 100}%` }}
							/>
						</div>
						<span className="usage-row-num">
							{formatTokens(v.tokens)} · ${v.cost.toFixed(4)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
