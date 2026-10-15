# 02 优化方案与改动面：第 2 批（执行准入与统计基础）

> 本文是给后续实施会话的执行契约。行为来源见 [00](./00-discussion.md)，现状依据见 [01](./01-problem-analysis-and-current-state.md)，验收见 [04](./04-test-and-acceptance.md)，参考对照见 [03](./03-reference-projects.md)。总体约束见 [../plan/02](../plan/02-optimization-plan-and-change-scope.md)。
> 文中接口与字段是**预期实现**（定行为、定所有权、定顺序），实施时可调命名，但要满足同一契约。第 3、4 批复用同一串行边界，见 §2.10 的挂点。

## 2.1 目标与不变量

目标一句话：把"谁能在这个 session 里执行"收敛成**一个串行边界里的一个占位**，并把 complete 与统计做成身份正确、可回放、可结算的最小闭环。

不变量（本批必须成立，后续批次在此基础上叠加）：

1. 同一 session 同时最多一个执行持有者（用户 run / goal 轮 / compact）。
2. 用户排队工作优先：有 queued / starting / running 用户工作时 goal 不准入；排队项不占 `maxActiveSessions` 名额。
3. 计轮、正文、展示值来自同一次准入快照；未准入不计轮、不发消息。
4. 旧执行（旧执行代号 executionEpoch / 旧 goalId）不能改新生命周期；同目标迟到 usage 仍可结算。
5. complete 是持久终态：不可复活、不可编辑，结算后清除；通知一次。
6. token 不再参与任何停止判定；已知 usage 不丢，未知不伪装为零。

## 2.2 唯一的串行边界：session 执行门禁 + 现有 commit 队列

### 复用而不是新建

每 session 的串行区已经存在：`SourceSessionProjection.owner.run / runControl`（`adapters/ui-state/session-view.ts`，per-session promise tail）。scheduler 的 store claim（`scheduler.ts` `commit()` → `commitCoordinator.run`）和 UI 控制写入都排在这条队列上。**本批不加第二个锁，不建第二个队列**：门禁的"检查 + 占位"必须排进这条队列执行；goal 与 compact 两条路径接进同一个边界。

### 新增件：adapter 内的 `SessionExecutionGate`（预期实现）

所有权：adapter 模块私有（例如 `packages/ohbaby-agent/src/adapters/session-execution.ts`），goals 模块不导入它；scheduler 通过窄端口使用（不把 scheduler 类型泄给 goals）。

```ts
type SessionExecutorKind = "user" | "goal" | "compact";

interface SessionExecutionGate {
  isHeld(sessionId: string): boolean;                                  // 同步快查，供 drain 预筛
  reserve(sessionId: string, kind: SessionExecutorKind, token: symbol): boolean; // 同步；无持有者才登记
  release(token: symbol): void;                                        // 同步；token 匹配才清，随后 notify
  subscribe(sessionId: string, wake: () => void): () => void;          // 先注册唤醒，再检查条件
  notify(sessionId: string): void;                                     // 释放/队列变化/目标生命周期变化的统一唤醒口
}
```

门禁**不自排队**。排队只由每 session 串行区负责：调用方用**一次** `owner.runControl(sessionId, op)` 进入，在同一个 op 里先检查条件（读快照、读队列），再做自己那**一次**持久化（或一组顺序固定的 append），最后 `reserve` 登记；op 里绝不运行 run 本体。这样"检查 → 持久化 → 占位"是同一个队列条目，不存在两条路径交错读改写，也不会出现"自排队的 acquire 再被 `commit` 回调重入"的死锁形状。

持有者变更规则（不留自相矛盾的例外）：

- `reserve` 只在串行区 op 内调用，且是该 op 的最后一步。
- `release` 是唯一同步例外：不进串行区，按 token 清自己的占位后唤醒。它只能清掉自己登记的项，清不掉后继持有者；所有权威判定都会在区内重新读占位表，所以不破坏串行语义。
- 区内只准调 store 的窄函数与"已在区内"的 service 内部函数（下节），不准调任何会再次进区的公共方法。

### goal 变更的统一入口

`GoalService` 的每个变更（create / pause / cancel / resume / replace / budget / admit / settle / complete）都**只把"读改写状态"这一段借 owner 队列进入一次**，写法是两层而不是整方法套壳：

