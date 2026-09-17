/* App mock harness (dev-only, /app-mock.html): the REAL App against the
 * scripted IPC backend from tauri-mock.ts (imported first). */
import "./tauri-mock";
import { createRoot } from "react-dom/client";
import * as React from "react";
import App from "./App";
// App.tsx already pulls in the styles via beui.css (layered tailwind +
// App.css); importing App.css here as well would emit an unlayered copy that
// beats the utilities layer and breaks the beUI components.
import "./beui.css";

const root = createRoot(document.getElementById("root")!, {
	onUncaughtError: (error, errorInfo) => {
		console.error("[mock] uncaught:", String(error).slice(0, 200));
		console.error("[mock] component stack:", errorInfo.componentStack?.slice(0, 800));
	},
});
const strict = new URLSearchParams(location.search).get("strict") !== "0";
console.log("[mock] strict =", strict);
if (strict) {
	root.render(React.createElement(React.StrictMode, null, React.createElement(App)));
} else {
	root.render(React.createElement(App));
}

// ---- scripted turn driver ----------------------------------------------------
const ANSWER = [
	"这是一个名为 **Tau** 的项目，是 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 的极简桌面客户端。",
	"",
	"## 项目定位",
	"",
	"正如其名「τ = 2π」，Tau 把 Pi 的体验「画完整」——将命令行的 Pi Agent 包裹在干净的原生桌面窗口中，提供更友好的交互界面。",
	"",
	"## 技术栈",
	"",
	"| 层 | 技术 |",
	"| --- | --- |",
	"| 桌面框架 | **Tauri 2**（跨平台桌面应用） |",
	"| 前端 | **React 19 + TypeScript + Vite** |",
	"| 后端 | **Rust**（进程管理、JSONL 解析、搜索归档） |",
	"| Agent | Pi Coding Agent（pi --mode rpc） |",
	"",
	"## 核心架构",
	"",
	"```bash",
	"前端 (React) → Tauri invoke() → Rust 后端 → stdin/stdout JSON-RPC → Pi Agent 进程",
	"```",
	"",
	"- **前端**：负责 UI 渲染（侧边栏、聊天区、Composer、Markdown 流式渲染）",
	"- **Rust 后端**：管理 Pi 进程生命周期、读取会话 JSONL 文件、处理搜索和归档",
	"- **Pi Agent**：实际执行代码读写、工具调用等任务的 AI Agent",
	"",
	"## 主要功能",
	"",
	"1. **项目化会话** — 每个聊天绑定一个工作目录，Agent 在项目内读写文件",
	"2. **流式 Markdown** — 助手回复实时渲染，支持代码高亮、表格、思考块",
	"3. **多窗口** — 每个窗口独立的 Pi 进程和会话",
	"4. **会话管理** — 标题自动生成、续接、分支、拖拽排序、归档/删除/恢复",
	"5. **扩展系统** — 内置 Pi 包目录，一键安装扩展、Skills、提示词、主题",
	"6. **桌面集成** — 原生菜单、Git 分支显示、窗口状态持久化、双语界面",
	"",
	"## 项目约定",
	"",
	"根据 `AGENTS.md`，当前修改仅针对 **Windows 版本**（除非是平台无关的 bug）。",
	"",
	"这是一个相当成熟的桌面客户端项目，将命令行 AI Agent 体验提升到了图形交互层面。",
].join("\n");

const w = window as unknown as {
	__emit: (event: string, payload: unknown) => void;
	__chanId?: string;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (e: unknown) => w.__emit("pi://event", { chan: w.__chanId ?? "c1", ev: e });

async function scriptedTurn(withTools: boolean) {
	w.__emit("pi://event", { chan: w.__chanId ?? "c1", ev: { type: "agent_start" } });
	await sleep(400);

	if (withTools) {
		// ---- assistant message #1: thinking + 2 reads ----
		ev({ type: "message_start", message: { role: "assistant" } });
		await sleep(120);
		ev({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
		const THINK =
			"用户要项目介绍。先读 AGENTS.md 和 README.md，再看看目录结构，然后组织成一段清晰的介绍。";
		for (let i = 0; i < THINK.length; i += 30) {
			ev({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: THINK.slice(i, i + 30) },
			});
			await sleep(24);
		}
		ev({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
		for (const p of ["AGENTS.md", "README.md"]) {
			ev({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
			await sleep(60);
			ev({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					toolCall: { name: "read", arguments: { path: p } },
				},
			});
		}
		ev({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: THINK },
					{ type: "toolCall", name: "read", arguments: { path: "AGENTS.md" } },
					{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
				],
			},
		});
		await sleep(80);
		for (const p of ["AGENTS.md", "README.md"]) {
			ev({ type: "message_start", message: { role: "toolResult", toolName: "read" } });
			await sleep(40);
			ev({
				type: "message_end",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: `# ${p}\n（mock 文件内容，供渲染用）` }],
				},
			});
			await sleep(40);
		}
		// ---- assistant message #2: 2 bash + final answer ----
		ev({ type: "message_start", message: { role: "assistant" } });
		await sleep(100);
		for (const c of ["ls src", "ls src-tauri"]) {
			ev({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
			await sleep(50);
			ev({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					toolCall: { name: "bash", arguments: { command: c } },
				},
			});
		}
		ev({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
		const chunk = 40;
		for (let i = 0; i < ANSWER.length; i += chunk) {
			ev({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: ANSWER.slice(i, i + chunk) },
			});
			await sleep(45); // model-paced chunks; the smooth controller lags behind
		}
		ev({ type: "message_update", assistantMessageEvent: { type: "text_end", content: ANSWER } });
		await sleep(60);
		ev({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash", arguments: { command: "ls src" } },
					{ type: "toolCall", name: "bash", arguments: { command: "ls src-tauri" } },
					{ type: "text", text: ANSWER },
				],
			},
		});
		await sleep(80);
		for (const c of ["src 目录列表…", "src-tauri 目录列表…"]) {
			ev({ type: "message_start", message: { role: "toolResult", toolName: "bash" } });
			await sleep(30);
			ev({
				type: "message_end",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: c }],
				},
			});
			await sleep(30);
		}
	} else {
		ev({ type: "message_start", message: { role: "assistant" } });
		await sleep(100);
		ev({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
		const chunk = 40;
		for (let i = 0; i < ANSWER.length; i += chunk) {
			ev({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: ANSWER.slice(i, i + chunk) },
			});
			await sleep(45);
		}
		ev({ type: "message_update", assistantMessageEvent: { type: "text_end", content: ANSWER } });
		await sleep(60);
		ev({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: ANSWER }] },
		});
		await sleep(80);
	}

	ev({ type: "agent_end" });
	await sleep(30);
	ev({ type: "agent_settled" });
}

(window as unknown as Record<string, unknown>).__mockTurn = scriptedTurn;
