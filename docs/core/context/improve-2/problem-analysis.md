# context improve-2 问题分析

本文档分析 `core/context/` 模块在 improve-1 完成后的剩余设计空间，结合 kimi-code 与 pi 的工程实践，以及 Agent 三层记忆系统架构参考文档，定义本轮优化方向。

**核心观点**：ohbaby-agent 的三层记忆架构骨架已完整且方向正确（improve-1 修复了算法层与契约层问题，agents improve-2 已统一 primary/subagent 的 agent 执行入口），context improve-2 聚焦**长会话韧性**——让 `prepareTurn` 不只在 turn 开始时正确，也能支撑单轮内长 tool 链、溢出恢复与可观测性。

---

## 一、分析对象与范围

| 对象 | 路径 |
|------|------|
| Context 管理实现 | [packages/ohbaby-agent/src/core/context/context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts) |
| Context 类型定义 | [packages/ohbaby-agent/src/core/context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) |
| 消息管理 | [packages/ohbaby-agent/src/core/message/](../../../../packages/ohbaby-agent/src/core/message/) |
| 记忆管理 | [packages/ohbaby-agent/src/core/memory/](../../../../packages/ohbaby-agent/src/core/memory/) |
| Agent 生命周期 | [packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) |
| Agent 运行器 | [packages/ohbaby-agent/src/core/agents/runner.ts](../../../../packages/ohbaby-agent/src/core/agents/runner.ts) |
| Agent 服务 | [packages/ohbaby-agent/src/agents/service.ts](../../../../packages/ohbaby-agent/src/agents/service.ts) |
| Subagent 工具 | [packages/ohbaby-agent/src/tools/task.ts](../../../../packages/ohbaby-agent/src/tools/task.ts) |

### 参考材料

| 材料 | 路径 |
|------|------|
| Agent 三层记忆架构 | 外部参考：`agent-harness/memory/2026-02-11-agent-memory-architecture.md`（不依赖本仓库绝对路径） |
| kimi-code agent 模块 | 外部参考：`kimi-code/packages/agent-core/src/agent/`（本地对照项目，不作为仓库链接） |
| pi agent harness | [pi/packages/agent/src/harness/compaction/compaction.ts](../../../../pi/packages/agent/src/harness/compaction/compaction.ts) |
| improve-1 问题分析 | [docs/core/context/improve-1/problem-analysis.md](../improve-1/problem-analysis.md) |

---

## 二、架构回顾：三层记忆系统的正确性确认

在进入问题分析之前，先对照参考文档确认 ohbaby-agent 记忆架构的**方向正确性**。参考文档将 Agent 记忆分为三层：

```
+----------------------------------------------------------+
|                  Long-term Memory                         |
|  持久化存储 | 低频写入 | 跨会话 | 文件/数据库/向量库       |
+----------------------------------------------------------+
              |                        |
              | 写入（低频）            | 读取（按需）
              v                        |
+----------------------------------------------------------+
|                  Mid-term Memory                          |
|  会话级压缩 | 中频读写 | 单次任务内 | Notebook/Summary     |
+----------------------------------------------------------+
              |                        |
              | 压缩归档                | 加载恢复
              v                        |
+----------------------------------------------------------+
|                  Short-term Memory                        |
|  消息流 | 高频读写 | 当前推理步 | Context Window / Messages |
+----------------------------------------------------------+
```

### ohbaby-agent 的对应实现

| 层级 | 参考文档定义 | ohbaby-agent 实现 | 状态 |
|------|-------------|-------------------|------|
| **短期** | Context Window 内的 message 流，每步读写 | `MessageManager` + `Part` 系统（text/tool/reasoning），通过 `prepareTurn` 组装为 LLM 输入 | 已正确实现 |
| **中期** | 会话级压缩、checkpoint、运行时状态 | `ContextManager`（prune → compress → assemble 三阶段流水线），`Lifecycle.runSession` 管理运行时状态 | 骨架正确，改善见 improve-1 |
| **长期** | 跨会话持久化，Middleware 写入 | `MemoryManager`（`OHBABY.md` 文件 + `memory_*` 工具），按需加载 | 已正确实现 |

### 对比参考文档的 open questions

参考文档提出四个开放问题，对照 ohbaby-agent 现状：

