# 第 3 批：优化方案与改动面

> 基线 `c5cfda26`；依据 [00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md) 与 [plan/02](../plan/02-optimization-plan-and-change-scope.md)。本文供后续开发会话实施，本次只撰写规划文档。路径除注明外均在 `packages/ohbaby-agent/src/`。

## 1. 交付目标与完成定义

把摘要从「字符串重建 + 先 prune」改成「同一份正常请求材料分叉 + 末尾指令」，输出字段与缓存按三协议正确落，重试收成单一所有者的两次实际请求，触发线降到 90% 并接必要容量提前保护；同批取消前置 prune、清掉失用代码。

**本批完成定义**（[plan/02 §9](../plan/02-optimization-plan-and-change-scope.md)）：

- 三协议摘要材料与最终字段一致；完整摘要输入与触发/容量保护同时接通。
- 摘要前不改写旧历史；失败或提交前 Stop 不留 prune 退场。
- 失用实现与消费方（SDK／CLI／Web）同批清理，无临时开关、无操作兼容壳。
- SDK 不另行重试；摘要断流仍受「总共两次实际请求」约束。
- 用量有归属（挂在摘要请求记录上），失败也写一行日志。

本批结束时是中间态：模式 A/B、原子事务、最终失败终止尚未到位（批 4），**不得单独发布为完整策略**。

## 2. 职责与数据流（模块视角）

**职责边界。** Context 负责选历史、按同一份材料造请求、解析本次摘要输出额度并做容量判断；LLMClient／provider 负责协议字段、发送与真实 usage；MessageStore 负责事务；调度器负责输入与运行状态。本批不改这些边界，只把摘要的**输入来源**从「历史字符串」换成「与正常请求同一份 prepared 材料」，并让 Context 把摘要额度显式传进预算解析。

```text
已投递历史 + 待交付输入 + 同源配置
  → 用现有 prepareTurn 路径造 prepared 正常请求（system/tools/消息顺序/原生状态/thinking/缓存身份）
  → 触发判断（90% 占用）与发送前容量检查
      不需 compact → 发送普通请求
      需要 compact → 在 prepared 材料末尾追加摘要指令
        → 摘要输出额度独立解析（正文 16K／16K＋B／32K）
        → 校验：无工具执行、末尾追加、协议字段与缓存身份
        → 发送摘要（首次＋至多一次网络重试，共两次实际请求）
        → 有效正文 + requestId + 请求记录（用量、终态）
  → （批 4：原子提交新摘要并退场旧 parts）
```

失败／Stop 停在发送前或发送后、批 4 提交前：**本批不应用任何裁剪**，旧历史与已完成工具结果保持不变。

## 3. 请求准备：正常材料分叉 + 末尾指令

- 摘要请求由**同一份将要发出的正常请求材料**构造：保留 system、tools 与原 tool_choice、既有消息顺序、原生状态、模型/端点、已解析 thinking、适用缓存配置和 `inputIds`；只在末尾追加摘要指令（一条 user 消息）。不换短 system、不删 tools、不降 thinking。
- 扩展现有 `PreparedModelRequest`（`core/context/types.ts:95-99`）周边契约，复用 `InterfaceProviderRequest` 已有字段：messages、tools、model/来源、温度、`ResolvedReasoning`、最终 `maxTokens`、`purpose`、session/scope 与适用 cache 配置。**不复制客户端、密钥或整份配置，不持久化完整请求体。** 具体类型组合随实施落定，不新造一套请求框架。
- 把摘要客户端 `ContextLLMClient.generateSummary` 从「history 到 string + prompt/systemPrompt」改为**消费 prepared 请求**，返回有效正文、requestId(s)、`summaryMessageId` 与请求记录（见 §8）（`core/context/types.ts:51-62`、`adapters/ui-runtime/prompt-context.ts:81-147`）。
- 摘要指令只要求把完整对话讲清楚，**不写入保留段边界**（[plan/02 §5.2](../plan/02-optimization-plan-and-change-scope.md)）。取消 `[COMPRESSION_PROMPT, AGGRESSIVE_COMPRESSION_PROMPT]` 两套提示词循环（`context-manager.ts:867`），不换提示词重做。
- tools 保持正常请求语义，由指令要求只输出总结；**摘要路径不接工具执行器，收到工具调用即失败**。不加冷热分流、不做老摘要 fallback。

## 4. 三协议输出字段与缓存

