# 5. 实施验收

## 第二轮（2026-10-29）：通过，带一项已知限制

复验范围：`3d704ffc..b94cc001`，重点是 `c990b0ee`（生命周期修复）和 `b94cc001`（权威文档补回）。Codex 的逐项回复见 [06-backend-review-response.md](06-backend-review-response.md)。验收方用一个子代理逐项读代码核对，再自己补查了关键点；完整测试、构建和编译后的 Web E2E 由验收方重新跑过。

### 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 个错误，109 个警告（原有的返回类型等警告） |
| `pnpm test` | 640 个文件通过、6 个跳过；7484 项通过、17 项跳过，0 失败 |
| `pnpm build` | 通过 |
| 编译后的 Web E2E | 通过，退出码 0。验收方在内置浏览器里走完 E01–E05：发首个 prompt、`read fixture.txt` 完成、发后续消息、刷新。刷新前后两条最终回复各只有 1 条，会话不变，页面和标题里没有运行时标记。runner 的后端证据（3 次请求、cache key 稳定、工具结果被消费）、清理和诊断日志都是 PASS |
| `pnpm test:smoke` | 没有重跑。Codex 那次 4 个文件、12 项全部因为没有真实服务而跳过，所以 smoke 对本轮没有证据价值，不能据此说真实 provider 通过 |

### 第一轮问题的处理

| # | 结论 | 依据 |
| --- | --- | --- |
| 1 sandbox 释放失败占住名额 | **没修，接受为已知限制** | Codex 的理由成立：`SandboxManager` 的 release 在物理销毁前就标记已释放，第二次调用不会重试，把它当成清理证据会归还一个其实没回收的名额（`sandbox/manager.ts:278-291`）。目前唯一的生产 adapter 是本机 host-local，它的 `destroy()` 不会失败（`sandbox/adapters/host-local.ts:58`）；子代理 close 时也是先停 shell、再销毁环境（`composition.ts:878-899`）。所以现在没有触发路径。但一旦触发，没有任何路径能释放这个名额，也没有任何提示：`beginCleanup` 遇到 `unconfirmed` 且没有 `settled` 时直接返回（`subagent-host.ts:839, 847`），`onExecutionFactError` 在 composition 里没接上。见下面"留给下一批的小修"第 1 条 |
| 2 Goal 预算挡住所有唤醒 | 已修 | `subagent-wakeup.ts:167-201` 按 Goal 实际拥有的 root run 拆分候选。预算耗尽或 Goal 进行中时只排除 Goal 自己的结果，普通后台结果和监督照常唤醒 |
| 3 Host 表只增不删 | 已修 | `pruneSeals`（`subagent-host.ts:396-417`）在准入结束、清理开始、按 root 中断时收缩；未处理消息改读持久输入；监督器每次替换审批集合。集成测试断言 16 张表归零 |
| 4 monitor 读不到未处理消息原文 | 已修 | `monitor.ts` 返回原文、关闭原因和时间，和原有输出共用 16 KiB 预算，带截断标记 |
| 5 每 5 秒全量扫描 | 已修 | 周期核对只覆盖还有后台执行的会话（`session-supervisor.ts:181, 311-314`） |
| 6 runtimeInput 标记 | 已修 | 三处都改用 `buildRuntimeInputMessage`（`composition.ts:1325`、`continuation-coordinator.ts:112`、`execution-message-channel.ts:153`）。主会话唤醒不带 `contextScopeId`，和主历史 `IS NULL` 的读取一致 |
| 7、8、10、12、14 | 已修 | 旧排队项关闭留档；死代码删除；常量集中；唤醒逻辑搬进 `subagent-wakeup.ts`；布尔参数改成选项对象 |
| 9 Web 派遣行 | 移到 improve-3/4，由前端处理 | 本轮按分工没有改 Web |
| 11 调度器按 bash 名特判 | 已修，设计合理 | 豁免只给受信任的 ToolAdmission，而且要求 `cleanupOwner: "tool"`。admission 存在以工具对象为键的 WeakMap 里，模型参数和工具名都伪造不了；MCP adapter 只注册 `settlementConfirmsCleanup: false` |
| 13 重复代码 | 已修，剩一处 | `tools/utils/ripgrep-files.ts:47` 还有一份清理状态的字面量联合类型 |
| 测试缺口 | 已补 | 06 的证据表逐项列了测试位置，验收方抽查的 4 个文件（74 项）通过 |
| 文档问题 | 已补 | `dfd-interface.md`、`context-isolation.md`、`architecture.md` 补回了第一轮列出的约定 |

