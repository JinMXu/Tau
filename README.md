<div align="center">

<img src="public/logo.png" alt="Tau Logo" width="120" height="120" />

# Tau（τ）

**π 只画了半个圆，Tau 把它补成完整的桌面体验。**

Tau（τ = 2π）是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的极简桌面客户端，基于 **Tauri 2 + React 19** 构建。它用干净的原生窗口包裹 Pi，提供项目化会话、流式 Markdown、持久化历史与多窗口体验，让你在不离开代码库的情况下持续推进对话。

[![CI](https://github.com/JinMXu/Tau/actions/workflows/ci.yml/badge.svg)](https://github.com/JinMXu/Tau/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24c8db)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-61dafb)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.96+-orange)](https://www.rust-lang.org)

</div>

---

## ✨ 功能特性

### 💬 会话管理

- **项目化会话** — 每个聊天会话绑定一个工作目录，Agent 在你的项目内读写文件、运行工具，切换项目时上下文跟随。
- **会话标题与续接** — 自动从首条用户消息生成标题，支持重命名；选中已有会话通过 `--session` 续接，历史消息即时回放（带 history 徽标）。
- **新建任务** — 一键开始新会话，支持 `--fork` 分支和 `--name` 自定义名称。
- **消息级分支** — 任意用户消息 hover 出现分支按钮，从该消息 fork 出新会话并自动切换。
- **会话拖拽排序** — 侧边栏会话可拖拽重排，顺序持久化；会话行菜单支持一键移动到其他项目。
- **归档 / 删除 / 恢复** — 软删除移入归档区，可随时恢复；彻底删除移入回收站，仍可手动 purge；归档管理页支持勾选多条批量恢复、只读预览与导出。
- **上次会话自动恢复** — 重启后自动恢复上次打开的会话。

### 🖥️ 聊天体验

- **流式 Markdown** — markstream-react 增量渲染：助手回复经自适应速率控制器逐字平滑流出（不积压、不跳格），支持 GFM 表格、引用、列表；代码块只读编辑器高亮 + 一键复制，公式（KaTeX）与图表（Mermaid）按需加载；超长消息自动降级为纯文本直出。
- **折叠工作组与工具卡片** — 助手的思考与连续工具调用折叠为一行类别汇总（「读取 1 个文件 · 编辑 2 个文件」），工作中实时滚动预览当前活动，展开可见完整参数与输出（高亮渲染）；每轮结束带计时 + 文件改动 footer（±行数，可展开文件列表并联动 diff 侧栏）；任务列表面板（`todo` 工具驱动）与子代理实时状态面板随会话内容自动出现。
- **附件** — Composer 支持拖拽、粘贴、选择添加附件；图片以 base64 dataURL 发送，文本文件内容内联注入，大文件仅记录路径；可清理历史会话中的图片附件以节省空间。
- **模型与思考级别** — 运行时切换 Provider/Model（按 Provider 分组的搜索菜单），选择思考级别。
- **Steer / Follow-up** — 会话运行中发送消息时可选择「立即介入 steered」或「排队等待 follow-up」；排队消息支持立即发送、编辑、删除、拖拽排序，打断后可暂停/继续自动发送。
- **会话内搜索** — Ctrl/Cmd+F 在当前会话中全文搜索（文本/思考/工具参数），显示命中计数，上下跳转定位，命中关键词高亮。
- **全文搜索** — ⌘K 唤起搜索浮层，跨所有会话标题和消息内容搜索，带片段预览，点击跳转。
- **Compact** — 一键压缩对话上下文。
- **上下文用量显示** — 会话标题栏实时显示上下文窗口占用百分比（tooltip 含 tokens 明细与费用），阈值变色提醒。
- **Escape 中断** — 全局 Esc 键中断当前回合（输入框或对话框打开时不触发）。
- **错误卡片与自动重试** — LLM / 网络 / 认证错误按类别渲染为可折叠错误卡（原始明细 + 建议 + 重试 / 压缩上下文 / 打开设置动作）；发送失败与工具失败同样在对应消息上可见；历史会话重开后失败轮次保留错误卡。可重试失败（超时 / 过载）自动指数退避重试，等待期显示「第 N / M 次 + 倒计时 + 错误预览」。错误卡上的「重试」会重发该轮的用户消息。
- **消息级复制** — 每条消息 hover 出现操作按钮：分支（用户消息）、复制为 Markdown、复制纯文本。
- **会话导出** — 会话菜单支持导出为 Markdown、原始 JSONL 或带样式的 HTML 文件（原生保存对话框，HTML 由内置运行时生成，无需安装 pi CLI）。

### 🧩 扩展与定制

- **扩展与 Skills 管理** — 内置精选 Pi 包目录（100 个，按下载量排序，支持搜索），一键安装/移除扩展、skills、提示词、主题；支持自定义包源（npm/git/本地路径）；列出已安装的 skills。
- **自定义 Agent 工具** — Composer 扳手按钮可勾选允许 Pi 使用的工具（read/write/edit/bash/grep/find/ls），下次连接会话时通过 `--tools` 生效。
- **自定义系统提示词** — 设置页内置 Markdown 编辑器，自定义 Pi 的系统指令，下次连接会话时通过 `--system-prompt` 生效。
- **聊天内 API Key 提示** — 发送消息时若所选 Provider 未配置 Key，直接在聊天内弹窗填写，无需跳转设置页。
- **模型提供商配置** — 设置页动态读取 Pi 内置的全部模型提供商（约 40 个：Anthropic/OpenAI/Gemini/DeepSeek/Kimi/OpenRouter 等，含 `models.json` 自定义提供商），可逐个配置 API Key，读写 `~/.pi/agent/auth.json`（内置运行时直接读取，若同时使用 Pi 的 TUI/CLI 则凭据互通），OAuth 登录状态同样可见，且登录流程内置（设备码 + 浏览器授权），无需终端。
- **MCP 服务器管理** — 设置页「MCP 服务」合并展示 pi-mcp-adapter 各配置层（shared / .agents / pi，全局与项目）的服务器定义，标注来源层与传输类型；支持启停（镜像 `/mcp` 适配器语义，只读共享层通过覆盖实现）、在可写的全局 `~/.pi/agent/mcp.json` 或项目 `.mcp.json` 中新建/编辑/删除，表单与 JSON 双模式编辑。
- **扩展 UI 对话框** — 处理 Pi 的 `extension_ui_request` 事件（select / confirm / input / notify），回传 `extension_ui_response`。

### 🪟 桌面体验

- **多窗口** — 应用菜单「新窗口」或 Ctrl/Cmd+Shift+N 打开独立窗口，每个窗口拥有自己的 pi 进程与会话；同一会话文件同时只能被一个窗口打开（冲突时新窗口自动改用新会话）。窗口关闭时自动回收其 pi 进程。
- **Git 分支集成** — 工作目录为 Git 仓库时，Composer 显示当前分支（含未提交文件数徽标），可一键切换已有分支或创建新分支。
- **原生菜单** — 应用/编辑/视图原生菜单（复制粘贴、全屏等），随界面语言切换即时重建（中文/英文）。
- **双语界面** — 中文 / English 一键切换。
- **窗口状态持久化** — 窗口大小/位置/最大化状态自动保存并在重启后恢复。
- **首次启动引导** — 未选择工作目录时展示欢迎界面与引导按钮。
- **调试日志** — 启动与连接事件写入应用配置目录的 `logs/tau.log`。
- **快捷键** — ⌘K 搜索、⌘N 新任务、Shift+⌘N 新窗口、⌘, 设置、⌘B 折叠侧边栏、⌘L 聚焦输入框、⌘F 会话内搜索、Shift+⌘A 归档当前会话（macOS 用 ⌘，Windows/Linux 对应 Ctrl；界面提示按平台自动切换）。
- **设置** — 主题（浅色/深色/跟随系统）、6 种色调（Mist/Paper/Sand/Gray/Forest/Ocean）、字号、消息密度、聊天字体（系统/霞鹜文楷/朱雀仿宋）、内容宽度（标准/宽/超宽）、行距、语言、默认发送模式（steer/follow-up）、上下文用量开关、失败自动重试开关、默认思考级别、pi 版本信息（内置运行时有标注）、会话目录、归档管理。
- **项目行操作** — 侧边栏项目行 hover 显示操作：在文件夹中显示、删除项目（归档该项目下全部会话，可恢复）。

---

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://www.rust-lang.org)（stable，建议 1.85+）
- 开发与打包均使用**内置 pi 运行时**（`npm run vendor:pi` 拉取到 `src-tauri/resources/pi-runtime/`，含按宿主平台的 Node 与 pi 包）；会话层由 pi SDK 驱动（`session-host.mjs`），**不依赖系统安装的 pi CLI**，用户无需自行安装任何东西

### 运行

```bash
# 安装前端依赖
npm install

# （开发与打包都需要；打包构建时也会自动执行）拉取内置 pi 运行时
# 到 src-tauri/resources/pi-runtime/（按宿主平台的 Node 运行时 + pi 包，约 100 MB，不入库）
npm run vendor:pi

# 开发模式（启动 Tauri 开发窗口）
npm run tauri dev

# 仅启动前端 dev server（浏览器预览，无 Tauri IPC）
npm run dev

# 类型检查 + 生产构建
npm run build

# 前端单元测试（vitest：行派生与消息工具 / 流式渲染契约 / 折叠组 / 统计页等）
npm test

# Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

CI（GitHub Actions，`.github/workflows/ci.yml`）：push/PR 时自动运行 `tsc + vitest + 前端构建`（ubuntu）与 `cargo test --lib`（windows）。

---

## 🏗️ 技术架构

```
┌──────────────────────────────────────────┐
│  前端 (React 19 + TypeScript + Vite)      │
│  ┌───────────┐  ┌──────────────────────┐  │
│  │  Sidebar   │  │       ChatArea       │  │
│  │  项目分组   │  │  ┌────────────────┐ │  │
│  │  会话列表   │  │  │   Markdown     │ │  │
│  │  搜索/设置  │  │  │   思考/工具卡   │ │  │
│  │            │  │  │   Composer     │ │  │
│  └───────────┘  │  └──────────────────┘ │
│                 └──────────────────────┘  │
└───────────┬──────────────────────────────┘
            │ Tauri invoke()
┌───────────▼──────────────────────────────┐
│  Rust 后端 (src-tauri)                    │
│  ┌──────────────────────────────────┐    │
│  │  Pi Session 管理 (pi.rs)          │    │
│  │  · spawn session-host（每会话）  │    │
│  │  · JSONL 读取/解析/搜索            │    │
│  │  · 归档/删除/恢复/清除            │    │
│  └──────────────────────────────────┘    │
│  ┌──────────────────────────────────┐    │
│  │  SDK Sidecar (sidecar.rs)        │    │
│  │  · 内置 node 直跑 pi SDK         │    │
│  │  · 会话解析/HTML 导出/包管理     │    │
│  └──────────────────────────────────┘    │
└───────────┬──────────────────────────────┘
            │ stdin/stdout JSON-RPC
┌───────────▼──────────────────────────────┐
│  session-host.mjs（SDK 会话宿主）         │
│  · AgentSessionRuntime / AgentSession     │
│  · 内置 node 运行，纯 SDK，无 CLI 依赖    │
│  会话 JSONL: ~/.pi/agent/sessions/*.jsonl │
└──────────────────────────────────────────┘
```

前端通过 Tauri 的 `invoke()` 调用 Rust 命令，Rust 负责 spawn 会话宿主进程并通过 stdin/stdout 转发 JSON-RPC 消息，同时直接读取会话 JSONL 文件实现历史回放、搜索和归档。会话宿主是 `resources/agent-sidecar/session-host.mjs`：由内置 Node 运行，基于 pi SDK（`AgentSessionRuntime` / `AgentSession`）实现与 `pi --mode rpc` 完全一致的 JSON-RPC 协议，**完全不依赖 pi CLI**。运行时只使用 vendored `pi-runtime/`（可用 `TAU_PI_RUNTIME` 覆盖），系统 PATH 上的 pi 不再被探测；过渡期内可设 `TAU_PI_RPC=cli` 回退到旧 CLI 路径。

### Pi RPC 命令

Tau 通过以下 JSON-RPC 命令与 Pi 通信：

`prompt` · `steer` · `follow_up` · `abort` · `new_session` · `compact` ·
`set_model` · `set_thinking_level` · `get_available_models` · `get_state` ·
`get_available_thinking_levels` · `set_session_name` · `switch_session` ·
`fork` · `clone` · `get_messages` · `get_session_stats` · `extension_ui_response`

图像附件格式：`{ type: "image", mimeType, data: <base64> }`

### SDK Sidecar 与桌面工具

内置运行时不仅支撑 RPC 会话，还打开了 pi SDK 的编程通道：

- **SDK 会话宿主**（`session-host.mjs`）— 会话主链路：每个聊天 channel 一个宿主进程，`import` vendored pi 包的 SDK 实现 RPC 协议服务端（移植自 pi 的 `rpc-mode.js`）。**pi 升级时需对照新版 `rpc-mode.js` diff 同步本文件**。
- **SDK Sidecar**（`sidecar.rs` + `resources/agent-sidecar/sidecar.mjs`）— 由内置 node 直接 `import` vendored pi 包，Rust 通过 stdio JSONL 协议调用 SDK 能力（`parseSessionEntries` 结构化解析、HTML 导出、扩展包管理等），前端设置页「关于」可查看 Sidecar 状态。
- **桌面工具扩展**（`tau-extension.mjs`）— 由会话宿主经 `additionalExtensionPaths` 加载，用 SDK 的 `registerTool` 注册 Tau 专属工具（首个为 `tau_open_in_editor`：在 VS Code/记事本中打开文件），让 agent 获得终端 CLI 不具备的桌面能力。
- SDK 调用统一收口在 agent-sidecar 模块，pi 版本升级时只需适配一处；升级检查单：`vendor-pi.mjs`  bump 版本 → 对照新包 `rpc-mode.js` diff `session-host.mjs` → 跑 `scripts/spike/` 下三个验证脚本。

---

## 🧰 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite |
| Markdown | markstream-react（流式增量渲染 + 代码块编辑器高亮，KaTeX / Mermaid 按需） |
| UI 组件 | beUI 动效组件（AgentActivity / ToolResult / CenterMorphModal 等）+ motion |
| 后端 | Rust（pi.rs 管理进程、JSONL、搜索、归档） |
| Agent | Pi Coding Agent SDK（`session-host.mjs` 驱动 `AgentSession`；内置运行时，无需安装 pi） |
| 状态 | localStorage + 会话 JSONL 直接读取 |

## 🎨 界面设计

Tau 的界面以暖中性色调为基调：

- 暖中性色调（Mist 默认）的侧边栏 + 浅色聊天面板
- 项目分组的侧边栏会话列表
- 悬浮胶囊式 Composer
- 流式 Markdown + 折叠工具卡片
- 会话标题、模型徽标、相对时间

Logo 设计概念：**τ = 2π** —— 半圆补全为完整的圆，象征 Tau 把 Pi 的体验“画完整”。

---

## 🤝 贡献

欢迎提交 Issue 与 Pull Request！请确保：

- 前端改动通过 `npx tsc --noEmit` 与 `npm test`
- Rust 改动通过 `cargo test --manifest-path src-tauri/Cargo.toml --lib`

## 📄 License

[MIT](LICENSE)
