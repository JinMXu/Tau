import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";
import type { MessageCatalog } from "../i18n";
import {
	BranchIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	SearchIcon,
	TerminalIcon,
	XIcon,
} from "../icons";

/** One session entry as returned by pi's `get_tree` RPC command. */
export interface PiTreeEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		text?: string;
		model?: string;
		provider?: string;
		thinkingLevel?: string;
		toolName?: string;
		command?: string;
	};
	[key: string]: unknown;
}

export interface PiTreeNode {
	entry: PiTreeEntry;
	children: PiTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

export interface PiTreeData {
	tree: PiTreeNode[];
	leafId: string | null;
}

type FilterMode = "default" | "noTools" | "userOnly" | "labeledOnly" | "all";

/** Extract a short display label for an entry. */
function entryLabel(entry: PiTreeEntry, t: MessageCatalog): string {
	const m = entry.message;
	switch (entry.type) {
		case "message": {
			const role = m?.role;
			if (role === "user") {
				const text = extractText(m?.content);
				return text ? text.replace(/\s+/g, " ").slice(0, 90) : t.tree.userMessage;
			}
			if (role === "assistant") {
				const text = extractText(m?.content);
				return text
					? t.tree.assistantPrefix + " " + text.replace(/\s+/g, " ").slice(0, 70)
					: t.tree.assistantMessage;
			}
			if (role === "toolResult") {
				return `${t.tree.toolResult}: ${m?.toolName ?? "tool"}`;
			}
			if (role === "custom") return `${t.tree.custom}: ${(entry.message as { customType?: string } | undefined)?.customType ?? ""}`;
			return `${t.tree.message}: ${role ?? "?"}`;
		}
		case "model_change":
			return `${t.tree.modelChange}: ${entry.provider ?? ""}/${entry.modelId ?? ""}`;
		case "thinking_level_change":
			return `${t.tree.thinkingChange}: ${entry.thinkingLevel ?? ""}`;
		case "compaction":
			return t.tree.compaction;
		case "branch_summary":
			return t.tree.branchSummary;
		case "custom":
			return `${t.tree.customEntry}: ${entry.customType ?? ""}`;
		case "label":
			return `${t.tree.labelEntry}: ${entry.label ?? ""}`;
		case "session_info":
			return `${t.tree.sessionInfo}: ${entry.name ?? ""}`;
		default:
			return entry.type;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			const block = b as { type?: string; text?: string; thinking?: string };
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "thinking") return block.thinking ?? "";
			return "";
		})
		.join(" ")
		.trim();
}

/** The message text of a user entry (for copy/fork). */
export function entryUserText(entry: PiTreeEntry): string {
	if (entry.type !== "message" || entry.message?.role !== "user") return "";
	return extractText(entry.message.content);
}

function entryRole(entry: PiTreeEntry): "user" | "assistant" | "tool" | "meta" {
	if (entry.type !== "message") return "meta";
	const role = entry.message?.role;
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	return "tool";
}

function entryMatches(entry: PiTreeEntry, query: string): boolean {
	if (!query) return true;
	const label = JSON.stringify(entry.message ?? {});
	return label.toLowerCase().includes(query);
}

interface FlatNode {
	node: PiTreeNode;
	depth: number;
	visible: boolean;
}