### 新发现的问题

都不挡合并。

| # | 级别 | 问题 |
| --- | --- | --- |
| N1 | 建议修 | 卡住的名额没有任何提示（就是上面第 1 项的另一面）。另外，已关闭的实例不出现在 list 里（`subagent-host.ts:980-984`），如果它的名额卡住，用户只会看到"名额已满"，查不到原因 |
| N2 | 建议修，推断 | 主 run 因结果持久化失败被 `runManager.fail` 中断后，`fail` 只同步 abort，run ledger 要等收尾才改状态。这期间如果 seal 已被 `pruneSeals` 撤掉，同一个 run 里正在执行的 spawn 可能通过 `resolveRequester`。窗口很窄，没有复现 |
| N3 | 小问题 | 监督器准入重试 3 次耗尽后，只要还有后台执行，5 秒的周期核对会继续调用，持续的存储错误每 5 秒报一次。06 说的"成功或耗尽后停止"不完全准确 |
| N4 | 小问题 | `subagent-wakeup.ts:44-60, 198`：`canStart` 填充 `candidates` 数组，`reserveSubagentWakeup` 按引用读取。能用但脆弱，改成 `canStart` 直接返回候选更清楚 |
| N5 | 小问题 | `continuation-coordinator.ts` 写死了 `agent: "default"` |

### 留给下一批的小修

和 improve-2 的 B4 一起交给 Codex（见 [improve-2/05](../improve-2/05-implementation-acceptance.md)）：

1. N1：把 `onExecutionFactError` 接到 `onNotice` 或日志，`beginCleanup` 静默返回的分支也报一次，让用户知道哪个名额为什么卡住。不要求自动释放。
2. N3–N5、第 13 项剩下的一处，顺手改。
3. N2 先写一个复现测试；复现不了就在代码里注释说明为什么安全。



审查范围：`subagent/backend` 分支，`fe820619...3d704ffc`，4 个提交，112 个文件，约 8.1k 行新增、4.1k 行删除。

| 提交 | 内容 |
| --- | --- |
| `ce7bdb2e` | improve-2 的 SDK 接口类型（审查意见见 [improve-2/05](../improve-2/05-implementation-acceptance.md)） |
| `b92777c0` | improve-1 生命周期主体 |
| `e0458390` | Web/TUI 新旧工具名兼容 |
| `3d704ffc` | 权威文档同步 |

审查方式：对照本目录 00、02、04，分"代码规范"和"是否符合设计"两条线，由四个子代理并行审查。关键结论由验收方再读代码核实，核实过的标"已核实"。

### 已运行的检查

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 个错误；改动文件里有若干 `explicit-function-return-type` 警告（`ui-inprocess.ts`、`composition.ts:891`、`continuation-coordinator.ts:42/154/159/168`） |
| 受影响目录的 vitest（agents、tools、tool-scheduler、prompt-scheduler、goals、adapters、context、permission、system-prompt、Web session、TUI message） | 199 个文件，2435 个通过，2 个跳过（`compact.real.test.ts`，需要真实模型），0 个失败 |
| `pnpm test:smoke`、`pnpm test:e2e:compiled-web` | 本轮未跑，复验时补 |

### 已经符合设计的部分

