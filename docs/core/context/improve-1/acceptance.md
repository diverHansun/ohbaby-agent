# context improve-1 成果验收

本文档定义本轮 context 重构的验收标准。每条验收项均可独立判定"通过 / 不通过"。本文档只回答"怎么算改完了"，不重复改造动机与实施步骤。

- 改造动机引用见 [problem-analysis.md](./problem-analysis.md)
- 实施步骤引用见 [implementation-plan.md](./implementation-plan.md)

---

## 一、验收原则

1. **可验证**：每条验收项必须能通过自动化测试、命令输出或代码审阅明确判定。
2. **可回溯**：每条验收项关联到 problem-analysis 中的具体问题编号（PC-N）。
3. **零回归**：[`manager.unit.test.ts`](../../../../packages/ohbaby-agent/src/core/context/manager.unit.test.ts) 全部已有测试在验收时全绿。
4. **阶段独立**：AC-1 / AC-2 / AC-3 可分别独立验收。
5. **接合面一致**：与 lifecycle improve-1 共享的 `prepareTurn` 契约必须满足双方文档的全部要求。

---

## 二、AC-1 系列：`prepareTurn` 契约验收

对应实施阶段 [CP1](./implementation-plan.md#二阶段-cp1建立-prepareturn-对外契约)。

### AC-1.1 接口存在且类型正确

**判定**：

- `core/context/types.ts` 导出 `PrepareTurnInput` 与 `PreparedTurn` 类型。
- `ContextManager` 接口包含 `prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>`。
- `PreparedTurn.messages` 元素类型为 `ChatCompletionMessage`，可直接传入 `llmClient.stream`。
- `core/context/index.ts` 重新导出上述新类型。
- `pnpm -F ohbaby-agent typecheck` 通过。

**关联**：G1、PC-1。

### AC-1.2 行为：单次调用完成完整流水线

**判定**：在 `manager.unit.test.ts` 中存在并通过以下用例：

| 用例 | 期望结果 |
|------|---------|
| 正常会话（未超阈值） | `messages` 非空；`usage.shouldCompress === false`；`compaction` 为 undefined |
| 接近阈值的会话 | `compaction` 存在且 `status === "compacted"` 或 `"pruned"`；返回时 `usage.shouldCompress === false` |
| `isSubagent: true` | 返回 `messages` 中不含 memory 相关内容 |
| `force: true` 且未超阈值 | 仍执行压缩并返回 `compaction` |
| 空会话 | `messages` 仅含 system prompt；`compaction` 为 undefined |

**关联**：G1、G2、PC-1、PC-10。

### AC-1.3 行为：内部资源调用次数收敛

**判定**：通过对依赖注入 spy 的测试：

- 普通无压缩路径：`messageManager.listBySession` 调用次数 ≤ 1，`memory.load` 调用次数 ≤ 1（subagent 路径为 0）。
- 压缩路径：`listBySession` 调用次数 ≤ 2，`memory.load` 调用次数 ≤ 1。

**关联**：G1、PC-3。

### AC-1.4 行为：决策函数纯函数化

**判定**：

- `decideAction` 为可独立测试的纯函数（不接触 IO）。
- 单测覆盖以下输入组合并断言返回值：

| usage.shouldCompress | historyLength | force | 期望 |
|---------------------|---------------|-------|------|
| false | 任意 | false | `skip` |
| true | ≤ 2 | false | `prune-only` |
| true | > 2 | false | `compact` |
| 任意 | 任意 | true | `compact` |

**关联**：G2、PC-10。

### AC-1.5 行为：序列化与现有 adapter 行为一致

**判定**：

- `serializeForLlm` 在 system prompt + memory 拼接层面与重构前 [`composition.ts:buildSessionPromptMessages`](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L279-L320) 的输出等价。
- subagent 路径下 memory 不被附加，行为一致。
- memory 安全扫描行为保留：传入含可疑内容的 memory 时，`onSecurityFinding` 回调被触发的次数、payload 与重构前完全一致。
- 安全扫描函数仍通过 `core/system-prompt/security` 暴露的接口实现，context 模块不重写扫描逻辑。
- persisted history 中存在 completed / error / aborted `ToolPart` 时，`serializeForLlm` 必须输出合法的 `assistant(tool_calls)` + `tool` result message 配对；不能沿用旧 `messageManager.toModelMessages()` 的扁平化输出。
- 同一 assistant message 里同时存在文本与 tool part 时，assistant message 的 `content` 保留文本；没有文本时为 `null`。
- compacted part、pending tool part、running tool part 不进入最终 LLM 输入。

**关联**：G1、G6、G7、PC-2、PC-13。

### AC-1.6 行为：被依赖模块零 API 变更

**判定**：

- grep 检查 `core/system-prompt/index.ts` 与 `services/llm-model/index.ts` 的导出列表，相对于改造前 commit 必须**完全相同**（无新增、无修改、无删除）。
- `core/memory/index.ts` 同上。
- 三个模块的现有单元测试（`tokenCounting.unit.test.ts` / `modelProfiles.unit.test.ts` / system-prompt `__tests__` 全部 / memory `parser.unit.test.ts` 与 `manager.integration.test.ts`）不修改且全绿。

**关联**：G7。

### AC-1.7 现有公共方法零破坏

**判定**：

- `compact / assemble / prune / getUsage / shouldCompress` 签名、行为、事件发布与重构前完全一致。
- `manager.unit.test.ts` 中所有针对上述方法的现有用例不修改且全绿。

**关联**：G6。

### AC-1.8 接合面：lifecycle improve-1 可消费

**判定**：

- 在 lifecycle improve-1 的 P2 单测中（[`acceptance.md A2.4`](../../lifecycle/improve-1/acceptance.md#a24-行为自动触发压缩)），`runSession` 路径调用 `prepareTurn` 后无需任何二次处理即可送 LLM。
- `PreparedTurn.usage` 字段在 `runSession` 发布 `turn:start` 事件时被直接消费。

**关联**：G5。

---

## 三、AC-2 系列：算法层正确性验收

对应实施阶段 [CP2](./implementation-plan.md#三阶段-cp2算法层正确性升级)。

### AC-2.1 智能切点与 tool 配对保护

**判定**：单测覆盖：

| 场景 | 期望 |
|------|------|
| 历史含 `assistant(tool_calls=[t1,t2]) → tool(t1) → tool(t2)` | 压缩切点不落在这三条之间任何位置 |
| `keepRecentTokens` 阈值恰好落在 turn 中间 | 该 turn 整体进入压缩区间或整体保留，不出现孤立 `tool` 消息 |
| 历史全部为 user / assistant text | 切点对齐到 user 或 assistant message 起点 |
| 历史长度小于 `keepRecentTokens` | 切点为 0（无需压缩） |

**关联**：G3、PC-4。

### AC-2.2 Split-turn 处理

**判定**：单测构造一个超长 turn（单 turn 内 token 超过 `keepRecentTokens`）：

- 切点落在该 turn 内部时，`turnPrefixMessages` 包含该 turn 的前缀（截断之前部分）。
- 后缀部分留在 `messagesToSummarize` 中正常压缩。
- 最终压缩后的 history 不出现 tool / assistant tool_calls 配对错位。
- 若超长内容位于单个 assistant message 的 `ToolPart` 内，improve-1 不允许在该 `ToolPart` 内部切开；测试应断言该 message 整体压缩或整体保留。

**关联**：G3、PC-4。

### AC-2.3 Token 估算 provider 锚点

**判定**：

- 单测构造一段含 3 条带 `tokenUsage` 的 assistant message + 5 条后续 user/assistant 消息：
  - `estimateContextTokens` 返回值的 `anchorTokens` 等于最末锚点 message 的 `promptTokens + completionTokens`。
  - `tailTokens` 等于锚点之后所有消息的字符估算和。
  - `tokens === anchorTokens + tailTokens`。
- 无锚点路径回退到全量字符估算，结果与现有 `estimateTokensForText` 在等价输入下一致。
- `getUsage` 调用使用新函数计算 `currentTokens`。

**关联**：G3、PC-5。

### AC-2.3b Token 估算算法的归属正确

**判定**：

- `estimateContextTokens` 文件位置在 `core/context/`（如 `core/context/token-estimation.ts`），**不**在 `services/llm-model/` 下。
- grep 验证 `services/llm-model/tokenCounting.ts` 不出现对 `MessageWithParts / Part` 的 import 或类型引用。
- `estimateContextTokens` 实现中对 services 的依赖仅限于 `estimateTokensForText` 函数；不依赖 services 的其它内部细节。

**关联**：G7、PC-5。

### AC-2.4 阈值改绝对量

**判定**：

- `getContextUsage` 在 `tokenCounter.getBudget` 可用时使用 `(inputBudgetTokens - currentTokens) < COMPACTION_RESERVE_TOKENS` 判定 `shouldCompress`。
- `tokenCounter.getBudget` 不可用时回退到比例阈值。
- 单测覆盖两条路径，且在大窗口（1M）与小窗口（8K）下行为符合预期。

**关联**：G3、PC-11。

### AC-2.5 压缩 prompt 升级

**判定**：

- `compression-prompt.ts` 导出的字符串包含 6 个二级标题：`## Goal`、`## Constraints & Preferences`、`## Progress`、`## Key Decisions`、`## Next Steps`、`## Critical Context`。
- 包含三个三级标题：`### Done`、`### In Progress`、`### Blocked`。
- 新增 `SUMMARIZATION_SYSTEM_PROMPT` 常量被 `summarizeActiveHistory` 引用并传入 `llmClient.generateSummary`。
- `llmClient.generateSummary` 的接口允许接收 system prompt（如不允许则在 CP2-C 中扩展该接口）。

**关联**：G3、PC-6。

### AC-2.6 文件操作追踪

**判定**：

- 单测构造压缩区间含 `read_file(path="a")`、`write_file(path="b")`、`edit_file(path="c")` 三次 tool 调用：
  - summary 末尾包含 `<read-files>` 块且列出 `a`。
  - summary 末尾包含 `<modified-files>` 块且列出 `b` 与 `c`。
- 压缩区间外的工具调用不被收集。
- 未知工具名静默忽略，不抛错。
- 读写均为空时 summary 末尾不附加任何块。

**关联**：G3、PC-7。

---

## 四、AC-3 系列：数据模型与可观测性验收

对应实施阶段 [CP3](./implementation-plan.md#四阶段-cp3数据模型微调与可观测性)。

### AC-3.1 过滤逻辑集中

**判定**：

- `core/context/filters.ts` 导出 `isActivePart(part)` 单一谓词。
- `getActiveHistory` 与 `serializePart` 调用同一谓词。
- grep 验证 `part.time?.compacted` 直接判定在 context 模块外不出现新增引用（旧引用允许标 `@deprecated` 保留）。

**关联**：G4、PC-8。

### AC-3.2 Summary 识别封装

**判定**：

- `core/context/summary.ts` 导出 `isSummaryMessage / partitionSummary` 等函数。
- `getActiveHistory` 与 `prepareTurn` 内部使用新函数。
- 旧 `serialization.ts:isContextSummary` 保留但标 `@deprecated` 并转发到新函数。
- 单测覆盖 partition 行为（summary 与非 summary 正确分离）。

**关联**：G4、PC-9。

### AC-3.3 可观测事件追加

**判定**：

- `events.ts` 新增 `ContextEvent.TurnPrepared` 与 `ContextEvent.CompactSkipped`。
- `prepareTurn` 每次完成时发布 `TurnPrepared`，payload 含 `sessionId / usage / tookMs / triggeredCompaction`。
- 决策为 `skip` / summarize 返回 `inflated` 时发布 `CompactSkipped`，payload 含 `reason`。
- 现有 `Compressed / Pruned` 事件**未修改**字段。
- 单测使用 Bus mock 断言事件发布次数与 payload。

**关联**：G4、PC-12。

---

## 五、全局验收（跨阶段）

### AG-1 类型与编译

`pnpm -F ohbaby-agent typecheck` 一次性通过。

### AG-2 测试套件

`pnpm -F ohbaby-agent test` 一次性通过。新增测试覆盖所有 AC-1 / AC-2 / AC-3 条目。

### AG-3 静态检查

`pnpm -F ohbaby-agent lint` 一次性通过。无新增 warning。

### AG-4 公共 API 变更声明

在 `packages/ohbaby-agent/CHANGELOG.md` 记录：

- `ContextManager.prepareTurn` 新增公共方法。
- `PrepareTurnInput / PreparedTurn` 新增导出类型。
- `ContextEvent.TurnPrepared / ContextEvent.CompactSkipped` 新增事件。
- `KEEP_RECENT_TOKENS / COMPACTION_RESERVE_TOKENS` 新增常量。
- `COMPRESSION_PROMPT` 内容变更（5 字段 XML → 6 节 Markdown），保留导出。
- `SUMMARIZATION_SYSTEM_PROMPT` 新增导出。
- 现有 API 均不变。

### AG-5 文档同步

- [`docs/core/context/architecture.md`](../architecture.md) 增加对 `prepareTurn` 与 `decideAction` 的说明段落。
- [`docs/core/context/data-model.md`](../data-model.md) 增加对 `PrepareTurnInput / PreparedTurn / KEEP_RECENT_TOKENS / COMPACTION_RESERVE_TOKENS` 的描述。
- [`docs/core/context/dfd-interface.md`](../dfd-interface.md) 增加 `prepareTurn` 的数据流条目。
- 上述更新与代码 PR 同批合并。

### AG-6 与 lifecycle improve-1 接合面验收

- `prepareTurn` 在 lifecycle improve-1 的 P2 单测中作为依赖被消费且全部通过。
- `PreparedTurn.usage` / `PreparedTurn.messages` 字段命名与含义在两份文档中一致。
- 双方文档对 `prepareTurn` 的描述无矛盾（人工 review）。

### AG-7 兼容性回归

以下场景在 improve-1 阶段全部走旧路径（`compact + assemble`），不应有可观察行为差异：

- CLI / TUI 普通会话（多步 + 含工具）。
- 主动 `/compact` 命令（如已实现）。
- 子 agent 流程（如已实现）。

### AG-8 跨模块边界核对

本项是 [implementation-plan.md 1.5 跨模块影响范围](./implementation-plan.md#15-跨模块影响范围硬约束) 的逐项核对。

**判定**：

| 模块 | 核对项 | 通过条件 |
|------|------|--------|
| `services/llm-model` | `index.ts` 导出列表 | 与改造前 commit 完全相同 |
| `services/llm-model` | grep `MessageWithParts \| Part` | 不出现任何匹配 |
| `services/llm-model` | 现有单测 | 不修改且全绿 |
| `core/system-prompt` | `index.ts` 导出列表 | 与改造前 commit 完全相同 |
| `core/system-prompt` | grep `import.*memory` 或 `MergedMemory` | 不出现新增匹配 |
| `core/system-prompt` | 现有单测 | 不修改且全绿 |
| `core/memory` | `index.ts` 导出列表 | 与改造前 commit 完全相同 |
| `core/memory` | 现有单测 | 不修改且全绿 |
| `core/message` | `Part.metadata.tokenUsage` 字段 | 新增为可选字段；旧 Part 序列化结果向前兼容 |
| `adapters/ui-runtime/composition.ts` | `appendMemoryToSystemPrompt` 内部 | 实现被搬迁到 context 模块；adapter 侧为转发壳子或调用 `prepareTurn` 等价路径 |

**关联**：G7、PC-13、RC-5。

---

## 六、保留优势核对

`problem-analysis.md` 第二节列出的 S1–S6 优势在重构后必须依然成立。验收时逐项核对：

| 优势编号 | 核对方式 |
|---------|---------|
| S1 函数式工厂 | `createContextManager` 仍为工厂函数，不引入 class 实例 |
| S2 两段式回收 | `prune` 与 `summarize` 在 `prepareTurn` 内仍按"先 prune 后 summarize"顺序 |
| S3 富类型 ContextUsage | `ContextUsage` 字段集合不缩减 |
| S4 model 级 budget | `tokenCounter.getBudget` 仍被使用 |
| S5 Part 级 compacted 标记 | `part.time.compacted` 仍是底层数据形式 |
| S6 Bus 事件 | `Compressed / Pruned` 仍发布；新增事件叠加而非替换 |

---

## 七、验收会议清单

每个阶段交付时按以下顺序逐项核对：

| 序号 | 检查项 | 通过条件 |
|------|-------|---------|
| 1 | 阶段对应 AC 系列条目逐项核对 | 全部"通过" |
| 2 | 现有测试套件全绿 | `test / typecheck / lint` 三命令零失败 |
| 3 | 实施清单中"不动"的文件确认未被改动 | `git diff` 确认 |
| 4 | S1–S6 优势核对 | 逐项确认仍然成立 |
| 5 | CHANGELOG 与架构文档同步 | 文档 PR 与代码 PR 同批合并 |
| 6 | 与 lifecycle improve-1 接合面 review | 双方 `prepareTurn` 描述无矛盾 |
| 7 | 回滚方案演练（可选） | 在分支上 revert 测试，确认回滚后仍全绿 |

---

## 八、不在验收范围内

以下事项不属于 context improve-1 验收范围：

- 增量摘要更新。
- Context summary 升级为一等公民消息类型。
- Session tree / branch / fork。
- 多 provider 兼容性测试。
- composition.ts 切到 `prepareTurn`（属 lifecycle improve-2 范围）。

---

## 九、关联文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 实施步骤：[implementation-plan.md](./implementation-plan.md)
- 协同导航：[README.md](./README.md)
- lifecycle improve-1 接合面：[lifecycle improve-1 implementation-plan.md](../../lifecycle/improve-1/implementation-plan.md)、[lifecycle improve-1 acceptance.md](../../lifecycle/improve-1/acceptance.md)
