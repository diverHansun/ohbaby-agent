# goals 模块架构

> 版本范围：goals 升级第 2 批的实施后文档，只描述本批阶段状态；上级目录保留原始设计，后续批次尚未包含。原始规划与验收标准见 [improve-2 方案](../../problem-lists/2026-10-13-goals-upgrade/improve-2/02-optimization-plan-and-change-scope.md)和[测试标准](../../problem-lists/2026-10-13-goals-upgrade/improve-2/04-test-and-acceptance.md)，实际验证与限制见[实施验收](../../problem-lists/2026-10-13-goals-upgrade/improve-2/05-implementation-acceptance.md)。

本文件描述 improve-2 落地后的结构；职责见 [goals-duty.md](../goals-duty.md)，领域概念见 [data-model.md](./data-model.md)。本批仍使用 `active`、`paused`、`complete`，不引入 blocked 审计、自动 steer 或精确 deadline。

## 组件与依赖

| 组件 | 职责 |
| --- | --- |
| `GoalService` | 缓存各 session 的 store，串行化变更，持有 executionEpoch、准入票据与单个 driver，校验工具身份 |
| `GoalStore` | 生命周期与预算规则，先 append 成功再提交内存，从记录回放；不加第二把锁 |
| `driveGoal` | 固定捕获 goalId/epoch，读态、预算快路径、请求 runner、结算结果并决定退出 |
| `injection.ts` | 纯函数生成完整续跑正文、paused light note 与查询状态文字；转义不可信内容 |
| `tools.ts` | 四个工具及参数校验；把可信 `context.runId` 传到后端，runId 不进入模型 schema |
| `persistence.ts` | append/list 端口及数据库实现；消息 compact 不影响目标状态 |
| adapter / scheduler | session owner 队列、执行 gate、用户优先、run 提交、中断与 finalization 恢复 |

命令、工具与 driver 通过 service 修改状态，service 只依赖注入的窄端口，不 import adapter owner 或 scheduler。driver 接收 `GoalTurnOutcome`，adapter 负责从 `RunCompletion` 转换执行结果与用量。

## 变更边界与准入

公共变更分三段：区外初始化 → 一个 `withSessionMutation` 条目内读、校验、append、提交内存与失效 epoch → 区外等待中断或启动驱动。不能把整个方法放进 owner 条目，否则初始化、runReady 或执行中断可能等待同一队列并死锁。

`runTurn(sessionId, goalId, executionEpoch)` 先订阅唤醒，再在一个 owner 条目内检查目标、预算、finalization 恢复、用户队列和执行 gate。service 的 `admitTurnInBoundary(..., available)` 在预算检查后确认可用性，append 轮数，再从计数后的快照生成正文和展示值。adapter 随即以票据 token reserve goal lease。未准入不计轮、不发消息；已准入后取消准备仍算这一轮。

首轮展示值为 `Goal started`，之后为 `Goal auto-continue (turn N)`。本批传递该契约，实时与持久展示的成对接线按后续 UI 批次完成。续跑正文作为普通 user 消息进入持久 history；paused light note 只作为普通用户请求的模型前缀。

## 执行身份与停止

create、真正的 resume、pause、cancel、complete 和 objective 实改在提交后递增 epoch；预算变化与同文编辑不递增。driver 每次循环使用启动时捕获的 epoch，不跟随新生命周期。清理 driving 项按 promise 身份判断，新目标或新 epoch 再安排自己的循环；已有循环退出期间的显式 resume 保留一次驱动请求。运行失败且 pause append 也失败时，不因磁盘仍 active 自动重开同代。

票据从 reserve 起存在，包含 goalId、epoch、轮号、token、准备 controller、正文/展示值、可后绑 runId、settled 与 recoveryPending。准备期间以独立 preparationSignal 覆盖内部 await，直到 running 落盘后的同步交接点解除监听；worker 已启动后仅执行捕获的 stopIntent。pause/cancel 停主 run，complete 的 `includePrimary:false` 允许主 run 收尾；objective 编辑与新目标替换允许已启动旧 run 收尾。中断只针对捕获的 goal root runId 及其子代理，不按 session 清扫后继用户执行。

## 结算与恢复

complete 先 append `status:"complete"` 并发一次 completion。没有待结算票据时立即静默 clear；否则等待尾部 usage。usage 按 goalId 匹配，即使 epoch 已失效、状态已 paused/complete 也可结算，永不拉回 active。业务失败/取消回写同时要求 goalId 与 epoch 匹配。

同一 owner 条目内先 append usage，成功后标记 ticket.settled，再按需要 clear；clear 失败保留 ticket 与 complete，重试不重复 usage。执行 lease 在首次结算成功，或 adapter 已登记阻断后继执行的 recovery 后才释放。runtime finalization、usage、clear 共用一个顺序恢复闭包，复用 scheduler 的现有恢复入口，不新增账本或恢复队列。恢复只补持久化，不恢复自主执行。

## 预算与压缩

仅轮数、累计 active 时间参与预算；tokens/cache 是统计。预算必须来自用户、system 或 developer 明确限制。1000 轮安全阀始终有效，测试可注入低值；预算与安全阀本批到顶均 paused。时间不含 paused 区间，本批仍在 continuation 边界检查。

目标记录独立于消息 history。compact 可压缩旧提醒，但不能改变 goalId、累计轮数、用量或预算；下次准入始终从当前 store 快照重新生成正文。重启把 active 降为 paused，complete 残留直接 clear，不补造丢失的尾部用量。

关闭时先停止准入、唤醒等待者，然后等待全部 goal driver 的尾结算，再处理 scheduler 既有恢复槽。超出原有关闭期限返回 unconfirmed，不能把尚未落盘的末轮用量当作已完成。
