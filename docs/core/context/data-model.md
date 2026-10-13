# Context 模块：数据模型

当前契约已同步 [Compact 议题第 4 批](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/02-optimization-plan-and-change-scope.md)（2026-10-13），执行证据见[本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/05-implementation-acceptance.md)。文末先前批次章节仅保留历史设计；与当前正文冲突时，以当前正文为准。第 5 批 mask 清理及全入口回归尚未实施。

本文定义 Context 数据结构的语义、所有权和生命周期。TypeScript 字段以 `packages/ohbaby-agent/src/core/context/types.ts` 为准；这里解释字段为何存在、何时稳定、能否持久化。

## 一、身份模型

### Scoped context identity

```typescript
interface ContextIdentity {
  readonly sessionId: string
  readonly contextScopeId?: string
}
```

- primary 的 `contextScopeId` 缺省，但只表示 primary scope；
- subagent 必须带显式 scope；
- key、event、calibration、mask、compaction floor 和 cache observation 使用同一身份语义；
- 缺省 scope 不能解释为“聚合整个 session”。

## 二、请求数据模型

### 2.1 `AgentRunPromptSnapshot`

```typescript
interface AgentRunPromptSnapshot {
  readonly systemPrompt: string
  readonly memory: MergedMemory
}
```

值对象，run-local immutable，不持久化。primary 在 initiating turn 读取 System/Memory；subagent 的 Memory 为空。文件变化只影响下一 run。

### 2.2 `AssembledContext`

```typescript
interface AssembledContext {
  readonly systemPrompt: string
  readonly memory: MergedMemory
  readonly history: readonly MessageWithParts[]
  readonly hasSummary: boolean
  readonly assembledAt: number
  readonly sessionId: string
  readonly contextScopeId?: string
  readonly isSubagent: boolean
}
```

它是“某一时刻 scoped durable history + run snapshot”的只读组装结果，不是最终 Provider request：

- 不包含 tools；工具属于 request epoch；
- 不包含 `tailDirectives` 或 active reasoning；它们是单次请求输入；
- 不持久化；durable truth 仍在 MessageStore。

### 2.3 `PreparedModelRequest`

```typescript
interface PreparedModelRequest {
  readonly settings?: PreparedRequestSettings
  readonly inputIds?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[] | undefined
}
```

它是测量和 Provider 发送的单一请求快照：

- `messages` 已合入 system/memory、active history、reasoning 和 `tailDirectives`；
- `tools` 保留 caller 解析后的顺序和 schema；
- 创建后深冻结，retry/lazy MCP/permission change 不得原地修改；
- `settings` 固定 model、temperature、已解析 reasoning 与输出 maxTokens；`inputIds` 固定本次纳入的 run 输入；
- cache policy 是 adapter capability，不强塞入该值对象；`context-summary` 沿用普通请求的 scope key 与 capability 策略；
- summary 派生值保留同一 mask 投影及上述字段，追加 user 指令并覆盖输出 maxTokens；模式 A 只允许裁派生请求中的较老可裁完整组，原对象保持不变。

### 2.4 `PreparedTurn`

```typescript
interface PreparedTurn {
  readonly request: PreparedModelRequest
  readonly usage: ContextUsage
  readonly composition?: ContextOccupancyComposition
  readonly compaction?: CompactResult
  readonly assembledAt: number
  readonly hasSummary: boolean
  readonly sentHeuristic: number
}
```

`request` 与 `usage/sentHeuristic` 必须来自同一次投影。`compaction` 解释本次 prepare 是否改变了 active view。`composition` 是对 compaction/reduction 后最终请求的解释性估算，不进入 `ContextUsage`，也不改变阈值或预算语义。

### 2.5 `ContextOccupancyComposition`

```typescript
interface ContextOccupancyComposition {
  readonly "system-prompt": number
  readonly "builtin-tools": number
  readonly mcp: number
  readonly skills: number
  readonly conversation: number
  readonly "summarized-conversation": number
  readonly "subagent-exchanges": number
}
```

