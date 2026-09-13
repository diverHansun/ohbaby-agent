# 事件、桥接与公开入口暴露调查

> 2026-09-13 只读子代理调查，主代理汇总。根目录下路径均以 `packages/ohbaby-agent/src/` 为前缀，行号为 a18290f3 快照。

## 1. 调查结果

| 路径 / 符号 | 当前事实 | 本轮处置 |
| --- | --- | --- |
| core/llm-client/types.ts:155 StreamingResponse | completeMessage 是 Chat 类型 | 迁移为 messageSnapshot |
| core/llm-client/index.ts:27；index.ts:94 | 导出旧函数/类型并从包根 re-export | 删除旧公开入口，测试发布产物 |
| core/lifecycle/types.ts:167 LifecycleEvent | llm:delta/complete 携带 completeMessage | 同步迁移字段；事件名不变 |
| core/agents/types.ts:53 AgentRunResult/AgentRunEventSource | 间接暴露 LifecycleEvent | 公开 API 清单必须包含此处 |
| core/lifecycle/lifecycle.ts:1004,1028,1087 | 转发模型结果并提取文本 | 只做接口适配，保留工具门槛 |
| runtime/run-manager/types.ts:124 | loop 产生 LifecycleEvent | 类型与 fixture 适配 |
| runtime/run-manager/worker.ts:284 publishLifecycleEvent | 手动投影到 bridge，而非序列化完整 event | 不扩大 wire 载荷，补不变测试 |
| adapters/ui-runtime/stream-bridge-run-event-source.ts:131 | 从 bridge 重建 LifecycleEvent | U4 必须明确缺失快照表达 |
| adapters/ui-runtime/prompt-context.ts:115；services/session/title-generator.ts:123 | 读取 completeMessage.content | 读取新快照 |

## 2. 关键发现：反向桥不是无损模型结果

worker.ts:287 的 delta 只发布 delta/content 等，不传 completeMessage；:407 的 complete 只发 finishReason/tokenUsage 等，不传正文、调用列表或快照。

反向桥 :147 当前构造 assistant content；:203 在 complete 中构造 content=""。这是观察投影占位，不能解释成模型真的输出空字符串。不能在新文档承诺 snapshot/toolCalls 的无损 roundtrip。

建议 U4：真实 StreamingResponse 保持快照必有；仅观察事件允许缺失 snapshot，不伪造完成正文。它会使事件消费者处理缺失值，需要用户拍板；备选是保留明确记录的过渡占位，但语义较差。不建议为此扩充 bridge wire 或新建第二套事件框架。

## 3. SQLite 与 UI

lifecycle.ts:904 创建应用 assistant；:985/993 写 TextPart；:1061/1072 写 finish/usage。message/manager.ts:47 写 store 后发布 MessageEvent。ui-persistent.ts:451 使用 DatabaseMessageStore。所查链路未发现 completeMessage 原样落库；stream-bridge/in-memory.ts:21 是 RingBuffer，不是数据库事件日志。

`packages/ohbaby-sdk/src/events.ts:61` 使用 delta/content；SDK/apps 生产路径未发现直接 completeMessage 消费。保持 SDK UI DTO、wire 和存储 JSON；迁移 ohbaby-agent 的公开 LLM/AgentRun API。这两类公开边界不能混为一谈。

建议复用：manager.unit.test.ts、stream-bridge-run-event-source.unit.test.ts、token-usage-roundtrip.integration.test.ts、runner.unit.test.ts、ui-persistent.integration.test.ts、SDK events.contract.test.ts。
