# llm-client 模块的目标与职责

## 当前状态

- 当前实现围绕 `createLLMClient()` 与 `streamChatCompletion()` 两个入口展开
- provider 抽象已落地，厂商协议差异由 `services/providers` 负责
- llm-client 当前定位为“provider-aware 的流式执行与累积层”

## 设计目标

1. **向上层提供稳定的流式调用入口**
   - 调用方只关心 messages、tools、signal 和 `StreamingResponse`

2. **对 provider 输出的增量事件做统一累积**
   - 调用方不需要自己拼接文本或工具参数分片

3. **在完成态产出可执行的工具调用参数**
   - 仅在工具参数完整后解析 JSON

4. **在中断时尽量保留结果**
   - 用户主动中断时返回最后一条部分结果，而不是直接抛异常

5. **同时保留共享语义与厂商原始语义**
   - 通过 `finishReason` 输出统一完成原因
   - 通过 `rawFinishReason` 保留 provider 原始值

## 职责

### 1. 创建 provider 绑定的 client 实例

- 调用 `getLLMConfig()` 获取配置
- 调用 `createProvider({ provider, apiKey, baseUrl })`
- 返回 `LLMClientInstance { provider, config }`

### 2. 构造单次流式请求参数

- 从 `llmClient.config` 读取 `model`、`temperature`、`maxTokens`
- 组合 `messages`、可选 `tools` 和 `signal`
- 构造 `ProviderRequest`

### 3. 累积 provider 归一化事件

- 累积 `textDelta`
- 累积 `toolCallDeltas[*].argumentsDelta`
- 持续构造 `completeMessage`

### 4. 在完成态解析工具参数

- 在出现完成信号后对已拼接的 arguments 做 `JSON.parse`
- 输出 `ParsedToolCall[]`

### 5. 处理中断与错误传播

- 用 `provider.isAbortError()` 判断中断错误
- 中断时返回部分结果
- 其他错误原样抛出

## 非职责

1. **不负责配置文件校验**
   - 仍由 `config/llm` 负责

2. **不负责厂商原生协议转换**
   - 原生请求构造和流事件归一化由 `services/providers` 负责

3. **不执行工具调用**
   - 只返回解析后的 tool call 数据

4. **不做 token 估算或预算决策**
   - 仅透传精确 usage

5. **不做 retry、fallback、上下文裁剪等策略**
   - 这些属于更上层的 orchestration 逻辑

## 与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `config/llm` | 依赖 | 提供连接级与默认调用参数 |
| `services/providers` | 依赖 | 创建 provider，并产出归一化流事件 |
| `tokenCounting` | 协作 | 上层可消费 `StreamingResponse.tokenUsage` |
| `agents` / `conversation` | 被依赖 | 通过 llm-client 与模型交互 |