- **区内（一个 `owner.runControl` 条目）**：读快照校验身份 → 捕获待中断票据 → 持久化状态 → 失效/递增 executionEpoch → 返回票据或结果。内部函数（命名如 `pauseActiveGoalInBoundary`）假定自己已经在区内，只调 store 的窄函数，不再进区；`admit` 也一样，不回调公共 service 方法。
- **区外**：状态提交后再等待 `interruptGoalExecution(...)`、触发 `ensureDriving(...)` 或重排截止定时器。`init` / `enterSession` 也必须在区外完成，所需初始化先于业务变更。这些路径可能等待 runReady、写 message 或动 ledger，需要 owner 队列；在同一个条目里等待会死锁。
- public 命令方法由区外初始化、一次区内状态变更和区外后续动作组成，不是 `runControl(() => 整个方法)`。

每次单记录变更都先 append 成功，再提交对应内存状态。多个 append 顺序执行不等于数据库事务，不能承诺其中任意一步失败都会回滚此前记录。complete → usage → clear 是允许保留中间持久态的三个阶段；第 3 批 resume 则把预算、状态和停止原因写成单条 update，才能保证该操作失败零修改。store 不加第二把锁，跨路径的读改写按同一队列排序。

方向说明：`GoalService` 通过**依赖注入**拿一个窄端口（如 `withSessionMutation(sessionId, op)`，实现是 `owner.runControl`），goals 模块**不直接 import** `SourceSessionProjection` / owner。门禁同理：scheduler 与 goals 只见窄端口，不 import adapter 内部实现。

### 锁顺序（固定，不能倒置）

```text
(1) adapter admission barrier（withSessionAdmission，提交入口，跨 await 前排队；不跨 run）
(2) session 串行区 owner.run / runControl  ← 门禁 reserve、条件检查、持久化、claim、控制写入都在这
(3) 内存占位表 holders（reserve 在 (2) 内；release 为同步例外）
(4) 长任务：run 本体 / 压缩本体（在所有队列之外）
```

规则（违反即回归）：

- **拿 (2) 只做短操作**：读快照、读队列、一次 append、登记占位。**绝不手持 (2) await 整个 run 或整个 compact。**
- **不在 (2) 内重入 (2)**：区内只准用裸 store 端口（如 `promptSubmissionStore.listQueued`、goal store 的窄函数）和"已在区内"的内部函数，不准调 `promptScheduler.accept/claim/steerQueued`、或任何内部再走 `commit()` / `runControl()` 的公共方法。
- **等待协议**：`subscribe` 先于条件检查；被唤醒后**重新完整检查**，不能把唤醒当成"条件已满足"；检查发现条件已变也要能立即通过（防止订阅与检查之间的丢失唤醒）。
- 唤醒口统一走 `notify`：门禁释放、scheduler `onSubmitted/onUpdated`、`GoalService.onChange` 三处都调一次，等待者自己重判。

## 2.3 三条路径的契约

### A. 用户 claim（scheduler `drain`）

- 候选预筛加 `isHeld(sessionId)`：goal 或 compact 持有中就不选它（保持 queued，不占 `maxActiveSessions`）。
- **必须订阅门禁唤醒**：scheduler 对每个用到的 session 调用 `gate.subscribe(sessionId, () => requestDrain())`，`dispose/close` 时注销。否则"用户因 goal 忙跳过 drain → goal 释放后没人再触发 drain"，两边互相等死。
- 权威动作放在现有 `commit(candidate.sessionId, …)` 回调里（这就是一个串行区条目）：op 内**先再查一次 `isHeld`**（预筛不是权威判定，block 内复审才算数），仍空闲才 `await store.claim(promptId)`；claim 成功再 `reserve(sessionId, "user", token)` 并把 lease 带回；被占用或 claim 返回 null（已被并发吃掉）就不登记，不留残留。注意：其他路径在同一区内只会 `release`、不会 `reserve`，所以区内复审的结果只会是"仍被占（跳过）"或"已释放（可 claim）"，不会出现抢注。
- **lease 归属跨越交接点**：claim 出来的 lease 先由 drain 外层作用域持有；在交给 `executeClaimed` 之前的所有退出路径（closed → requeue → break，即现有 `scheduler.ts` 的 closed 分支；以及异常）都必须在**外层 finally** 释放 lease。交接之后，lease 只由 `executeClaimed` 的 `finally` 释放（token 校验），再走现有 `requestDrain()`。两条路径不得都释放、也不得都不释放。
- `waitForPromptSlot`：删除 `interruptGoalPromptInFlight` 及其调用；`owner=user` 撞 goal active 改为 **等 `waitForPromptIdle` 后重查**（防御分支，正常路径不可达，因为 claim 已被门禁拦住）。通用 `throw` 只保留给"同类冲突"这类不应发生的情况，用户撞 goal 不得落进去。