export function TreePanel({
	open,
	data,
	t,
	onClose,
	onFork,
}: {
	open: boolean;
	data: PiTreeData | null;
	t: MessageCatalog;
	onClose: () => void;
	onFork: (entryId: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<FilterMode>("default");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const copyTimerRef = useRef<number>(0);
	useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

	useEffect(() => {
		if (open) {
			setQuery("");
			setFilter("default");
			setCollapsed(new Set());
			setSelectedId(null);
			setCopied(false);
		}
	}, [open]);

	// Flatten the tree with depth; pruning depends on filter + query, so the
	// flattening is recomputed per render (trees are small).
	const flat = useMemo(() => {
		const out: FlatNode[] = [];
		const q = query.trim().toLowerCase();
		const walk = (nodes: PiTreeNode[], depth: number) => {
			for (const node of nodes) {
				const role = entryRole(node.entry);
				let visible = true;
				if (filter === "noTools" && (role === "tool" || node.entry.message?.role === "toolResult")) {
					visible = false;
				} else if (filter === "userOnly" && role !== "user") {
					visible = false;
				} else if (filter === "labeledOnly" && !node.label) {
					visible = false;
				}
				const qMatch = entryMatches(node.entry, q);
				out.push({ node, depth, visible: visible && qMatch });
				walk(node.children, depth + 1);
			}
		};
		walk(data?.tree ?? [], 0);
		return out;
	}, [data, filter, query]);

	const selected = useMemo(() => {
		if (!selectedId) return null;
		for (const f of flat) {
			if (f.node.entry.id === selectedId) return f.node;
		}
		return null;
	}, [flat, selectedId]);

	// Keyboard navigation: move the selection among visible nodes.
	const visibleIds = useMemo(
		() => flat.filter((f) => f.visible).map((f) => f.node.entry.id),
		[flat],
	);
	const handleTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (visibleIds.length === 0) return;
		const idx = selectedId ? visibleIds.indexOf(selectedId) : -1;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedId(
				idx < 0 ? visibleIds[0] : visibleIds[Math.min(idx + 1, visibleIds.length - 1)],
			);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedId(idx < 0 ? visibleIds[0] : visibleIds[Math.max(idx - 1, 0)]);
		} else if (e.key === "Home") {
			e.preventDefault();
			setSelectedId(visibleIds[0]);
		} else if (e.key === "End") {
			e.preventDefault();
			setSelectedId(visibleIds[visibleIds.length - 1]);
		}
	};

	// Keep the selected node visible while navigating.
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const el = list.querySelector(".tree-node.selected") as HTMLElement | null;
		if (!el) return;
		const top = el.offsetTop;
		const bottom = top + el.offsetHeight;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (bottom > list.scrollTop + list.clientHeight) {
			list.scrollTop = bottom - list.clientHeight;
		}
	}, [selectedId, flat]);

	if (!open) return null;

	const toggleCollapse = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const copySelected = async () => {
		if (!selected) return;
		const text = entryUserText(selected.entry);
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.clearTimeout(copyTimerRef.current);
			copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			/* ignore */
		}
	};

	const isLeaf = (id: string) => data?.leafId === id;
	const roleClass = (role: "user" | "assistant" | "tool" | "meta") =>
		role === "meta" ? "meta" : role;

	return (
		<div className="overlay-backdrop">
			<div className="extension-dialog tree-dialog">
				<div className="tree-dialog-header">
					<h3>{t.chat.tree}</h3>
					<button className="icon-btn" title={t.app.close} aria-label={t.app.close} onClick={onClose}>
						<XIcon size={15} />
					</button>
				</div>
				<div className="tree-toolbar">
					<div className="tree-search">
						<SearchIcon size={13} />
						<input
							autoFocus
							value={query}
							placeholder={t.tree.search}
							onChange={(e) => {
								setQuery(e.target.value);
								setSelectedId(null);
							}}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									onClose();
								}
							}}
						/>
					</div>
					<select
						className="tree-filter"
						value={filter}
						onChange={(e) => {
							setFilter(e.target.value as FilterMode);
							setSelectedId(null);
						}}
					>
						<option value="default">{t.tree.filterDefault}</option>
						<option value="noTools">{t.tree.filterNoTools}</option>
						<option value="userOnly">{t.tree.filterUserOnly}</option>
						<option value="labeledOnly">{t.tree.filterLabeledOnly}</option>
						<option value="all">{t.tree.filterAll}</option>
					</select>
				</div>
				<div
					className="tree-list"
					ref={listRef}
					tabIndex={0}
					onKeyDown={handleTreeKey}
				>
					{flat.length === 0 && (
						<div className="tree-empty">{t.tree.empty}</div>
					)}
					{flat.map(({ node, depth, visible }) => {
						if (!visible) return null;
						const id = node.entry.id;
						const hasChildren = node.children.length > 0;
						const isCollapsed = collapsed.has(id);
						const role = entryRole(node.entry);
						const label = entryLabel(node.entry, t);
						const isSel = id === selectedId;
						return (
							<div
								key={id}
								className={`tree-node ${isSel ? "selected" : ""} ${isLeaf(id) ? "leaf" : ""} role-${roleClass(role)}`}
								style={{ paddingLeft: 10 + Math.min(depth, 40) * 16 }}
								onClick={() => setSelectedId(id)}
							>
								<span
									className="tree-chevron"
									onClick={(e) => {
										e.stopPropagation();
										if (hasChildren) toggleCollapse(id);
									}}
								>
									{hasChildren &&
										(isCollapsed ? (
											<ChevronRightIcon size={12} />
										) : (
											<ChevronDownIcon size={12} />
										))}
								</span>
								<span className="tree-role-icon">
									{role === "user" ? (
										<span className="tree-dot user" />
									) : role === "assistant" ? (
										<span className="tree-dot assistant" />
									) : role === "tool" ? (
										<TerminalIcon size={12} />
									) : (
										<BranchIcon size={12} />
									)}
								</span>
								<span className="tree-node-label" title={label}>
									{label}
								</span>
								{node.label && (
									<span className="tree-node-tag">{node.label}</span>
								)}
								{isLeaf(id) && <span className="tree-leaf-mark">◀</span>}
							</div>
						);
					})}
				</div>
				<div className="tree-actions">
					{selected ? (
						<>
							<span className="tree-actions-hint">
								{entryLabel(selected.entry, t)}
							</span>
							<div className="tree-actions-buttons">
								{selected.entry.type === "message" &&
									selected.entry.message?.role === "user" && (
										<button
											className="btn secondary"
											onClick={() => onFork(selected.entry.id)}
										>
											<BranchIcon size={13} />
											<span>{t.tree.forkHere}</span>
										</button>
									)}
								<button className="btn secondary" onClick={() => void copySelected()}>
									{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
									<span>{copied ? t.chat.copied : t.tree.copyText}</span>
								</button>
							</div>
						</>
					) : (
						<span className="tree-actions-hint muted">{t.tree.selectHint}</span>
					)}
				</div>
			</div>
		</div>
	);
}
