# goals 模块 architecture.md

本文档描述 `goals` 模块（`packages/ohbaby-agent/src/goals`）的内部结构与设计取舍。所有结构均服务于 [goals-duty.md](./goals-duty.md) 中已确认的目标与职责，不引入新职责。

---

## 一、Architecture Overview（总体架构）

goals 模块由五个子组件构成，围绕"一个 session 恰好一个 goal"这一核心状态展开：

- **GoalStore（聚合根 / 状态机）**：持有单个 goal 的内存态，是所有状态迁移的唯一入口。承载生命周期规则、actor 边界、turn 计数、预算追踪，并能从持久化记录重建。对外只暴露"迁移方法"与"读取快照"，不暴露可变字段。
- **GoalDriver（编排器）**：长任务续跑循环的拥有者。站在 `runtime/run-manager` **之上**，反复"起一轮续跑 Run → 等待完成 → 据结果驱动一次状态迁移 → 决定是否再来一轮"。它是唯一读取 `RunCompletion` 并把它翻译成 goal 语义的组件，也是预算判定与**不可配置安全阀**（写死的续跑轮上限，仅在未设 turn 预算时作为兜底）的持有者。
- **GoalInjector（续跑提醒与 light note 渲染）**：把 GoalStore 的当前状态渲染成模型可见文本（纯函数、无副作用），负责 `<untrusted_objective>` 包裹与转义。`active` 时由 GoalDriver 生成全量续跑提醒，并作为续跑 Run 的 user 消息写入持久 history；`paused` 时生成 light note，只作为普通用户 prompt 的模型可见前缀，提示可 `/goal resume`，不触发自动恢复。
- **goal 工具组（模型接口）**：`CreateGoal` / `UpdateGoal` / `GetGoal` / `SetGoalBudget`。作为 builtin 工具注册，经 `sessionId` 定位到本 session 的 GoalStore 并触发迁移，是"模型自判终止"与"opt-in 预算设置"的落点。
- **GoalPersistence（持久化投影）**：定义 goal 的记录读写端口与数据库实现，负责 append/list 记录。`GoalStore.rebuild()` 使用这些记录回放状态，并在回放后执行 `normalizeAfterReplay()`（把落盘的 active 降级为 paused）。底层存储委托 `services/database`。

依赖方向：`commands` / `tools` / `driver` 都**向内依赖 GoalStore**；GoalStore 只向下依赖 GoalPersistence 的记录读写端口；GoalDriver 向外依赖 run-manager 的 `create()` / `waitForCompletion()` 契约。GoalStore 不反向依赖任何执行层。

一条贯穿全局的不变量：**goal 的结构化状态（status / turnsUsed / tokensUsed / wallClockMs / budgetLimits）存活在可压缩的消息历史之外**。它由 `GoalStore.rebuild()` 基于 GoalPersistence 记录重建，因此消息历史被自动 compact 压缩时，goal 记录本身永不丢失。续跑提醒文本则在 history 中——旧的可被 compact 压缩，最新的始终在尾部。两者共同保证长任务在 compact 中途触发时仍然自洽（详见第四节）。

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 聚合根 + 单一变更入口（GoalStore）

goal 的终止折叠规则、actor 边界、turn 计数、预算追踪、resume 降级彼此耦合，若让命令层、工具层、驱动层各自改状态，规则会散落且易冲突。因此把 GoalStore 设计为**唯一变更入口的聚合根**：所有迁移（create / resume / pause / markComplete / cancel / replaceObjective / incrementTurn / recordTokenUsage / setBudgetLimits）都必须过它，外部只能读快照。这直接支撑 Duty 1 与 Design Goal 2/4。

### 2. 编排层与执行层分离（GoalDriver 之于 RunManager）

不把 goal 语义塞进 Run 内部，而是让 GoalDriver 在 run-manager **之上**编排。理由：run-manager 需保持 turn-agnostic（它已服务普通对话、subagent 等场景），把"续跑循环"下沉进 Run 会污染它、也让 goal 的终止判定散到执行层。编排/执行分离让 goals 自洽，同时复用 run-manager 现成的并发、sandbox、abort 台账。这支撑 Duty 2 与"与运行调度分离"的 Non-Duty 1。

### 3. 续跑提醒作为持久 user 消息（仿 kimi append-only）

active 续跑提醒文本是 GoalStore 状态的函数：`active state → text`，无副作用、可随时重算。把它**作为续跑 Run 的 user 消息写入持久 history**而非临时注入，换来以下性质。paused 的 light note 也是同一渲染模块的纯函数，但它只在普通用户 prompt 前作为模型可见前缀出现，不属于 GoalDriver 的续跑消息：

