# Context 模块：架构

当前契约已同步 [Compact 议题第 5 批](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/02-optimization-plan-and-change-scope.md)（2026-10-13）。测试范围见[本批测试与验收标准](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/04-test-and-acceptance.md)，实际结果见[本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/05-implementation-acceptance.md)。文末先前批次章节仅保留历史设计；与当前正文冲突时，以当前正文为准。

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
run snapshot + dynamic request inputs + step-local tool definitions
          ↓
canonical model projection
          ↓
PreparedModelRequest { messages, tools, settings?, inputIds? }
          ├─→ wire heuristic / ContextUsage
          ├─→ final attribution / ContextOccupancyComposition?
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
├── compaction-policy.ts         # 触发策略、完整组与固定尾段切点
├── serializer.ts                # durable history → ModelMessage
├── failed-history.ts            # 失败正文/事实选择，普通请求与摘要共用
├── serialization.ts             # 可读历史评分与诊断（非摘要发送源）
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
| Request projection | durable/UI/provider message shape | serializer + tool metadata projection | 不写 store、不调 Provider |
| Compaction policy | threshold、容量压力、成功占用地板 | `decideCompactionRung()` + scoped floor | 纯决策与进程内状态分开；无次数帽或 thrash lock |
| Summary candidate | 读取／保留／遗漏集合、模式 A/B、两次实际请求额度 | `ContextLLMClient` + candidate functions | 候选不是提交事实 |
| Durable commit | summary、成功 requests、metadata 与 compacted marks | `MessageManager.commitCompaction()` + store transaction | 一次原子提交；事件在提交后发布 |
| Scoped coordinator | auto/manual/prompt mutation order | per-scope exclusive lane + pre-commit snapshot check | key=`sessionId+scope`，异 scope 并发 |
| Observation | progress/window/cache event | Bus + tracker | 不回滚、不重放 durable truth |

这里应用 SRP 的尺度是“独立变化原因”，不是“一函数一类”。只有测试证明变化需要独立替换时才抽窄端口。

## 四、请求身份与快照

### 4.1 Run snapshot

`AgentRunPromptSnapshot { systemPrompt, memory }` 在 initiating turn 创建，在同一 run 内保持稳定。目录、custom instruction 或 `OHBABY.md` 的变化只进入下一 run。

### 4.2 Prepared request

`PreparedModelRequest` 固定同一次请求的模型输入、设置与输入归属：

```typescript
interface PreparedModelRequest {
  readonly settings?: PreparedRequestSettings
  readonly inputIds?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[] | undefined
}
```

- `messages` 已包含 system/memory、active history、active reasoning 和 `tailDirectives`。
- `tools` 是当次已解析、已排序、已做 permission/admission 的 schema 快照。
- `onRequestMeasured` 接收 detached/frozen 请求；Provider 发送同一快照。
- final-step 从完整 tool set 派生 system tool names，但发送的 `tools` 为 `[]`。
- `settings` 固定已解析 model、temperature、reasoning 与 maxTokens；`inputIds` 固定本请求纳入的 run 输入。摘要从同一普通请求完整历史投影分叉，继承 system/tools/settings 与模型可见历史，追加 user 指令并覆盖摘要输出预算；模式 A 必要时只裁请求副本中的较老完整组，不改普通请求快照或重建 transcript。

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
force=true                           → force
相同容量条件且占用不高于成功地板         → none
capacityPressure 或完整窗口占用>=0.90   → summary
otherwise                            → none
```

```text
ordinaryInputBudget = contextWindow - ordinaryMaxTokens - safetyMargin
summaryInputBudget = contextWindow - summaryMaxTokens - safetyMargin
capacityPressure = ordinaryInput >= ordinaryInputBudget
                || summaryInput + ordinaryMaxTokens >= summaryInputBudget
