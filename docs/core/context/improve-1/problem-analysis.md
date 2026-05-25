# context improve-1 问题分析

本文档分析 `core/context/` 模块当前实现中暴露的设计缺陷，结合 pi 项目的 context 设计哲学，定义本轮重构目标。本文档只回答"为什么改"与"借鉴什么"，不涉及具体改动方案；改动方案见 [implementation-plan.md](./implementation-plan.md)。

---

## 一、分析对象与范围

| 对象 | 路径 |
|------|------|
| Context 管理实现 | [packages/ohbaby-agent/src/core/context/context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts) |
| Context 类型定义 | [packages/ohbaby-agent/src/core/context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) |
| Context 序列化 | [packages/ohbaby-agent/src/core/context/serialization.ts](../../../../packages/ohbaby-agent/src/core/context/serialization.ts) |
| Context 事件 | [packages/ohbaby-agent/src/core/context/events.ts](../../../../packages/ohbaby-agent/src/core/context/events.ts) |
| Context 常量 | [packages/ohbaby-agent/src/core/context/constants.ts](../../../../packages/ohbaby-agent/src/core/context/constants.ts) |
| 压缩 prompt | [packages/ohbaby-agent/src/core/context/compression-prompt.ts](../../../../packages/ohbaby-agent/src/core/context/compression-prompt.ts) |
| Token 估算 | [packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts](../../../../packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts) |
| 当前编排层 | [packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) |

