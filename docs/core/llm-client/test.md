# llm-client 模块的测试策略

## 测试目标

通过单元和集成测试验证：
1. createLLMClient() 正确初始化 OpenAI 实例和配置
2. streamChatCompletion() 正确处理流式响应
3. 消息内容和工具调用参数的积累逻辑
4. 工具调用 JSON 参数的延迟解析
5. 用户中断时的优雅降级
6. Token 使用统计的正确提取

## 单元测试范围

### 1. createLLMClient() - 客户端初始化

**测试用例：**

| 用例 | 输入 | 预期行为 | 验证点 |
|------|------|--------|-------|
| 正常初始化 | config 模块返回有效配置 | 创建 OpenAI 实例成功 | client 和 config 都存在 |
| 配置缺失 | config 模块无法加载 | 立即抛异常 | 异常信息明确指出缺失字段 |
| 配置无效 | 模型名称为空 | 立即抛异常 | Fail Fast 原则 |
| 多次调用 | 连续调用两次 | 创建两个独立实例 | 实例互不影响 |

**验证方式：**
- Mock config 模块，注入不同的配置响应
- 检查抛异常的消息内容
- 验证返回的 LLMClientInstance 结构

**示例：**
```typescript
it('should create client with valid config', () => {
  // Mock getLLMConfig
  mockGetLLMConfig({
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 4096,
    // ...
  });

  const llmClient = createLLMClient();
  expect(llmClient.client).toBeInstanceOf(OpenAI);
  expect(llmClient.config.model).toBe('gpt-4');
});

it('should throw on missing config', () => {
  mockGetLLMConfig(null);
  expect(() => createLLMClient()).toThrow();
});
```

---

### 2. streamChatCompletion() - 流式调用

**测试用例：**

#### 2.1 基础文本流

| 用例 | 输入 | 预期 | 验证点 |
|------|------|------|-------|
| 简单文本响应 | 用户消息 | 逐步积累文本 | completeMessage.content 逐步更新 |
| 空响应 | 用户消息 | 返回占位符 | 内容为 "(Empty response)" 或类似 |
| 多次迭代 | 流返回 3 个 chunks | 返回 3 个 StreamingResponse | 最后一个的 isComplete = true |

**验证方式：**
- Mock OpenAI 的 stream API，返回预定义 chunks
- 逐次检查每个迭代返回的 completeMessage
- 验证 isComplete 的转移点

#### 2.2 工具调用流

| 用例 | 输入 | 预期 | 验证点 |
|------|------|------|-------|
| 单工具调用 | 带工具定义的请求 | 积累 tool_calls 参数 | completeMessage.tool_calls[0] 包含完整参数 |
| 多工具调用 | 调用多个工具 | 正确分离各工具参数 | tool_calls 数组长度正确 |
| 工具参数解析 | JSON 参数分片到达 | 流完成时 parsedToolCalls 已解析 | arguments 为对象，非 JSON 字符串 |

**验证方式：**
- Mock 返回包含 tool_calls delta 的 chunks
- 检查 parsedToolCalls 仅在 isComplete 时出现
- 验证 JSON.parse 成功（arguments 是对象）

**示例：**
```typescript
it('should accumulate tool call arguments', async () => {
  mockStreamResponse([
    { delta: { tool_calls: [{ index: 0, function: { arguments: '{"' } }] } },
    { delta: { tool_calls: [{ index: 0, function: { arguments: 'key' } }] } },
    { delta: { tool_calls: [{ index: 0, function: { arguments: '": "value"}' } }] },
    { finish_reason: 'tool_calls', usage: {...} }
  ]);

  const responses = [];
  for await (const res of streamChatCompletion(llmClient, messages, { tools })) {
    responses.push(res);
  }

  // During stream: parsedToolCalls should be undefined
  expect(responses[0].parsedToolCalls).toBeUndefined();
  expect(responses[1].parsedToolCalls).toBeUndefined();

  // After complete: parsedToolCalls should be populated
  expect(responses[3].parsedToolCalls).toBeDefined();
  expect(responses[3].parsedToolCalls[0].arguments).toEqual({ key: 'value' });
});
```

#### 2.3 完成信息

