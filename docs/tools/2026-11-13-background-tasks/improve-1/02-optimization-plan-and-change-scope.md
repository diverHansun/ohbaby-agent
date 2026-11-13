# 改造方案与关键改动

规划基线：`f42608d4d90060c6d93ac6e0caeac13df63059bf`。这是实施契约，尚未实施；2026-11-13 已同步显式后台的范围确认，本次收尾工程契约见 design 与本文，前端默认视图仍按 [00 §5](00-discussion.md#5-收尾边界) 留给后续前端任务。本轮所有 Stage 都属于 improve-1。模块设计见 [design](design/goals-duty.md)，验收见 [04](04-test-and-acceptance.md)。路径默认相对于 `packages/ohbaby-agent/src`。

## 1. 方案总览

给每个 shell 任务建一份持久记录，作为状态的唯一来源。状态模型保留现有五种状态并新增 lost，共六种，停止原因另列。回收规则从“按启动它的轮次”改为“按归属方”。显式后台任务结束后，用一种独立来源的运行时输入通知主代理：主代理忙时注入，空闲时唤醒。前台保持超时停止，自动转后台延期至 improve-2。服务崩溃后，启动时仅把内部启动占位或仍记为 running 的遗留任务标成 `lost`，身份核实无误时清理残留进程。当前交付后端查询、输出、单停与事件契约；Web/TUI 实现暂缓。

| 决策 | 选择与理由 | 未采用方案及代价 |
| --- | --- | --- |
| 事实来源 | 新表 `shell_job`，前台后台都记（D15）；内存保留运行及未完成清理/输出/资源释放的对象 | 不继续靠 tool part 推断；启动、停止意图、结果与晚到事实按实际阶段写库 |
| 状态模型 | `running/completed/failed/timed_out/cancelled/lost` 加 `stopReason`（D06、D23、D24） | 不将 timed_out、cancelled 合并为 stopped；旧值继续有效，未知原因保持未知 |
| 回收 | 按归属方 `(sessionId, contextScopeId)`；Stop 和轮次失败只停前台任务（D04） | 不再在轮次结束时 `cancelByRootRun`；回滚仍按轮次 |
| 时限 | 前台 2/10 分钟，到时停止；显式后台默认不限，显式 timeout 最长 24 小时（D01、修订 D13） | 自动和手动转换留 improve-2；本轮不引入转换政策或 `sleep` 特判 |
| 失控兜底 | 按归属独立限制后台任务：主代理 10、每个子代理 5，清理未确认仍占名额（D08）；累计输出 1GB 时停止（D23） | 不设全局上限（已知限制） |
| 通知 | 新运行时输入来源 `background-task-result`，新触发来源 `background-task`（D03、D16） | 不复用 `subagent-result` 和子代理执行记录 |
| 防抖 | 每条通知最多自动唤醒一次 | 不照搬子代理的 3 次重试和退避 |
| 崩溃恢复 | 在 `startupReady` 中全局执行；原 owner 已退出且目标 OS 身份和组归属可核验才发信号（D10、D26、D28） | 不依赖“进入会话”触发；Windows 只标 `lost` |
| 名额配置 | `~/.ohbaby/tools/shell.json`：`maxRunningBackgroundJobs` 默认 10（主代理），`maxRunningSubagentBackgroundJobs` 默认 5（每个子代理） | 不做界面设置 |

## 2. 分阶段实施

### Stage 1：持久记录与状态模型

1. 新增 `shell_job` 迁移（规划占位号 031，实施时用下一个可用编号）：新建 `shell_job` 表，字段见 [data-model](design/data-model.md)，`session_id REFERENCES session(id) ON DELETE CASCADE`，并为 `(session_id, context_scope_id, status)`、`(root_session_id, mode, started_at, job_id)`、`(root_run_id)` 建索引。在 `services/database/schema.ts` 登记。
2. 新增 `tools/shell-job-store.ts`：数据库实现和内存实现，写法参考 `agents/subagents/execution-store.ts`。
3. `ShellJobRegistry` 使用六状态模型；先提交启动占位，spawn 后补写实际身份，停止时先保存意图并反馈 UI。正常收尾或有限观察失败后保存已知事实与完整性，设置 `result_ready_at`；晚到事实允许补齐。只有清理确认、输出关闭、资源释放及最终事实持久化完成（settled_at）后才移除内存对象；未确认任务继续被管理。历史查询读库，原按数量淘汰结束记录的逻辑由安全的责任释放流程替代，不能直接删除管理对象。
4. 每次 stdout/stderr 有数据时在内存累加 `output_bytes`；累计达到 1GB 时以 `output-limit` 停止。日志前缀写满 10 MiB 仍截断；仅后台增加持久 output_tail（32 KiB UTF-8）与检查点时刻；纯前台不周期写库、不保存重复尾部。自动转换时首次保存内存尾部，详细契约见 data-model。
5. `bash` 新增可选的 `description` 参数，写入记录。
6. 新增 `tools/shell-job-notice.ts`：状态行渲染（通知正文在 Stage 3 补上）。`task(output)` 的返回改为“状态行 + 输出结尾”，状态行始终说明捕获字节与日志可用性，路径可用才提供；IO故障不伪装零输出。
7. 兼容：前台工具结果 executionOutcome 保持 timed_out→timed-out、cancelled→cancelled；core/context/tool-metadata-projection.ts 与 adapters/ui-state/tool-result-details.ts 保留原值并支持 lost、stopReason 和 cleanup。当前只实现后端/SDK 投影，前端状态展示另行交接，不改写历史。
8. `services/session/rewind-shell.ts` 改为查询 `shell_job`；某个轮次在表里没有记录（旧会话）时，保留现有的 tool part 推断作为兜底。
9. 删除不起作用的派发上限（D14）：`core/tool-scheduler/constants.ts` 的 `maxSubagentConcurrency`、`concurrency.ts` 和 `types.ts` 里的 `dispatch` 名额类别，以及对应测试。同步修改 `docs/core/tool-scheduler/data-model.md`。

完成定义：T01–T06、T29–T31、T33 通过；现有 shell 相关用例按新状态名改写且保留清理保证；旧会话能正常显示和回滚。

### Stage 2：时限与按归属方回收

1. `bash` 的时限分开：后台默认不限，`timeout` 最长 86400000；前台不变。
2. 后台名额：写锁内检查并提交同一任务行的启动占位，提交成功后才在事务外 spawn；合同见 design/dfd-interface。现有事务入口会 await，必须在获锁 callback 内重检准入。按可信归属 `(sessionId, contextScopeId)` 独立计数，主代理默认 10、每个子代理默认 5；前台不占后台名额。后台启动占位、运行中及未放弃追踪的清理未确认任务占名额，名额检查与占用原子完成，spawn/登记失败的回收流程也不能提前释放仍存活进程的名额。达到上限就返回 00 §4 的动态额度报错。新增 `config/tools/shell/`，分别读取 `maxRunningBackgroundJobs` 与 `maxRunningSubagentBackgroundJobs`；共享物理会话的不同子代理作用域仍各自计数。
3. 前台保持超时停止：到达 timeout 后按 `timed_out + timeout` 返回，不生成后台结束通知。模式在启动时确定，只有 `run_in_background: true` 才进入后台名额和通知流程。`bash` 与轮次中止接线只停止本轮仍在等待的前台任务，不影响已启动的显式后台任务；不新增 `promote` 或命令首词特判。
4. 生命周期接线（`adapters/ui-runtime/composition.ts`）：
   - `currentRunInputs.close` 不再调用 `cancelByRootRun`，只处理本轮的前台任务（G2）。
   - `interruptRunTree` 只停本轮的前台任务（G1）。
   - `cleanupExecution`：子代理执行结束时，不论结局如何都 `stopScope(..., "owner-ended")`（G3、D07）。
   - `stopRewoundRunWork` 改用 `stopByRootRun(..., "rewound")`。
   - 会话删除：`stopSession(..., "session-closed")`。
   - 服务退出：`dispose` 记 `shutdown`。
5. 归档、删除及 SideChat 关闭：先封闭准入并停止整棵会话树任务，原因 session-closed；清理未确认时保留记录和日志、返回明确错误，不先删记录后依赖 Removed 事件异步回收。SideChat 仍可使用后台 Bash，不额外收窄产品能力。工作区移动保持现有行为，只影响后续轮次；现有后台继续持有原 cwd/环境/owner，不新增“后台活跃就禁止移动”的限制。
6. 崩溃恢复：process-identity 与 shell-job-recovery 在 startupReady 新调用开放前执行。扫描 status IS NULL 的启动占位、running 及所有未完成清理/收尾责任的记录（含 unconfirmed、settled_at 为空）；只把原启动占位或 running 改 lost。原生出生身份不明不发信号，不用 started_at±2s 或“组成员更年轻”推定归属。prepareOfflineMigration 纳入 shell_job 的活跃/未完成责任 owner_pid 检查，表不存在时兼容跳过；不能沿用只看 running 的通用 SQL。

7. D29/D30：复用有界探测补按需复查；用户专用 abandonShellJob 只记录明确放弃，不伪造清理成功。活 foreign owner 只读，stop/需清理的删除归档返回明确错误；原 owner 已死亡才进入 CAS 认领的保守恢复。具体条件见 design/dfd-interface。

完成定义：T07–T16、T36–T37、T40，以及 T41 的管理归属/回收部分通过；T38 此阶段只验证生命周期、准入和回收旧分支的删除，不提前要求后续通知接线或 task 工厂迁移。

### Stage 3：主代理感知

1. 新增 `background_task_input` 迁移（规划占位号 032，实施时复核编号）：按 028 的写法重建 `current_run_input`，`CHECK` 加入 `background-task-result`。`core/message/types.ts` 和 `events.ts` 同步加入。`current-run-inputs.ts` 的 `filterModelHistory`（`:558-559`）对新来源和 `subagent-result` 一样处理：处理后才进入历史。业务输入的判定（`:597`）把它算作业务输入。
2. 后台结果来源负责 reconcile 和状态确认；与现有子代理来源接入一个轻量输入协调入口。各来源先汇总，之后只调用一次 getMessages/sealSteer/tryCloseForCompletion/confirmRequestSuccess；移除原子代理 port 独占关闭和确认的接线，保留其业务逻辑。批次稳定身份、先分配再接收、失败重投与真实请求消费规则见 data-model，不能用一次 tool output 返回代替消费。
3. 新增 `adapters/ui-inprocess/background-task-wakeup.ts`：任务结束、产生允许唤醒的通知、且主代理空闲时，复用会话闸门和 `prepareSession` 准入，用这条通知作为开场输入提交一轮。`TriggerSource` 新增 `background-task`（`runtime/run-ledger/types.ts:9`，`runtime/run-manager/policy.ts`，SDK `contract/snapshot.ts:119`）。开场输入的类型目前写死为 `"subagent-status"`，三处一起放宽（`ui-inprocess.ts:335-339`、`agents/types.ts:77-80`、`subagent-wakeup.ts:96-100`）。已核实 run_ledger 的列名为 trigger，类型是 TEXT 且没有 CHECK；这里只更新 TypeScript/SDK 枚举，不为该列新增迁移。
4. 通知正文渲染补进 `shell-job-notice.ts`，包括 `lost` 的写法和结尾 2KB 输出。
5. 提供列表/输出/单停服务，主代理及 generic/explore/research 均具有完整管理能力。联合实施直接注册 improve-3 的 task，不先发布临时 task_list。list/output 读取不修改 notice_state；模型主动停止等不通知原因仍按产品表处理。
6. `task(output)` 的 `block` 等待在有新的用户 steer 时提前结束：给 `ToolExecutionContext` 增加一个可选的输入订阅，接 `CurrentRunInputStore.subscribe`（`current-run-inputs.ts:722`），只对本 run 新增的 user-steer 生效。当前 subscribe 回调不带来源，必须结合输入记录过滤，不能把任何 wake 都当作用户消息；Steer 正常返回快照，AbortSignal 取消由 Scheduler 返回取消工具结果，二者都不杀 job。
7. 枚举与消费边界一并更新：PromptOwner、runtimeInput 类型、Goal 票据与启动时可信 goal_id 归属、SDK turn、session-export、side-chat 提示和消息过滤。ToolExecutionOwner 当前没有 goalId；接线时从已校验的当前执行/Goal票据取得并保存，不能由模型输入伪造或靠结束时当前Goal反推。复用 background-task-result，不为开场再造重复的 background-task-status 来源。后台唤醒不得绕过 Goal 的暂停、预算和执行票据；常驻服务不自动阻塞 Goal。具体规则见接口文档。
8. 提示词：主代理 `base.md` 在 Delegating to subagents 之后新增 Background jobs 一节（00 §4）；子代理补充本次执行结束即回收、交付前收齐结果、长期服务由主代理启动、独立默认 5 个额度的规则。子代理使用有界 `task(output)` 等待与结束输入，不照搬主代理“结束本轮等唤醒”的建议。联合实施按最终 bash/task 工具描述同步更新。

完成定义：T17–T23、T34–T35 及 T38 的旧输入独占接线删除通过。T25 先验证 steer 输入与等待服务，最终工具接线和 T24 的实际工具集合随 improve-3 验证，不为阶段验收新增临时 task_list 工厂。

### Stage 4：后端查询、用户单停接口与整体验证

1. 后端提供 `listShellJobs`、输出读取、`stopShellJob` 和带 runtimeEpoch/revision 的 `shell-jobs.invalidated` 失效事件，经 SDK 暴露（[dfd-interface](design/dfd-interface.md)）；输出读取、历史分页和启动者信息按 design/dfd-interface 的完整契约提供。列表覆盖当前主会话及所有子代理，排除其他独立会话；单停只影响目标任务。
2. `UiToolResultDetails` 的 bash 分支补 `stopReason`、`mode`，并能读到任务的最新状态，供后续 Web 起始卡片使用。当前只完成后端/SDK 的状态投影，不修改 Web 组件。
3. 同步权威文档（§6 的 D 项）。Web 的侧栏、筛选、输出详情与停止按钮暂缓，候选界面不作为当前后端验收条件。
4. 全量后端回归，并用真实服务验证 01 §1 所涉及的超时、通知、单停与回收链路；浏览器验收待前端实施后执行。

当前后端完成定义：T26、T27、T28 中的 API、持久状态及真实服务验证，以及 T39–T41 的用户接口部分通过，所属代理收到适用通知。T26–T28 的前端交互/浏览器部分及 T32 留待前端交付；只完成 API 时明确标记“后端完成，前端未实施”。本次分工按用户最新要求调整，不撤销已确认的用户侧能力需求。

## 3. 按包的改动面

| 包或目录 | 新增 | 修改 | 删除 |
| --- | --- | --- | --- |
| `ohbaby-agent/src/tools/` | `shell-job-store.ts`、`shell-job-notice.ts`、`shell-job-recovery.ts`，及测试 | `shell-job-registry.ts`、`bash.ts`、`builtin.ts` | `MAX_RETAINED_SHELL_JOBS` 相关逻辑 |
| `ohbaby-agent/src/agents/builtin/` | — | generic/explore/research 的任务管理工具列表；对应子代理提示词装配 | — |
| `ohbaby-agent/src/shell/` | `process-identity.ts` | — | — |
| `ohbaby-agent/src/adapters/` | `ui-runtime/background-task-inputs.ts`、`ui-inprocess/background-task-wakeup.ts` | `ui-runtime/composition.ts`、`ui-inprocess.ts`、`ui-persistent.ts`、`ui-state/tool-result-details.ts` | — |
| `ohbaby-agent/src/services/` | — | `database/migrations.ts`、`database/schema.ts`、`session/rewind-shell.ts` | — |
| `ohbaby-agent/src/core/` | — | `message/types.ts`、`message/events.ts`、`context/tool-metadata-projection.ts`、`tool-scheduler/*`、`system-prompt/prompts/primary/base.md` | `dispatch` 名额类别 |
| `ohbaby-agent/src/runtime/` | — | `prompt-scheduler/current-run-inputs.ts`、`run-ledger/types.ts`、`run-manager/policy.ts` | — |
| `ohbaby-agent/src/config/` | `tools/shell/` | `tools/index.ts` | — |
| `ohbaby-sdk/src/` | — | `contract/snapshot.ts`、`util/turn.ts` 和 bash 结果详情类型 | — |
| `ohbaby-cli/src/tui/` | — | 后续前端交接：旧历史显示、新 task 展示及 runtimeInput 过滤，不作为本代理代码实施范围 | — |
| `ohbaby-server/src/` | — | 暴露 UI 接口的路由（Stage 4） | — |
| `apps/ohbaby-web/src/` | 后续前端任务 | 本代理不实施；后端/SDK 提供契约 | — |

## 4. 迁移与兼容

- 迁移 031、032 只新增表和放宽 `CHECK`，不改已有数据。032 重建 current_run_input，复用 028 的保留原行写法；028 没有 requiresOfflineBackup 标记。本轮重建迁移显式设置 requiresOfflineBackup，使用现有离线备份机制，不把旧迁移描述成已有此保证。
- 旧会话 tool part 的 timed_out、cancelled 继续有效；缺失原因保留未知，不回写数据库。
- 旧会话没有 `shell_job` 记录，回滚判断保留推断兜底。
- 升级旧版本服务前正常关闭它管理的任务；新版本不接管另一活跃后端的进程。多后端共库迁移沿用离线检查，不能只停 Web 就假设 TUI 也已退出。
- `bash` 的新参数是可选的，旧调用方式不受影响。模型可见状态继续包含 timed_out、cancelled，并新增 lost；提示词和工具描述同步更新。

## 5. 风险与回滚

| 风险 | 应对 |
| --- | --- |
| 生命周期写库增加，SQLite 忙时拖慢命令启动 | 预登记事务提交后才 spawn；沿用现有忙等待，只重试 BEGIN，不因补写失败重跑命令；04 测试忙锁下的启动延迟 |
| 当前轮 Stop 误杀显式后台任务 | 按启动模式区分取消路径；T09、T12 覆盖同轮与跨轮情况 |
| 原生进程身份查询失败或平台能力不足 | 返回 unknown，不发信号；macOS 使用已验证可行的 JXA/proc_pidinfo 路径，实施仍须实测 |
| 通知过多打扰主代理 | 同一归属方合并成一条；每条通知最多自动唤醒一次；有名额上限兜底 |
| Goal 模式下唤醒 | 沿用子代理唤醒的 Goal 判断，T21 覆盖 |
| 删除 `dispatch` 名额类别影响其他工具 | 生产代码里没有使用者；删除前再全局搜索一次 |

版本回退前先停止服务并完成资源回收，保留离线备份。新运行时来源、列和未知枚举可能不被旧代码理解，禁止声称“只增表所以任意旧版本均可直接运行”；实际降级须按兼容测试或恢复配套备份执行。

## 6. 关键改动清单

用户要求简要列出。行号是规划基线时的快照，以符号为准；本表不是进度表，实施时不勾选、不回写。

| ID | 路径与符号 | 行号快照 | 要改什么 |
| --- | --- | --- | --- |
| C1 | `tools/shell-job-registry.ts` · `ShellJobStatus`、`start`、`terminate`、`snapshot`、`pruneTerminalJobs` | 31-43、221-337、568-597、635-649、719-755 | 新状态模型；写库；释放内存；1GB 兜底；`stopForeground`、按归属方停止 |
| C2 | `tools/shell-job-registry.ts` · `createTaskOutputTool`、`createTaskKillTool` | 762-841 | 状态行、精确 steer 打断、读取不抑制；联合实施直接迁至 task 并删除旧工厂 |
| C3 | `tools/bash.ts` · 参数和 `execute` | 180-194、198-336 | `description`；前后台时限；显式后台派发；中止处理 |
| C4 | `adapters/ui-runtime/composition.ts` · `currentRunInputs.close`、`createCurrentRunInputPort`、`cleanupExecution`、`interruptRunTree`、`SessionEvent.Removed`、`stopRewoundRunWork` | 812-849、954-970、1052-1060、1078-1112、1520-1531 | 改为按归属方回收；组合两个输入端口 |
| C5 | `adapters/ui-inprocess.ts` · `archiveSessionInternal`、`rewindSessionInternal`、运行时输入类型、触发来源映射、唤醒接线 | 3560-3654、3944-4030、335-339、4546-4549、1543-1629 | 归档停任务；回滚改查表；接入后台任务唤醒 |
| C6 | `adapters/ui-persistent.ts` · `startupReady` | 866-887 | 调用 `recoverShellJobs` |
| C7 | `services/database/migrations.ts` · `INITIAL_MIGRATIONS` | 661-679（028 写法）、691 | 迁移 031、032 |
| C8 | `runtime/prompt-scheduler/current-run-inputs.ts` · `filterModelHistory`、业务输入判定 | 558-559、597 | 新来源的处理规则 |
| C9 | `core/message/types.ts` · `RuntimeInputOrigin`；`core/message/events.ts` | 39-48；36-46 | 新来源 |
| C10 | `runtime/run-ledger/types.ts` · `TriggerSource`；`runtime/run-manager/policy.ts` | 9；11、19-20 | 新触发来源 |
| C11 | `services/session/rewind-shell.ts` · `assertRewindShellOwners` | 9-56 | 查询 `shell_job`，保留兜底 |
| C12 | `core/tool-scheduler/constants.ts` · `maxSubagentConcurrency` | 6 | 删除（D14） |
| C13 | `core/system-prompt/prompts/primary/base.md` · Delegating to subagents 之后 | 73-82 | 新增 Background jobs 一节 |
| D1 | `docs/tools/data-model.md`、`docs/tools/architecture.md`、`docs/tools/dfd-interface.md` | 按章节定位 | bash 参数、六状态、task 三动作、持久记录；修正 dfd-interface 里“不落盘”的过时说法 |
| D2 | `docs/shell/data-model.md` | 32 | 状态集合与前后台清理合同 |
| D3 | `docs/core/tool-scheduler/data-model.md` | 按章节定位 | 删除 `dispatch` 名额 |

连带影响：`ohbaby-sdk/src/contract/snapshot.ts`（触发来源、`runtimeInputKind`、bash 结果详情）、`ohbaby-sdk/src/util/turn.ts`、`ohbaby-cli/src/tui/store/transcript.ts`、`services/session-export/`，以及所有断言旧状态名的测试。

## 7. 范围检查

- 00 的本轮规则对应：时限（Stage 2.1）、Web 查看与单停（Stage 4）、通知（Stage 3）、Stop（Stage 2.4）、状态模型（Stage 1）、子代理结束（Stage 2.4）、名额与提示词（Stage 2.2、3.7）、输出兜底（Stage 1.4）、崩溃恢复（Stage 2.6）、`description`（Stage 1.5）、显式后台和前台超时（Stage 2.3）、删除死配置（Stage 1.9）、记录全部任务（Stage 1.3）、记录保留（Stage 1.1、1.3）。D13、D21 的自动转换设计已延期。
- 本轮不做：TUI 任务面板、自动或用户手动转后台、任务跨重启存活、全局任务上限、增量输出游标、子代理与后台任务合并。这些都已列在 00 的边界里。
- 已知限制：所有会话合计的后台任务数不设上限；spawn 至 PID/出生身份补写之间崩溃可能留下有占位却无法定位的进程；原 backend 身份无法核实时暂不认领/不杀，并返回恢复不确定性；仅数字 owner_pid 存活不是同一 owner 的证明。

## 8. improve-2 后续范围

2026-11-13 用户明确将自动转后台延期：下一轮再讨论等待阈值与硬超时、模式切换、取消与清理归属、后台名额竞争和手动入口。本轮不预建 `promote`、`promoted_at` 等转换专用能力。用户随后明确要求现在开启 improve-2 讨论，见 [第二轮记录](../improve-2/00-discussion.md)；这不代表 improve-1 已实施或验收。实施前按实际后端基线复核，不沿用旧 D21 的 timeout 取消语义作为既定结论。

## 安全删除与替换验收

用户明确要求安全删除不必要旧模块，不能以新增包装层完成改造。实施中先确认真实消费者、接好替代路径、迁移测试，再删除死分支；不要求旧名字在整个仓库消失，历史夹具与读取兼容有意保留。

| 删除/替换对象 | 条件与保留边界 |
| --- | --- |
| createTaskOutputTool/createTaskKillTool 及旧 builtin 注册 | task 三动作及调用方已迁移；删除旧工厂，不保留可执行别名。旧工具名只用于历史读取、授权兼容及明确的迁移错误。联合实施不先创建临时 task_list 工厂。 |
| dispatch 容量类别、dispatchLimit/count/queue 分支、maxSubagentConcurrency | 全仓核查无生产工具声明此 capacity；迁移合成测试并保留 ordinary/control 行为。真实子代理执行上限不删除。 |
| terminalJobIds、MAX_RETAINED_SHELL_JOBS、pruneTerminalJobs | 历史转由 Store 查询；运行责任只在进程、输出、持久结果和资源释放都完成后释放。不能只删历史上限却继续把全部终态永远留 Map。 |
| observeExecutionCleanup 的正常子代理豁免后台路径 | 当前唯一生产调用在子代理 cleanupExecution；所有结局改走本次执行的完整清理后，删除此路径。cleanupRootRun/按轮次定位仍供回滚使用，不能一并删除。 |
| 旧“主代理当前轮中止杀本轮所有后台”接线 | 改成只停仍处于前台的调用；保留回滚、子代理结束和会话关闭的定向清理，删除语义不明的旧调用分支。 |
| 子代理 continuation 端口独占 seal/close/请求确认 | 公共输入协调入口接好后移除旧独占接线；保留子代理结果准备、投递状态更新和任务专属通知逻辑。 |
| Session.Removed 事件中的主要 Shell 终止责任 | 删除/关闭会话入口已经执行删除前的完整清理；事件只做删除后的投影/文件回收及防御性幂等处理，不作为唯一停止路径。 |
| 六状态旧草案的 stopped 映射 | 未实施，不新增这种兼容代码；保持真实历史 timed_out/cancelled，补 lost。 |
| 无界 sealedRoots 集合 | 替换成有生命周期的准入封锁，优先复用可信执行租约。释放记录后，迟到调用仍须由当前 run 准入拒绝；不能靠 TTL 或直接删 Set 重新开放旧 run。 |
| improve-2 的旧固定模式取消/混用计时分支 | 新提交点、计时及清理归属接线验证后删除；保留纯前台默认超时和其他工具仍使用的通用能力。 |

保留 ShellJobRegistry、killTree、source-cleanup、run-cleanup、环境 retain/release 和 CappedOutputFile 的实际职责；这些不是废弃模块。旧 tool part 的解析、旧会话缺任务表记录时的 rewind 兜底继续保留，且只作用于缺记录的旧数据，不能覆盖新权威任务表。

验收同时检查：类型/import/export 无悬空；生产注册唯一；旧历史和最小注入 deny 测试仍有效；重复启动/退出许多轮后计时器、监听器、等待器、准入记录和可释放 job 数回到稳定基线；未确认清理对象仍保留责任。不要为让静态扫描干净而删除这些异常路径。每项删除在实际实施验收中记录证据，不在规划期宣称已经删除。