- 七个值是用现有 `TokenCounter` 得出的非负整数 heuristic，允许加总不等于校准后的 `ContextUsage.currentTokens`；UI 必须用 `~` 表达分类估算。
- runtime `model-context:runtime:v1` 按 provenance 归 `system-prompt`，不按物理 user wire role 归 Conversation。
- context summary 单列；父窗口中的 `subagent_run/status/close` call 与回写单列，child transcript 不聚合进 primary。
- tool schema 来源取同一步 `ToolDefinition.source`：`builtin/module → builtin-tools`、`mcp → mcp`、`skill → skills`；加载后的 SKILL.md 正文作为 tool result 归 Conversation。
- 当最终 `request.messages` 与同一 final context/reasoning/tail directives 的重建结果不一致，或请求含非空 flattened tools 却没有同一步 definitions、两者名称/顺序不一致时，composition 整体省略。final step 同时把 definitions/request tools 清空。

## 三、Token 与预算语义

```typescript
interface ContextUsage {
  readonly currentTokens: number
  readonly contextLimit: number
  readonly inputBudgetTokens?: number
  readonly reservedOutputTokens?: number
  readonly safetyMarginTokens?: number
  readonly usageRatio: number
  readonly remainingTokens: number
  readonly modelId: string
}
```

| 字段 | 语义 |
|---|---|
| `currentTokens` | 当次 `messages + tools` 的 calibrated input occupancy；cache read 仍包含在内 |
| `contextLimit` | 模型声明的完整 context window |
| `inputBudgetTokens` | 扣除 output reserve 与 safety margin 后可供输入使用的预算 |
| `usageRatio` | 有 budget 时为 `currentTokens / inputBudgetTokens`，否则回退完整 limit |
| `remainingTokens` | 剩余 input budget；不是“未缓存 token” |

Provider `TokenUsage.inputTokens` 是 inclusive input；可选 breakdown 满足 `uncached + cacheRead + cacheWrite = inputTokens`。Context 只消费归一化后的口径，不把 hit 当作空闲窗口。

### Anthropic 输入快照的更新

