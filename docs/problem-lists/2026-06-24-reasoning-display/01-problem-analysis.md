# 01 · 现有问题分析：reasoning（CoT）链路截断与显示缺失

> 日期：2026-06-24
> 范围：openai-compatible 接口的 reasoning（chain-of-thought，思维链）文本在 CLI / web 端不显示，以及其落盘 / context 处理现状。

## 1. 概念界定

本设计中的 **reasoning** 专指模型通过独立通道返回的**思维链（CoT）文本**，对应 openai-compatible 流式响应里的 `delta.reasoning_content` 或 `delta.reasoning` 字段。

它**不是**以下两者（这两者都属于普通 `content`，本就应进入 context）：

- **中间态消息**：工具调用之间的过渡文字，如「接下来我看看 xx 模块」「下面我还要做…」，后接 tool_calls。
- **终态消息**：一轮结束时较长的总结性回答。

reasoning 的定位（已与需求方确认）：**仅用于（可折叠）实时显示，不落盘，跨轮不进 model context，且对不支持 reasoning 的模型完全无副作用**。

## 2. 现状链路（逐层实测）

| 环节 | 位置 | 现状 |
|---|---|---|
| ① 识别 | [openai-compatible.ts:64-72](../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts) | ✅ 已从 `reasoning_content` / `reasoning` 提取为 `reasoningDelta`，并放入 stream event（[:114](../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts)）。这是先前「不舍弃 reasoning」优化的落点，但**只到 provider 层**。 |
| ② 累积 / 下传 | [streaming.ts:267-275](../../../packages/ohbaby-agent/src/core/llm-client/streaming.ts) | ❌ 纯 reasoning 事件被 `continue` **直接丢弃**：从不累积进 `accumulatedContent`/`completeMessage`，也从不向下游发出。reasoning 在此**彻底断流**。 |
| ③ 建 Part / 落盘 | [lifecycle.ts:811-835](../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) | ❌ 仅从 `completeMessage` 的 text content 建 `text` part，从工具调用建 `tool` part。**从不创建 `reasoning` part**。 |
| ④ 显示层 | web [App.tsx:870](../../../apps/ohbaby-web/src/ui/App.tsx)、CLI [transcript.ts:159](../../../packages/ohbaby-cli/src/tui/store/transcript.ts)、[events.ts:801](../../../packages/ohbaby-cli/src/tui/store/events.ts) | ⚠️ **脚手架已存在但空转**：`ReasoningPart` 类型、web `<pre className="ohb-reasoning">`、CLI transcript 的 `case "reasoning"`、snapshot 的 reasoning 类型、persistent-store 的 reasoning 分支——全部已写好，但因 ② ③ 断流而**永远收不到数据**。 |

**根因结论**：CLI / web 看不到 reasoning，根因**不在显示层缺失**，而在 ②（streaming 丢弃）→ ③（lifecycle 不建 part）这段中间链路把 reasoning 截断了。

## 3. 空转脚手架清单（已写好但当前永不触发）

这些都假设 reasoning 是一个持久化的 `Part`，在本项目当前从未被创建：

- 类型：`ReasoningPart`、`Part` 联合、`CreatePartInput`（[types.ts:94-179](../../../packages/ohbaby-agent/src/core/message/types.ts)）
- 模型消息拼接：[converter.ts:17-19](../../../packages/ohbaby-agent/src/core/message/converter.ts) 对 reasoning 返回 `part.text`
- LLM 序列化：[serializer.ts:150-152](../../../packages/ohbaby-agent/src/core/context/serializer.ts) 把 reasoning 当文本拼接
- 上下文摘要序列化：[serialization.ts:16](../../../packages/ohbaby-agent/src/core/context/serialization.ts)
- UI 状态：[persistent-store.ts:112-113](../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts)
- snapshot：[snapshot.ts:85](../../../packages/ohbaby-sdk/src/snapshot.ts)
- CLI transcript 折叠逻辑：[transcript.ts:138-205](../../../packages/ohbaby-cli/src/tui/store/transcript.ts)

> ⚠️ **潜在隐患**：上述 ④ 中 [converter.ts:17](../../../packages/ohbaby-agent/src/core/message/converter.ts) 与 [serializer.ts:150](../../../packages/ohbaby-agent/src/core/context/serializer.ts) 的现有写法是**「reasoning part → 回灌进 model context」**。若有人简单地「把 reasoning 建成 part」来实现显示，会无意间让历史 reasoning **每轮回灌**，导致 token 暴涨且语义错误。本设计明确规避这条路径（见文档 02）。

## 4. 落盘与 context 现状（回应目标 2）

- **落盘**：当前 reasoning **完全不落盘**——因为 ③ 从不建 reasoning part。`database-store` 按 `JSON + type` 列通用持久化 Part（[database-store.ts:217-224](../../../packages/ohbaby-agent/src/core/message/database-store.ts)），一旦建 reasoning part 就会自动落盘。
- **进 context**：同理，当前 reasoning 不进 context。
- **compaction / prune**：prune 仅针对**已完成的 tool output**（[context-manager.ts:389-399](../../../packages/ohbaby-agent/src/core/context/context-manager.ts)），通过给 part 打 `time.compacted` 标记、`partToContent` 对 compacted part 返回 `""`（[converter.ts:11-13](../../../packages/ohbaby-agent/src/core/message/converter.ts)）实现。当前与 reasoning 无关。

## 5. 关键约束（来自 ohbaby 架构与外部参考）

1. **逐步从 store 重组**：一轮（turn）内可有多步（reasoning → tool → reasoning → … → text）；每步都调 `contextManager.prepareTurn` 从 message store 经 `serializeForLlm` 重新组装请求消息（[lifecycle.ts:348-466](../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts)）。**不在 store 里的数据，默认不会出现在后续步骤的请求中。**
2. **DeepSeek 等需同轮回传**：参考 claude-code [openaiConvertMessages.ts:208-229](/Users/hansun025/Projects/code-cli/claude-code/packages/@ant/model-provider/src/shared/openaiConvertMessages.ts) 明确注释：**DeepSeek thinking 模式 + tool calls 时，必须把 `reasoning_content` 原样回传，否则返回 400**。
3. **跨轮应剥离**：参考 gemini-cli `stripThoughtsFromHistory` / `ensureActiveLoopHasThoughtSignatures`（[geminiChat.ts:1006-1039](/Users/hansun025/Projects/code-cli/gemini-cli/packages/core/src/core/geminiChat.ts)）：**当前活跃 tool 循环内保留 thought 签名，跨轮历史剥离**。
4. **消息类型可携带额外字段**：`ChatCompletionMessage = ChatCompletionMessageParam`（[types.ts:29](../../../packages/ohbaby-agent/src/core/llm-client/types.ts)），可像 claude-code 那样在 assistant 消息上附加 `reasoning_content` 透传给 API；`buildRequestParams` 直接透传 messages（[openai-compatible.ts:74-91](../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts)）。

## 6. 问题清单（供文档 02 逐项解决）

- **P1**：reasoning 在 streaming 层被丢弃，无法到达任何显示通道。
- **P2**：lifecycle 不产出 reasoning 事件，CLI / web 无实时「思考中」反馈。
- **P3**：若按现有脚手架把 reasoning 建成 Part，会错误地落盘并回灌进跨轮 context。
- **P4**：DeepSeek 等模型在 thinking + 工具调用同一轮内若不回传 `reasoning_content` 会 400，需在「不落盘 / 不进跨轮历史」的前提下仍满足同轮回传。
- **P5**：方案须对无 reasoning 的模型完全 no-op（兼容性）。
