# llm-client 模块架构

## 调用关系

```text
config/llm → createLLMClient → provider factory

context 的冻结 PreparedModelRequest / 公开调用者
  → streamResponse(ModelMessage[], ModelToolDefinition[])
  → 当前协议 adapter：Chat / Responses / Anthropic
  → 供应商原生请求与事件
  → InterfaceProviderStreamEvent
  → StreamingResponse（messageSnapshot + 状态、reasoningText、usage）
  → lifecycle / 调用者
```

自有请求类型位于现有 `services/interface-providers/types.ts`；输出快照位于 `core/llm-client/types.ts`。没有新建消息包、通用协议转换器或供应商扩展袋。三个 adapter 直接把同一内部请求投影到各自协议，不经过“先统一转 Chat、再转其他 API”的桥接层。

## 数据与状态归属

- client 持有 provider 实例和已加载配置；直接访问 SDK 时走 `client.provider.client`。
- context 拥有同一步的冻结输入。llm-client 不在旁路重新拼接工具或长期缓存另一份请求。
- 流式累积器拥有当前 attempt 的文本、纯文本 reasoning、按局部 index 关联的工具参数。每次重试新建累积状态，失败 attempt 的 usage/工具片段不混入下一次。
- `messageSnapshot` 是当前累计输出；只有正文和工具片段，不重复保存 role/reasoning。它不是 `ModelMessage`，不能直接写入数据库或 push 回请求历史。
- lifecycle 继续映射到原 Message/Part，下一步由历史 serializer 生成新请求。scheduler 的 `ResolvedToolCall.id`、存储 `ToolPart.callId` 不因 LLM 命名迁移改名。
- 观察用 LifecycleEvent 可以缺少 snapshot。现有 wire complete 无正文，反向桥省略 snapshot；delta 可从 wire content 重建文本快照。观察事件不提供工具执行授权。

## 重试边界

重试属于 llm-client，不是上层统一兜底。默认每步最多重试 5 次，指数退避基准从 500ms 起、基准上限 10s，再乘 0.8–1.2 的抖动系数；供应商 Retry-After 最多采用 60s。具体数值以 `retry.ts` 为准。

只有没有可见内容/工具/结束信号的可重试失败才自动重试。Anthropic 起始 usage-only 帧先保留，不视为已向上游输出。可见输出后失败抛 `ProviderStreamInterruptedError`；用尽重试抛 `ProviderRetryExhaustedError`；非法工具 JSON 保留 `ToolCallParseError`；取消返回 `user_aborted` 的 partial result。不会切换协议或自动执行部分工具。

## 协议与计量边界

`openai-compatible` 仍是默认。Responses 必须显式配置，当前只支持受限 stateless replay、observe-only cache；原生输出状态的严格校验保留在 Responses adapter 中。

`services/llm-model/tokenCounting.ts` 继续负责文本启发式与预算，`core/context/token-estimation.ts` 决定计量材料。improve-3 的私有 `legacy-estimation.ts` 仅临时还原旧计量形状以维持旧数值，不参与发送、不导出为公共转换器。只有未来另批获准替换计量材料并完成回归后，才评估退出这层兼容；不承诺在 improve-4 删除。

provider usage 归一化、context 估值/校准、生命周期跨步聚合和 SQLite usage codec 仍各守原有职责，不因字段更名合并。
