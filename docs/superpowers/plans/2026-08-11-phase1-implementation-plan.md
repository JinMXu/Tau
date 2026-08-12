# 阶段 1 实施计划 — Token 体系 + 图标重绘 + 会话输出

设计依据：`docs/superpowers/specs/2026-08-11-ui-redesign-design.md`（已批准）。
参考 mockup：`.superpowers/brainstorm/482-1786409229/content/chat-output.html`（文档流 + 状态化工具行的具体视觉）。

## 任务分解

1. **图标重绘**（`src/icons.tsx`）
   - 24×24 网格，strokeWidth 1.8 → 1.5，保持导出名与 `size` prop 不变；
   - `SparkleIcon` 米字 → 四角星；`MoreIcon` / `StopIcon` 等实心款改为细线风格一致的表达；
   - 工具类图标统一视觉语言；按需补充 copy / 思考 / 耗时等新图标。

2. **语义 token 层**（`src/App.css` 顶部 `:root` + 各 accent / 暗色覆盖）
   - 新增 `--text-1/2/3`、`--surface-0/1/2`、`--border-1/2`、`--status-ok/warn/err/run`；
   - 字阶 `--fs-xs/sm/md/lg/xl`、间距 `--sp-1..6`、圆角 `--r-sm/md/lg`、两级阴影、`--ease` + 150ms；
   - 映射到现有变量，旧选择器逐步切换，不一次性全量替换（防爆）。

3. **MessageList 结构改造**（`src/components/MessageList.tsx`）
   - 工具卡片 `<details>` → 状态化工具行：状态点（running/ok/err）+ 图标 + 名称 + 参数摘要 + 耗时（有数据才显示）+ chevron，展开显示参数与结果；
   - 思考块 → 单行折叠 `Thought … ▸`；
   - 用户消息气泡 + hover 时间戳（`message.timestamp`）；助手顶部 `PI + 模型` 小字标签；
   - 流式光标改软闪烁块；`prefers-reduced-motion` 关闭动画；
   - 状态数据约束：Pi RPC 不提供耗时/状态则不渲染，参数摘要 JSON.parse 失败回退截断原文。

4. **会话输出 + Composer CSS 重写**（`src/App.css` 对应区块）
   - 会话列 max-width ≈720px 居中；助手文档流、用户右侧气泡；
   - 工具行 / 思考块 / 代码块头部 / Markdown 排版（标题、列表、引用、表格斑马纹、行内 code、链接）按 mockup 与 token 落地；
   - Composer 胶囊、工具栏按钮、菜单接入新 token 与 1.5px 图标。

5. **验证**
   - `npm run build`（tsc + vite）通过；
   - 亮/暗 × 2 套 accent、三档密度、中英双语人工走查（`npm run tauri dev`）。

## 边界

- 不改 IPC / 状态逻辑 / Rust 后端；侧边栏、设置页、浮层属阶段 2，本阶段只保证不破。