大部分核心行为已按 02 落地，复验时不用重看：

- 统一 `agent` 工具：六个 action、按 action 拒绝多余字段、默认后台、运行中 send 忽略 mode；list/monitor 只读，控制操作不排在 dispatch 后面。
- 六个名额：检查和预占在同一个同步步骤里；名额只还一次；清理没确认时继续占着。
- D42：自然结束时 seal 并立即还名额，stop/close 时 cancel shell；shell 的 owner 改成了子执行。
- D45：没消费的输入写 `closedAt` 和原因，stop/close 的回执列出原文。
- 结果按主会话交付，请求成功才确认；每个结果只自动唤醒一次；前台结果和主动停止不走自动唤醒；所有唤醒都经过同一个执行门。
- 监督：2/5 分钟、真正空闲才开始计时、用户 Stop 只禁止定时唤醒、连续 3 次没有新事实就停（D44）、审批阻塞时不反复唤醒、30 分钟超时兜底。
- monitor 只读、有预算和游标、不跨会话。
- 提示词：D41、D43、D47、D48 的内容都在，旧的 `subagent_status`、`subagent_close` 和 60/120 秒说法已删除。
- G 节列出的按工具名分支的位置全部改了。

### 必须修复（合并前）

| # | 问题 | 位置 | 设计依据 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **sandbox 释放失败会永久占掉一个名额（已核实）。** release 被 reject 时，`released()` 不会执行，`releaseComplete` 永远是 false，`confirmCleanup` 返回的 `settled` 永远不会完成。stop 要等这些 shell 释放完才还名额，所以名额一直占到会话销毁。旁边的注释说"释放失败不能证明进程还活着"，和实际行为矛盾 | `tools/shell-job-registry.ts:652-667`、`:388-408` | 02 §B："由对应 execution 的回收路径自动归还，而且只还一次" | 进程已经确认停止时，释放失败只记录错误，仍然标记 released；或者给释放加有限次重试，最后一次失败后同样标记 |
| 2 | **Goal 预算用完后，整个会话的自动唤醒都停了（已核实）。** `canStart` 只要 `isAutomaticRunBudgetExhausted` 为真就返回 false。这个判断只看快照是否超预算，不看 Goal 状态，blocked 的 Goal 又会保留快照。结果是普通后台结果和监督都唤不醒主代理，直到 Goal 被清掉 | `adapters/ui-inprocess.ts:1487`、`goals/service.ts:156` | 02 §D："Goal 原有的推进、预算和显式终止规则保留，等待时和普通会话走同一个结果和监督入口" | 预算只限制 Goal 自己的续跑；子代理结果和监督唤醒不受 Goal 预算限制，或者只在 Goal 仍为 active 时才检查 |
| 3 | **Host 里仍有只增不删的表。** `sealedRoots` 只在该 root 有被跟踪的执行收尾时才清理，没有活执行的 root 会一直留着；`sealedParents`（`:1301`）从不清理；新加的 `unprocessed`（`:751`）只在确认 close 时清理；`session-supervisor.ts:50` 的 `approvals` 只增不减 | `agents/subagent-host.ts:775-776, 962, 993, 1005, 1301, 751, 1186` | 02 §B："从不清理的……改为在执行收尾或实例 close 时清掉"；A10 | 执行收尾时清掉它对应的条目；`unprocessed` 在下一次执行开始或结果交付后清；补 A10 要求的测试 |
| 4 | **monitor 读不到未处理的消息（D45）。** monitor 没有调用 `readExecutionInputs`，返回的消息页里分不出哪些没处理，也没有关闭原因。只有 list 给出了条数 | `agents/subagents/monitor.ts`、对照 `subagent-host.ts:924-941` | 02 §C："list 显示'有 N 条消息未处理'，monitor 能读到原文" | monitor 每个目标附上本次执行未处理消息的原文和关闭原因；补测试 |
| 5 | **监督器每 5 秒全量扫描所有进入过的会话。** 每次扫描都分页读完该会话的全部执行。会话只有在 `SessionEvent.Removed` 时才移出 | `agents/subagents/session-supervisor.ts:281-284` | 02 §F 只要求"漏事件核对由程序负责"，没有固定频率的全量扫描 | 只对还有运行中后台执行的会话做核对；或者去掉定时扫描，改为启动时和事件触发时核对 |
| 6 | **需确认：唤醒路径构造的结果消息少了 `runtimeInput` 标记（已核实代码差异）。** `continuation-coordinator.ts:99-141` 构造的消息带 `info.runtimeInput` 和 `contextScopeId`，`composition.ts:1289-1316` 构造的没有。如果历史显示或上下文组装依赖这个标记，空闲唤醒时的结果可能被当成普通用户消息 | 同左 | 02 §D 第 4 条：结果用稳定的来源标识 | 先确认影响；无论有没有影响，都抽一个 `buildRuntimeInputMessage()`，两处共用 |

