# 1. 现状与问题分析

> 最初调查基线为 `16737a72`，本次规划复查基线为 main / `018a5c96`。本文描述改造前实现，不是实施进度。
> 源码路径默认相对仓库根目录；定位以符号为准。下列事实来自本地代码与独立评审，未用真实模型请求测量成本或故障概率。

## 1.1 主要问题

| ID | 现状及影响 | 代码依据 | 方案入口 |
| --- | --- | --- | --- |
| P1 | 流在建立后不再产生事件时，没有应用层 idle watchdog，driver 可能一直等完成 | `core/llm-client/streaming.ts` 的 `streamResponse`、`goals/driver.ts` 的 `driveGoal` | 02 §2.7 |
| P2 | 计轮在 adapter 真正开始前；等待期间状态可能改变；轮末用量无 goalId 保护 | `goals/driver.ts`、`goals/store.ts` 的 `incrementTurn` / `recordTokenUsage` | 02 §2.2、§2.4 |
| P3 | 用户与 goal 提交有各自调度路径；检查空闲到登记活跃 prompt 之间含 await | `adapters/ui-inprocess.ts` 的 `submitPromptWork` / `waitForPromptSlot` | 02 §2.2、§2.5 |
| P4 | 普通输入当前会打断 goal 并暂停；已有 steer 机制未接到自动 goal 插话 | `waitForPromptSlot` / `interruptGoalPromptInFlight`、`runtime/prompt-scheduler/current-run-inputs.ts` | 02 §2.5 |
| P5 | resume 只改状态；到顶后立刻再次停止；直接命令不能同时调整预算 | `commands/goal.ts`、`GoalService.resumeGoal`、`GoalStore.resume` | 02 §2.3 |
| P6 | 时间预算只在轮次边界检查；超长一轮无法及时停止 | `goals/driver.ts`、`goals/budget.ts` | 02 §2.3 |
| P7 | 实时与回放都是完整续跑正文；UI goal 投影只有三个字段 | `writeInitialUserMessage`、`goalSnapshotToUiGoal`、SDK `UiGoal` | 02 §2.6 |
| P8 | paused 轻提示随每条普通输入持久化，重复目标全文；criterion 没有长度限制 | `promptTextForModel`、`renderGoalContextNote`、`GoalStore.create` | 02 §2.6 |
| P9 | 模型 complete 时立刻 clear，轮末 usage 随后到达而无法记入 | `GoalStore.markComplete`、`driveGoal` | 02 §2.4 |
| P10 | 历史 blocked 被归一化成 paused；SDK 和 adapter 也只接受 active / paused | `normalizeStoredStatus`、`UiGoalStatus`、`goalSnapshotToUiGoal` | 02 §2.3、§2.6 |

以上为已证实的控制流或数据结构问题；实际触发频率、成本增幅未经测量。不把“存在竞争窗口”写成“每次必然发生”。

## 1.2 职责与结构

`packages/ohbaby-agent/src/goals/` 的结构可保留：

| 层 | 当前职责 | 评价 |
| --- | --- | --- |
| GoalStore | 维护一个当前目标，追加 create/update/clear 记录，回放恢复 | 状态集中，但异步变更缺少覆盖整次读改写的串行保护 |
| GoalService | 用户/模型操作入口，持有每 session 的 driver promise | 边界清楚；driver 退出与 resume 交错仍有缺口 |
| driveGoal | 读快照、判预算、计轮、渲染、执行、回写 | 顺序简单；计轮和渲染发生得过早 |
| GoalTurnRunner | adapter 提交 goal-owned run 的窄端口 | 无需绕过该端口重建 run 引擎 |
| GoalExecutionControlPort | 请求中断 goal 执行 | 已有能力可复用，但延迟动作需要身份约束 |
| adapter | 调度接入、消息展示、状态投影和通知 | 是跨模块改造的主要落点 |

目标状态独立于聊天摘要。driver 每轮从 store 读取目标，不依赖模型从摘要中重建 objective。这一点是现有设计的优势。

## 1.3 数据与生命周期

### 状态与恢复

当前运行态主要是 active / paused，complete 后立即清除。持久类型仍容纳历史 blocked，但回放会将其转换为 paused。重启时 active 会归一化为 paused，已有防止重启后自动执行的机制，不需要新增 activation 层。

`GoalService.ensureDriving` 用 `driving.has(sessionId)` 避免重复启动，但 finally 仅删除 map 项。旧 driver 尚未退出时，resume 调用可能因 map 项仍存在而返回；随后旧 driver 退出，没有新的驱动者。外层 catch 又只检查当前是否 active，可能暂停已替换的新目标。

`replaceGoal` 调用 `replaceObjective`，只编辑文字；`CreateGoal({replace:true})` 才创建新目标身份。两者不能混称“重开”。

### 预算与用量

