import { useCallback, useEffect, useRef, useState } from "react";
import { searchSessions, type PiSearchHit } from "../pi";
import type { MessageCatalog } from "../i18n";
import { FolderIcon, SearchIcon } from "../icons";

export function SearchOverlay({
	t,
	open,
	onClose,
	onSelect,
}: {
	t: MessageCatalog;
	open: boolean;
	onClose: () => void;
	onSelect: (path: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<PiSearchHit[]>([]);
	const [loading, setLoading] = useState(false);
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const timerRef = useRef<number>(0);
	const reqIdRef = useRef(0);

	useEffect(() => {
		if (open) {
			setQuery("");
			setHits([]);
			setActive(0);
			setTimeout(() => inputRef.current?.focus(), 30);
		}
	}, [open]);

	useEffect(() => {
		window.clearTimeout(timerRef.current);
		const q = query.trim();
		if (!q || !open) {
			setHits([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		// Monotonic request id so a slower, older scan can't overwrite a newer
		// query's results when responses arrive out of order.
		const reqId = ++reqIdRef.current;
		timerRef.current = window.setTimeout(async () => {
			try {
				const result = await searchSessions(q, 30);
				if (reqIdRef.current !== reqId) return;
				setHits(result);
				setActive(0);
			} catch {
				if (reqIdRef.current !== reqId) return;
				setHits([]);
			} finally {
				if (reqIdRef.current === reqId) setLoading(false);
			}
		}, 180);
		return () => window.clearTimeout(timerRef.current);
	}, [query, open]);

	const select = useCallback(
		(path: string) => {
			onSelect(path);
			onClose();
		},
		[onSelect, onClose],
	);

	if (!open) return null;

	return (
		<div
			className="overlay-backdrop"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="search-overlay">
				<div className="search-input-row">
					<SearchIcon size={16} />
					<input
						ref={inputRef}
						value={query}
						placeholder={t.search.placeholder}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								onClose();
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								setActive((a) => Math.min(a + 1, hits.length - 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setActive((a) => Math.max(a - 1, 0));
							} else if (e.key === "Enter" && hits[active]) {
								e.preventDefault();
								select(hits[active].path);
							}
						}}
					/>
					<kbd>esc</kbd>
				</div>
				<div className="search-results">
					{loading && <div className="search-status">…</div>}
					{!loading && query.trim() && hits.length === 0 && (
						<div className="search-status">{t.search.noResults}</div>
					)}
					{!query.trim() && (
						<div className="search-status">{t.search.all}</div>
					)}
					{hits.map((hit, i) => (
						<button
							key={hit.path}
							className={`search-hit ${i === active ? "active" : ""}`}
							onMouseEnter={() => setActive(i)}
							onClick={() => select(hit.path)}
						>
							<div className="search-hit-title">
								<FolderIcon size={13} />
								<span className="search-hit-name">{hit.title}</span>
								{hit.project && (
									<span className="search-hit-project">{hit.project}</span>
								)}
							</div>
							{hit.snippet && (
								<div className="search-hit-snippet">{hit.snippet}</div>
							)}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
