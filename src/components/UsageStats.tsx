import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Language, MessageCatalog } from "../i18n";
import { usageStats, type PiUsageEntry } from "../pi";

/** Series colors for the trend/donut charts (legible on both themes). */
const MODEL_COLORS = [
	"#4c8dff",
	"#34c98e",
	"#f5a623",
	"#a67cf5",
	"#ef6a6a",
	"#3bbfd9",
];
const MAX_SERIES = 5;
const MAX_DONUT = 6;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function dayKeyOf(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
	return dayKeyOf(d);
}

/** 43300000 → "4330万" (zh) / "43.3M" (en). */
function formatTokens(n: number, lang: Language): string {
	if (lang === "zh") {
		if (n >= 100_000_000) {
			const v = n / 100_000_000;
			return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}亿`;
		}
		if (n >= 10_000) {
			const v = n / 10_000;
			return `${v >= 1000 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}万`;
		}
		return String(n);
	}
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(n);
}

/** 947 min → "15 小时 47 分钟" / "15h 47m". */
function formatDurationMs(ms: number, t: MessageCatalog): string {
	const totalMin = Math.round(ms / 60_000);
	if (totalMin < 1) return `<1 ${t.settings.usageMinutes}`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h === 0) return `${m} ${t.settings.usageMinutes}`;
	return `${h} ${t.settings.usageHours} ${pad2(m)} ${t.settings.usageMinutes}`;
}

function shortDate(key: string, lang: Language): string {
	const [, m, d] = key.split("-").map(Number);
	return lang === "zh" ? `${m}月${d}日` : `${m}/${d}`;
}

/** "2026-08-15" → "2026年8月15日" / "Aug 15, 2026". */
function fullDate(key: string, lang: Language): string {
	const [y, m, d] = key.split("-").map(Number);
	if (lang === "zh") return `${y}年${m}月${d}日`;
	return new Date(`${key}T00:00:00`).toLocaleString("en", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** 0–4 intensity level for a heatmap cell. */
function levelOf(v: number, max: number): number {
	if (v <= 0 || max <= 0) return 0;
	return Math.min(4, Math.max(1, Math.ceil((v / max) * 4)));
}

type HeatMode = "daily" | "weekly";
type TrendRange = 7 | 30;

export function UsageStats({ t, lang }: { t: MessageCatalog; lang: Language }) {
	const [entries, setEntries] = useState<PiUsageEntry[] | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [heatMode, setHeatMode] = useState<HeatMode>("daily");
	const [range, setRange] = useState<TrendRange>(30);
	const [hoverIdx, setHoverIdx] = useState<number | null>(null);
	const [donutHover, setDonutHover] = useState<{ i: number; x: number; y: number } | null>(
		null,
	);
	const trendSvgRef = useRef<SVGSVGElement>(null);
	const donutWrapRef = useRef<HTMLDivElement>(null);

	const load = useCallback(() => {
		setRefreshing(true);
		usageStats()
			.then((data) => setEntries(data))
			.catch(() => setEntries([]))
			.finally(() => setRefreshing(false));
	}, []);
	useEffect(load, [load]);

	const agg = useMemo(() => {
		if (!entries) return null;
		const dayTokens = new Map<string, number>();
		const dayCounts = new Map<string, number>();
		const dayModelTokens = new Map<string, Map<string, number>>();
		const modelTotals = new Map<string, number>();
		const sessionSpan = new Map<string, { min: number; max: number }>();
		let totalTokens = 0;
		for (const e of entries) {
			totalTokens += e.total;
			const day = localDayKey(e.date);
			dayTokens.set(day, (dayTokens.get(day) ?? 0) + e.total);
			dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
			const model = e.model || e.provider || "—";
			modelTotals.set(model, (modelTotals.get(model) ?? 0) + e.total);
			let dm = dayModelTokens.get(day);
			if (!dm) dayModelTokens.set(day, (dm = new Map()));
			dm.set(model, (dm.get(model) ?? 0) + e.total);
			if (e.ts > 0) {
				const span = sessionSpan.get(e.sessionPath) ?? {
					min: Number.POSITIVE_INFINITY,
					max: 0,
				};
				span.min = Math.min(span.min, e.ts);
				span.max = Math.max(span.max, e.ts);
				sessionSpan.set(e.sessionPath, span);
			}
		}
		// Peak day & longest chat.
		const peakDay = Math.max(0, ...dayTokens.values());
		let longestChat = 0;
		for (const s of sessionSpan.values()) {
			if (Number.isFinite(s.min)) longestChat = Math.max(longestChat, s.max - s.min);
		}
		// Streaks over active days.
		const active = new Set(dayTokens.keys());
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		let currentStreak = 0;
		{
			const cursor = new Date(today);
			while (active.has(dayKeyOf(cursor))) {
				currentStreak += 1;
				cursor.setDate(cursor.getDate() - 1);
			}
		}
		let longestStreak = 0;
		{
			const sorted = [...active].sort();
			let run = 0;
			let prev = "";
			for (const key of sorted) {
				const expected = new Date(`${prev}T00:00:00`);
				expected.setDate(expected.getDate() + 1);
				run = prev && dayKeyOf(expected) === key ? run + 1 : 1;
				longestStreak = Math.max(longestStreak, run);
				prev = key;
			}
		}
		return {
			totalTokens,
			peakDay,
			longestChat,
			currentStreak,
			longestStreak,
			dayTokens,
			dayCounts,
			dayModelTokens,
			modelTotals,
		};
	}, [entries]);

	// ---- heatmap (last ~52 weeks, GitHub-style, Monday-start columns) ----
	const heatmap = useMemo(() => {
		if (!agg) return null;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const start = new Date(today);
		start.setDate(start.getDate() - 364);
		start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday
		const weeks: { key: string; tokens: number; count: number; future: boolean }[][] = [];
		const cursor = new Date(start);
		while (cursor <= today) {
			const week: { key: string; tokens: number; count: number; future: boolean }[] = [];
			for (let i = 0; i < 7; i++) {
				week.push({
					key: dayKeyOf(cursor),
					tokens: agg.dayTokens.get(dayKeyOf(cursor)) ?? 0,
					count: agg.dayCounts.get(dayKeyOf(cursor)) ?? 0,
					future: cursor > today,
				});
				cursor.setDate(cursor.getDate() + 1);
			}
			weeks.push(week);
		}
		// Per-mode cell values + scale max.
		const weekSums = weeks.map((w) => w.reduce((s, d) => s + d.tokens, 0));
		const weekCounts = weeks.map((w) => w.reduce((s, d) => s + d.count, 0));
		const maxDaily = Math.max(1, ...weeks.flat().map((d) => d.tokens));
		const maxWeekly = Math.max(1, ...weekSums);
		// Month labels at the column where the month changes.
		const monthLabels: { col: number; label: string }[] = [];
		let prevMonth = -1;
		weeks.forEach((w, col) => {
			const month = Number(w[0].key.split("-")[1]);
			if (month !== prevMonth) {
				monthLabels.push({
					col,
					label:
						lang === "zh"
							? `${month}月`
							: new Date(`${w[0].key}T00:00:00`).toLocaleString("en", {
									month: "short",
								}),
				});
				prevMonth = month;
			}
		});
		return { weeks, weekSums, weekCounts, maxDaily, maxWeekly, monthLabels };
	}, [agg, lang]);

	// ---- trend chart data (last N days, per top-model series) ----
	const trend = useMemo(() => {
		if (!agg) return null;
		const days: string[] = [];
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		for (let i = range - 1; i >= 0; i--) {
			const d = new Date(today);
			d.setDate(d.getDate() - i);
			days.push(dayKeyOf(d));
		}
		const inRange = new Set(days);
		const totals = new Map<string, number>();
		for (const [day, dm] of agg.dayModelTokens) {
			if (!inRange.has(day)) continue;
			for (const [model, v] of dm) {
				totals.set(model, (totals.get(model) ?? 0) + v);
			}
		}
		const top = [...totals.entries()].sort((a, b) => b[1] - a[1]);
		const kept = top.slice(0, MAX_SERIES).map(([name]) => name);
		const hasOther = top.length > MAX_SERIES;
		const series = kept.map((name, i) => ({
			name,
			color: MODEL_COLORS[i % MODEL_COLORS.length],
			values: days.map((d) => agg.dayModelTokens.get(d)?.get(name) ?? 0),
		}));
		if (hasOther) {
			series.push({
				name: t.settings.usageOther,
				color: MODEL_COLORS[MAX_SERIES % MODEL_COLORS.length],
				values: days.map((d) => {
					const dm = agg.dayModelTokens.get(d);
					if (!dm) return 0;
					let sum = 0;
					for (const [m, v] of dm) if (!kept.includes(m)) sum += v;
					return sum;
				}),
			});
		}
		const maxV = Math.max(1, ...series.flatMap((s) => s.values));
		return { days, series, maxV };
	}, [agg, range, t]);

	// ---- donut data (all-time per model) ----
	const donut = useMemo(() => {
		if (!agg) return null;
		const sorted = [...agg.modelTotals.entries()].sort((a, b) => b[1] - a[1]);
		const kept = sorted.slice(0, MAX_DONUT);
		const rest = sorted.slice(MAX_DONUT);
		const items = kept.map(([name, v], i) => ({
			name,
			value: v,
			color: MODEL_COLORS[i % MODEL_COLORS.length],
		}));
		if (rest.length > 0) {
			items.push({
				name: t.settings.usageOther,
				value: rest.reduce((s, [, v]) => s + v, 0),
				color: MODEL_COLORS[MAX_DONUT % MODEL_COLORS.length],
			});
		}
		const total = items.reduce((s, it) => s + it.value, 0);
		return { items, total };
	}, [agg, t]);

	if (entries === null || agg === null || !heatmap || !trend || !donut) {
		return <div className="settings-loading">{t.settings.loading}</div>;
	}
	if (entries.length === 0) {
		return <div className="settings-empty">{t.settings.emptyUsage}</div>;
	}

	// Trend chart geometry.
	const W = 720;
	const H = 220;
	const PADL = 10;
	const PADR = 10;
	const PADT = 14;
	const PADB = 26;
	const n = trend.days.length;
	const stepX = n > 1 ? (W - PADL - PADR) / (n - 1) : 0;
	const xOf = (i: number) => PADL + i * stepX;
	const yOf = (v: number) => PADT + (1 - v / trend.maxV) * (H - PADT - PADB);
	const tickIdxs = [...new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1])];

	const onTrendHover = (e: React.MouseEvent<SVGSVGElement>) => {
		const el = trendSvgRef.current;
		if (!el || n === 0) return;
		const rect = el.getBoundingClientRect();
		const x = ((e.clientX - rect.left) / rect.width) * W;
		const idx = Math.round((x - PADL) / stepX);
		setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
	};

	const onDonutHover = (i: number, e: React.MouseEvent<SVGCircleElement>) => {
		const wrap = donutWrapRef.current;
		if (!wrap) return;
		const rect = wrap.getBoundingClientRect();
		setDonutHover({
			i,
			x: e.clientX - rect.left + 14,
			y: e.clientY - rect.top - 14,
		});
	};

	// Donut geometry.
	const R = 64;
	const C = 2 * Math.PI * R;
	let donutOffset = 0;

	// Tooltip transform: centered by default, flush-left/right at the chart
	// edges so it never gets clipped by the panel boundary.
	const hoverFrac = hoverIdx !== null ? xOf(hoverIdx) / W : 0;
	const hoverTransform =
		hoverFrac < 0.12
			? "translateX(0)"
			: hoverFrac > 0.88
				? "translateX(-100%)"
				: "translateX(-50%)";

	return (
		<div className="usage-stats">
			{/* overview cards */}
			<div className="usage-cards">
				<div className="usage-card">
					<div className="usage-card-num">{formatTokens(agg.totalTokens, lang)}</div>
					<div className="usage-card-label">{t.settings.usageTotalTokens}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">{formatTokens(agg.peakDay, lang)}</div>
					<div className="usage-card-label">{t.settings.usagePeakTokens}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">
						{agg.longestChat > 0 ? formatDurationMs(agg.longestChat, t) : "—"}
					</div>
					<div className="usage-card-label">{t.settings.usageLongestChat}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">
						{agg.currentStreak} {t.settings.usageDays}
					</div>
					<div className="usage-card-label">{t.settings.usageCurrentStreak}</div>
				</div>
				<div className="usage-card">
					<div className="usage-card-num">
						{agg.longestStreak} {t.settings.usageDays}
					</div>
					<div className="usage-card-label">{t.settings.usageLongestStreak}</div>
				</div>
			</div>

			{/* activity heatmap */}
			<div className="usage-section">
				<div className="usage-section-head">
					<span className="usage-section-title">{t.settings.usageTokenActivity}</span>
					<div className="usage-toggle">
						{(["daily", "weekly"] as const).map((mode) => (
							<button
								key={mode}
								className={heatMode === mode ? "active" : ""}
								onClick={() => setHeatMode(mode)}
							>
								{mode === "daily" ? t.settings.usageDaily : t.settings.usageWeekly}
							</button>
						))}
					</div>
				</div>
				<div className="usage-heatmap-scroll">
					<div className="usage-heatmap-months">
						{heatmap.monthLabels.map((m) => (
							<span
								key={m.col}
								style={{ left: `${(m.col / heatmap.weeks.length) * 100}%` }}
							>
								{m.label}
							</span>
						))}
					</div>
					<div className="usage-heatmap">
						{heatmap.weeks.flatMap((week, wi) =>
							week.map((d) => {
								const v = heatMode === "daily" ? d.tokens : heatmap.weekSums[wi];
								const max = heatMode === "daily" ? heatmap.maxDaily : heatmap.maxWeekly;
								const level = d.future ? -1 : levelOf(v, max);
								const title =
									heatMode === "daily"
										? `${d.key} · ${formatTokens(d.tokens, lang)} tokens · ${d.count} ${t.settings.usageTurns}`
										: `${fullDate(week[0].key, lang)} ${t.settings.usageWeekOf} · ${formatTokens(heatmap.weekSums[wi], lang)} tokens · ${heatmap.weekCounts[wi]} ${t.settings.usageTurns}`;
								return (
									<span
										key={d.key}
										className={`usage-heatmap-cell${level < 0 ? " future" : ` l${level}`}`}
										title={d.future ? undefined : title}
									/>
								);
							}),
						)}
					</div>
				</div>
			</div>

			{/* trend range toggle */}
			<div className="usage-range-row">
				<span className="usage-section-title">{t.settings.usageRange}</span>
				<div className="usage-toggle">
					{([7, 30] as const).map((r) => (
						<button
							key={r}
							className={range === r ? "active" : ""}
							onClick={() => setRange(r)}
						>
							{r === 7 ? t.settings.usageLast7 : t.settings.usageLast30}
						</button>
					))}
				</div>
			</div>

			{/* daily trend line chart */}
			<div className="usage-section">
				<div className="usage-section-head">
					<span className="usage-section-title">{t.settings.usageDailyTrend}</span>
				</div>
				<div className="usage-legend">
					{trend.series.map((s) => (
						<span className="usage-legend-item" key={s.name}>
							<span className="usage-dot" style={{ background: s.color }} />
							{s.name}
						</span>
					))}
				</div>
				<div className="usage-trend">
					<svg
						ref={trendSvgRef}
						viewBox={`0 0 ${W} ${H}`}
						onMouseMove={onTrendHover}
						onMouseLeave={() => setHoverIdx(null)}
					>
						{trend.series.map((s) => {
							const pts = s.values.map((v, i) => `${xOf(i)},${yOf(v)}`).join(" ");
							return (
								<g key={s.name}>
									<path
										d={`M ${xOf(0)} ${yOf(s.values[0])} ${s.values
											.map((v, i) => `L ${xOf(i)} ${yOf(v)}`)
											.join(" ")} L ${xOf(n - 1)} ${yOf(0)} L ${xOf(0)} ${yOf(0)} Z`}
										fill={s.color}
										opacity={0.08}
									/>
									<polyline
										points={pts}
										fill="none"
										stroke={s.color}
										strokeWidth={2}
										strokeLinejoin="round"
										strokeLinecap="round"
									/>
								</g>
							);
						})}
						{hoverIdx !== null && (
							<line
								x1={xOf(hoverIdx)}
								y1={PADT}
								x2={xOf(hoverIdx)}
								y2={H - PADB}
								className="usage-trend-cursor"
							/>
						)}
						{tickIdxs.map((i) => (
							<text key={i} x={xOf(i)} y={H - 8} className="usage-trend-tick">
								{shortDate(trend.days[i], lang)}
							</text>
						))}
					</svg>
					{hoverIdx !== null && (
						<div
							className="usage-trend-tooltip"
							style={{
								left: `${(xOf(hoverIdx) / W) * 100}%`,
								transform: hoverTransform,
							}}
						>
							<div className="usage-trend-tooltip-title">
								{shortDate(trend.days[hoverIdx], lang)} ·{" "}
								{formatTokens(
									trend.series.reduce((s, sr) => s + sr.values[hoverIdx], 0),
									lang,
								)}{" "}
								tokens
							</div>
							{trend.series.map((s) => (
								<div className="usage-trend-tooltip-row" key={s.name}>
									<span className="usage-dot" style={{ background: s.color }} />
									<span className="usage-trend-tooltip-name">{s.name}</span>
									<span>{s.values[hoverIdx].toLocaleString()}</span>
								</div>
							))}
						</div>
					)}
				</div>
			</div>

			{/* model donut */}
			<div className="usage-section">
				<div className="usage-section-head">
					<span className="usage-section-title">{t.settings.usageModelUsage}</span>
				</div>
				<div className="usage-donut-wrap" ref={donutWrapRef}>
					<div className="usage-donut">
						<svg viewBox="0 0 160 160">
							{donut.items.map((it, i) => {
								const frac = donut.total > 0 ? it.value / donut.total : 0;
								const dash = `${frac * C} ${C - frac * C}`;
								const offset = -donutOffset * C;
								donutOffset += frac;
								return (
									<circle
										key={it.name}
										cx={80}
										cy={80}
										r={R}
										fill="none"
										stroke={it.color}
										strokeWidth={donutHover?.i === i ? 24 : 20}
										strokeDasharray={dash}
										strokeDashoffset={offset}
										transform="rotate(-90 80 80)"
										opacity={donutHover !== null && donutHover.i !== i ? 0.3 : 1}
										onMouseMove={(e) => onDonutHover(i, e)}
										onMouseLeave={() => setDonutHover(null)}
									/>
								);
							})}
						</svg>
						<div className="usage-donut-center">
							<div className="usage-donut-total">{formatTokens(donut.total, lang)}</div>
							<div className="usage-donut-sub">tokens</div>
						</div>
					</div>
					{donutHover !== null && donut.items[donutHover.i] && (
						<div
							className="usage-trend-tooltip usage-donut-tooltip"
							style={{ left: donutHover.x, top: donutHover.y }}
						>
							<div className="usage-trend-tooltip-row">
								<span
									className="usage-dot"
									style={{ background: donut.items[donutHover.i].color }}
								/>
								<span className="usage-trend-tooltip-name">
									{donut.items[donutHover.i].name}
								</span>
							</div>
							<div className="usage-trend-tooltip-row">
								<span>
									{formatTokens(donut.items[donutHover.i].value, lang)} tokens
								</span>
								<span>
									{donut.total > 0
										? Math.round((donut.items[donutHover.i].value / donut.total) * 100)
										: 0}
									%
								</span>
							</div>
						</div>
					)}
					<div className="usage-donut-legend">
						{donut.items.map((it) => (
							<div className="usage-donut-row" key={it.name}>
								<span className="usage-dot" style={{ background: it.color }} />
								<span className="usage-donut-name" title={it.name}>
									{it.name}
								</span>
								<span className="usage-donut-tokens">
									{formatTokens(it.value, lang)} tokens
								</span>
								<span className="usage-donut-pct">
									{donut.total > 0 ? Math.round((it.value / donut.total) * 100) : 0}%
								</span>
							</div>
						))}
					</div>
				</div>
			</div>

			<div className="usage-footer">
				<button
					className="btn secondary usage-refresh"
					disabled={refreshing}
					onClick={load}
				>
					{t.settings.usageRefresh}
				</button>
			</div>
		</div>
	);
}
