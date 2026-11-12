# 给 Claude：前端 goal-duty

共用本地分支 `codex/model-feedback`，不用 worktree。Codex 负责 LLM、agent 和共享 SDK；Claude 负责 Web、浏览器 daemon 客户端和 TUI。协作期间不要切换分支，按各自文件分批提交。

## Goal

用户始终能看懂“正在等、已结束、连接不可用”。反馈轻量、稳定，不因自动重试闪烁；只展示必要原因和可采取的下一步。

## Duty

- **模型等待**：同一请求链保持一行和连续计时。重试时简短提示；当前步骤有可见正文、Thought 或工具进度后由内容接替。隐藏/空白 Thought 不让页面失去反馈。终态停止转圈。
- **最终错误**：放在所属轮次末尾，只出现一次。主会话和 Side Chat 隔离；保留部分回答，主动停止不当成模型错误。不自动消失，不用卡片，也不提供关闭（00 §13 F1、F2）；TUI 保留简短静态结果。
- **连接**：短断线显示 Reconnecting；约 10 秒仍未恢复改为全页静态遮罩，后台继续自动重连。重复尝试不反复转圈，恢复就绪才清除。明确认证/注册失效静态提示刷新。保留历史和当前页草稿，不自动刷新或重发问题。
- **简洁**：不新增 Syncing 标签，重试只显示 `Retrying #n`，错误行只附 `HTTP 状态码`；不展示倒计时、重试上限、providerId、错误码或诊断详情（00 §13 F6、F8）。复用现有样式，支持减少动态效果。

## 对接

- SDK 提供 `modelActivity.phase`、`waitingStartedAt`。重试等待关联的请求可能已经结束；不要再只用 `endedAt` 判断是否显示等待。
- Web `ExecutionProgress`、TUI `working-spinner` 按当前运行中的 agent-step 活动接入；计时用 `waitingStartedAt ?? startedAt`，不因 requestId 改变重建等待行。只检查 `modelActivity.messageId` 对应消息的可见内容。
- `retryScheduled` 仅是历史事实，前端不据此发送请求。SDK 的 `listEndedTurns(...)[].error` 提供所属轮次的安全错误，优先 prompt，缺失时取 run。
- UI 是否能看见内容由前端判断；后端不记录 Thought 展开状态、提示关闭或连接展示计时。
- 连接未恢复就绪时屏蔽旧快照的模型动效；同步是内部条件，不增加一套用户可见状态。
- 会话视图的 runs 是活动数据来源，旧 `run.updated` 若不带 modelActivity，不能用它把现有活动整体覆盖。轮次错误行替换旧 prompt/run/message 的重复错误展示；尚无 runId 的启动失败继续使用现有 notice。

验证重点：重试不闪、最终错误不重复、侧聊隔离、刷新后错误仍只出现一次、断线后静态且能恢复。复用现有测试，接通后直接操作 E2E 和视觉走查。细节边界见 [02](02-optimization-plan-and-change-scope.md) 与 [04](04-test-and-acceptance.md)。

额外观察：全量回归中 TUI 审批期间 Ctrl+C 偶发提示无法确认当前 run，隔离运行通过。审查定位到现有 `session-recovery.refreshControl` 的递归 ticket 变化可能让 `stop()` 拒绝；请在前端阶段核查，本轮后端未改这段逻辑。

## 2026-11-12 前端讨论更新

用户与 Claude 讨论后调整了部分前端行为，以 [00 §13](00-discussion.md) 为准：错误改为轮次末尾的一行说明，不用卡片，不提供关闭；等待行重试时写 `Retrying #n`；断线约 10 秒后用全页静态遮罩；文案不出现 `ohbaby`，AI 名为 Lychee。
