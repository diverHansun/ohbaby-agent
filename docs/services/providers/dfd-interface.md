# providers 模块的数据流与接口设计

## 上下文与范围

providers 位于 `packages/ohbaby-llm/src/providers/`，介于同包 client 和厂商 SDK 之间。公开入口为 `ohbaby-llm`；配置文件 IO 由 agent 包装层处理，同包配置目录只提供纯合同和校验。

## 创建与请求

```text
已解析、已校验 LLMConfig
  -> createLLMClientFromConfig
  -> createInterfaceProvider({ id, interfaceProvider, apiKey, baseUrl, tokenUsageReporter? })
  -> 显式 kind 分发（缺省 Chat，未知 kind 抛错）
  -> InterfaceProviderInstance

streamResponse(client, ModelMessage[], options)
  -> InterfaceProviderRequest（模型、工具、推理、缓存和取消信号）
  -> provider.streamResponse(request)
  -> Chat / Responses / Anthropic SDK
  -> 原始事件 onActivity
  -> InterfaceProviderStreamEvent
  -> client 中间快照与最终校验
```

工厂同步创建实例，不缓存实例。provider 调用返回规范化事件的异步迭代器；SDK 流解析和协议异常留在 adapter 边界，client 不接触原始 chunk。

## 数据归属

| 数据                               | 创建者      | 消费者             | 边界                                             |
| ---------------------------------- | ----------- | ------------------ | ------------------------------------------------ |
| `CreateInterfaceProviderOptions`   | client 工厂 | providers          | 连接级配置                                       |
| `InterfaceProviderRequest`         | client      | providers          | 单次请求，自有消息与工具类型                     |
| 原生 SDK stream                    | SDK         | adapter 内部       | 不作为共享流接口暴露                             |
| `InterfaceProviderStreamEvent`     | adapter     | client             | 正文、推理、调用片段、终态、usage 和 native 输出 |
| `StreamingResponse` / `ModelState` | client      | agent 或独立消费者 | 正常耗尽后校验并接受                             |
| 用量诊断回调                       | adapter     | 可注入 reporter    | agent 包装层将其接入 logger                      |

## 取消与策略

`isAbortError(error)` 只识别 SDK 错误形态。client 必须结合本地 signal 判断用户取消；无本地依据的 provider abort 是失败。`onActivity` 记录原始流活动，包括没有规范化输出的事件，用于 client 空闲计时。

三个内置 adapter 均设置 SDK `maxRetries: 0`，关闭 SDK 重试。项目层有界重试、工具 JSON 解析和最终快照由 client 处理；provider 不另做项目重试、fallback、工具执行、上下文恢复或持久化。
