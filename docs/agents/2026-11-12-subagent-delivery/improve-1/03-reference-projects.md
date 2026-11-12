# 参考项目与采用范围

2026-11-12 核查本地源码和测试。以下结论限定于这些快照，不表示所有发布版本或所有客户端都这样工作，也没有运行这些项目的完整测试套件。项目路径均位于 `/Users/hansun025/Projects/code-cli/`；符号为定位依据，行号为快照。

| 项目 | 本地目录 | HEAD |
| --- | --- | --- |
| Kimi | `kimi-code` | `bb5284cf42b0ddcbb670a3b0d41c3ea1c6445a30` |
| DSH | `deepseek-harness` | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` |
| ZCode | `zcode` | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Codex | `codex` | `5228d94a27b7f84cae4854acbb5ea3b3e90dfeaf` |

## Kimi：终态事实可以恢复为通知

`packages/agent-core-v2/src/agent/task/completionRestore.ts:8` 从 wire journal 恢复终态，按 taskId、status、notificationId 以及已有消息／pending／wait-delivered 记录判断是否已经交付。`taskService.ts:38` 把遗留运行投影为 lost；仍在实际运行的任务不会被重复当成 lost。

`taskOutput.ts:90` 对输出读取失败降级，仍构造完成通知；通知带任务状态与后续可用信息。`loop/loopService.ts:374` 在恢复流程中核对历史和补通知。`loop/core/loop-actor.ts:1131` 取消非 detached 工作；`:1747` 的 detached completion 会记录结束、加入通知并调度运行。因此停止当前主轮次与后台任务后来通知是两件事。

证据测试：`test/agent/task/idle-notification-repro.test.ts` 包含 idle、多完成、结束边界和恢复 lost 后进入实际 turn 的场景；`wire-history.test.ts:221` 覆盖缺失通知补一次、已有通知不补。busy 测试包含额外的用户驱动动作，不能据此扩大成所有 busy 时机都立即自动请求的证明。

采用：终态先保存，启动后核对缺失通知，故障／lost 也通知主代理，输出不可读不吞掉通知。不照抄：wire 存储结构、与现有 runtime input 重复的 pending 队列，以及要求盲目重做最后一次工具调用的提示。ohbaby 的“成功请求包含输入”确认标准仍使用自身记录。

## DSH：忙闲与取消收尾必须有明确定义

`packages/subagent/subagent/src/manager.ts:1109` 的 `notifySettlement` 校验父链及 root；根据 caller delivery、closing、idle、busy 选择不重复交付、inject、sendWaking、queue 或 steer。发送异常记录 warning，是 best effort 路径，不足以证明崩溃后端到端可靠。

`manager.ts:669` 的 `sendWaking` 将交付和唤醒连接。`packages/core/agent-loop/src/agent.ts:170` 在 abort 收尾期间把新的 waking input 转向下一轮；`tests/cancel.spec.ts:221` 覆盖此窗口。Stop 本身不是永久拒收通知的开关。

`packages/core/agent-loop/src/inbox.ts` 具有持久事件投影和接收约束，但不直接推出模型语义 exactly-once。`tests/continuation.spec.ts:1998` 明确覆盖 accepted-but-unlogged 不自动重放；`manager.ts:1203` 的 restoreTarget 是显式消息触发的子目标恢复，不是扫描全部子任务自动重启。

采用：交付与下一轮唤醒之间的明确接力，终态去重及父子归属校验。不照抄整个 inbox；ohbaby 已有相同用途的 runtime input 与 execution 事实。

## ZCode：主 Stop 与子任务取消分开

`apps/zcode-cli/packages/core/src/subagent/runner.ts:372` 在后台运行时 detachParent。`runtime/methods/runtime-command-queue.ts:30` 明确区分任务卡取消与 chat Stop；前者抑制该子任务迟到通知，后者保留后台结果唤醒。队列会合并当时的 task notification，而不是等所有任务结束。

`runtime/methods/background-notifications.ts:65` 保存 admission ledger；恢复时会把部分已接纳通知标成 `session_resumed` 丢弃，不能拿它证明“重启一定重新投递”。`tests/subagent-background.test.ts:665` 覆盖已认领通知在 provider 失败／Stop 后不因后台重复事件再次开跑，而后续显式运行仍可带入消息。

`subagent/completion-notification.ts:55` 使用结构化通知信息。消息身份由 contracts 中的 UUID 方案生成；命令队列仍有数值编号，因此不能声称它所有身份都全局稳定。

采用：主 Stop 语义、分批交付、同一失败结果不无限重开、结构化错误信息。不照搬其恢复时 discard 的选择，因为本产品明确要求故障中断通知和保留未消费结果。

## Codex：收件与主动运行是不同能力

`codex-rs/core/src/agent/control/mailbox.rs` 是内存 HashMap/watch 信箱，可跨会话卸载保留，不等于跨进程持久队列。`control/delivery.rs` 明确区分 QueueOnly 与 TriggerTurn。

`control/completion.rs:109` 的 completion 使用 `trigger_turn=false`，并有 best effort 失败记录及独立 UI activity。因此不能说“Codex 子完成一律启动空闲主代理”；不同消息类型有不同唤醒策略。`control.rs` 的冷队列使用 UUID 身份，可参考其避免 UI 编号充当持久消息身份的做法。

采用：把接收、唤醒和 UI 活动分开定义。没有采用：新增 mailbox、按它的 completion 触发策略改变本产品已经确认的自动续跑要求。

## 对本轮方案的约束

参考项目支持把终态、通知、执行调度分开，但没有一个应被整体搬入 ohbaby。我们的边界是既有存储上的可靠交接：借 Kimi 的故障通知与恢复思路，借 DSH 的取消边界接力，借 ZCode 的 Stop 与去重规则，借 Codex 的投递／触发区分。所有采用项落在 [02](02-optimization-plan-and-change-scope.md) 和 [design](design/architecture.md) 内，不以参考项目名替代本项目的端到端验证。