| 开放问题 | 参考文档的讨论 | ohbaby-agent 现状 |
|---------|-------------|-------------------|
| **压缩时机** | 基于 token 数阈值？基于语义完整性？ | improve-1 已解决：基于 provider usage 锚点 + 绝对量阈值（`reserveTokens` / `keepRecentTokens`）替代比例阈值 |
| **遗忘机制** | 长期记忆是否需要遗忘？ | 未实现。当前 `memory_remove` 是手动工具，无自动遗忘策略 |
| **记忆检索精确性** | 向量检索的 recall/precision 平衡 | 未实现向量检索，仅文件级 memory 合并 |
| **多 Agent 记忆共享** | 不同 Agent 如何安全共享长期记忆 | 已实现基础隔离：subagent 不加载 memory，不加载 custom instructions；但无共享机制 |

**结论**：ohbaby-agent 的三层记忆架构骨架方向正确，与参考文档的架构图完全一致。参考文档中的 DeerFlow middleware 模式对应 ohbaby-agent 的 `ContextManager.prepareTurn` 每轮自动决策，这比 DeerFlow 的"附着在 Agent 实体上的 middleware"更轻量且同样覆盖了 Agent 完整生命周期。

---

## 三、当前 context 模块的优势（必须保留）

在 improve-1 已经修复大量算法层问题的基础上，列出**本轮不改动**的基础设施：

### S1：函数式工厂构造

`createContextManager(options)` 返回纯方法对象，无 class 实例化成本，便于注入与单测。

### S2：两段式上下文回收（Prune + Compress）

ohbaby 的独有设计，比 pi 的单一 compaction 路径更经济：低成本（prune）优先，高成本（LLM compress）仅在必要时触发。

### S3：富类型 `ContextUsage`

暴露 `inputBudgetTokens / reservedOutputTokens / safetyMarginTokens / usageRatio / remainingTokens` 等完整字段，下游可直接消费。

### S4：基于 `tokenCounter.getBudget(modelId)` 的模型级 budget

通过模型 profile 注册表为不同 model 分别配置 context window 与 output reservation。

### S5：Part 级 compaction 标记

`part.time.compacted` 时间戳允许细粒度回收，单条 message 的部分 part 可被压缩而其他 part 保留。

### S6：通过 Bus 解耦的事件流

`ContextEvent.Compressed / Pruned / TurnPrepared / CompactSkipped` 通过 `core/bus` 发布，context 不直接依赖 UI。

### S7：Subagent 上下文隔离（本架构特有优势）

ohbaby-agent 的 subagent 隔离已相当完善：

```
Agent A (Primary / build)                    Agent B (Subagent / explore)
  │                                              │
  SystemPrompt (完整 identity + memory)          SystemPrompt (SUBAGENT_BASE_PROMPT)
  Memory (OHBABY.md loaded)                      Memory (不加载)
  Custom Instructions (loaded)                   Custom Instructions (不加载)
  Tools (完整工具集)                             Tools (SUBAGENT_DISABLED_TOOLS 禁用)
  │                                              │
  │  task tool 调用                               │ 独立 session (parentId 链接)
  │  ─────────────────────────────────────────────│
  │  ↔ 返回 finalOutput 文本（不暴露完整历史）     │
```

对比 kimi-code：各自用独立 `Agent` 实例 + 独立 `ContextMemory`，结果通过 `lastAssistantText()` 文本传递。ohbaby-agent 的设计与其等效，额外的优势是 `resumeSessionId` 支持 subagent 会话的暂停/恢复。

### S8：`prepareTurn` 完整对外契约（improve-1 建立）

`prepareTurn(input) → { messages, usage, compaction? }` 覆盖"决定本轮 LLM 看什么 + 必要时压缩 + 序列化"的完整用例，adapter 与 lifecycle 不再自行编织。

**保留原则**：本轮所有改造必须保留 S1–S8。

---

## 四、优秀项目对比与借鉴点

### 4.1 kimi-code

kimi-code 的 agent 模块 (`packages/agent-core/src/agent/`) 是最具参考价值的对比对象，因为其功能集（subagent、compaction、context management）与 ohbaby-agent 高度重叠。

#### 4.1.1 kimi-code 的架构亮点

**a) Record/Replay 事件溯源**

kimi-code 的 `AgentRecords` 将所有 context 变更序列化为事件流并持久化到 `wire.jsonl`：

```typescript
// kimi-code records/types.ts 的事件类型：
context.append_message
context.mark_last_user_prompt_blocked
context.append_loop_event
context.clear
context.apply_compaction
```

每次 context 变更都以原子事件记录，支持：
- **崩溃恢复**：从 jsonl 重放所有事件，精确重建内存状态
- **跨进程迁移**：session 可迁移到其他进程继续执行
- **可审计性**：完整的事件级时间线用于调试

