# 消息区 beUI 重设计(方向 C)设计文档

- 日期:2026-09-18
- 状态:已批准(用户于会话中确认)
- 视觉定稿:[`.superpowers/brainstorm/message-area/directions.html`](../../../.superpowers/brainstorm/message-area/directions.html)(三方向对比,用户选定 C)与 [`c-mockup-expanded.html`](../../../.superpowers/brainstorm/message-area/c-mockup-expanded.html)(C 完整静态稿)
- 前序:本项目已陆续将 sidebar、composer、settings、dialogs/toasts 迁至 beUI 原语;本次为该迁移路线在消息区的收尾

## 1. 背景与目标

消息区现为手写实现(`MessageList.tsx` 935 行 + `MetaGroup` / `ToolCard` + App.css 样式段),`src/components/agents/` 下已 vendor 整套 beUI agents 组件但尚未接入。

**目标**:在不改变对话数据流(`chat-rows.ts` 行推导)的前提下,把消息区渲染层重建到 beUI agents 组件上 —— Percho 折叠哲学保留,展开态用 beUI 活动行语言重绘(方向 C)。

**非目标**:

- 不改 `chat-rows.ts` 的行推导逻辑与 `ChatMessage` 数据结构
- 不动 Composer、DiffSidebar、TodoPanel、搜索面板的内部实现(仅对接点样式对齐)
- 不引入新的运行时依赖(motion、lucide-react、Tailwind v4 均已就位)

## 2. 用户已拍板的决定

| 决策点 | 结论 |
|---|---|
| 视觉方向 | C:折叠哲学保留 + beUI 组件语言(折叠行升级为活动卡、回合 footer 改居中 pill) |
| emoji | 一律不出现;图标全部用 lucide-react 线性图标 |
| 动效来源 | 全部使用 beUI 组件自带动效(`@/lib/ease` 弹簧/缓动体系),不手写 CSS 动画 |
| 滚动容器 | 换用 vendored `MessageScroller` |
| 助手 footer 操作(复制/分叉) | 常驻低透明(约 50%),hover 变亮(beUI `StreamingResponse` 默认风格) |
| 消息导航轨(`navigation="rail"`) | **开启,放左侧**(`railSide="left"`:轨道贴聊天列左缘,预览卡向右弹出;与右侧 DiffSidebar 完全错开) |

## 3. 部件映射

