# Context 模块：目标与职责

当前契约已同步 [Compact 议题第 4 批](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/02-optimization-plan-and-change-scope.md)（2026-10-13），执行证据见[本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/05-implementation-acceptance.md)。文末先前批次章节仅保留历史设计；与当前正文冲突时，以当前正文为准。第 5 批 mask 清理及全入口回归尚未实施。

本文定义 `packages/ohbaby-agent/src/core/context/` 的模块目标、责任边界与当前行为契约。联合回归的实施与验收以 [improve-4-to-5-regression](./improve-4-to-5-regression/README.md) 为补充契约。

## 一、模块定位

Context 把 durable Message history、run-local System/Memory snapshot、当次 ordered tools 和 ephemeral directives 投影为模型可见请求，并在输入预算不足时执行可解释、可恢复的 mask/summary。独立 prune 写入路径及其事件、返回值和消费者已移除。

```text
durable MessageStore
  + AgentRunPromptSnapshot
  + current ordered tools
  + active reasoning / tail directives
            ↓
     Context projection + measurement
            ↓
       PreparedModelRequest
            ↓
       Lifecycle → Provider
```

没有 Context 模块时，请求测量、发送、压缩和 UI 占用会各自组装输入，容易产生窗口判断错误、工具权限漂移及主/子代理串线。

## 二、Design Goals

### G1：请求单一真相源

`prepareTurn()` 返回的 `PreparedModelRequest { messages, tools, settings?, inputIds? }` 是测量和 Provider 发送共同消费的不可变快照。不得在 Lifecycle、retry、final-step 或 adapter 中重新组装一份等价请求。

### G2：预算感知的自动保护

自动 summary rung 按完整窗口占用率触发：

```text
currentTokens / contextLimit >= 0.90
或 ordinaryInput >= ordinaryInputBudget
或 summaryInput + ordinaryMaxTokens >= summaryInputBudget
```

- contextLimit 来自模型连接时探测的窗口，失败时沿用配置／默认回退；容量预留使用本次普通请求完整 maxTokens，不套半窗帽；只有 mask 保留旧半窗压力比。
- cached input 仍占用输入窗口；cache hit 不等于释放 token。
- 普通／摘要输入预算各自扣除自身完整输出预留和 safety margin；summaryInput 包含追加指令与固定 system/tools。自动触发额外预留普通请求已申请的最大输出：`summaryInput + ordinaryMaxTokens >= summaryInputBudget`。这不是未来增长预测，不加新 ratio，也不恢复旧 4096 提前摘要条件。
- 容量压力与 0.90 占用率共同进入 summary 分支；同容量且占用不高于成功地板时抑制自动重复压缩，容量变化重新判断，手动与 force 豁免。次数帽与 thrash lock 已移除。摘要超窗由模式 A 裁请求副本的较老完整组，摘要成功后普通请求仍超窗由模式 B 收缩保留尾段；保护集合之外已无空间则失败。

### G3：合法且唯一的模型视图

mask、summary、abort、retry 和 restart 后，模型只看到一个合法视图：被 summary 替代的原文与 summary 不得同时 active；tool call/result 必须配对，或显式投影为 interrupted/unknown。

### G4：主/子代理同契约、按 scope 隔离

primary 与 subagent 都通过同一 `ContextManager`/Lifecycle 链路。隔离身份是 `sessionId + contextScopeId`：

- primary 的 `contextScopeId` 缺省，语义上是 primary scope，不表示“所有 scope”；
- child/sibling scope 的 history、calibration、mask、compaction floor、tool epoch 与 cache identity 互不污染；
- subagent 不自动加载 `OHBABY.md` Memory。

### G5：稳定前缀与正确权限

同一 run 的 System/Memory snapshot 稳定；runtime model context 只附着 initiating user message；同 tool epoch 的工具顺序稳定。缓存优化不能保留已失效的权限、工具或历史。

### G6：故障可解释、状态可恢复

durable store 是事实源。摘要正文、成功请求 records、遗漏 metadata 与退场 marks 同事务提交；相关 message/part 快照冲突或提交前 Stop 不应用候选，提交后 Stop 不撤销成功。Context event 只用于观测，发布或订阅失败不得回滚已提交历史。恢复不得重新调用 summary LLM，也不得重发旧 observable event。

### G7：简单且可测试

