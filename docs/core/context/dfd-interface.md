# Context 模块：数据流与接口

当前契约已同步 [Compact 议题第 4 批](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/02-optimization-plan-and-change-scope.md)（2026-10-13），执行证据见[本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/05-implementation-acceptance.md)。文末先前批次章节仅保留历史设计；与当前正文冲突时，以当前正文为准。第 5 批 mask 清理及全入口回归尚未实施。

本文以实际请求和状态转换为主线，说明 Context 与 Message、Lifecycle、MCP、Provider、Bus 和 UI 的交互。接口签名以 `types.ts` 为准。

## 一、边界图

```text
MemoryReader ───────┐
SystemPromptProvider├─→ createRunPromptSnapshot()
MessageManager ─────┘             │
                                  ▼
ToolScheduler/MCP ── resolved names/schemas ─┐
Lifecycle ── reasoning/tail directives ──────┼─→ prepareTurn()
MessageManager ── scoped durable history ────┘       │
                                                     ├─→ ContextUsage
                                                     └─→ PreparedModelRequest
                                                              │
                                                              ▼
                                                        Provider adapter
                                                              │
                                                              ▼
                                                   TokenUsage/cache observation
```

Context 不访问 MCP registry、UI state 或 Provider transport；这些 adapter 只通过窄输入/输出与 Context 协作。

## 二、普通 initiating turn

```text
1. UI/CLI 接纳 prompt，创建 initiating user message
2. Lifecycle 解析 agent identity、ordered tools、permission/MCP epoch
3. Context.createRunPromptSnapshot()
   3a. SystemPromptProvider.build()
   3b. primary MemoryReader.load()；subagent 使用空 Memory
   3c. dynamic runtime context append-if-absent 到 initiating message
4. Context.prepareTurn()
   4a. assemble scoped active history
   4b. serialize messages + tools；固定 resolved request settings 与 inputIds
   4c. measure ContextUsage
   4d. decideCompactionRung()
   4e. 普通与摘要共用 mask 投影；如需要，从 prepared 分叉 summary，模式 A/B 校验后原子提交，再重新 assemble/measure
   4f. freeze PreparedModelRequest
5. onRequestMeasured(request)
6. Lifecycle 在压缩失败／无收益时终止本次运行，否则把同一 request 交给 Provider adapter
7. Provider 返回 stream + normalized TokenUsage/cache breakdown
8. Lifecycle 更新 scoped calibration；adapter 更新 primary UI tracker
```

关键不变量：步骤 5 与 6 的 `{ messages, tools }` 深等价；步骤 3 的 snapshot 在同一 run 内不刷新。

## 三、后续 tool step 与 MCP epoch

```text
tool result durable append
      ↓
resolve currently admitted tools
      ↓
prepareTurn(current run snapshot, current tool epoch)
      ↓
PreparedModelRequest N
```

- lazy MCP load 发生在 request N 准备后时，不修改 N；只影响 N+1。
- registry 原始遍历顺序不直接决定 wire 顺序；canonical tool order 在 epoch 内稳定。
- permission 移除工具时，下一 request 必须移除；不能为 cache hit 保留过期 schema。
- final-step 使用 `tailDirectives`，messages 被测量并发送一次，tools 为 `[]`。

## 四、自动 compaction

```text
measure usage
  │
  ├─ force=true ───────────────────────────────→ force
  ├─ 同容量且占用不高于成功地板 ───────────────→ none
  ├─ capacityPressure 或窗口占用>=0.90 ──────→ summary
  ├─ 旧 mask 压力比>=0.50 ────────────────────→ mask
  └─ otherwise ───────────────────────────────→ none
```

```text
ordinaryInputBudget = contextWindow - ordinaryMaxTokens - safetyMargin
summaryInputBudget = contextWindow - summaryMaxTokens - safetyMargin
capacityPressure = ordinaryInput >= ordinaryInputBudget
                || summaryInput + ordinaryMaxTokens >= summaryInputBudget
```

`summaryInput` 包含普通 prepared 的同一 mask 投影、system/tools、历史和追加摘要指令。加上 `ordinaryMaxTokens` 是提前预留已申请的普通输出，不是预测增长。普通与摘要实际发送各用自身独立预算；摘要发送前不再扣一次普通输出，超窗时由模式 A 裁请求副本中的较老可裁完整组。

容量压力不转换为 force。成功后按 scope 保存绝对占用地板，同容量且未增长时不重复自动压缩；窗口、输出预留等容量条件变化后重新判断。手动与 force 豁免地板，旧次数帽和 thrash lock 已删除。

### Summary path

