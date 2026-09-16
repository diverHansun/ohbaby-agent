# 03：参考项目与采用边界

本次研究的是本地源码快照，不代表项目的最新版本。参考项目用于发现管理遗漏；是否采用，以用户在 [00](./00-discussion.md) 的决定和本项目现有机制为准。实施合同统一写在 [02](./02-optimization-plan-and-change-scope.md)，本文不另定策略。

## 3.1 调研版本与结论

源码根目录为 `/Users/hansun025/Projects/code-cli/`。

| 项目                      | 本地 HEAD    | 值得借鉴                                                                     | 本轮不采用                                                                    |
| ------------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| pi                        | `57cde8690`  | 请求/消息/运行分别结束；错误回复可落盘但发送历史另作选择；工具错误返回模型   | 关闭 SDK 后重建重试；已有输出后自动重试；模型输出截断且含工具调用后的自动继续 |
| kimi-code                 | `19c5aa64e`  | 流式展示与可恢复历史分开；可靠终态正文与半截输出分开；取消时收尾工具结果     | 丢弃所有断流正文；中途断流无条件自动重试                                      |
| deepseek-harness          | `47f943859b` | 原始事件和可发送消息分层；明确工具业务错误与调度故障；按调用 ID 保存结果     | 复制完整事件架构；没有输出门槛的重试策略                                      |
| codex                     | `5c19155cbd` | 已完成事实进入历史；取消后保留事实说明及配对结果；请求完成不等于整个任务完成 | 流式工具提前执行、逐 output item 提交等大范围架构；已有输出后的流重试         |
| claude-code（本地改写版） | `987e5503`   | 观察工具取消与父运行生命周期如何分开；检查 fallback 与重复工具的风险         | 把它当官方源码；复制 SDK 关闭、截断自动续写或特定工具失败取消兄弟工具         |

本地 `claude-code/AGENTS.md` 明确说明其为逆向、反编译后修改的版本，含桩实现。以下引用只证明这个快照的行为，不用于声称官方 Claude Code 的设计或当前产品行为。

## 3.2 pi：保存与发送是两件事

入口：

- `pi/packages/agent/src/types.ts`：`message_end`、`turn_end`、`agent_end` 各有职责，agent_end 本身不是成功证明。
- `pi/packages/agent/src/agent-loop.ts`：等待最终 response 后结束消息；错误/取消退出当前步骤；工具错误结果保留调用 ID。
- `pi/packages/coding-agent/src/core/agent-session.ts`：错误消息仍进入会话记录；重试另有会话管理。
- `pi/packages/ai/src/api/transform-messages.ts`：发送时跳过 error/aborted assistant。
- `pi/packages/ai/src/api/openai-responses.ts`、`pi/packages/ai/src/utils/provider-retry.ts`、`pi/packages/ai/src/utils/retry.ts`：SDK 与自定义重试的分工。

**采用**：不要为了让下一次请求合法，就删除用户已经看到的失败回复。持久化保留事实，发送时决定哪些材料合法。工具业务错误要作为工具结果反馈。

**本项目自己的选择**：可靠 length/filter 正文可以进入历史；明确断流正文的有限投影按 Q1 已确认规则处理。pi 直接过滤 error/aborted，并不等于它已经实现了我们建议的正文投影。pi 的 SDK 关闭与自定义重试也不适用于本轮“保留 SDK”的决定。

## 3.3 kimi-code：展示过的片段不自动等于完整消息

入口：

- `kimi-code/packages/agent-core/src/loop/events.ts`：增量事件与可记录内容事件分开。
- `kimi-code/packages/agent-core/src/agent/turn/kosong-llm.ts`、`kimi-code/packages/agent-core/src/loop/turn-step.ts`：生成、提交消息与终态处理。
- `kimi-code/packages/agent-core/src/agent/context/projector.ts`、`kimi-code/packages/agent-core/src/agent/context/index.ts`：partial 历史过滤与未完成工具结果修复。
- `kimi-code/packages/agent-core/src/loop/retry.ts` 及其测试：循环重试。
- `kimi-code/packages/kosong/src/providers/openai-responses.ts`、`anthropic.ts`：SDK 创建配置。

**采用**：运行状态、显示片段、可靠历史是不同层。可靠收到截断或过滤终态后，可以保留正文；只有合法工具结束条件才允许执行调用。取消工具时，已经完成的结果与未完成的调用分别处理。

**不照搬**：kimi 对 partial 的过滤方式不替代用户选择；中途断流重试也不覆盖“已有有效输出后停止自动重试”的要求。其 SDK 配置只是对照，不据此改变本项目配置。

