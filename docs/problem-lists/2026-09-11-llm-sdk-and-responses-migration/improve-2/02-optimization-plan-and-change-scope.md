# 2. 优化方案与改动面

## 2.1 方案总览

新增独立 `openai-responses.ts`，与现有两个 adapter 实现同一 `InterfaceProviderInstance`。配置 kind 增加 `"openai-responses"`；仅显式该值时走新文件。adapter 把当前项目实际产生的 Chat 形状请求译成无状态 Responses 调用（`store: false`），按精确分类表处理 SDK `7.13.0` 的全部已知事件，只把能无损映射的能力写入统一流事件。cache 本轮 observe-only。lifecycle / llm-client / context / SQLite 不改行为，因此原生 reasoning/output-item 续接、assistant `phase`、refusal、annotation 与非 function tool 本轮必须 fail-closed。

```text
interfaceProvider
  "anthropic"          → anthropic.ts
  "openai-responses"   → openai-responses.ts   ← 仅显式
  缺省 / 其他合法 Chat  → openai-compatible.ts
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
| --- | --- | --- | --- | --- |
| 文件结构 | 独立 `openai-responses.ts` | 协议事件模型不同 | Chat 文件内 if-else | 部分转换逻辑以后 canonical 时可能改入口 |
| 共享接口 | 沿用现有，不重命名 | 避免全仓库机械 diff | `streamModelResponse()` | 名称仍带 Chat 味道 |
| 内部消息 | 继续 Chat 形状，adapter 翻译 | 先接通协议 | 本轮 canonical | 转换是过渡层 |
| 配置 | 扩展 `interfaceProvider` | 即未来 type | 第二套 protocol 字段 | 无 |
| 默认 | 仍 Chat，无 UI | 不误切中转站 | 官方 URL 自动 Responses | 用户本轮用不了新产品入口 |
| 认识 vs 能力 | wire-complete + capability-limited + fail-closed | 防字段补丁化，又不污染共享层 | 共享接口塞满 Responses 字段 | adapter 内部分类表要维护；推理模型本轮不可用 |
| 状态 | 每轮本地完整 replay | 与 compaction 不冲突 | `previous_response_id` | 请求体较大 |
| cache | responses → observe-only | 不绑 Chat cache 成果；防掉进 Anthropic | 复用 keyed-implicit | 官方 Responses 本轮无主动 cache 控制 |
| tool id | adapter 合成 index | 不改累积器 | 本轮改 llm-client 为 call_id | 后续还要再改一次累积器 |
| temperature | 原样发送 | 不建模型表 | 按模型省略 | 部分 reasoning 模型可能 400 |
| 原生 continuation | 本轮不承载；出现即失败 | Chat-shaped 历史无法无损回放 reasoning item / phase | 临时隐藏状态或把 opaque JSON 塞进 Chat 字段 | 支持面明确限于无需这些 item 的模型路径 |

## 2.3 分阶段实施

全部 Stage 属于 improve-2，不新开轮。

### Task 1 / Stage 1：kind、工厂、cache 守卫

- 目标：配置与工厂认识 `"openai-responses"`；缺省仍 Chat；cache 策略对该 kind 恒为 observe-only。
- 改动：`config/llm/types.ts`、`validation.ts`、**`apply-active-model-config.ts`**（第二份 kind 白名单）及对应单测；`services/interface-providers/types.ts`、`index.ts`；`core/llm-client/prompt-cache.ts` 与 `prompt-cache.unit.test.ts`；拆分 SDK 的 connect/probe 两值选择联合与 current-model 三值只读回显联合，并同步 UI runtime 类型。
- UI 边界：connect 输入、probe 输入与 `inferConnectModelInterfaceProvider(baseUrl)` 仍只能产生 `openai-compatible | anthropic`；只有读取当前已手工配置模型时允许回显 `openai-responses`。不得用 type cast 掩盖联合不一致，也不得新增选择控件。
- 工厂：必须显式分支 `"openai-responses"`，**禁止** fallthrough 到 `createOpenAICompatibleProvider`。Stage 1 的中间状态只存在于本地开发分支，不作为可发布或可合并节点；最终实现不得保留生产 stub。
- DoD：未知 kind 仍由 validation/apply **拒绝**（不静默当 Chat）；未写 kind 行为与今天一致；显式 responses 的策略为 observe-only，且 **零次** `chat.completions.create`。

### Task 2 / Stage 2：Responses adapter（协议层）

- 目标：实现 `openai-responses.ts`：请求翻译、SDK `responses` 流、事件分类、usage 归一化、abort。
- 改动：新建 adapter 与测试；`token-usage.ts` 增加按 kind 的 Responses 分支（诊断 `protocol: "openai-responses"`），并同步 `observability/events.ts` protocol enum 与 `observability/logger.ts` 安全枚举；factory 接到真实现。
- 请求翻译（冻结）：
  - **全部字符串** `role: system`（含 `tailDirectives` 拼进 messages 的）按原顺序用 `"\n\n"` 合并进顶层 `instructions`，不进 `input`
  - 字符串 user 文本 → `{ role: "user", content }` input message
  - 字符串 assistant 文本 → `{ role: "assistant", content }` input message；若同条消息还有 `tool_calls`，文本消息先于对应 function calls
  - assistant function `tool_calls` → `function_call`（`call_id`、`name`、`arguments`）；旧 `function_call` 字段不支持
  - 字符串 `role: tool` → `function_call_output`，`call_id = tool_call_id`
  - tools：Chat 嵌套 `{ type:"function", function:{ name, description?, parameters } }` → 扁平 Responses `FunctionTool`，固定 `strict: false`；非 function → Rejected
  - `developer`、legacy `function` role、数组/多模态 content、assistant `audio` / `refusal` / legacy `function_call`、带 `name` 的消息均 Rejected；不得只取文本子块或静默丢字段
  - 每个 message、tool 与嵌套 function/tool_call 先执行 allowed-key 校验；当前 serializer 可能产生的 `reasoning_content` 以及任何未登记 own-key 一律 Rejected，不能因 TypeScript 类型断言而被静默丢弃
  - 显式 `store: false`；省略 `previous_response_id`；无任何 `prompt_cache_*` 字段
  - `temperature` / `max_output_tokens` 从现有 request 投影（`maxTokens` → `max_output_tokens`）
- 工具 index（冻结）：在 `output_item.added`（function_call）时分配单调本地 index `0..n`，绑定 `call_id`；`function_call_arguments.delta` 经 `item_id` 回查该绑定；并行/非连续 `output_index` 不得直接当 Chat index。只有 `response.completed` 且所有普通 function call 均为 `completed` 时才发 `finishReason: "tool_calls"`；任意 `response.incomplete` 只要包含 function call 就整体 Rejected，不能执行可能被截断的参数。
- usage（冻结）：新建 Responses parser，**禁止**复用 Anthropic accumulator。`input_tokens` 为含 cache 的总量；从 `input_tokens_details.cached_tokens` / `cache_write_tokens` 取细分。两个明细都未观测到时省略 breakdown；只要至少一个存在，另一个按 0 参与 `uncached = input_tokens - cached_tokens - cache_write_tokens`，并分别保留 `observed` 标记。若细分为负数、非整数或两者之和超过 `input_tokens`，保留可信 input/output/total、省略 breakdown，并报告 `input-breakdown-conflict`。`total_tokens` 与本地求和不一致时沿用诊断但标记 `protocol: "openai-responses"`，归一化 total 仍取 input + output。
- 事件分类（冻结）：以 SDK `7.13.0` 的 `ResponseStreamEvent["type"]` 为闭集，代码用精确 key 表或 exhaustive switch 保证编译期穷尽，并对运行时未知字符串抛错。

| 类别 | 内容 | 行为 |
| --- | --- | --- |
| Mapped | `response.output_text.delta`；普通同步 function_call 的 added + arguments delta；`response.completed`；不含 function call 的 `response.incomplete`（仅 `max_output_tokens` / `content_filter`）；abort exception | 写入现有 `InterfaceProviderStreamEvent`；tool 用合成 index，`id = call_id`；终态带 usage |
| Validated then discarded | response id 与状态、usage 中现有 breakdown 无法表达的明细；function_call arguments done、output_text done、output_item done 等重复终值 | id 必须非空且在同一流内稳定；done 终值必须与累积值一致；事件与 response 状态必须相符。验证后丢弃，不宣称已有生产观测出口 |
| Rejected | 任意 reasoning item/event、非空 assistant `phase`、refusal、annotation、非空 logprobs、hosted/custom/MCP/shell 等非 function tool、异步/namespace/programmatic function call、`error`、`response.failed`、含 function call 的 incomplete、缺失/未知 reason 或 `max_messages` / `steered` incomplete、未知 output item/event、响应暗示 `previous_response_id` / `store:true` | 抛出带 event/item type 与原因的明确错误；不得发成功终态或执行工具 |
| Ignored by design | `response.created` / `in_progress` / `queued` 等纯生命周期；经内容类型校验后的 content-part 结构事件 | 在精确表中逐项登记后可丢；未入表一律失败 |

SDK `7.13.0` 精确事件登记如下。四类描述的是处理结果；`output_item` / `content_part` 这类载荷联合事件必须先进入专用 handler，再由内部 item/content type 决定 Mapped、Validated 或 Rejected，不能仅凭外层 event type 放行。

- **Mapped / terminal**：`response.output_text.delta`、`response.function_call_arguments.delta`、`response.completed`、`response.incomplete`。
- **Payload-gated**：`response.output_item.added` 对普通 `function_call` 分配并发出本地绑定，对 message 只校验，对其他 item 拒绝；`response.output_item.done` 只核对终值且不得重复发 delta；`response.content_part.added` / `response.content_part.done` 只接受无 annotation 的 `output_text`，否则拒绝。
- **Validated then discarded**：`response.output_text.done`、`response.function_call_arguments.done`。
- **Ignored by design**：`response.created`、`response.in_progress`、`response.queued`。
- **Rejected · reasoning/refusal/annotation**：`response.reasoning_summary_part.added`、`response.reasoning_summary_part.done`、`response.reasoning_summary_text.delta`、`response.reasoning_summary_text.done`、`response.reasoning_text.delta`、`response.reasoning_text.done`、`response.refusal.delta`、`response.refusal.done`、`response.output_text.annotation.added`。
- **Rejected · provider failure**：`error`、`response.failed`。
- **Rejected · audio/code/search/image/custom**：`response.audio.delta`、`response.audio.done`、`response.audio.transcript.delta`、`response.audio.transcript.done`、`response.code_interpreter_call_code.delta`、`response.code_interpreter_call_code.done`、`response.code_interpreter_call.in_progress`、`response.code_interpreter_call.interpreting`、`response.code_interpreter_call.completed`、`response.file_search_call.in_progress`、`response.file_search_call.searching`、`response.file_search_call.completed`、`response.web_search_call.in_progress`、`response.web_search_call.searching`、`response.web_search_call.completed`、`response.image_generation_call.in_progress`、`response.image_generation_call.generating`、`response.image_generation_call.partial_image`、`response.image_generation_call.completed`、`response.custom_tool_call_input.delta`、`response.custom_tool_call_input.done`。
- **Rejected · MCP/shell**：`response.mcp_call_arguments.delta`、`response.mcp_call_arguments.done`、`response.mcp_call.in_progress`、`response.mcp_call.completed`、`response.mcp_call.failed`、`response.mcp_list_tools.in_progress`、`response.mcp_list_tools.completed`、`response.mcp_list_tools.failed`、`response.shell_call_command.added`、`response.shell_call_command.delta`、`response.shell_call_command.done`、`response.shell_call_output_content.delta`、`response.shell_call_output_content.done`。

`response.output_item.added/done` 还要对 `ResponseOutputItem["type"]` 做第二层穷尽并维护状态机：

- message：整条响应最多一个 message item；`output_item.added` 只接受 `status: in_progress` 且 `content: []`，不得预填 content。唯一的 `output_text` 必须由唯一一次 `content_part.added` 建立；随后 `content_part.done`、`output_item.done` 与 terminal 都必须包含同一个已支持 part，并按 content index 与全文保持有序相等。missing/duplicate part、窗口外 delta 或终态不一致一律拒绝。done 可记录 `completed` 或 `incomplete`，最终必须与 completed/incomplete 终态一致。`phase` 只允许 `null` / `undefined`，该唯一 content 必须无 annotation、无非空 logprobs。若与 function call 共存，message 的 `output_index` 必须位于所有 function call 之前；反序或交错一律拒绝，因为共享 Chat assistant message 无法无损保留该拓扑。
- function_call：`call_id` 与 `name` 必须为非空字符串；added 只接受 `in_progress`，done 与 completed 终态只接受 `completed`；`async` 只允许 false/undefined、`namespace` 必须缺省、`caller` 只允许 direct/null/undefined，program caller 拒绝。
- incomplete 终态不得含任何 function_call；`incomplete_details.reason` 缺失或为运行时未知值也拒绝。只有 message-only 的 `max_output_tokens` / `content_filter` 可分别映射为 length / content_filter。
- 每个 `output_index` / item id 必须唯一且恰好一次 `added → done`；item/content delta 与 done 只能发生在对应 added 之后、done 之前，`call_id` 绑定不可复用或改写。整条流恰好一个 terminal，terminal 必须是最后一个事件；重复 terminal 或 terminal 后事件一律拒绝。
- `reasoning` 与其余 item 全部 Rejected。item 事件只负责校验结构、分配/核对 function-call 绑定，不得把 done 的完整文本或 arguments 再发一次造成重复累积。

`response.completed.response.output[]` 与可映射的 `response.incomplete.response.output[]` 必须再次执行同一校验，并与流中已见结构做有序全集相等比较：按 `output_index` 比较唯一的 `(item_id, item.type)` 序列；message 再按 `content_index` 比较有序 content type 与全文；function call 比较 `call_id`、`name`、`arguments`。终态多出、缺少、重排、重复或内容不一致都 fail-closed；本轮不使用终态补发缺失 delta，防止 llm-client 把漏流静默收敛成空响应。

- DoD：分类穷尽当前 SDK 联合；未知成员编译或测试能抓住；无 reasoning/output-item 续接要求的 Mapped 路径可跑通工具多轮；reasoning/phase/refusal/annotation 与 hosted/custom tool 均在执行工具前失败。

### Task 3 / Stage 3：契约测试与权威文档

- 目标：Chat/Anthropic wire 语义不变；Responses 有镜像单测与分类覆盖；llm-client 文档同步第三 kind 与本轮限制。
- 改动：`prompt-cache-wire.contract.test.ts` 增加「responses 不发 cache 字段」；新 `openai-responses.test.ts`；必要时 `docs/core/llm-client/architecture.md` 等被本轮触达的陈述。
- DoD：见 04；`pnpm preflight` 通过。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
| --- | --- | --- | --- | --- |
| `packages/ohbaby-agent/src/config/llm/` | 无 | types、validation、**apply-active-model-config**、相关单测 | 无 | 两处 kind 白名单必须一起改 |
| `packages/ohbaby-sdk/src/`、UI runtime | current-model kind 类型（可原位新增） | `connect-model.ts`、`adapters/ui-inprocess.ts` 及相关测试 | 无 | 只扩只读回显；connect/probe/URL 推断保持两值 |
| `packages/ohbaby-agent/src/services/interface-providers/` | `openai-responses.ts`、测试 | `index.ts`、`types.ts`、`token-usage.ts`、cache 契约测试 | 无 | 核心 |
| `packages/ohbaby-agent/src/observability/` | 无 | `events.ts`、`logger.ts` 及诊断测试 | 无 | usage protocol 闭集同步第三值 |
| `packages/ohbaby-agent/src/core/llm-client/` | 无 | `prompt-cache.ts` 及单测 | 无 | 仅 observe-only 分支 |
| `core/lifecycle`、`core/context` | 无 | 无行为改动 | 无 | 不为 Responses continuation 增加隐藏状态或 opaque 字段 |
| `docs/core/llm-client/` | 无 | 被触达的 kind/协议陈述 | 无 | 不得声称默认 Responses 或已 canonical |
| `docs/problem-lists/.../improve-2/` | 本套规划 | 根 README 轮次地图 | 无 | |

## 2.5 API / 协议 / 迁移与兼容

- 可写产品入口：无新 CLI/UI 开关。`model.json` 的 `interfaceProvider` 若手工写成 `"openai-responses"` 则走新路径；**缺省**兼容 Chat；**非法 kind 拒绝**，不 fallthrough。SDK 的 current-model 只读返回联合会新增可回显枚举值，但 connect/probe 输入能力不扩展。
- 出站 Chat / Anthropic wire：语义 JSON 契约保持。
- 出站 Responses：无状态完整 replay；cache 控制字段缺省不出现。
- 支持边界：只承诺无需原生 reasoning/output-item 续接的模型路径；不支持事件必须 fail-closed。
- context 统计边界：本轮仍以转换前的 Chat-shaped `PreparedModelRequest` 做 heuristic/occupancy 估算，只保证默认 Chat 不回归与 Responses 路径不崩溃；它不是 Responses 实际 wire token/composition 的精确口径，后续协议投影轮再对齐。
- 持久化：无 migration。
- 以后把默认改成 Responses 时，只翻转 `resolveInterfaceProviderKind` 的缺省值，并补 UI——不在本轮做。

## 2.6 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| `enabled` + 新 kind 误发 Anthropic cache_control | Stage 1 守卫测试 |
| 静默丢弃 hosted tool / 未知 item | Rejected + 穷尽分类测试 |
| reasoning/phase 被压扁后继续工具循环 | 任意 reasoning item 或非空 phase 立即失败；下一轮再设计 continuation |
| refusal/annotation 被当普通文本 | 明确 Rejected；终态 output 再校验 |
| reasoning 模型拒绝 temperature | 记风险；不扩模型表；smoke 失败则停并回规划 |
| usage 与 Anthropic 嗅探撞车 | 按 kind 调 parser，禁止共用「见到 input_tokens 即 Anthropic」 |
| 转换丢失 tool_call_id | 单测固定 call_id 往返 |
| 范围膨胀进 cache/canonical | 02.8 硬边界；实施中出现必须改 lifecycle 行为则停止回审 |

回滚：删除新文件与 factory 分支，恢复 kind 白名单与 prompt-cache 分支；无 DB 回滚。

## 2.7 与 00 边界对齐检查

- 独立文件、共享旧接口、不重命名：是
- 显式 kind、**缺省 Chat、非法 kind 拒绝**、无 URL 分流、无 UI：是
- 工厂禁止 fallthrough Chat：是
- wire-complete / capability-limited / 四类事件 / SDK 精确登记：是
- cache 非对齐、observe-only、不发 key；usage 可观测进 breakdown：是
- 全部 system 合并 instructions；tools 扁平投影：是
- adapter 合成 index、temperature 原样：是
- reasoning/phase/refusal/annotation 不降级、不续跑：是
- 无 2.9 关键改动清单：是

## 2.8 不在本轮

登记为下一轮**候选**（真正立轮须在本轮 05 闭环之后，并再规划）：

- 内部请求 canonical 化与命名规范（含 `streamChatCompletion` → 中性名、原生 call_id 累积）
- Chat 与 Responses 的 cache 完全对齐（keyed-implicit、显式 breakpoint 等）
- 产品默认改为 Responses、Chat 另开入口
- `previous_response_id` / 服务端状态 / hosted tools
- reasoning item、assistant phase 与其他 output item 的 provider-continuation / canonical 表达
- lifecycle 双循环、context 压缩算法、SQLite schema