```text
acquire scope mutation lease
  ↓
read scoped active history + ordinary prepared request + message/part snapshots
  ↓
plan one rolling summary + fixed 20,000-token recent complete groups
  ↓
append summary instruction; reserve file-operation/omission text within 16,384 tokens
  ↓
check summary budget; Mode A removes only older eligible groups from request copy
  ↓
generate candidate; transient retry and overflow recovery share 2 actual requests
  └─ abort/invalid completion/no eligible groups/no remaining attempt → failure
  ↓
check full ordinary request; Mode B reduces kept tail once, without another summary
  └─ preserve latest complete group and dependencies; still too large → failure
  ↓
recompute omission/body/capacity; require strictly lower full-request occupancy
  ↓
atomic commit checks Stop and message/part snapshots at actual write entry
  ├─ changed/deleted/compacted/related group appended → conflict failure; zero writes
  └─ unchanged → summary + successful requests + metadata + marks commit together
  ↓
set successful occupancy floor → release lease → publish one terminal event
```

R3 failpoint 已证明旧的 `createMessage → appendPart → updatePart*` 会形成非法部分终态；当前 summary 与原文替代 marks 通过 7.5.1 的窄原子端口提交；独立 prune 路径已删除。

## 五、手动 compact 与 prompt 并发

```text
manual compact accepted ─┐
prompt accepted ─────────┼─→ per-(session,scope) mutation lane
auto compact ────────────┘
```

- UI 接纳不等于立即写 Context；
- logical compaction 从 snapshot 到 terminal 持有 scope lease；
- prompt 的 durable Context mutation 排在同 scope manual compact 之后；
- auto compact 在已有 prompt owner 内复用/转交 owner token，避免嵌套死锁；
- 不同 scope 的 lane 互不阻塞；
- store 事务内的 message/part snapshot precondition 防御多 manager 和遗漏入口；新建独立输入消息不构成冲突，不用全局 mutex 或持久化 revision 字段。

## 六、restart/replay

```text
close manager/store/cache
      ↓
reopen durable MessageStore
      ↓
construct new ContextManager
      ↓
assemble + canonical serialize
      ↓
compare live/resumed model view
```

恢复期间：

- summary LLM 调用数为 0；
- 历史 observable event 数为 0；
- deterministic tool repair 与 live view 等价；
- calibration/mask/compaction floor 等明确 ephemeral 状态可重置；
- 若未来采用 durable operation marker，current lifecycle unmatched begin 是 busy，prior lifecycle 才是 stale/orphan。

## 七、公共接口

### 7.1 Run snapshot

```typescript
createRunPromptSnapshot(input: CreateRunPromptSnapshotInput):
  Promise<AgentRunPromptSnapshot>
```

`initiatingUserMessageId` 只允许在新 run 附着一次 runtime context。

### 7.2 Assembly

```typescript
assemble(
  sessionId: string,
  directory: string,
  options: ContextAssemblyOptions,
): Promise<AssembledContext>
```

调用方必须显式提供 `isSubagent`、`toolNames` 和可选 scope/snapshot。

### 7.3 Measurement

```typescript
getUsage(input: {
  readonly context: AssembledContext
  readonly modelId: string
  readonly tools: readonly ModelToolDefinition[] | undefined
}): ContextUsage
```

只测最终 provider-relevant messages/tools，不重复单算 system、Memory 或 tool schema。

### 7.4 Prepare

```typescript
prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>
```

`tailDirectives` 是 ephemeral messages，参与初次测量、compaction 后复测和发送，但不写 history。

### 7.5 Manual compact

```typescript
compact(sessionId: string, options: CompactOptions): Promise<CompactResult>
```

manual 与 automatic 共用 projection/measurement。公开 UI manual compact 当前只允许 primary，但 core contract 同样携带可选 `contextScopeId`，供内部对称测试。

### 7.5.1 Atomic compaction commit

```typescript
messageManager.commitCompaction({
  sessionId,
  contextScopeId,
  compactedAt,
  expectedParts,
  expectedMessages?,
  signal?,
  summary?: { messageId?, agent, text, modelRequests?, metadata? },
})
```

Context 提交精确退场 Part 与相关完整 Message/parts 快照，不新增持久化 revision。Context 预分配 summary message identity，Message adapter 分配 part identity；store 在一个原子边界内检查 signal、深比较快照、校验 scope，提交摘要、成功 records、遗漏 metadata 与退场标记。冲突时 store 返回 `undefined` 且零写入，Context 映射为 `failed`，不再返回 `not-needed`。新输入另建消息不影响旧快照。

