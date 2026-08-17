# 自定义 Provider 管理模块设计

日期：2026-08-17
状态：已获用户批准（标准版 B）

## 背景与目标

pi-gui 的设置面板已有「providers」页：列出 pi 内置 catalog 的 provider、`~/.pi/agent/models.json` 里的自定义 provider、`auth.json` 里持有凭证的 provider，并支持为它们配置/清除 API Key（存 `~/.pi/agent/auth.json`）。

缺失能力：用户无法在 GUI 里**手动添加**自定义 provider（如 Volcengine 方舟）。目标是让用户通过表单完成 pi 官方 `models.json` 的编写，保存后 TUI `/model` 与 GUI 同时生效。

## 存储方案（已选定）

直接读写 `~/.pi/agent/models.json`（pi 官方自定义 provider 机制）：

- `pi_providers()` 已合并 models.json 条目，保存后新 provider 自动出现在现有列表；
- pi 每次打开 `/model` 热重载 models.json，无需重启；
- 备选方案（生成 registerProvider 扩展 / GUI 私有配置注入）因复杂度高或 pi 不支持而否决。

合并语义：读出现有文件 → 只改目标 provider 条目 → 写回。绝不触碰文件中的其他条目（含用户手写的 `modelOverrides`、内置 provider 覆盖等）。文件 JSON 非法时返回错误，禁止覆盖。

## 后端（src-tauri/src/extras.rs）

新增 3 个 Tauri 命令（在 pi.rs 的 invoke_handler 注册）：

### `pi_custom_providers() -> Vec<CustomProviderEntry>`

读取 models.json 的 `providers` map，返回条目数组：

```rust
struct CustomProviderEntry {
    id: String,
    /// 该 provider 的原始 JSON 配置（baseUrl/api/apiKey/models/compat/... 全量），
    /// 供编辑表单回显与未知字段透传。
    config: serde_json::Value,
}
```

文件不存在时返回空数组。

### `pi_upsert_custom_provider(id, config)`

- 校验：
  - `id` 只允许小写字母、数字、`-`、`_`，非空；
  - 拒绝与内置 catalog 同名的 id（用现有 `read_catalog_provider_ids`），避免意外接管内置 provider；
  - `config` 必须是对象，含非空 `baseUrl`（字符串）、非空 `models`（数组，每个元素含非空 `id` 字符串）；
  - 新建时若 id 已存在按更新处理（upsert）。
- 合并：读取 models.json（不存在则视为空对象）→ 确保顶层 `providers` 为对象 → 写入 `providers[id] = config` → 以 pretty JSON 写回（保留文件其余内容）。
- models.json 已存在但 JSON 非法 → 返回错误，不写入。

### `pi_remove_custom_provider(id)`

从 models.json 的 `providers` 中删除该条目并写回；不动 `auth.json`（凭证清理由前端按需调用现有 `pi_auth_remove`）。

### 单元测试

沿用 extras.rs 现有测试模式（临时 HOME 隔离）：upsert 新建/更新/保留其他条目、非法 id、内置 id 冲突、非法 JSON 报错、remove。

## 前端

### 新组件 `src/components/CustomProviderDialog.tsx`

模态对话框（沿用 LlamaDialog 的 open/onClose 模式与现有 CSS 类）：

字段：

| 字段 | 说明 |
|---|---|
| 模板下拉 | 空白 / Volcengine 方舟 / Ollama / DeepSeek / OpenRouter；选中预填 baseUrl、api、示例模型，可再改 |
| Provider ID | 新建可编辑；编辑已有 provider 时只读（id 即 key） |
| Base URL | 必填 |
| API 类型 | `openai-completions`（默认）/ `openai-responses` / `anthropic-messages` / `google-generative-ai` |
| API Key | 可选；保存时写入 auth.json（`authSetKey`），与现有 Key 管理一致；留空表示稍后在列表里配 |
| 模型表格 | 每行：模型 ID（必填）、显示名（可空）、推理能力 checkbox、图像输入 checkbox、上下文窗口 number（默认 128000）、最大输出 number（默认 16384）、删除行按钮；底部「添加模型」按钮 |