ohbaby-agent 现状：通过 `MessageManager` 持久化 message 到 SQLite（`database-store.ts`），但**不记录 context 的非 message 状态变更**（如 compaction 决策、memory 变更、系统 prompt 变更）。这是 P1 级别缺口。

**b) 消息 Origin 追踪**

kimi-code 的 `ContextMessage` 携带 `PromptOrigin` 标记：

```typescript
type PromptOrigin =
  | UserPromptOrigin          // 用户输入
  | SkillActivationOrigin     // skill 激活
  | InjectionOrigin           // 系统注入（plan 提醒、权限提示等）
  | CompactionSummaryOrigin   // 压缩摘要
  | SystemTriggerOrigin       // 系统触发
  | BackgroundTaskOrigin      // 后台任务完成通知
  | HookResultOrigin;         // hook 结果
```

Origin 追踪的价值：
- **精准压缩决策**：compaction 时可以区分来源，对不同 origin 采用不同保留策略
- **调试可观测性**：UI 可以展示每条消息的来源
- **安全审计**：可以追踪哪些内容来自不可信来源

ohbaby-agent 现状：消息仅有 `role`（system/human/ai/tool）和 `agent` 字段，无 origin 追踪。

**c) Per-step 动态压缩**

kimi-code 在每个 tool step 之前检查是否需要压缩：

```typescript
// kimi-code turn/index.ts:
fullCompaction.beforeStep(signal)  // 在每个 step 前调用
```

触达压缩阈值时，**阻塞当前 turn** 直到压缩完成。这确保了即使一个用户 turn 内有大量 tool 调用（比如读取 50 个文件），上下文也不会溢出。

ohbaby-agent 现状：`Lifecycle.runSession` 仅在 turn 开始时调用一次 `prepareTurn`，之后的 tool-call 循环中 `conversationMessages` 持续增长而不再压缩。如果单轮内 tool 调用密集，可能溢出。见 PC-17。

**d) 动态 Completion Budget**

kimi-code 在每次 LLM 调用前，根据当前 context usage 动态计算 `max_completion_tokens`：

```typescript
// kimi-code utils/completion-budget.ts:
computeCompletionBudgetCap({
  capability: model.max_context_tokens,
  input: estimateTokensForMessages(messages) + estimateTokens(systemPrompt),
  safetyMargin: ...,
})
```

确保每次 LLM 调用都不会超出 context window，从 API 层面防护溢出。

ohbaby-agent 现状：`tokenCounter.getBudget()` 提供静态 budget，但未在每次 LLM 调用时动态重新计算 `max_completion_tokens`。

**e) 上下文溢出自动恢复**

kimi-code 在捕获到 `APIContextOverflowError` 或 `CONTEXT_OVERFLOW` 时，自动触发压缩并重试，不将错误抛给用户。

ohbaby-agent 现状：无此机制，溢出错误直接上报。

**f) 注入系统（DynamicInjector）**

kimi-code 的 `InjectionManager` 支持在上下文组装的投影阶段动态插入内容：

```typescript
// project() 中：
memory_recall → 记忆检索结果注入
system_reminder → 计划模式提醒注入
pending_notification → 后台任务完成通知注入
```

这些注入是**短暂的（ephemeral）**——不持久化到 `_history`，仅在本次 LLM 投影中出现。

**g) Background Task 异步通知**

kimi-code 的后台 subagent 完成后，通过 `turn.steer()` 将通知注入父 agent 的上下文：

```typescript
// kimi-code background/index.ts:
notifyBackgroundTask(info) {
  this.agent.turn.steer(context.content, context.origin);
}
```

父 agent 在下一个推理步骤中就能看到子 agent 的完成通知，不需要轮询。

ohbaby-agent 现状：`agent_open / agent_status / agent_close` 工具存在，但无异步通知机制。

**h) 压缩防并发修改（Undo Safety）**

kimi-code 在压缩完成回写时，验证消息历史在压缩期间未被其他操作修改：

```
compaction worker:
  1. 记录 compact-able 消息快照
  2. 发送给 LLM 生成摘要
  3. 在应用摘要前，验证 history 未变化
  4. 如果变化 → 放弃本次压缩结果，不写入
```

ohbaby-agent 现状：压缩是同步串行的（在 `prepareTurn` 内部），但无显式 undo safety 检查。

#### 4.1.2 kimi-code 的架构复现成本评估

