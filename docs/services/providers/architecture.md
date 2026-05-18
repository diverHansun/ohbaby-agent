# providers 模块架构设计

## 当前状态

`services/providers` 是 LLM 厂商适配层，源码位于：

```text
packages/ohbaby-agent/src/services/providers/
├── types.ts
├── openai-compatible.ts
├── anthropic.ts
└── index.ts
```

当前已实现 OpenAI-compatible 与 Anthropic 两类 provider。registry 保持静态分发：Anthropic provider id 进入 Anthropic adapter，其余 provider id 走 OpenAI-compatible adapter。

## 公共边界

```typescript
interface ProviderInstance<TClient = unknown> {
  id: string;
  kind: "openai-compatible" | "anthropic";
  client: TClient;
  streamChatCompletion(
    request: ProviderRequest,
  ): Promise<AsyncIterable<ProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
```

provider 层负责把不同厂商协议归一化到 `ProviderStreamEvent`，让 `core/llm-client` 不直接接触 OpenAI chunk、Anthropic SSE 或 SDK 特定错误类型。

## 职责边界

providers 负责：

- 创建并持有厂商 SDK/API client。
- 将统一 `ProviderRequest` 转换为厂商原生请求。
- 调用厂商流式接口。
- 将原生 chunk/SSE 归一化成 `ProviderStreamEvent`。
- 暴露 `isAbortError()`，让 llm-client 统一处理中断。

providers 不负责：

- 不累积完整 assistant message。
- 不解析最终 `parsedToolCalls`。
- 不执行工具。
- 不读取 session/message/run 状态。
- 不做 retry/fallback 策略。
- 不做 token 估算或上下文压缩。

## 与 llm-client 的关系

```text
core/llm-client
  -> ProviderRequest
  -> ProviderInstance.streamChatCompletion()
  -> ProviderStreamEvent
  -> core/llm-client 聚合完成态
```

`completeMessage`、`parsedToolCalls`、partial response 都由 `core/llm-client` 生成。provider 只翻译厂商事件。

## 与 llm-model 的关系

`services/llm-model` 是平行的本地模型辅助模块，只处理模型元数据和 token 估算。providers 不依赖 llm-model，也不根据 token 估算改变请求。

provider 返回的真实 usage 通过归一化事件进入 llm-client；它属于真实 provider usage，不属于 `services/llm-model` 的估算 token。

## 设计取舍

1. OpenAI-compatible 是默认回退路径，符合当前配置系统中 provider 是字符串标识的现实。
2. Anthropic 默认不启用 eager input streaming，避免 MVP 依赖 beta 行为。
3. `model`、`temperature`、`maxTokens` 保留在 `ProviderRequest`，provider 实例只绑定连接级配置。
