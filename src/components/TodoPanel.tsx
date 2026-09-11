import { useEffect, useState } from "react";
import type { MessageCatalog } from "../i18n";
import { ChevronDownIcon } from "../icons";
import type { TodoItem } from "./chat-rows";

/**
 * TodoPanel — floating task-list card (port of the Percho panel). Data
 * source: the session's latest `todo` tool call (full-replace protocol).
 * Hidden entirely when the session never used the todo tool.
 *
 * Collapsed = a one-line capsule (breathing dot + title + progress ring);
 * expanded = the task list. The body stays mounted and is collapsed via a
 * grid-rows 0fr→1fr transition so the card shrinks smoothly.
 */

/** Progress ring geometry (r=8; dashoffset drives the elastic fill). */
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

const COLLAPSED_KEY = "pi-gui.todoCollapsed.v1";

function ProgressRing({ done, total }: { done: number; total: number }) {
	const pct = total > 0 ? done / total : 0;
	return (
		<svg width="20" height="20" viewBox="0 0 20 20" className="todo-ring" aria-hidden="true">
			<circle
				cx="10"
				cy="10"
				r={RING_R}
				fill="none"
				strokeWidth="2.5"
				className="todo-ring-track"
			/>
			<circle
				cx="10"
				cy="10"
				r={RING_R}
				fill="none"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeDasharray={RING_C}
				strokeDashoffset={RING_C * (1 - pct)}
				className="todo-ring-fill"
			/>
		</svg>
	);
}

function TodoRow({ todo, spinning }: { todo: TodoItem; spinning: boolean }) {
	return (
		<li className={`todo-row ${todo.status}`} title={todo.content}>
			<span className="todo-mark" aria-hidden="true">
				{todo.status === "completed" ? (
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M20 6 9 17l-5-5" className="todo-check-path" />
					</svg>
				) : spinning ? (
					<span className="todo-spinner" />
				) : (
					<span className="todo-circle" />
				)}
			</span>
			<span className="todo-text">{todo.content}</span>
		</li>
	);
}

export function TodoPanel({
	todos,
	agentActive,
	t,
}: {
	todos: TodoItem[];
	/** Whether the agent is mid-run — pauses the in-progress spinner. */
	agentActive: boolean;
	t: MessageCatalog;
}) {
	// Expanded by default (matches the reference look); the collapse choice
	// persists across sessions. A session without todos renders nothing.
	const [expanded, setExpanded] = useState(() => localStorage.getItem(COLLAPSED_KEY) !== "1");
	useEffect(() => {
		localStorage.setItem(COLLAPSED_KEY, expanded ? "0" : "1");
	}, [expanded]);
	if (todos.length === 0) return null;
	const done = todos.filter((x) => x.status === "completed").length;
	const hasActive = todos.some((x) => x.status === "in_progress");
	return (
		<div className="todo-panel" data-has-active={hasActive || undefined}>
			<button
				type="button"
				className="todo-head"
				aria-expanded={expanded}
				onClick={() => setExpanded((v) => !v)}
			>
				<span className="todo-breath-dot" aria-hidden="true" />
				<span className="todo-title">{t.todo.title}</span>
				<span className="todo-count">
					{done}/{todos.length}
				</span>
				<ProgressRing done={done} total={todos.length} />
				<ChevronDownIcon size={12} className={`todo-chev${expanded ? " open" : ""}`} />
			</button>
			{/* body 常驻 DOM：grid-rows 0fr→1fr 在卡片内部抽拉，收起时缩回胶囊态 */}
			<div className={`todo-body-wrap${expanded ? " open" : ""}`} aria-hidden={!expanded}>
				<div className="todo-body-clip">
					<ul className="todo-list">
						{todos.map((todo, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 全量替换列表无稳定 id，顺序稳定
							<TodoRow
								key={i}
								todo={todo}
								spinning={todo.status === "in_progress" && agentActive}
							/>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}
