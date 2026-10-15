# 第 3 批参考项目对照（Kimi 截止、DSH resume、CCB 同因计数）

> 核查时间：2026-10-15，基线 main / `018a5c96`。路径相对各项目根，行号只用于定位、以符号为准。参考用于理解边界，不按「几家都这么做」投票。
> 本批只展开与本批决策直接相关的部分；总体对应关系见 [plan/03](../plan/03-reference-projects.md)。用户确认的产品选择见 [00](./00-discussion.md)，工程约束见 [02](./02-optimization-plan-and-change-scope.md)。

## 3.1 来源

| 简称 | 目录 | 本批重点 |
| --- | --- | --- |
| Kimi | `kimi-code/packages/agent-core-v2/src/features/goal/` | 活跃时间截止（`goalService.ts`、`goalDeadlineScheduler*.ts`） |
| DSH | `deepseek-harness/packages/goal/goal/src/` | resume 与 edit 的上限检查（`index.ts`） |
| Claude Code Best | `claude-code/src/services/goal/` | 同因阻塞计数（`goalState.ts`） |

## 3.2 Kimi：活跃时间截止

事实（`goalService.ts`，2026-10-15 快照）：

- `wallClockDeadlineDelay`（L951）：只有 active、设了 `wallClockBudgetMs` 且已有起始点才返回延迟，值为 `min(2^31-1, max(0, 上限 - 已用活跃时长))`。
- `handleWallClockDeadline`（L963）：先发 `goal.deadline.clear` 再重读状态；不在限内（早到回调）→ `refreshWallClockDeadline` 重排；到顶 → `goalBudgetBlockReason` → `applyLifecycle(..., 'blocked', reason, 'runtime', { cancellationReason: cancellation })`，由 lifecycle 路径取消 pending continuation，另在 `liveTurnId !== pendingTurnId` 时 `cancel(liveTurnId)`。
- `setBudgetLimits`（L376）：合并上限 → `blockIfBudgetReached` → `refreshWallClockDeadline`。截止调度用 `goalDeadlineSchedulerService.ts` 的 `schedule(delayMs, callback): IDisposable`，基于 `hrtime`，timer `unref()`。

本项目取舍：借「有上限才排、到点转 blocked 并中断当前执行、预算变更重排、timer unref、早到回调重算」。不搬 live / pending turn 这套独立协调机制，本项目用准入票据表达同一件事；Kimi 的 `deadline.clear` 是全局单目标下够用的写法，本项目加上 token 自识别，防旧回调清新 timer（见 02 §2.5）。

## 3.3 DSH：到顶后拒绝 resume

事实（`goal/src/index.ts`，2026-10-15 快照）：

- `resume`（L364）：resumable 为 active / paused / blocked；active 且 armed 直接拒绝；`roundsStarted >= maxGoalRounds` 时抛 `GoalError("... exhausted N goal rounds; increase maxGoalRounds before resuming")`。
- `edit`（L330 附近）：可改 objective 和 / 或 `maxGoalRounds`，至少给一个；不改变阶段与 activation。

本项目取舍：借「到顶恢复必须先抬上限，错误文本给出可执行的下一步」。不搬持久 revision、armed / disarmed 激活层（plan/00 决议 10）。DSH 的「编辑」与「恢复」是两步，本项目把两步合成一条 `/goal resume`（明细见 02 §2.5），并保留「SetGoalBudget 后再 resume」的两步路径。

## 3.4 Claude Code Best：同因计数

事实（`goalState.ts`，2026-10-15 快照）：

- `BLOCKED_CONSECUTIVE_THRESHOLD = 3`（L12）。
- `recordBlockedAttempt`（L211）：非 active 返回 null；比较值 `reason.trim().toLowerCase()`；上一次理由不同 → 计数归零；累计到 3 → 状态置 blocked。
- 计数随 `GoalState` 存储；可恢复的 resume 会把 `blockedAttempts` 清零（L102-103、L135）。计数按**调用**累计，不区分轮次。

本项目取舍：借归一化比较、换因归零、真正恢复清零；这些与 plan/00 决议 9 一致。不搬「按调用计数」：本项目要求按已准入 goal run、同轮最多一次，防同一轮三次工具调用凑数（见 02 §2.5）。「相邻三轮」是本项目自己的硬约束，不宣称 Claude Code Best 已有同样门禁。

## 3.5 不混用的口径

- **Codex**：`codex-rs/ext/goal/src/accounting.rs` 的内存硬计数针对「无活动 / 执行失败」，不是模型同因报告门禁；「模型连续三轮」在 Codex 是 continuation 提示里的规则。不得写成「Codex 已有同因三轮硬门禁」（plan/03 §3.3 已更正）。Codex 的 BudgetLimited 独立终态、独立 goals 库与六态不搬。
- **ZCode**：独立 verifier 不搬；`stream-idle-timeout` 属请求空闲看门狗，归第 1 批，不拿来当本批参数。**Kimi** 的 criterion `slice` 截断由第 5 批明确拒绝；其通用 origin/injection 分类与后续重注入机制也不搬，不称为 goal 专属压缩分支（锚点见 plan/03 §3.4）。

## 3.6 对 02 的影响

| 02 的决策 | 参考来源 |
| --- | --- |
| 时间上限做成当轮截止；创建 / 恢复 / 预算变更后重排；timer unref；早到回调重算 | Kimi §3.2 |
| 到顶恢复先给「抬上限」的可执行提示；拒绝时零修改 | DSH §3.3 的拒绝语义 + 本项目的原子要求 |
| 同因归一化、换因从 1 计、真正恢复清零 | Claude Code Best §3.4 |
| 连续三个「已准入 goal run」、同轮一次、steer 不新增审计轮 | 本项目自己的约束，不声称照搬某家 |
| 不引入 revision / activation 层；预算恢复不重置计数 | DSH 对照后拒绝（plan/00 决议 10） |
