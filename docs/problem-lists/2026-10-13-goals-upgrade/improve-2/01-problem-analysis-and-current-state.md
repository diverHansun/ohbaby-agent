# 01 现状与问题分析：第 2 批（执行准入与统计基础）

> 基线 main / `018a5c96`。本文描述改造前实现，不是实施进度；路径相对仓库根，定位以符号为准，行号只是快照。
> 每节先写"现状"，再写"本批完成后的样子"，便于实施会话对照。

## 1.1 执行准入的现状

### 三条各说各话的路径

| 路径 | 现状流程 | 代码锚点 |
| --- | --- | --- |
| 普通用户 run | scheduler `accept`（有读写 admission barrier）→ `drain` 按 session 取 lane head → `commit(claim)` → `executeClaimed` → adapter `execute` → `submitPromptInternal` → `submitPromptWork` → `waitForPromptSlot(owner=user)` | `prompt-scheduler/scheduler.ts` `accept`/`drain`/`executeClaimed`；`adapters/ui-inprocess.ts` `submitPromptWork`、`waitForPromptSlot` |
| goal 轮 | `driveGoal` 循环直接调 `runner.runTurn` → adapter 内 `waitForPromptIdle` + `submitPromptInternal(owner=goal)` | `goals/driver.ts`、`adapters/ui-inprocess.ts:1004`（`attachTurnRunner`） |
| 手动 compact | 先做一次性检查（`hasPendingPrompt`、`compactingSessions`、`activePromptsBySession`、`pendingRuntimePromptsBySession`），再 `compactingSessions.add` | `adapters/ui-inprocess.ts` `compactSessionInternal` |

三处唯一共通的基础设施是 `SourceSessionProjection.owner` 的每 session 串行区（`run` / `runControl`，`adapters/ui-state/session-view.ts:108-148`）：scheduler 的 store claim 已经走它，控制写入也走它，但 goal 与 compact 完全没用。

### 具体缺陷

- **打断分支**：`waitForPromptSlot` 里 `owner=user` 撞 `active.owner=goal` 会调用 `interruptGoalPromptInFlight`——先 `pauseGoal("interrupted")` 再中断 run 并等空。同一个 goal 正忙时，用户输入既不排队也不 steer，直接把目标暂停掉。函数末尾还有一条通用 `throw new Error("A prompt is already running ...")`，删掉打断分支时容易落进它。
- **排队项提前占容量**：`drain` 的候选条件只看 `activeBySession`（只有 scheduler 自己 claim 过的 prompt），goal run 不写这个 map。于是 goal 正忙时，用户 prompt 仍会被 claim、进入 `executeClaimed`，在等待 goal 结束期间占着全局 `maxActiveSessions` 名额。
- **goal 无队列优先**：goal 准入不检查本 session 是否有 queued / starting / running 的用户工作。`drain` 和 driver 谁先动作，取决于事件唤醒顺序，没有共同的裁定点。
- **check 与 set 之间有 await**：compact 的"检查"（含 `await hasPendingSession`）与 `compactingSessions.add` 不在同一串行区；`submitPromptWork` 里 `waitForPromptSlot` 通过后再 `activePromptsBySession.set`，中间同样有 await。

**本批完成后**：三类持有者共用一个每 session 的执行权占位（门禁），"检查 + 占位"在同一个串行区完成；用户 claim 在串行区内复查空闲后发生，成功即登记占位；goal 准入要求本 session 无排队用户工作、无其他执行占位；普通输入只排队。

## 1.2 准入计轮与渲染的现状

`driveGoal` 每个循环：读快照判预算/安全阀 → `store.incrementTurn()` → **重新**读一次快照 → `renderGoalTurnPrompt(current)` → `runner.runTurn(sessionId, prompt, goalId)`。问题是：

- **计轮过早**：轮次在 driver 循环里就落盘，此时既没有 session 执行权，也没有和用户队列、compact 比较过先后。结果是"没真正轮到的轮"也会计数，而"该记的轮"和"正在跑的那一轮"可能对不上；计轮才是准入本身，必须先获准再计。
- `GoalTurnRunner` 的签名把 prompt 文本当参数传，渲染归属在 driver，展示文本根本没有位置；
- `incrementTurn` 落盘失败时内存不变（`store.ts` 已正确），但 driver 没有稳定的失败出口：占位（本批新增）必须在失败时释放干净。

**本批完成后**：runner 只拿目标身份；准入回调里完成"核对 goalId/active → 计轮落盘 → 从同一快照生成正文与展示值"；`not_admitted` 不计轮、不发消息、等待条件变化后重试。

## 1.3 身份与旧结果回写的现状

