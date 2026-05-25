# lifecycle improve-1 成果验收

本文档定义本轮重构的验收标准。每条验收项都可独立判定"通过 / 不通过"。本文档只回答"怎么算改完了"，不重复改造动机与实施步骤。

- 改造动机引用见 [problem-analysis.md](./problem-analysis.md)
- 实施步骤引用见 [implementation-plan.md](./implementation-plan.md)

---

## 一、验收原则

1. **可验证**：每条验收项必须能通过自动化测试、命令输出或代码审阅明确判定。
2. **可回溯**：每条验收项关联到 problem-analysis 中的具体问题编号。
3. **零回归**：所有现有单元测试与合约测试在验收时必须全绿，除非该测试本身已被本计划标注为需要迁移。
4. **阶段独立**：A1 / A2 / A3 可分别独立验收，缺失某阶段不阻塞其他阶段。

---

## 二、A1 系列：Context `prepareTurn` 契约验收

对应实施阶段 [P1](./implementation-plan.md#二阶段-p1context-模块建立-prepareturn-契约)。

### A1.1 接口存在且类型正确

**判定**：

- `core/context/types.ts` 导出 `PrepareTurnInput` / `PreparedTurn` 类型。
- `ContextManager` 接口包含 `prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>`。
- `core/context/index.ts` 重新导出上述新类型。
- TypeScript 严格模式编译通过：`pnpm -F ohbaby-agent typecheck`。

**关联**：G2、PA-C6。

### A1.2 行为：一次调用完成"压缩判定 + 序列化"

**判定**：在 `manager.unit.test.ts` 中存在并通过以下用例：

- 输入正常会话历史（未超阈值）：返回 `messages` 非空、`usage.shouldCompress === false`、`compaction === undefined`、内部 `assemble` 仅被调用一次。
- 输入接近阈值的会话：返回值携带 `compaction` 字段，状态为 `compacted` 或 `pruned`，且 `usage.shouldCompress === false`（压缩后已降下来）。
- 输入 `isSubagent: true`：返回的 `messages` 不包含 memory 内容。
- 输入 `force: true`：即使未超阈值也执行压缩并返回 `compaction`。

**关联**：G2、PA-C1。

### A1.3 性能：内部 `assemble` 调用次数

**判定**：通过对 `messageManager.listBySession` 与 memory loader 注入计数器的单测：

- 普通无压缩路径，`listBySession` 在单次 `prepareTurn` 内被调用次数 ≤ 1。
- 压缩路径，`listBySession` 调用次数 ≤ 2（一次组装，一次为压缩生成 summary 后的重新组装）。

**关联**：PA-C1。

### A1.4 现有公共方法不退化

**判定**：

- `compact / assemble / prune / getUsage / shouldCompress` 行为与签名与重构前一致。
- 现有 `manager.unit.test.ts` 全部测试不修改且全绿。

**关联**：G6。

---

## 三、A2 系列：Lifecycle `runSession` 入口验收

对应实施阶段 [P2](./implementation-plan.md#三阶段-p2lifecycle-引入-runsession-新入口)。

### A2.1 接口存在且类型正确

**判定**：

- `core/lifecycle/types.ts` 导出 `LifecycleSessionParams` / `LifecycleConfig` / `TurnContext` 类型。
- `LifecycleEvent` 联合类型新增 `turn:start` / `turn:end` 两个变体。
- `Lifecycle` 类同时存在 `run` 与 `runSession` 两个方法，返回类型一致。
- TypeScript 严格模式编译通过。

**关联**：G3、G4。

### A2.2 行为：单事实源

**判定**：在 `lifecycle.unit.test.ts` 中存在并通过以下用例：

- 调用 `runSession` 期间，断言 Lifecycle 内部**不存在** `conversationMessages` 这类局部副本（通过实现审阅 + 测试钩子双重保证；测试钩子可以是注入一个 spy `MessageManager`，验证 assistant 与 tool 结果只通过 `messageManager.createMessage / appendPart / updatePart` 出现，从不通过其他渠道返回给下一轮）。
- 在 turn N 结束后、turn N+1 开始前向 `MessageManager` 写入一条 user 消息，turn N+1 的 LLM 调用消息列表中**必须**包含该 user 消息。

**关联**：G1、G3、PA-L1、PA-L4。

### A2.3 行为：协议构造下沉至 context

**判定**：

- `runSession` 路径下，LLM 输入消息全部来自 `contextManager.prepareTurn(...)` 的返回。
- `runSession` 不新增 `ChatCompletionAssistantMessageParam` / `ChatCompletionToolMessageParam` 的构造逻辑；代码审阅确认 provider 协议重建位于 `core/context/serializer.ts`。
- 旧 `run()` 为 improve-1 兼容期保留的 `toAssistantToolMessage` / `toolResultToMessage` 等 helper 可以继续存在；这些 helper 不被 `runSession` 调用。

**关联**：G1、PA-L2。

### A2.4 行为：自动触发压缩

**判定**：单测用例 —— 构造一个接近 context window 的会话历史，调用 `runSession`：

- 首轮 `turn:start` 事件中 `usage.shouldCompress === true`。
- `prepareTurn` 在此轮内部完成压缩，LLM 实际看到的消息列表已被压缩。
- 不依赖任何调用方主动调用 `compact()`。

**关联**：G3、PA-L4。

### A2.5 行为：可注入终止策略

**判定**：单测用例 —— 注入 `shouldStopAfterTurn: () => step >= 2`，运行一个工具调用密集的场景：

- 第 2 轮结束后 loop 终止，返回 `LifecycleResult.success === true`。
- 不依赖 `maxSteps` 命中。

**关联**：G4、PA-L5。

### A2.6 现有 `run` 入口与调用方零破坏

**判定**：

- `lifecycle.unit.test.ts` 现有针对 `run` 的所有用例不修改且全绿。
- `ui-inprocess.contract.test.ts` 全绿。
- `worker.unit.test.ts`（如存在）全绿。
- RunWorker 在 improve-1 阶段不切换到 `runSession`，仍调用 `run`。

**关联**：G6。

### A2.7 事件契约

**判定**：`runSession` 路径下发射的事件序列满足：

- 每轮至少一对 `turn:start` 与 `turn:end`。
- `llm:start` / `llm:delta` / `llm:complete` 在 `turn:start` 与 `turn:end` 之间。
- 若该轮有工具，`tool:start` / `tool:result` 在 `llm:complete` 与 `turn:end` 之间。
- 旧 `run` 路径下**不发射** `turn:start` / `turn:end`，保持事件序列向后兼容。

**关联**：G6。

---

## 四、A3 系列：压缩算法正确性验收

对应实施阶段 [P3](./implementation-plan.md#四阶段-p3压缩算法正确性升级)。

### A3.1 切点与 tool 配对保护

**判定**：单测用例覆盖以下场景：

- 历史中存在 `assistant(tool_calls=[t1, t2]) → tool(t1) → tool(t2)` 序列。压缩切点**绝不**落在这三条消息中间任意位置。
- 当 `keepRecentTokens` 阈值正好落在 turn 中间时，该 turn 整体进入压缩区间或整体进入保留区间，不出现孤立 `tool` 消息。
- 对 ohbaby 当前的 persisted `ToolPart` 数据模型，单个 `ToolPart` 内部不做 split；单测应确认该 assistant message 被整体压缩或整体保留。

**关联**：G5、PA-C2。

### A3.2 Token 估算引入 provider 锚点

**判定**：

- 单测构造一段含 3 条带 `tokenUsage` 的 assistant 消息 + 若干后续未带 usage 的消息。`estimateContextTokens` 返回值满足：
  - 锚点之前部分 = provider 累计 token 真值。
  - 锚点之后部分 = 字符估算和。
- 无 `tokenUsage` 时回退路径与现有字符估算结果一致。

**关联**：G5、PA-C3。

### A3.3 摘要 prompt 升级

**判定**：

- `compression-prompt.ts` 包含 6 个 Markdown 二级标题：Goal、Constraints & Preferences、Progress、Key Decisions、Next Steps、Critical Context。
- 包含 `### Done` / `### In Progress` / `### Blocked` 三级标题。
- 新增 `SUMMARIZATION_SYSTEM_PROMPT` 常量被 `summarizeActiveHistory` 引用。
- 单测验证 `generateSummary` 调用时传入的 prompt 字符串包含上述全部标题。

**关联**：G5、PA-C4。

### A3.4 文件操作追踪

**判定**：单测用例 —— 压缩区间内包含 `read_file(path="a")`、`write_file(path="b")`、`edit_file(path="c")` 三次 tool 调用：

- 压缩后生成的 summary 文本末尾包含：
  - `<read-files>` 块中列出 `a`。
  - `<modified-files>` 块中列出 `b` 与 `c`。
- 不在压缩区间内的工具调用不被收集。
- 未知工具名被静默忽略，不抛错。

**关联**：G5、PA-C5。

### A3.5 阈值规则升级

**判定**：

- `constants.ts` 导出 `KEEP_RECENT_TOKENS` 与 `COMPACTION_RESERVE_TOKENS`。
- 当 `tokenCounter.getBudget` 可用时，`shouldCompress` 的判定使用绝对值规则；不可用时回退到比例阈值。
- 单测覆盖两条路径。

**关联**：G5、PA-C2。

---

## 五、全局验收（跨阶段）

### G-1 类型与编译

`pnpm -F ohbaby-agent typecheck`（或对应命令）一次性通过。

### G-2 测试套件

`pnpm -F ohbaby-agent test`（或对应命令）一次性通过。新增测试覆盖所有 A1/A2/A3 条目。

### G-3 静态检查

`pnpm -F ohbaby-agent lint`（或对应命令）一次性通过。无新增 warning。

### G-4 公共 API 变更声明

在 `packages/ohbaby-agent/CHANGELOG.md`（若不存在则新建）中记录：

- `ContextManager.prepareTurn` 新增公共方法。
- `Lifecycle.runSession` 新增公共方法。
- `LifecycleEvent` 新增 `turn:start` / `turn:end` 变体。
- 上述均为新增，旧 API 不变。

### G-5 文档同步

`docs/core/lifecycle/architecture.md` 与 `docs/core/context/` 下相关文档（如有）增加对 `runSession` 与 `prepareTurn` 的说明段落，链接回 improve-1 三份文档。

### G-6 兼容性回归

以下场景手动或自动验证可正常运行：

- 通过 CLI / TUI 发起一次普通会话（多步 + 含工具）。
- 通过 CLI / TUI 触发主动 `/compact` 命令（如存在）。
- 子 agent 流程（如已实现）正常完成。

上述场景在 improve-1 阶段全部走旧路径 `run + compact + assemble`，不应有任何可观察的行为差异。

---

## 六、验收会议清单

每个阶段交付时，按以下顺序逐项核对：

| 序号 | 检查项 | 通过条件 |
|------|-------|---------|
| 1 | 阶段对应 A 系列条目逐项核对 | 全部"通过" |
| 2 | 现有测试套件全绿 | `test` / `typecheck` / `lint` 三命令零失败 |
| 3 | 实施清单中"不动"的文件确认未被改动 | `git diff` 确认 |
| 4 | CHANGELOG / 架构文档同步 | 文档 PR 与代码 PR 同批合并或同 commit |
| 5 | 回滚方案演练（可选） | 在分支上 revert 测试，确认回滚后仍全绿 |

---

## 七、不在验收范围内

以下事项不属于 improve-1 验收范围，对应在后续 improve-N 中独立验收：

- composition / RunWorker 切换到 `runSession`。
- 旧 `run` 入口的删除。
- 多 provider 兼容性测试。
- 增量摘要更新算法。
- 用户中途插话的端到端 UI 演示。

---

## 八、关联文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 实施步骤：[implementation-plan.md](./implementation-plan.md)
- 目录索引：[README.md](./README.md)