当前 `GoalBudgetLimits` 包含轮次、token、活跃时长，`computeBudgetReport` 用 `used >= limit` 判断到顶。1000 轮安全阀独立判断。

活跃时长由 `wallClockResumedAt`、`foldWallClock` 和 `liveWallClockMs` 计算。它包含 active 状态下等待用户 run 的时间；不是单纯的 LLM 执行时长。使用 `Date.now()`，重启不追补未持久化的活跃区间。时钟变化与崩溃前未落盘区间是现有统计局限。

用量路径为：

```text
provider usage → lifecycle 聚合 → RunCompletion.usage
  → adapter 的 goalOutcomeFromRunCompletion → driver → GoalStore
```

adapter 当前只在 succeeded 且 usageComplete 时向 goal 返回 token；store 又要求 active。因而失败、取消和轮内 complete 都可能漏记。primary 的 totalTokens 为输入加输出，不包含子代理和独立摘要请求；不能把它称为实际账单金额。

`setBudgetLimits` 在 await append 之前计算合并值。并发更新不同维度可能覆盖彼此，仅将数据库写入排队不等于业务读改写已串行。

### 完成判定

`UpdateGoal(complete)` 直接进入 `GoalService.updateGoalFromModel`，没有独立 verifier，也不读取 completionCriterion 进行运行时验收。criterion 的使用点是 `untrustedBlock` 和 `formatGoalStatusLines`。当前 create 没有限制该字段长度。

## 1.4 消息、上下文与展示

### 模型正文与 UI 是两条路径

`renderGoalTurnPrompt` 生成正文，经 adapter 的 `runtime.startSession`、`core/agents/runner.ts` 的 `writeInitialUserMessage` 写为普通 user text part。goal 路径不设置 displayUserText，所以完整提醒会出现在用户气泡中。

实时回显在 `ui-inprocess.ts` 的 `createTextMessage` 创建；持久化回放在 `adapters/ui-state/persistent-store.ts` 读取 metadata.displayText。只修改其中一个会导致实时与刷新后的界面不同。

paused 轻提示则在 `promptTextForModel` 拼进用户原文，并用 displayUserText 恢复 UI 所见原文。它不是临时上下文，会持久化；多次普通输入会生成多份目标全文。

### runtime context 不能拿来承载 goal 正文

`core/context/context-manager.ts` 的 `createRunPromptSnapshot` 给发起消息附加 runtime context，先检查是否已有 model-context part。message store 的 `appendModelContextPart` 也按该 kind 去重。因此续跑正文若占用同一个 kind，可能跳过环境/MCP 上下文构建，或自身被去重丢弃。

这两个机制职责不同，不能再将 displayText 描述为“比 model-context 更弱、应统一替换”的技术债。

### 压缩与缓存

goal 提醒目前是普通正文，按已有消息分组参与压缩。每轮从权威 store 重新生成目标，最近输入受现有保留窗口与请求准备逻辑约束；不需要为 goal 引入独立压缩分支。

`getMessageOrigin` 仍返回 user。真正的 steer 带 runtimeInput 标记，由 `protectedInputs` 机制在请求边界保护；两者不是同一种消息。

静态 Goal mode 规则来自 `core/system-prompt/prompts/primary/base.md`，不随 goal 开关变化。自动提醒追加在历史尾部，有利于复用旧前缀；压缩与 provider 自身规则仍可能造成缓存重建。源码的字符/token 估算只是量级说明，不能据此保证缓存命中或固定计费优惠。

## 1.5 调度、插话与异常恢复

普通用户输入走 prompt scheduler 的 accept → claim → submit；goal driver 直接调用 runner，两者没有共同的用户优先准入契约。

`waitForPromptSlot` 当前在 user 撞 goal 时调用 `interruptGoalPromptInFlight`，先 pause 再中断。已有 current-run-inputs 则支持 queued 输入转换为 steered，并在 beforeStep 注入。成功 steer 绕过普通 `submitPromptWork`，不能指望该方法的文本拼接或 reasoning 设置对 steer 生效。

关键边界：

- scheduler 的 accept 可能触发 drain，因此公共 accept 返回后才做分流不具备原子性。
- goal 正忙时若先 claim 用户消息再等待，会占用 maxActiveSessions 名额。
- 正常完成已有 pending-input / close / seal 防护，不宜笼统声称正常完成会静默丢 steer。
- adapter 与 SDK 的 unsentSteer 展示均存在 user-stop 条件；异常关闭和恢复未覆盖完整。
- firstAttemptRequestId 是本地准备事实，不能证明 provider 已收到消息。
- steer 复用 goal run 的 Todo scope、reasoning 和剩余 step；与当前“插话新建普通 run”的语义不同。

`adapters/goal-execution-control.ts` 在异步等待前检查 owner，等待后读取当前 runId。若身份已切换，需要防止旧中断误伤后续用户 run。

