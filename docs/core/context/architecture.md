# Context 模块：架构

本文描述 Context 的当前结构、依赖方向和 improve-4～5 联合回归的目标边界。目标不是把 `ContextManager` 机械拆成很多类，而是让请求投影、策略、持久化与观测之间的数据流单向且可验证。

## 一、架构总览

```text
UI / CLI / Subagent Host
          │ accepted prompt / manual compact
          ▼
Prompt Scheduler + Lifecycle
          │ resolved tools + run snapshot + scoped identity
          ▼
┌──────────────────────────────────────────────────────────────┐
│ Context core                                                 │
│                                                              │
│ assemble → project → measure → decide rung → compact →       │
│ re-project → PreparedModelRequest                            │
└──────────────────────────────────────────────────────────────┘
   │ read/write         │ summary candidate       │ observe
   ▼                    ▼                         ▼
Message port       ContextLLMClient               Bus
   │                    │
   ▼                    ▼
in-memory / SQLite   Provider adapter
```

### 灵魂数据流

```text
durable truth
  Message + Part + compacted metadata
          ↓
scoped active history
          ↓
run snapshot + dynamic request inputs
          ↓
canonical model projection
          ↓
PreparedModelRequest { messages, tools }
          ├─→ wire heuristic / ContextUsage
          └─→ Lifecycle provider request
                  ↓
             TokenUsage/cache observation
                  ↓
          scoped calibration + UI projection
```

依赖只能沿这条数据流前进。UI tracker、Context event 或 Provider usage 都不能反向成为 durable history 的事实源。

## 二、当前内部结构

```text
packages/ohbaby-agent/src/core/context/
├── context-manager.ts           # 编排、纯策略入口、scoped ephemeral state
├── types.ts                     # ports、请求/usage/结果值对象
├── constants.ts                 # 当前阈值与保护预算
├── serializer.ts                # durable history → Provider messages
├── serialization.ts             # summary 输入与诊断序列化
├── projection.ts                # mask/reduction 纯投影
├── token-estimation.ts          # messages + tools wire heuristic
├── summary.ts                   # summary 识别/分区
├── filters.ts                   # active durable part 判定
├── compression-prompt.ts        # summary prompt
├── file-ops.ts                  # summary 的文件操作事实投影
├── events.ts                    # Context event catalog
├── scoped-exclusive-lane.ts     # session/scope durable mutation 排队
├── context-window-usage.ts      # primary UI window projection/tracker
├── tool-metadata-projection.ts  # tool metadata 的模型投影
└── *.test.ts                    # unit/contract/integration/real gates
```

旧文档中的 `context-assembler.ts`、`context-compressor.ts`、`context-pruner.ts` 和 `__tests__/` 布局不存在，不能作为实现或评审依据。

## 三、稳定边界与变化原因

| 边界 | 隐藏的变化 | 当前形态 | 约束 |
|---|---|---|---|
| Request projection | durable/UI/provider message shape | serializer + projection pure functions | 不写 store、不调 Provider |
| Compaction policy | threshold、floor、thrash、cap | `decideCompactionRung()` | 纯函数、输入显式 |
| Summary candidate | prompt、LLM、overflow shrink | `ContextLLMClient` + candidate functions | 候选不是提交事实 |
| Durable commit | summary 与 compacted marks | `MessageManager.commitCompaction()` + store transaction | summary/prune marks 一次原子提交；事件在提交后发布 |
| Scoped coordinator | auto/manual/prompt mutation order | per-scope exclusive lane + pre-commit revision check | key=`sessionId+scope`，异 scope 并发 |
| Observation | progress/window/cache event | Bus + tracker | 不回滚、不重放 durable truth |

这里应用 SRP 的尺度是“独立变化原因”，不是“一函数一类”。只有测试证明变化需要独立替换时才抽窄端口。

## 四、请求身份与快照

### 4.1 Run snapshot

`AgentRunPromptSnapshot { systemPrompt, memory }` 在 initiating turn 创建，在同一 run 内保持稳定。目录、custom instruction 或 `OHBABY.md` 的变化只进入下一 run。

### 4.2 Prepared request

`PreparedModelRequest` 只包含 Provider 会消费的：

```typescript
interface PreparedModelRequest {
  readonly messages: readonly ChatCompletionMessage[]
  readonly tools: ChatCompletionCreateParams["tools"]
}
```

- `messages` 已包含 system/memory、active history、active reasoning 和 `tailDirectives`。
- `tools` 是当次已解析、已排序、已做 permission/admission 的 schema 快照。
- `onRequestMeasured` 接收 detached/frozen 请求；Provider 发送同一快照。
- final-step 从完整 tool set 派生 system tool names，但发送的 `tools` 为 `[]`。