### B. goal 准入（adapter `runTurn`）

`GoalTurnRunner` 不再接收提前渲染的 prompt：

```ts
interface GoalTurnTicket {
  readonly goalId: string;
  readonly executionEpoch: number; // 见 §2.4
  readonly turnNumber: number;     // 准入后已落盘的 turnsUsed
  readonly modelText: string;      // 完整续跑正文
  readonly displayText: string;    // 简短展示值，如 "Goal auto-continue (turn 7)"
}
runTurn(sessionId: string, goalId: string, executionEpoch: number): Promise<GoalTurnOutcome>
// GoalTurnOutcome.status 的取值含 "not_admitted" 与既有的 succeeded/failed/cancelled
```

`runTurn` 内部循环（事件驱动，不忙转）：先 `subscribe(sessionId)`（先订阅后检查），再用**一个** `owner.runControl(sessionId, op)` 条目做全部"检查 + 计轮 + 占位"：

1. 读 goal 快照与当前 executionEpoch：goalId 或捕获代号不符，或状态非 active → 不登记（目标或生命周期已变）；
2. **在区内重查预算与安全阀**（不能只信 driver 准入前的检查，否则等待期间被调低的预算会被跳过）：到顶（本批仍 paused）→ 区内直接调 `pauseActiveGoalInBoundary`，不登记、不启动；
3. 既有 session finalization / goal 结算恢复尚未完成 → 不准入，等待显式恢复成功的唤醒；本 session 有 queued 用户 prompt（裸 `listQueued` 过滤 sessionId）→ 不登记（用户优先）；starting / running 的用户或 compact 占位由 `isHeld` 覆盖；
4. `admitTurnInBoundary(sessionId, goalId)` —— 只做身份/状态校验 + 一次 append + 内存加一，返回**计数后的快照**；用这一份快照生成 `modelText` 与 `displayText`（`renderGoalTurnPrompt(postCount, {isFirstTurn: turnsUsed===1})` + 短提示模板）；
   - 文案基线（唯一生成点在这里）：首轮 `Goal started`，续轮 `Goal auto-continue (turn N)`，N 取本次准入快照的轮号；第 5 批不再另设生成点。
   - `displayText` 随提交契约传到 adapter（挂在票据和内部提交选项上）。**不许只接一半**：接它的那一步必须同时改"实时消息文案"和"持久化 displayUserText"，否则实时与刷新后会显示不同文字。本批只交付"同快照生成 + 契约传递"，live/replay 接线归第 5 批；本批不得只把 `displayUserText` 写进持久层而不改实时显示。
5. `reserve(sessionId, "goal", token)`；
6. op 外启动 run：`submitPromptInternal(owner="goal")`。票据在 `reserve` 时以 token 为键就已存在（此时可能还没生成 runId），并有准备阶段取消 controller / signal，复用内部提交 signal 接线；runId 生成后、首个工具可执行前绑到同一票据。停止操作在区内捕获旧票据，状态 append 成功后立即使 epoch 失效并发出准备取消；区外才 await 中断完成。每个异步准备点之后、`startSession` 前核对 signal 与身份，启动握手跨 await 时还须在 runReady 交接复核捕获的停止意图，并按其 includePrimary 范围处理，不能只靠启动前一次检查。runtime `startSession` 已启动 worker 即视为“已启动”，不是等 UI runReady 才算。交接检查只执行捕获的停止意图：pause/cancel/deadline 要停主 run；complete/模型 blocked 的 includePrimary=false 以及 objective 实改允许已启动主 run 收尾，不得单因 epoch 失效而误停。准备 signal 只负责阻止尚未启动的执行，不等同于已启动 run 的主取消 signal。
7. **lease 交接**：runner 准入后先持有，携票据/outcome 交给 driver 结算；首次 usage/complete clear 成功，或同一票据的 recovery 已登记并可阻断后继执行，才在 finally 按 token 释放。交接前异常由 runner 同样先完成结算或登记恢复再释放；不能在 runTurn 返回前先释放让用户 run 抢入。这里只延长执行占位，不持有 owner 队列。票据从 reserve 起存在，直到结算或显式恢复完成才清除；恢复阻断已登记后 lease 可以释放，票据继续保留。

