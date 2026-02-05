# llm-client 模块的数据流与接口设计

## 上下文与范围（Context & Scope）

llm-client 模块与以下模块交互：

- **config 模块**：向 llm-client 提供 LLM 配置信息（model、apiKey、baseUrl 等）
- **上层应用模块**（conversation、agents 等）：从 llm-client 获取 OpenAI 调用能力
- **tokenCounting 模块**：接收 llm-client 返回的 tokenUsage 数据进行额度跟踪

本文档描述的是模块的外部接口和核心数据流，不涉及内部的流式处理实现细节。

## 数据流描述（Data Flow Description）

### 流程 1：客户端创建与初始化

```
config 模块
    ↓ 提供 getLLMConfig()

消费者调用 createLLMClient()
    ↓
llm-client 调用 getLLMConfig() 获取配置
    ├─ provider, model, apiKey, baseUrl
    ├─ temperature, maxTokens
    └─ 验证配置完整性
    ↓
使用配置信息创建 OpenAI SDK 实例
    ↓
返回 LLMClientInstance（包含 SDK 实例和配置）
    ↓
消费者获得配置绑定的客户端
```

**关键特性：**
- 一次性初始化，配置在此时确定
- 若配置加载失败，立即抛异常（Fail Fast）
- 返回的实例将配置与 SDK 绑定，后续无需重复提供

### 流程 2：流式聊天完成请求

```
消费者准备消息列表和可选参数
    ├─ messages: ChatCompletionMessage[]
    ├─ options.signal?: AbortSignal（用户中断控制）
    └─ options.tools?: Tool[]（可选工具定义）
    ↓
消费者调用 streamChatCompletion(llmClient, messages, options)
    ↓
llm-client 使用 llmClient.config 中的参数
    ├─ model, temperature, maxTokens
    └─ 加上消息和工具定义
    ↓
向 OpenAI API 发送 stream 请求
    ↓
OpenAI 返回流式响应（chunks）
```

### 流程 3：流式数据积累与消费

```
OpenAI 流开始
    ↓
[逐个处理 chunks]
    ├─ 累积 content（文本）
    ├─ 累积 tool_calls（函数调用参数片段）
    ├─ 记录 finish_reason 和 tokenUsage（如有）
    └─ 构建当前的完整 completeMessage
    ↓
[每个 chunk 处理完毕]
    ↓
生成 StreamingResponse 并 yield
    ↓
消费者通过 for-await-of 接收响应
    ├─ 可实时读取 completeMessage 显示内容
    ├─ 可检查 isComplete 判断流是否结束
    └─ 流完成时可读取 finishReason 和 tokenUsage
    ↓
[流结束或用户中断]
```

### 流程 4：工具调用参数的积累与解析

```
OpenAI 返回 tool_calls chunks
    ↓
[流进行中]
    ├─ 累积 tool_calls[i].function.arguments（JSON 字符串片段）
    ├─ completeMessage 中的 arguments 为不完整的 JSON 字符串
    └─ parsedToolCalls = undefined（不尝试解析）
    ↓
[流完成，finishReason = 'tool_calls']
    ↓
一次性对所有 tool_calls 的 arguments 执行 JSON.parse
    ↓
生成 ParsedToolCall[] 数组
    └─ 每个 call 的 arguments 已转为对象
    ↓
返回最后一个 StreamingResponse，包含 parsedToolCalls
    ↓
消费者获得完整的、已解析的工具调用
```

### 流程 5：用户中断处理

```
消费者创建 AbortController
    ↓
传递 signal 给 streamChatCompletion(llmClient, messages, { signal })
    ↓
[流进行中]
    ↓
用户调用 controller.abort()
    ↓
OpenAI SDK 抛出 APIUserAbortError
    ↓
llm-client 捕获异常
    ├─ 不重新抛异常
    ├─ 返回已积累的部分 completeMessage
    ├─ 标记 isComplete = true, finishReason = 'length'
    └─ yield 最后一个 StreamingResponse
    ↓
流式调用结束，消费者获得部分结果
    ↓
消费者可决定是否保存部分内容或重试
```

## 接口定义（Interface Definition）

### 接口 1：createLLMClient()
**语义：** 创建并初始化 LLM 客户端实例

```typescript
function createLLMClient(): LLMClientInstance
```

- **输入：** 无（从 config 模块读取配置）
- **输出：** LLMClientInstance（包含 OpenAI 客户端和配置）
- **特性：** 同步，不可重复调用（每次都重新初始化）
- **错误处理：** 配置缺失或无效时抛异常

**使用场景：** 应用初始化时调用一次，或需要刷新配置时重新调用

### 接口 2：streamChatCompletion()
**语义：** 流式调用 OpenAI API 并自动积累消息

```typescript
async function* streamChatCompletion(
  llmClient: LLMClientInstance,
  messages: ChatCompletionMessage[],
  options?: {
    signal?: AbortSignal;
    tools?: ChatCompletionCreateParams['tools'];
  }
): AsyncGenerator<StreamingResponse, void, unknown>
```

- **输入：**
  - llmClient：来自 createLLMClient() 的实例
  - messages：对话消息历史
  - options.signal：可选，用于中断流
  - options.tools：可选，工具定义

- **输出：** AsyncGenerator，每次迭代返回 StreamingResponse

- **特性：**
  - 异步生成器，支持 for-await-of 语法
  - 消费者可随时停止迭代
  - 每次 yield 都提供完整的已积累消息

- **行为保证：**
  - 文本内容逐步积累到 completeMessage.content
  - Tool calls 的 id 和 name 在积累过程中可用
  - Tool calls 的 arguments JSON 字符串在积累，对象在 isComplete 时解析
  - isComplete 为 true 时，finishReason 和 tokenUsage 同时出现

## 数据归属与责任（Data Ownership & Responsibility）

| 数据 | 创建者 | 所有者 | 责任边界 |
|------|--------|--------|---------|
| config 配置 | config 模块 | config 模块 | llm-client 仅读取和使用，不修改 |
| OpenAI 实例 | llm-client | llm-client | llm-client 创建和维护，消费者仅使用 |
| 消息历史 | 消费者 | 消费者 | llm-client 仅读取，不修改或缓存 |
| 工具定义 | 消费者 | 消费者 | llm-client 仅转发给 OpenAI API |
| StreamingResponse | llm-client | 消费者 | llm-client 生成，消费者负责使用 |
| 流的中断 | 消费者 | 消费者 | 消费者通过 AbortSignal 控制 |
| tokenUsage | OpenAI API | 消费者 | llm-client 从 API 提取，消费者决定使用方式 |

**关键原则：**
- llm-client 是"中介"，不拥有配置或业务数据
- 配置的完整生命周期由 config 模块管理
- 消费者保留对流程的完全控制权（可随时中断）

## 禁止的操作

以下操作**不**在本模块的接口范围内：

- 修改 messages 参数或返回的 StreamingResponse 对象
- 缓存、持久化或分享 tokenUsage 数据
- 根据消息内容或 finishReason 进行业务决策
- 管理消息历史的生命周期
- 动态调整 model、temperature、maxTokens（需要重新创建实例）
- 提供模型列表或模型切换接口（由 config 模块提供）
