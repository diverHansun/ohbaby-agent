# 1. 当前代码、问题与设计差异

> 基线：2026-09-21，`039dca95` / v0.1.13。前三轮仍为规划。本次为源码与文档调查，未运行新的崩溃复现或性能测试；原始真实 serve 诊断见[证据](../evidence/2026-09-19-serve-stalled-tools.md)。下列路径相对仓库根，行号只是基线定位，符号优先。

## 1.1 承重问题

| ID | 当前缺口或风险 | 证据 | 目标方案 |
|---|---|---|---|
| P1 | 会话父子关系不足以隔离同一实例的多次委托；直接 parent 查询不等于整棵任务树 | composition `interruptRunTree`；subagent-host `interruptByParent` | 02 §2.2～2.3 |
| P2 | 主执行完成与外部资源清理耦合/脱节并存，不能直接证明安全交接下一 Run | run-manager `finalizeRun`、scheduler deferredRelease、runtime dispose | 02 §2.3～2.4 |
| P3 | 中断后旧子 pendingQueue 会在下次调用被继续消费 | subagent-host enqueue/drain；七月方案 | 02 §2.3 |
| P4 | serve stop 发信号即报 stopped；关闭入口的等待上限不一致 | daemon main `stopDaemonFromState`；Supervisor | 02 §2.5 |
| P5 | 冷启动主动加载 queued 工作区并 drain，与本轮保留待发送冲突 | daemon main `createServerRuntime.start`；scheduler.init | 02 §2.6～2.7 |
| P6 | 恢复分散在 prompt/run/child；queued 尚无提交环境归属，不能安全全库批量改写 | 各 database store；prompt insert/claim | 02 §2.2、§2.6 |
| P7 | 工具缺失结果、恢复失败与正常 idle 缺乏统一恢复门槛和解释 | UI reconcile、message 工具状态、ledger恢复 | 02 §2.6 |
| P8 | 现有队列整行点击编辑、X 删除，尚无重启保留消息的单条发送语义 | Web App、SDK prompt 操作 | 02 §2.7 |