| 现有 | 改为 | 说明 |
|---|---|---|
| `.chat-scroll` + `MessageList` 内手写吸附跟随(stickRef + wheel/touch/pointer/keydown,约 150 行) | `MessageScroller`(`src/components/agents/message-scroller.tsx`) | `followOutput`、`followThreshold={120}`(保持现有 120px 手感)、`smooth`、`busy={working}`;`onFollowChange` 备用;会话切换以 `key={sessionId}` 重挂载复位到最新消息;`navigation="rail"` + `railSide="left"` 开启左侧导航轨 —— 开启后视口滚动条按 beUI 行为隐藏,轨道 tick 即位置指示(悬停出预览卡、点击跳转对应消息) |
| 搜索定位命中消息 | 自定义逻辑经 `viewportRef` 滚动 | 保留居中定位算法;程序滚动后 `MessageScroller` 的 scroll handler 自然置 `following=false`,等价现有行为 |
| 用户消息行 | `Message from="user"` + `MessageBubble variant="soft"` | 入场 `animateIn`;图片网格(`MessageImages`)保留在气泡内容区内;撤回按钮保留在气泡旁 hover |
| 助手文本行 | `Message from="assistant"` + `StreamingResponse` | 三态 `streaming / complete / error`;markdown 仍走现有 `Markdown` 流式渲染与打字光标;footer 操作 = copy + fork(用 `ResponseAction` 样式扩展 fork 按钮,常驻低透明 hover 变亮) |
| `MetaGroup`(思考/工具折叠组) | `AgentActivity` 卡 | 折叠头 = 摘要文案 + 「N 步」徽章 + `ChevronDown`(`SPRING_SWAP` 旋转);live 态头部换 `ThinkingShimmer`;展开体 = `AgentDisclosure` + `ActivityRow` 列表 |
| 折叠组内条目 | `ActivityRow` 变体 | 思考 = trace 行(sparkles 图标 + mono 摘要条 + 耗时);read/bash/edit = tool 行(check 状态图标 + 粗体工具名 + mono 目标条 + 耗时);bash 输出以两行淡出 mono 预览嵌于行下,点击行展开完整输出(数据已随 tool result 缓存) |
| `ToolCard`(流式中的运行工具) | 单行 live 活动卡 | 呼吸圆点(StepRow active 态)+ 工具名 + mono 参数预览 + 「运行中」徽章;完成后归入折叠组 |
| `GapLiveChip` / `TurnStatus` | live 活动卡 | 呼吸圆点 + Thinking/Working 标签 + 预览条;与现有 hysteresis(`useShownWorking`)逻辑保留 |
| `AutoRetryChip` | live 活动卡变体 | 加 `attempt/max` 徽章与倒计时 meta;错误预览文案保留 |
| `TurnDiffRow`(左对齐 footer 行) | 居中 pill | `MessageMarker` 风格:⏱ 时长 · N 个文件 +x −y + chevron;点击 `AgentDisclosure` 原地展开文件列表;文件行点击打开 DiffSidebar(现有 `onOpenDiff` 回调);live 轮次 pill 上的计时跳动保留 |
| `MessageActions`(hover 小图标行) | `StreamingResponse` footer 操作 | copy + fork 常驻低透明;错误消息的 retry/compact 走 `ErrorNote`(保留) |
| `ThinkingOrb`(thinking-orbs 包) | 退役 | 以 beUI 呼吸点 / `MessageTyping` 三点 / `ThinkingShimmer` 替代;`thinking-orbs` 依赖移除 |
| `SubagentLivePanel` | `AgentActivity` 多 run 卡 | StepRow 样式逐 step 状态;数据管道(`pi.ts` 轮询)不变 |
| 搜索高亮、`ErrorNote`、图片网格、i18n 文案 | 逻辑原样保留 | 样式对齐新 token;搜索命中高亮(`session-search-hit`)保留 |

## 4. 动效清单(全部来自 beUI,不手写)

- 消息入场:`MESSAGE_POP_UP` 弹簧(`message.tsx` animateIn)
- 气泡表面:`BUBBLE_POP` + `BUBBLE_CONTENT_REVEAL`(`message-bubble.tsx`)
- 折叠展开:`AgentDisclosure` clip-path + opacity + y(0.22s/0.14s `EASE_OUT`)
- chevron 旋转:`SPRING_SWAP`
- 活动行增删:`AnimatePresence` popLayout + `SPRING_LAYOUT`
- live 指示:StepRow 呼吸圆点 / `MessageTyping` 三点 / `ThinkingShimmer`
- 滚动跟随:`MessageScroller` smooth follow(`useReducedMotion` 时降级 auto)
- 全局:`useReducedMotion()` 尊重系统「减少动态效果」;仅动画 transform/opacity/clip-path

现有 App.css 中消息区的 keyframes/过渡(orb、sweep-highlight、turn pop 等)随退役组件一并删除;`use-sweep-highlight.ts` 仅被 `MetaGroup` 使用,随其一并移除(其测试同删)。

## 5. 实现策略

