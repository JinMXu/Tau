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

- **流式 Markdown** — 助手回复实时渲染，支持 GFM 表格、引用、列表，rehype-highlight 代码高亮 + 一键复制。
- **思考块与工具卡片** — 助手思考过程可折叠展示；工具调用按类型显示对应图标（终端/文件夹/文件/搜索/闪电），参数可展开；工具写入的文件一键打开预览。
- **附件** — Composer 支持拖拽、粘贴、选择添加附件；图片以 base64 dataURL 发送，文本文件内容内联注入，大文件仅记录路径；可清理历史会话中的图片附件以节省空间。
- **模型与思考级别** — 运行时切换 Provider/Model（按 Provider 分组的搜索菜单），选择思考级别。
- **Steer / Follow-up** — 会话运行中发送消息时可选择「立即介入 steered」或「排队等待 follow-up」；排队消息支持立即发送、编辑、删除、拖拽排序，打断后可暂停/继续自动发送。
- **会话内搜索** — Ctrl/Cmd+F 在当前会话中全文搜索（文本/思考/工具参数），显示命中计数，上下跳转定位，命中关键词高亮。
- **全文搜索** — ⌘K 唤起搜索浮层，跨所有会话标题和消息内容搜索，带片段预览，点击跳转。
- **Compact** — 一键压缩对话上下文。
- **上下文用量显示** — 会话标题栏实时显示上下文窗口占用百分比（tooltip 含 tokens 明细与费用），阈值变色提醒。
- **Escape 中断** — 全局 Esc 键中断当前回合（输入框或对话框打开时不触发）。
- **消息级复制** — 每条消息 hover 出现操作按钮：分支（用户消息）、复制为 Markdown、复制纯文本。
- **会话导出** — 会话菜单支持导出为 Markdown、原始 JSONL 或带样式的 HTML 文件（原生保存对话框，HTML 由 pi CLI 生成）。

### 🧩 扩展与定制

- **扩展与 Skills 管理** — 内置精选 Pi 包目录（100 个，按下载量排序，支持搜索），一键安装/移除扩展、skills、提示词、主题；支持自定义包源（npm/git/本地路径）；列出已安装的 skills。
- **自定义 Agent 工具** — Composer 扳手按钮可勾选允许 Pi 使用的工具（read/write/edit/bash/grep/find/ls），下次连接会话时通过 `--tools` 生效。
- **自定义系统提示词** — 设置页内置 Markdown 编辑器，自定义 Pi 的系统指令，下次连接会话时通过 `--system-prompt` 生效。
- **聊天内 API Key 提示** — 发送消息时若所选 Provider 未配置 Key，直接在聊天内弹窗填写，无需跳转设置页。
- **模型提供商配置** — 设置页动态读取 Pi 内置的全部模型提供商（约 40 个：Anthropic/OpenAI/Gemini/DeepSeek/Kimi/OpenRouter 等，含 `models.json` 自定义提供商），可逐个配置 API Key，读写 `~/.pi/agent/auth.json`，与 Pi CLI 共享凭据，OAuth 登录状态同样可见。
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
- **设置** — 主题（浅色/深色/跟随系统）、6 种色调（Mist/Paper/Sand/Gray/Forest/Ocean）、字号、消息密度、聊天字体（系统/霞鹜文楷/朱雀仿宋）、内容宽度（标准/宽/超宽）、行距、语言、默认发送模式（steer/follow-up）、上下文用量开关、失败自动重试开关、默认思考级别、pi 版本信息、会话目录、归档管理。
- **项目行操作** — 侧边栏项目行 hover 显示操作：在文件夹中显示、删除项目（归档该项目下全部会话，可恢复）。

---

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://www.rust-lang.org)（stable，建议 1.85+）
- [Pi Coding Agent](https://github.com/earendil-works/pi)（`pi` 命令可用）

### 运行

```bash
# 安装前端依赖
npm install

# 开发模式（启动 Tauri 开发窗口）
npm run tauri dev

# 仅启动前端 dev server（浏览器预览，无 Tauri IPC）
npm run dev

# 类型检查 + 生产构建
npm run build

# 前端单元测试（vitest：message-utils / settings / i18n）
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
│  │  · spawn pi --mode rpc            │    │
│  │  · JSONL 读取/解析/搜索            │    │
│  │  · 归档/删除/恢复/清除            │    │
│  └──────────────────────────────────┘    │
└───────────┬──────────────────────────────┘
            │ stdin/stdout JSON-RPC
┌───────────▼──────────────────────────────┐
│  Pi Coding Agent (pi --mode rpc)         │
│  会话 JSONL: ~/.pi/agent/sessions/*.jsonl │
└──────────────────────────────────────────┘
```

前端通过 Tauri 的 `invoke()` 调用 Rust 命令，Rust 负责 spawn Pi RPC 进程并通过 stdin/stdout 转发 JSON-RPC 消息，同时直接读取会话 JSONL 文件实现历史回放、搜索和归档。

### Pi RPC 命令

Tau 通过以下 JSON-RPC 命令与 Pi 通信：

`prompt` · `steer` · `follow_up` · `abort` · `new_session` · `compact` ·
`set_model` · `set_thinking_level` · `get_available_models` · `get_state` ·
`get_available_thinking_levels` · `set_session_name` · `switch_session` ·
`fork` · `clone` · `get_messages` · `get_session_stats` · `extension_ui_response`

图像附件格式：`{ type: "image", mimeType, data: <base64> }`

---

## 🧰 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite |
| Markdown | react-markdown + rehype-highlight |
| 后端 | Rust（pi.rs 管理进程、JSONL、搜索、归档） |
| Agent | Pi Coding Agent（`pi --mode rpc`） |
| 状态 | localStorage + 会话 JSONL 直接读取 |

## 🎨 设计参考

本项目参考了 [Ousia](https://github.com/s1dashu/ousia) 的设计理念：

- 暖中性色调（Mist 默认）的侧边栏 + 浅色聊天面板
- 项目分组的侧边栏会话列表
- 悬浮胶囊式 Composer
- 流式 Markdown + 折叠工具卡片
- 会话标题、模型徽标、相对时间

Logo 设计概念：**τ = 2π** —— 半圆补全为完整的圆，象征 Tau 把 Pi 的体验"画完整"。（设计提示词见 [`docs/logo-prompts.md`](docs/logo-prompts.md)）

---

## 🤝 贡献

欢迎提交 Issue 与 Pull Request！请确保：

- 前端改动通过 `npx tsc --noEmit` 与 `npm test`
- Rust 改动通过 `cargo test --manifest-path src-tauri/Cargo.toml --lib`

## 📄 License

[MIT](LICENSE)