核心策略尽量保持纯函数；IO、时间、LLM、MessageStore 和 Bus 位于端口边界。抽象只隐藏已经证实会独立变化的决策，不为假想的 Context source 或 Provider 策略预建框架。

## 三、Duties

### D1：创建 run-local prompt snapshot

`createRunPromptSnapshot()` 在 initiating turn 捕获 SystemPrompt 与 Memory，并可向 initiating user message 幂等附着动态、仅模型可见的 runtime context。

### D2：组装 scoped durable history

`assemble()`：

- 按 session/scope 读取 Message history；
- 使用调用方提供或新建的 `AgentRunPromptSnapshot`；
- primary 加载 Memory，subagent 使用空 Memory；
- 返回 `AssembledContext`，但不把工具 schema 固化为会话状态。

### D3：投影并测量一次请求

`prepareTurn()` / `getUsage()`：

- 把 system、active history、active reasoning、tail directives 序列化为 Provider messages；
- 把调用方已经解析的 ordered tools 放入同一请求；
- 对同一个 wire heuristic 计算 `ContextUsage`；
- 仅在最终 compaction/reduction 投影确定后，用同一步 tool definitions 对七类 `ContextOccupancyComposition` 估算一次；provenance 不足时省略而不猜测；
- 返回深冻结的 `PreparedModelRequest`。

### D4：选择 compaction rung

Context 先按 scope 检查成功占用地板；`decideCompactionRung()` 根据 `force`、容量压力、完整窗口占用率与 mask 的旧半窗预留压力比返回 `none | mask | summary | force`。纯策略不访问数据库、LLM、UI 或 MCP。

### D5：执行 mask 与 prepared summary 分叉

- mask 只改变模型投影，不删除 durable part；
- 摘要从普通请求的同一 mask 投影分叉，继承 system、tools、模型可见历史、tail directives、model 与 reasoning；追加 user 指令并独立预留输出。全部活动旧摘要参加新的单滚动摘要；固定 20,000-token 原文尾段按完整组保留，至少留最近一组并保护未闭合依赖；
- 模式 A 只裁摘要请求副本中较老可裁完整组；模式 B 在摘要成功后，按普通完整请求的剩余空间一次收缩尾段，不再请求摘要。两者都更新读取／保留／遗漏集合；最终正文含文件操作和遗漏说明，合计不超过 16,384 tokens；
- 候选需通过完整普通请求容量与严格降占用检查，再把 summary、成功 `modelRequests`、遗漏 metadata 和精确退场关系提交到 MessageStore；无可压旧段不发摘要但仍检查普通容量，无收益或最终失败由 Lifecycle 终止本次自动运行；
- manual `compact()` 与 automatic `prepareTurn()` 使用同一请求投影和计量口径；摘要 Provider purpose 为 `context-summary`，cache 身份及能力策略继承普通请求。
- Context 独占摘要重试，transient retry 与模式 A 的 overflow 恢复共用最多两次实际请求；摘要流层与三个 SDK 的隐式重试均为 0。abort、空白、length、工具调用和协议缺终态不重试；普通请求 overflow 由 Lifecycle 每个 model step 最多 force 恢复一次，同一步快照变化不重新获额。

### D6：维护 scoped ephemeral 状态

calibration factor、mask cutoff 与成功 compaction floor 按 `sessionId + contextScopeId` 管理。地板在同进程跨 run 保留；`disposeScope()` 只清一个 child scope，`disposeSession()` 清理整个 session。

### D7：发布 Context 观测事件

所有 Context event 带 session/scope identity；compaction progress/terminal event 另带 attempt identity。每个 accepted attempt 只有一个 terminal outcome；事件不是 durable truth。

## 四、Non-Duties

- 不解析 ToolScheduler/MCP registry；Context 只消费调用方已解析的 names/schemas。
- 不负责 Provider transport、streaming 或普通请求 retry；Lifecycle/adapter 消费 `PreparedModelRequest`。
- 不负责 Memory CRUD、自动提取、RAG 或 `memory_*` 工具。
- 不负责 SystemPrompt 模板内容，只消费 `SystemPromptProvider`。
- 不拥有 Message 实体；持久化、事务与查询由 Message port/adapter 提供。
- 不把 UI tracker 当 child scope 的精确状态源。
- 不解析 Provider cache 命中字段，也不把 cache 塞进 occupancy composition；session 聚合与 `/status` 显示由独立 adapter 通道负责；原 [session-cache-hit](../../problem-lists/2026-08-27-session-cache-hit/README.md) 通道现按 [Responses migration improve-5](../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-5/02-optimization-plan-and-change-scope.md) 的可信 Step 规则纳入，不依赖整个 Run 的缓存明细完整性。
- 不持久化 Provider observed-window adaptive ceiling；该能力另行设计。

