# 本机 Magpie 提供了什么证据

2026-11-24 使用本机 `127.0.0.1:3425` 抽查，OpenAI 与 Anthropic 两种认证头都能读取同一目录，均返回 273 个条目。以下为当时的样本，实施验收时重新读取。

| 完整模型 ID | `reasoning_levels` 中的名称 |
| --- | --- |
| `auto/gemini-4-carbon` | low, medium, high |
| `auto/gemini-4-neon` | low, medium, high, xhigh |
| `auto/deepseek-v4.1-flash` | low, high, max |
| `auto/claude-sonnet-5` | low, medium, high, xhigh, max |
| `auto/gpt-6.1-sol` | low, medium, high, xhigh, max, ultra |

每个样本的 `supported_reasoning_levels` 另以 `[{"effort":"low"}, …]` 表达相同集合。Magpie 的 `modelObject` 从同一组模型属性构造两种输出。Chat 的输入处理会接受合法档位，并将不认识的名字归一化为空。这解释了已观察到的非法值 HTTP 200。[Magpie 目录实现](https://github.com/yetone/magpie/blob/v0.1.4758/internal/gateway/gateway.go#L1599-L1615) · [Magpie Chat 参数解析](https://github.com/yetone/magpie/blob/v0.1.4758/internal/gateway/chat.go#L84-L101) · [档位名称归一化](https://github.com/yetone/magpie/blob/v0.1.4758/internal/gateway/ir.go#L1113-L1130)

产品实现只依赖字段形状和所选协议。并用与 Magpie 无关的 URL、provider 与模型名验证这个约束。记录真实网关结果时区分客户端入口与网关实际选择的供应商；`auto/` 的后者可以变化。

## ultra 的直连对照

当日目录有 29 个条目列出 ultra。20:13 对 `auto/gpt-6.1-sol` 同时从 Chat、Responses、Anthropic 入口发送 ultra，均带一个函数工具定义并请求流式计算 17 + 4。三者均以 HTTP 200 正常结束，答案都是 21。按返回 ID 与网关用量逐条对应，三条记录均为 max；Responses 的 `response.completed.response.reasoning.effort` 也回报 max。该结果确认网关接受了 ultra 拼写，并报告了 max；不能从答对算术推断模型内部计算强度。

对照当前 ohbaby 的正式 Responses provider：给精确 profile 注入含 ultra 的完整能力，调用 `resolveRequestReasoning` 得到 ultra，再调用 `streamResponse`，结果为 `Responses request: unsupported Responses reasoning effort ultra`，观察到零次 fetch。阻断点位于 ohbaby 构造 SDK 请求时的本地枚举。修复目标与验收证据见 [02](02-optimization-plan-and-change-scope.md) 和 [04](04-test-and-acceptance.md)。

另用项目已安装的 OpenAI 与 Anthropic SDK 注入本地记录用 fetch，直接调用三个 SDK 入口。三者均把 ultra 原样交给 fetch。这个无网络对照说明现有 SDK 可以承载扩展字符串，实施可以保留现有客户端。