未登记时（op 返回 null）：若目标已停 / 已换或捕获的 executionEpoch 已失效，返回 `not_admitted(target_lost)`；否则 `await wake` 后回到 1。`not_admitted` 严格表示未获准，不计轮、不发消息。

driver 侧删除 `incrementTurn` 与 `renderGoalTurnPrompt` 调用，只做“读态 → 预算/安全阀快路径 → runner.runTurn → 按 §2.4 结算与回写”。`not_admitted` 后重读状态与身份：只有仍 active、goalId 及捕获代号都匹配才继续；任一失配就退出，不能因新生命周期也 active 而用旧代号反复重试。有效生命周期的繁忙等待已在 `runTurn` 内完成，不忙转。

**边界契约一：暂停与计轮的先后由队列条目顺序裁定。** pause / cancel / resume / replace / admit 都走同一个 owner 队列（§2.2），所以只有两种结果：

- 暂停的条目先进区 → 计轮条目随后看到的快照已非 active：不计数、不启动，返回 `not_admitted(target_lost)`（准确的"未获准"）；
- 计轮的条目先进区 → 计轮 append 落盘、`reserve` 登记；暂停条目排在后面才执行。此时本轮**已经算一轮**（决议 7：已准入轮即使随后取消也计一轮），准备/启动阶段发现 epoch 已失效就取消本轮启动，结果按 `cancelled`（携带本轮票据）上报，**不允许**返回"未准入"这种宣称。

两端一致要求：计轮 append 落盘失败 → 内存不变、不登记、lease 不留残留；取消启动 → 携票据结算或登记恢复后释放 lease，不改已经落盘的计数。

**边界契约二：同一 run 内工具 create(replace)。** run 里的 `CreateGoal({replace:true})` 创建新目标身份，**不打断**当前 run。旧票据绑定旧 goalId：run 结束后 usage / 暂停 / clear 等所有回写先比对 goalId（和 epoch），不匹配就静默丢弃，不写进新目标；旧 driver 退出时只清自己的 `driving` 项，若当前目标状态为 active 且不是自己这一代，补一次 `ensureDriving`（新目标由自己的循环驱动）。旧 run 的 goal 工具调用按 §2.4 的绑定规则处理：旧 goal-owned run 不得修改替换后的目标。

**边界契约三：`/goal replace` 编辑同目标。** 归一化后正文实际改变才递增 epoch；保留 goalId、预算、turnsUsed 与全部用量。尚未准入的旧等待者退出且不计轮，已准入但未启动的准备取消并保留计轮；已启动旧 run 可自然收尾、同 goalId 的 usage 可结算，但其后 complete / budget / create 等模型变更及自动 steer 资格均失效。旧 driver 清理后为已提交的新 epoch 安排一次驱动，正文来自新准入快照。同文 no-op 不换 epoch、不重置第 3 批审计。第 3 批须在实改提交后按原累计活跃用量重排 deadline；停止该目标时仍按同 goalId 的实际占位捕获旧 run，mutation 失效不等于免受截止中断。

### C. 手动 compact

`compactSessionInternal` 在现有预检之后、`compactingSessions.add` 之前，用一个 `owner.runControl` 条目复核预检并 `reserve(sessionId, "compact", token)`；预检失败抛 `SessionRunBusyError`（保持现状语义），失败不留残留。压缩本体在队列外运行，`finally` 释放。效果：goal 准入在压缩期间不获准（等 `notify` 再重试，不 pause、不空转）；用户 prompt 停在 queued，压缩结束后正常执行，不再以 runtime error 结束。

## 2.4 身份、回写与迟到用量

