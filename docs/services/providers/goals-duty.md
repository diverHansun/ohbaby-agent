# providers 模块的目标与职责

## 当前状态

- 当前已实现，源码位于 `packages/ohbaby-agent/src/services/providers/`
- 当前支持两类 provider：`openai-compatible` 与 `anthropic`
- `createProvider()` 只接收连接级配置：`provider`、`apiKey`、`baseUrl`
- `model`、`temperature`、`maxTokens` 属于单次请求参数，通过 `ProviderRequest` 在调用时传入

## 设计目标

1. **封装厂商协议差异**
   - `core/llm-client` 不再直接处理 OpenAI chunk 或 Anthropic SSE 事件
   - provider 内部同时负责“构造原生请求 + 调用 SDK + 归一化流事件”

2. **提供稳定的流式边界**
   - 对外统一暴露 `ProviderInstance.streamChatCompletion()`
   - 输出统一的 `ProviderStreamEvent`

3. **把连接级配置与调用级参数分离**
   - provider 实例只绑定连接信息
   - 单次请求的模型和采样参数在 `ProviderRequest` 中传递

4. **保留必要的原始协议语义**
   - 共享的 `finishReason` 维持简洁枚举
   - 同时通过 `rawFinishReason` 暴露厂商原始停止原因

## 职责

1. **创建 provider 实例**
   - `createProvider(options)` 根据 `provider` 选择实现
   - 当前 `anthropic` / `claude` 映射到 Anthropic provider，其余值映射到 OpenAI-compatible provider

2. **创建并持有 SDK client**
   - OpenAI-compatible provider 创建 `OpenAI` client
   - Anthropic provider 创建 `Anthropic` client

3. **将统一请求参数转换为厂商原生调用**
   - OpenAI-compatible provider 生成 Chat Completions streaming 请求
   - Anthropic provider 负责 system 提取、messages/tool 格式转换

4. **将厂商原生流事件归一化**
   - 文本增量归一到 `textDelta`
   - 工具调用分片归一到 `toolCallDeltas`
   - usage 归一到统一的 `ProviderTokenUsage`

5. **识别 provider 中断错误**
   - 通过 `isAbortError(error)` 让 `core/llm-client` 能统一处理中断分支

## 非职责

1. **不加载或校验配置文件**
   - `model.json` 的读取和校验仍由 `config/llm` 负责

2. **不累积完整消息**
   - `completeMessage`、`parsedToolCalls`、中断时的部分结果都由 `core/llm-client` 负责

3. **不执行工具调用**
   - provider 只处理 tool schema 和 tool delta，不调用任何业务工具

4. **不做重试、fallback 或业务决策**
   - provider 是协议边界，不是策略层

5. **不做 token 估算**
   - 这里只转发厂商返回的精确 usage
   - 估算逻辑属于 tokenCounting 模块