| kimi-code 特性 | ohbaby-agent 当前基础 | 复现难度 |
|---------------|---------------------|---------|
| Record/Replay | 已有 MessageManager + SQLite 持久化 | 中：需定义事件类型 + jsonl 写入 |
| Origin 追踪 | 消息有 role、agent 字段 | 低：新增 `origin` 字段到 `MessageWithParts` / `Part` |
| Per-step 压缩 | `prepareTurn` 已有完整压缩逻辑 | 中：需修改 `Lifecycle.runSession` 在循环内重调 `prepareTurn` |
| 动态 completion budget | `tokenCounter.getBudget()` 已提供 budget | 低：在 `llm-client` 层消费 budget |
| 溢出自动恢复 | 无 | 中：需在 `Lifecycle.runModelStep` 捕获并触发压缩重试 |
| 注入系统 | 无 | 中：需新增 injector 抽象 + 整合到 `serializeForLlm` |
| 后台异步通知 | 无 | 中：需新增 `turn.steer` 机制 + 消息队列 |
| Undo safety | `context-manager.ts` 实现同步串行 | 低：添加校验逻辑 |

### 4.2 pi

pi 的 harness 与 ohbaby-agent 的 context 管理在架构哲学上有根本差异，但某些具体实现值得借鉴。

#### 4.2.1 pi 的借鉴点

**a) 文件操作追踪与累积**

pi 的 compaction 跨多轮累积文件操作状态：

```typescript
// pi compaction.ts:
extractFileOperations(messages, entries, prevCompactionIndex)
```

不仅是本次压缩区间，还从前一次 compaction 的 `CompactionDetails` 中继承 `readFiles` 和 `modifiedFiles`。这保证了即使经过多轮压缩，agent 始终知道自己"看过 / 改过哪些文件"。

ohbaby-agent 的 improve-1 已实现文件操作追踪（CP2-D），但**仅限于单次压缩区间**，不跨压缩累积。

**b) Branch summarization**

pi 支持在 session tree 的分支间切换时生成分支摘要：

```typescript
// pi branch-summarization.ts:
generateBranchSummary(entries, fromId, toId)
```

当用户回到之前的会话分支，可以快速了解该分支的内容而不需要重放全部历史。

ohbaby-agent 现状：无 branch / fork 概念，会话是线性的。

#### 4.2.2 pi 的不照搬项

| pi 设计 | 不照搬的理由 |
|---------|------------|
| `SessionTreeEntry` 作为持久化形式 | pi 的 session 是完全自定义的 entry 结构，而 ohbaby-agent 已有 SQLite-backed `MessageManager`，更换持久化层成本过高 |
| `convertToLlm` 多 provider 消息转换 | ohbaby-agent 暂时单一 provider 接入 |
| `AgentMessage` 中间消息类型 | ohbaby-agent 已有成熟的 `MessageWithParts` 类型系统 |
| `session_before_compact / session_compact` hooks | ohbaby-agent 通过 Bus 事件已经实现了松耦合的可观测性 |

### 4.3 参考文档：三层记忆架构

参考文档的核心观点 — **压缩是有损的，关键是在保持语义的前提下降低信息量** — 对 improve-2 的设计方向有指导意义：

- 参考文档强调**信息流转核心原则**：信息从短期向长期流动，反向是按需的。ohbaby-agent 的 `MemoryManager` 实现了长期记忆按需加载（仅 primary agent 加载，subagent 跳过），但未实现"长期向短期"的向量检索注入（RAG）。
- 参考文档强调**Middleware 附着在 Agent 实体上而非单个 Node**。ohbaby-agent 的 `ContextManager.prepareTurn` 在 Lifecycle 层调用，覆盖了 Agent 完整生命周期，这与 Middleware 模式等效。
- 参考文档的 **DeerFlow Notebook 机制**（将某会话的关键信息压缩并结构化存储）与 ohbaby-agent 的 context summary 机制对应，但 ohbaby-agent 的 summary 仅停留在 message 流中，未提升为可跨会话检索的资产。

---

## 五、关键问题清单

每条问题延续 improve-1 的命名体系 `PC-N`（Problem Context），从 PC-14 开始。

---

### PC-14：缺少事件溯源能力，无崩溃恢复与跨进程迁移

**严重度**：高（生产可用性）

**证据**：当前 `MessageManager` 在 SQLite 中持久化 message，但 context 的非 message 状态（compaction 决策、memory 快照、系统 prompt 变更）**无持久化记录**。

**描述**：