## 1.6 UI 与接口

当前 `UiGoal` 只有 status、objective、pauseReason。`goalSnapshotToUiGoal` 只放行 active / paused，新增 blocked 不能只改 TypeScript 联合类型。

`GoalStore.incrementTurn` 与 `recordTokenUsage` 不发 onChange。adapter 的现有 onChange 又把非 completion 变化都做成状态 notice。直接给记账补事件会产生重复通知，需要区分数据刷新和生命周期通知。

CLI 已有输入框上方 goal 行；Web 已有 GoalStatusChip 与 GoalControl 面板，无需新建仪表盘。Web Resume 的禁用条件也需要接受 blocked。

## 1.7 测试基线与 SWE 判断

现有 goals 测试覆盖 store、driver、service、budget、injection、persistence 和 goal-compact 集成。`goal-completion.real.e2e.test.ts` 是显式环境开关下的真实模型测试，不能替代可重复的竞态验收。

缺口集中在：共享准入竞争、旧结果污染、resume 与退出重叠、双预算恢复、截止中断身份、未消费 steer 恢复、live/replay 展示一致性和永不返回的 provider。

按照 SWE 的复杂度管理原则，保留现有 store/service/port 分层，补齐边界比新建通用调度平台更合适。真正需要新增的是有限的身份与串行保证，不是更多模式名称。引用参考实现时要比较触发条件与失败语义，不能把项目数量当成正确性的投票。

## 1.8 既有文档的差距

| 文档 | 与当前实现或已确认目标的关系 | 后续处理 |
| --- | --- | --- |
| `docs/goals/architecture.md` | driver 实际依赖 GoalTurnRunner；快照走 adapter，非 stream-bridge；新增目标会改变准入和时间截止 | 随实现更新结构与时序 |
| `docs/goals/data-model.md` | 状态、clear、GoalChange 与用量描述需对齐 | 随状态与统计批次更新 |
| `docs/goals/dfd-interface.md` | 未完整描述轻提示落库；插话与恢复将改变 | 随提交链路更新 |
| `docs/goals/goals-duty.md`、`use-case.md`、`non-functional.md` | 既有边界大体保留，插话暂停和统计口径需修订 | 对应批次逐项更新 |
| `docs/goals/ui/goal-ui-design.md` | 原来有意不展示 usage，且只有两种 UI 状态 | 随 CLI/Web 改动更新 |
| `docs/goals/2026-07-03-state-contract-simplification.md` | blocked 非常驻状态的历史决定被本规划取代 | 保留原文，补 superseded 指向 |
| `docs/goals/2026-07-03-interrupt-current-light-note.md` | 普通输入打断与 paused 轻提示的历史决定被取代 | 保留原文，补 superseded 指向 |
| `docs/tools/todo-list/use-case.md`、`test.md` | 插话独立 scope 的旧约定不适用于成功 steer | 显式区分 steer 与普通 queued run |
| `docs/goals/test.md` | 需补新状态、准入、显示与恢复验收 | 随实现同步 |

本轮只更新规划目录。模块文档暂时保留现状，避免代码尚未实现而文档提前宣称已具备新行为。

## 补充代码核查（2026-10-15，同一基线）

- `goals/store.ts:208–229` 的 objective 原地编辑保留 goalId；`goals/tools.ts:20–28` 的 backend 未传 runId。这要求计划中的 epoch 覆盖实际正文变化，并补齐全部变更工具的上下文接线（第 2 批），仅重置 blocked 计数不足以保护 complete。
- `goals/service.ts:107–120` 的 catch 尝试 pause 并吞掉其写入失败；现状没有 finally 自动重开。新增补驱动若仅检查 active，会引入同代持久化失败忙循环（第 2 批须避免）。
- `adapters/goal-execution-control.ts:29–30` 在未中断主 run 时调用 session 级子代理兜底；`adapters/ui-runtime/composition.ts:1321–1326` 枚举 session root。只保护主 run 的 expectedRunId 不足以保证用户子代理安全（第 2 批修正，第 3 批复用）。
- `core/llm-client/streaming.ts:487–501,806–835` 的 opening 校验与 finally 间夹着重试退避。新 watchdog 不 abort 共享 signal，因此需要额外过期判据；这是规划接线风险，不是当前已存在 watchdog 的回归（第 1 批）。
- `runtime/prompt-scheduler/scheduler.ts:357–365` 除 store steer 外还通知投影并结算 waiter。自动路径尚未存在，计划不能漏掉这些既有责任（第 4 批）。
- Web `SessionScreen.tsx:497–546` 先开结构化命令 overlay，`ui/commands/GoalControl.tsx:209–221` 对 resume 仅保留 action；后端支持新参数后还须修此路径（第 3 批）。
