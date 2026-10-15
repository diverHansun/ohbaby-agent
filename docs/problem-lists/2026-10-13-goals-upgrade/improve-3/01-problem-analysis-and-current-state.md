# 第 3 批现状、问题与证据（blocked、审计、恢复与截止）

> 调查基线 main / `018a5c96`（plan 快照），2026-10-15 复核。本批、第 1 批与第 2 批**均未实施**；本文只描述当前代码事实，第 2 节末单独列出「前序预期」。
> 代码路径相对仓库根，行号是调查快照，定位以符号为准。需求见 [00](./00-discussion.md)，方案见 [02](./02-optimization-plan-and-change-scope.md)。

## 1. 核心问题

| ID | 当前事实与影响 | 代码证据 |
| --- | --- | --- |
| P3-1 | blocked 不是运行态：`GoalStatus` 只有 `active / paused / complete`；`GoalStoredStatus` 只为历史记录保留 blocked，回放时被归一成 paused。UI、工具、命令都无处表达 blocked | `goals/types.ts:1-2`、`goals/store.ts:408-410`（`normalizeStoredStatus`） |
| P3-2 | 模型 UpdateGoal 仍是三值 `active / complete / paused`，报告「阻塞」就是暂停，一次调用即生效，没有同因门禁；active 分支返回「已是 active」但不可恢复 paused | `goals/tools.ts:30`（`GOAL_STATUSES`）、`:198`（schema enum）、`goals/service.ts:187-229`（`updateGoalFromModel`） |
| P3-3 | 预算到顶 = paused，且时间只在轮次边界检查：driver 每轮开头 `budget.overBudget` 就 pause，长轮没有当轮截止；`goals/` 目录里没有任何 timer | `goals/driver.ts:24-35`、`goals/budget.ts:26-60` |
| P3-4 | `/goal resume` 无参数、无法同时改预算；到顶后 resume 会立刻再次到顶（driver 下一轮开头再 pause），形成「resume 即停」循环；两轴同时到顶时单条命令无出口 | `commands/goal.ts:50-53`、`commands/types.ts:168-186`（`CommandGoalBackend.resume(sessionId)`）、`goals/service.ts:139-144` |
| P3-5 | 预算单位校验只存在于工具层私有函数里：`turns / tokens / milliseconds / seconds / minutes / hours`、1 秒–24 小时、轮次上限 1000。命令层要用同一套校验，只能抽公共纯模块，不能让 `commands/` 反向导入 `tools.ts` | `goals/tools.ts:54-114`（`GOAL_BUDGET_UNITS`、`timeBudgetMs`、`budgetLimitsFromInput`） |
| P3-6 | 中断身份不足：`executeGoalExecutionInterrupt` 在 await 前检查 owner，await 后读取「此刻」的 runId 就直接 abort；期间执行者切换会误伤新 run | `adapters/goal-execution-control.ts:13-32` |
| P3-7 | 客户端投影吞掉 blocked：adapter 只放行 active / paused，其余返回 null；SDK `UiGoalStatus` 只有两值；Web Resume 按钮只在 paused 可点；CLI 颜色只有「active 用 accent，其余用 warning」 | `adapters/ui-inprocess.ts:1408-1420`、`ohbaby-sdk/src/snapshot.ts:75-82`、`apps/ohbaby-web/src/ui/commands/GoalControl.tsx:175-189`、`ohbaby-cli/src/tui/components/prompt/index.tsx:908-909` |
| P3-8 | 审计与计轮没有身份：`GoalTurnOutcome` 只有 status / error / tokensUsed；driver 直接 `incrementTurn()` 且用量回写不带 goalId。run 身份基建归第 2 批，本批只消费它，不重复实现 | `goals/types.ts:86-91`、`goals/store.ts:233-253`、`goals/driver.ts:36-57` |

以上均为已证实的控制流或数据结构事实；实际触发频率未经测量。第 2 批落地后 P3-3、P3-6、P3-8 的具体代码位置会移动。

## 2. 职责、数据流与接口现状（模块视角）

**职责边界**。GoalStore 是状态唯一入口（append 成功才改内存，`store.ts:40-43` 注释），GoalService 是用户 / 模型的共同后端并持有 driver promise（`service.ts:34-45`），driver 只做「读态→判预算→计轮→渲染→执行→回写」（`driver.ts:20-59`），adapter 负责投影、通知与中断端口。本批不改变这套分层，只在其中补状态与截止。