- kimi-code 的 `AgentRecords` + `wire.jsonl` 支持从零重建任意时刻的完整 context 状态。
- pi 的 `SessionStorage` 持久化完整 session tree。
- ohbaby-agent 已将 message、tool part、summary part、`part.time.compacted` 等核心投影结果持久化到 SQLite，但没有独立的 context 事件日志。如果 Worker 崩溃后重启，可以恢复消息投影，却无法审计或重放"为什么在某一步压缩 / 跳过 / 加载了哪些 memory / 组装了怎样的 system prompt"这类决策过程。

**违反原则**：持久化完整性（Persistence Completeness）—— 所有影响未来推理决策的状态都应当可恢复。

**与参考文档对应**：参考文档"运行时状态 (Runtime State)" — LangGraph checkpointer 管理的 ThreadState 包含完整图执行状态，支持从任意 checkpoint 恢复。ohbaby-agent 缺少此层。

**优先级**：P1

---

### PC-15：消息缺少 Origin 追踪

**严重度**：中（工程化）

**证据**：`MessageWithParts.info` 仅含 `role` + `agent` 字段，无法区分消息来源。

**描述**：

- 系统注入（如 plan 模式提醒）、压缩摘要、hook 结果、后台任务通知都应带有 origin 标记。
- 缺少 origin 导致：压缩时无法对不同来源的消息采用不同保留策略；UI 无法展示消息来源；调试时无法追溯行为原因。

**违反原则**：可观测性（Observability）、精准事实源（Precise Source of Truth）。

**与 kimi-code 对比**：kimi-code 的 `PromptOrigin` 有 7 种 variant，每种都携带独立上下文。

**优先级**：P1

---

### PC-16：无注入系统，上下文扩展点缺失

**严重度**：中（可扩展性）

**证据**：当前系统 prompt + memory + history 的组装是硬编码的线性流程（`assemble` → `serializeForLlm`），没有为外部注入预留扩展点。

**描述**：

- kimi-code 的 `InjectionManager` 支持在上下文投影阶段动态插入内容（规划模式提醒、权限模式指示、后台任务通知等）。
- ohbaby-agent 想要增加一个"每次 LLM 调用前提醒当前计划进度"的功能，需要修改 `serializer.ts` 或 `context-manager.ts` 的硬代码。

**违反原则**：开闭原则（OCP）—— 对扩展开放，对修改封闭。

**与 kimi-code 对比**：kimi-code 的 `projector.ts` 在 `project()` 中渲染 ephemeral injections，注入内容不持久化到 history，只在本次 LLM 投影中出现。

**优先级**：P2

---

### PC-17：Per-step 压缩缺失，长 tool 链可能溢出

**严重度**：高

**证据**：`Lifecycle.runSession`（`lifecycle.ts:534`）仅在 turn 开始时调用一次 `contextManager.prepareTurn()`。之后 `conversationMessages` 数组持续追加 tool 调用消息但不再压缩。

**描述**：

```
// 当前 runSession 的压缩触发点（仅一次）：
for (let step = 1; step <= maxSteps; step++) {
  if (!conversationMessages) {
    preparedTurn = await contextManager.prepareTurn(...);  // 仅第一次进入
    conversationMessages = [...preparedTurn.messages];
  }
  // ... LLM 调用 + tool 执行 ...
  conversationMessages.push(toolResultToMessage(...));  // 持续增长
  // 第二次及以后：conversationMessages 不再压缩
}
```

如果单轮 user prompt 触发了 30 个 tool 调用（如大规模重构场景），`conversationMessages` 可能膨胀到远超 context window。

**违反原则**：协议正确性（Protocol Correctness）—— 不应假设"单轮 tool 调用量必然在 context 内"。

**与 kimi-code 对比**：kimi-code 在每个 step 前调用 `fullCompaction.beforeStep(signal)`，如果需要压缩则阻塞当前 turn 直到完成。

**优先级**：P0

---

### PC-18：上下文溢出无自动恢复

**严重度**：高

**证据**：`Lifecycle.runModelStep` 调用 `streamChatCompletion` 时，如果 LLM 返回 context overflow 错误，错误直接传播到上层。

**描述**：

- kimi-code 的 `fullCompaction.handleOverflowError()` 在捕获到 `APIContextOverflowError` 或 `CONTEXT_OVERFLOW` 时，自动触发压缩，然后标记为 blocked 直到压缩完成，最后重试 LLM 调用。
- ohbaby-agent 缺少这套"检测 → 压缩 → 重试"的自动恢复链路，用户面临原始 API 错误。

**违反原则**：弹性（Resilience）—— 可恢复的错误不应成为用户可见的故障。