- **崩溃可恢复**：进程崩溃后，history 仍承载 goal 上下文（objective + 进度 + 预算报告）。即使 GoalStore 记录重建出问题，模型仍能从 history 读到 goal 语境。
- **对 compact 自然幂等**：旧提醒被 compact 压缩掉，最新提醒在尾部——每轮都是新鲜的。不需要特殊机制处理 compact 交互。
- **无需新建注入子系统**：用现有的消息 append 机制即可，不引入 InjectionManager/DynamicInjector 等新基础设施。

代价：每轮 append 一条提醒消息（约 200-500 tokens），长 goal 会累积。但 compact 会自然压缩旧提醒，最新提醒始终在尾部——与 kimi 的实践一致。支撑 Duty 4 与 Design Goal 3。

### 4. 事件溯源式持久化（append records → rebuild）

沿用项目 `snapshot` / `run-ledger` 已有的"追加记录、从记录重建状态"姿态：goal 的每次迁移追加一条记录，`GoalStore.rebuild()` 读取并回放这些记录得到当前态，随后 `normalizeAfterReplay()` 对 active 做归一化降级。这天然支撑 Design Goal 4（跨 session 存活、恢复安全），并与项目存储惯例一致，避免自建存储层（Non-Duty 3）。

### 5. opt-in 预算 + 不可配置安全阀

预算是 opt-in 的：用户不设则无约束，设了则按 turn/token/time 三维度独立判定。`SetGoalBudget` 工具仅在用户明确要求时由模型调用。预算到顶 → `pause` + `pauseReason`（可恢复，用户可 `/goal resume` 再给一批）。`BudgetReport` 每轮注入到提醒文本中，让模型看到剩余量并主动收敛（75% 阈值时提醒"开始收敛"）。

当用户未设 turn 预算时，一个**写死的续跑轮上限**（安全阀）作为兜底，纯防"模型永不终止"的无限循环。安全阀不对用户/prompt 暴露，不可配置。已在测试中通过构造参数注入低上限来快速命中。

### 6. 刻意不引入的模式

- **不引入 PauseCause 枚举与多恢复路径**：所有 `paused` 同等处理，恢复统一为 `/goal resume`。`pauseReason` 仅供 UI 展示与 light note 使用，不驱动恢复逻辑分支。这避免了"五值枚举 × 三恢复路径"的测试矩阵爆炸与维护负担。
- **不引入 auto-resume**：用户插话打断 goal 后，goal pause；用户完成小任务后自行 `/goal resume`。goal 的 turn 与普通任务的 turn 共享同一 session、同一 message history，不做 context 隔离。简单、可预测、与 kimi/codex 一致。
- **不引入独立事件总线做 driver→UI 推送**：复用现成 `runtime/stream-bridge` 发布 goal 快照即可，避免额外的观察者复杂度。
- **不引入策略/插件式的"终止判定器"**：终止来源就四类（模型自判 + 用户控制 + 预算 + 安全阀），用直白的分支表达即可；抽象成可插拔策略是为想象中的未来服务，违反 YAGNI。
- **不新建通用注入子系统**：续跑提醒作为普通 user 消息写入 history，用现有消息系统即可。不需要 InjectionManager/DynamicInjector 等新基础设施。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/goals/
  index.ts              # 模块出口：装配 GoalService，暴露对外接口（生命周期操作、快照、工具集）
  store.ts              # GoalStore：状态机唯一入口、turn 计数、预算追踪、从记录重建
  driver.ts             # GoalDriver：续跑循环编排（在 run-manager 之上）+ 预算/安全阀判定
  injection.ts          # GoalInjector：active 全量提醒 + paused light note（纯函数）
  budget.ts             # GoalBudgetReport / 预算计算与判定
  persistence.ts        # GoalPersistencePort 实现，委托 services/database 的读写
  service.ts            # GoalService：commands / adapter / tools 共用的门面与 store 缓存
  tools.ts              # 四个 goal 工具定义与 execute（经 sessionId 触发 store 迁移）
  errors.ts             # GoalError 及错误码
  types.ts              # GoalStatus / GoalActor / GoalSnapshot / GoalBudgetLimits / GoalBudgetReport 等
  constants.ts          # GOAL_CONTINUATION_CORE、安全阀续跑轮上限、预算收敛阈值、objective 长度上限