- `chat-rows.ts`(行推导纯函数,`src/__tests__/chat-rows.test.ts` 已覆盖)原样保留 —— 渲染层重建不触碰数据层
- vendored `message-scroller.tsx` 最小扩展:新增 `railSide?: "left" | "right"`(默认 `"right"` 保持上游行为),按侧切换轨道定位类(`left-1`/`right-1`)、tick 对齐(`justify-start`/`origin-left` 与 `justify-end`/`origin-right`)、预览卡弹出方向(`previewSide` 与容器类)及溢出留白(`pl-10`/`pr-10`);除此之外不改上游跟随/吸附逻辑
- `MessageList.tsx` 重写为 vendored beUI 组件组合;`MetaGroup.tsx`、`ToolCard.tsx`、`use-sweep-highlight.ts` 退役;`message-utils.ts`、`Markdown.tsx`、`ErrorNote.tsx` 按需沿用;live 活动卡的 mono 预览条复用 `PreviewTicker`(及其依赖 `activity-ticker`,到达序最新活动滚动预览的职责与 beUI 组件不重叠,测试保持不动)
- `ChatArea.tsx`:滚动容器外壳换 `MessageScroller`(viewport 样式保留现有 9px 自定义滚动条与 welcome 态);`MessageList` props 接口保持不变,使 `ChatArea`/`dev-preview.tsx` 改动最小
- 样式:App.css 消息区段落替换为少量新类;组件皮肤优先用 beUI token bridge(`beui.css` 的 `@theme inline` 已映射 `--panel-bg`/`--accent` 等到 Tailwind 语义色);主题(dark/light)、`data-density`、`data-color-scale` 经 token 自动跟随
- i18n:新增文案(「N 步」「运行中」等)进 `src/i18n.ts` 中英两份

## 6. 测试与验收

- 单测:`chat-rows.test.ts` 不动应保持绿;`message-actions.test.tsx`、`stream-split.test.tsx`、`markdown-fade.test.tsx` 按新 DOM 适配查询选择器;新增活动卡折叠/展开与回合 pill 展开的渲染测试
- 命令:`npm test`、`npm run lint`、`npm run build`
- 视觉验收:`preview.html`(`src/dev-preview.tsx` 静态稿)覆盖折叠/展开/live/回合 pill/图片/错误各态;dark + light 双主题过一遍
- 手工回归:流式跟随、上滚脱离/回底吸附、会话切换复位、搜索定位、撤回/分叉/复制、auto-retry 倒计时、子代理面板、DiffSidebar 打开、导航轨(hover 预览卡、tick 高亮跟随、点击跳转、左侧布局)

## 7. 风险与对策

- **StreamingResponse footer 扩展 fork 按钮**:beUI 源为 copy-paste 所有,允许轻量扩展(新增一个 `ResponseAction`),不 fork 其内部结构
- **导航轨在左侧**:与右侧 DiffSidebar 完全错开,无并存冲突;开启 rail 后视口滚动条隐藏(beUI 行为),轨道 tick 承担位置指示 —— 若手感不适,可在 `viewportClassName` 恢复细滚动条(留作实现期微调点)
- **长会话性能**:活动卡展开态按需渲染(未展开不渲染完整输出),与现有「折叠省 DOM」策略一致;`MessageRow` memo 结构保留
- **`PreviewTicker`/`activity-ticker` 既有测试**:live 活动卡复用 `PreviewTicker`,`preview-ticker.test.tsx` 与 `activity-ticker.test.ts` 均不动

## 8. 实现记录(2026-09-18)

- vendored 扩展落地:`message-scroller.tsx` 增 `railSide`;`streaming-response.tsx` 增 `contentClass`(替换内置 markdown 工具类,消息区传 `text-block` 保住现有排版)、`copyLabel`/`copiedLabel`(本地化 aria)、`showFeedback`(隐藏thumbs)、`actions`(fork 按钮槽);均为可选 props,上游默认行为不变
- `motion/text-shimmer.tsx` 修正 vendor 时误写的自引用 import(指向 `@/lib/text-shimmer`)
- `dev-preview.tsx` 改载 `beui.css`(原先只载 App.css,preview 缺 Tailwind)
- `vitest.config.ts` 补 `@` 别名(渲染 vendored beUI 组件的测试需要)
- 已提交行的流式稳定性由 `MessageRow` 值比较 memo 保证(motion 的 layout 投影每次渲染都会写 style,必须整行跳过重渲染);回调不参与比较,已核实 App 层回调均为 `useCallback` 稳定引用
- 遗留(非本次引入):`usage-stats.test.tsx` 一例断言在 HEAD 上即失败;`npm run lint` 的 24 个 error 均在未触碰的 scripts/tauri-mock 等文件
- 后续优化项:App.css 中退役组件的死样式段(meta-group/tool-card/think-row/turn-diff/turn-status 等)待清理