**与 kimi-code 对比**：kimi-code 在 `turn/index.ts` 中捕获溢出错误，调用 `fullCompaction.handleOverflowError()` 自动恢复。

**优先级**：P0

---

### PC-19：Completion budget 未在每次 LLM 调用时动态计算

**严重度**：中

**证据**：`Lifecycle.runModelStep` 调用 `streamChatCompletion` 时未传递动态计算的 `max_completion_tokens`。

**描述**：

- `tokenCounter.getBudget()` 提供了 `maxOutputTokens` 和 `reservedOutputTokens`，但仅用于压缩决策，未被 LLM 调用消费。
- 如果 context window 总容量为 128K、当前已用 120K input，LLM 仍尝试生成 8K 输出，必然溢出。

**违反原则**：防御性编程（Defensive Programming）—— 在边界处做校验。

**与 kimi-code 对比**：kimi-code 的 `completion-budget.ts` 每次 LLM 调用前根据当前 messages + system prompt + tools 估算 input tokens，动态设置 `max_completion_tokens`。

**优先级**：P2

---

### PC-20：后台子 Agent 任务无异步通知机制

**严重度**：中

**证据**：`agent_open` 启动了子 Agent 后，主 Agent 需要主动调用 `agent_status` 轮询，没有推送机制。

**描述**：

- kimi-code 的 `BackgroundManager` 在后台子 Agent 完成时通过 `turn.steer()` 将通知注入父 Agent 的上下文，父 Agent 在下一个推理步就能看到。
- ohbaby-agent 的轮询模式增加了不必要的 LLM 交互次数（轮询本身也是 tool call），也增加了延迟（轮询间隔）。

**违反原则**：效率（Efficiency）—— 应当用事件驱动替代轮询。

**与参考文档对应**：参考文档"多 Agent 记忆共享"开放问题——不同 Agent 如何高效共享信息。

**优先级**：P2

---

### PC-21：文件操作跨压缩累积追踪缺失

**严重度**：中

**证据**：improve-1 的 CP2-D 实现了压缩区间内文件操作追踪，但 `CompressionResult` 不包含继承逻辑。

**描述**：

- pi 的 compaction 从前一次 `CompactionDetails` 继承 `readFiles` 和 `modifiedFiles`。
- ohbaby-agent 每次压缩只追踪当次区间内的文件操作。经过多次压缩后，agent 失去对"在我整个会话中看过哪些文件"的认知。
- 这导致 agent 在压缩后重新读取已经读过的文件——浪费 token。

**违反原则**：关键状态优先保留（Preserve Operational State），有损压缩应有界（Bounded Lossy Reduction）。

**与 pi 对比**：pi 的 `extractFileOperations` 接收 `prevCompactionIndex` 参数继承前序状态。

**优先级**：P2

---

### PC-22：压缩摘要未提升为可跨会话检索的资产

**严重度**：低（前瞻性）

**证据**：压缩摘要存为带 `metadata.kind === "context-summary"` 的合成 part，仅存在于当前会话的 message 流中。

**描述**：

- 参考文档的 DeerFlow Notebook 机制将压缩后的结构化信息写入可跨会话检索的存储。
- ohbaby-agent 的压缩摘要虽然在 token 经济上起到作用（减少当前会话的上下文占用），但没有变成**可跨会话复用的知识资产**。
- 例如：用户在上一会话中修复了一个 Bug，压缩摘要记录了操作文件和决策，但新会话中如果遇到类似问题，这部分知识不可检索。

**违反原则**：信息复用（Information Reuse）—— 压缩不是信息丢弃，而是信息升华。

**与参考文档对应**：参考文档"信息流转核心原则：信息总是从短期向长期流动"—— ohbaby-agent 实现了短期→中期，但中期→长期的流动性不足。

**优先级**：P3

---

### PC-23：无 Pre/Post compaction hooks

**严重度**：低

**证据**：当前压缩流程完全内聚在 `context-manager.ts` 中，外部无介入点。

**描述**：

- kimi-code 和 pi 都有 `PreCompact` / `PostCompact` hooks。
- 这些 hooks 的典型用途：压缩前注入额外上下文（如"优先保留关于 X 的信息"），压缩后校验结果质量，压缩前后记录日志用于 A/B 测试压缩 prompt 效果。
- ohbaby-agent 的 Bus 事件 `Compressed / Pruned` 覆盖了可观测性，但无法让下游**修改压缩行为**。

**违反原则**：可扩展性（Extensibility）。