**状态迁移现状**（`store.ts`）：`resume` L160-168、`pause` L170-179、`markComplete` L182-198（宣告即 clear，从不驻留落盘）、`cancel` L200-206、`replaceObjective` L208-230（只改文字）、`setBudgetLimits` L255-274（合并写入；在 await 前计算合并值，并发安全归第 2 批）。重启归一化 `normalizeAfterReplay` L277-298：active 降 paused，游离 complete 补 clear。

**数据流（现状）**：

```text
/goal 命令 → CommandGoalBackend → GoalService → GoalStore（append + 内存 + onChange）
模型工具   → GoalToolBackend → GoalService.updateGoalFromModel → GoalStore
driver     → GoalTurnRunner（adapter 提交 goal-owned run）→ RunCompletion → pause/incrementTurn
投影       → GoalService.onChange → adapter publishGoalUpdated → goal.updated → CLI / Web
```

**接口现状**：`CommandGoalBackend` 只有 `create / status / pause / resume / cancel / replace / resolveSessionId`，resume 无参数、无预算（`commands/types.ts:168-186`）；工具 schema 只在 SetGoalBudget 里表达预算（`tools.ts:255-295`）；`GoalExecutionInterruptInput` 只有 sessionId / reason / includePrimary（`types.ts:102-107`）。没有任何 deadline 定时器，也没有把「预期 run」传入中断的记录。

**通知现状**：adapter 的 `onChange` 把每次迁移都发一条 notice（`ui-inprocess.ts:803-818`），文案形如 `Goal <status>: <pauseReason>`，blocked 出现后可直接复用；usage 刷新的静默化归第 2 批。

## 3. 数据模型现状

- `GoalStatus`（运行态）与 `GoalStoredStatus`（含 blocked 的持久态）并存是历史兼容产物；`GoalRecordData.reason` 是旧字段，回放时归一到 `pauseReason`（`types.ts:54-77`、`store.ts:90-97`）。
- `pauseReason` 现在只承载 paused 原因；决议 9 要求它同时承载 blocked 原因，不新增 cause 枚举。
- `GoalBudgetReport` 仍有三轴（含 token）；第 2 批删 token 后剩轮次与活跃时长两轴（`budget.ts:26-52`）。
- 客户端 `UiGoal` = `{ status, objective, pauseReason? }`（`snapshot.ts:77-82`）；轮次、时长与分母是第 5 批的字段，本批不动。

## 4. 用例现状

| 用例 | 现状 |
| --- | --- |
| 到顶后恢复 | `/goal resume` 只把 paused 改回 active；driver 下一轮开头再次到顶 pause。用户无法在 resume 时抬高总上限 |
| 模型报告阻塞 | `UpdateGoal(paused, reason)` 立即可用；没有连续轮次要求，也没有 blocked 终态；`UpdateGoal(blocked)` 被 enum 拒绝 |
| 一轮超时（长请求） | 轮内无任何检查，driver 必须等 `runner.runTurn` 返回才判预算 |
| CLI / Web 恢复 | 只有 paused 可恢复；Web chip 只有 `ohb-goal-active` / `ohb-goal-paused` 两种形状（`status.css:104-110`），Resume 按钮 `disabled unless paused` |
| 模型自我恢复 | 现在 `UpdateGoal(active)` 不改状态；改枚举后必须保留「模型不能自我恢复」，并返回清楚说明 |

## 5. 非功能现状（竞态、时钟、通知）

- **截止竞态**：没有 timer，所以也不存在「旧 timer 打断新 run」；引入 timer 后必须一次做对身份核对（P3-6）。
- **时钟**：活跃时长用注入的 `now`（`store.ts` 的 `wallClockResumedAt` / `foldWallClock` / `liveWallClockMs`），包含 active 等待用户队列的时间；测试可用假时钟，timer 可以配合 vitest fake timers。
- **通知**：blocked 通知可复用现有 `Goal <status>` 文案；不新增第二条 cleared 通知（第 2 批已建立去重）。
- **审计状态（本批预期，不是现状）**：审计链打算做成进程内小状态、每 session 一份、不落盘；只有最终 blocked 与原因落盘，跨重启保留。

## 6. 测试现状与缺口