- 沿用现有 Chat Completions、Responses、Anthropic 转换器：Chat 写 `max_tokens`（必要时按模型/端点切 `max_completion_tokens`）、Responses 写 `max_output_tokens`、Anthropic 写对应总输出与 thinking 字段（现状锚点 `openai-compatible.ts:78`、`openai-responses.ts:155`、`anthropic.ts:397`）。不把不同兼容端点全局当官方接口。
- `purpose` 仍为 `context-summary`。共享适用的会话/scope 缓存身份与正常请求策略，保留 system、tools、消息及原生状态顺序。
- 需要显式缓存标记的端点，在**稳定前缀、真实历史边界**设置适用标记；**不把末尾追加的摘要指令误当既有命中边界**。遵循既有顶层/分块策略与数量限制，不统一强加不支持的字段（`core/llm-client/prompt-cache.ts`）。
- 缓存验证比较**最终请求体与真实 usage**，不用「我们传了同一个 key」代替验证。压后首个普通请求自然建立新缓存，无预热、无冷热分流、无服务端 compact 新分支。

## 5. 摘要独立输出预算

正文 ≤ 16K（含确定性追加的文件操作信息；16K 是上限，不是目标长度）。发送额度按已解析 thinking 模式分三行，都是**发送时的输出上限**，复用同一预算解析和真实模型能力检查：

| 已解析 thinking | 摘要申请的输出上限 | 说明 |
| --- | --- | --- |
| 不生成 thinking | 16K 正文额度 | 受真实模型输出能力约束 |
| 已有固定 B | `16K＋B` | 保持 B 不变，不叠加全局 32K 帽 |
| 只有 effort/adaptive | `16K 正文＋试行 thinking 预留`、合计 32K | 不拆成两套；试行值，不套成所有协议硬帽 |

- **不改普通请求**：用 per-request override（`streaming` 的 `options.maxTokens`，`core/llm-client/streaming.ts:273/291`）只覆盖本次摘要调用；改摘要 maxTokens 不触碰普通请求、不影响缓存身份（身份是会话＋作用域指纹，见 `prompt-cache.ts:193-200`）。
- **发送与预留同源**：容量检查把摘要额度作为 `requestedOutputTokens` **显式**传给预算解析，不取 `profile.maxOutputTokens`（普通偏好），避免「普通配置 4K、摘要却要预留 16K」错配（`services/llm-model/modelProfiles.ts:221-263`）。B 必须合法；实际能力不大于 B 时报告不兼容，不默默降 B。
- 宿主已知要追加的文字，在生成前就计入这份 16K 正文额度——**具体接线在批 4 完成**，本批只保证额度解析与发送同源。

## 6. 重试所有权与两次实际请求

- **Context 唯一持有两次实际请求预算**：在 `generateSummaryCandidate` 的现有尝试循环统一计数，`MAX_SUMMARY_PROVIDER_ATTEMPTS` 收敛为 2；删除 `prompt-context.ts` 的外层重试，摘要调用 `streamResponse` 时传 `retry: { maxRetriesPerStep: 0 }`。首次和一次暂时性网络重试共用这份每压缩调用的局部预算。第 4 批模式 A 也消费它，不能让网络和容量恢复各拿两次；本地检查未发送不计请求数。
- **错误分类的最小补充**：摘要客户端保留结构化错误及 cause，Context 区分 Stop、溢出和暂时性网络故障。复用 `ProviderStreamInterruptedError.source/cause` 与既有重试分类，识别 transport 中断；零应用重试产生的 `ProviderRetryExhaustedError` 也保留原始原因。只为摘要路径补必要的小分类函数，不改变普通流收到内容后的重发规则；protocol、provider_abort 等不当成网络中断重试。
- **SDK 隐式重试收进应用层**：三个 provider 建 client 时显式 `maxRetries: 0`（`openai-compatible.ts:443`、`openai-responses.ts:168`、`anthropic.ts:682`）。这是全局的：普通请求同样不再经 SDK 重试、改由应用层既有策略接管，普通请求的应用层重试次数回归本批更新——**普通请求应用层重试策略本身不重新设计**。
- **断流分类**：符合暂时性网络故障分类的流中断，即使已收到部分正文或 thinking，也可用剩余一次机会按相同材料/配置重试；前一次半成品不拼接、不提交，两次消耗分别记录。Stop、length、工具调用或协议错误**不**因此变成可重试。
- **溢出错误标为不可重试**，只进 force compact 入口、不吃普通重试预算（分类隔离，借鉴 kimi `retry.ts`）。摘要请求自身溢出**不在**此列：本批模式 A 未接入，摘要请求放不下直接失败、不缩水输入、不静默退场（模式 A 的副本裁剪在批 4）。
- 路径分开：网络重试与溢出恢复不让同一失败重复拿额度。空正文、length、意外工具调用、协议错误、容量不足，均不走换提示词、短 system 或无工具旧摘要路径。