**与 kimi-code 对比**：kimi-code 的 `PreCompact` 和 `PostCompact` hooks 通过 `HookEngine` 注册，可以在压缩前后执行任意逻辑。

**优先级**：P3

---

### PC-24：压缩无 undo safety，无并发状态校验

**严重度**：低（当前同步环境不触发，但架构应预留）

**证据**：`context-manager.ts` 的 `summarizeHistory` 在压缩完成后直接回写，不校验并发修改。

**描述**：

- kimi-code 的 compaction worker 在生成摘要后回写前，验证 history 未被其他操作修改。如果被修改，放弃本次压缩结果。
- ohbaby-agent 当前的同步串行架构不会触发并发冲突，但如果未来支持异步压缩（后台线程做压缩，主线程继续运行），就会出现 data race。

**违反原则**：防御性（Defensive）—— 并发安全的代码从第一天就应设计好屏障。

**与 kimi-code 对比**：kimi-code 的 `compactionWorker` 记录了 `compactedCount`，在 `applyCompaction` 前验证 history 长度未变化。

**优先级**：P3

---

### PC-25：Tool metadata 缺少中央白名单投影

**严重度**：高

**证据**：`core/context/serializer.ts` 的 `toolResultContent(part)` 只读取 `part.state.output` 或 `part.state.error`。当前成功工具结果的 raw metadata 没有进入 `ToolState.completed`，即使后续持久化后，也缺少统一规则决定哪些 metadata 可进入模型上下文。

**描述**：

- 当前 `Lifecycle.runSession` 在同一步内能通过内存里的 `ToolCallResult.metadata` 传给下一次 LLM 请求；但 per-step prepare 会从 message store 重建 provider messages，这条内存捷径会消失。
- `read -> edit/write` 需要 `mtimeMs`；`bash false` 需要 `exitCode`；MCP 工具可能把关键结构放在 `structuredContent` 中。这些都是模型下一步继续工作的执行事实。
- 反过来，permission/preflight、pid、resolvedPaths、完整 diff、todos 等 raw/internal metadata 不应无差别进入模型上下文。
- 因此需要“raw metadata 持久化 + serializer 中央白名单投影”，而不是各工具自行拼接 output 或直接透传完整 metadata。

**违反原则**：接口隔离（ISP）与最小暴露原则（Least Exposure）—— 模型上下文只应接收完成任务所需的最小事实，不应消费工具内部实现细节。

**与 kimi-code / opencode 对比**：两者都倾向让模型看到稳定的 tool output 执行事实，并把 UI/审计 metadata 与模型输入区分开。opencode 的 tool state 持久化 metadata，但 `toModelMessages` 仍以 output 为主；kimi-code 的 `ExecutableToolResult.output` 是模型可见源，`message` 属于人类侧通道。

**优先级**：P0

---

## 六、根因归纳

问题归并为四条根因，按优先级排列：

### RC-1：缺少状态持久化的完整性（PC-14、PC-18、PC-22）

当前持久化覆盖 message 数据和部分 compaction 投影结果，但不覆盖 context 决策事件（compaction 决策、memory 快照、系统 prompt 构建过程）。这导致：调试时无法精确解释某次上下文投影，溢出恢复也缺少可审计的事件轨迹。

### RC-2：上下文管理缺少中间扩展层（PC-16、PC-17、PC-19、PC-20、PC-25）

当前 context 的组装 → LLM 输入是硬编码的线性流程。缺少：
- 投影层：在组装和 LLM 输入之间允许动态注入（PC-16）
- 中间检查点：在 tool 循环中可触发二次压缩（PC-17）
- 动态参数计算：每次 LLM 调用前根据当前状态调整参数（PC-19）
- 事件驱动通知：后台子 Agent 完成时推送到主 Agent（PC-20）
- 中央投影层：统一决定 tool metadata 哪些进入模型上下文（PC-25）

### RC-3：数据元信息不足（PC-15、PC-21、PC-25）

消息不记录来源（origin）、文件操作不跨压缩累积、tool metadata 不进入持久化上下文事实、摘要不提升为一等公民。这些是"数据管道中的筛子"——关键信息在流转过程中被丢弃。

### RC-4：可扩展性预留不足（PC-23、PC-24）

压缩流程完全封闭，无 hooks 介入点。虽然 Bus 事件覆盖了可观测性，但不允许下游修改行为。并发安全虽然当前不触发，但架构应预留 barrier。

---

## 七、优先级矩阵

按影响 × 复现难度排序：