现有覆盖：`goals/store.unit.test.ts`（含「legacy blocked 归一为 paused」L233，本批要改成「blocked 回放保留」）、`service.unit.test.ts`、`driver.unit.test.ts`、`budget.unit.test.ts`、`tools.unit.test.ts`、`injection.unit.test.ts`、`persistence.integration.test.ts`、`goal-compact.integration.test.ts`；命令层 `commands/goal.unit.test.ts`；适配层 `adapters/ui-inprocess.contract.test.ts`、`adapters/goal-execution-control.contract.test.ts`、`ui-runtime/admission.integration.test.ts`；CLI `tui/app.contract.test.tsx`；Web `ui/App.unit.test.tsx`、`ui/session/selectors.unit.test.ts`。

缺口集中在：blocked 状态迁移与回放、三轮同因门禁与 run 绑定、resume 参数矩阵与原子失败、deadline 重排与中断身份、watchdog × 截止竞争、blocked 的 CLI/Web 投影与恢复入口。这些正是本批 04 的验收对象。

## 7. 跨模块一致性与改动影响面（现状）

- 状态术语在四处各写一份：`types.ts` 联合类型、工具 enum、SDK `UiGoalStatus`、CSS 类名；改 blocked 必须四处同批更新，否则出现「后端 blocked、前端当未知」。
- 预算单位校验在工具层，命令层没有；静态规则与续跑规则分别写在 `primary/base.md` 与 `goals/constants.ts:15-29`，两处都写着 `paused`。改动面清单见 02 §2.4。

## 8. SWE 原则审视摘要

- 改动集中在既有 store / service / driver / adapter 的补口，不新建子系统；deadline 用最朴素的 `setTimeout` + 注入 `now`，不引入调度框架（KISS、YAGNI）。
- 三轮审计是进程内小状态 + 纯函数判定；resume 的解析、检查、写入分三层（纯 helper → 服务规则 → store 单条 update），反馈方向单一，不新增反向依赖。
- blocked 落盘不是不可逆变化，但回滚时有语义降级：旧版本会把它降回 paused，必须在 05 记录并提示（plan/02 §2.8 已登记）。

## 9. 与既有文档的关系

| 文档 | 关系 | 本批处理 |
| --- | --- | --- |
| `docs/goals/2026-07-03-state-contract-simplification.md` | 「blocked 非常驻」的历史决定被 plan 取代 | 实施时补 superseded 指向，不改原文 |
| `docs/goals/2026-07-03-interrupt-current-light-note.md` | 普通输入打断的历史决定被取代（第 2 批已生效） | 实施时补 superseded 指向 |
| `docs/goals/architecture.md`、`data-model.md`、`dfd-interface.md`、`non-functional.md`、`ui/goal-ui-design.md`、`test.md` | 描述的是改造前行为 | 随本批实现同步更新（见 02 §2.4） |

## 10. 前序批次预期 vs 代码事实

| 事项 | 当前代码事实 | 前序预期（未实施） |
| --- | --- | --- |
| 共享准入与执行身份 | 用户与 goal 各有调度路径，adapter 直接调 `runTurn` | 第 2 批提供 `withSessionMutation`、runId 绑定表与 `expectedRunId` |
| 计轮 | driver 在跑之前 `incrementTurn()` | 第 2 批移到准入快照内，并绑定 run 身份 |
| 预算到顶 | driver pause | 第 2 批过渡态仍 paused；本批翻成 blocked |
| complete | 立即 clear | 第 2 批改为持久 complete → 尾部结算 → clear |
| token | 仍是三轴之一 | 第 2 批删除配置、单位与判断，读兼容旧记录 |

本批 02 的代码锚点会随第 2 批落地移动；实施时以前序 05 与源码为准重新定位。

## 补充代码核查（2026-10-15，同一基线）

Web `SessionScreen.tsx:497–546` 在执行文本命令前打开 overlay，`GoalControl.tsx:209–221` 的 resume intent 只返回 action，未保留 rest。新增后端参数解析并不能自动覆盖 composer 路径，需在本批贯通并验收。`runtime.ts:187–191` 对 overlay 命令要求 `allowOverlay:true`，仅绕开面板而沿普通提交路径仍会被拒绝。中断的 session 子树范围问题见第 2 批 01；本批 deadline 与 blocked 复用其修正，不能另保留会话级 fallback。
