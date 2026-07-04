# goals 模块 test.md

本文档说明如何验证 `goals` 模块在协作环境中的正确性。遵循项目级测试规范（[docs-test/classification.md](../../docs-test/classification.md)：`unit` / `contract` / `integration` / `smoke`，就近命名），只补 goals 特有场景。测试围绕**职责与交互边界**，不围绕代码结构。

> 模块原型：**服务编排模块** → 主 `unit`、次 `integration`；对外接口/事件用 `contract` 固定。**禁止调用真实 LLM API**，续跑循环一律用 fake provider。

---

## 一、Test Scope（测试范围）

**覆盖（goals 自身职责）：**
- 状态机迁移与合法性：create / resume / pause / markComplete / cancel / replaceObjective / incrementTurn / recordTokenUsage / setBudgetLimits 全部经 GoalStore 唯一入口；actor 边界；`complete` 瞬态（宣告即清、从不落盘）；折叠规则。
- 预算与安全阀：三维预算（turn/token/time）opt-in 设定、到顶 pause 并记录 `pauseReason`、未设 turn 预算时安全阀兜底、BudgetReport 计算与收敛阈值。
- GoalDriver 编排：续跑循环、预算/安全阀判定、`RunCompletion` → 迁移映射、ensure-driving 幂等重入。
- GoalInjector：active 全量续跑提醒、paused light note、`<untrusted_objective>` 包裹与转义；active 提醒每轮重生成并作为 user 消息写入持久 history，light note 只作为普通用户 prompt 的模型可见前缀。
- GoalPersistence：追加/读取记录；GoalStore.rebuild 回放记录并执行 `normalizeAfterReplay`（active→paused 降级、清游离 complete）。
- goal 工具（CreateGoal / UpdateGoal / GetGoal / SetGoalBudget）经 `sessionId` 触发 store 迁移。
- GoalSnapshot / GoalChange / GoalBudgetReport 投影内容正确。
- UI adapter 的 goal prompt owner 分流：用户普通 prompt 可中断 active goal run；goal driver 不抢占正在执行的用户 prompt。

**不覆盖（属其他模块）：**
- run-manager 的 Run 机制、并发、sandbox、取消实现。
- llm-client 的 provider 重试与超时（继承能力，在 llm-client 自测）。
- core/context 的组装与 compact 内部实现（goals 只验证"提醒文本被产出并写入 history"，不验证组装点内部）。
- permission/policy 的权限决策。
- services/database 的 SQL、stream-bridge 的传输、UI 渲染。

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：状态机与折叠规则（unit）

| 场景 | 预期结果 |
|------|---------|
| create 有效 objective | 置 `active`，追加 `goal.create`，返回快照 |
| create 空 objective | 拒绝，不建记录 |
| markComplete | 发完成事件后**清记录**；重建后无 goal（从不落盘 `complete`） |
| pause | 置 `paused` 并带 `pauseReason`，**可恢复** |
| cancel | 丢弃记录，无残留状态；再次 cancel 无副作用 |
| replaceObjective（命令入口为 `/goal replace`） | objective 被替换，保持 goal 身份/生命周期语义一致 |
| 非法迁移（如对无 goal resume、对 active 再 create 未带 replace） | 明确拒绝或按既定规则处理，不进入不一致态 |

### 场景组 2：预算与安全阀（unit）

| 场景 | 预期结果 |
|------|---------|
| 设 token 预算，tokensUsed 未达 | 继续续跑 |
| 设 token 预算，tokensUsed 达上限 | pause(budget_exhausted)，**可恢复** |
| 设 turn 预算，turnsUsed 达上限 | pause(budget_exhausted)，**可恢复** |
| 设 wallClock 预算，wallClockMs 达上限 | pause(budget_exhausted)，**可恢复** |
| 未设 turn 预算，turnsUsed 达安全阀上限 | pause(safety_cap_reached)，**可恢复** |
| 设了 turn 预算 > 安全阀上限 | 按用户 turn 预算判定，安全阀不生效 |
| 任一预算用量达 75% | BudgetReport 标记 converging，提醒文本含收敛提示 |
| 未设任何预算 | 无预算约束，仅安全阀兜底 |
| 触发后 `/goal resume` | 回 active 再给一批续跑（预算用量不清零，继续累计） |
| turnsUsed / tokensUsed / wallClockMs 单调 | 跨 compact 不回退（见场景组 6） |

### 场景组 3：Driver 的 RunCompletion 映射（unit，fake run-manager）

| RunCompletion | 预期迁移 |
|------|---------|
| succeeded & goal 仍 active | 续下一轮 |
| succeeded & goal 已清 / 非 active | 退出循环 |
| cancelled | pause（`pauseReason: "interrupted"`） |
| failed | pause(`runtime-error`, reason)（failed 已是重试耗尽后的真失败） |

> **不区分 cancelReason。** 所有 cancelled → pause，`pauseReason` 仅供展示。

### 场景组 4：注入（unit + contract）

| 场景 | 预期结果 |
|------|---------|
| active | 全量提醒（objective + 进度 + 预算报告 + 自审指令） |
| paused | 轻提醒（不催干活、提示可 resume） |
| 无 goal | 空 |
| objective 含 `<`/`>`/`&` 或伪造 `</untrusted_objective>` | 被转义，无法越出包裹、无法当指令（**防注入，contract 固定**） |
| 连续两轮 | 各自重新渲染，作为 user 消息 append 到 history；旧提醒可被 compact 压掉 |
| 有预算时提醒含 BudgetReport | 模型可见剩余量与收敛提示 |
| 无预算时提醒不含预算行 | 不展示无意义的"unlimited" |
| 普通用户 prompt 遇到 paused goal | 发给模型的 prompt 含 light note；UI transcript 保持用户原文 |
| light note | 不含 `GOAL_CONTINUATION_CORE`，不触发自动恢复，只提示 `/goal resume` |

