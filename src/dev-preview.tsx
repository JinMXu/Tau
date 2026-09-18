import { createRoot } from "react-dom/client";
// Tailwind entry (layered tailwind + preflight + App.css + token bridge) —
// the beUI message-area components carry Tailwind utilities, so the preview
// must load the same stylesheet host as the app. See beui.css.
import "./beui.css";
import { getMessages } from "./i18n";
import type { ChatMessage } from "./chat-types";
import { MessageList } from "./components/MessageList";
import { TodoPanel } from "./components/TodoPanel";
import { DiffSidebar } from "./components/DiffSidebar";
import { deriveTurnChanges } from "./components/chat-rows";

/**
 * Static preview harness (dev-only, not part of the app bundle): renders
 * the ported Percho UI — meta groups, todo panel, turn rows, diff sidebar —
 * against mock data so the visual result can be screenshotted headlessly.
 * Open /preview.html on the vite dev server.
 */

const t = getMessages("zh");

let id = 1;
const m = (
	role: ChatMessage["role"],
	blocks: ChatMessage["blocks"],
	extra?: Partial<ChatMessage>,
): ChatMessage => ({
	id: id++,
	role,
	blocks,
	streaming: false,
	...extra,
});

const messages: ChatMessage[] = [
	m(
		"user",
		[
			{
				kind: "text",
				text: "修复一个问题，当前项目中切换会话会把运行中的会话杀掉，我希望多个会话可以同时运行。",
			},
		],
		{
			timestamp: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
		},
	),
	m(
		"assistant",
		[
			{
				kind: "thinking",
				text: "问题是 pi_start 在切换会话时先 kill 上一个进程……我需要把进程表按 channel 键控，事件打上 channel 标签。",
			},
			{ kind: "tool", name: "read", args: JSON.stringify({ path: "src-tauri/src/pi.rs" }) },
			{
				kind: "tool",
				name: "bash",
				args: JSON.stringify({ command: "cargo check 2>&1 | tail -30" }),
			},
		],
		{ timestamp: new Date(Date.now() - 21 * 60 * 1000).toISOString() },
	),
	m(
		"tool",
		[
			{
				kind: "tool",
				name: "read",
				args: "pub struct PiState {\n\tinner: Arc<Mutex<HashMap<String, PiProcess>>>,\n}",
				result: true,
			},
		],
		{
			timestamp: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
		},
	),
	m(
		"tool",
		[
			{
				kind: "tool",
				name: "bash",
				args: "warning: unused import\n    Finished dev profile in 0.60s",
				result: true,
			},
		],
		{
			timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
		},
	),
	m(
		"assistant",
		[
			{
				kind: "text",
				text: "根因找到了：**一个窗口 = 一个 pi 进程**。我把进程表改为按「窗口 × channel」键控，切换会话只切显示、不杀进程。",
			},
		],
		{
			timestamp: new Date(Date.now() - 19 * 60 * 1000).toISOString(),
		},
	),
	m(
		"assistant",
		[
			{
				kind: "tool",
				name: "edit",
				args: JSON.stringify({
					path: "src-tauri/src/pi.rs",
					oldText: "let old = map.remove(&label);",
					newText: "let old = map.remove(&channel_key(&label, chan));",
				}),
			},
		],
		{
			timestamp: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
		},
	),
	m(
		"assistant",
		[{ kind: "text", text: "改动很小：只是把进程表的键从窗口标签换成 channel_key。" }],
		{
			timestamp: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
		},
	),
	m(
		"assistant",
		[
			{
				kind: "thinking",
				text: "用户让我做自我介绍。我是运行在 pi coding agent 环境的编码助手，应该说明我能做什么：读懂代码、精确编辑、跑命令、派子代理、调用 MCP 工具……组织成一份清晰的回答。",
			},
		],
		{
			timestamp: new Date(Date.now() - 97 * 1000).toISOString(),
		},
	),
	m(
		"assistant",
		[
			{
				kind: "text",
				text: [
					"你好！我是一个运行在 pi 编码助手环境中的 AI 编程助手。",
					"",
					"## 我能做什么",
					"",
					"- 📖 阅读、分析代码文件（支持文本和图片）",
					"- 🔧 精确编辑代码（多位置修改、重构）",
				].join("\n"),
			},
		],
		{
			timestamp: new Date(Date.now() - 95 * 1000).toISOString(),
		},
	),
	m("user", [{ kind: "text", text: "看看这两张截图，然后继续把渲染和任务清单也做了。" }], {
		timestamp: new Date(Date.now() - 90 * 1000).toISOString(),
		images: [
			{
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfSQKYzliH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB0rMBhyUu39kAAAAASUVORK5CYII=",
			},
			{
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtxmn/V1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBmNlhtM/v+fQAAAAASUVORK5CYII=",
			},
		],
	}),
	m(
		"assistant",
		[
			{
				kind: "thinking",
				text: "现在处理 MetaGroup 的折叠组渲染——运行中显示 orb + 预览行 + 圆点，结束后折叠成分类统计：",
			},
			{
				kind: "tool",
				name: "edit",
				args: JSON.stringify({
					path: "src/components/MessageList.tsx",
					oldText: "{items.map((item) => (\n\t<div key={item.msg.id}>",
					newText: "{rows.map((row) => (\n\t<Row key={row.key} row={row} />",
				}),
			},
			{
				kind: "tool",
				name: "bash",
				args: JSON.stringify({
					command:
						"npx vitest run src/__tests__/chat-rows.test.ts src/__tests__/activity-ticker.test.ts src/__tests__/preview-ticker.test.tsx",
				}),
			},
		],
		{ streaming: true, timestamp: new Date(Date.now() - 60 * 1000).toISOString() },
	),
];

const todos = [
	{ content: "调研现有单进程架构（后端 pi.rs + 前端 App.tsx）", status: "completed" as const },
	{
		content: "后端：进程 map 按「窗口|channel」键控，事件带上 channel 标签",
		status: "completed" as const,
	},
	{
		content: "后端：pi_start/pi_send/pi_stop/pi_status 支持 channel 参数",
		status: "completed" as const,
	},
	{ content: "前端 pi.ts：start/send/stop/status 透传 channel", status: "in_progress" as const },
	{ content: "前端 App.tsx：channel 注册表 + 事件路由", status: "pending" as const },
	{ content: "前端：按会话的 working/queue 状态（侧栏并发运行指示）", status: "pending" as const },
	{ content: "回归测试 + 构建验证", status: "pending" as const },
];

const turnChanges = deriveTurnChanges(messages);

function Preview() {
	return (
		<div
			className="chat"
			style={{
				height: "100vh",
				display: "flex",
				flexDirection: "column",
				background: "var(--app-bg)",
				color: "var(--app-fg)",
			}}
		>
			<div className="chat-main-row" style={{ flex: 1 }}>
				<div className="chat-col">
					<MessageList
						messages={messages}
						stream={null}
						streaming={false}
						working={true}
						t={t}
						turnStartTime={Date.now() - 90 * 1000}
						turnChanges={turnChanges}
						onOpenDiff={() => {}}
					/>
					<TodoPanel todos={todos} agentActive={true} t={t} />
				</div>
				<DiffSidebar
					open={true}
					turns={turnChanges}
					scope="all"
					onScopeChange={() => {}}
					onClose={() => {}}
					branch="main"
					t={t}
				/>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Preview />);
