# providers 模块的目标与职责

## 当前状态

源码位于 `packages/ohbaby-llm/src/providers/`，通过 `ohbaby-llm` 包根入口公开。支持 `openai-compatible`、`openai-responses`、`anthropic` 三种协议。

`createInterfaceProvider({ id, interfaceProvider, apiKey, baseUrl, tokenUsageReporter? })` 创建连接级实例。`interfaceProvider` 缺省为 `openai-compatible`；`id` 是 provider 路由标识，不用于猜测协议。未知 kind 抛错。

## 目标与职责

1. 创建并持有 OpenAI 或 Anthropic SDK client。
2. 将自有 `ModelMessage`、`ModelToolDefinition` 和调用参数转换为厂商 wire 请求；model、temperature、maxTokens、reasoning 等按请求传入。
3. 调用原生流接口，把正文、推理、工具片段、终态和 usage 归一为 `InterfaceProviderStreamEvent`。
4. 保留必要的原始语义，包括 `rawFinishReason` 和各协议 `nativeOutput`；同源 assistant 历史可重放经校验的原生状态。
5. 规范化真实 token usage，必要时通过可注入的 `tokenUsageReporter` 报告诊断；原始流事件到达时调用 `onActivity`，支持 client 空闲保护。
6. 用 `isAbortError` 识别 SDK abort 类型，供 client 结合本地 signal 判断取消或失败。

## 非职责

- 不读取配置文件、环境变量或 agent 配置单例。纯配置类型、校验和 profile 函数在同包 `src/config/`，文件 IO、配置写回和探测在 agent。
- 不累积最终 `StreamingResponse`，不解析最终 `ParsedToolCall[]`，不执行工具；这些分别由同包 client 层和 agent 执行边界负责。
- 不拥有项目层重试、provider fallback、上下文压缩或 session/message/run 持久化。三个 adapter 均用 `maxRetries: 0` 关闭 SDK 重试；有界重试由 client 的项目层管理。
- 不做 token 估算或 UI reasoning 能力展示；这些仍属于 agent `services/llm-model`。本层只处理 provider 返回的真实用量与协议能力。