## 7. 触发与容量检查

- **自动摘要默认 90%**：把 `COMPRESSION_THRESHOLD = 0.95` 改为 `0.90`（`core/context/constants.ts:1`）。触发沿用 `needsSummaryCompaction` 的完整窗口占用 `currentTokens / contextLimit`（`compaction-policy.ts:108-117`），**不含输出预留帽**。
- **50% 帽的归属**：带 50% 预留帽（`maxOutputReservation`／`MAX_OUTPUT_RESERVATION_RATIO`，`modelProfiles.ts:423-429`）的 `usageRatio` **只服务 mask 触发**（`decideCompactionRung` 的 `usage.usageRatio >= thresholds.mask`）；mask 随批 5 删除后该帽也不再用于触发判断。它**不进入容量检查**。
- **必要提前保护**：发送每次普通请求前，用已准备材料和实际输出预算做容量检查，为摘要追加指令及实际输出留出必要空间，确有需要时**早于 90%** 触发 compact；容量检查里的「本次普通请求输出预留」取**全量 `config.maxTokens`**（来自 `/connect`），不套半窗帽子。90% 不保证每次都等到，实际位置由最终预算和材料算出，不再加第二条固定比例或增长预测。落点在 `prepareTurnUnlocked` 量完 `usageBefore` 之后、`runCompaction` 之前（`core/context/context-manager.ts:1581-1615`）：现在的触发只看 90%，提前保护是新增的**必要容量判断**，不改 mask、不新建第二条流水线。
- **摘要容量检查**：把摘要的 `requestedOutputTokens` 显式传给预算解析（见 §5）；模式 B 的保留段收缩是批 4，本批不做。

## 8. 用量归属（本批）与事务（批 4）

- 成功的摘要请求产生一条 `ModelRequestRecord`（`core/llm-client/types.ts:257-271`）式的记录：`purpose: "context-summary"`、attempt、起止时间、outcome，并携带这次请求的 usage/cache 结果。本批把它**挂在摘要结果上返回**（供批 4 随摘要消息的 `modelRequests` 落库，`core/message/types.ts:47`）。
- 只有确认真需要时才在既有 `ModelRequestRecord` 上补一个**可选** usage 字段；**不新建用量表、不为摘要写 SQL、不伪造普通 run 或对话消息**；普通请求 `ModelRequestRecord` 的必填所有权保持不变。
- **失败、被停止或判定无收益而没有摘要消息时**，只写一行日志（requestId、可用 usage、结束原因），不为留档单独造记录容器（[plan/02 §6.1](../plan/02-optimization-plan-and-change-scope.md)）。
- **请求前分配身份**：摘要请求发出**之前**，先在内存里为即将产生的摘要消息分配一个 `summaryMessageId`（即这条 `ModelRequestRecord` 的 `messageId`），不预先落库成消息；每次实际请求的 `requestId` 由发送层按 attempt 生成（`core/llm-client/streaming.ts:345-354`）并回传给调用方。这样成功结果已经带齐「正文 + requestId(s) + 目标 messageId」，批 4 可直接提交。
- **所有权不靠假 run**：普通请求的 `ModelRequestRecord` 仍是 `{runId, messageId, step}` 必填，本批**不放宽**。空闲手动压缩没有活跃普通 step：所有权走一个**压缩作用域**变体（messageId 用上面的 `summaryMessageId`，另带压缩自身标识），**不伪造普通 run、不把普通必填改成可选**。这个类型建议（判别联合还是压缩专用字段）由批 1 的类型核查确认后落定；本批**不新增尝试表**。
- **成功 record 交付**：摘要成功后返回 `{requestId(s), summaryMessageId, record}`；批 4 把这条 record 连同摘要正文在同一 `commitCompaction` 事务里落到 `AssistantMessage.modelRequests`（`core/message/types.ts:47`）。本批只在结果上携带与返回，不落库。

## 9. 同批清理：取消前置 prune 与失用消费者

取消共用压缩入口的前置 prune 与 prune-only 返回，不另留手动专用副本或临时开关。按**真实引用关系**清理，不把失用代码留给批 5（[plan/02 §9.2](../plan/02-optimization-plan-and-change-scope.md)）：