### 建议修复（可以和必须项同一轮做）

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| 7 | 旧排队项被静默清空，没有"关闭并记录" | `subagent-host.ts:1060, 1282, 1652` | 按 02 §2.2 关闭并记录；如果觉得不值得，在 02 里改成"清空、不执行"，并说明理由，二选一 |
| 8 | 旧队列模型留下的死代码：`enqueueOrSchedule` 有三个不用的参数，`execution` 可选但缺了就抛错；`appendPendingQueue` 没有生产调用者；`status()`、`recoverInterrupted()` 只剩测试在调 | `subagent-host.ts:1592-1605, 1077-1129, 1343`；`subagents/types.ts:263`、`in-memory-store.ts:68`、`database-store.ts:220` | 改名为 `startExecution` 并收成一个参数对象；删掉没人用的方法和只测它们的用例 |
| 9 | Web 对满额被拒（`started: false`）的 spawn 也显示派遣行；会启动新执行的 send 标题固定为 "Subagent task"，没有读 `message` | `apps/ohbaby-web/src/ui/session/DelegationRow.tsx:13-23, 78-84` | 没有 execution 的调用按普通工具卡显示；send 的标题取实例名或 message 摘要 |
| 10 | 六个名额和 30 分钟上限是散落的字面量 | `subagent-host.ts:425`、`tools/subagent.ts:58, 80, 255, 261` | 集中成常量（`MAX_SUBAGENT_EXECUTIONS`，复用 `MAX_SUBAGENT_TIMEOUT_MS`） |
| 11 | 通用调度器写死了 `tool.name === "bash" && params.run_in_background` | `core/tool-scheduler/scheduler.ts:880` | 和 `settlementConfirmsCleanup` 一样，做成 `ToolAdmission` 上的标记 |
| 12 | `wakeFromSubagent` 约 170 行写在 5.4k 行的 `ui-inprocess.ts` 里，而 `ui-inprocess/subagent-wakeup.ts` 就是为它建的 | `adapters/ui-inprocess.ts:~1452-1625` | 搬进 `subagent-wakeup.ts` |
| 13 | 重复代码：请求方身份校验复制了两份；`"subagent-result:"` 前缀一处拼、一处 `slice` 解析；`RunCleanupSnapshot` 和 `ShellCleanupResult` 是同一个类型；`"in-progress"/"unconfirmed"/"confirmed"` 写了 6 遍；`goals/service.ts` 里同一个判断写了 7 遍 | `subagent-host.ts:315, 356`；`execution-store.ts:227`、`continuation-coordinator.ts:173`；`run-cleanup.ts:1`；`goals/service.ts:191` 等 | 各抽一个小函数或类型别名 |
| 14 | `goals/service.ts:772` 的 `interruptInput` 和 `:598` 的 `pauseActiveGoal` 各带两个布尔参数 | 同左 | 改成选项对象 |

