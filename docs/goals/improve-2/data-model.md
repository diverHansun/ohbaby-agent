# goals 数据模型

> 版本范围：goals 升级第 2 批的实施后文档，只描述本批阶段状态；上级目录保留原始设计，后续批次尚未包含。原始规划与验收标准见 [improve-2 方案](../../problem-lists/2026-10-13-goals-upgrade/improve-2/02-optimization-plan-and-change-scope.md)和[测试标准](../../problem-lists/2026-10-13-goals-upgrade/improve-2/04-test-and-acceptance.md)，实际验证与限制见[实施验收](../../problem-lists/2026-10-13-goals-upgrade/improve-2/05-implementation-acceptance.md)。

本文件定义 improve-2 的领域概念与持久化语义，具体接口以 `src/goals/types.ts` 为准。架构见 [architecture.md](./architecture.md)。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| Goal | session 当前持久目标，由 `goalId` 标识，一个 session 最多一个 |
| Objective / Completion criterion | 自包含目标与可选成功判据；模型输入中作为不可信数据转义 |
| GoalStatus | `active`、`paused`、`complete`；无目标用 null，complete 会持久保留到结算清理 |
| GoalActor | `user`、`model`、`runtime`、`system`，记录变更来源 |
| PauseReason | 展示与 light note 使用的文字，不决定恢复分支；恢复统一为 `/goal resume` |
| executionEpoch | service 持有的进程内执行代号，隔离生命周期，不持久化 |
| GoalTurnTicket | 从准入到结算/恢复结束的执行身份，准备阶段也存在，不依赖 runId 已生成 |
| GoalSnapshot | 只读状态投影，供命令、工具、提示词与 UI 读取 |
| GoalChange | `created`、`lifecycle`、`completion` 或 `progress`；progress 仅刷新数据，不发 notice |

## 状态与用量

`GoalSnapshot` 包含 goalId、objective、可选 completionCriterion、status、turnsUsed、tokensUsed、wallClockMs、budgetLimits、计算得到的 budget、可选 pauseReason，以及可选 cachedTokensUsed / usageIncomplete。

- `turnsUsed` 在准入 append 成功时加一；等待、未准入与 steer 不加轮，已准入后取消仍计轮。
- `wallClockMs` 累计 active pursuit，paused 时间不计。暂停时先计算折算值，append 成功后再改内存与时间锚点。
- `tokensUsed` 与 `cachedTokensUsed` 为累计统计，不控制执行。outcome 的 `usage` 可提供 totalTokens、cachedInputTokens 和 usageComplete；缺失值表示未知，不写伪造的零。
- 新建目标的零用量已知，usageIncomplete 为 false。历史记录缺字段按未知处理；任一轮统计不完整后，累计统计继续标为不完整。

`GoalBudgetLimits` 仅有可选 turnBudget 与 wallClockBudgetMs。`GoalBudgetReport` 包含这两维上限、剩余量、到顶标志、overBudget 与 converging（达到 75%）。1000 轮系统安全阀独立于报告。历史 tokenBudget 字段回放时忽略，新记录和工具 schema 不再产出。

## 生命周期与身份

create（包括 replace:true）生成新 goalId。`/goal replace` 编辑同目标，保留预算、轮数和全部用量，仅 objective 归一化后实改才换 epoch。pause、cancel、complete、真正 resume 和 create 同样递增 epoch；同文编辑与预算变化保持 epoch。

模型工具携带内部可信 runId。goal-owned run 只能修改票据所绑定、epoch 仍有效的目标；普通用户主 run 在调用时捕获目标，区内复核身份；未知/失效 run 拒绝变更。GetGoal 只读。steer 共享所属 run 票据，不产生新身份。

业务状态回写要求 goalId 与 epoch 同时匹配。迟到 usage 只要求 goalId 匹配，paused/complete 也接受；目标已取消或替换则丢弃，不能计入新目标。ticket.settled 只在 usage append 成功后设置，重复结算跳过已经成功的阶段。

## complete 与持久记录

complete 的顺序为：append complete update → 等待票据尾部 usage → clear。没有 pending 票据时可直接 clear。complete 残留期间拒绝 resume、objective 编辑与预算编辑，但允许 create 新目标。completion notice 只发一次，最终 clear 使用 progress。

GoalRecord 是 append-only 的 create/update/clear JSON 记录，带 sessionId、goalId、seq 与 createdAt。每条记录 append 成功后才提交相应内存修改；多次 append 不构成数据库事务。usage 成功而 clear 失败是允许的持久中间状态。

rebuild 顺序回放，update 与 clear 必须匹配当前 goalId。旧 reason 归一到 pauseReason，旧 blocked 归一到 paused。active 重启后降 paused，complete 残留直接 clear；不恢复 driver，不补造崩溃前未知用量。

Lifecycle 的完整 `inputBreakdown` 仍要求所有参与请求提供明细。请求失败、取消或部分请求缺少明细时，可选 `cachedInputTokens` 只保留已经观测到的小计；adapter 不因此把统计标为完整。缓存读取量是 total 的组成部分，不再加到 total 中。