- **Context**：`pruneHistory`（`context-manager.ts:726-809`）、压缩入口里的 prune 调用与 `afterPruneRung` 分支（`:1232-1293`）、`pruneReducedContext`（`:1082-1120`）、`usageAfterPrune`／`PruneResult`／`"pruned"` 状态与 `CompactResult.prune`、prune 配置项（`pruneProtectTokens`／`pruneMinimumTokens`）。仍被摘要投影使用的共用辅助函数**不能仅凭名称删除**。
- **配置与事件**：`PRUNE_PROTECT_TOKENS`／`PRUNE_MINIMUM_TOKENS`（`constants.ts:15-16`）、`core/context/index.ts:13-14` 再导出、`ContextEvent.Pruned`（`events.ts:110-116`）及 `bus/event-catalog.ts` 登记；确认读取用途后同步调整类型和 schema。
- **消费方**：`adapters/ui-runtime/prompt-context.ts` 的 `pruned` 分支、SDK 的 compact 返回类型与导出（`packages/ohbaby-sdk/src/compact.ts`）、CLI 的 `pruned` 渲染（`packages/ohbaby-cli/src/tui/store/events.ts:1162`）、Web 的 `pruned` 行（`apps/ohbaby-web/src/ui/commands/CompactOverlay.tsx:121`），同批更新协议契约和相关测试，避免只删生产方却留假状态。
- **保留**：工具首次返回时的分页/必要限长、调用与结果配对、原生依赖检查、`time.compacted` 与 `commitCompaction` 共用事务、旧摘要及原文读取、仍有效的失败回归。移除前置 prune 不代表撤销旧记录已有的退场标记，也不删除历史数据。
- 测试随语义改写：删除只证明旧 prune 策略的用例，把仍有效的原子性、停止、scope、配对和恢复断言移到新流程。mask 是另一条机制，不借本条扩大清扫。

## 10. 接口契约（输入承接批 1/2，输出供批 4）

- **上游**：批 1 提供真实能力与普通/摘要分离的预算解析（本批只**传**摘要 `requestedOutputTokens`，不重定义解析）；批 2 提供稳定的工具投影与序列化（本批复用同一条 `serializeForLlm`／`serializeHistoryMessages` 路径）。
- **本批产出**：扩展后的 prepared 请求契约、摘要请求的最终 wire、`context-summary` 的请求记录（含可选 usage/real cache 结果）。摘要客户端接口从「history→string」变为「消费 prepared 请求，返回正文 + requestId(s) + `summaryMessageId` + 请求记录（见 §8）」。
- **下游（批 4）消费**：这批请求记录、摘要候选与读到的材料，用于原子提交、遗漏计算与模式 A/B。批 4 不重新选边界、不重造请求。
- 术语统一：全程用 `prepared 请求`／`摘要请求`／`请求记录`；「prune」只出现在本批清理说明里，不引入新状态名。

## 11. 迁移、回退与风险

- 不新增用量表、不做 schema 迁移；旧记录继续可读。回退时停止新行为、保持已提交摘要与原记录可读，不把退场历史无条件塞回窗口；已写入的摘要消息按普通消息保留。
- 主要风险：①材料同源没做全（system/tools/thinking 掉队）→ 以最终 wire 逐项核对；②重试没收干净（SDK 还在重）→ 三个 provider 显式 `maxRetries: 0` 并核对实际 HTTP 次数；③容量检查又套半窗帽 → 以全量 `config.maxTokens` 为预留；④清理误删共用函数 → 按引用关系判断，保留 `time.compacted`/`commitCompaction`。
- 实施时同步 `docs/core/context/goals-duty.md`、`dfd-interface.md`、`test.md`；Context 变更记录入口仍是 `docs/core/context/improve-7/`。

## 12. 本批内部阶段（Stage，同一轮内）

本批仍是一次规划-实施-验收循环，内部按依赖排成三个 Stage，不需要新开文档：

| Stage | 内容 | 可独立验证 |
| --- | --- | --- |
| S1 请求分叉 | prepared 材料分叉 + 末尾指令；摘要客户端改为消费 prepared 请求（§3）；三协议输出字段（§4） | C1、C2 的字段部分 |
| S2 额度、重试、容量 | 摘要独立输出额度并显式传 `requestedOutputTokens`（§5）；单一重试所有者 + `maxRetries: 0`（§6）；90% 与必要提前保护（§7） | C3、E1、A2/A4 |
| S3 同批清理 | 取消前置 prune 与 prune-only，按引用链清理配置/事件/消费者（§9） | C1 的去 prune 断言、E5 |

S3 必须在 S1/S2 之后同批完成：先删 prune 而没有同源摘要请求会暴露「摘要读的是被裁过的历史」；先接分叉而不删 prune 则留下「先裁后失败」的窗口。两步合起来才构成批 3 的完成定义。用量归属（§8）随 S2 携带、随批 4 落库，不在本批单独成立。
