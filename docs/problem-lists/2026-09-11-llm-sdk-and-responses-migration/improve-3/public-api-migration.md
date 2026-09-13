# improve-3 公开 API 迁移说明

这是临时迁移分支上的源码接口变更，旧公开入口与旧类型直接删除，不保留兼容别名。本轮不发布包、不调整版本号，也不迁移 SQLite。完整替换项和语义以 [唯一字段表](./design/data-model.md#2-唯一替换表) 为准；这里仅说明调用方式，不再维护第二张命名表。

## 调用方要改什么

从根包导入 `ModelMessage`、`ModelToolDefinition` 和 `streamResponse`，工具定义改为扁平结构：

```ts
import {
  createLLMClient,
  streamResponse,
  type ModelMessage,
  type ModelToolDefinition,
} from "ohbaby-agent";

const client = await createLLMClient();
const messages: ModelMessage[] = [
  { role: "system", content: "Keep answers brief." },
  { role: "user", content: "Hello" },
];
const tools: ModelToolDefinition[] = [{
  name: "lookup",
  description: "Look up a value",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
}];
for await (const response of streamResponse(client, messages, { tools })) {
  // 累计正文，不是本次增量；reasoningText 在外层。
  console.log(response.messageSnapshot.content);
}
```

已有内部 ToolDefinition 列表可用 `toModelTools` 转为请求工具定义。`streamChatCompletion`、`toOpenAiTools`、`ChatCompletionMessage`、`ChatFinishReason` 和旧 function-tool 类型不再导出。原 SDK 的 wire 字段名称仍由各自 adapter 使用，不能对 HTTP 请求做同样的全局替换。

## 工具多轮与观察事件

assistant 请求使用完整 `{callId, name, argumentsJson}`；tool 结果使用 `{role:"tool", callId, content}`。`ParsedToolCall.callId` 是 LLM 调用标识，不应借此次迁移改掉 scheduler 的 id 或存储消息 ID。

不要把 `response.messageSnapshot` 直接 push 回 messages。快照可能没有 callId/name，argumentsJson 也可能没收完；其中 index 只是当前流的关联序号。消费完整流并检查既有成功/完成及解析条件后，调用者才显式构造 assistant 请求，去掉 index，保留原始 argumentsJson，再附上匹配 callId 的工具结果。不要用解析后的 arguments 重新 stringify 来代替原始参数文本，也不要自动给非法调用补 ID。

真实 `StreamingResponse` 必有 messageSnapshot；从 UI wire 重建的观察 LifecycleEvent 允许缺失。尤其 complete 通知没有正文，缺快照不能当作模型输出空字符串，不能用来恢复历史或授权工具执行。

## 哪些没变

- system 继续在内部消息序列中；每个 adapter 自己处理实际 API 格式。
- canonical usage 与缓存统计口径不变；仅删除公开 StreamingTokenUsage 的三个蛇形旧别名。历史数据库 usage metadata 的读取兼容仍在。
- Message/Part JSON、数据库 schema、工具执行和权限链不变。
- token 估算继续使用旧口径；新增私有兼容计量 helper 不是公开的 Chat 转换工具。
- 默认仍用 Chat，Responses 仍显式启用、受限 replay、observe-only cache；原生推理状态续接和后续统计工作尚未完成。

本地构建消费者与真实请求验证证据统一见 [04](./04-test-and-acceptance.md) 和实施后的 05。根包类型测试通过不能替代完整迁移验收；本分支仍须等待用户审查后才讨论合入集成分支。