`composition.ts:1256` 的 `getSubagentWaitState` 永远返回 false，这会让旧浮层的等待状态失效。旧浮层到 improve-4 就会删除，这一项留到那时一起清理，不在这一轮修。

### 测试缺口（复验时要有证据）

| 验收项 | 缺什么 |
| --- | --- |
| A01 | 前台、后台混合占满；另一个主会话有自己独立的六个 |
| A02 | 一轮里多个 spawn 部分成功、部分失败 |
| A03 | Host 层面：自然完成时带着活的 `run_in_background` shell，名额立即归还，这次执行不能再开新命令；close 回收实例的全部 shell |
| A04 | 迟到的清理确认不能归还更新的执行的名额 |
| A05 | 主代理结束后，后台子代理还能开新 shell、还能走审批 |
| A06 | 单独停止一个子代理，兄弟子代理不受影响 |
| A08 | monitor 能看到未处理消息（见第 4 项）；UI 停止、失败、超时时也会关闭消息 |
| A09 | 名额满时 send 一个空闲实例 |
| A10 | Host 内部表被清理（见第 3 项）；重启后用旧 ID |
| A11 | 断言提示词里有 D41、D43、D47、D48 的规则，并且旧说法已经删除 |
| A13 | 结果、用户消息、监督同时到达的受控竞态集成测试（现在只有执行门的单元测试） |
| A19 | 集成测试（现在只有单元测试） |
| A20b | 30 分钟 `timed_out` 后唤醒主代理、审批等待不计时，端到端走一遍 |
| A22 | 旧排队项（见第 7 项）；"主 run 结束不被误当成后台已死"；"错误不只发给已经结束的 root" |
| A23 | 用户中途换模型时，正在运行的执行不切换 |
| A24 | smoke 测试 |

### 文档问题

`3d704ffc` 改写权威文档时，删掉了一些仍然有效的约定，需要补回：

- `docs/agents/dfd-interface.md`：
  - `claim` 和 `finishRun` 的行为契约（防止 close 或恢复后迟到的结果覆盖新状态），代码在 `database-store.ts:301, 324`；
  - primary 历史按 `context_scope_id IS NULL` 读取（`core/message/database-store.ts:199`）；
  - runtime 重置的顺序（`resetRuntime` 屏障 → `cancelAll` → `SandboxManager.dispose`）；
  - RunManager 的锁只覆盖当前 scope，不阻塞兄弟 scope。
- `docs/agents/context-isolation.md`：子代理不继承父代理的 memory；sandbox 环境在 `finally` 里清理。
- `docs/agents/architecture.md`：禁止的依赖方向 `runtime -> core/agents`。

建议在 `dfd-interface.md` 里加一小节"Store 契约与恢复"，把上面这些放回去。

### 需要在文档里写明的意图

- Goal 的停止意图（`goal-execution-control.ts:38, 44`，`ui-inprocess.ts:4175`）会按原 root 中断该 Goal 派出的后台执行。这符合 02 §D"Goal 预算耗尽或整体终止时，按实际的 Goal 归属查找要清理的执行"，但普通主 Stop 不会走这条路。建议在 `dfd-interface.md` 里写一句，免得以后有人当成 bug 改掉。
- Goal 的归属（`goals/service.ts:61, 147` 的 `ownedRuns`）只存在内存里，重启后丢失。因为重启时后台执行本来就会被中断，目前无害，在文档里注明即可。
- `started: false` 同时表示"满额没启动"和"消息已投递给运行中的实例"。提示词已经说明，可以接受。

### 复验门槛

1. 第 1–6 项修复，或者给出有证据的不修理由。
2. 第 7–14 项修复，或者明确推迟到哪一轮。
3. "测试缺口"表里每一项都有对应测试。
4. 补回"文档问题"里列出的约定。
5. 跑完 `pnpm typecheck`、`pnpm lint`、受影响的测试、`pnpm test:smoke`、`pnpm test:e2e:compiled-web`。
