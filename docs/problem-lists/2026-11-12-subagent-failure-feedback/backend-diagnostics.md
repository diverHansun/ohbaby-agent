# 受控上游诊断字段

实施日期：2026-11-12 至 2026-11-13。基线：`3b36ae05`。

HTTP 状态沿用 SDK / 上游错误的真实状态，不从诊断标签推算。此次真实会话的五条失败均保存了 400；账户并发上限仍是未证实的假设。

## 字段与数据流

- 后端沿用 `providerErrorDetail → ModelRequestObservation.failure → llm.request.failed`，只增加两个可选诊断字段。没有增加数据库列、SDK DTO、配置项或新的错误组件。

| 字段 | 含义与约束 |
| --- | --- |
| `upstreamReason` | 根据每条上游错误 message 的前 4096 字符识别固定提示标签：`concurrency_limit`、`invalid_reasoning_content`、`invalid_tool_request`。未命中则省略。`invalid_reasoning_content` 表示该字段校验不通过，包含缺失、类型不符或不允许携带；不把这些情况都称为“缺失”。标签是诊断线索，不证明实际根因，也不改变重试资格。 |
| `upstreamId` | 用于向上游核查请求的关联 ID。OpenAI/Anthropic SDK 读取其 `requestID`，普通错误读取 `request_id`；只接受有界 `req_` 字母数字串、32 位十六进制串或 UUID。其他形状省略。日志编码时再次校验，拒绝 URL、换行、Bearer 字符串等。 |

上游 ID 保留原值以便核查；本地 operation/run/session/provider/model 等标识继续使用已有指纹规则。上游错误正文、请求正文、工具结果、API key 和 headers 不写入新字段。请求 ID 格式白名单不是对任意文本的通用脱敏器。

日志单事件字段上限从 16 调整为 18，容纳已有失败事件的两个新字段；敏感字段名禁令和逐字段编码仍有效。诊断字段只走 transient failure/log，不进入请求事实或会话消息；`UiRun.error` 沿用既有契约。可选 ID 读取异常不会覆盖原有错误分类。

HTTP 400 仍不会自动重试。未修改并发、调度、接续或退避策略，也没有为了验证猜测而对真实 key 做并发压力测试。

## 审查与验证

两个独立子代理和 Pi `anthropic/claude-opus-5-5`（xhigh）参与复审。依据反例，将 reasoning 标签改为 `invalid_reasoning_content`，工具标签改为 `invalid_tool_request`；并发标签只匹配请求并发，不匹配单条消息的工具调用数量。

回归覆盖 SDK 请求 ID、受控标签、4096 字符截断、非法 ID、可抛异常的属性读取、日志二次编码，以及诊断字段不改变 400 / 429 的重试语义。全仓测试 698 个文件通过、6 个跳过；8156 项通过、17 项跳过。最终修正边界测试后，provider-error 的 17 项再次全部通过。

`upstreamId` 保留原始关联元数据，不是匿名化数据；格式校验不能保证恶意上游伪造的合规字符串不含敏感内容。没有新增任意正文或 headers 的日志通道。新诊断只会在更新并重启服务后记录，不能补回旧失败缺失的信息。
