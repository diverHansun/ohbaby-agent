# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
| --- | --- | --- |
| codex | `code-cli/codex/codex-rs` | 每轮采样循环里的流重试、Responses `response.failed` 分类、默认重试次数 |
| pi | `code-cli/pi/packages` | 会话层自动重试、失败尝试从模型上下文中剔除的方式 |
| DSH | `code-cli/deepseek-harness` · `39163dd30f7` | 步骤重试、失败尝试记录、正常策略的预算 |
| OpenCode | `code-cli/opencode` · `38bd73789a` | 会话 runner 中的重试与助手消息结算 |
| Kimi Code | `code-cli/kimi-code` · `f082f04a0` | 请求策略、步骤重试事件与工具执行边界 |
| ZCode | `code-cli/ZCode` · `fec97590` | 流失败恢复与已接受工具的结算 |

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
| --- | --- | --- | --- |
| codex | 重试放在每轮的采样循环里（`core/src/session/turn.rs` 的 `run_sampling_request`，约 L1979 起）。流出错后交给 `core/src/responses_retry.rs` 的 `handle_response_stream_error` 判断，返回可以重试就重新读取当前历史，再发一次这一步的请求。已完成的条目留在历史中，半截条目不会进入历史 | 和本议题要补的“开始输出后断线，整步重来”是同一件事。子代理跑的也是同一个循环，所以自然覆盖 | **采纳**。ohbaby 在 lifecycle 的步骤循环里做同样的事，复用已有的 `step -= 1; continue` 写法 |
| codex | 默认 `stream_max_retries = 5`（`model-provider-info/src/lib.rs` L74），不区分开始输出前后，用一个计数 | 支撑“共用一个预算”的决定 | **采纳**。ohbaby 已有每步 5 次的默认值，开始输出前后共用 |
| codex | `codex-api/src/sse/responses_error.rs` 的 `parse_failed_response` 读出 `response.failed` 里的 `error.code`。额度不足、策略拦截、`invalid_prompt` 等已知终态错误不重试，`rate_limit_exceeded`、`server_is_overloaded` 按服务端建议的时间等待，其余未知错误码默认可重试。事件里没有错误体时按流错误处理 | ohbaby 当前在处理 `response.failed` 时丢掉错误码 | **调整后采纳**。保留错误码和类型。ohbaby 依 D6 只重试已知临时错误 |
| pi | `coding-agent/src/core/agent-session.ts` 的 `_prepareRetry`（L3938）：失败消息留在原始记录里，用 `_omitRecoveryAttempt`（L1311）从模型上下文中剔除，退避后 `agent.continue()` 重新请求 | 这正是方案 A：界面保留，模型看不到 | **采纳思路**。ohbaby 用已有的“不作为模型材料”机制实现，不另建一套剔除逻辑 |
| pi | 等待重试时保留重试事件，并支持取消 | 等待应随任务停止而结束 | **部分采纳**。复用事件和取消信号，前端呈现稍后决定 |
| DSH | 失败流写成 `assistant/attempt`，由步骤循环接收重试决定。完成的模型响应才进入助手历史和工具执行。正常策略默认 5 次，按已知类别重试 | 构成最接近 ohbaby 的提交边界 | **采纳边界**。复用现有消息及步骤循环。DSH 的部分干净 EOF 默认不重试，ohbaby 按 D7 覆盖已确认的 EOF。[步骤循环](../../../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L547) · [重试策略](../../../../../deepseek-harness/packages/llm/llm/src/retry-policy.ts#L16) · [工具回归](../../../../../deepseek-harness/packages/llm/llm-retry/tests/retry.spec.ts#L318) |
| OpenCode | `packages/core/src/session/runner` 的步骤在未输出时可复用助手消息，已输出后先结算原消息，再用新消息 ID 重试。它会边接收流边调工具，重试前也会结算工具 | 支持同一步保留不同请求和消息记录 | **采纳消息结算思路**。ohbaby 的工具只在完整响应后提交，继续守住这个边界。[重试分支](../../../../../opencode/packages/core/src/session/runner/step.ts#L244) · [更换消息 ID](../../../../../opencode/packages/core/src/session/runner/llm.ts#L337) |
| Kimi Code | 请求策略发出带次数和延迟的 `llm.retrying`。投影先重置当前流，工具调用只来源于成功结果 | 同一步可有多次流尝试，状态和工具提交各有归属 | **采纳事件与提交边界**。后端保存现有事实，方案 A 的历史排除由 ohbaby 处理。[请求策略](../../../../../kimi-code/packages/core/src/llm/policy/policy.ts#L250) · [工具接收](../../../../../kimi-code/packages/core/src/loop/loop-actor.ts#L1426) |
| ZCode | 无工具已接受时标记半截助手输出，再从安全位置重来。已有工具被接受时先结算并保留结果 | 强调重试要尊重已完成的工作 | **采纳失败消息标记思路**。ohbaby 复用现有消息错误类型，工具结果沿用当前提交机制。[半截输出恢复](../../../../../ZCode/apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts#L223) · [工具结算](../../../../../ZCode/apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-coordinator.ts#L206) |

## 3.3 明确不借鉴

| 项目 | 做法 | 不借鉴的原因 |
| --- | --- | --- |
| codex | 开启特性开关后，连接失败时无限次重试 | 子代理有执行时限，无限等待会和时限冲突，问题也更难发现。ohbaby 保持有上限的预算 |
| codex | WebSocket 失败后切换到 HTTPS 传输 | ohbaby 只走 HTTP 流，没有这个场景 |
| pi | 用正则匹配错误文字来判断能否重试（`ai/src/utils/retry.ts` L281） | ohbaby 已经按状态码、错误类型和错误码判断，比匹配文字可靠。缺口 2 要做的是把类型保留下来，不是改成匹配文字 |
| DSH、OpenCode、Kimi Code、ZCode | 各自的插件化策略、额外的重试预算或流中工具恢复机制 | ohbaby 只需要现有步骤循环、每步五次临时故障预算和流后工具提交 |

## 3.4 对 02 方案的影响

- “LLM 层判断能不能重来，lifecycle 负责怎么重来”的分工，来自 codex 的采样循环和 pi 的会话层重试。两者都没有在 HTTP 层重放已经输出过的流。
- 共用每步 5 次的预算，和 codex 的 `stream_max_retries` 一致。
- Responses 参考 codex 的 `parse_failed_response` 保留上游错误码。重试资格参考 DSH 的保守默认，只对已知临时错误重试。
- 方案 A 参考 pi 的 `_omitRecoveryAttempt`：失败的尝试保留在记录里，但不发给模型。