## 1.2 职责与架构现状（goals-duty / architecture）

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:613` 将普通 prompt 交 `submitPromptInternal`，后者在 `:2171` 调 `nextRunId`，在 `:2203` 启动同一 session 的新 Run。`agents/service.ts` 创建轻量主 AgentInstance，不新建 OS 进程。`adapters/ui-inprocess/runtime-controller.ts::getRuntime/acquireRuntime` 复用 runtime，配置版本变化才考虑重建。因此独立 runId 本身不是昂贵重启。

`adapters/ui-runtime/composition.ts:266` 在 runtime 级创建共享 tool scheduler；`:642 interruptRunTree` 先取消主 run，再通过父 session 调 host。`agents/subagent-host.ts:304 interruptByParent` 查询直接 parentSessionId 的活动实例，设置不继续 drain 并取消。**该函数本身没有递归整树；不能仅凭名字断言所有嵌套和新派遣竞态已覆盖。**

`runtime/run-manager/manager.ts::finalizeRun` 登记终态后，还会 release sandbox、结束事件流、删除活动索引。`ui-inprocess.ts:2269` 等 run completion 与 projection.done，finally 还进行 todo、统计、快照和 admission 收尾；这些都会影响 A→B 的交接。需要测具体路径，当前不能给出毫秒级保证。

`finalizeRun` 的 catch 还会在 ledger 写失败时填内存终态，finally 仍发布、结束流并移除 active。这与本轮“停止登记成功后才推进 B”的要求有直接差异；不能只改 Stop 入口而沿用该成功收尾路径。

## 1.3 数据模型与身份（data-model）

| 实体 | 当前用途 | 风险 |
|---|---|---|
| Session/context scope | 保存会话历史和执行上下文 | 同 session/scope 被复用，不代表同一次委托 |
| Run/runId | 主执行、取消和 ledger | 子执行不一定都经过 primary RunManager，不能强制塞入主 ledger |
| 子代理实例/currentRunId/pendingQueue | 复用实例、串行子任务、恢复 | latest status 不可替代每次 execution；旧 queue 仍有资格 |
| PromptSubmission | 用户普通提交、队列、终态、用户消息关联 | 当前 queued 插入时 ownerId/ownerPid 为空，claim 后才写 owner |
| ToolPart / shell job | 调用结果、内存进程句柄 | jobId、callId、runId 不能互相代替；内存句柄不能冷恢复 |

锚点：`runtime/prompt-scheduler/types.ts`、`database-store.ts:210` 的 insert、`:439` 的 claim；`agents/subagents/types.ts`；`tools/shell-job-registry.ts:153` 的 Map；`runtime/run-ledger/database.ts`。

当前 scopeKey 是项目目录（`adapters/ui-persistent.ts:529`），并不是 TUI/serve 身份。即使筛同一个 scope，也不能认定所有 queued 属于刚退出的进程。

2026-09-23 字段复核：现有 `prompt_submission`、run ledger、子实例均已有 owner 字段。“旧格式”不等于完全没有 owner 列，而是普通消息 `accept` 尚未填写归属。`ui-persistent.ts:472` 创建 backendOwnerId，`:531` 将其交同一个 prompt store；接受和执行没有独立的两类 backend。`database-store.ts::claim`（L440）目前覆盖 owner 且未按原归属过滤，`requeueBusy`（L499）会清空它，`listQueued`（L571）仅按 scope 查询；因此复用一对 owner 时必须一起修正这些入口，不能只补 INSERT。

`services/database/index.ts::applyMigration/runMigrations`（L136/L161）已有逐版本事务、版本登记和失败回滚；`migrations.ts` 的 `014_prompt_submission` 对 status 设置 CHECK，当前只允许七种状态，新增 retained 不能只改 TypeScript。现有 accepted 时间只有 created_at，updated_at 又会被租约续期更新，不能直接替代重发的接受时间。迁移方案可在这套框架内扩展，无需新迁移服务，见 02 §2.9。

`run-ledger/database.ts::isOrphaned` 使用 owner PID，unknown owner 由显式选项控制。`subagents/database-store.ts::markInterrupted` 有 owner/run 条件。`prompt-scheduler/database-store.ts::recoverAllInterrupted` 跳过仍活的 owner PID；但 `recoverInterrupted(scopeKey)` 的 SQL 仅按 scope 和 starting/running 更新。实施必须逐一确认调用入口，不把 scope-only 批量方法当作安全的多环境恢复入口。

## 1.4 数据流与取消接口（dfd-interface）

`runtime/prompt-scheduler/scheduler.ts:568` 的 finally 清除匹配活动项并再次 requestDrain，支持正常结束/Stop 后推进 B。新增停止逻辑若一概暂停队列，会违反用户确认。

`subagent-host.ts:625` 从 persisted.pendingQueue 复制旧队列并加上新输入，`:756` 才为实际执行创建 runId；`finishInterruptedRun` 清理当前运行但保留队列。第三轮计划增加排队即有 executionId，第四轮须按其实际接口把旧委托退队，而非删除整实例。

`tools/bash.ts:160` 启动进程，background 分支在 `:192` 提前返回，位于前台 abort 监听之前；后台取消须穿过 registry，不能只依赖工具调用 Promise。`shell/process.ts` 已有平台终止逻辑。第二轮将补逻辑结果/实际清理分离，本轮只补精确归属与整树触发。

2026-09-22 补查保存故障：`run-manager/manager.ts::finalizeRun`（L303）接住 ledger 终态保存错误后仍执行 `endStream/removeActive`；`prompt-scheduler/scheduler.ts::fault`（L638）却把整个 scheduler 标 closed 并拒绝所有 completion waiter。两者没有统一的按受影响范围保留、重试和交接契约。页面重新打开本身不等于这些状态会恢复，02 §2.6 的共享恢复入口属于本轮新增设计。

`services/database/busy-retry.ts` 仅对 SQLITE_BUSY/locked 默认再试 3 次；`services/database/index.ts` 另设 `busy_timeout = 5000`。现有等待包含同步阻塞，不能将小退避间隔当作整次保存耗时，也不能通过叠加外层重试实现所谓“有限恢复”。实施需共同核定次数/总预算。

第三轮已规划accepted Steer的持久输入，但“接受”和“实际尝试发送”不能混为一谈；第四轮未发送提示依赖第三轮补齐请求证据。用户确认在queued卡片上方提示，不改成历史消息旁标记，不引入截图中的队列暂停。当前代码/旧方案没有该完整闭环，目标与责任见02 §2.7、第三轮02 §2.6。

## 1.5 服务退出和用户场景（use-case）

- `ohbaby-server/src/runtime/daemon/supervisor.ts:19` 默认退出上限 10 秒，signalHandler 调 stopWithTimeout 后 process.exit；`:147 stop()` 本身没有同一包装。
- `daemon/main.ts:515` HTTP onShutdown 和返回的 stop handle 调 `supervisor.stop()`；不同入口不能假定具有同样期限。
- `daemon/main.ts:818 stopDaemonFromState` 核对 pid lock/token 后发 SIGTERM，马上返回 stopped；这是已查实的退出反馈缺口。
- `daemon/server.ts::stop` 先 dispose 工作区/app，再停止监听。关闭期间何时禁止新入队和启动，需统一在接收与调度边界定义。
- `composition.ts:1027 dispose` await shell/subagent/run 和 pendingLifecycleCleanups，没有这一层的整体期限。底层库不能简单加 process.exit，否则会杀掉嵌入宿主。
- `ohbaby-cli/src/tui/app.tsx:459` 在有任务/审批时 Ctrl+C 中断，空闲时 exit；`cli/commands/terminal.ts:121` finally dispose host。TUI 按键与 serve 进程信号不是同一个入口。
- `ohbaby-cli/src/tui/components/prompt/index.tsx:175,422` 的Alt+↑只编辑最后一项，Ctrl+D仅在编辑中取消该项；尚无任意queued/retained选择操作。第四轮02 §2.7给出沿现有区域的键盘接线，不能只凭列表可见就认定支持逐条管理。

刷新 Web、服务复用、切换会话不会创建新的执行环境。真正冷启动路径 `daemon/main.ts:162` 恢复后读取 listScopesWithQueued 并加载工作区；scheduler.init `:105` 主动 drain，因此现有实现与“重启后手动发送旧消息”不一致。

Web `apps/ohbaby-web/src/ui/App.tsx::beginQueuedEdit/finishQueuedEdit` 已有编辑租约、原草稿保留与保存；`:3095` 整条消息是编辑按钮，删除图标为 X。本轮调整入口和恢复消息语义即可，不需要新页面。

## 1.6 可靠性、性能和测试现状（non-functional / test）

逻辑取消不能证明外部副作用撤销；detached shell 在宿主崩溃后可能存活，这是源码可推导的风险，尚未在本轮实测。进程内不合作工具若仍持有写入能力，同进程新 Run 必须继续受保护；冷启动内存保护已消失，不能伪称仍有隔离。

现有 unit/contract/integration 测试覆盖 scheduler、subagent store、run manager、Supervisor、全局 serve 和 Web 队列，但不能据文件存在证明以下组合已经通过：整树新派遣竞争、A 中断后 B 与旧清理并存、queued 提交归属、修复中再次崩溃、服务退出实际确认。04 必须补可控并发和真实子进程证据。

关键测试入口：`agents/subagent-host.unit.test.ts`、`agents/subagents/database-store.integration.test.ts`、`runtime/prompt-scheduler/{scheduler.unit,database-store.integration}.test.ts`、`ohbaby-server/src/runtime/daemon/{supervisor.unit,main.unit,global-single-serve.integration}.test.ts`、Web `App.unit.test.tsx`。路径按包前缀定位；本次不运行产品验收测试。

## 1.7 SWE 原则审视

- **复杂度与职责：** 保留各模块的执行、存储、投影职责，由 runtime 装配停止/恢复，不让 scheduler 直接写会话 DB，也不在 UI 自行判断进程是否死亡。
- **身份与信息隐藏：** 用户只看任务中断和待发送消息；run/execution/owner 的检查在后台完成，不把恢复复杂度变成一排按钮。
- **最小改造：** 复用共享 scheduler、registry、SQLite 和第三轮 execution/result，不为本轮新造分布式任务系统。
- **KISS/YAGNI：** 复用现有 owner 列及版本化事务迁移；只为重新入队新增接受时间，恢复元数据按真实读取需求扩展。支持旧数据升级即可，不为当前无需求的新旧程序混用建设兼容系统。
- **可测试性：** 把停止登记、领取任务、持久化提交、清理确认做成可注入故障的边界；不靠长时间 sleep 或真实模型概率复现判断正确性。
- **取舍：** 允许 B 与旧清理并行提升响应，但需要更严格的归属和资源存续；本轮放弃跨重启进程管理，接受外部结果未知的明确边界。

## 1.8 文档与实现差异、权威关系

| 文档 | 原要求/描述 | 本轮关系 |
|---|---|---|
| [七月子代理方案](../../../agents/2026-07-09-subagent-context/02-implementation-plan.md) | 显式新 prompt 后先 drain 旧 pendingQueue | D4 明确替换：旧委托退队留记录，实例可复用 |
| [run-ledger 数据模型](../../../runtime/run-ledger/data-model.md) | interrupted 主要指崩溃；描述批量修复 running/pending | D2/D6 扩展用户 Stop 为执行中断，并要求 owner-aware；不得按旧文字全库打断 |
| [第二轮 02](../improve-2/02-optimization-plan-and-change-scope.md) | cleanup 未确认不释放保护；后台 Bash 派遣返回释放调用槽 | 本轮保留；补所属任务取消，不能宣称后台进程全程持有危险槽 |
| [第三轮 02](../improve-3/02-optimization-plan-and-change-scope.md) | 完成结果/交付持久化；父终态后不自动唤醒；完整冷恢复留给第四轮 | 本轮补恢复排序和资格，不另造结果交付系统 |
| [七月普通队列方案](../../2026-07-12-workspace-prompt-concurrency/00-discussion.md)及当前启动代码 | 持久队列恢复后可继续调度 | D6 修订仅冷启动遗留项；正常 Stop 推进保持 |

实施时同步受影响模块的原设计/接口说明，并给历史方案加明确后继引用；本次不把原文改成“已实现”。各模块当前路线入口沿[总 README](../README.md)，第四轮契约集中在 02/04。