- **执行代号（executionEpoch）**：由 `GoalService` 持有，**在生命周期转换时立即失效**，不是"driver 启动时才分配"。会递增的转换：pause、cancel、complete/clear、create（含 `replace:true`）、真正的 resume，以及归一化后 objective 实际改变的 `/goal replace`。objective 编辑保留 goalId、预算与累计统计，但立即使旧执行资格失效；同文 no-op 和普通预算调整不递增。第 3 批据此重置审计链，不新增持久 revision 或第二套 cutoff。driver 在**启动循环时捕获一次**代号并固定使用，每轮准入与每次回写都用这个捕获值验证 `捕获值 === 当前值` 且 goalId 匹配；**不得每轮重新捕获、偷偷续跑同一生命周期**。验证不过就退出。这样 pause → resume 时即使旧 driver 还挂在 `driving` map 里，它的回写也已失效，不会暂停新生命周期。（plan 里把同一种东西写作"进程内 generation"，本文统一叫 epoch。）
- **driver 生命周期**：`driving` 存 `{promise, loop}`。`finally` 按**条目身份**（map 里是不是自己这个 promise / loop 对象）删除自己的条目，**不能拿 epoch 当删除条件**——epoch 失效后如果按 epoch 比较，旧条目反而删不掉、新 driver 永远起不来。清理后，只有当前目标仍 active，且已有已提交的新 goalId / epoch 或尚未消费的显式驱动请求时，才补一次 `ensureDriving`。显式 resume 在旧条目退出期间到来时，可在既有 driving 状态上保留一个待驱动标记，由 finally 消费一次，避免丢唤醒；不建新队列。正常同代续轮由原循环负责。致命异常退出且暂停 append 也失败时，不能仅因磁盘仍 active 就自动重启同代循环；错误对用户可见，存储恢复后由显式 resume 重试。存在未完成结算恢复时也不准入新 goal 轮，见下文。
- **票据与 mutation 资格**：票据从 `reserve` 起以 token 为键存在，含 goalId、executionEpoch、turnNumber；票据同时拥有准备阶段取消 signal，runId 生成后附加到同一票据，并建立 runId 查询。票据直到 settle / complete 或显式 recovery 完成才清理；lease 仅可在首次结算成功或 recovery 阻断已登记后释放，不能在尚未尝试结算时提前释放。
  - **真实工具上下文**：本批就将 `ToolExecutionContext.runId` 经 `GoalToolBackend` 传入 CreateGoal、SetGoalBudget、UpdateGoal 的所有变更调用；这是内部可信参数，不放进模型 schema。adapter 依现有 run 所有权与票据区分 goal-owned / 普通用户主 run / 无有效身份；不能把“没找到票据”当作普通用户权限，未知或已失效调用拒绝变更。GetGoal 只读当前快照，无需套 mutation 门禁。
  - **goal-owned run**：变更只能作用于票据绑定的 goalId 与有效 executionEpoch；取消、替换或生命周期已经变化时，拒绝迟到工具调用并说明原因。
  - **普通用户 run**：保留 `CreateGoal`、`SetGoalBudget`、显式用户要求的 `UpdateGoal(complete)`。调用捕获目标身份，实际变更在同一串行边界内复核；不能在 await 后拿旧快照修改替代目标。它不需要 goal 准入票据，也没有 blocked 三轮审计资格。
  - **steer**：共享所在 goal run 的身份与资格，本身不新增轮。其后的合法工具调用沿用原票据，仍可贡献该轮首次有效的 blocked 报告，不能一概拒绝。
- **业务状态回写（要求 executionEpoch + goalId 都匹配）**：`cancelled → paused("interrupted")`、`failed → paused(runtime error)`、外层 catch 的暂停及截止状态变更。不匹配即丢弃，旧轮失败不能暂停恢复后的新生命周期。执行 lease 按 token 释放，`driving` 按 promise / loop 身份清理，二者不以失效的 executionEpoch 作为清理条件。已提交停止操作的中断按提交前捕获的票据识别旧执行，见下文。
- **usage 结算（只要求 goalId 匹配，且结算一次）**：`recordUsage(goalId, usage)` 在 store 当前 `state.goalId === goalId` 时结算，状态为 paused / blocked / complete 也接受，但**永不把状态拉回 active**；目标已被替换或取消则丢弃（不建历史账本）。去重方式：票据上有 `settled` 标记，在**同一个串行区条目内**先查标记、持久化成功之后才置位（不是靠"outcome 只会来一次"的口头假设）；重复到达的迟到结算看到标记即跳过。不新增全局 settlement map——标记就挂在既有票据上。usage 里可选项缺失时按"部分统计"标记，旧记录里字段为 undefined 也按未知处理，不当作完整的零。
- **结算失败的实际恢复入口**：已收到的 outcome 与 settled 标记留在原票据；usage/clear append 失败不丢 outcome、不自动忙重试。adapter 经窄回调复用 `promptScheduler.blockExecutionFinalization(sessionId, error, persist)` 与 `recoverSession` / 客户端恢复入口，不新增账本、恢复 UI 或恢复队列。恢复注册必须先于 lease 释放，避免用户 run 先进入后又以自己的 finalization 覆盖同 session 的单槽回调；既有 recovery 条件也纳入 goal 准入，所有执行入口均不能绕过。
  - 同一 goal run 的 run finalization、usage、clear 是**一个顺序恢复闭包**：如 runtime finalization 先失败，调用既有 `retryFinalization(runId)`，保留它返回的最终 `RunCompletion`，再经 `goalOutcomeFromRunCompletion` 取真实 usage → 按 goalId 结算 → 必要时 clear。不能覆盖已有 runtime recovery，不能只补 usage 而丢它，也不能再登记另一个 session 回调覆盖自身；每个成功阶段留在同一票据上，后段重试不重复前段。
  - runtime finalization 未确认时，必须保留可辨认的“待恢复”分支（可复用 `RunFinalizationError`），不能被 runTurn 的通用 catch 合成为无 usage 的 failed 后提前 settled/clear。driver 退出当前推进，按现有错误通道展示，当前 active 且身份匹配时可尝试 pause；pause 也写失败仍不重开同代。票据交给 recovery 后仅由 recovery 负责结算；driver 不再对最终恢复结果重复 settled/clear 或回写生命周期。显式恢复只补持久化，不复活 paused/blocked/complete；若 pause 写失败仍 active，也由后续显式 resume 请求补驱动，不自动重开同代。
  - usage 成功后才置 settled；clear 单独失败重试复用该标记。同目标被取消或新建替代后，runtime finalization 仍须补齐该旧 run 的执行记录，但 goal usage/clear 只丢弃旧票据，不写新目标。重启仍按 complete 残留清理，不假造崩溃丢失的尾部 usage。

