# goals 第 4 批架构：自动插话与输入恢复

> 2026-10-15；继承 [improve-3](../improve-3/architecture.md)。本文件描述第 4 批阶段实现，原始 goals 文档和前三批记录保留。契约见 [improve-4/02](../../problem-lists/2026-10-13-goals-upgrade/improve-4/02-optimization-plan-and-change-scope.md)，测试映射与实际验收见 [05](../../problem-lists/2026-10-13-goals-upgrade/improve-4/05-implementation-acceptance.md)。

GoalStore、GoalService 和 GoalDriver 的职责不变。自动插话由已有 PromptScheduler 的 accept 路径决定，消费由当前 run 的输入机制承担；恢复提示由 adapter 查询持久事实生成。没有第二套 goal 状态、执行调度器、恢复账本或锁。

## 接受与分流

普通输入先持久接受。在同一 session owner 条目中，scheduler 检查是否有更早的 queued 输入，再由 adapter 解析有效 active goal run，调用 current-run-input store 尝试 steer。必须是当前 goalId/epoch 的执行且未封口；complete、blocked、pause、cancel 或正文替换已生效，旧 run 即使仍收尾也无输入资格。

结果是 `steered`、`not-steered`、`existing` 或 `error`。预期竞争保持原队列项；真实错误保持 durable acceptance 并返回错误；同 ID 重试先去重，直接读取旧状态和 receipt，既不再分流也不受新队列容量影响。成功调用既有 onSteered、发布最终 prompt.updated 并结算 completion waiter；投影回调失败不撤销持久成功。

prompt 顺序使用既有 `accepted_at`、`admission_order`。进入当前 run 的输入使用既有 `acceptedAt`，事务内按该 run 既有最大值加一；冻结时钟、反向 ID 和较早 queued 的手动 steer 都遵循实际进入 run 的顺序。重试保留旧时间戳。成功 steer 共享当前 run 的 scope、reasoning 与剩余 step，不增加 goal 轮或 blocked 审计轮。

## 会话恢复投影

`UiSession.unconsumedSteers` 是客户端唯一恢复列表，条目包含 inputId、promptId、messageId、原文与 `unconsumed | unconfirmed`。`ui-inprocess/steer-recovery.ts` 查询所有未成功处理的 root user-steer 输入、run 关闭事实、原消息与重发子项，不读取聊天 viewport 来判断是否遗失。

Web 默认只显示单行数量入口，展开后查看完整原文和逐项重发；CLI 保留紧凑状态与单行预览。折叠不丢失待定操作及重试身份，换会话重置展开状态。真正的重发错误独立于折叠列表显示；恢复区域按实际高度给聊天流留白。成功插话不另加常驻提示。

所有关闭原因均可产生恢复项。已有本地 attempt、没有本地成功落盘标记时显示“处理未确认”；这不是 provider 收到或模型理解的证明。原消息经过分页、隐藏或 compact 后，仍可按 ID 取得持久原文。旧 run 已终态但缺输入关闭字段时可作为读取依据，不改写旧输入。

close、确认和重发子项状态变化安排区外 rebuild；只有列表实变才发布既有 session 事件，避免 owner 重入。读取失败只使该 session 的列表为 undefined，并并入既有 executionRecovery blocked；不会中断历史或全局 snapshot。persistent adapter 等待既有启动 execution recovery，失败按 session 保留，健康 root 可继续读写，成功显式恢复清除错误。只读 snapshot 不发起隐式恢复重试。

## 显式重发与接口

`resendSteerInput({ inputId, operationId })` 从持久原文新建 prompt/message，使用 `resend:<operationId>` 幂等键。迁移 024 仅新增可空 `prompt_submission.resend_of_prompt_id`，旧数据不回填，多个新操作可对应同一父 prompt。原 prompt 与原消息不改写，不复用 retained 操作。

queued、retained、starting、running 子项或有本地成功处理证据的子项压制父提示。有效 steered 子项承接该分支的恢复，关闭后只显示它自己的入口；多级重发不同时显示祖先。普通子项尚未成功便失败/取消时重新显示最近可恢复父项；retained 继续走自己的显式 resubmit/cancel，不复用祖先身份。普通子项若已成功请求、后续才失败，父提示仍被压制。steer 的成功证据来自 `processedRequestId`，普通子项来自持久 assistant agent-step 请求结果。

| 层 | 接口 |
| --- | --- |
| SDK | `UiPromptReceipt.steer`、`UiSteerQueuedPromptResult`、`UiUnconsumedSteer`、`UiResendSteerInput` |
| Adapter / host | `resendSteerInput` 及 trusted owner 变体；持久 session/scope 校验，原提示隐藏后同操作重试仍可验证 |
| HTTP daemon | `POST /v1/steer-inputs/:id/resend`，body 中 operationId；客户端绑定 root 与 adapter 双重核对 |
| JSON-RPC / Web / CLI | 同批透传新命令和结果；会话恢复入口不依赖原消息是否加载，消息行按 messageId 显示同一投影 |

旧 `UiRun.unsentSteer` / latest-stop helper 被会话列表替代。SDK、后端和客户端应一起升级；前批的四态、两轴预算、时间截止、用户优先与尾部结算保持原职责。improve-5 继续处理正文/短显示、inactive 注入、criterion 6000、常驻统计和最终 compact/cache/重连组合回归。
