# llm-client 模块架构设计

## 当前状态

当前 llm-client 已从“直接调用 OpenAI SDK”的实现收缩为“配置绑定的 provider-aware 流式执行层”。它仍然只有两个公开入口，但职责边界已经变化：

- `createLLMClient()`：从 `config/llm` 读取配置，并调用 `services/providers.createProvider()` 创建 provider 实例
- `streamChatCompletion()`：面向统一的 `ProviderStreamEvent` 做消息累积、工具参数拼接、完成态输出和中断处理

```text
llm-client Module
├── Client Creation
│   └── createLLMClient()
│       ├─ getLLMConfig()
│       ├─ createProvider({ provider, apiKey, baseUrl })
│       └─ 返回 LLMClientInstance { provider, config }
│
└── Streaming Processing
    └── streamChatCompletion(llmClient, messages, options)
        ├─ 构造 ProviderRequest
        ├─ provider.streamChatCompletion(...)
        ├─ 累积 textDelta / toolCallDeltas
        ├─ 流结束时解析 tool_calls.arguments
        └─ 中断时返回部分结果
```

厂商协议差异现在下沉到 `docs/services/providers/` 对应的源码模块中。

## 设计模式与理由

### 1. AsyncGenerator 持续输出完整状态

- 与 `for await...of` 自然兼容
- 每次 yield 都携带“当前完整消息”，而不是只输出 delta

### 2. provider 边界隔离协议差异

- llm-client 不再直接依赖 OpenAI chunk 或 Anthropic SSE 事件结构
- 上层统一通过 `streamChatCompletion()` 使用 provider-agnostic 行为

### 3. 延迟解析工具调用参数

- `tool_calls.arguments` 仍然按字符串片段累积
- 只有在完成态出现后才 `JSON.parse`

### 4. 中断优先返回部分结果

- 通过 `provider.isAbortError()` 判断中断
- 中断时保留已生成内容，输出最终一条 `StreamingResponse`

### 5. 共享 finish reason + 原始 finish reason 双轨保留

- `finishReason` 维持共享枚举
- `rawFinishReason` 暴露厂商原始值，用于保留 `pause_turn` 这类额外语义

## 模块结构

```text
src/core/llm-client/
├── types.ts
├── client.ts
├── streaming.ts
├── index.ts
└── llm-client.test.ts
```

## 当前权衡

1. **消息输入边界仍复用 OpenAI-compatible message 类型**
   - `messages` 仍使用 `ChatCompletionMessageParam[]`
   - 这让 provider 层可以兼容现有调用方，不必同时重写消息模型

2. **provider 创建只绑定连接级配置**
   - `model`、`temperature`、`maxTokens` 在请求时传入
   - 这允许未来在不重建 provider 的前提下切换模型

3. **llm-client 仍承担完成态构造责任**
   - provider 负责归一化单个流事件
   - `completeMessage`、`parsedToolCalls` 仍由 llm-client 聚合生成

## 演进方向

- 如果未来引入更独立的消息模型，llm-client 可以继续摆脱 `ChatCompletionMessageParam`
- 如果未来需要多 provider 并发或更复杂的 registry，再扩展 `services/providers`
