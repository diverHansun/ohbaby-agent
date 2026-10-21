# providers 模块架构设计

## 位置与入口

源码位于 `packages/ohbaby-llm/src/providers/`：

```text
index.ts                    factory 与公开导出
types.ts                   自有消息、请求、事件和实例合同
openai-compatible.ts        Chat Completions adapter
openai-responses.ts         Responses 请求与 SDK 接线
openai-responses-stream.ts  Responses 流解析
anthropic.ts                Messages adapter
native-state.ts             原生状态及同源投影校验
reasoning.ts                请求推理意图与协议能力
token-usage.ts             真实用量规范化和诊断回调
```

消费者从 `ohbaby-llm` 导入公开符号；包只公开根入口，不提供 provider 子路径 export。它不依赖 agent、sdk 或其他 workspace 包。

## 公共边界

`createInterfaceProvider` 按显式 `interfaceProvider` 静态分发，缺省为 Chat，未知 kind 拒绝。`id` 不决定协议。实例包含 `id`、`kind`、SDK `client`，核心方法为：

```typescript
streamResponse(
  request: InterfaceProviderRequest,
): Promise<AsyncIterable<InterfaceProviderStreamEvent>>;
isAbortError(error: unknown): boolean;
```

原始 SDK 流由 adapter 内部消费。client 层只处理规范化事件，累积正文、推理和工具参数，正常耗尽后构造最终快照与 `modelState`。实例可通过 `streamStart` 声明在调用还是首个 next 启动 IO；默认适配器在调用时启动。

## 协议边界

- Chat adapter 将自有消息和工具转换为 Chat Completions 参数。
- Responses adapter 使用完整输入和 `store: false`，不发送 `previous_response_id`。它保留当前支持的原生 output items，校验流事件序列；缓存策略保持 observe-only。
- Anthropic adapter 提取 system，转换 Messages、tool use/result 和当前支持的原生块。
- 三协议的原生状态通过 `ModelState` 保存。重放必须匹配来源并通过共享投影校验；不支持的输入或损坏的流不能被静默丢弃或伪造成正常完成。

## 与 client 及 agent 的关系

```text
ohbaby-llm/client
  -> InterfaceProviderRequest
  -> provider.streamResponse
  -> SDK 原始流
  -> InterfaceProviderStreamEvent
  -> client 累积与完成校验
  -> agent 接受、保存与工具执行
```

provider 负责 wire 转换、SDK 调用、活动回调和 usage 规范化；client 负责项目重试、空闲保护、请求观测及最终响应。三个 adapter 均显式设置 SDK `maxRetries: 0`，关闭 SDK 内部重试。配置 IO、系统代理、模型探测、UI 能力视图和 token 估算均由 agent 接入，不引入反向依赖。
