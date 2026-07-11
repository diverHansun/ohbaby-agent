# goals 模块 data-model.md

本文档是 `goals` 模块的**概念词典**：统一讨论、接口与实现使用的领域语言。它不冻结实现，不列完整类型。所有概念服务于 [goals-duty.md](./goals-duty.md) 与 [architecture.md](./architecture.md)。

---

## 一、Core Concepts（核心概念）

- **Goal（目标）**：一个 session 内、朝可验证结果持续推进的**持久任务记录**。有身份（`goalId`）、有生命周期。一个 session 恰好一个 current goal。
- **Objective（目标描述）**：goal 要"变为真"的文本。作为不可信数据注入，不作指令。
- **Completion Criterion（完成判据）**：可判定的成功条件。可选——缺失时靠模型自审判断。
- **GoalStatus（生命周期状态）**：`active` / `paused` / `complete`。`complete` 为瞬态（宣告即清、不落盘）；无当前 goal 用 `null` 表示。
- **GoalActor（触发者）**：`user` / `model` / `runtime` / `system`。记录"谁触发了这次迁移"，与 pauseReason 一起把多种停因折叠进 `paused`。
- **PauseReason（暂停原因）**：`paused` 时的人读说明，供转录、UI 展示与 light note 使用。**不驱动恢复逻辑分支**——所有 `paused` 的恢复路径统一为 `/goal resume`。
- **GoalBudgetLimits（预算上限）**：opt-in 的三维上限：`tokenBudget?` / `turnBudget?` / `wallClockBudgetMs?`。全部可选，未设的维度无约束。用户以自然语言声明限制，main 仅翻译用户、system 或 developer 明确给出的限制，经 `SetGoalBudget(value, unit)` 每次设置一个维度；不得自行发明预算。
- **GoalBudgetReport（预算报告）**：从 GoalState + GoalBudgetLimits 计算的只读投影：各维度剩余量、是否到顶、整体 overBudget 标志。每轮注入到续跑提醒文本中，让模型看到剩余量并主动收敛（75% 阈值时提醒"开始收敛"）。
- **SafetyCap（安全阀）**：一个**不可配置、不对外暴露**的 1000-turn 系统绝对上限，始终生效且不能被显式预算绕过。它不是默认预算，不进入预算报告、不驱动预算式规划；命中后转 `paused`，保留 goal。一个 goal turn 只统计 main 的 goal continuation，不统计 subagent turns、tool calls 或单轮模型步骤。
- **UsageCounters（用量计数）**：`turnsUsed` 驱动 turn 预算与安全阀；`tokensUsed` 驱动 token 预算；`wallClockMs` 驱动 active-time 预算。time 只在 `active` pursuit 区间累计，paused 时间不计，并只在 continuation 边界判定。三者均**单调递增**，不因 compact 缩小上下文而回退。
- **GoalRecord（目标记录）**：goal 迁移的追加式事件（创建 / 更新），是持久化与重建的来源。
- **GoalSnapshot（目标快照）**：对外暴露的只读投影，命令层 / 注入器 / UI 都读它，不读内部可变态。
- **GoalChange（变更描述）**：一次 goal 更新"变了什么"的描述（是生命周期迁移还是成功完成 + actor + pauseReason + 当时用量），供 UI 决定如何渲染。

---

## 二、Entity / Value Object 区分

- **Entity（有身份、有生命周期）**：`Goal`——由 `goalId` 标识，跨多轮存在，状态随迁移改变。
- **Value Object（无身份、不可变快照）**：`GoalSnapshot`、`GoalChange`、`GoalBudgetLimits`、`GoalBudgetReport`。它们是某一时刻的只读投影，不持有身份。

（不强求 DDD，此区分只为讲清"谁会变、谁是快照"。）

---

## 三、Key Data Fields（关键数据要素，描述含义而非类型）

**Goal（及其快照）承载的要素：**

- `goalId`：goal 的身份。
- `objective` / `completionCriterion`：目标描述与完成判据（后者可选）。
- `status`：当前生命周期状态。
- `turnsUsed` / `tokensUsed` / `wallClockMs`：累计用量，分别驱动 turn/token/active-time 预算；turnsUsed 还驱动系统安全阀。
- `budgetLimits`：opt-in 预算上限（三维可选）。
- `pauseReason`：暂停的人读原因，仅供展示与 light note 使用。
- `pauseCause`：**无此字段**。所有 `paused` 同等处理，不区分子类型。

**GoalBudgetLimits 承载的要素：** `tokenBudget?` / `turnBudget?` / `wallClockBudgetMs?`，全部可选。未设的维度无产品预算约束。