### 场景组 5：持久化与恢复安全（integration，真实 SQLite）

| 场景 | 预期结果 |
|------|---------|
| 迁移序列后重建 | 回放记录得到与内存一致的当前态（含预算、用量） |
| 重建时存在 active | `normalizeAfterReplay` 降级为 `paused`，**不自动续跑** |
| 重建时存在游离 complete | 被清除 |
| 记录落盘失败 | **显性失败**，不得让 goal 看似 active 却无法重建（不可接受静默失败） |
| compact 压缩消息历史后读 goal | goal 记录不丢（状态出带），turnsUsed/tokensUsed/wallClockMs 不回退 |
| compact 压缩掉旧提醒 | 最新提醒仍在尾部；下一轮重生成不受影响 |

### 场景组 6：ensure-driving 幂等（unit）

| 场景 | 预期结果 |
|------|---------|
| resume 触发转 active | 确保**恰好一个** driver 在跑 |
| 重复触发 ensure-driving | 不叠加多个 driver 循环 |

### 场景组 7：插话中断与显式恢复（integration，fake provider）

| 场景 | 预期结果 |
|------|---------|
| goal 续跑中用户发消息 | 续跑 Run cancelled → goal pause；用户消息在同一 session 执行 |
| goal 续跑中用户发消息 | 不抛 `"A prompt is already running"`，不要求用户先按 Esc |
| 插话用户消息的模型输入 | 包含 paused light note 和 `/goal resume` 提示，模型知道 goal 存在但不自动续跑 |
| 用户消息完成后 | goal 保持 paused，**不自动恢复** |
| 用户 `/goal resume` | goal 回 active，GoalDriver 重入续跑；模型能看到插话期间的增量 |
| 用户 Esc 中断 | goal pause，**不自动恢复**，需 `/goal resume` |
| 用户 prompt 正在跑时 goal driver 续跑 | goal driver 等待 prompt idle，不抢占用户 run |

> **无 auto-resume 测试**——所有暂停都需显式恢复。

---

## 三、Integration Points（集成点测试）

### 集成点 1：goals + run-manager（fake provider）—— 续跑走查骨架
**验证重点**：create → 续跑循环 → RunCompletion 映射 → 终态，以及插话中断 → pause → 显式 resume。
**方式**：真实 GoalDriver + 真实/可控 run-manager + **fake LLM provider**（可编排每轮返回 complete/paused/继续、或注入 cancelled/failed）。
**关注**：首轮输入=objective、后续=GOAL_CONTINUATION_CORE + 进度 + 预算报告；模型经工具改状态后 driver 正确读到并续跑或退出；插话 → pause → 用户 `/goal resume` → 重入续跑。

### 集成点 2：goals + services/database（真实 SQLite）
**验证重点**：记录追加、重建、`normalizeAfterReplay` 跨"模拟重启"的正确性。
**方式**：in-memory SQLite，不 mock database。
**关注**：active→paused 降级、游离 complete 清除、迁移序列可回放到一致态、预算与用量可重建。

### 集成点 3：goals 工具 + tool-scheduler（contract）
**验证重点**：CreateGoal / UpdateGoal / GetGoal / SetGoalBudget 的输入/输出结构与经 `ctx.sessionId` 落到正确 store 的迁移语义。
**方式**：真实工具执行 + fake/真实 store，断言"参数 X → 迁移 Y + 返回快照 Z"。

### 集成点 4：goals 续跑提醒 + message history（integration）
**验证重点**：续跑提醒作为 user 消息写入持久 history、旧提醒可被 compact 压缩、最新提醒在尾部、进程崩溃后 history 仍承载 goal 上下文。
**方式**：真实 GoalInjector + 真实 messageManager，验证 append、compact 后状态、重启后 history 可读。

---

## 四、Verification Strategy（验证策略）

**主策略：unit（mock 外部依赖）+ 少量 integration（真实 SQLite + fake provider）。**

**Mock 边界（unit）：**
- run-manager → fake（可配置返回 `RunCompletion`：succeeded / cancelled / failed）。
- services/database → fake store 或 in-memory。
- LLM provider → **fake，绝不真实 API**（分类规范硬约束）。
- 被测对象本身（GoalStore / GoalDriver / GoalInjector / budget）不 mock。

**不 mock（integration）：** in-memory SQLite、真实 GoalDriver 编排、真实 messageManager。

**contract 固定：** goal 工具的 I/O 结构、`goal.updated{sessionId, goal}` 事件形态、以及**注入转义**（防注入）作为消费者可见契约，单独 `.contract.test.ts`。

**可测性要求（重要）：** 安全阀虽对**用户/prompt 不可配置**，但测试需能以**内部构造参数**注入一个低上限，快速命中而不必真跑成千轮。预算同理——测试可注入低预算值快速触发到顶。即"对用户不可配置"≠"对测试不可注入"——安全阀常量与预算值应可在构造期被测试覆盖，但前者不暴露为用户 config，后者经工具/命令设定。

**重点关注（不可破坏行为）：**
- **恢复安全**：重建后绝不自动续跑 active（场景组 5）——最高优先，直接对应 non-functional 的不可接受失败。
- **防注入**：objective 转义与包裹不可绕过（场景组 4 contract）。
- **无双 driver**：ensure-driving 幂等（场景组 6）。
- **无静默失败**：Run failed / 落盘失败必须显性反映到状态与事件，不停在假 active。
- **预算判定正确**：三维独立、opt-in、到顶 block、安全阀仅未设 turn 预算时兜底（场景组 2）。