| 优先级 | 编号 | 问题 | 影响范围 | 复现难度 | 依赖 |
|--------|------|------|----------|---------|------|
| **P0** | PC-17 | Per-step 压缩缺失 | 长 tool 链场景直接溢出 | 中 | improve-1 prepareTurn |
| **P0** | PC-18 | 溢出无自动恢复 | 生产可用性 | 中 | PC-17 |
| **P0** | PC-25 | Tool metadata 白名单投影缺失 | per-step prepare 后执行事实丢失 | 低 | MessageManager + serializer |
| **P1** | PC-14 | 事件溯源 | 崩溃恢复、跨进程迁移 | 中 | MessageManager |
| **P1** | PC-15 | Origin 追踪 | 调试、精准压缩 | 低 | MessageWithParts 类型 |
| **P2** | PC-21 | 文件操作跨压缩累积 | token 经济 | 低 | improve-1 CP2-D |
| **P2** | PC-16 | 注入系统 | 可扩展性 | 中 | serializer |
| **P2** | PC-19 | 动态 completion budget | API 层防护 | 低 | tokenCounter |
| **P2** | PC-20 | 后台异步通知 | 多 Agent 效率 | 中 | agent-task tools |
| **P3** | PC-22 | 摘要跨会话复用 | 知识积累 | 高 | memory 模块扩展 |
| **P3** | PC-23 | Hooks 系统 | 可扩展性 | 中 | Bus 扩展 |
| **P3** | PC-24 | Undo safety | 未来并发安全 | 低 | 无 |

---

## 八、本轮优化目标

### G1：建立 Per-step 压缩能力（P0 → PC-17、PC-18）

`Lifecycle.runSession` 在 tool 循环内动态检测是否需要再次压缩，需要时调用 `prepareTurn` 重新组装 context 并更新 `conversationMessages`。溢出错误自动触发压缩 + 重试。

### G2：建立 Tool metadata 白名单投影（P0 → PC-25）

tool raw metadata 持久化在 message store 中；`serializeForLlm` 通过中央白名单投影模型可见字段。首批覆盖 `read.mtimeMs`、`bash.exitCode`、MCP `structuredContent`、task/subagent `sessionId/success` 等必需事实，同时禁止 permission/preflight、pid、完整 diff 等内部字段进入模型上下文。

### G3：建立事件溯源基础（P1 → PC-14）

定义最小可行的 context 状态变更事件类型，优先记录 compaction / prepareTurn / overflow-recovery 决策。事件持久化形式可先复用现有 SQLite/ledger 思路，不强制照搬 kimi-code 的完整 `wire.jsonl`。

### G4：消息 Origin 追踪（P1 → PC-15）

给 `MessageWithParts.info` 新增 `origin` 字段，覆盖：`user` / `tool` / `compression` / `injection` / `system` / `background_task`。`serializeForLlm` 和压缩切点逻辑消费 origin。

### G5：文件操作跨压缩累积（P2 → PC-21）

`CompressionResult` 包含前序压缩的累积文件操作状态，下一代压缩自动继承。

### G6：建立注入系统骨架（P2 → PC-16）

在 `serializeForLlm` 中预留 injector pipeline，支持注册 ephemeral injection（不持久化，仅本次 LLM 投影出现）。

### G7：动态 completion budget（P2 → PC-19）

`Lifecycle.runModelStep` 在调用 LLM 前根据当前 context usage 动态计算并传递 `max_tokens`。

### G8：后台任务异步通知（P2 → PC-20）

后台子 Agent 完成时通过事件总线通知主 Agent session，主 Agent 下一次 `prepareTurn` 时将通知注入 context。

### G9：现有 API 零破坏

所有现有公共方法（`compact / assemble / prepareTurn / prune / getUsage / shouldCompress`）行为与签名保持不变。S1–S8 优势全部保留。improve-1 成果不受影响。

---

## 九、非目标（不在 improve-2 范围内）

- 向量检索 / RAG 集成（memory 模块独立立项）
- 长期记忆自动遗忘策略（需要更多观测数据）
- Branch / fork / session tree 模型
- Branch summarization
- 多 provider 抽象层
- 将压缩摘要提升为跨会话可检索资产（留 improve-3 / memory improve-1）
- Memory 模块公共 API 扩展
- 异步压缩（后台线程做压缩，主线程继续运行）—— 留 improve-3

---

## 十、后续文档

- 具体改造步骤见 [implementation-plan.md](./implementation-plan.md)
- 验收标准见 [acceptance.md](./acceptance.md)
- 与 lifecycle / memory 模块的协同关系见 [README.md](./README.md)