- **中断身份**：`GoalExecutionInterruptInput` 携带停止提交前捕获的票据及已绑定 `expectedRunId`。准备票据的取消见 §2.3；已有 run 时，`executeGoalExecutionInterrupt` 在 `waitForPromptRunReadyOrIdle` 之后再次核对主 run 身份，只能中断预期的 goal run。子代理也必须限定到同一 goal root runId，复用 `subagentHost.interruptByRootRun`，删除 `interruptSubagentsByParent(sessionId, ...)` 的会话级兜底。没有匹配 goal 票据 / root 时不枚举 session 内当前 root；已知旧 goal root 的子代理可定点清理，但不触碰后继用户 root 及其子代理。`includePrimary: false` 的 complete（第 3 批还有 blocked）只清对应 root 的冗余子代理，主 run 可收尾；不代表放宽子代理范围。第 3 批 deadline 复用这一整套契约。

## 2.5 complete：持久终态与结算顺序

状态决定与结算分离，顺序固定：

1. `UpdateGoal(complete)` → `GoalStore.markComplete`：append `{status:"complete"}` 的 update 记录，**状态保留在内存**（不再立即 clear），发一次 completion 变更（adapter 投影 complete → 空、notice "Goal completed." 一次）。
2. `updateGoalFromModel` 同时检查"该目标现在是否有待结算的已准入 run"。判定按**票据**，不看 runId 是否存在：从 `reserve` 起（此时可能还没生成 runId）就算"待结算"。没有票据 → 立刻 `store.clearCompleted(goalId)`；有 → 保留残留，等 driver 结算。票据条目的清理不得早于 settle / complete 处理，否则会出现"误判无 pending → 提前 clear → 尾部 usage 无处落"的窗口。
3. driver 收到本轮 outcome 后，在同一串行边界内核对 goalId、执行 `recordUsage` 并提交该票据的 settled 标记；只有该目标已 complete 且没有其他未结算票据时，才 `store.clearCompleted(goalId)`。执行 lease 须在首次结算成功或 recovery 阻断登记后才释放；同目标旧生命周期的迟到票据也要纳入 pending 判断。usage 写失败不得先删票据或 clear；clear 写失败保留 complete，后续清理或重启回放可继续，不重复累计已成功结算的 usage。最终 clear 只走数据刷新（§2.6），不发第二条 cleared / completed 通知。
4. 守卫：complete 残留期间 `resume`、`replaceObjective`、`setBudgetLimits` 抛 `GoalError`（明确"已完成，不再可编辑"）；`create`（含 `replace:true`）放行，新目标直接替换残留。`updateGoalFromModel` 对 complete 的返回文案不再提示 `/goal resume`。
5. 回放：`normalizeAfterReplay` 的"complete 残留 → 直接 clear"保持并成为真实路径（不降 paused、不恢复驱动、不补记崩溃前拿不到的 usage）。历史记录里本来就可能存在 complete，回放必须容忍，不当作异常。

## 2.6 统计与 token 闸门删除

