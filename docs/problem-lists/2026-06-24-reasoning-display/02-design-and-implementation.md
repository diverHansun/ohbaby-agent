# 02 · 设计方案：reasoning 后端 / 前端优化 + context 处理策略（方案 B+）

> 日期：2026-06-24
> 依赖：[01-problem-analysis.md](./01-problem-analysis.md)
> 本篇为**设计层**文档（改哪里、为什么、接口长什么样）；步骤化实施计划另行编写。

## 1. 方案选型结论：B+（事件流 + 同轮内保留回传）

经需求方确认，采用 **B+**：

- reasoning **只走实时事件通道**显示，**永不创建持久化 Part**、**永不写 sqlite**。
- 前端：流式中展开显示「思考中」，本轮正式 content 出现 / 本轮完成后**自动折叠**为摘要行；**无开关，默认折叠**。
- context：**跨轮历史不带** reasoning；**仅当前活跃 tool 循环内**、对**带 tool_calls 的 assistant 消息**注入 `reasoning_content`（满足 DeepSeek 等同轮回传要求）。
- 对无 reasoning 的模型：全链路 **no-op**。

### 被否决的备选

- **A（建 Part 落盘 + `partToContent` 返回 ""）**：复用脚手架但违背「不落盘」诉求，且 sqlite 会因 reasoning（通常数倍于终态答案的长度）膨胀。
- **B（纯事件流，完全不回传）**：最简单，但 DeepSeek + 工具会 400。B+ 在 B 之上补「同轮回传」消除该问题。

## 2. 架构与数据流

```
provider(openai-compatible)  reasoning_content/reasoning → reasoningDelta      [已有]
        │
        ▼
llm-client/streaming.ts
  · 累积 accumulatedReasoning
  · 删除「丢弃纯 reasoning delta」的 continue（streaming.ts:267-275）
  · StreamResponse 增加 reasoning 字段（增量 + 累积）
        │
        ▼
lifecycle.ts（单步内）
  ├─(a) yield 新事件 llm:reasoning-delta / llm:reasoning-end（均带 messageId）─► CLI/web 按 messageId 实时渲染→完成后折叠
  └─(b) 写入 turn-local 内存 map: assistantMessageId → reasoningText
        │      （绝不 appendPart，绝不写 sqlite）
        ▼
下一步 contextManager.prepareTurn → serializeForLlm
  · 对「带 tool_calls 的 assistant 消息」从 map 注入 reasoning_content
  · 仅当前活跃循环内；跨轮历史不注入
        │
        ▼
turn 结束 → 清空 turn-local map（reasoning 彻底消失）
```

**两条通道彼此独立**：显示走事件、同轮回传走内存 map；二者都不触碰 sqlite、不进跨轮历史，从而 compaction / prune 天然无需为 reasoning 做任何特判。

## 3. 后端改动点（设计层）

### 3.1 provider 层 — 基本无改
`reasoningDelta` 已就绪（[openai-compatible.ts:64-114](../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts)）。仅需在 `buildRequestParams` 透传消息上可能存在的 `reasoning_content` 字段（OpenAI SDK 会随请求 body 原样发出附加字段，行为对齐 claude-code）。

### 3.2 `InterfaceProviderRequest` 消息类型
允许 assistant 消息携带可选 `reasoning_content`（[types.ts](../../../packages/ohbaby-agent/src/services/interface-providers/types.ts)）。

### 3.3 `llm-client/streaming.ts`
- 新增 `accumulatedReasoning` 累积 `event.reasoningDelta`。
- **删除** [streaming.ts:267-275](../../../packages/ohbaby-agent/src/core/llm-client/streaming.ts) 丢弃纯 reasoning 事件的 `continue`。
- `StreamResponse` 增加：`reasoningDelta?: string`（本次增量，供事件流）与 `reasoning?: string`（累积值，供 end 事件 / 回传）。
- reasoning **不进** `accumulatedContent`、**不进** `completeMessage`（避免被当作正式 content 走 ③ 建 text part）。

### 3.4 `lifecycle.ts`
- **事件**：新增 `llm:reasoning-delta`（含 `messageId`、`delta`、`sessionId`、`step`）与 `llm:reasoning-end`（含 `messageId`、`sessionId`、`step`，标记本步 reasoning 结束，触发前端折叠）。在 `runModelStep` 流式循环里产出。
  - **必须携带 `messageId`（当前 assistant message id）**：前端据此把 reasoning 区块精确归属到对应 assistant 行，而非靠 `sessionId + step` 猜测归属（多步 / 并发场景下后者不可靠）。
- **turn-local map**：在一轮生命周期内维护 `turnReasoning: Map<assistantMessageId, string>`；每步把累积 reasoning 写入对应 assistant message id；**turn 结束（终态 / 中止 / 错误）时清空**。
- reasoning **不调用** `appendPart`。

