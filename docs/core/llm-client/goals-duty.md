# llm-client 模块的目标与职责

## 设计目标（Design Goals）

1. **提供统一的 OpenAI SDK 调用接口**
   - 简化上层模块与 OpenAI 的交互
   - 整合配置信息，消消费者无需关心 API Key、BaseURL 等

2. **支持流式响应的实时积累**
   - 消费者无需手动从 chunks 重构完整消息
   - 每个迭代都能获得当前的完整累积内容

3. **自动解析工具调用参数**
   - 自动从流中积累 tool call 的部分参数
   - 流完成时自动解析完整的 JSON arguments

4. **支持流式操作的中断控制**
   - 通过 AbortSignal 允许用户优雅地中断流
   - 返回已积累的部分结果供后续使用

## 职责（Duties）

1. **从配置系统获取 LLM 配置**
   - 调用 config 模块提供的 getLLMConfig() 接口
   - 获取 provider、model、apiKey、baseUrl、temperature、maxTokens 等信息

2. **初始化 OpenAI SDK 客户端**
   - 使用配置信息创建 OpenAI 实例
   - 处理初始化失败的错误（如配置缺失）

3. **实现流式聊天完成接口**
   - 调用 OpenAI 的 stream API
   - 使用从配置获取的 model、temperature、maxTokens 等参数

4. **在流传输中实时积累消息**
   - 逐个处理流 chunks
   - 累积文本内容（content）
   - 累积工具调用信息（tool_calls 的 id、name、arguments 片段）

5. **在流完成时提供完整的响应数据**
   - 返回完整的消息对象（completeMessage）
   - 提供已解析的工具调用（parsedToolCalls，JSON 已解析）
   - 提供完成原因（finishReason）
   - 提供 Token 使用统计（tokenUsage）

6. **处理用户中断流的场景**
   - 捕获 AbortSignal 触发的中断
   - 返回中断时已积累的部分结果，而非抛出异常
   - 允许上层模块决定是否保存或重试

## 非职责（Non-Duties）

1. **不管理配置的加载和验证**
   - 配置的加载、解析、验证完全由 config 模块负责
   - llm-client 仅使用配置，不涉及其来源或有效性

2. **不处理消息历史管理**
   - 不负责消息的存储、缓存、持久化
   - 不负责消息历史的截断或清理
   - 不参与对话流程的决策

3. **不执行业务逻辑决策**
   - 不根据工具调用结果进行条件判断
   - 不参与工具调用的执行或调用链管理
   - 不做任何业务层面的过滤或转换

4. **不包装非流式调用**
   - 不提供非流式 chat completion 的包装
   - 消费者需要直接使用 OpenAI SDK 进行非流式调用

5. **不进行 Token 额度检查**
   - 不检查当前 Token 使用是否接近限制
   - Token 管理完全由 tokenCounting 模块负责

6. **不提供模型管理或切换**
   - 不提供模型列表、验证或动态切换接口
   - 模型配置和切换由 config 系统提供

## 与其他模块的依赖关系

### 依赖：config 模块

llm-client 依赖 config 模块提供的配置接口：

```typescript
import { getLLMConfig } from '@/config';

const config = getLLMConfig();
// {
//   provider: string,
//   model: string,
//   apiKey: string,
//   baseUrl: string,
//   temperature: number,
//   maxTokens: number
// }
```

该依赖在 `createLLMClient()` 初始化时发生。配置加载失败会立即抛异常，遵循 Fail Fast 原则。

### 被依赖：上层模块

conversation、agents 等模块通过 llm-client 进行 LLM 交互：

```typescript
const llmClient = createLLMClient();
for await (const response of streamChatCompletion(llmClient, messages)) {
  // 使用 response
}
```

### 协作：tokenCounting 模块

tokenCounting 模块利用 llm-client 返回的 tokenUsage 数据进行 Token 额度跟踪，但 llm-client 不依赖 tokenCounting。

## 设计约束

1. **配置驱动，不重复实现**
   - 不在 llm-client 中硬编码模型、API Key 等信息
   - 完全由 config 模块驱动

2. **流是唯一的对外接口**
   - 仅提供流式调用的 streamChatCompletion()
   - 不提供非流式的包装，减少表面积

3. **部分结果优于异常**
   - 用户中断时返回已有的部分结果
   - 让上层决定是否重用或重试