Anthropic 的 uncached/read/write 是整条消息的输入分项；合法字段存在时采用最新值，避免早期未拆分输入与晚到缓存重复相加。只有三个输入分项均明确为零且此前有正输入时，才保留旧输入组以兼容全零占位；输出沿用原单调合并。详见 [Responses migration improve-5 §2.9](../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-5/02-optimization-plan-and-change-scope.md#29-实施中经真实证据确认的最小归一化修复)。

## 四、Compaction 数据模型

### 4.1 结果类型

```typescript
type CompressionStatus = "compressed" | "skipped" | "failed" | "inflated"
type CompactStatus = "not-needed" | "compacted" | "failed" | "inflated"
```

- `compressed/compacted`：候选已经 durable commit，提交前完整普通请求通过容量检查且占用严格下降；事后 Stop 不改变成功事实；
- `inflated`：候选完整请求占用未下降，不得提交，自动运行终止；
- `failed`：生成、容量检查或提交失败（包括快照冲突），不得声称完成；
- `skipped/not-needed`：未达到触发条件、受成功地板抑制，或没有可压旧段；无旧段时仍检查普通请求容量，装不下则外层 `CompactResult.status` 为 `failed`，但不记为摘要请求失败。

### 4.2 Summary candidate

candidate 是进程内值对象：

```text
compactionId / summaryMessageId
sourceHistory / expectedMessages
readIds / keptIds / protectedInputIds / omittedPartIds
historyToCompress / compactedPartSnapshot
summaryBody / snapshot
originalTokens / newTokens / savedTokens
requests: readonly SummaryRequestRecord[]
```

它不是事实。读取、保留与遗漏集合随模式 A/B 更新；固定 20,000-token 尾段保留完整组，最终正文含文件操作与遗漏说明且不超过 16,384 tokens。只有 message/part 快照校验和 durable commit 成功后，才成为 active summary。

### 4.3 Durable compaction state

当前 durable 数据仍由 Message 模块拥有：

| 数据 | 载体 | 所有者 |
|---|---|---|
| 原始 user/assistant/tool history | Message + Part | MessageStore |
| Summary | assistant Message + text Part + summary metadata | MessageStore |
| 成功摘要请求 | 摘要 assistant `modelRequests` | MessageStore |
| 读取／保留 message IDs、受保护 input IDs、遗漏 part IDs 与原因 | 摘要正文 Part `metadata` | MessageStore |
| 被摘要替代的原文标记 | `Part.time.compacted` | MessageStore |

Message port 一次提交上述摘要状态与退场标记；`metadata.kind` 固定为 `context-summary`，遗漏原因用 `summary-capacity`。`ModelRequestRecord` 由 `purpose` 判别：普通 `agent-step` 保留必填 `runId/messageId/step`，`context-summary` 使用 `compactionId` 与预分配摘要 `messageId`，不伪造 run。成功记录随摘要落库，失败、中断和未应用记录只留日志，usage 缺失不补零。Context 不接管数据库事务细节；历史 compacted marks 仍正常读取。

## 五、Ephemeral scoped state

| 状态 | Key | 重启语义 |
|---|---|---|
| calibration factor | session + scope | 重置为 `1.0` |
| mask cutoff | session + scope | 重算 |
| compaction floor | session + scope | 重启清空；同进程跨 run 保留成功后绝对占用和容量签名，容量变化重新判断 |
| force recovery step | Lifecycle run + model step | 新运行／新 step 重新获额，同一步输入快照重入不重置 |
| mutation lane owner/queue | session + scope | 进程内；store 事务内的 message/part snapshot precondition 防跨 manager stale commit |
| UI context window tracker | primary session | projection，可从后续请求重建；total-only 更新清旧 composition |
| UI prompt-cache tracker | primary session | 进程内 session 累计；compact/换模型不清，归档/删除/dispose 清理 |

这些状态不是模型事实；重建后的模型 view 必须等价，但允许上述明确数值重新校准。

`UiPromptCacheUsage` 是与 `UiContextWindowUsage` 平级且分离的 `/status` 投影：

```typescript
interface UiPromptCacheUsage {
  readonly sessionId: string
  readonly accountedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheReadShare: number | null
}
```

它累计同一主代理 session 历次可信 Step 的输入分桶，`cacheReadShare = cacheReadTokens / accountedInputTokens`；无可信样本时分母、read 均为 0 且 share 为 `null`。它不描述当前窗口库存，不进入 occupancy composition 或 snapshot，compact 与换模型也不回减/清空。可信表示该 Step 已结算并实际提供有效缓存读取明细；某一步未知只排除它自己的分子和分母，保留其他 Step 及历史累计。该比例是已观察样本的加权结果，不能还原缺失明细的全部 session 实际比例。纳入规则见 [Responses migration improve-5](../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-5/02-optimization-plan-and-change-scope.md)，既有生命周期沿用 [session-cache-hit](../../problem-lists/2026-08-27-session-cache-hit/README.md)。

## 六、Tool exchange 与 deterministic repair

模型可见的每个 tool call 必须有一个 result，或显式 `interrupted/unknown` repair。若需要 synthetic repair：

- ID、文本、status 是 durable call id/status/schema version 的纯函数；
- 不使用当前时间、随机数或进程顺序；
- 真实 result 优先覆盖 synthetic projection；
- repair 默认不写回 store，除非未来定义显式版本化 migration。

这样 live/restart 的 model view 与 cache prefix 字节稳定。

## 七、事件数据模型

所有 Context event 具有：

```typescript
interface ScopedContextEventIdentity {
  readonly sessionId: string
  readonly contextScopeId?: string // absent means primary only
}
```

compaction progress/terminal 另具有：

```typescript
interface CompactionAttemptIdentity {
  readonly attemptId: string
}

type CompactionTerminalOutcome =
  | "success"
  | "failed"
  | "inflated"
  | "skipped"
  | "aborted"
```

`success` 另带 rung/result 说明 mask 或 summary。事件是 ephemeral observation：不持久化、不在 replay 时重发、不反向修改 durable data。

## 八、生命周期与所有权总表

| 数据 | 创建 | 生命周期 | 事实源 |
|---|---|---|---|
| Message/Part | Message/Lifecycle/Tools | durable | MessageStore |
| `AgentRunPromptSnapshot` | Context | one run | initiating run input |
| `AssembledContext` | Context | one assembly | MessageStore + run snapshot |
| `PreparedModelRequest` | Context | one provider attempt | immutable prepared request |
| `ContextUsage` | Context | one measurement | prepared request heuristic + budget |
| `ContextOccupancyComposition` | Context | one final prepare | final context/request + step-local tool provenance |
| Summary candidate | ContextLLMClient | one compaction attempt | 非事实，提交前可丢弃 |
| Atomic compaction commit | MessageManager/MessageStore | one durable transaction | summary + 成功 requests + metadata + 全部 compacted marks；全成或全不成 |
| Context event | Context/adapter | in-process | 非事实，best effort |
| UI window | tracker | primary projection | 可重建 projection |
| UI prompt-cache usage | UI adapter tracker | primary session、in-process | provider usage 的累计 projection；非窗口事实 |

`CompressionResult.status="skipped"` 的当前无旧段分支使用 `too-short`。类型中的旧 `stale` reason 仍保留，但当前提交冲突返回 `failed/error`，不再表示无需压缩；无关新输入消息仍可并存。

`CompressionResult` 按 `status` 判别：`compressed` 必有 `summaryMessageId`，可携带 requests 与遗漏数量；`skipped` 必有 `reason`，`failed` 必有 `error`。摘要 overflow 进入模式 A，并与 transient retry 共用两次实际请求额度；可裁材料或额度耗尽时失败。模式 B 只重算本地候选，不增加摘要请求。

## 迁移 improve-6：自有结构与估算用途（历史记录）

`ModelMessage` 承载通用正文、工具调用和结果；`ModelState` 保存同源续接需要的协议专有状态，已有类型约束继续生效。Responses reasoning item 的 `encrypted_content` 是服务端返回、客户端无法解读的字符串，只原样保存／同源回传；它不是可读推理文本，也不按字符串长度计 token。Anthropic thinking signature 同样不作为摘要正文。

计量直接使用自有消息和扁平工具定义。已有原生状态时，重复的 reasoningText 不再另计；原生状态中的可读推理正文仍按文本估算，只有包含不透明推理数据时才额外加一次既有 usage／输出上限代理值。密文、签名与完整原生 JSON 不进入通用文本计量。三协议转换由 provider 负责，Context 不定义三套请求格式。

`ContextUsage.usageRatio` 仍表示输入预算占用，供 mask／thrash 等已有规则使用。自动 summary 与 UI 则都使用 `currentTokens / contextLimit`，其中 `contextLimit` 是完整窗口。两种比例用途不同。

## Compact 议题 improve-3：摘要请求记录与预算（历史记录）

`SummaryRequestResult { text, summaryMessageId, requests }` 的 requests 是 `SummaryRequestRecord[]`。记录沿用普通请求的 requestId、messageId、attempt、inputIds、时间、outcome 与可选 usage，新增 compactionId，purpose 固定为 `context-summary`，不包含虚构 runId/step。usage 缺失保持未知，cache 使用既有 inclusive input breakdown。成功 `CompressionResult.requests` 返回 records；本批不写入 durable assistant.modelRequests，失败或未应用记录只保留日志观测。其持久化与统计归属留到第 4 批。

摘要文本上限 16,384 tokens；输出预留分别为关闭 thinking 的 16,384、数字 budget B 的 `16,384 + B`、effort/adaptive 的 32,768。reasoning 配置保持普通请求已解析值。完整摘要输入估算包含追加指令、system、tools 和同一 mask 历史。

```text
ordinaryInputBudget = contextWindow - ordinaryMaxTokens - safetyMargin
summaryInputBudget = contextWindow - summaryMaxTokens - safetyMargin
capacityPressure = ordinaryInput >= ordinaryInputBudget
                || summaryInput + ordinaryMaxTokens >= summaryInputBudget
```

`summaryInput` 包含普通 prepared 的同一 mask 投影、system/tools、完整历史和追加摘要指令。加上 `ordinaryMaxTokens` 是在发送普通请求前为其已申请的最大输出预留空间，不是预测实际未来增长，也不另加比例。普通与摘要实际发送仍各用自身独立预算；摘要发送前只检查 `summaryInput > summaryInputBudget`，不再扣一次普通输出。单次巨型输入仍可能直接跨过摘要容量并失败。

第 3 批完成时，容量压力与完整窗口 0.90 阈值共同进入 summary，仍受旧次数／thrash guard 约束，只有显式 force 绕过。第 4 批已移除次数帽、thrash lock 和 preserve ratio，改用固定 20K 完整组尾段与成功占用地板；只有 mask 状态仍保留到第 5 批。此段记录阶段演进，不表示旧保护当前仍存在。