参考材料：[D:\Projects\agent-components\harness\analysis-pi-vs-ohbaby.md](file:///D:/Projects/agent-components/harness/analysis-pi-vs-ohbaby.md)。

---

## 二、当前 context 模块的优势（必须保留）

在批评问题之前，先明确本次重构**不会推翻**的现有优势。这是评估改动是否合理的对照基线。

### S1：函数式工厂构造

`createContextManager(options)` 返回纯方法对象，无 class 实例化成本，便于注入与单测。比 pi 的 `Agent` / `Harness` 实例风格更轻量。

### S2：两段式上下文回收

`prune`（丢弃已完成工具输出）+ `compress`（摘要压缩）是 ohbaby 的独有设计，比 pi 的单一 compaction 路径更经济：低成本动作优先尝试，高成本动作仅在必要时触发。

### S3：富类型 `ContextUsage`

暴露 `inputBudgetTokens / reservedOutputTokens / safetyMarginTokens / usageRatio / remainingTokens` 等字段，下游可直接消费。pi 仅返回单一 token 计数。

### S4：基于 `tokenCounter.getBudget(modelId)` 的 model 级 budget

通过 [`modelProfiles`](../../../../packages/ohbaby-agent/src/services/llm-model/modelProfiles.ts) 注册表为不同 model 分别配置 context window 与 output reservation。比 pi 的"统一 `contextWindow - 16384`"更灵活。

### S5：Part 级 compaction 标记

`part.time.compacted` 时间戳允许细粒度回收：单条 message 的部分 part 可以被压缩而其他 part 保留。pi 仅有 entry-level 标记。

### S6：通过 Bus 解耦的事件流

`ContextEvent.Compressed / Pruned` 通过 [`core/bus`](../../../../packages/ohbaby-agent/src/bus/) 发布，UI / Worker 旁听式订阅。context 不直接依赖 UI。

**保留原则**：本轮所有改造必须保留 S1–S6，验收时会显式核对。

---

## 三、跨模块协作面

context 模块不是孤立模块，它对外依赖三个本包模块。本节明确所有接合面，约束本轮改造的边界。本节内容直接影响 [implementation-plan.md 第一节](./implementation-plan.md#一总体策略) 的跨模块影响声明与 [acceptance.md AG 系列](./acceptance.md#五全局验收跨阶段) 的边界核对项。

### 3.1 当前依赖的对内模块

| 被依赖模块 | 用途 | 现状接合方式 |
|----------|------|-----------|
| [`services/llm-model`](../../../../packages/ohbaby-agent/src/services/llm-model/) | 文本级 token 估算、模型 budget 计算 | 通过注入的 `TokenCounter` 接口消费 `estimateTokens / getBudget / getLimit` |
| [`core/system-prompt`](../../../../packages/ohbaby-agent/src/core/system-prompt/) | 系统提示组装（identity / agent / task / environment / customInstructions / tools） | 通过注入的 `SystemPromptProvider` 接口消费 `build({ sessionId, directory, isSubagent })` |
| [`core/memory`](../../../../packages/ohbaby-agent/src/core/memory/) | 全局 / 项目 memory 文件加载与合并 | 通过注入的 `MemoryReader` 接口消费 `load(directory)` |

三者均通过 `ContextManagerOptions` 依赖注入（[types.ts:132-146](../../../../packages/ohbaby-agent/src/core/context/types.ts#L132-L146)），保持 DIP。本轮**不改动任何一个依赖模块的对外 API**。

### 3.2 模块职责边界

| 模块 | 应当拥有的职责 | 不应越界的事项 |
|------|-------------|-------------|
| `services/llm-model` | 提供文本级 token 估算原语（`estimateTokensForText`）、模型 profile 查询（`getBudget / getLimit`） | 不应理解 `MessageWithParts / Part` 等领域类型；不应感知会话状态 |
| `core/system-prompt` | 输出已组装完整的 system prompt 字符串（含 identity / task / agent / environment / customInstructions / tool guidance） | 不应注入运行时 memory；不应决定 LLM 输入的 message 数组结构 |
| `core/memory` | 加载并合并 `OHBABY.md / AGENTS.md / CLAUDE.md` 等 memory 文件，输出 `MergedMemory` | 不应决定 memory 何时/如何并入 system prompt |
| `core/context`（本模块） | 决定本轮 LLM 输入；调用上述三者并合成；判定压缩；序列化为 `ChatCompletionMessage[]` | 不应替代上述三者的内部能力；不应自行实现 token 原语或 prompt 组装 |

### 3.3 现状违反的边界（衍生问题）

- **memory 注入与安全扫描位于 adapter 层**：见 PC-13。
- **token 估算的领域层归属未定**：当前 `services/llm-model/tokenCounting.ts` 仅提供 `estimateTokensForText`，没有 `MessageWithParts` 感知的估算函数；context 模块自己做拼接序列化 + 字符估算，但缺少 provider usage 锚点算法（PC-5）。新算法必须明确归属：**领域感知层在 context（消费 `MessageWithParts`），原语层留在 services（消费 `string`）**。
- **system prompt 的"最终形态"不唯一**：`SystemPromptProvider.build` 返回的字符串并非真正送 LLM 的 system prompt，因为 adapter 层还会追加 memory（PC-13 的衍生症状）。

### 3.4 本轮改造对外模块的影响

| 模块 | 本轮是否修改公共 API | 仅有的内部协作变化 |
|------|------------------|----------------|
| `services/llm-model` | **否** | 仅在 [CP2-B](./implementation-plan.md#32-cp2-btoken-估算-provider-锚点) 中，context 模块新增的 `estimateContextTokens(history)` 函数会**消费** `estimateTokensForText`，并需要 `Part` metadata 携带的 `tokenUsage`。`tokenUsage` 字段的载入由 `core/message` 与 `core/lifecycle` 共同支持，不要求 services 暴露新 API。 |
| `core/system-prompt` | **否** | context 模块继续通过现有 `SystemPromptProvider.build` 接口消费；memory 与 system prompt 的合并搬入 context 的序列化器，不要求 system-prompt 暴露新接口。 |
| `core/memory` | **否** | 同上，继续通过 `MemoryReader.load` 消费。 |

---

## 四、关键问题清单

每条问题给出稳定编号、严重度、代码定位、违反的软件工程原理、与 lifecycle improve-1 的关系。

### PC-1：`prepareTurn` 对外契约缺失，编排逻辑外溢

**严重度**：高（架构性）

**证据**：[composition.ts:279-320](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L279-L320)

**描述**：当前由 adapter 层 `buildSessionPromptMessages` 依次调用 `compact()` → `assemble()` → `messageManager.toModelMessages()` → 拼接 system prompt，再返回 `ChatCompletionMessage[]`。"准备一轮 LLM 输入" 这件事在 context 模块没有任何对外契约，每个调用方都要重复这套编排。

**违反原则**：封装（Encapsulation）、用例完整（Use-Case Completeness）。模块应当为其核心用例提供完整 API，而不是要求调用方自行组装内部步骤。

**与 lifecycle improve-1 关系**：等价于 lifecycle improve-1 的 PA-C6。本轮在 context improve-1 中落地 `prepareTurn` 实现，lifecycle improve-1 的 `runSession` 在其 P2 阶段消费该契约。

---

### PC-2：`assemble.history` 与 `messageManager.toModelMessages` 双轨产出，事实源不统一

**严重度**：高

**证据**：

- `assemble()` 返回的 `AssembledContext.history` 由 [`getActiveHistory`](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L114-L137) 过滤 compacted parts 后产出，用于 token 估算与压缩。
- adapter 实际送 LLM 的消息来自 [`messageManager.toModelMessages(sessionId)`](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L314)，与 `assemble.history` 是**两条独立的路径**。
- 二者都消费同一份 message 数据，但过滤规则、序列化规则、字段范围可能漂移。

**描述**：`assemble.history` 实际上**从未作为 LLM 输入直接使用**，但仍参与 token 估算与压缩判定。token 估算依据的"历史"与 LLM 真正看到的"历史"可能不一致，导致压缩判定与现实脱节。

**违反原则**：单一事实源（Single Source of Truth）。

**与 lifecycle improve-1 关系**：本问题不在 lifecycle improve-1 的 PA-C 清单中，是更深入审阅时发现的新问题。其修复依赖 `prepareTurn` 的引入：当 context 模块自己产出 LLM 输入时，token 估算与真实输入必然一致。

---

### PC-3：`compact()` 内部三次 `assemble`

**严重度**：高

**证据**：[context-manager.ts:391-457](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L391-L457)

**描述**：一次 `compact()` 调用先后执行 `assemble`（before）→ `prune` → `assemble`（afterPrune）→ `summarize` → `assemble`（afterCompression）。每次 `assemble` 都重新拉取整段 history、重载 memory、重做序列化、重做 token 估算。在长会话中显著放大 IO 与 CPU 开销。

**违反原则**：DRY（Don't Repeat Yourself）的反向延伸——重复**计算**与重复**代码**同样违反 DRY。

**与 lifecycle improve-1 关系**：等价于 PA-C1。修复在本轮 context improve-1 中通过 `prepareTurn` 单次流水线完成。

---

### PC-4：压缩切点不感知 turn 边界与 tool 配对

**严重度**：高

**证据**：[context-manager.ts:82-112](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L82-L112) 的 `getHistoryToCompress`

**描述**：当前实现从末尾按 token 比例累加直到达到 `preserveRatio` 阈值，**完全不区分 message 类型**。当切点正好落在 `assistant(tool_calls)` 与对应 `tool` 结果之间时，下一轮 LLM 看到的是孤立的 `tool` 消息没有对应的 `tool_calls`。OpenAI / Anthropic 协议都要求 tool_calls 与 tool 结果配对，这会触发 provider 报错或行为退化。

**违反原则**：协议正确性（Protocol Correctness）。

**与 lifecycle improve-1 关系**：等价于 PA-C2。

---

### PC-5：Token 估算完全是字符启发式，丢弃 provider 真值

**严重度**：高

**证据**：[tokenCounting.ts:68-86](../../../../packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts#L68-L86) 的 `estimateTokensForText`

**描述**：估算规则 `ASCII × 0.25 + non-ASCII × 1.3`，与真实 tokenizer 在代码、CJK、特殊符号场景下偏差显著。同时 LLM 流式响应每一轮都返回 `tokenUsage`，提供了精确的真值，但**当前实现完全没有消费**。压缩触发时机因此不准。

**违反原则**：可观测信息优先（Use Available Observation）。已经有真值就不该用估算。

**与 lifecycle improve-1 关系**：等价于 PA-C3。

---

### PC-6：压缩 prompt 结构简陋，且无增量更新

**严重度**：中

**证据**：[compression-prompt.ts](../../../../packages/ohbaby-agent/src/core/context/compression-prompt.ts) 仅 5 字段 XML

**描述**：当前摘要结构 `<state_snapshot>` 仅含 `overall_goal / key_knowledge / file_system_state / recent_actions / current_plan` 5 个字段：

- 缺少 Progress 子结构（Done / In Progress / Blocked），LLM 续作时无法快速恢复任务进度。
- 缺少 Decisions 字段，关键设计决策无法沉淀。
- XML 比 Markdown 在 LLM 阅读时更冗长、消耗更多 token。
- 每次压缩都从零生成，长会话中早期信息逐次衰减。

**违反原则**：有损压缩应有界（Bounded Lossy Reduction）。

**与 lifecycle improve-1 关系**：等价于 PA-C4。本轮只升级结构与 prompt，**不实现增量更新**（留 improve-2）。

---

### PC-7：压缩摘要无文件操作追踪

**严重度**：中

**证据**：当前 `summarizeActiveHistory` 完全未触及 tool_calls 的参数。

**描述**：压缩区间内 LLM 执行的 `read_file / write_file / edit_file` 等工具调用，所涉及的文件路径不会沉淀到摘要中。压缩后 LLM 失去对"看过 / 改过哪些文件"的认知，再次需要操作同一文件时往往要重新读取。

**违反原则**：关键状态优先保留（Preserve Operational State）。

**与 lifecycle improve-1 关系**：等价于 PA-C5。

---

### PC-8：compacted 过滤逻辑散落在两个位置

**严重度**：中

**证据**：

- [`getActiveHistory`](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L114-L137) 过滤 `part.time?.compacted === undefined` 的 part。
- [`serializePart`](../../../../packages/ohbaby-agent/src/core/context/serialization.ts#L9-L26) 也对 `part.time?.compacted !== undefined` 返回 `""`。

**描述**：同一条业务规则（"已压缩的 part 不参与上下文"）在两处独立实现，规则演进时容易遗漏其中之一。例如未来想区分"已压缩但允许调试展示" vs "已压缩且彻底排除"，两处都得改。

**违反原则**：DRY、单点变更（Shotgun Surgery）反例。

**与 lifecycle improve-1 关系**：新问题，未在 PA-C 清单中。

---

### PC-9：上下文摘要靠 metadata flag 识别，非一等公民

**严重度**：中

**证据**：

- 摘要存为带 `metadata.kind === "context-summary"` 的合成 part：[context-manager.ts:319-324](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L319-L324)
- 识别靠 `isContextSummary` 扫描 part metadata：[serialization.ts:3-7](../../../../packages/ohbaby-agent/src/core/context/serialization.ts#L3-L7)
- 排序逻辑也耦合 `isContextSummary`：[context-manager.ts:128-136](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L128-L136)

**描述**：摘要在数据模型层面没有独立类型，仅靠 metadata 字段约定。任何模块都可能误判（或被绕过）。`hasSummary` 字段的判定也是 O(N×parts) 扫描。

**违反原则**：领域概念应建模为一等公民（Make Domain Concepts Explicit）。

**与 lifecycle improve-1 关系**：新问题。本轮**不引入新类型**（避免与 message 模块耦合扩散），但通过封装查询函数把识别逻辑集中到一处，为 improve-2 引入一等公民类型铺路。

---

### PC-10：`compact()` 决策分散在三个判断点

**严重度**：中

**证据**：[context-manager.ts:407-435](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L407-L435)

**描述**：当前 `compact()` 依次：

1. 判断 `usageBefore.shouldCompress` → 决定是否进入
2. 必做 `prune()`
3. 判断 `usageAfterPrune.shouldCompress` → 决定是否进入 summarize
4. 调用 `summarizeActiveHistory()`，其内部又判断 `historyToCompress.length <= 2` → 决定是否跳过

四个独立判断分布在不同函数层级，难以从单一入口理解"在什么条件下会做什么"。`force` 参数的语义在不同判断点行为不一致。

**违反原则**：决策内聚（Decision Cohesion）。

**与 lifecycle improve-1 关系**：新问题。修复在 `prepareTurn` 内部完成——所有判断收拢到一个决策函数。

---

### PC-11：阈值规则在大小窗口失衡

**严重度**：中

**证据**：[constants.ts:1](../../../../packages/ohbaby-agent/src/core/context/constants.ts#L1) `COMPRESSION_THRESHOLD = 0.85`

**描述**：单一 `0.85` 比例阈值：

- 在 1M token 大窗口下，85% = 850K tokens，太晚才触发压缩；
- 在 8K 小窗口下，85% = 6.8K tokens，太早触发；
- 用绝对量预留更合理：触发条件改为 `inputBudget - currentTokens < reserveTokens`，其中 `reserveTokens` 为 summary prompt + 响应预留。

**违反原则**：阈值应与单位匹配（Threshold Should Match Unit）。

**与 lifecycle improve-1 关系**：lifecycle improve-1 中作为 PA-C2 的延伸提及，本轮在 context improve-1 中落地。

---

### PC-12：事件粒度粗，缺少必要的可观测信号

**严重度**：低

**证据**：[events.ts:25-40](../../../../packages/ohbaby-agent/src/core/context/events.ts#L25-L40) 仅有 `Compressed` / `Pruned` 两个事件

**描述**：

- 没有 `PrepareTurnStarted / Completed`，外部无法观测每轮 LLM 输入的组装耗时与决策依据。
- 没有 `CompactSkipped`，调用方无法区分"未触发压缩"与"判定不需要压缩"。
- 没有 `CompactStarted`，长压缩操作无法被 UI 显示 progress。

**违反原则**：可观测性（Observability）。

**与 lifecycle improve-1 关系**：新问题。本轮按需新增 1–2 个事件，不全面扩展。

---

### PC-13：Memory 注入与安全扫描逻辑外溢到 adapter 层

**严重度**：中

**证据**：[composition.ts:305-312](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L305-L312) 的 `appendMemoryToSystemPrompt + loadMemoryForPrompt`

**描述**：将 memory 合并入 system prompt、对 memory 内容做安全扫描，本应属于 context 模块"对 LLM 的呈现"职责。当前实现把这一步放在 adapter，导致：

- 任何想要拿到"最终送 LLM 的 system prompt"的调用方都得自己重做合并。
- 安全扫描成为可绕过的步骤。
- 模块边界不清晰：`AssembledContext.systemPrompt` 字段名暗示"已组装好的 system prompt"，但实际并不包含 memory，与字段名不符。
- `core/system-prompt` 与 `core/memory` 都不知道对方存在，二者的产物如何拼接由 adapter 决定——三个模块之间的协作契约靠 adapter 维持。

**违反原则**：高内聚（High Cohesion）、关注点不可绕过（Non-Bypassable Concerns）、模块协作应有显式契约。

**与 lifecycle improve-1 关系**：新问题。修复在 [CP1 的 serializer](./implementation-plan.md#25-序列化路径合并) 中通过将合并逻辑搬入 context 模块完成。`core/system-prompt` 与 `core/memory` 的对外 API 不变。

---

## 五、Pi 的设计哲学借鉴与边界

参考 pi `harness/compaction/` 与 `harness/session/` 的设计，识别**值得借鉴**与**不应照搬**两类。

### 4.1 值得借鉴（本轮采纳）

| Pi 设计 | 借鉴点 | 落地编号 |
|---------|--------|---------|
| 两层 token 估算：provider usage 锚点 + 尾部字符估算 | 精确度跃迁，几乎零额外成本 | 修复 PC-5 |
| `findCutPoint` + `findValidCutPoints` 智能切点 | 切在 user / assistant message 边界，禁止切断 tool 配对 | 修复 PC-4 |
| Split-turn 处理：`turnPrefixMessages` 单独总结 | 让超长 turn 也能安全切断 | 修复 PC-4 |
| Markdown 6 节摘要结构 + Progress 子结构 + Decisions | 摘要质量与 token 效率双提升 | 修复 PC-6 |
| `extractFileOpsFromMessage` 文件操作追踪 | 关键状态保留 | 修复 PC-7 |
| 绝对量 `reserveTokens / keepRecentTokens` 替代比例阈值 | 跨模型 size 一致工作 | 修复 PC-11 |
| 模块对外提供"一次性准备 LLM 输入"的完整契约 | `buildSessionContext` 启发了 `prepareTurn` | 修复 PC-1、PC-3 |

### 4.2 不应照搬（本轮拒绝）

| Pi 设计 | 不照搬的理由 |
|---------|------------|
| 把"compaction"作为外部显式调用 | ohbaby 已有"每轮 prepareTurn 自动决策"的更主动模式，更适合 CLI 长会话 |
| `SessionTreeEntry` 联合类型作为持久化形式 | 需要重做 message 模块；与本轮范围正交，留 improve-2 |
| 增量摘要更新（`UPDATE_SUMMARIZATION_PROMPT`） | 价值依赖"长时间高频 compact"场景，目前缺少观测数据，留 improve-2 |
| Branch summarization（子分支独立摘要） | ohbaby 当前无 branch / fork 概念 |
| `session_before_compact / session_compact` hooks | 当前没有外部消费者，加 hook 会变成死代码；通过 Bus 已足够 |
| `convertToLlm` 多 provider 消息转换层 | 仅在多 provider 接入时才有价值，留 improve-N |
| `AgentMessage` 中间消息类型 | 同上 |

### 4.3 保持 ohbaby 自有优势

| ohbaby 现有优势 | 不被 pi 风格覆盖的理由 |
|----------------|--------------------|
| Prune + Compress 两段式回收 | 比 pi 的单一 compaction 更经济 |
| Part 级 compacted 标记 | 比 entry 级更细，已经隐式覆盖 split-turn |
| `ContextUsage` 富类型 + `tokenCounter.getBudget` 模型级 budget | pi 没有 |
| Bus 事件总线 | pi 的 hook 体系更耦合，Bus 更适合 ohbaby 的 RunWorker 架构 |

---

## 六、根因归纳

上述 13 条问题归并为五条根因：

### RC-1：缺少完整对外用例契约

`compact + assemble + 序列化` 是 context 模块的核心用例，但模块没有提供一次性完成该用例的 API。调用方必须自行编织，导致逻辑外溢（PC-1）、事实源分裂（PC-2）、重复计算（PC-3）。

### RC-2：内部决策分散

压缩判定逻辑分布在 `compact / summarizeActiveHistory / getHistoryToCompress` 三个函数的多个判断点，缺少统一的决策入口（PC-10）。`force` 语义在不同判断点不一致（同 PC-10）。

### RC-3：算法层质量不足

- Token 估算不消费可用真值（PC-5）。
- 切点算法不感知协议约束（PC-4）。
- 摘要结构不足以保留进度与决策（PC-6）。
- 摘要不追踪文件操作（PC-7）。
- 阈值与单位不匹配（PC-11）。

### RC-4：数据模型表达不充分

- 业务规则散落两处（PC-8）。
- 领域概念（context summary）靠 metadata 字段约定，非一等公民（PC-9）。
- 可观测信号不足（PC-12）。

### RC-5：跨模块协作契约由 adapter 编织

context 与 `system-prompt`、`memory` 的产物如何最终合成 LLM 输入，目前完全靠 adapter 层手工编织（PC-13）。三个模块没有显式约定谁负责"最终形态"，导致 memory 注入与安全扫描逻辑外溢、`AssembledContext.systemPrompt` 字段语义与现实不符。

---

## 七、本轮重构目标

按软件工程原理对应根因给出目标。每条目标在 [implementation-plan.md](./implementation-plan.md) 中映射到具体阶段。

### G1：建立 `prepareTurn` 完整对外契约

对应 RC-1。Context 模块对外提供单一入口 `prepareTurn(input) → { messages, usage, compaction? }`，覆盖 "决定本轮 LLM 看什么 + 必要时压缩 + 序列化为 LLM 输入" 的完整用例。adapter 与 lifecycle 不再自行编织。

### G2：内部决策统一收拢

对应 RC-2。压缩判定、prune 判定、序列化判定收拢到单一决策函数，`force` 语义在所有路径一致。

### G3：算法层正确性与质量升级

对应 RC-3。

- Token 估算：provider usage 锚点 + 尾部字符估算。
- 切点：在 user / assistant message 边界对齐，禁止切断 tool 配对，支持 split-turn。
- 阈值：绝对量 `reserveTokens / keepRecentTokens` 替代比例。
- 摘要：Markdown 6 节结构 + Progress 子结构 + Decisions。
- 文件操作追踪：压缩区间内 read / write / edit 路径附加到摘要末尾。

### G4：数据模型微调与可观测性

对应 RC-4。

- compacted 过滤集中到单点（PC-8）。
- summary 识别封装为查询函数，为 improve-2 一等公民铺路（PC-9）。
- 新增 1–2 个必要事件（PC-12），避免预先膨胀。

### G5：与 lifecycle improve-1 接合面一致

`prepareTurn` 返回的 `PreparedTurn.messages` 必须直接可被 LLM Client 消费，不需要二次处理。lifecycle improve-1 的 `runSession` 每轮单次调用即可。

### G6：现有公共方法零破坏

`compact / assemble / prune / getUsage / shouldCompress` 行为与签名保持不变。S1–S6 优势全部保留。改造期所有现有调用方零改动。

### G7：跨模块边界明确化，零对外 API 变更

对应 RC-5。

- context 模块成为 system prompt + memory + history 合成 LLM 输入的**唯一收口**。
- `services/llm-model`、`core/system-prompt`、`core/memory` 三个被依赖模块在本轮**不出现任何公共 API 变更**。
- 新算法（`estimateContextTokens`、memory 注入与安全扫描）的归属严格遵守 [三、跨模块协作面](#三跨模块协作面) 第 3.2 节定义的职责边界：领域感知逻辑在 context，原语在 services，prompt 组装在 system-prompt，文件加载在 memory。

---

## 八、非目标

为防止范围漂移，明确以下事项**不在 improve-1 范围内**：

- 增量摘要更新（incremental summary）
- Session tree / branch / fork 模型
- Branch summarization
- 多 provider 抽象层
- Compaction hooks 公开 API
- Context summary 改为一等公民消息类型
- Memory 模块能力扩展
- `services/llm-model` 公共 API 扩展（如 `MessageWithParts` 感知的估算函数下沉到 services）
- `core/system-prompt` 公共 API 扩展（如 system prompt 内置 memory 注入能力）

---

## 九、后续文档

- 具体改造步骤见 [implementation-plan.md](./implementation-plan.md)
- 验收标准见 [acceptance.md](./acceptance.md)
- 与 lifecycle 的协同关系见 [README.md](./README.md)
