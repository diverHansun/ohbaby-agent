# 现状与问题

分析基线：`main` 上的 `f42608d4`（2026-11-13）。下面写的都是当时的代码行为，目标设计见 [design](design/goals-duty.md) 和 [02](02-optimization-plan-and-change-scope.md)。路径都相对于仓库根目录。

## 1. 真实会话发生了什么

会话“查后台长期任务支持”（`session_1794538093285_0lzq4l1`）。以下事实来自只读查询 `ohbaby.db` 的 `part` 表，以及在 Web 上打开这个会话看到的实际显示。

| 时间 | 调用 | 当时返回 | 实际情况 |
| --- | --- | --- | --- |
| 10:48:21 | 后台 `bash`：循环 90 次 tick，未传 timeout | `running`，job `69853e79` | 未传 timeout 时用默认值，120 秒后会被杀 |
| 10:48:40 | 后台 `bash`：循环 30 次，`timeout: 5000` | `running` | 5 秒后超时 |
| 10:48:42 | `task_output` 阻塞等待 12 秒 | `timed_out`，5 行输出，`exitCode` 和 `signal` 均为 null，`cleanup: in-progress` | 读取时进程树还在清理，拿不到退出事实 |
| 10:48:48 | `task_kill` 第一个任务 | `cancelled`，28 行输出 | 正常 |
| 10:48:55 | 后台 `bash`：心跳 `>> bg_demo.log`，`timeout: 600000` | `running` | 10 分钟后超时 |
| 10:58:55 | 任务被 SIGTERM 杀掉 | — | 没有任何通知 |
| 10:59 | 模型先 `sleep 55` 再调 `task_output` | “Command timed out with no output.” | 命令把输出全部重定向到文件，stdout 本来就是空的 |

这个会话暴露了四个事实：

1. 模型据此得出“超时任务读不到历史输出”的结论，这是误读。返回内容既没有说“捕获到 0 字节”，也没有给运行时长、上限和日志路径，模型只能猜。
2. 任务死掉的时候主代理并不知道，是它自己 sleep 之后再查才发现的。
3. 三次后台 `bash` 的 tool part 里，`state.metadata.status` 至今仍是 `running`。起始调用的记录停在派发的那一刻，之后不会更新。
4. Web 上其实显示了起始调用，但它看上去和普通命令一样：显示 0 秒，没有后台标记。展开后的 `outcome: success`、`cleanup: confirmed` 说的是派发这一步，不是任务本身。用户在第二轮只看到 `task_output`，是因为起始调用在第一轮，而第一轮已经折叠。

## 2. 时限

- 前台和后台共用 `bash` 的 `timeout` 参数：默认 `DEFAULT_SHELL_JOB_TIMEOUT_MS = 120_000`，上限 `MAX_SHELL_JOB_TIMEOUT_MS = 600_000`（`packages/ohbaby-agent/src/tools/shell-job-registry.ts:31-32`），解析在 `packages/ohbaby-agent/src/tools/bash.ts:200-205`。
- 到点后 `terminate(job, "timed_out")` 杀掉整个进程组（`shell-job-registry.ts:267-269, 719-755`）。前台和后台的规则完全相同。
- 这两个值来自执行可靠性第二轮 D14 的“暂保现有期限……第三轮再评估”，之后没有再评估。
- 前台超时一律杀掉。第二轮当时明确决定不做自动后台化命令。

## 3. 监控与通知

**只能轮询。** 主代理了解后台任务的唯一途径是 `task_output`（`shell-job-registry.ts:762-812`）。任务结束、失败、超时都不会通知任何人。

**没有列表。** 只有 `task_output` 和 `task_kill`，没有 `task_list`。模型如果丢了 jobId（比如上下文被压缩后），就找不回这个任务。