- `GoalService.ensureDriving` 只用 `driving.has(sessionId)` 判重，`finally` 无条件 `delete`。旧 driver 还没退出时 resume 会因 map 项存在而直接返回；旧 driver 随后退出，没有新的驱动者（`service.ts:92-122`）。
- 外层 `catch` 只看"当前是否 active"，可能暂停已经替换的新目标（`service.ts:107-117`）。
- `pauseActiveGoal` 不携带本次执行身份；`driveGoal` 的 `cancelled` / `failed` 分支只检查 `store.getSnapshot()?.status === "active"`，无法区分"还是我这一代"还是"新目标恰好 active"（`driver.ts:46-57`）。
- `GoalStore.rebuild` 回放 `update` 记录时不核对 `record.goalId` 就套用 `turnsUsed` / `tokensUsed`（`store.ts:76-98`）。旧目标的迟到记录被追加后，回放会把用量算到新目标头上。
- 用量结算通道过窄：`goalOutcomeFromRunCompletion` 只在 `succeeded` 且 `usageComplete === true` 时回传 token，failed / cancelled 的已知 usage 直接丢（`ui-inprocess.ts:3545-3563`）。

**本批完成后**：driver / service 用进程内 executionEpoch + runId 判断“这次执行是否仍是当前生命周期”；状态回写要求 executionEpoch 与 goalId 匹配，同目标迟到 usage 只要求 goalId 匹配；回放按 goalId 过滤 update 记录；failed / cancelled 也回传已知 usage。

## 1.4 完成与清除的现状

`GoalStore.markComplete` 先 append 一条 `clear` 记录，然后把内存状态清空，再发 completion 变更（`store.ts:181-198`）。后果：

- 同一轮尾部 usage 到达时目标已经不存在，`recordTokenUsage` 又要求 `active`，末轮用量记不进去；
- 当前 `markComplete` 写 clear，不产生新的 complete 残留；历史记录仍可能带 complete，`normalizeAfterReplay` 的补清分支必须保留（`store.ts:293-297`）；
- `UI 立即为空`与"通知一次"依赖 instant clear，一旦改成持久 complete，投影与通知都必须重新确认不重复。

**本批完成后**：complete 先持久化成终态（UI 立即为空、完成通知一次、禁止 resume / replace / 预算编辑），同目标尾部 usage 结算后 clear；无待结算 run 就直接 clear；崩溃回放清理 complete；最终 clear 只做数据刷新，不再发第二条通知。

## 1.5 统计与 token 闸门的现状

- `GoalBudgetLimits` 含 `tokenBudget`，`computeBudgetReport` 把 token 计入 `overBudget` 与 `converging`（`goals/budget.ts`）；
- `SetGoalBudget` 工具单位含 `tokens`（`goals/tools.ts:56-114`），描述与常驻提示都围绕"预算到顶就暂停"；
- 续跑正文（`renderGoalTurnPrompt`）打印 token 数并输出 `tokens remaining x/y` 预算行（`goals/injection.ts:18-43,61-80`）；`formatGoalStatusLines` 同样只有裸 token 数，没有缓存命中与完整性标识；
- 计轮与 usage 都不发 `onChange`，adapter 的变更通知又对每次变更发一条 notice（`ui-inprocess.ts:805-818`、`ui-runtime/composition.ts:975-1004`），所以"刷新数字"和"生命周期通知"目前没有可用的数据刷新通道。

**本批完成后**：token 预算从类型、计算、工具、文案、converging 中全部移除；total / cached / 完整性沿 `RunCompletion.usage → GoalTurnOutcome → store → snapshot → 查询输出` 传递；计轮与 usage 刷新走纯数据刷新（`goal.updated`），不发 notice；运行时提醒无 token，查询保留明细并标注部分统计。

## 1.6 与本批无关但要注意的现状

- `GoalStoredStatus`、`normalizeStoredStatus`（blocked → paused）、`pauseReason` 语义改造是第 3 批；本批保留现状，不写 blocked。
- `renderGoalContextNote`（paused 轻提示）与 displayText 落库是第 5 批；本批只保证准入时同时产出正文与展示值，不接 UI。
- `docs/goals/` 下的模块文档（architecture、data-model、dfd-interface、test）在本批改动落地后需要同步；本批规划阶段不动它们。

## 补充代码核查（2026-10-15，同一基线）

- `GoalStore.replaceObjective`（`store.ts:208–229`）原地编辑，保留 goalId；仅按 goalId 判断会让旧内容的 complete 清掉新内容。计划需同时失效 epoch，保留累计统计。
- `GoalToolBackend`（`tools.ts:20–28`）尚未传真实 runId；可信上下文已有 `core/tool-scheduler/types.ts:106`。身份校验必须贯通到实际工具调用，不能只在 service 单测手工填 runId。
- `service.ts:107–120` 捕获错误后可能连 pause 也写失败；现状不在 finally 重开。计划中的无条件 active 补驱动会新增忙循环。
- `goal-execution-control.ts:29–30` 的后备中断按 session 调用；`ui-runtime/composition.ts:1321–1326` 枚举 session roots。需要限制到捕获的 goal root，不能只校验主 run。
- scheduler 已有 `blockExecutionFinalization` / `recoverSession`（`scheduler.ts:680`），adapter 在 `ui-inprocess.ts:3226` 为 goal run finalization 接线。新 usage 结算恢复应复用此入口；当前 driver 的 outcome 是局部值，现状没有持久 complete 后的这套尾部恢复。
