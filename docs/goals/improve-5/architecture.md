# Goals improve-5：正文、展示与写入边界

2026-10-16 更新（含 [截图反馈收尾](../../problem-lists/2026-10-13-goals-upgrade/improve-5/06-prompt-and-composer-followup.md)）。基于 improve-4 `17fdae14`，本批收尾方案见 [实施范围](../../problem-lists/2026-10-13-goals-upgrade/improve-5/02-optimization-plan-and-change-scope.md)。原始模块文档保留历史内容；本页描述本批实际改变的接口与行为，前序生命周期与输入恢复仍见 [improve-3](../improve-3/architecture.md)、[improve-4](../improve-4/architecture.md)。

## 正文和展示共用同一次准入

`GoalService.admitTurnInBoundary` 已生成 `GoalTurnTicket.modelText`、`displayText` 和 `turnNumber`。首轮展示该快照的完整 objective，后续展示 `Goal auto-continue (turn N)`；adapter 不重新计算文案或轮号。

`submitPromptInternal` 将正文作为 `runtime.startSession.prompt`，把独立展示值交给 `displayUserText`，实时 `message.appended` 使用同一展示值。runner 仍将正文写入普通 user text part，附加既有 `metadata.displayText`；SQLite 回放复用 persistent-store 的既有展示投影。实时与重连因此显示相同的目标原文或续轮短提示，模型与压缩仍读取完整正文。自动会话标题的 `firstUserMessage` 保持正文。

没有新增消息 kind、system role、origin 或缓存身份。环境信息与 MCP 菜单继续由 runtime model-context part 承担；目标提醒仍按普通 user history 分组，可被通用压缩处理，下一轮目标从 store 重建。

`/goal` 创建与 `/goal replace` 将 argv 首行与 SDK invocation.body 合并，保留多行目标；不改变全局 slash parser 或引号参数语义。命令执行成功提示仍可写 `Goal started (...)`，它不是聊天 prompt。旧消息的 displayText 不迁移。

## 普通输入直接透传

删除 `renderGoalContextNote`、其导出与测试、`suppressGoalContextNote`、`promptTextForModel`。无目标、paused、blocked 下普通输入都不再拼目标前缀；成功 steer 仍走既有 current-run-input 路径，保留用户原文。

历史目标正文与旧 light note 不清除，显式 GetGoal 和 `/goal status` 仍可查询目标与统计。base.md 静态规则和压缩实现不变。删除 helper 不影响计轮和用量刷新：它们已经由 store 的 progress → `goal.updated` 发布。

## Criterion 的唯一校验入口

`GoalStore.create` 在 objective 校验后、存在性检查及任何写入前规范化 completionCriterion：trim 后为空则省略；JavaScript UTF-16 `length` 超过 6000 则抛 `invalid_criterion`，消息包括上限与实际长度；合法值完整保留。

上限复用 `MAX_GOAL_OBJECTIVE_LENGTH`，不新增第二个可漂移的配置。记录与内存使用同一个规范化值。`replace: true` 也先校验，失败时目标、统计、持久记录均不改变。历史 criterion 回放保持原样，不追溯截断或拒绝。CreateGoal 工具参数说明同步长度与拒绝规则；不新增 criterion 编辑入口。

## UI 只消费后端快照

`UiGoal` 在既有 status/objective/pauseReason 之外增加必填 `turnsUsed`、`wallClockMs`，以及可选 `turnBudget`。`goalSnapshotToUiGoal` 是统一生成点，服务初始快照、session view 与增量事件；无轮次上限时省略字段，complete 仍为 null。

- CLI 常驻行显示 `goal active · 3m 12s · 7/20 turns`；无上限为 `7 turns`。
- Web header 移除 goal chip。Composer 依次显示 steer recovery、queued prompts、goal 窄条、输入框；goal 始终紧贴输入框上沿。状态条包含单色靶心、状态、单行省略的 objective、轮次上限进度与活跃时长、同槽位暂停/恢复及编辑图标；480px 以下收起附加数字，保留摘要和操作空间。
- active 直接暂停；paused 直接恢复，失败时打开 Resume 面板显示后端错误；blocked 打开 Resume 面板。编辑复用现有面板，保留 Turns、Active time、Optional limits；不会重置累计或新建目标。目标清空、正文更换或切换会话会使旧操作回调失效；仅统计更新不取消当前操作。
- 两端复用 SDK `formatDurationSeconds`；显示后端最近一次快照，不在前端启动计时器。paused/blocked 显示停止值，恢复不清零。
- 数字更新复用 progress 静默刷新，不追加生命周期 notice。常驻 UI 和自动提醒不显示 tokens，主动查询仍保留 total/cached 和统计不完整标识。

## 取舍、兼容与回滚

借鉴 Claude Code Best 的正文与展示分离、Kimi 的状态/时长/轮次形状，以及 Codex 的超长创建拒绝思路；不移植双消息体系、前端计时器、静默截断或文件转存。

本批没有数据库 schema 迁移。SDK 必填字段增加需要后端与 CLI/Web 一起发布；旧持久记录仍可读取。回退展示接线会重新显示正文但不会丢正文；恢复 light note 需要回退代码，没有运行期开关；回退 criterion 校验会重新允许超长写入。不要只回退某一 UI 消费者。

按 improve-1/06 回看 watchdog 位置：当前生产调用者仍仅有 llm-client streaming，attempt、retry、partial usage 的所有权未改变，provider 仅上报活动。没有新增独立消费者，继续保留原位置，不为收尾批提取公共框架。