**状态只存在内存里。** `ShellJobRegistry` 用一个 `Map` 保存任务（`shell-job-registry.ts:210`），最多保留 100 个已结束任务（`MAX_RETAINED_SHELL_JOBS`，`:36`；淘汰在 `pruneTerminalJobs`，`:635-649`）。服务重启后，所有 jobId 查询都返回 “Unknown shell job”。

**回滚只能靠推断。** `packages/ohbaby-agent/src/services/session/rewind-shell.ts:9-56` 判断后台任务是否可能还活着时，要扫描 tool part 的 JSON：找 `run_in_background = 1`、`cleanup` 不是 `confirmed`，而且没有同一 jobId 的 `task_output` 或 `task_kill` 回执。这说明系统里没有一份权威的任务记录。

**返回信息不够。** 快照（`snapshot`，`shell-job-registry.ts:568-597`）不包含开始时间、运行时长和寿命上限。日志路径只在输出被截断时才附上（`:570-572`）。给模型看的 metadata 只投影了 `jobId`、`status`、`exitCode`、`signal`、`truncated` 这几个字段（`packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts:91-105`）。终止刚开始时就生成的快照，`exitCode` 和 `signal` 都是 null（见 §1 第三行）。

## 4. 用户侧

- Web 的 `ToolCard` 用同一套通用方式渲染所有工具（`apps/ohbaby-web/src/ui/conversation/tool-card.tsx:78-118`），不读后台任务的状态。
- TUI 对仍在运行的后台 `bash` 显示 “Started in background”（`packages/ohbaby-cli/src/tui/components/message/parts/tool-display.ts:74-77`），Web 没有对应的提示。
- 没有列出后台任务的地方，也没有停止入口。子代理有侧栏 Subagents 页和 Stop（`apps/ohbaby-web/src/ui/side-panel/subagents/`），shell 任务没有。
- 按 2026-11-13 的范围修订，improve-1 包含 Web 查看状态和用户单停的最小闭环；后端提供准确数据，Web 负责呈现与操作。用户已确认统一显示当前主会话及其所有子代理的后台任务，标明启动者并允许逐个停止。

## 5. 归属与回收

### 5.1 做得好的部分

- POSIX 下以独立进程组启动（`bash.ts:95-97, 276`）。终止时先对进程组发 SIGTERM，200ms 后发 SIGKILL，再观察是否真的停了（`packages/ohbaby-agent/src/shell/process.ts:178-200`，`shell/constants.ts:2`）。
- “确认已停止”和“未确认”分开记录，清理不会因为工具调用先返回而被丢掉（`shell-job-registry.ts:651-717`）。相关单元测试很完整（`shell-job-cleanup.unit.test.ts` 有 10 个用例）。
- 会话删除时清理该会话和其子代理作用域的任务（`packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:1079-1108`）。服务正常退出时 `dispose` 杀掉全部任务（`shell-job-registry.ts:533-549`）。
- 日志写入 `<会话存储>/tool-results/<jobId>.log`，上限 10MiB（`packages/ohbaby-agent/src/utils/capped-output-file.ts:5`）。

### 5.2 缺口

| 编号 | 问题 | 锚点 |
| --- | --- | --- |
| G1 | 主代理 Stop 只杀本轮启动的任务（`interruptRunTree` → `cancelByRootRun(runId)`），之前轮次启动的不受影响 | `composition.ts:1052-1060`，`shell-job-registry.ts:362-370` |
| G2 | 一轮以失败或取消结束时，本轮启动的后台任务也会被杀 | `composition.ts:828-836` |
| G3 | 子代理正常结束时，只确认前台任务已清理，它启动的后台任务继续运行，直到子代理被关闭 | `composition.ts:954-970`，`observeExecutionCleanup`（`shell-job-registry.ts:382-388`） |
| G4 | 归档会话只检查有没有正在运行的轮次，不处理 shell 任务；轮次结束后归档，后台任务继续运行。之后 daemon 删除已归档会话时也不发布 `SessionEvent.Removed`，内存里的任务仍不会被清理 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的 `archiveSessionInternal`（`3560-3654`），`services/session/archive.ts:66` |
| G5 | 后台任务没有数量上限。按执行可靠性第二轮 D29，后台派遣成功后就归还工具名额 | `bash.ts:338-341` 的 `detachedCleanup` |
| G6 | 服务崩溃时，独立进程组会留成孤儿；没有记录 pid，重启后也不清理 | 内存 registry；无启动恢复 |
| G7 | 日志写满 10MiB 后进程继续运行；结合 D01 后台不限时，就没有任何失控兜底了 | `capped-output-file.ts` |

