# llm-client 模块的测试策略

## 当前文档范围

本文件描述的是**当前实现**的测试策略：`createLLMClient()` 依赖 `config/llm` 与 `services/providers`，`streamChatCompletion()` 消费 provider 输出的归一化流事件并构造最终 `StreamingResponse`。

## 测试目标

通过单元和集成测试验证：

1. `createLLMClient()` 正确读取配置并创建 `OpenAI` client
2. `streamChatCompletion()` 正确累积文本内容与工具调用片段
3. 流结束时 `parsedToolCalls`、`finishReason`、`tokenUsage` 输出正确
4. 请求参数 `model`、`temperature`、`max_tokens`、`tools`、`stream_options` 透传正确
5. 配置错误或 API 错误能够按预期传播

## 当前已有测试范围

当前测试文件是 `src/core/llm-client/llm-client.test.ts`，已覆盖以下行为。

### 1. createLLMClient()

| 用例 | 当前状态 | 验证点 |
|------|------|-------|
| 正常加载配置 | 已有测试 | 返回 `client` 与裁剪后的 `config` |
| 不暴露 apiKey | 已有测试 | `client.config` 中不含 `apiKey` |
| 不同 provider/baseUrl 配置 | 已有测试 | `zhipu` 这类 OpenAI-compatible 配置可被绑定 |
| 配置错误传播 | 已有测试 | `getLLMConfig()` 抛错时直接向上抛 |
| SDK 能力存在 | 已有测试 | `client.chat.completions.create` 可用 |

### 2. streamChatCompletion() 基本流

| 用例 | 当前状态 | 验证点 |
|------|------|-------|
| 简单文本累积 | 已有测试 | `completeMessage.content` 随 chunk 增长 |
| 工具调用累积与解析 | 已有测试 | `tool_calls[].function.arguments` 拼接正确，最终 `parsedToolCalls` 正确 |
| 空响应占位文本 | 已有测试 | 无文本时返回 `(Empty response)` |
| 配置透传到请求 | 已有测试 | `model`、`temperature`、`max_tokens` 正确传给 SDK |
| tools 透传 | 已有测试 | `tools` 原样传给 SDK |
| `stream_options.include_usage` | 已有测试 | 请求里包含 usage 统计开关 |

### 3. 模块导出

| 用例 | 当前状态 | 验证点 |
|------|------|-------|
| 导出函数存在 | 已有测试 | `createLLMClient`、`streamChatCompletion` 可导入 |
| ES Module 形态可用 | 已有测试 | 返回的 generator 可被 `for-await-of` 使用 |

## 建议补充的测试

以下用例与当前实现强相关，但还应补上，以避免文档和行为继续漂移。

### 1. 中断场景

| 用例 | 预期 |
|------|------|
| 中途中断抛 `APIUserAbortError` | 返回部分结果，不重新抛异常 |
| 中断且尚无文本 | `completeMessage.content === '(Interrupted)'` |
| 中断时存在未完成 tool_calls | `parsedToolCalls === undefined` |

### 2. 边界情况

| 用例 | 预期 |
|------|------|
| 0 chunk 返回 | 明确当前行为是“不产生任何 yield”还是“补一个最终响应” |
| 单 chunk 同时包含 content 与 finish_reason | 正确生成最终响应 |
| tool_calls JSON 非法 | 在解析阶段抛出明确错误 |
| API 不返回 usage | `tokenUsage` 为 `undefined` |

### 3. 错误传播

| 用例 | 预期 |
|------|------|
| 网络错误 | 原样抛出 |
| 认证错误 | 原样抛出 |
| 非 `APIUserAbortError` 的异常 | 不应被误判为中断 |

## 建议的验证方式

### 1. createLLMClient()

- Mock `getLLMConfig()` 返回不同配置
- 断言 `LLMClientInstance.config` 被正确裁剪与绑定
- 避免在单元测试中发起真实网络请求

### 2. streamChatCompletion()

- Mock `client.chat.completions.create()` 返回异步迭代器
- 收集所有 `StreamingResponse`
- 分别校验中间态和最终态，而不只看最后一个响应

### 3. 参数构造

- 检查 `create()` 的第一个参数是否包含：
  - `model`
  - `temperature`
  - `max_tokens`
  - `stream: true`
  - `stream_options: { include_usage: true }`
  - `tools`（如有）

## 覆盖重点

| 模块部分 | 优先级 | 说明 |
|---------|-------|------|
| `createLLMClient()` | 高 | 配置读取是所有流式调用的入口 |
| `streamChatCompletion()` 主流程 | 高 | 当前模块的核心价值所在 |
| tool_calls 累积与解析 | 高 | 最容易在流式协议改动时出错 |
| 中断处理 | 高 | 用户体验强相关，当前已覆盖部分结果返回 |
| 错误传播 | 中 | 保证调用方能区分中断和真正故障 |

## 维护原则

### 1. 文档必须描述当前真实边界
当前测试文档必须与 `src/core/llm-client/` 和 `src/services/providers/` 下的真实代码一致。

### 2. 中间态与最终态都要验证
流式接口最容易只验证最终结果，遗漏中间累积逻辑。

### 3. 明确记录已覆盖与待补齐项
测试文档不应把“未来计划测试”写成“当前已有覆盖”。

## 后续重构提示

当前 provider 单测已独立维护在 `docs/services/providers/test.md` 对应的源码测试文件中。llm-client 测试只关注消息累积、完成态构造和中断处理，不重复验证 provider 的协议转换细节。
