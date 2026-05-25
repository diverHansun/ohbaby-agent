# lifecycle improve-1 问题分析

本文档分析 `core/lifecycle/` 模块在当前实现中暴露的架构性问题，并明确本轮重构的目标。本文档只回答"为什么需要改"，不涉及具体改动方案；具体方案见 [implementation-plan.md](./implementation-plan.md)。

---

## 一、分析对象与范围

| 对象 | 路径 |
|------|------|
| Lifecycle 引擎 | [packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) |
| Lifecycle 类型 | [packages/ohbaby-agent/src/core/lifecycle/types.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/types.ts) |
| Context 管理 | [packages/ohbaby-agent/src/core/context/context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts) |
| Context 类型 | [packages/ohbaby-agent/src/core/context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) |
| 当前编排层 | [packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) |

参考材料：[D:\Projects\agent-components\harness\analysis-pi-vs-ohbaby.md](file:///D:/Projects/agent-components/harness/analysis-pi-vs-ohbaby.md)。

---

## 二、当前数据流速写

当前一次用户请求的实际流转：

```
用户输入
  -> composition.buildSessionPromptMessages():
       (1) contextManager.compact(sessionId)
       (2) contextManager.assemble(sessionId)
       (3) 序列化为 ChatCompletionMessage[]
  -> Lifecycle.run({ messages, sessionId, ... }):
       (1) const conversationMessages = [...params.messages]   // 拷贝一份
       (2) for step in 1..maxSteps:
             - streamChatCompletion(conversationMessages)
             - messageManager.createMessage(assistant)         // 写持久层
             - toolScheduler.executeBatch(...)
             - conversationMessages.push(assistant + toolResults)
       (3) 循环结束返回 LifecycleResult
```

存在两条同时维护的会话状态：

- **A 路：`Lifecycle.conversationMessages`** —— loop 内 LLM 实际看到的消息数组，仅 loop 生命周期存在。
- **B 路：`MessageManager` 持久化的消息树** —— `part.time.compacted` 标记、`assemble()` 读取的事实源。

A 和 B 在每一步都需要手动保持同步，且 A 在 loop 结束后被丢弃。

---

## 三、关键问题清单

每条问题给出稳定编号、严重度、定位证据、违反的软件工程原理。

### PA-L1：Lifecycle 持有"会话副本"，与 message 模块形成双事实源

**严重度**：高

**证据**：[lifecycle.ts:279](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L279)、[lifecycle.ts:421-427](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L421-L427)

**描述**：`conversationMessages` 是 Lifecycle 内部的可变数组，与 `MessageManager` 持久化的事实源并行存在。每一轮生成的 assistant 消息和 tool 结果都要同时写入 A、B 两路。

**违反原则**：单一事实源（Single Source of Truth）。两条状态需要手动同步，任何同步遗漏都会导致 LLM 视角与持久化视角分歧。

---

### PA-L2：Lifecycle 直接构造 LLM 协议消息，越权进入 context 的呈现职责

**严重度**：高

**证据**：[lifecycle.ts:140-214](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L140-L214)（`toAssistantToolMessage`、`toolResultToMessage`、`toolResultToContent`）

**描述**：Lifecycle 直接产出 `ChatCompletionAssistantMessageParam`、`ChatCompletionToolMessageParam` 等 LLM 协议结构。"如何把会话状态呈现给 LLM" 本应是 context 模块的职责，目前被 Lifecycle 重复实现。

**违反原则**：关注点分离（Separation of Concerns）、单一职责（SRP）。

---

### PA-L3：Lifecycle 紧耦合 OpenAI 协议

**严重度**：高

**证据**：[lifecycle.ts:1-5](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L1-L5)、[types.ts:1-8](../../../../packages/ohbaby-agent/src/core/lifecycle/types.ts#L1-L8)

**描述**：模块直接 import 并使用 `openai/resources/chat/completions/completions` 的类型。一旦未来接入 Anthropic / Google 等 provider，Lifecycle 与 context 都要改。

**违反原则**：依赖倒置（DIP）。高层编排不该依赖具体 provider 协议。

---

### PA-L4：循环内无法响应外部状态变化

**严重度**：高

**证据**：[lifecycle.ts:287-457](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L287-L457) 的整段 for 循环

**描述**：

- 用户在 loop 进行中追加输入，loop 无法感知（因为读的是局部数组）。
- 上下文增长接近窗口上限，loop 不会主动触发压缩。
- 模型 / 工具 / 系统提示需要在某轮中途切换，没有任何注入点。

**违反原则**：开放封闭（OCP）。循环行为被硬编码，扩展只能通过修改 loop 本身。

---

### PA-L5：固定 `maxSteps=8` 是唯一终止条件

**严重度**：中

**证据**：[lifecycle.ts:30](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L30)、[lifecycle.ts:449-457](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L449-L457)

**描述**：除 `abortSignal` 与硬上限步数外，没有"基于动态条件优雅终止"的接口。8 步达到即返回 error，语义粗糙。

**违反原则**：策略与机制分离（Mechanism vs. Policy）。终止策略应可注入。

---

### PA-L6：类外壳无内部状态

**严重度**：低

**证据**：[lifecycle.ts:268-273](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#L268-L273)

**描述**：`Lifecycle` 类仅持有 `deps`，所有方法逻辑无关实例字段。等价于一个纯函数加几个辅助函数。class 形式制造了不必要的实例化成本与测试样板。

**违反原则**：最小复杂度（KISS）。

---

### PA-C1：`compact()` 重复 assemble，浪费 IO 与 CPU

**严重度**：高

**证据**：[context-manager.ts:391-457](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L391-L457)

**描述**：一次 `compact()` 会调用 `assemble()` 三次（before / afterPrune / afterCompression），每次都重新拉取 history、重新加载 memory、重新序列化。在长会话中显著放大开销。

**违反原则**：组合优于重复（DRY 的具体体现）。

---

### PA-C2：压缩切点不感知 turn 边界

**严重度**：高

**证据**：[context-manager.ts:82-112](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts#L82-L112)

**描述**：`getHistoryToCompress` 按 token 比例从末尾累加，完全可能将切点落在 `tool_calls` 与对应 `tool` 结果之间。下一轮 LLM 看到孤立的 tool 结果，没有对应的 tool call，会拒绝继续或行为退化。

**违反原则**：协议正确性。LLM 协议要求 tool_calls 与 tool 结果配对出现。

---

### PA-C3：Token 估算未利用 provider 真值

**严重度**：高

**证据**：[tokenCounting.ts:68-86](../../../../packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts#L68-L86)

**描述**：估算完全是字符启发式（ASCII 0.25 + non-ASCII 1.3），不消费 `tokenUsage`。代码、CJK、特殊符号场景下与真实 token 数差异显著。压缩触发时机因此不准。

**违反原则**：可观测信息优先（Use Available Data）。provider 已返回真值，不应被丢弃。

---

### PA-C4：压缩 prompt 过于简略，且不支持增量更新

**严重度**：中

**证据**：[compression-prompt.ts](../../../../packages/ohbaby-agent/src/core/context/compression-prompt.ts) 的 5 字段 XML

**描述**：摘要结构没有 Progress 子结构（Done / In Progress / Blocked）、没有 Decisions、没有 Next Steps，对延续工作的指导有限。每次压缩都从零重生成，长会话信息逐次衰减。

**违反原则**：信息保留（Lossy Reduction Should Be Bounded）。

---

### PA-C5：压缩摘要无文件操作追踪

**严重度**：中

**证据**：缺失

**描述**：压缩区间内的 read / write / edit 工具调用涉及的文件路径不会沉淀到摘要中。压缩后 LLM 失去对"之前看过 / 改过哪些文件"的认知。

**违反原则**：关键状态优先保留。

---

### PA-C6：`compact()` 与 `assemble()` 是分离动作，编排逻辑外溢

**严重度**：高（架构性）

**证据**：[composition.ts: 277-318](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L277-L318)

**描述**：当前由 adapter 层依次调用 `compact()`、`assemble()`，再序列化为 LLM 输入。"准备一轮 LLM 输入" 这件事在 context 模块没有对外契约，编排逻辑下沉到 adapter，意味着每个调用方都要复制这套流程。

**违反原则**：封装（Encapsulation）。模块的核心用例应当对外提供完整契约，而不是要求调用方组装内部步骤。

---

## 四、根因归纳

上述问题可归为两条根因：

### RC-1：模块边界错位

`core/lifecycle/` 和 `core/context/` 在概念上是平级模块，但实际数据所有权混乱：

- "LLM 看到什么" 是 context 的呈现职责，被 Lifecycle 重做了一份（PA-L1、PA-L2）。
- "准备一轮 LLM 输入" 是 context 模块的核心用例，目前没有公开 API，逻辑外溢到 adapter（PA-C6）。

### RC-2：Lifecycle 把自己当成了状态持有者

Lifecycle 在概念上是"turn 循环编排器"，本应是无状态函数。当前实现把它做成了"携带 conversation 副本的有状态对象"，导致：

- 外部状态（用户输入、token 增长、模型切换）无法在 loop 内被感知（PA-L4）。
- 终止策略硬编码（PA-L5）。
- class 外壳无意义（PA-L6）。

---

## 五、本轮重构目标

按软件工程原理，对应根因给出目标。每条目标在 [implementation-plan.md](./implementation-plan.md) 中映射到具体阶段。

### G1：数据所有权归位

`message/` 模块成为会话状态的唯一事实源；`context/` 模块成为"对 LLM 的呈现层"；`lifecycle/` 模块成为"无状态 turn 编排器"。Lifecycle 不再持有 conversation 副本，不再构造 LLM 协议消息。

对应：PA-L1、PA-L2、RC-1。

### G2：Context 模块对外提供 `prepareTurn` 契约

将"决定本轮 LLM 看什么 + 必要时压缩 + 序列化"封装为 context 模块的单一对外用例。adapter 层不再编织 `compact + assemble`。

对应：PA-C1、PA-C6、RC-1。

### G3：Lifecycle 改为按轮询问 context 的纯编排循环

每轮 LLM 调用前调用 `context.prepareTurn`，每轮的 assistant / tool 结果直接落入 `message/`，不维护局部副本。借此自动获得：

- 用户中途追加输入立即生效（写入 message → 下一轮自动读到）
- 中途上下文超限自动压缩（prepareTurn 内部决策）
- 不需要引入额外的 steering / followUp 队列

对应：PA-L4、RC-2。

### G4：Lifecycle 引入可注入的终止与拦截策略

为 `shouldStopAfterTurn`、`beforeToolCall`、`afterToolCall` 等关键决策点提供注入接口，但仅在有消费者的前提下引入，不预先制造空 hook。

对应：PA-L5。

### G5：压缩内部算法的正确性与质量

- Token 估算引入 provider usage 锚点（PA-C3）
- 切点感知 turn 边界与 tool 配对（PA-C2）
- 摘要结构升级与文件操作追踪（PA-C4、PA-C5）

这些算法层修复与 G1–G4 的架构归位相互独立，但放在同一轮交付以减少回归窗口。

### G6：向后兼容

Lifecycle 现有调用方（RunWorker、单测、子 agent 流程）在重构期间无须改动即可继续工作。新旧入口共存，旧入口在迁移完成后再删除。

对应：约束所有上述目标的落地方式。

---

## 六、非目标

为防止范围漂移，明确以下事项**不在 improve-1 范围内**：

- 多 provider 抽象（Anthropic / Google）。本轮仍维持 OpenAI 协议，但通过模块边界归位让未来引入 provider 抽象的代价显著下降。
- Session tree / branch / fork 模型。
- 子 agent 调度策略。
- ToolScheduler 内部 wave 机制改造。
- Memory 模块的能力扩展。

---

## 七、后续文档

- 具体改造步骤见 [implementation-plan.md](./implementation-plan.md)
- 验收标准见 [acceptance.md](./acceptance.md)