## 3.4 deepseek-harness：保留工具错误，区分运行故障

入口：

- `deepseek-harness/packages/core/agent-loop/src/agent.ts`：原始 assistant/chunk 记录与提交给历史的消息不同；工具循环的结束条件独立。
- `deepseek-harness/packages/core/session/src/surface.ts`、`session/src/index.ts`：选出模型可见的消息。
- `deepseek-harness/packages/core/agent-loop/src/tool-calls.ts`：工具结果顺序、取消收尾和调度故障。
- `deepseek-harness/packages/llm/llm-deepseek/src/adapter.ts`、`serialize.ts`：直接请求及协议序列化。
- `deepseek-harness/packages/llm/llm-retry/src/index.ts`：provider 重试事件与计数。

**采用**：读文件找不到之类的业务错误应成为该 callId 的结果，供模型调整下一步。参数损坏、结果保存失败、调度器内部异常不能一概伪装成普通工具业务错误。保留调用与结果的对应关系，比保留整个失败协议对象更重要。

**不照搬**：它使用直接 fetch，不是“保留官方 SDK”方案的替代实现；也不为 improve-7 引入独立事件重放架构。

## 3.5 codex：取消之后还要能解释已经发生的事

入口：

- `codex/codex-rs/core/src/session/turn.rs`：流消费、请求完成与外层步骤继续条件。
- `codex/codex-rs/core/src/stream_events_utils.rs`：已完成 output item 的记录。
- `codex/codex-rs/core/src/context_manager/history.rs`：发送历史。
- `codex/codex-rs/core/tests/suite/abort_tasks.rs`：取消后下一次请求中保留调用、aborted 结果和中断说明。
- `codex/codex-rs/core/src/tools/parallel.rs`：工具取消收尾。
- `codex/codex-rs/model-provider-info/src/lib.rs`、`codex-client/src/retry.rs`：HTTP 与流重试的分工。

**采用**：取消不能抹掉已经完成的工具事实，否则下一次请求会以为工具没有执行过。测试应检查下一次实际 HTTP 请求，而不只检查 UI 或数据库中“看起来有记录”。

**不照搬**：它的逐 item 提交和提前执行工具是更大范围的架构选择。本项目继续在请求耗尽并校验、保存成功之后执行工具。参考中的 stream retry 也不能成为已有输出后重新请求的理由。

## 3.6 本地 claude-code：只作受限交叉检查

入口：

- `claude-code/AGENTS.md`：来源限制。
- `claude-code/src/services/api/claude.ts`：`maxRetries: 0`、外层 withRetry 和流处理。
- `claude-code/src/query.ts`：后续请求组装和截断自动继续。
- `claude-code/src/services/tools/StreamingToolExecutor.ts`：工具取消和兄弟调用的处理。

能借鉴的是检查方法：工具失败是否错误地取消整个运行？fallback 是否可能重复执行工具？不能从这个项目得出“本项目应关闭 SDK”“截断后应自动续写”的结论；这两项与本轮用户决定相反。

## 3.7 截图中的 Context 管理规则

截图提到的 DeepSeek-Reasonix、Kun 和上一轮 context 调研见 [improve-6 参考项目](../improve-6/03-reference-projects.md)。本轮对照的重点是 **ohbaby 现有实现**，不是给那些项目补未经本次核验的源码结论。

| 管理规则                      | ohbaby 已有基础                                                    | improve-7 的验证/最小修复                                                           |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| M1 估算对应下一次实际发送内容 | prepare 组装、冻结并计量同一请求；每步取当前工具                   | 验证新增正文投影、工具集变化、压缩后重组都进入同一快照                              |
| M2 工具调用和结果不断开       | 同一 ToolPart 生成同 ID 的调用与结果；按消息切分和 native 原子保护 | 加失败/取消/重开后的配对测试，防止整条过滤误删已经完成的工具事实                    |
| M3 切模型后不沿用旧溢出/用量  | 产品入口禁止运行中切模型，reset runtime 并清上下文窗口显示状态     | 从真实入口验证新模型窗口、新校准和旧 overflow 隔离；保留已有 session cache 累计账本 |
| M4 避免无收益的反复压缩       | 每 run 上限、连续低收益锁、增长解锁和 force 例外                   | 验证压缩后重算及既有防护，不新建相同历史指纹去重机制                                |

特别是 M4：现有规则允许达到锁定条件前再次摘要，force 也有例外。本轮不把它改写成“压缩一次后，只要没新消息就绝不再次压缩”。压缩算法及更强的重复压缩抑制留到整条 Responses 链路完成后讨论。