G1 和 G2 让“任务会不会被杀”取决于它是在哪一轮启动的，用户和模型都很难理解。G3、G4 留下的任务已经没有人会接收它的结果。

## 6. 提示词

- 子代理部分已经有“别切得太碎”的说明：1–2 步的工作自己做、只为真正独立的部分派多个、不要默认填满 6 个执行名额、名额满时不要马上重试（`packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md:74-82`）。
- 后台任务没有任何使用说明。`bash` 的描述只有一句“设置 run_in_background=true 立即返回 job_id”（`bash.ts:180`），`task_output` 只说明机械用法。`base.md` 里没有后台任务一节。
- 调度层的子代理派发上限 `maxSubagentConcurrency: 3`（`packages/ohbaby-agent/src/core/tool-scheduler/constants.ts:6`）不起作用：生产代码里没有工具声明 `capacity: "dispatch"`，`agent` 工具用的是不限量的 `control`（`packages/ohbaby-agent/src/tools/subagent.ts:347`）。模型实际只受 6 个执行名额限制（`agents/subagents/limits.ts:1`）。

## 7. 可复用的现有能力

本节由子代理只读核实。路径相对于 `packages/ohbaby-agent/src`；以 `ohbaby-server/`、`ohbaby-sdk/` 开头的路径在 `packages/` 下。

**运行时输入大部分是通用的，但来源类型在三处写死了。**
- `acceptRuntimeInput` 会检查消息形状、`inputId` 的幂等性、目标轮次是否仍在运行，以及 `(runId, source, sourceId)` 是否唯一，然后保存并唤醒订阅者（`runtime/prompt-scheduler/current-run-inputs.ts:379-394, 731-738`）。只有回滚判断这一条规则是 `subagent-result` 专用的（`:383`）。
- 来源类型在三处被限定：TypeScript 联合类型（`core/message/types.ts:39-48`）、zod 枚举（`core/message/events.ts:36-46`）、SQL 的 `CHECK(source IN (...))`（`services/database/migrations.ts:668`，迁移 028）。新增一种来源，需要照 028 的写法做一次重建表的迁移。

**注入当前轮靠“每步前拉取”。**
- 每次模型请求前，生命周期会调用 `currentRunInputs.beforeStep()`（`core/lifecycle/lifecycle.ts:570`）。这个端口目前只由子代理协调器提供（`agents/subagents/continuation-coordinator.ts:151-159`，在 `adapters/ui-runtime/composition.ts:847-849` 接入）。它先接收新的子代理结果，再返回这一轮所有来源的待处理输入（`current-run-inputs.ts:538-546`）。
- 请求成功并落库后，`confirmRequestSuccess` 记下 `processedRequestId`（`:638-672`）；`beforeFinish` 在还有待处理输入时不让本轮结束（`:692-705`）。这套“接收、尝试、成功确认”的流程可以直接复用。
- 历史过滤 `filterModelHistory` 规定结果类输入只有被处理后才进入历史（`:558-559`），新来源需要决定是否同样处理。

