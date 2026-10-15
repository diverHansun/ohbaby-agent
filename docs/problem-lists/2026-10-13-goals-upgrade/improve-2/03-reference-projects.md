# 03 参考项目对照：第 2 批

> 只记录与"执行准入、身份与计轮、用量结算"直接相关的事实与取舍。总体对照见 [../plan/03-reference-projects.md](../plan/03-reference-projects.md)；核查时间 2026-10-15，路径相对各项目根，定位以符号为准。

## 3.1 DSH：round-driver 的预约与竞争排队

事实（`deepseek-harness/packages/goal/goal-round-driver/src/index.ts`）：

- `RoundAttempt` 是一张进程内票据：`goalId + revision + round + messageId + content + phase(queued|claimed|admitted)`，另有 `cancelled / stale` 标记（第 21-35 行）。
- `readyToDrive` 要求"fiber 活着 + 同一个 live agent + agent idle + `!competingQueued`"（第 103-109 行）；`competingQueued` 在普通消息进入 next-turn inbox 时置真（第 299-306 行）——这就是"用户排队工作优先于 goal 下一轮"的原型。
- 准入前先 `followup` 一条带 `source: {kind:'goal', goalId, revision, round}` 的消息并登记预约（第 174-190 行）；排队失败则按最新 revision 比对后 block（第 193-204 行）。
- `validReservation`（第 349-362 行）在 pre-step 前做 fail-closed 复核：内容与 source 一致、phase 是 claimed、未 stale、goal 仍 active/armed、`source.round === roundsStarted + 1`。不合法就把它从消息里撤掉、并把其他已 claim 的消息还原（`restoreOtherClaimed`，第 127-135 行），防止用户消息被顺手丢掉。
- agent 在仍挂着一轮 queued 预约时回到 idle：主动撤回预约（第 271-277 行），说明"没轮到的预约不能把排在它后面的用户输入堵死"。
- 计轮发生在 admitted 之后：`goal/src/fold.ts` 里 `roundsStarted` 是变更字段，fold 校验 `source.round === roundsStarted + 1`（第 302、326 行）；driver 侧在收到对应 `user/message` 事件时把 phase 推到 `admitted`（第 322-331 行）。

本项目借用：票据式预约 + phase/失败语义 + "applied 前复核身份" + `competingQueued` 的优先级思想。**不借**：持久 revision（本项目无 fork、同进程）；不做 activation/armed 层；不把 goal 消息塞进 inbox 再由 pre-step 拦截——本项目的执行权在"准入即占位"，不是"先排队再撤销"。

## 3.2 Codex：按 turn 身份记账

事实（`codex/codex-rs/ext/goal/src/accounting.rs`、`tool.rs`）：

- `record_token_usage(turn_id, usage)` 把用量记在**轮**上，只返回"自上次结算以来的增量"（`token_delta_since_last_accounting`，第 282-303 行）；`mark_turn_goal_active(turn_id, goal_id)` / `current_active_goal_id_for_turn` 把轮绑定到目标（第 265、313-332 行）。
- 结算走 `account_thread_goal_usage(thread_id, time_delta, token_delta, mode, expected_goal_id)`（tool.rs 第 330-367 行）：带 `expected_goal_id` 做核对，结算后 `mark_progress_accounted_for_status` 记录本轮的已结算状态，防重复累计。

本项目借用：用量绑定执行身份、写入前核对目标、结算幂等。本项目按每个 run 的最终 outcome 结算一次，不搬 Codex 的多次增量结算模型。沿既有 `RunCompletion.usage → GoalTurnOutcome → store` 通道传递，去重标记挂在票据上；不引入独立 goals 数据库、六态、子代理归集、缓存计价或新结算账本。

## 3.3 Kimi：在 step 边界计轮、按 turn 记用量

事实（`kimi-code/packages/agent-core-v2/src/features/goal/goalService.ts`）：

- `handleBeforeStep`（第 541-547 行）：先看 `goalDrivenTurns.get(turnId)` 是不是 goal 轮，再用 `countedGoalTurns` 集合**幂等**加一——同一个 turn 不会重复计轮。
- `handleUsageRecorded`（第 549-555 行）：只接受 `source.type === 'turn'` 的记录，按 `turnId → goalId` 的映射记账，其他来源（子代理、摘要）不混入。

本项目借用：**"已准入才计、同轮最多一次、用量按轮绑定目标"**。差异：Kimi 用 turnId 集合去重，本项目用票据（token 起、runId 后绑）去重；Kimi 的轮次由 step 事件驱动，本项目的轮次由准入落盘驱动（未获准的轮不计），这与 plan/00 决议 7 一致。

## 3.4 不搬入本批的设计

- DSH 的持久 revision 与 activation 层：本项目按 epoch + 票据即可覆盖"旧执行不碰新生命周期"。
- Codex 的独立数据库与账本：本项目明确不建 settlement map / 历史账本。
- Kimi 的 fork 清理提醒（`GOAL_FORK_CLEARED_REMINDER_NAME`）：无 fork，不引入。
- 任何"goal 轮先排队、被拦截再撤销"的形态：本项目的门禁是准入即占位，排队由用户队列承担。