- **类型/计算**：`GoalBudgetLimits` 删 `tokenBudget`；`GoalBudgetReport` 删 `remainingTokens` / `tokenBudgetReached`；`computeBudgetReport` 的 `overBudget` 与 `converging` 只看轮次与活跃时长。`GoalSnapshot.tokensUsed` 保留为统计。
- **usage 通道**：`GoalTurnOutcome` 用 `usage?: { totalTokens?, cachedInputTokens?, usageComplete }`；adapter 从 `RunCompletion.usage` 取 `totalTokens` 与 `inputBreakdown.cacheRead`（含 observed 缺失情况），succeeded / failed / cancelled 都回传已知部分；`undefined` 表示未知，落库时不写 0 伪装。`GoalStore.recordUsage` 接受部分已知；快照新增 `cachedTokensUsed?` 与 `usageIncomplete?`（旧记录缺字段按未知/兼容处理，不迁移整库）。
- **回放兼容**：`rebuild` 对 update 记录先核对 `record.goalId === state.goalId` 再套用计数与用量；旧记录中的 token 预算字段读取时直接忽略，新写入不再产出。
- **静默刷新**：`GoalChangeKind` 增加"数据刷新"类（如 `"progress"`）；`incrementTurn` / `recordUsage` / 最终 clear 发这一类，adapter 两处 notice 分支（`ui-inprocess.ts`、`ui-runtime/composition.ts`）对这类只走 `publishGoalUpdated`，不发 notice。
- **文案**：续跑正文改"Progress: N continuation turns, X elapsed"，删 token 预算行；`formatGoalStatusLines` 保留 token 统计并加缓存命中与部分统计标注（查询用，例如 `Tokens: 12,345 total (cache read 8,000); usage incomplete`）；`SetGoalBudget` 单位删 `tokens`，描述同步；`GOAL_CONTINUATION_CORE` 与 base.md 的状态词本批不动（blocked 是第 3 批）。若动了 base.md，必须跑 `pnpm --filter ohbaby-agent prompt:generate` 重生成模板并用 `prompt:check` 校验一致。

## 2.7 改动面

| 文件 / 模块 | 改动 |
| --- | --- |
| `adapters/session-execution.ts`（新增） | 门禁：同步占位表 + 唤醒口 + `reserve/release/subscribe/notify/isHeld` |
| `runtime/prompt-scheduler/scheduler.ts` | drain 预筛 + claim 在同一串行区条目内 `reserve`；释放接 finally；接受窄端口选项 |
| `adapters/ui-inprocess.ts` | `runTurn` 改为准入循环与票据；删 `interruptGoalPromptInFlight`；`waitForPromptSlot` 改成等待；compact 取占位；`goalOutcomeFromRunCompletion` 补 usage；notice 分支跳过数据刷新；`GoalService` 的 public/区内双层接线 |
| `goals/driver.ts` | 持有结算交接后的 lease，先结算/登记恢复再释放；不再计轮/渲染；`not_admitted` 与 admitted-then-cancelled 处理；回写带 epoch；complete 结算入口 |
| `goals/service.ts` | epoch 生命周期失效；public = 队列包装 + `...InBoundary` 内部实现；`admitTurn` / `recordUsage` / complete 守卫；待结算票据查询与显式恢复端口；异常退出不自动重试同代 |
| `goals/store.ts` | `markComplete` 落盘不即清；`clearCompleted`；`admitTurn`（计数并返回快照）；`recordUsage`（部分已知、终态可记）；回放按 goalId 过滤；complete 守卫 |
| `goals/types.ts` | 预算/快照/outcome/ticket 类型；`GoalTurnRunner` 签名；中断 `expectedRunId` |
| `goals/budget.ts`、`constants.ts` | 删 token 维度；converging 两轴 |
| `goals/tools.ts` | `GoalToolBackend` 与全部变更工具传递内部 `ToolExecutionContext.runId`；单位、描述与 complete 文案 |
| `goals/injection.ts` | 正文去 token；状态行加缓存/完整性 |
| `adapters/goal-execution-control.ts`、`adapters/ui-runtime/types.ts`、`adapters/ui-runtime/composition.ts` | 主 run 和子代理均按捕获的 goal root 定点中断，删除 session 级后备中断；complete 投影与静默刷新同步 |

不动：run-manager 并发政策、sandbox、权限、压缩算法、`UiGoal` 字段（第 5 批）、blocked（第 3 批）。

## 2.8 实施步骤（Stage）