### 4.3 Tools 不进入 AssembledContext

工具属于 request/epoch，而不是 session history。Lifecycle 与 static/manual composition 各自解析一次工具集合，再把 names/schemas 交给 Context；Context 不依赖 ToolScheduler 或 MCP registry。

## 五、预算与 compaction ladder

`getContextUsage()` 优先使用 `TokenCounter.getBudget()`：

```text
inputBudget = contextWindow - reservedOutput - safetyMargin
usageRatio = currentInput / inputBudget
remainingInput = inputBudget - currentInput
```

```text
force=true                         → force
thrash locked                      → none
ratio>=0.95 OR remaining<4096      → prune-summary（受 per-turn cap）
ratio>=0.50                        → mask
otherwise                          → none
```

summary rung 先应用模型投影/prune，再生成候选；只有下一次真实投影与相同 model/tools/tail directives 下确实变小，才能报告 `compacted`。

## 六、主/子代理 scope

内部统一使用 `scopedSessionKey({ sessionId, contextScopeId })`：

- primary：`contextScopeId === undefined`，归一为 primary key；
- subagent：显式 child scope；
- calibration、mask cutoff、thrash lock、turn count 和后续 mutation lane 都使用同一 key；
- `disposeScope()` 只清一个 child，`disposeSession()` 清全部；
- public static window 查询没有可信 child identity，因此 child session 返回 unavailable，不聚合 sibling 数据。

## 七、并发与恢复

R2 已完成同一 `ContextManager` 内的 per-scope 排队和候选 revision 复核；R3 继续验证 durable commit 的 crash consistency：

1. 同 scope 的 auto+auto、manual+auto、manual+manual 及 prompt Context mutation 共用 exclusive lane；异 scope 保持并发。
2. logical compaction 从 snapshot 到 terminal 持有 scope lease；`prepareTurn()` 内部直接执行 compaction core，不重复进入 lane，因此不会嵌套死锁。
3. candidate await 后、提交前重读精确 scope history，并复核非 summary active history 的语义 revision；stale candidate 以 `CompressionResult { status: "skipped", reason: "stale" }` 结束，不提交旧候选，prepare 路径使用重读后的最新 view。
4. failpoint 已证明旧的 summary/mark 多步写存在部分终态窗口；当前由窄的 `commitCompaction()` 端口修复，SQLite 使用 `BEGIN IMMEDIATE`，in-memory 在写前完整校验，不做 catch-only rollback。子进程在首个 part update 后被 `SIGKILL` 的 reopen 测试确认 SQLite 会回滚整个未提交事务。
5. summary request 自身 overflow 已使用单一路径恢复：总 Provider 调用最多 4 次，每次从最旧 user round 裁到下一个 user 边界；保留最近 user round，非 overflow 不进入该重试，abort signal 贯通主/子代理共用 Lifecycle 与 summary client。

## 八、事件与 UI projection

- 所有 Context event 具有 session/scope identity；primary wire payload 可省略 scope，但消费者归一为 primary。
- compaction progress/terminal event 具有 `attemptId`，每个 accepted attempt 只有一个 terminal outcome。
- summary 每次 Provider attempt 只观测 `attempt/inputTokens/droppedRounds`，不记录 message 正文或额外通用状态。
- durable commit 先于 success event；subscriber 错误不得回滚已提交状态。
- primary UI 只消费 `UiContextWindowUsage` tracker；child scope 不显示 session-only 聚合的伪精确窗口。
- resume/replay 不重新发布历史 observable event，也不重新调用 LLM。

## 九、架构取舍

| 决策 | 选择 | 放弃/代价 |
|---|---|---|
| Context 存储范式 | 继续使用 MessageStore + 窄端口 | 不获得全量 event sourcing 的统一 replay，但避免高迁移复杂度 |
| Compaction 修复 | `commitCompaction()` atomic port | 不增加 durable marker；当前 SQLite/in-memory 都能提供原子边界 |
| 并发控制 | per-scope lane + revision check | 同 scope 长 summary 会排队，但 correctness 优先且异 scope 不阻塞 |
| Memory | primary run snapshot 只读 | 本轮不增加自动长期记忆、RAG 或 child MemoryView |
| Provider window | 声明 budget + calibration + bounded recovery | 不持久化 observed adaptive ceiling |

这些决策优先正确性、可靠性和隔离性；复杂度必须由可复现失败证据挣得。
