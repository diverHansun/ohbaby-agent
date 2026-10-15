# goals 数据流与接口

> 版本范围：goals 升级第 2 批的实施后文档，只描述本批阶段状态；上级目录保留原始设计，后续批次尚未包含。原始规划与验收标准见 [improve-2 方案](../../problem-lists/2026-10-13-goals-upgrade/improve-2/02-optimization-plan-and-change-scope.md)和[测试标准](../../problem-lists/2026-10-13-goals-upgrade/improve-2/04-test-and-acceptance.md)，实际验证与限制见[实施验收](../../problem-lists/2026-10-13-goals-upgrade/improve-2/05-implementation-acceptance.md)。

本文件描述 improve-2 的模块边界。领域概念见 [data-model.md](./data-model.md)，内部结构见 [architecture.md](./architecture.md)。

## 一轮执行的数据流

```text
create / resume / objective 实改
  → GoalService 提交状态、更新 epoch，区外 ensureDriving
  → driver 固定捕获 goalId + epoch，检查状态与预算快路径
  → adapter runner.runTurn(sessionId, goalId, epoch)
      → 先订阅 gate 唤醒
      → 一个 owner 条目：身份/预算/恢复/用户队列/gate 检查
      → admitTurnInBoundary：append 轮数，从新快照生成票据
      → reserve(sessionId, ticket.token)
      → 区外准备，绑定 runId，startSession，等待 completion
  → GoalTurnOutcome（ticket + usage + release）
  → runner.finishTurn → service.settleTurn
      → 同一 owner 条目：usage → settled 标记 → 必要时 clear
      → 成功或 recovery 登记后释放 token lease
  → 当前 goalId/epoch 仍匹配且 active 才继续下一轮
```

未获准返回 not_admitted，不计轮、不发消息。繁忙等待在 runner 内事件驱动完成；已准入后的准备取消返回 cancelled 并携票据结算。succeeded 继续读态；failed/cancelled 仅能暂停同一生命周期。

## 模块端口

| 接口 | 契约 |
| --- | --- |
| `withSessionMutation(sessionId, op)` | adapter 注入 owner.runControl；仅包读改写状态，不等待初始化或运行中断 |
| `currentExecutionEpoch` / `isExecutionCurrent` | 同步判断当前目标与生命周期资格 |
| `admitTurnInBoundary(sessionId, goalId, epoch, available)` | 调用者已在 owner 区内；先检查身份与预算，available 后计轮并返回 ticket/null |
| `GoalTurnRunner.runTurn(sessionId, goalId, epoch)` | adapter 负责等待、准入、gate 占位与执行，输入不再是预渲染正文 |
| `GoalTurnRunner.finishTurn(sessionId, ticket, outcome)` | adapter 串接 service 结算与 scheduler 恢复；返回票据的 runner 必须提供 |
| `bindTicketRun` / `getTicketForRun` | 准备票据与可信 run 身份绑定；工具运行前完成绑定 |
| `settleTurn(sessionId, ticket, outcome)` | 使用 outcome 按 goalId 记 usage，成功后标 settled，再按需要 clear；失败保留票据 |
| `pauseExecution(sessionId, goalId, epoch, reason)` | driver 异常/取消回写，区内再次校验捕获身份 |
| `resolveMutationContext(sessionId, runId)` | adapter 区分普通用户主 run、goal ticket 与无效身份；未找到 ticket 不等于普通用户权限 |
| `GoalExecutionControlPort.interruptGoalExecution(input)` | 传 sessionId、reason、includePrimary、捕获 ticket 和 expectedRunId；只中断对应 root |
| `GoalPersistencePort.append/list` | 数据库负责字节存储；goals 负责 schema、先持久后改内存和回放 |

工具 backend 的 createGoal、setBudget、updateGoalFromModel 接收 context.runId 内部参数，不把它加入公开 schema。普通命令可不带模型 runId；配置生产 resolver 后模型缺失 runId 必须拒绝。GetGoal 不经过 mutation 门禁。

## 停止、替换与恢复

pause/cancel 先在 owner 条目内捕获旧票据、持久化停止、失效 epoch 并取消准备，区外再 await 中断。runReady 交接后重新核对预期 runId，只处理捕获的 stopIntent；子代理按同一 rootRunId 中断，不能 session 兜底清扫。

complete 使用 includePrimary:false，允许主 run 输出最后回复；objective 编辑和 create(replace:true) 不主动中断已启动旧 run。准备取消仍然生效。旧票据不能修改替代目标，迟到 usage 也不能进入新 goalId。

runtime finalization 未确认时，adapter 保留可辨认的恢复分支，复用 scheduler.blockExecutionFinalization / recoverSession。一个恢复闭包依次 retryFinalization → 使用真实 completion 提取 usage → settle/clear，每个成功阶段只做一次。恢复登记先于 lease 释放；driver 不再结算已转交的票据。恢复只补持久化，不自动续跑。

## 提醒、投影与 compact

准入后生成 modelText/displayText：首轮 `Goal started`，续轮 `Goal auto-continue (turn N)`。完整正文写入 history；后续 UI 批次将展示值同时接到实时和刷新路径。paused light note 只加入普通请求的模型输入，不驱动执行。

GoalChange 的 created/lifecycle/completion 继续表达业务事件；incrementTurn、recordUsage、最终 clear 发 progress，仅 publishGoalUpdated，不发第二条 notice。UI 可把 complete 投影为无当前目标，而内部仍保留结算状态。

目标记录独立于消息历史，compact 不改变预算与累计统计。initSession 在业务变更前完成恢复；重启 active→paused，complete→clear，不自动启动 driver。

恢复闭包保留已取得的 outcome；不在票据中复制它。driver 的 `not_admitted` 直接结束该代，合法等待已由 adapter 内部承担，关闭服务不会空转。

`getActiveGoalRunForSteer(sessionId)` 是 adapter 内只读挂点：在 owner 边界内同步验证 active、goalId、epoch、当前 goal run 和输入接收/封口状态，返回 `{runId, goalId}` 或 undefined。不分流输入、不取得 lease；第 4 批实际 steer 仍须由输入事务复核。

准备取消通过 `preparationSignal` 穿过 AgentService、AgentRun 到 RunManager。在 agent 配置、session、消息、pending ledger、sandbox 和 running ledger 等待期间保持有效；`markRunning` 完成后同步移除监听，之后只有显式 stop intent 才能中断主 run。普通运行期 `signal` 的语义不变。

关闭先封闭准入并唤醒等待者，runtime 取消与 goal driver 收尾并行推进；join 全部 goal driver 后再处理 scheduler 的恢复槽。这样 late usage 写失败登记的恢复也纳入同一次关闭，仍受既有 shutdown deadline 限制，未完成不能返回 confirmed。