**GoalBudgetReport 承载的要素：** 三维剩余量（remainingTokens / remainingTurns / remainingWallClockMs）、是否到顶、整体 overBudget 标志、是否接近显式预算阈值（≥75% 时标记 converging）。系统 1000-turn 安全阀不进入该报告。

**SafetyCap 承载的要素：** 一个写死为 1000 的最大续跑轮数常量（不在 Goal 上、不可配置）。判定：`turnsUsed >= 常量` → `paused + pauseReason`，无论是否存在显式 turn budget。无剩余量报表、不对外暴露。

**GoalRecord 承载的要素：** 迁移类型（创建/更新）、变更后的关键字段（status / turnsUsed / tokensUsed / wallClockMs / budgetLimits / pauseReason / actor）。用于回放重建，不是给人读的日志。旧记录中的 `reason` 仅作回放兼容，新的记录写 `pauseReason`。

---

## 四、状态迁移规则

### 4.1 状态迁移的折叠规则

不为每种停因新增状态，而用 **actor + pauseReason** 折叠：

- 模型自判完成 → `complete`（瞬态，清记录）
- 模型自判无法推进 / 目标不可能 → `paused` + pauseReason（可恢复）
- 预算到顶（任一已设维度） → `paused` + pauseReason（可恢复）
- 续跑轮数达 1000-turn 系统安全阀 → `paused` + pauseReason（可恢复）
- 运行时/模型/provider 报错 → `paused` + reason（可恢复）
- 用户或插话中断 → `paused` + reason（可恢复）
- 进程重启/`--resume` → active 降级为 `paused`（`normalizeAfterReplay`）
- 用户 `/goal cancel` → 丢弃记录（无状态）

### 4.2 恢复路径（统一）

**所有 `paused` 的恢复路径统一为 `/goal resume`。** 不因暂停缘由区分恢复逻辑，不自动恢复，不做模型据意图恢复。

- 用户插话打断 → goal pause → 用户完成小任务 → 用户自行 `/goal resume`
- 运行时错 → goal pause → 用户排查后 `/goal resume`
- 进程重启 → active 降级为 paused → 用户 `/goal resume`
- 预算到顶 / 安全阀触发 → goal paused → 用户 `/goal resume` 再给一批

要点：**简单、可预测。** 用户始终知道：要恢复 goal，敲 `/goal resume`。goal 的 turn 与普通任务的 turn 共享同一 session、同一 message history，模型在 resume 时能看到插话期间的增量，无需重复。

**瞬时超时/provider 错不由 goals 处理**——续跑轮作为普通 Turn 已继承 llm-client 的 provider 重试策略（与正常对话一致，`maxRetriesPerStep`），只有重试**耗尽**或错误**不可重试**时 Run 才 failed → pause(`runtime-error`)；goals 不加自己的重试层。

---

## 五、Lifecycle & Ownership（生命周期与归属）

- **创建**：两条入口写同一个 store——用户 `/goal <objective>`（命令直写）或模型 `CreateGoal` 工具。创建即置 `active` 并启动续跑。
- **更新**：所有迁移经 **GoalStore 唯一入口**。用量由 GoalDriver 在每轮推进时累计（turn 计数、token 消耗、wall-clock 锚点）；预算由 `SetGoalBudget` 工具或命令参数设定；`tokensUsed` 按**累计消耗单调增长**，不因 compact 缩小上下文而回退。
- **失效/清除**：`complete` 宣告后即清记录；`cancel` 直接丢弃。
- **持久化与重建**：每次迁移追加 GoalRecord，落盘委托 `services/database`；进程重启时由 `GoalStore.rebuild()` 回放记录重建，并对 active 执行 `normalizeAfterReplay` 降级为 `paused`。
- **归属**：GoalStore 是 goal 状态的唯一拥有者；GoalSnapshot / GoalChange / GoalBudgetReport 是它派生的只读投影，由消费者（命令/注入器/UI）读取，任何人不得绕过 store 改状态。安全阀常量属于 GoalDriver，不在 goal 数据上。

---

## 六、文档自检

- 每个概念都能一句话解释，使用领域语言。
- 无"为设计而设计"的抽象：`GoalBudgetLimits` / `GoalBudgetReport` 服务于 opt-in 预算控制与模型收敛信号；`GoalChange` 服务于 UI 渲染区分；`SafetyCap` 服务于防跑飞兜底——都能在 dfd-interface / use-case 中找到使用场景。
- 已移除 `PauseCause`——所有 `paused` 同等处理，恢复统一为 `/goal resume`。已移除"三条恢复路径"——不自动恢复、不模型据意图恢复。
- 与 goals-duty / architecture 无冲突：状态机、折叠规则、单一入口、委托存储、opt-in 预算、续跑提醒写入 history 均一致。