**空闲唤醒基本是子代理专用的。**
- 流程是：执行记录变化 → 监督器 `check()` → `createSubagentWakeup` → 占用会话闸门 → 认领记录 → 用一条 `subagent-status` 运行时输入开启新一轮（`agents/subagents/session-supervisor.ts:113-137`，`adapters/ui-inprocess/subagent-wakeup.ts:149-337`，`adapters/ui-inprocess.ts:1543-1629`）。
- 可以复用的通用部分：会话闸门的预留（`withSessionControl`、`gate.reserve`）、`prepareSession` 的准入检查（`ui-inprocess.ts:1570-1610`），以及带 `runtimeInput` 提交一轮的入口。
- 子代理专用的部分：执行记录上的唤醒字段、`claimWakeup`、`checkWakeup`、Goal 判断（`agents/subagents/execution-store.ts:97-109, 582-650`，`agents/subagents/delivery.ts:127-166`）。
- 开启新一轮的输入类型在三处写死为 `"subagent-status"`（`ui-inprocess.ts:335-339`、`agents/types.ts:77-80`、`subagent-wakeup.ts:96-100`）。轮次的触发来源 `TriggerSource` 只有 `user | goal | subagent`（`runtime/run-ledger/types.ts:9`），运行策略（`runtime/run-manager/policy.ts:11, 19-20`）和 SDK（`ohbaby-sdk/src/contract/snapshot.ts:119`）都按这三种取值写死。
- 防抖规则：上一次唤醒的轮次还在进行，或者被 Stop、被取消，或者已经发出过请求，就不再唤醒；否则按 5 秒 × 2 的幂退避，最多重试 3 次（`delivery.ts:144-165`）。

**崩溃重启后不会扫描所有会话。** 孤儿轮次会被标成 `interrupted`（`runtime/run-ledger/database.ts:278-298`）。启动时只进入当前活动的会话（`ui-inprocess.ts:5233-5243`），其他会话等用户打开、提交或 steer 时才检查。D20“`lost` 等下一轮再带上”和这个做法一致。清理残留进程不能依赖“进入会话”触发，必须在服务启动时全局做一次。

**`task_output` 的阻塞等待不会被用户消息打断。** 等待只在任务结束、`wait_ms` 到时或工具被中止时结束（`tools/shell-job-registry.ts:448-477`）。steer 只是保存输入并调用 `wake(runId)`（`current-run-inputs.ts:506-509`），不会中止工具。`ToolExecutionContext` 里没有“有新输入”的信号（`core/tool-scheduler/types.ts:94-110`）。`CurrentRunInputStore.subscribe`（`:722`）存在，但目前没有生产代码在用。要实现 D19，需要把这个订阅接到工具上下文里。

**存储与迁移。** 迁移集中在 `services/database/migrations.ts` 的 `INITIAL_MIGRATIONS` 数组里，最新的是 `030_subagent_goal_ownership`（`:691`），按版本号逐个在事务中执行（`services/database/index.ts:129-170`）。`run_ledger` 等表通过 `session_id REFERENCES session(id) ON DELETE CASCADE` 随会话级联删除；`subagent_execution` 没有外键，由 `deleteTree` 显式删除（`services/session/archive.ts:141-174`）。子代理执行记录的存储类 `DatabaseSubagentExecutionStore`（`agents/subagents/execution-store.ts:897`）可以作为新表存储类的写法参考。

**日志可直接读取。** 日志目录是 `~/.ohbaby/sessions/<ownerId>/tool-results`（`paths/session-storage.ts:19-31`，`services/session-storage.ts:20`）。`read` 读取这个目录不需要审批（`sandbox/lease.ts:76`，测试见 `tools/session-storage.scheduler.integration.test.ts:70`），写入则需要审批。会话被删除时整个目录会被删掉（`services/session/archive-files.ts:31-42`），归档时不删。

**数量上限目前都不可配置。** 工具并发上限 10 写在常量里（`core/tool-scheduler/constants.ts:3-7`），生产代码创建调度器时不传配置（`composition.ts:455`）。子代理 6 个执行名额、100 个保留任务也是常量。用户可配置的先例只有 `~/.ohbaby/tools/search.json`（`config/tools/search/`）。

