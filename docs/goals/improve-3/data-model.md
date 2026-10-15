# goals 第 3 批数据模型

> 前序字段与尾部结算见 [improve-2/data-model](../improve-2/data-model.md)。本文件只补本批变化；[实施验收](../../problem-lists/2026-10-13-goals-upgrade/improve-3/05-implementation-acceptance.md)记录实测边界。

`GoalStatus` 统一为 active / paused / blocked / complete，删除仅为旧记录服务的 GoalStoredStatus。pauseReason 同时承载 paused 与 blocked 的停止原因，不引入新的 cause 枚举。历史 reason 仍归一到 pauseReason，历史 blocked 原样保留；重启 active→paused 与 complete→clear 保持前序语义。

持久化继续使用 create/update/clear 追加记录。resume 的一个 update 包含合并后的 budgetLimits、active 与已折算 wallClockMs；回放 active 清除旧 pauseReason。失败 append 不更新内存。用量不清零，同 goalId 的已知尾部用量在 blocked 后仍可结算；目标被替换或取消时旧用量不会写到新目标。

预算仍只有 turnBudget、wallClockBudgetMs。轮数必须是 1–1000 的整数，时间必须为 1 秒–24 小时的有限正值。默认未设；未提供维度沿用原值，不支持清除已有上限。新总额度可以低于原上限，但恢复时必须大于已用量。token/cache 仍只是统计。

| 进程内对象 | 内容与生命周期 |
| --- | --- |
| BlockedAudit | 最近 runId、turnNumber、归一化 reason 和 count；每 session 一份；第三次 append 成功后才更新 |
| deadline entry | session 对应 token 与 timer；捕获 goalId；停止、重排或 dispose 清理 |
| executionEpoch / GoalTurnTicket | 沿用 improve-2；block 也是生命周期转换，立即使旧 mutation 资格失效 |

SDK 的 UiGoalStatus 增加 blocked；UiGoal 仍只有 status/objective/pauseReason，本批不提前加入轮次、时长或预算字段。adapter 的完整快照、session view 和 goal.updated 都保留 blocked，complete 仍不展示为当前目标。

回退旧版本会把已持久化 blocked 降为 paused，属于语义降级。客户端和后端需同批升级/回退；不能只移除 deadline 或单独缩回状态枚举而称为完整回滚。
