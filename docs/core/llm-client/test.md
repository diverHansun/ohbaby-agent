# llm-client 模块的测试策略

## 当前文档范围

本文件描述的是**当前实现**的测试策略：`createLLMClient()` 依赖 `config/llm` 与 `services/interface-providers`，`streamChatCompletion()` 消费 provider 输出的归一化流事件并构造最终 `StreamingResponse`。

## 测试目标

通过单元和集成测试验证：

1. `createLLMClient()` 正确读取配置并创建对应的 provider client
2. `streamChatCompletion()` 正确累积文本内容与工具调用片段
3. 流结束时 `parsedToolCalls`、`finishReason`、`tokenUsage` 输出正确
4. 请求参数 `model`、`temperature`、`maxTokens`、`tools` 正确交付 provider；wire 参数由 provider contract tests 验证
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
| SDK 能力存在 | provider 单测 | 默认 Chat 使用 `client.chat.completions.create`；显式 `openai-responses` 使用 `client.responses.create` |

### 2. streamChatCompletion() 基本流

| 用例 | 当前状态 | 验证点 |
|------|------|-------|
| 简单文本累积 | 已有测试 | `completeMessage.content` 随 chunk 增长 |
| 工具调用累积与解析 | 已有测试 | `tool_calls[].function.arguments` 拼接正确，最终 `parsedToolCalls` 正确 |
| 空响应占位文本 | 已有测试 | 无文本时返回 `(Empty response)` |
| 配置透传到请求 | 已有测试 | `model`、`temperature`、`maxTokens` 正确交付 provider |
| tools 透传 | 已有测试 | 本地 function tools 原样交付 provider |
| provider wire 参数 | provider contract tests | 默认 Chat 的 `stream_options.include_usage`/cache、Anthropic 参数映射不变；Responses 不发 cache 或 continuation 控制字段 |

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

- 在 provider 边界 mock 对应 SDK stream（默认 Chat 为 `client.chat.completions.create`，显式 Responses 为 `client.responses.create`）返回异步迭代器
- 收集所有 `StreamingResponse`
- 分别校验中间态和最终态，而不只看最后一个响应
- Responses fixture 的 message added 必须是 `in_progress` + `content=[]`；唯一 output_text 由唯一 content-part added 建立，并在 part done/item done/terminal 保持有序一致。

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
当前测试文档必须与 `src/core/llm-client/` 和 `src/services/interface-providers/` 下的真实代码一致。

### 2. 中间态与最终态都要验证
流式接口最容易只验证最终结果，遗漏中间累积逻辑。

### 3. 明确记录已覆盖与待补齐项
测试文档不应把“未来计划测试”写成“当前已有覆盖”。

## 后续重构提示

当前 provider 单测已独立维护在 `docs/services/providers/test.md` 对应的源码测试文件中。llm-client 测试只关注消息累积、完成态构造和中断处理，不重复验证 provider 的协议转换细节。

## 请求空闲保护测试（2026-10-15）

- `idle-watchdog.unit.test.ts`：默认/覆盖阈值、pulse、消费者空档、取消、dispose、迟到异常与输入校验。
- `stream-idle.integration.test.ts`：四个等待点、partial 不重放、取消竞争、opening 在退避期间及 finally 后迟到、next 迟到、慢持久化不污染 first-text/endedAt、建流与首事件分别计时。
- `sdk-retry.integration.test.ts`：安装的三种真实 SDK 配合本地 fetch stub；无归一化输出的原始事件持续续时；挂住的 HTTP body 只按应用层预算重试，无 SDK 隐藏重试。
- `core/lifecycle/failed-history.integration.test.ts`：partial idle 以 APIError 落库，正文保留但不进入后续模型历史或摘要。
- `packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts`：真实 HTTP daemon、SQLite 和 goal driver 的故障链路；付费三协议请求需显式设置 `OHBABY_RUN_IDLE_REAL_E2E=1`，使用 DeepSeek 官方 `deepseek-flash`，凭据 `DEEPSEEK_API_KEY` 只从环境或根 `.env` 读取。三种请求都显式关闭 thinking。使用现有 `vitest.e2e.config.ts` 运行；不依赖浏览器。

本批范围与实际验收结果分别见 [04](../../problem-lists/2026-10-13-goals-upgrade/improve-1/04-test-and-acceptance.md) 和 [05](../../problem-lists/2026-10-13-goals-upgrade/improve-1/05-implementation-acceptance.md)。