```

`summaryInput` 包含普通 prepared 的同一完整历史投影、system/tools、历史和追加摘要指令。加上 `ordinaryMaxTokens` 是提前预留已申请的普通输出，不是预测增长。摘要实际发送只按自身完整输出预留和 safety margin 检查容量，不再扣一次普通输出；超窗时进入模式 A，而不是立即提交裁剪或直接调用装不下的请求。

尾段从最近完整交互组向前累计，目标固定为 20,000 tokens，不按窗口比例缩放；至少保留最近一组，并保护未闭合依赖。全部活动旧摘要参与新摘要，提交后只保留一份滚动摘要。模式 A 只裁摘要请求副本中的较老可裁组；transient retry 与 overflow 恢复共用最多两次实际请求额度。模式 B 在摘要成功后按普通请求的完整输入、输出预留和安全余量计算一次尾段预算，不另发摘要；最近完整组仍放不下则失败。

成功必须同时满足最终正文不超过 16,384 tokens、完整普通请求可发送、占用严格下降。成功后按 scope 记录绝对占用地板；相同容量条件且占用未增长时抑制自动重复压缩，容量变化重新判断，手动与 force 豁免。无可压旧段不调用模型，但仍做普通容量检查。自动失败或无收益由 Lifecycle 终止本次运行；普通 overflow 仅允许每个 model step 一次 force 恢复，输入快照重入不重新获额。

## 六、主/子代理 scope

内部统一使用 `scopedSessionKey({ sessionId, contextScopeId })`：

- primary：`contextScopeId === undefined`，归一为 primary key；
- subagent：显式 child scope；
- calibration、compaction floor 和 mutation lane 都使用同一 key；
- `disposeScope()` 只清一个 child，`disposeSession()` 清全部；
- public static window 查询没有可信 child identity，因此 child session 返回 unavailable，不聚合 sibling 数据。

## 七、并发与恢复

同一 `ContextManager` 内使用 per-scope 排队；store 事务内的 message/part 快照前置条件与 atomic commit 覆盖跨 manager 竞态和 crash consistency：

1. 后端先为手动 compact 取得空闲独占资格，活跃 run、重复压缩和运行时切换立即返回 busy。已接纳操作的 Context mutation 共用同 scope exclusive lane；异 scope 保持并发。
2. logical compaction 从 snapshot 到 terminal 持有 scope lease；`prepareTurn()` 内部直接执行 compaction core，不重复进入 lane，因此不会嵌套死锁。
3. candidate await 后把精确退场 Part 和相关完整 Message/parts 快照交给 `commitCompaction()`；store 在任何写入前深比较当前值。退场快照或相关工具组追加、修改、删除时冲突失败，返回 `failed` 并重读最新 view；新建独立输入消息不使候选失效。
4. failpoint 已证明旧的 summary/mark 多步写存在部分终态窗口；当前由窄的 `commitCompaction()` 端口修复，SQLite 使用 `BEGIN IMMEDIATE`，in-memory 在写前完整校验，不做 catch-only rollback。子进程在首个 part update 后被 `SIGKILL` 的 reopen 测试确认 SQLite 会回滚整个未提交事务。
5. 新摘要正文、成功请求 records、遗漏 metadata 与精确退场 marks 同事务提交。未读且未原样保留的 part IDs 标为 `summary-capacity` 遗漏；失败、Stop、冲突都不应用候选。abort signal 贯通到排队放行后的 store 写入口；事务完成后到达的 Stop 不撤销或误报已提交成功。

手动准入的互斥边界是 canonical workspace 对应的唯一 backend/runtime owner。正常 daemon 由 InstanceStore 保持该边界，不同工作区可共用数据库；独立构造多个同工作区 persistent backend 时，本地 session 锁与账本读取不提供跨 owner 原子准入保证。store 的提交冲突检查仍保护原子性，但不替代准入互斥。

## 八、事件与 UI projection

- 所有 Context event 具有 session/scope identity；primary wire payload 可省略 scope，但消费者归一为 primary。
- compaction progress/terminal event 具有 `attemptId`，每个 accepted attempt 只有一个 terminal outcome。
- summary progress 每次 Provider attempt 继续观测 `attempt/estimatedHistoryTokens`；token 值来自正式 history 投影的 heuristic，不含固定请求开销，不记录 message 正文或额外通用状态。
- durable commit 先于 success event；subscriber 错误不得回滚已提交状态。
- primary UI 只消费 `UiContextWindowUsage` tracker；child scope 不显示 session-only 聚合的伪精确窗口。
- `ContextUsage` 继续只承载窗口控制总量；七类 `ContextOccupancyComposition` 是最终 `PreparedTurn` 的 optional 解释字段，不参与 compaction 决策。
- composition 只从 compaction 后的最终 context、实际 request 与同一步 definitions 计算一次；重建 messages 与 final request 不一致或缺少非空 tool schema provenance 时省略整份 composition，不猜来源。
- `context:prepared` 的 `usage + composition?` 经 worker 进入 stream bridge：raw event 分支更新 primary UI tracker，run-event-source 分支重建 LifecycleEvent；total-only 更新整对象覆盖并清旧 composition。
- Web 顶栏和 Web `/status` 可解释七类；TUI footer 与 TUI `/status` 的 Context 行仍只显示总量。Provider cache 是独立事实，不进入 composition；Web/TUI `/status` 通过独立 `promptCacheUsage` 投影在 Context 后显示 session 累计命中率，可信 Step 的纳入规则见 [Responses migration improve-5](../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-5/02-optimization-plan-and-change-scope.md)，历史设计见 [session-cache-hit](../../problem-lists/2026-08-27-session-cache-hit/README.md)。
- resume/replay 不重新发布历史 observable event，也不重新调用 LLM。

## 九、架构取舍

| 决策 | 选择 | 放弃/代价 |
|---|---|---|
| Context 存储范式 | 继续使用 MessageStore + 窄端口 | 不获得全量 event sourcing 的统一 replay，但避免高迁移复杂度 |
| Compaction 修复 | `commitCompaction()` atomic port | 不增加 durable marker；当前 SQLite/in-memory 都能提供原子边界 |
| 并发控制 | per-scope lane + atomic message/part snapshot precondition | 底层 Context mutation 按 scope 串行，手动请求在外层遇忙拒绝；跨 manager 冲突失败，不增加全局锁或持久化 revision |
| Memory | primary run snapshot 只读 | 本轮不增加自动长期记忆、RAG 或 child MemoryView |
| Provider window | 声明 budget + calibration + bounded recovery | 不持久化 observed adaptive ceiling |

这些决策优先正确性、可靠性和隔离性；复杂度必须由可复现失败证据挣得。

## 迁移 improve-6 的计量与摘要边界（历史记录）

Context 直接选择 `ModelMessage`／扁平工具定义作为计量材料，不再转换为内部旧 Chat 形状。原生状态中的可读推理仍按文本估算，含不透明推理数据时才额外加一次既有 token 代理值；密文和签名不按字符计数；分类来源核对包含完整原生状态。七类分桶是未校准的解释值。

摘要客户端等待流耗尽并要求正常 `stop` 与非空文本。摘要专用序列化补足工具名称、输入、状态与结果；普通历史评分不变。overflow progress 的 `estimatedHistoryTokens` 仍是可读历史评分，不代表完整摘要请求。

## improve-7：失败历史的请求、摘要与计量（历史记录）

`failed-history.ts` 是纯选择函数，不写持久化、不新增历史系统。普通请求和实际摘要（`includeToolContext: true`）共用它：可靠截断、过滤、已知断流可用 active 可见正文加说明；取消只有持久化事实；未知失败为空。所有失败协议消息的 native、推理和未完成工具均不回放。

合成中断事实由 Lifecycle 在原 assistant 上保存。已接受工具步骤的事实单独置于调用/结果之后，不混入 native 正文。退休以现有 Part compacted 标记为准，不能每次从错误枚举重新产生没有载体的事实。

计量使用同一请求投影；失败回复的派生说明与正文整体计入 conversation 一次。scoped assemble 仍负责主/子隔离。默认 readable scoring、选段、prune、低收益锁和 95% 触发策略保持不变。

## Compact 议题 improve-3：重试与 records 所有权（历史记录）

`ContextManager` 是摘要重试的唯一 owner，至多两次实际 Provider 请求；summary client 关闭流层重试，OpenAI Chat、Responses 与 Anthropic SDK 均设置 `maxRetries: 0`。只对 transient transport／可重试 HTTP 错误使用同一 prepared 输入重试；overflow、abort、空白、length、工具调用、协议不完整直接结束。

summary client 返回 `SummaryRequestResult { text, summaryMessageId, requests }`；`SummaryRequestRecord` 属于 compaction／预分配摘要消息，不伪造 runId/step。成功结果返回 records，未应用记录作日志观测，本批不持久化摘要 records 或新增统计消费者。既有 summary + marks 原子提交保持；第 4 批再处理 records 的持久化归属、尾段和终止策略。mask 的普通／摘要一致投影本批保留，第 5 批再清理。
