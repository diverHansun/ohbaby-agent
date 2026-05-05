# providers 模块架构设计

## 当前状态

providers 已从规划落地为当前实现，源码位于：

```text
packages/ohbaby-agent/src/services/providers/
├── types.ts
├── openai-compatible.ts
├── anthropic.ts
└── index.ts
```

模块不再采用文档早期版本里的 `ProviderAdapter.buildRequest()` / `normalizeChunk()` / `normalizeResponse()` 三件套。当前公开边界更小：

```typescript
interface ProviderInstance<TClient = any> {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  client: TClient;
  streamChatCompletion(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
```

## 架构概览

```text
config/llm
    ↓ 提供 provider/apiKey/baseUrl
core/llm-client.createLLMClient()
    ↓ 调用 createProvider()
services/providers
    ├─ 选择具体 provider
    ├─ 创建 SDK client
    └─ 返回 ProviderInstance

core/llm-client.streamChatCompletion()
    ↓ 构造 ProviderRequest
ProviderInstance.streamChatCompletion(request)
    ↓
具体 provider 内部
    ├─ 转换原生请求
    ├─ 调用 SDK 流接口
    └─ 归一化为 ProviderStreamEvent
```

## 设计要点

### 1. provider 内聚协议细节

与早期规划相比，当前实现把“请求构造、SDK 调用、流事件归一化”都封进 provider 内部。收益是：

- `core/llm-client` 不需要知道 OpenAI chunk 或 Anthropic SSE 的形状
- 每个 provider 的差异只在本文件内部扩散
- 对上层暴露的抽象面更小，测试边界更清晰

### 2. registry 保持静态而简单

`index.ts` 当前只做静态分发：

- `anthropic` / `claude` → Anthropic provider
- 其他 provider id → OpenAI-compatible provider

这比可动态注册的插件式 registry 更简单，也更符合当前项目阶段。

### 3. provider 实例只绑定连接级配置

`createProvider()` 不接收完整 `LLMConfig`，而只接收：

```typescript
interface CreateProviderOptions {
  provider: string;
  apiKey: string;
  baseUrl: string;
}
```

`model`、`temperature`、`maxTokens` 留在 `ProviderRequest` 里按调用传入，避免为模型切换重建 provider。

### 4. 共享 finish reason 保持收敛

当前共享枚举仍然只有：

```typescript
type ProviderFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';
```

当厂商存在额外语义时，例如 Anthropic 的 `pause_turn`，当前实现会：

- 归一化到共享值 `stop`
- 同时通过 `rawFinishReason` 保留原始值

## 当前权衡

1. **输入消息类型仍复用 OpenAI ChatCompletionMessageParam**
   - 这是当前 provider 层的统一消息输入格式
   - 尚未引入完全独立的 provider-neutral message schema

2. **OpenAI-compatible 是默认回退路径**
   - 当前没有显式的“未知 provider id”错误分支
   - 这符合现有配置系统“provider 只是字符串标识”的现实

3. **Anthropic 默认不启用 eager input streaming**
   - 当前实现优先避免默认依赖 beta 行为
   - 如未来需要更细粒度工具参数流，可再引入显式开关