生成 models.json 条目：

```jsonc
{
  "baseUrl": "...",
  "api": "openai-completions",
  "models": [
    {
      "id": "...",                    // 必填
      // name 仅当填写时输出
      "reasoning": true,              // 仅勾选时输出 true（pi 默认 false）
      "input": ["text", "image"],     // 勾选图像时；否则 ["text"]
      "contextWindow": 128000,
      "maxTokens": 16384
    }
  ]
}
```

未知字段透传：编辑已有 provider 时，以原 config 为底，仅覆盖表单认识的字段（baseUrl/api/models），`compat`、`headers`、`samplingParams`、`thinkingLevelMap`、`apiKey` 等原样保留。新建时模板可附带 `compat`（如 Ollama 的 `supportsDeveloperRole: false`、`supportsReasoningEffort: false`），同样进入 config。

校验（前端即时提示）：id 格式（`^[a-z0-9][a-z0-9_-]*$`）、baseUrl 非空、至少一行模型且每行 id 非空、contextWindow/maxTokens 为正整数。

### 预设模板

| 模板 | baseUrl | api | 备注 |
|---|---|---|---|
| Volcengine 方舟 | `https://ark.cn-beijing.volces.com/api/v3` | openai-completions | 示例模型 `doubao-seed-1-6-250615`（256K，图像 ✓） |
| Ollama | `http://localhost:11434/v1` | openai-completions | compat: supportsDeveloperRole/supportsReasoningEffort = false |
| DeepSeek | `https://api.deepseek.com/v1` | openai-completions | 示例 `deepseek-chat`、`deepseek-reasoner`（reasoning ✓） |
| OpenRouter | `https://openrouter.ai/api/v1` | openai-completions | 空白模型行 |

模板 id 预填（如 `volcengine`），冲突时由用户修改。

### SettingsPanel.tsx 改造（providers 页）

- 页顶部新增「自定义 Provider」区：
  - 「添加 Provider」按钮 → 打开对话框（新建模式）；
  - 自定义 provider 列表：每行显示 id（或模板名）+ 模型数，右侧「编辑」「删除」按钮；删除需二次确认（window.confirm 沿用现有模式，如有），删除后可选提示「API Key 仍保留在 auth.json」；
- 下方保留现有内置 provider 列表（不变）；
- 保存/删除后调用现有 `refreshAuth` + 重新拉取 `piProviders()` 与 `pi_custom_providers()`。

### pi.ts

新增 `piCustomProviders()`、`piUpsertCustomProvider(id, config)`、`piRemoveCustomProvider(id)` 三个 invoke 封装。

### i18n

`MessageCatalog` 的 `settings` 组新增 zh/en 文案：区块标题、按钮、表单标签、模板名、校验/成功/失败提示、删除确认。

## 数据流（保存）

表单校验 → `pi_upsert_custom_provider` → 若填了 Key：`authSetKey(id, key)` → 刷新 provider 列表与 auth 状态 → 关闭对话框并 toast 成功。新 provider 出现在 provider 列表（可再配/换 Key），其模型在聊天模型选择中立即可选。

## 错误处理

- models.json 非法 JSON：Rust 返回错误，前端 toast 展示，不弹对话框数据丢失；
- 与内置 provider 同名：前端预检（有 providerIds 列表）+ Rust 强校验双重拦截；
- authSetKey 失败：provider 已保存，提示 Key 保存失败可稍后手动配。

## 测试

- Rust：extras.rs 单元测试（合并/校验/删除/非法 JSON）；
- 前端：vitest 覆盖表单校验与 models.json 条目生成（纯函数抽出到组件外，如 `custom-provider.ts`）；
- 手动：添加 Volcengine 模板 → 保存 → 列表出现 → 配 Key → `/model` 可见。

## 范围之外（YAGNI）

- cost 计费、compat/headers/samplingParams 的表单编辑（C 版内容；通过未知字段透传不丢失）；
- OAuth provider 注册；
- 模型可用性探测（ping baseUrl）。
