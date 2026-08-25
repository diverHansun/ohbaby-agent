# Context 模块：数据模型

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
- key、event、calibration、mask、thrash、compaction 和 cache observation 使用同一身份语义；
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
  readonly messages: readonly ChatCompletionMessage[]
  readonly tools: ChatCompletionCreateParams["tools"]
}
```

它是测量和 Provider 发送的单一请求快照：

- `messages` 已合入 system/memory、active history、reasoning 和 `tailDirectives`；
- `tools` 保留 caller 解析后的顺序和 schema；
- 创建后深冻结，retry/lazy MCP/permission change 不得原地修改；
- cache policy 是 adapter capability，不强塞入该值对象。

### 2.4 `PreparedTurn`

```typescript
interface PreparedTurn {
  readonly request: PreparedModelRequest
  readonly usage: ContextUsage
  readonly compaction?: CompactResult
  readonly assembledAt: number
  readonly hasSummary: boolean
  readonly sentHeuristic: number
}
```

`request` 与 `usage/sentHeuristic` 必须来自同一次投影。`compaction` 解释本次 prepare 是否改变了 active view。

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

## 四、Compaction 数据模型

### 4.1 结果类型

```typescript
type CompressionStatus = "compressed" | "skipped" | "failed" | "inflated"
type CompactStatus = "not-needed" | "pruned" | "compacted" | "failed" | "inflated"
```

- `compressed/compacted`：候选已经 durable commit，且下一真实投影变小；
- `pruned`：只提交 prune，未提交 summary；
- `inflated`：候选不比被替代输入小，不得提交；
- `failed`：生成或提交失败，不得声称完成；
- `skipped/not-needed`：未达到条件或没有合法 cut point。

### 4.2 Summary candidate

candidate 是进程内值对象：

```text
historyToCompress
snapshot
originalTokens
newTokens
savedTokens
```

它不是事实。只有在 scope lease、revision recheck 和 durable commit 成功后，才成为 active summary。

### 4.3 Durable compaction state

当前 durable 数据仍由 Message 模块拥有：

| 数据 | 载体 | 所有者 |
|---|---|---|
| 原始 user/assistant/tool history | Message + Part | MessageStore |
| Summary | assistant Message + text Part + summary metadata | MessageStore |
| 被替代/被 prune 标记 | `Part.time.compacted` | MessageStore |

联合回归若证明多步写会形成非法终态，Message port 增加一次性 atomic compaction commit；Context 不接管数据库事务细节。

## 五、Ephemeral scoped state

| 状态 | Key | 重启语义 |
|---|---|---|
| calibration factor | session + scope | 重置为 `1.0` |
| mask cutoff | session + scope | 重算 |
| thrash lock | session + scope | 重置 |
| per-turn compaction count | session + scope | 新 turn/reset |
| mutation lane owner/queue | session + scope | 进程内；durable revision 防跨 manager stale commit |
| UI context window tracker | primary session | projection，可从后续请求重建 |

这些状态不是模型事实；重建后的模型 view 必须等价，但允许上述明确数值重新校准。

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

`success` 另带 rung/result 说明 mask、prune 或 summary。事件是 ephemeral observation：不持久化、不在 replay 时重发、不反向修改 durable data。

## 八、生命周期与所有权总表

| 数据 | 创建 | 生命周期 | 事实源 |
|---|---|---|---|
| Message/Part | Message/Lifecycle/Tools | durable | MessageStore |
| `AgentRunPromptSnapshot` | Context | one run | initiating run input |
| `AssembledContext` | Context | one assembly | MessageStore + run snapshot |
| `PreparedModelRequest` | Context | one provider attempt | immutable prepared request |
| `ContextUsage` | Context | one measurement | prepared request heuristic + budget |
| Summary candidate | ContextLLMClient | one compaction attempt | 非事实，提交前可丢弃 |
| Atomic compaction commit | MessageManager/MessageStore | one durable transaction | 可选 summary + 全部 compacted marks；全成或全不成 |
| Context event | Context/adapter | in-process | 非事实，best effort |
| UI window | tracker | primary projection | 可重建 projection |

`CompressionResult.status="skipped"` 时，`reason` 对当前可观测分支显式区分：

- `too-short`：active history 不足以生成有效 summary；
- `stale`：summary Provider await 期间 durable history revision 已变化，候选未提交。

`CompressionResult` 是按 `status` 判别的 union，而不是一组可任意组合的 optional 字段：`compressed` 必有 `summaryMessageId`，`skipped` 必有 skip `reason`，`failed` 必有 `error`，summary overflow 另以 `summary-overflow-exhausted | summary-overflow-minimum` 表示有界终止原因。
