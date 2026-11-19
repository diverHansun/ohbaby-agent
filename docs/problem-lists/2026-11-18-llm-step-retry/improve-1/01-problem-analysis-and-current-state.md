# 1. 问题基线与当前实施状态

> 时间口径：`main` 分支 `bc0d4cc1`（2026-11-18）。证据来自 2026-11-16 的服务日志、之前的诊断会话，以及本次源码核查。行号是分析时的快照，定位以符号为准。

## 1.1 问题陈述

1. **开始输出后再断线，整轮直接结束。** 只要模型吐出过一个字、一段思考或半截工具参数，之后的网络断开、缺终止事件或空闲超时都不再重试。子代理一轮要请求模型十几次，每次都是几十秒的流，遇上一次网络抖动就失败。
2. **流里返回的服务端错误认不出来。** 三种协议在流中途报“服务器忙”“服务器出错”时，SDK 抛出的错误都没有 HTTP 状态码。重试判断只认状态码和网络错误码，所以这些错误一律不重试。Responses 更糟：`response.failed` 事件被换成一个笼统的 `Error`，连错误码都丢了。
3. **缺终止事件的流处理不一致。** 当前链路可能直接失败，也可能在 Anthropic 空响应只收到 `stop_reason` 时误判成功。
4. **子代理失败后，主代理不知道它还能接着用。** 失败结果里只有一句错误说明，没有提示实例还开着、历史和工具结果都还在。

前三条导致了“一次波动就失败”，第四条让失败后的补救全靠主代理自己去猜。

## 1.2 已确认的分界

```
streamResponse（ohbaby-llm）                   lifecycle（ohbaby-agent）
  决定：能不能重来、还剩多少次、等多久              执行：标记半截消息、等待、重跑这一步
  不重放已经输出过的流（保持不变）                  主会话、子代理、Side Chat 共用
```

