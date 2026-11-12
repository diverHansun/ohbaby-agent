# 参考项目与取舍

2026-11-11，只读核查用户指定的三个本地项目。下表是源码快照，未运行这些项目的测试或模型请求，也不把其实现视为必须照搬的标准。

## 1. 来源

| 用户称呼 | 本地目录                    | HEAD                                       |
| -------- | --------------------------- | ------------------------------------------ |
| dsh      | `code-cli/deepseek-harness` | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` |
| kimicode | `code-cli/kimi-code`        | `bb5284cf42b0ddcbb670a3b0d41c3ea1c6445a30` |
| zcode    | `code-cli/ZCode`            | `b95ebaffeab641907b38652f45c1502bd762972d` |

链接按三个项目与 ohbaby-agent 同属 `code-cli/` 的本地布局编写；行号是此快照的辅助定位，以符号为准。

## 2. dsh：明确记录重试安排，错误留在轮次内

| 代码事实                                                                                | 依据                                                                                                                                                                                                                                                          | ohbaby 取舍                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 先保存 `llm/retry`，可取消等待结束后再保存 `llm/retry-started`；按 retryId 聚合等待链。 | [backoff，约 L146](../../../../../deepseek-harness/packages/llm/llm-retry/src/index.ts)、[retry 投影，约 L41](../../../../../deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/retry.ts)                                                 | 采用“安排重试”和“请求实际开始”是不同事实的思路；复用我们的请求归属，不新增 retryId 或事件表。 |
| 重试行显示次数、上限、等待秒数和可展开详情。                                            | [ModelRetryItem，约 L63](../../../../../deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx)                                                                                                                                             | 保留一条连续状态行；不采用默认次数、等待秒数和详细错误。                                      |
| `turn-error` 从终态构造，持久显示在对应轮次内，没有自动超时和关闭按钮。                 | [endFailure / turn-error，约 L36、79](../../../../../deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts)、[TurnErrorItem，约 L131](../../../../../deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx) | 采用轮次归属和持久结果；不照搬可见 code。关闭记忆是我们的产品决定。                           |
| 普通用户取消保留 stopped 摘要，不作为 provider 错误。                                   | 同上 `endFailure`                                                                                                                                                                                                                                             | 采用正常停止与失败分开的语义。                                                                |
| UI 投影收窄错误字段；AUTH 不直接展示上游 message，以防其中带凭据。                      | [displayFailure，约 L149](../../../../../deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts)                                                                                                                          | 采用安全原因分类。后台也只保存筛选后的摘要，不采用“原始诊断全部留日志”。                      |

dsh 对某些已有部分输出的 TRANSPORT 断流会重试，失败片段记为 `assistant/attempt`，成功尝试才提交正文；clean partial EOF 的默认处理又不同。[transport-recovery.spec.ts 约 L128、192](../../../../../deepseek-harness/packages/llm/llm-retry/tests/transport-recovery.spec.ts) 明确区分两者。**本轮不采用这种部分输出重试策略。**

它的活动标题还有 150ms 最短保持时间，见 [ChatGroupSeat.tsx，约 L60](../../../../../deepseek-harness/packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx)。这是标题平滑，不是修复 ohbaby 秒级重试空白的方法，本轮不引入延迟隐藏计时器。

## 3. kimi-code：稳定的活动实例，诊断与用户说明分开

| 代码事实                                                                         | 依据                                                                                                                                                                                                                                  | ohbaby 取舍                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| retry 事件带步骤、尝试、delay 和原因；TUI 保存 backoff/attempt 阶段。            | [TurnStepRetryingPayload，约 L161](../../../../../kimi-code/packages/agent-core-v2/src/agent/loop/turnEvents.ts)、[handleStepRetrying，约 L520](../../../../../kimi-code/apps/kimi-code/src/tui/controllers/session-event-handler.ts) | 采用明确的重试状态；该事件本身非持久，我们还需覆盖刷新恢复。                                |
| 相同样式的 spinner 实例复用，只更新 label；空白或隐藏 reasoning 不结束 waiting。 | [ensureActivitySpinner，约 L5011](../../../../../kimi-code/apps/kimi-code/src/tui/kimi-tui.ts)、[handleThinkingDelta，约 L612](../../../../../kimi-code/apps/kimi-code/src/tui/controllers/session-event-handler.ts)                  | 采用实例稳定及“有可见进展才交接反馈”的原则。                                                |
| 默认 label 含次数、错误名、等待秒数，下方还有状态码和 provider 说明。            | [formatStepRetryLabel / formatStepRetryDetail](../../../../../kimi-code/apps/kimi-code/src/tui/utils/step-retry.ts)                                                                                                                   | 不采用该信息密度；ohbaby 仅显示 `Retrying…`。这里的秒数是等待时长文本，不是持续递减计时器。 |
| 后端 TurnEnded 持久保存错误；TUI 则追加静态错误文本，无关闭操作。                | [TurnEndedPayload，约 L106](../../../../../kimi-code/packages/agent-core-v2/src/agent/loop/turnOps.ts)、[showStatus，约 L4520](../../../../../kimi-code/apps/kimi-code/src/tui/kimi-tui.ts)                                           | 采用终态原因持久化；不能把追加式文本当作现成的精确轮次卡片或浏览器关闭记忆。                |
| 错误具有 status、requestId、traceId 等信息，日志按请求和轮次关联。               | [APIStatusError，约 L111](../../../../../kimi-code/packages/agent-core-v2/src/llm-adapter/contract/errors.ts)、[logRequestFailure，约 L413](../../../../../kimi-code/packages/agent-core-v2/src/agent/loop/requestObservation.ts)     | 采用关联诊断，不复制任意 details、headers、cause 到我们的公共错误或默认 UI。                |

Kimi 的普通重试策略并不以“已经产生部分输出”为禁止条件，重试时可以 reset 当前步骤的临时流，还支持无限重试模式。见 [shouldRetry，约 L214](../../../../../kimi-code/packages/agent-core-v2/src/human/llm/policy/policy.ts) 和 [retry.ts](../../../../../kimi-code/packages/agent-core-v2/src/human/llm/policy/retry.ts)。本轮不采用这些策略，也不改变现有预算。

该 checkout 的生产 Web 只有构建产物，未核验浏览器关闭记忆。源码中的 message 清洗主要处理 HTML/换行，不能当作通用隐私脱敏器。

## 4. ZCode：请求重新发出不等于已经恢复

| 代码事实                                                                                                                    | 依据                                                                                                                                                                                                                                                                                                                                           | ohbaby 取舍                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| snapshot.control 有结构化 apiRetry。普通重试再次 request-started 时不清空，直到有效进展或终态才清理，注释明确防止标签闪退。 | [snapshot.ts，约 L126](../../../../../ZCode/packages/shared/src/zcode-protocol-v4/snapshot.ts)、[zcode-api-retry-status.ts，约 L39](../../../../../ZCode/packages/shared/src/zcode-api-retry-status.ts)、[product-projection.ts，约 L2916](../../../../../ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts) | 采用同一重试链状态连续的生命周期，复用我们的请求 JSON 和投影，不复制整套协议。         |
| 有效进展包括非空正文、reasoning 和可识别的工具输入/调用。                                                                   | [isZCodeModelRetryRecoveryProgressPayload，约 L66](../../../../../ZCode/packages/shared/src/zcode-api-retry-status.ts)                                                                                                                                                                                                                         | UI 用可见进展判断等待是否结束；后端首正文指标和安全重试判断保持独立。                  |
| Working 主要代表最后一轮仍在工作；审批、提问、压缩等有专属反馈。前两次重试不显示次数，第三次才显示，无倒计时。              | [chatLoadingVisibility.ts](../../../../../ZCode/packages/ui/src/v4/chatLoadingVisibility.ts)、[ConversationTurnGroup.tsx，约 L195、853](../../../../../ZCode/packages/ui/src/v4/ConversationTurnGroup.tsx)                                                                                                                                     | 不把它的全轮 Working 直接搬到我们的模型等待行，也不采用“第三次起显示次数”。            |
| 错误摘要与详情分开；主 Banner 在输入框上方，没有自动超时。新轮清 lastError，关闭只记在组件内存。                            | [ChatErrorBanner.tsx，约 L353](../../../../../ZCode/packages/ui/src/ChatErrorBanner.tsx)、[SessionPane.tsx，约 L1233](../../../../../ZCode/packages/ui/src/v4/SessionPane.tsx)、[product-projection.ts，约 L2645](../../../../../ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts)                          | 采用摘要与诊断分离；位置、历史保留、刷新关闭记忆按用户已确认规则执行，不复制详情弹窗。 |
| 图标占位稳定，elapsed 不作每秒播报，减少动态效果时用静态图形。                                                              | [chat-loading.tsx，约 L117、177](../../../../../ZCode/packages/ui/src/components/ai-elements/chat-loading.tsx)                                                                                                                                                                                                                                 | 采用这些局部可访问性规则，保留本项目现有图标和样式。                                   |

ZCode 的 adapter 在正文或 reasoning 发布后不原地重放，但 core 还有独立的半截回答恢复机制：标记 discarded，从安全锚点开新消息，避免新旧内容拼接。见 [streaming-recovery.ts，约 L207](../../../../../ZCode/apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts)。不能简化成“ZCode 也绝不在部分输出后重试”；本轮不引入这套恢复机制。

## 5. daemon 连接的补充核查

模型请求重试与客户端连接 daemon 是两条独立链路。针对用户补充的持续 Reconnecting 问题，继续只读核对同一批源码：

| 项目与事实                                                                                                                                                   | 依据                                                                                                                                                                                                                                                                                                                                  | 本轮取舍                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| dsh 持续重连，退避上限 10 秒；单次握手有 15 秒期限和 3 秒慢连接日志。daemon 持续不可达时仍可保持 connecting，静态 disconnected 主要由浏览器 offline 触发。   | [连接循环，L164](../../../../../deepseek-harness/packages/client/connection/src/client/connection.ts)、[recovery-config.ts](../../../../../deepseek-harness/packages/client/connection/src/recovery-config.ts)、[SettingsRoot，L214](../../../../../deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx) | 采用后台自动恢复与手动重连可并存的思路；不照搬持续动画，也不把握手期限当成 UI 展示期限。                                   |
| ZCode 本地 runtime 重订使用 250 / 1000 / 3000ms 的有界退避，耗尽进入静态错误并提供 Reconnect；运行时可用事件仍可触发恢复。操作就绪还要求正确会话的有效投影。 | [scheduleRuntimeRecycleReconnect，L774](../../../../../ZCode/packages/ui/src/v4/conversationProjectionStore.ts)、[SessionSubscriptionErrorPanel，L51](../../../../../ZCode/packages/ui/src/v4/SessionSubscriptionErrorPanel.tsx)、[runtimeReady，L818](../../../../../ZCode/packages/ui/src/v4/SessionPane.tsx)                       | 采用静态不可用状态及同步完成后才可操作。按用户选择保留后台持续重连，不采用它的重试耗尽策略；这些延迟之和也不是总恢复期限。 |
| Kimi 的 Web 生产入口加载 dist-web，未找到可据以确认展示期限的 Web 源码。IPC 断开后不自动重连属于另一种 transport。                                           | [Web 入口](../../../../../kimi-code/apps/kimi-code/src/cli/sub/web/run.ts)、[IPC channel](../../../../../kimi-code/packages/klient/src/transports/ipc/channel.ts)                                                                                                                                                                     | 不据 IPC 或构建资产推断 Web 行为。                                                                                         |

“约 10 秒后停止转圈，后台继续自动重连”是本项目已确认的产品规则，并非三个参考项目共有的实现。它不要求新增连接框架、进程探测服务或后端状态表。

## 6. 对本轮方案的结论

（2026-11-12 注：§2–§6 写于前端讨论之前。其中“不显示次数”“关闭记忆”“轮次卡片”等取舍已由 00 §13 修订，以 §7 为准。）

三个项目都支持把重试看作有明确事实的运行阶段，但它们的重试预算、输出恢复、错误位置和显示细节并不统一。

02 采用的是这些小机制：明确记录重试安排、稳定展示同一条活动反馈、终态错误归属轮次、诊断与用户文案分离。关闭状态按稳定会话/轮次身份存在当前标签页，是用户自己的明确要求，并非三个参考项目共同已有的能力。

不采用它们的完整事件架构、无限模型重试、部分输出恢复、详细重试报表或错误详情系统。ohbaby 已有的请求记录、轮次、消息存储及连接循环足以承接本轮修正。

## 7. 前端讨论补充核查（2026-11-12）

Claude 派子代理只读复核三个项目的等待行与最终错误 UI，结论供 00 §13 使用。行号是当日快照，以符号为准。

| 项目 | 重试时的等待行 | 最终错误位置与样式 | 显示内容 | 何时消失 |
| --- | --- | --- | --- | --- |
| dsh | `RunningStatus` 按整轮挂载，重试不卸载；重试另起一行可展开的 `model-retry`，显示次数、上限和秒数（`chat/MessageItem.tsx` 约 L99–126） | 失败轮次末尾的 `turn-error` 行，不是卡片（`conversation-nodes/turn-error.ts` 约 L93–110） | 标题、说明和错误码；AUTH 说明会被替换为安全文案 | 不消失，留在历史里，没有关闭按钮 |
| kimi-code TUI | 样式相同时复用同一个 spinner 实例，只换 label（`kimi-tui.ts` `ensureActivitySpinner`） | 追加到滚动区的一行红字（`showStatus`） | `Error: [code] message`，附导出调试包的提示 | 不消失 |
| kimi-code VS Code webview | 重试显示为顶栏上的小标签 | 失败消息底部的红框 | 说明，加一个 `Retry` 按钮 | 下一次发送时清除 |
| ZCode | 加载位常驻，内容在 `ChatLoading` 和重试状态之间切换；前两次重试不显示次数，没有倒计时（`v4/ConversationTurnGroup.tsx` 约 L143、225–241） | 输入框上方的卡片（`ChatErrorBanner.tsx`） | 一行摘要，详情、复制、反馈都放在按钮后面 | 下一轮开始时由服务端清除，或手动关闭（仅存在组件内存） |

规律：错误留在对话历史里的项目（dsh、kimi TUI）都不用卡片，也不提供关闭；ZCode 的卡片浮在输入框上方，会挡视线，所以才需要关闭和自动清除。ohbaby-agent 据此选择轮次末尾的行内说明、不提供关闭（00 §13 F1、F2）。

重试次数的展示上，dsh、kimi 默认显示次数和上限，ZCode 第三次起才显示次数。用户确认 ohbaby-agent 显示 `Retrying #n`，不显示上限（F6、F8）。
