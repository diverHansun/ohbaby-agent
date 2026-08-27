# Context 模块：目标与职责

本文定义 `packages/ohbaby-agent/src/core/context/` 的模块目标、责任边界与当前行为契约。联合回归的实施与验收以 [improve-4-to-5-regression](./improve-4-to-5-regression/README.md) 为补充契约。

## 一、模块定位

Context 把 durable Message history、run-local System/Memory snapshot、当次 ordered tools 和 ephemeral directives 投影为模型可见请求，并在输入预算不足时执行可解释、可恢复的 mask/prune/summary。

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

`prepareTurn()` 返回的 `PreparedModelRequest { messages, tools }` 是测量和 Provider 发送共同消费的不可变快照。不得在 Lifecycle、retry、final-step 或 adapter 中重新组装一份等价请求。

### G2：预算感知的自动保护

自动 summary rung 在以下任一条件成立时触发：

```text
usageRatio >= 0.95
OR remainingInputTokens < 4096
```

- 分母优先使用模型 input budget，而不是完整 context window。
- cached input 仍占用输入窗口；cache hit 不等于释放 token。
- `0.95 + 4096` 是当前行为基线，不在联合回归中顺带调参。

### G3：合法且唯一的模型视图

mask、prune、summary、abort、retry 和 restart 后，模型只看到一个合法视图：被 summary 替代的原文与 summary 不得同时 active；tool call/result 必须配对，或显式投影为 interrupted/unknown。

### G4：主/子代理同契约、按 scope 隔离

primary 与 subagent 都通过同一 `ContextManager`/Lifecycle 链路。隔离身份是 `sessionId + contextScopeId`：

- primary 的 `contextScopeId` 缺省，语义上是 primary scope，不表示“所有 scope”；
- child/sibling scope 的 history、calibration、mask、thrash、compaction count、tool epoch 与 cache identity 互不污染；
- subagent 不自动加载 `OHBABY.md` Memory。

### G5：稳定前缀与正确权限

同一 run 的 System/Memory snapshot 稳定；runtime model context 只附着 initiating user message；同 tool epoch 的工具顺序稳定。缓存优化不能保留已失效的权限、工具或历史。

### G6：故障可解释、状态可恢复

durable store 是事实源。Context event 只用于观测，发布或订阅失败不得回滚已提交历史。恢复不得重新调用 summary LLM，也不得重发旧 observable event。

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

`decideCompactionRung()` 根据 `force`、usage ratio、remaining input floor、thrash lock 和 per-turn cap 返回 `none | mask | prune-summary | force`。策略不访问数据库、LLM、UI 或 MCP。

### D5：执行 mask、prune 与 summary

- mask 只改变模型投影，不删除 durable part；
- prune 为旧 tool output 写 `time.compacted`；
- summary 生成候选、验证体积收益，再把 summary 与原文替代关系提交到 MessageStore；
- manual `compact()` 与 automatic `prepareTurn()` 使用同一请求投影和计量口径。

### D6：维护 scoped ephemeral 状态

calibration factor、mask cutoff、thrash lock 与 per-turn compaction count 按 `sessionId + contextScopeId` 管理。`disposeScope()` 只清一个 child scope，`disposeSession()` 清理整个 session。

### D7：发布 Context 观测事件

所有 Context event 带 session/scope identity；compaction progress/terminal event 另带 attempt identity。每个 accepted attempt 只有一个 terminal outcome；事件不是 durable truth。

## 四、Non-Duties

- 不解析 ToolScheduler/MCP registry；Context 只消费调用方已解析的 names/schemas。
- 不负责 Provider transport、streaming 或普通请求 retry；Lifecycle/adapter 消费 `PreparedModelRequest`。
- 不负责 Memory CRUD、自动提取、RAG 或 `memory_*` 工具。
- 不负责 SystemPrompt 模板内容，只消费 `SystemPromptProvider`。
- 不拥有 Message 实体；持久化、事务与查询由 Message port/adapter 提供。
- 不把 UI tracker 当 child scope 的精确状态源。
- 不解析 Provider cache 命中字段，也不把 cache 塞进 occupancy composition；session 聚合与 `/status` 显示由 [session-cache-hit](../../problem-lists/2026-08-27-session-cache-hit/README.md) 定义的独立 adapter 通道负责。
- 不持久化 Provider observed-window adaptive ceiling；该能力另行设计。

## 五、依赖与方向

| 依赖 | Context 依赖的抽象 | 边界 |
|---|---|---|
| Message | `MessageManager` / 后续窄 atomic commit port | durable history 与变更提交 |
| Memory | `MemoryReader` | 只读 merged Memory |
| SystemPrompt | `SystemPromptProvider` | run snapshot 内容 |
| Token counting | `TokenCounter` | request heuristic 与 budget |
| Summary LLM | `ContextLLMClient` | 只生成候选，不拥有提交 |
| Bus | `BusInstance` | best-effort observable event |

依赖方向遵循 DIP：Context 的领域策略不依赖 SQLite、Web、MCP SDK 或具体 Provider；adapter 依赖 Context 的窄契约。

## 六、当前约束与假设

1. 当前 summary threshold 为 `0.95`，remaining input floor 为 `4096`，preserve ratio 为 `0.3`。
2. primary scope 以 `contextScopeId === undefined` 表示；所有 scoped key helper 必须使用同一归一化语义。
3. 压缩 LLM 会失败、超窗或被 abort；所有循环必须有进展与次数上限。
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