**进程身份。** 每个后端进程有一个 owner id `backend_${pid}_${uuid}`（`adapters/ui-persistent.ts:147`），写在 `run_ledger` 等表的 `owner_id`、`owner_pid` 上。`isOwnerProcessAlive` 只用 `kill(pid, 0)` 判断进程在不在，不核对启动时间，所以 pid 被复用时会误判为“还活着”（`utils/process-owner.ts`）。读取进程启动时间的代码只存在于服务端终端模块（`ohbaby-server/src/terminal/process-tree.ts` 的 `readProcessTable`、`sameProcess`，用 `ps -o lstart`），agent 包不能直接引用它。

**启动恢复的位置。** 每个工作区后端启动时，`startupReady` 会依次清理孤儿侧聊、恢复活动会话的执行，然后解析启动会话（`adapters/ui-persistent.ts:866-887`）。daemon 层还有 `promptStore.recoverAllInterrupted()`（`ohbaby-server/src/runtime/daemon/main.ts:178-190`）。

**删除路径不一致。** daemon 删除已归档会话走的是 `deleteArchivedSession`（`services/session/archive.ts:66`，由 `ohbaby-server/src/runtime/daemon/main.ts:563` 调用），这条路径不会发布 `SessionEvent.Removed`，所以 `composition.ts:1078-1112` 里的 shell 任务清理不会执行。在 D24 让归档时就清理任务之前，这也是 G4 的一部分。

## 8. 文档与实现对照

| 文档 | 文档说 | 代码做 | 差距 |
| --- | --- | --- | --- |
| `docs/tools/data-model.md:177-183` | `timeout` 是前后台共用的生命周期，到点 `timed_out`；最多保留 100 个 job | 一致 | 本议题要改：前后台分开、新状态模型、持久记录 |
| `docs/tools/architecture.md:184-186, 400` | 后台返回 `jobId/status/truncated`；生命周期默认 120 秒、上限 600 秒 | 一致 | 同上 |
| `docs/tools/dfd-interface.md:315-344` | “v1 不落盘、不返回 `outputPath`” | 已经落盘到 `<jobId>.log`，截断时返回路径（`docs/tools/architecture.md:382` 也这么写） | 文档自相矛盾，dfd-interface 已过时 |
| `docs/shell/data-model.md:32` | ShellJobRegistry 的五个状态与前后台清理合同不变 | 一致 | 本议题要改状态集合 |
| `docs/core/tool-scheduler/data-model.md` | 记载 `maxSubagentConcurrency` 和 `dispatch` 名额 | 名额类别存在，但没有工具使用 | D14 删除，文档同步 |

## 9. 测试现状

- 已有覆盖：超时、取消、按根轮次取消、按作用域清理、阻塞读取、进程清理证据，共 56 个用例（`shell-job-registry.unit.test.ts` 17 个、`shell-job-registry.integration.test.ts` 4 个、`bash.unit.test.ts` 25 个、`shell-job-cleanup.unit.test.ts` 10 个）。
- 缺口：没有任何关于服务重启后任务状态、归档、子代理正常结束后后台任务去向、Stop 与后台任务关系的测试。通知和持久记录目前不存在，自然也没有测试。

## 10. SWE 判断

- **缺少唯一的事实来源。** 任务状态分散在内存 `Map`、tool part metadata 的快照和 `rewind-shell.ts` 的推断里，三处会互相矛盾（§1 第 3 点）。持久任务记录是承重改动，其他改动都依赖它。
- **归属方不清楚。** 现在的回收按“启动它的那一轮”划分，而不是按“它属于谁”划分，于是出现 G1–G4。改为按归属方（会话或子代理作用域）回收，规则会更少，也更一致。
- **职责边界基本合理。** 进程启动和整树终止在 `shell/`，任务生命周期在 `ShellJobRegistry`，生命周期接线在 `composition.ts`。本议题沿用这套分层，不新建服务。
- **避免过度设计。** 不做统一 Task 抽象、不做增量游标、不做跨重启存活，这些都已在 00 列为不做。