1. **门禁落地**：新增 `SessionExecutionGate` + 串行区接线；scheduler claim、goal 准入、compact 三路径接入；goal 变更收拢到"一次队列条目 + 区内窄函数"；删打断分支。此时普通输入只排队（第 4 批的 steer 尚不存在）。
2. **准入与身份**：`admitTurn` + 票据 + epoch 生命周期/正文变更失效 + 工具真实 runId 接线 + 准备取消 + 回写校验 + 回放 goalId 过滤 + `ensureDriving` 补驱动、`admitted-then-cancelled` 出口。
3. **complete 与统计**：complete 持久化与结算顺序、守卫、回放；token 闸门删除；usage 通道、票据 outcome / `settled` 去重、既有 recovery 接线、静默刷新、文案。
4. **收尾**：模块文档（`docs/goals/*`）同步、`prompt:check`、全量 `test:unit/contract/integration`。

Stage 1 未完成前不要先落 Stage 3（先删打断分支却没有排队准入会直接坏掉）。

## 2.9 迁移、兼容与回滚

- 兼容：旧 goal 记录（含 token 预算、无 cached/usageIncomplete 字段）读取兼容，不重写；历史回放里可能出现 complete 记录，`normalizeAfterReplay` 的清理分支按真实路径对待，无数据迁移。
- 回滚：门禁、准入、身份、complete 与统计共用执行票据，按整批评估回退，不承诺各 Stage 或其中两组可以独立回滚。第 3–5 批落地后，需要同时核对它们对串行边界、票据、统计字段和事件的依赖。
- 回滚的已知语义变化：退回本批会让普通输入重新打断 goal（行为回退，不是可选配置）；complete 回到"宣告即清除"时会丢掉尾部结算——两处都要写进回滚说明，不假装无损。

## 2.10 过渡态声明与留给 3/4 批的挂点

**过渡态不是最终设计**：本批预算到顶仍是 paused；普通输入只排队、不打断，也没有自动 steer；`GoalTurnRunner` 只管跑一轮。

给第 3 批（同一边界，不另立锁）：

- 串行 mutation 复用本批的 owner 队列模式（§2.2）：resume 的"读当前预算与用量 → 合并 → 两轴与安全阀检查 → 一条 update 写预算+active+清停因"整体放进**一个** `owner.runControl` 条目，区内的 service 内部函数只调 store 窄函数、不再进区；失败零修改；不要自建队列或第二把锁。
- store 侧需要新增"一条 update 同时写预算+状态+清 pauseReason"的入口，由 3 批按本契约定名实现。
- 三轮审计用 §2.4 的票据绑定（runId → goalId + executionEpoch + turnNumber）判资格，以票据轮号判断相邻、以 runId 去重同轮贡献。普通用户 run 无审计资格；steer 沿用所在 goal run 的资格，不新增轮，后续合法工具调用仍可贡献本轮首次报告。
- deadline 中断复用票据准备取消与 goal root 限定（§2.4），主 run 在 await 后复核，子代理不做 session 级兜底。
- 预算到顶从 paused 翻成 blocked 时，要**同时**改两处：driver 的 `pause(...)` 出口，和准入区内的到顶分支（§2.3 B 第 2 步）；不是只换 driver 一处。门禁与准入顺序不动。

给第 4 批：

- 自动 steer 挂在 accept 之后、claim 之前（决议 8 顺序），复用 `CurrentRunInputStore`；本批已保证"排队不打断、队列优先、goal 少占容量"，steer 只需在 accept 与 claim 之间插入分流，不改门禁。
- 只读挂点 `getActiveGoalRunForSteer(sessionId) => { runId, goalId } | undefined`（命名可调，语义保留）：在 accept 已进入的同一 owner 边界内同步读取。必须同时满足当前 goal 为 active、goalId 与票据一致、票据的 executionEpoch 有效、run 正在执行且未封口；否则返回 undefined，输入保持 queued。实现位于 adapter，复用票据与现有 run 状态；goal 生命周期资格由这次同区检查保证，`steerQueued` 事务继续复核 run 接收状态与封口。complete / blocked 已落盘、旧 run 内 replace、pause 先于 accept 时，即使旧 run 仍在收尾也不得自动 steer。不占门禁租约、不新建 run、不增轮。
- 未消费输入恢复 UI 与 FIFO 细节属 4 批，本批只固定接受顺序（沿用既有 `accepted_at` / `admission_order`，不新增序列）与不越过更早排队项的语义。