```

对外稳定接口：`index.ts` 装配出的 GoalService（供 `commands` 调用生命周期操作、供 `driver` 推进、供 adapter 读取 light note、供 tool-scheduler 注册工具）。内部实现：`store.ts` / `driver.ts` / `persistence.ts` / `budget.ts` 的内部细节不对外暴露，允许在不破坏消费者的前提下演进。

文件划分刻意让"角色"显性：store=规则、driver=编排、injection=提醒/light note 产出、budget=预算、persistence=落盘、tools=模型接口——与 goals-duty 的 Duties 一一对应，便于追溯。

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. 与自动 compact 的交互（本模块的关键约束）

自动 compaction 住在 `core/lifecycle`，每轮按 usage 阈值触发。goals **不实现压缩**，而是让每一次续跑作为普通 Turn 免费继承它。为让长任务在 compact 中途触发时仍自洽，架构守三条不变量：

- **状态出带（out-of-band）**：goal 结构化状态（status / turnsUsed / tokensUsed / wallClockMs / budgetLimits）存活在可压缩消息历史之外，由 GoalPersistence 记录重建。压缩历史 → 不丢 goal 状态。
- **提醒在 history 中、每轮重生成**：GoalInjector 每轮渲染提醒文本并作为 user 消息 append 到 history。旧提醒被 compact 压缩掉，最新提醒在尾部——每轮都是新鲜的。即使旧提醒被压掉，GoalStore 状态仍在，下一轮照常重生成。
- **turn 计数与预算用量单调**：`turnsUsed` / `tokensUsed` / `wallClockMs` 随续跑单调递增，存于 goal 记录、不因 compact 缩小上下文而回退。预算判定因此稳定可判。

代价：续跑提醒每轮 append（约 200-500 tokens），长 goal 累积量靠 compact 自然消化。续跑 prompt 必须足够精简，依赖模型从"压缩后的历史 + 最新的续跑提醒"重建工作状态。这是刻意取舍：把鲁棒性放在"状态出带 + 每轮重生成"而非"保住某条历史消息"。

### 2. 放弃把 driveGoal 塞进 turn 层（kimi 的做法）

换取 run-manager 不被 goal 污染、goals 自洽可测。代价：goals 依赖 run-manager 的 `create()` / `waitForCompletion()` 契约稳定；续跑 Run 的中断与失败语义需由 GoalDriver 自己翻译成状态迁移。

**可逆决策说明**：driver 放在 run-manager 之上是可逆的。实现时若发现要大量重造 lifecycle 已有的"轮"编排（step 循环、工具调度、LLM 调用），回来重估"是否借 lifecycle 而非 run-manager"——那才是真正省事的信号。当前判断不需要重造：GoalDriver 调 `runManager.create()` + `waitForCompletion()`，每次续跑是一个完整 Run，lifecycle 在 Run 内照常跑 step 循环。两者是不同层级的循环，不冲突。

### 3. 并发取舍（interrupt-current），不做 auto-resume

run-manager 的并发由 `MultitaskStrategy = reject | queue | interrupt-current` 决定。当前 CLI in-process adapter 的落地方式是**adapter owner-aware interruption**：adapter 识别 in-flight prompt 属于 `goal` 还是 `user`；当 goal 活跃续跑期间用户发来普通消息，adapter 等到当前 goal run 注册完成后取消该 run，等待投影与 completion 收敛，再启动用户消息 Run。GoalDriver 捕获 cancelled → goal 转 paused。也就是说，对用户可见语义是 interrupt-current；具体取消入口在 adapter 边界完成，而不是依赖 run-manager 对普通 user/user prompt 启用全局 `interrupt-current`。

**不自动恢复**：用户的小任务完成后，goal 保持 paused，等用户自行 `/goal resume`。放弃 auto-resume 换取简单与可预测——用户知道自己打断了 goal，知道自己要恢复。不因暂停缘由区分恢复路径，不追踪队列状态，driver **不自动重入**（只由 `/goal resume` 显式触发，走幂等的 ensure-driving）。goal 的 turn 与普通任务的 turn 共享同一 session、同一 message history，模型在 resume 时能看到插话期间的增量。

（对接要求：run-manager 的取消无需区分 cancelReason。所有 cancelled → pause，`pauseReason` 仅供展示。）

### 4. 放弃 goals 自建存储

换取与项目统一存储层（`services/database`）一致；代价是依赖其 schema 与演进。

### 5. 结构可演进性说明

本文件描述当前阶段的合理结构，而非终态。若后续引入 `/goal next` 排队或 master/subagent 能力（当前明确在 Non-Duties），需回到 goals-duty.md 重新讨论职责边界，再评估是否新增子组件（如 GoalQueue），不在本结构内偷偷扩张。