SQLite 使用 `BEGIN IMMEDIATE`，内存 store 在实际写入口检查取消；队列等待期间 Stop 也不得写入。事务完成后到达的 Stop 不撤销成功。事务异常或进程在 commit 前终止时不留下空摘要、部分 marks 或双可见 view；Message/Context events 只在 store commit 返回后发布。

### 7.6 Scoped cleanup

```typescript
disposeScope(sessionId: string, contextScopeId: string): void
disposeSession(sessionId: string): void
```

前者不能改变 sibling scope；后者清理整个 session 的 ephemeral Context state。

## 八、事件接口语义

当前 `events.ts` 的已实现契约：

- 所有 event：`sessionId` + primary/child scope identity；primary wire payload 可省略 `contextScopeId`，但只表示 primary；
- compaction progress/terminal：另有相同 `attemptId`；
- summary attempt progress 的最小 payload 为 `attempt/estimatedHistoryTokens`，其中 token 值按正式投影估算 history，不含固定 system/tools 请求开销和正文；已删除缩水恢复专属 droppedRounds；
- terminal outcome：`success | failed | inflated | skipped | aborted`；
- `context.compaction.started` 与 `context.compaction.finished` 建立一次 attempt 的开始/唯一终态；`success` 另带具体 rung，summary 细节仍由同 attempt 的领域事件携带；prune 事件及消费者已删除；
- durable commit 先于 success event；event 失败不回滚；replay 不补发。

## 九、错误分类

| 错误 | 处理层 | 行为 |
|---|---|---|
| 普通 Provider transient | Lifecycle/adapter | 按既有 retry/abort 策略 |
| 原请求 context overflow | Lifecycle + Context | 每个 model step 一次 force，调用前置位；成功、降占用且容量通过才重发，同一步快照重入不获新额度，二次 overflow 终止 |
| Summary request context overflow | Context + summary client | 模式 A 只裁较老可裁完整组；与 transient retry 共用两次实际请求额度，无可裁材料或额度耗尽则失败 |
| Summary transient 失败 | Context | 同一请求副本可重试，和模式 A 共用总额度；流层与 SDK 隐式重试为 0 |
| Summary 空白、length、工具调用、协议缺终态 | Context + summary client | 不重试；terminal failed，原文保持 active |
| Summary 无收益／最终失败 | Context + Lifecycle | 不提交候选，结束当前自动运行；不在同一运行另开 automatic/overflow/force 额度 |
| Durable commit 失败／冲突 | Message adapter/Context | 返回 failed、零部分写；重建必须得到唯一合法 view |
| Event subscriber 失败 | Bus/observer | 记录但不改变 durable truth |

## improve-7：保存失败回复到下一请求（历史记录）

```text
Lifecycle 保存 assistant 错误 + 已有正文（必要时追加一个合成事实 Part）
    ↓ scoped active history
selectFailedHistoryText / selectActiveInterruptionText
    ├─ serializer → 普通 ModelMessage → 计量 → Provider
    └─ serialization(includeToolContext=true) → 实际摘要输入
压缩提交退休原 Part → 两路都不再从旧错误再生正文/说明
```

失败原始协议状态不下发；可投影文本不会被另存为“成功 assistant”。固定说明和可见性定义由 `message/interruption.ts` 提供。工具阶段取消保留调用/结果，说明跟在结果之后。SQLite 重开沿用同一读取规则。

## Compact 议题 improve-2：工具错误 metadata（历史记录）

MCP adapter 抛出的工具执行错误携带原有 metadata，scheduler 通过对象形状守卫接入 `ToolCallResult.metadata`，再由既有 lifecycle 保存到 `ToolPart.state.metadata`。普通请求与摘要继续使用同一工具投影；错误状态和正文保留。新增错误字段不可枚举，避免通过 `error.details` 再写入一份正文；核心不导入 MCP 错误类。见 [本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-2/05-implementation-acceptance.md)。

## Compact 议题 improve-3：摘要返回接口（历史记录）

`ContextLLMClient.generateSummary()` 接受 `request: PreparedModelRequest`、session/scope、预分配 `summaryMessageId`、`compactionId`、attempt 与 abort signal，返回 `{ text, summaryMessageId, requests }`。success `CompressionResult.requests` 返回摘要尝试 records，包含 usage/cache；本批仅返回与日志观测，不写 assistant `modelRequests`、不新增消费统计。自动／手动和主／子代理沿用同一 prepared 与 Provider 流路径，purpose 为 `context-summary`。原生状态仍由三协议 adapter 映射，cache key/策略沿用普通请求。

完整 prepared 历史用于生成摘要，旧 cut point 仍只决定退场集合。旧次数限制／尾段算法留到第 4 批，mask 保留并与普通请求共用同一投影，清理留到第 5 批。