## 五、依赖与方向

| 依赖 | Context 依赖的抽象 | 边界 |
|---|---|---|
| Message | `MessageManager.commitCompaction()` | durable history 与原子变更提交 |
| Memory | `MemoryReader` | 只读 merged Memory |
| SystemPrompt | `SystemPromptProvider` | run snapshot 内容 |
| Token counting | `TokenCounter` | request heuristic 与 budget |
| Summary LLM | `ContextLLMClient` | 只生成候选，不拥有提交 |
| Bus | `BusInstance` | best-effort observable event |

依赖方向遵循 DIP：Context 的领域策略不依赖 SQLite、Web、MCP SDK 或具体 Provider；adapter 依赖 Context 的窄契约。

## 六、当前约束与假设

1. 当前 summary threshold 为完整窗口的 `0.90`，另有完整输出预留的提前容量条件。尾段目标固定为 20,000 tokens；成功地板只抑制同容量且未增长的自动重复触发，不恢复 preserve ratio、次数帽或 thrash lock。
2. primary scope 以 `contextScopeId === undefined` 表示；所有 scoped key helper 必须使用同一归一化语义。
3. 摘要内部总额度为两次实际请求，不能通过 automatic／overflow／force 在同一失败运行另开额度；成功后随正常增长可继续压缩，不设每轮压缩次数帽。
4. 部分持久化和同 scope 并发不能靠调用顺序假设；联合回归用 failpoint/barrier 决定是否扩展窄端口。
5. summary 的语义质量由独立 eval 验证，普通 unit 只验证确定性结构、隐私、体积和恢复。

## 七、关键公共接口

- `ContextManager.assemble()`
- `ContextManager.createRunPromptSnapshot()`
- `ContextManager.getUsage()`
- `ContextManager.prepareTurn()`
- `ContextManager.compact()`
- `ContextManager.disposeScope()` / `disposeSession()`
- `PreparedModelRequest`
- `ContextUsage`
- `ContextOccupancyComposition`
- `CompactResult`

接口的实际 TypeScript 定义以 `packages/ohbaby-agent/src/core/context/types.ts` 为准；本文记录语义和责任，不复制全部字段。

## improve-1 计量与退场修复（2026-10-13）（历史记录）

尾段与完整请求复用正式模型消息投影及 TokenCounter，包含工具 metadata、活动兼容 reasoning 和实际回传的原生状态；展示 reasoning 不重复计数。摘要超窗直接失败，不能缩小输入后仍按原集合退场。前置 prune 与无收益 aggressive 重试保持现状，后续批次再替换。详见[本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-1/05-implementation-acceptance.md)。

## Compact 议题 improve-2：稳定工具结果（历史记录）

MCP 工具错误的结构化 metadata 已接入既有持久化与白名单投影，error 状态不变。同一记录在常规请求、摘要工具投影与数据库重开后保持一致；默认 mask 关闭时，预算变化不二次裁短正文。Read 分页与子代理回传沿用原有机制，不新增配额或预览状态。完整压力路径的 prune／mask 清理分别留在第 3、5 批，见 [本批验收](../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-2/05-implementation-acceptance.md)。

## Compact 议题 improve-3：本批边界（历史记录）

摘要正文上限为 16,384 tokens；数字 thinking budget 为 B 时输出预留为 `16,384 + B`，effort／adaptive 为 32,768，关闭 thinking 为 16,384。沿用已解析 reasoning，不缩小 thinking 预算。`SummaryRequestResult` 返回文本、预分配摘要消息 ID 和实际请求 records；成功 `CompressionResult` 携带 records，本批不把它们写入 assistant `modelRequests`，失败／未应用 records 只作日志观测。摘要正文与旧原文替代关系继续使用既有原子提交。mask 仍保留且普通／摘要共用投影，第 5 批才清理；第 4 批的单滚动摘要、尾段算法和终止条件不在本批。