详见 [00 §2](./00-discussion.md#2-已确认目标与范围)。

## 1.3 ohbaby-llm 请求层现状

### 1.3.1 目标与职责

[goals-duty.md](../../../core/llm-client/goals-duty.md) 的“重试边界”一节规定：SDK 自带重试全部关闭，项目层默认再重试 5 次，只适用于“尚无正文、推理、工具片段或完成信号”的尝试；出现有效输出后不重放，也“不新增自动续写”。

代码与文档一致。问题是，文档只说了 LLM 层不做什么，没有说上一层由谁来接手。

### 1.3.2 架构与关键链路

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| 重试策略 | `ohbaby-llm/src/client/retry.ts` 的 `DEFAULT_PROVIDER_RETRY_POLICY`（L20） | 每步最多重试 5 次，退避从 500 ms 起，上限 10 s，Retry-After 上限 60 s |
| 能否重试 | `retry.ts` 的 `isRetryableProviderError`（L110） | 只看空闲超时、SDK 连接错误类型、HTTP 状态码（408、429、529、5xx）和网络错误码。**不看上游错误码和错误类型** |
| 开始输出后的拦截 | `ohbaby-llm/src/client/streaming.ts` 的 catch（L779–794） | 有正文、推理、工具片段或完成信号时，直接包成 `ProviderStreamInterruptedError` 抛出，不进入重试判断 |
| 缺终止事件 | `streaming.ts` L662–667 | 抛出 `ProviderStreamInterruptedError(…, "eof")`，在 L762 被原样抛出，**先于**“有没有输出”的判断。所以没有输出的空流也不会重试 |
| 尝试计数 | `streaming.ts` L374 的 `failedAttempts`，L414 的 `attempt` | 每次调用 `streamResponse` 都从 0 开始。上层重新调用，编号会从 1 重新算，预算也会重新算 |

**流内错误的实际形态**（缺口 2 的根因）：

| 协议 | 流内错误 | 到达重试判断时的样子 | 结果 |
| --- | --- | --- | --- |
| OpenAI Responses | SSE `event: error` | SDK 在 `openai/core/streaming.js` 里先拦截，抛出 `APIError`，`status` 为空，`code` 保留 | 不重试 |
| OpenAI Responses | `response.failed` | `ohbaby-llm/src/providers/openai-responses-stream.ts` L929–931 抛出 `new Error("Responses ${event.type}: provider failure")`，`response.error.code` 丢失 | 不重试，日志只剩 `unknown` |
| Anthropic | SSE `error`（如 `overloaded_error`） | SDK 抛出 `APIError`，`status` 为空，`type` 保留 | 不重试。只有 HTTP 层返回 529 才重试 |
| OpenAI 兼容 | 带 `error` 字段的数据块 | SDK 抛出 `APIError`，`status` 为空，`code` / `type` 来自上游 | 不重试 |

**缺终止事件的处理不一致**：

| 协议 | 位置 | 抛出的错误 |
| --- | --- | --- |
| OpenAI 兼容 | `providers/openai-compatible.ts` 的 `ChatNativeAccumulator.finalize`、`streaming.ts` L662 | 有原生推理片段时，适配器可先抛普通 `Error("Incomplete Chat native reasoning stream.")`。没有走到该分支时，由共享层识别 `eof` |
| Anthropic | `providers/anthropic.ts` L609–611 | 有内容块时抛出普通 `Error("Incomplete Anthropic message stream.")`。无内容块时先返回。若已收到带结束原因的 `message_delta`，只缺 `message_stop` 的空响应会被误判为成功 |
| Responses | `openai-responses-stream.ts` L985 的 `check(…, "missing terminal event")` | 普通 `Error`，永远到不了 L662 |

普通 `Error` 在有输出时会被包成 `source` 为空的中断错误，lifecycle 不把它当成“中断”；没有输出时被包成 `ProviderRequestError`，归类为 `unknown`。

### 1.3.3 数据模型

- 请求观测在 `streaming.ts` L837–852 的 `observer.end(...)` 封存。`retryScheduled` 只在 `delayMs` 有值时为 `true`，也就是只有 LLM 层自己安排了重试时才会标记。
- 封存后不可修改。11-11 议题把“已结束的请求不能回填”定为不变量（`ohbaby-sdk/src/contract/execution.ts` 的 `mergeModelRequests`，约 L190）。

lifecycle 收到失败后再决定重来，已经无法回填该请求的 `retryScheduled`。因此在请求封存前记录重试决定。

### 1.3.4 测试

- `docs/core/llm-client/test.md` 列出的重试测试明确断言“已有输出不重放”。现有测试能通过，正是因为它们测的就是当前行为。
- 之前的诊断用两个临时用例确认：带 `server_error` 的 `response.failed`、空流缺终止事件，即使允许 5 次重试，也只请求了 1 次。这两个用例没有入库。

## 1.4 ohbaby-agent lifecycle 现状

### 1.4.1 架构与关键链路

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| 步骤循环 | `ohbaby-agent/src/core/lifecycle/lifecycle.ts` 的 `runTurn`，`for (let step …)` 在 L557 | 每一步开头生成新的 `assistantMessageId`（L609） |
| 步骤失败 | 同文件 L707–732 的 catch | `providerFailure(error)`（L118）有结果就结束整轮，`terminalReason` 为 `provider_stream_interrupted` 或 `provider_retry_exhausted` |
| 重跑一步的先例 | L708 | 输入快照变化时 `step -= 1; continue`，最多 3 次。回到循环开头后会生成新的消息 ID，重新准备上下文 |
| 另一个先例 | L758、L816–823 | 上下文超长时强制压缩，换新的消息 ID 再请求一次 |
| 标记失败消息 | `markAssistantMessageError`（L328–389） | 写入 `finish: "error"`。只有 `source` 为 `transport` 或 `eof` 的中断才记为 `MessageStreamInterruptedError`；空闲超时、流内服务端错误记为 `APIError` |

**工具只在流完整结束后执行。** `parsedToolCalls` 来自 `finalEvent`（L1070–1072），而 `finalEvent` 只在 `response.isComplete` 时设置（L1706–1729）。工具部件和模型状态在 `commitModelStep`（L1101–1114）才写入。所以流中途断开时，没有任何工具被执行过，重跑这一步不会把 Bash 再跑一遍。

**流式过程中只保存两样东西**：正文部件（L1673–1690）和展示用的推理内容（L1630）。

### 1.4.2 失败消息如何进入下一次请求的上下文

`ohbaby-agent/src/core/context/serializer.ts` L57–60 对 `finish === "error"` 的助手消息只调用 `failed-history.ts` 的 `selectFailedHistoryText`（L24–48）：

| 错误名 | 投影结果 |
| --- | --- |
| `MessageStreamInterruptedError`、`MessageOutputLengthError`、`MessageContentFilterError` | 正文前加一行“回答被中断，以下内容可能不完整”，作为纯文本历史 |
| `MessageAbortedError` | 只保留中断说明 |
| `APIError`、`Unknown`、`ProviderAuthError` | 返回 `undefined`，整条消息不进上下文 |

工具调用、原生模型状态和推理内容，对任何失败消息都不投影。

方案 A 需要的“界面保留、模型看不到”，现在**已经有一半**：返回 `undefined` 的分支就是整条剔除。缺的是一个标记，让“已被重试取代的中断消息”也走这个分支。现有的排除手段都不合适：`ignored` 不在 `UpdatePartPatch` 里，只能在创建部件时设置；`time.compacted` 的含义是“已被压缩”，借用会混淆语义。

被剔除消息上挂的系统提醒也会隐藏（`reminder-history.ts` L7–45）。重试重新根据当前状态生成提醒，使用新消息为锚点。用户追加、子代理消息和结果等待处理输入由 `current-run-inputs.ts` 单独记录。请求开始只记录首次尝试，成功后才确认处理，因此原请求失败后这些输入仍可进入下一次请求。

### 1.4.3 prompt cache

缓存键只与会话有关（`ohbaby-llm/src/client/prompt-cache.ts` L193–199），与消息 ID 和步骤无关。失败消息被剔除后，它不会破坏可复用的历史前缀。重试仍会重新准备上下文，待处理输入、提醒和压缩结果都可能改变请求。

### 1.4.4 取消与时限

- `Lifecycle.run` 把调用方的信号和内部控制器合并（L436–439），每一步开头检查是否已取消（L558）。
- 子代理的时限和父代理停止，都通过同一个 `params.signal` 传进来（`agents/subagent-host.ts` L1753、L1875；`agents/deadline.ts`）。子代理单次执行上限 30 分钟（`agents/subagents/limits.ts`）。
- 可中断的等待已有先例：`core/context/context-manager.ts` L1047–1055 用 `node:timers/promises` 的 `setTimeout` 加 `signal`，配合 `nextRetryDelayMs`。

### 1.4.5 请求记录与重试状态

`ohbaby-sdk/src/contract/execution.ts` 的 `projectModelActivity` 按运行和消息读取已有请求事实。目前跨消息 ID 会断开等待链。整步重来会换消息，因此后端先保证同一步的临时故障重试计数连续，并在封存时记录 `retryScheduled`。跨消息的等待投影及界面呈现留到前端实施时决定。

## 1.5 子代理与 Side Chat

### 1.5.1 共用链路（核实结论）

| 调用方 | 链路 |
| --- | --- |
| 主会话 | run manager → `RunWorker` → `lifecycle.run`（`runtime/run-manager/worker.ts` L257） |
| 子代理 | `agents/subagent-host.ts` 的 `runTurn`（L1699）→ 同一个 run manager |
| Side Chat | `adapters/ui-inprocess.ts` L4845 → `agents/service.ts` 的 `startSession` → 同一个 run manager。和主会话唯一的区别是 `promptCacheSessionId` 用主会话的 ID |

唯一单独设置了重试策略的是上下文摘要：`adapters/ui-runtime/prompt-context.ts` L91 设为 `maxRetriesPerStep: 0`，由 `ContextManager` 自己最多请求两次。本议题不改它。

### 1.5.2 子代理失败后的结果

- 失败时保存 `status: "failed"`，但不设置 `closedAt`（`subagent-host.ts` L1972–1981），实例仍可以接收新任务。
- 主代理收到的结果正文由 `agents/subagents/result-artifacts.ts` 的 `identity()`（L29–31）生成，包含 ID、任务、`status: failed` 和错误说明，没有“实例还在、可以继续”的提示。
- `core/agents/runner.ts` L311–312 把 `steps` 和 `toolCalls` 写死为 `0` 和 `[]`，所以结果里拿不到已完成的工具调用次数。

## 1.6 2026-11-16 失败的对应关系

| 时间（台北） | 步骤 | 日志 `kind` | 对应缺口 |
| --- | --- | --- | --- |
| 21:38:38 | 3 | `stream_interrupted` | 记录为流中断，缺少足够的来源字段来确认是否已交付片段、是否为底层网络断线 |
| 21:40:19 | 5 | `stream_interrupted` | 记录为流中断，缺少足够的来源字段来确认是否已交付片段、是否为底层网络断线 |
| 21:40:35 | 7 | `unknown` | 通用 Provider 错误。记录不足以区分上游报错、缺终止事件及其他异常 |

三条记录都是 `attempt: 1`、`retryScheduled: false`，都没有触及 30 分钟时限。

## 1.7 改动影响面（现状视角）

- **ohbaby-llm**：`client/retry.ts`、`client/streaming.ts`、`client/provider-error.ts`、`providers/openai-responses-stream.ts`、`providers/openai-compatible.ts`、`providers/anthropic.ts`。
- **ohbaby-agent**：`core/lifecycle/lifecycle.ts`、`core/context/failed-history.ts`、`core/message` 的错误类型和事件 schema、`agents/subagents/result-artifacts.ts`。
- **后端观测**：沿用已有请求记录和安全日志字段，补充缺终止事件等诊断原因。
- 工具调度、审批、子代理时限及摘要重试维持既有契约。前端呈现与 SDK 等待投影待前端实施时决定。

## 1.8 SWE 原则审视摘要

| 观察 | 判断 | 依据 |
| --- | --- | --- |
| LLM 层“开始输出后不重放”的边界 | 合理，应保留。LLM 层不知道输出有没有显示、有没有被用，在这一层重放会让职责越界 | 信息隐藏，职责单一 |
| 上层没有接手人 | 主要缺口。复杂度没有消失，而是推给了主代理模型去临场判断，结果不可靠 | 复杂度被转移，没有被管理 |
| 重试资格只看状态码 | 对 HTTP 层的错误够用，对流内错误是盲区 | 抽象与实际输入不匹配 |
| 已有 `step -= 1; continue` 和“错误名决定投影”两个机制 | 可以直接复用，不需要新框架 | KISS，复用已有抽象 |
| 如果在 lifecycle 另开一套计数和延迟计算 | 会出现两个重试决策点，预算和编号容易不一致 | DRY 针对的是“同一个决定”，不是相似代码 |

## 1.9 与既有文档的关系

| 文档 | 文档说 | 代码做 | 差距与处理 |
| --- | --- | --- | --- |
| [llm-client 目标与职责](../../../core/llm-client/goals-duty.md) | 出现有效输出后不重放，不新增自动续写 | 一致 | 保留“不重放”；补充 lifecycle 整步重来不算续写，并说明重试资格扩展到流内错误码 |
| [llm-client 架构](../../../core/llm-client/architecture.md) L50–52 | 开始输出后的空闲超时记为 `APIError`，不进入失败历史 | 一致 | 整步重来时改为统一标记 |
| [lifecycle 数据模型](../../../core/lifecycle/data-model.md) L7 | 没有有效输出的内部重试不是新的可信 Step | 一致 | 扩展：被整步重来取代的失败尝试，也不是新的可信 Step |
| [lifecycle 架构](../../../core/lifecycle/architecture.md) L44 | 不新增自动续写 | 一致 | 说明整步重来与续写的区别 |
| [message 数据模型](../../../core/message/data-model.md) L651 | 失败消息的投影规则 | 一致 | 补充被重试取代的中断消息不投影 |
| [模型等待与错误反馈 improve-1](../../2026-11-11-model-waiting-and-error-feedback/README.md) | 本轮不增加部分输出后的自动重放 | — | 那是上一轮的边界，不是长期约束。本议题按 00 D2 有意放宽。`retryScheduled` 请求事实继续复用；等待行跨消息串联和半截回答的呈现，见 §1.4.5 |

## 1.10 真实 API 请求基线

2026-11-18 在 `bc0d4cc1` 上通过 ohbaby 的生产 SDK 和适配器测试。请求只包含固定短文本。每个端点收到三个真实 HTTP 请求，分别验证正常接收、第一段正文后在客户端注入读取异常、第一段正文后在客户端提前结束流。另外一组先在客户端注入一次 503，再向 OpenAI Responses 发送真实请求。

| 协议和真实端点 | 模型 | 正常接收 | 正文后注入读取异常 | 正文后提前结束 |
| --- | --- | --- | --- | --- |
| OpenAI Responses · `api.openai.com/v1/responses` | `gpt-6.1-terra` | HTTP 200，`stop` | HTTP 200 后有部分正文，未重试 | HTTP 200 后有部分正文，未重试 |
| OpenAI 兼容 · `zenmux.ai/api/v1/chat/completions` | `deepseek/deepseek-v4.1-flash` | HTTP 200，`stop` | HTTP 200 后有部分正文，未重试 | HTTP 200 后有部分正文，未重试 |
| Anthropic Messages · `zenmux.ai/api/anthropic/v1/messages` | `deepseek/deepseek-v4.1-flash` | HTTP 200，`stop` | HTTP 200 后有部分正文，未重试 | HTTP 200 后有部分正文，未重试 |

六个中断场景均以 `ProviderStreamInterruptedError` 结束，`source` 未填。两条 OpenAI 链路的异常断开场景都能从 `cause` 链读到 `UND_ERR_SOCKET`，安全诊断也识别了网络码，当前中断分类却没有将其标为 `transport`。先注入 503 的对照组记录两次应用层尝试，第二次向真实端点发出请求并成功结束。合计 **10 次真实请求**，均返回 HTTP 200。

另外两类本地探针用于定位源码。真实本地 HTTP 连接在正文后被销毁时，两条 OpenAI 链路同样产生嵌套的 `UND_ERR_SOCKET`。模拟 Anthropic 空响应只收到 `stop_reason` 时，当前实现返回 `stop`。这些结果验证了改动前的行为。真实端点的故障由客户端主动注入，历史故障的上游原因和新方案的恢复效果仍需分别验证。