### 3.5 `context-manager.prepareTurn` + `serializer.ts`
- `PrepareTurnInput` 增加可选入参 `activeReasoningByMessageId?: ReadonlyMap<string,string>`，由 lifecycle 传入当前 turn-local map。
- 透传至 `serializeForLlm` → `serializeAssistantMessage`（[serializer.ts:112-142](../../../packages/ohbaby-agent/src/core/context/serializer.ts)）：当某 assistant 消息**含 `tool_calls`** 且 map 中存在其 reasoning 时，在该消息上附加 `reasoning_content`。
- **沿用 claude-code「无脑透传、不做 provider 探测」策略**：对不识别该字段的模型无害，对 DeepSeek 满足回传要求。
- **跨轮历史不注入**：map 仅含当前 turn 的 message id，历史 turn 的 assistant 消息天然不在 map 中。

### 3.6 现有空转脚手架的处置
`ReasoningPart` 类型及 [converter.ts:17](../../../packages/ohbaby-agent/src/core/message/converter.ts)、[serializer.ts:150](../../../packages/ohbaby-agent/src/core/context/serializer.ts) 等「reasoning part → 文本」分支在 B+ 下永不触发。

**决策（保守）**：保留 `ReasoningPart` 类型定义，但在其声明处加注释标注「当前不创建、保留以备未来落盘需求」；同时**移除** converter（[converter.ts:17-19](../../../packages/ohbaby-agent/src/core/message/converter.ts)）与 serializer（[serializer.ts:150-152](../../../packages/ohbaby-agent/src/core/context/serializer.ts)）中「把 reasoning part 当文本回灌」的分支，以**根除「误把 reasoning 回灌进 context」的隐患**（对应 01 文档 P3）。

## 4. 前端改动点（设计层）

reasoning 不再是 Part，**不能复用**基于 Part 的 transcript/selectors 渲染，改为**消费事件流**。

### 4.1 CLI（[events.ts](../../../packages/ohbaby-cli/src/tui/store/events.ts) / transcript store）
- 监听 `llm:reasoning-delta`：在当前 assistant 行**上方**维护一个临时 reasoning 区块，按 delta 流式追加。
- 收到 `llm:reasoning-end` 或首个正式 `llm:delta`(content) 时：把区块**折叠为单行摘要**（如 `▸ reasoning · N 行（已折叠）`）。
- reasoning 区块属于**纯 live UI 状态**，不写入会被冻结进 scrollback 的持久 transcript；会话重载后不重现（符合 B+）。

### 4.2 web（[App.tsx](../../../apps/ohbaby-web/src/ui/App.tsx) / [selectors.ts](../../../apps/ohbaby-web/src/ui/selectors.ts)）
- 消费同样的事件流（经 server / snapshot 通道，见 4.3），渲染可折叠 `<details className="ohb-reasoning">`：流式中 `open`，`reasoning-end` 后 `collapse`。
- 复用既有 `.ohb-reasoning` 样式骨架。

### 4.3 事件传输通道
- 确认 `llm:reasoning-delta` / `llm:reasoning-end` 能经 **server / SDK snapshot** 通道送达 web（ohbaby-server、ohbaby-sdk 的事件转发）。
- snapshot 重连：reasoning 为 live-only，**不进 snapshot 持久态**；重连后进行中的 turn 可不补发历史 reasoning（可接受）。

## 5. context / 落盘策略（目标 2 的最终答复）

| 维度 | 策略 |
|---|---|
| 落盘 sqlite | **永不写**。`MessageStore` / `database-store` 不涉及 reasoning，sqlite 不膨胀。 |
| 跨轮 context | **不带**。历史 turn 的 reasoning 不在 turn-local map，序列化时不注入。 |
| 同轮活跃循环 | **带**。对含 tool_calls 的 assistant 消息注入 `reasoning_content`（DeepSeek 等兼容）。 |
| compaction / prune | **无需特判**。reasoning 既非 Part 又不进跨轮历史，不在被压缩集合内——直接消解「compact 时还要带入 reasoning 块」的担忧。 |
| 无 reasoning 模型 | **no-op**。无 `reasoning_content` → 无 delta → 无事件、map 空、不注入。 |

## 6. 影响面与不变量

- **不变量 1**：reasoning 不得进入 `accumulatedContent` / `completeMessage` / `text` part（否则会被当正式回答持久化与回灌）。
- **不变量 2**：reasoning 不得产生任何 `appendPart` / sqlite 写入。
- **不变量 3**：跨轮（历史）请求消息中不得出现 reasoning_content。
- **不变量 4**：无 reasoning 输入时，全链路行为与改造前**逐字节一致**。
- **影响包**：`ohbaby-agent`（streaming / lifecycle / context-manager / serializer / provider types）、`ohbaby-cli`（events / transcript store）、`apps/ohbaby-web`（App / selectors）、`ohbaby-server` + `ohbaby-sdk`（事件转发，按需）。