| 用例 | 输入 | 预期 | 验证点 |
|------|------|------|-------|
| 正常完成 | finish_reason: 'stop' | finishReason = 'stop' | 对应正确 |
| 工具调用完成 | finish_reason: 'tool_calls' | finishReason = 'tool_calls' | 对应正确 |
| 长度限制 | finish_reason: 'length' | finishReason = 'length' | 对应正确 |
| Token 统计 | 最后 chunk 包含 usage | tokenUsage 被提取 | prompt_tokens、completion_tokens、total_tokens 都有 |

#### 2.4 用户中断处理

| 用例 | 输入 | 预期 | 验证点 |
|------|------|------|-------|
| 正常中断 | AbortController.abort() 触发 | 返回已积累内容 | 不抛异常，completeMessage 有值 |
| 中断时的标记 | 用户中断 | isComplete = true, finishReason = 'length' | 状态标记清晰 |
| 部分工具调用 | 中断时工具调用不完整 | 返回不完整的 tool_calls | 上层可选择使用或重试 |

**验证方式：**
- Mock AbortSignal，在流中途触发
- 检查不抛异常（或捕获后不重新抛）
- 验证返回的内容非空

**示例：**
```typescript
it('should return partial content on user abort', async () => {
  const controller = new AbortController();
  let abortTriggered = false;

  mockStreamResponse([
    { delta: { content: 'Hello' } },
    // Abort will be triggered here
    { delta: { content: ' world' } }, // May not reach
  ]);

  const responses = [];
  for await (const res of streamChatCompletion(llmClient, messages, {
    signal: controller.signal
  })) {
    responses.push(res);
    if (!abortTriggered && res.completeMessage.content.length > 0) {
      controller.abort();
      abortTriggered = true;
    }
  }

  // Should have at least one response with partial content
  expect(responses.length).toBeGreaterThan(0);
  const lastResponse = responses[responses.length - 1];
  expect(lastResponse.isComplete).toBe(true);
  expect(lastResponse.completeMessage.content).toBeTruthy();
});
```

---

### 3. StreamingResponse 数据结构验证

**测试用例：**

| 字段 | 约束 | 验证 |
|------|------|------|
| completeMessage | 始终存在 | 每个响应都有 |
| isComplete | 与 finishReason 对应 | true 时 finishReason 非空 |
| finishReason | 仅在 isComplete 为 true 时 | undefined 或有效值之一 |
| parsedToolCalls | 仅在 isComplete 且工具调用时 | 为 undefined 或 ParsedToolCall[] |
| tokenUsage | 仅在流完成时 | undefined 或包含三个数值字段 |

---

## 集成测试

### 1. 与 config 模块的集成

```typescript
it('should work with real config module', async () => {
  // 使用实际的 config 模块（或接近真实的 mock）
  const llmClient = createLLMClient();

  // 应能成功创建实例
  expect(llmClient.client).toBeDefined();
  expect(llmClient.config.model).toBeDefined();
});
```

### 2. 与 OpenAI SDK 的集成

```typescript
it('should handle OpenAI API errors gracefully', async () => {
  // Mock OpenAI 返回错误
  mockOpenAIError(new APIError('Invalid API key'));

  // 应能正确传播错误
  expect(() => streamChatCompletion(llmClient, messages)).rejects.toThrow(APIError);
});
```

### 3. 实际流式调用（仅在集成测试中）

如果需要测试实际的 OpenAI API 调用，应使用集成测试，并：
- 在 CI/CD 中配置真实的 API Key
- 使用测试账户和低成本模型
- 添加超时控制，防止测试挂起

---

## 测试覆盖要求

| 模块部分 | 最低覆盖率 | 优先级 |
|---------|----------|-------|
| createLLMClient | 90% | 高 |
| streamChatCompletion | 85% | 高 |
| 数据类型转换 | 95% | 中 |
| 错误处理 | 80% | 中 |

---

## 测试维护原则

1. **Mock 配置而非真实 API Key**
   - 所有单元测试应 mock config 模块
   - 避免 CI/CD 中泄露密钥

2. **流式行为的验证**
   - 不仅验证最终结果，也验证中间状态
   - 检查每个迭代的数据变化

3. **边界情况**
   - 空消息列表
   - 超长内容
   - 多工具调用
   - 快速中断（在第一个 chunk 到达前）

4. **性能考虑**
   - 流处理不应有显著延迟
   - 避免内存泄漏（及时释放积累的数据）
