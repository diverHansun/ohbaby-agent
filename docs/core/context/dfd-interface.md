# Context 模块：数据流与接口

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
   4b. serialize messages + tools
   4c. measure ContextUsage
   4d. decideCompactionRung()
   4e. 如需要，执行 mask/prune/summary 后重新 assemble/measure
   4f. freeze PreparedModelRequest
5. onRequestMeasured(request)
6. Lifecycle 把同一 request 交给 Provider adapter
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
  ├─ ratio>=0.95 OR remainingInput<4096 ──────→ prune-summary
  ├─ ratio>=0.50 ─────────────────────────────→ mask
  └─ otherwise ───────────────────────────────→ none
```

### Summary path

```text
acquire scope mutation lease
  ↓
read scoped active history
  ↓
find legal turn cut point
  ↓
generate summary candidate
  ├─ explicit context overflow → drop oldest complete turn/API round,
  │                              clean leading orphan tool results,
  │                              retry with progress/max/abort bounds
  └─ other failure → terminal failed
  ↓
validate candidate is smaller and tool pairing legal
  ↓
atomic commit validates selected Part snapshots
  ├─ changed/deleted/compacted → stale skip; zero writes
  └─ unchanged → summary + compacted marks commit together
  ↓
release lease → publish one terminal event
```

R3 failpoint 已证明旧的 `createMessage → appendPart → updatePart*` 会形成非法部分终态；当前 summary/prune 都通过 7.5.1 的窄原子端口提交。

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
- store 事务内的 selected-Part snapshot precondition 防御多 manager 和遗漏入口，不用全局 mutex 或持久化 revision 字段。

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
- calibration/mask/thrash 等明确 ephemeral 状态可重置；
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
  readonly tools: ChatCompletionCreateParams["tools"]
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
  summary?: { agent, text },
})
```

Context 提交被选中 Part 的瞬时快照，而不是新增持久化 revision 字段；Message adapter 分配 summary message/part identity，store 在一个原子边界内深比较快照、校验 scope、写可选 summary 并标记全部 parts。快照已变化时返回 stale 且零写入；SQLite 事务失败或进程在 commit 前终止时不留下 active 空 summary、部分 mark 或双可见 view。该结论由并发 barrier、SQL failpoint 与事务中途 `SIGKILL` 后 reopen 共同验证。Message/Context events 只在 store commit 返回后发布。

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
- summary attempt progress 的最小 payload 为 `attempt/estimatedHistoryTokens/droppedRounds`，其中 token 值只估算 history，round 数为累计值，不含正文；
- terminal outcome：`success | failed | inflated | skipped | aborted`；
- `context.compaction.started` 与 `context.compaction.finished` 建立一次 attempt 的开始/唯一终态；`success` 另带具体 rung，prune/summary 细节仍由同 attempt 的领域事件携带；
- durable commit 先于 success event；event 失败不回滚；replay 不补发。

## 九、错误分类

| 错误 | 处理层 | 行为 |
|---|---|---|
| 普通 Provider transient | Lifecycle/adapter | 按既有 retry/abort 策略 |
| 原请求 context overflow | Lifecycle + Context | force prepare/compact 后发送新 request |
| Summary request context overflow | Context + summary client | 最多 4 次 Provider 调用；完整 user round 收缩；最近 user round floor；abort 立即终止 |
| Summary 非 overflow 失败 | Context | terminal failed，原文保持 active |
| Durable commit 失败 | Message adapter/Context | 不报告 success；重建必须得到唯一合法 view |
| Event subscriber 失败 | Bus/observer | 记录但不改变 durable truth |
