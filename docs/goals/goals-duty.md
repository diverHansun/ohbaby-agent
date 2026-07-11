# goals 模块 goals-duty.md

本文档定义 `goals` 模块（`packages/ohbaby-agent/src/goals`）的设计目标与职责边界。

> 术语说明：本文中的 **goal** 指用户通过 `/goal` 发起的、跨多个 Turn 持续推进的**可验证长任务目标**，是一份带生命周期状态的持久记录。它不同于 `docs-plan` 里的"设计目标（Design Goals）"，也不同于 agent 单轮对话中的普通 prompt。**objective** 指 goal 的目标描述文本，**completion criterion** 指其可判定的成功条件。

---

## 一、Design Goals（设计目标）

### 1. 把"朝可验证目标持续推进的长任务循环"提升为一等能力

普通 prompt 说的是"下一步做什么"，goal 说的是"什么必须变为真"。当任务有清晰的终点、但下一步取决于 agent 在过程中学到什么时（修一批失败测试、定位构建失败根因），系统需要一个能在 Turn 边界之间自我延续、自我审计、自我终止的循环。goals 的目标就是把这个"长任务循环"从一次性的单轮 Run 中抽离出来，成为一个可被 `/goal` 启动、可被生命周期命令控制的独立模块。

### 2. 让终止由模型自审 + 用户控制主导，预算与安全阀兜底

长任务最大的风险是"跑飞"——在已完成或不可能的目标上空转。终止靠四条：**模型自审**（每轮自审后通过工具声明 complete / paused，主）、**用户控制**（`/goal pause` / `cancel` / Esc，随时）、**opt-in 预算**（用户、system 或 developer 明确声明的 turn/token/active-time 限制）与**不可配置安全阀**（1000 个 goal continuation turns 的系统绝对上限）。未声明预算时不创建产品级限制，agent 按 objective 完成度规划；安全阀不是默认预算，不进入预算报告或提示。单轮内的 step-runaway 由运行时既有的 per-run step 上限（`DEFAULT_MAX_STEPS`）兜住。

### 3. 把 objective 当作不可信数据，绝不越权

objective 与 completion criterion 来自用户输入，是"任务数据"而非"系统指令"。goals 追求：注入到模型上下文时始终以 `<untrusted_objective>` 包裹并转义，明确它不得覆盖 system / developer 消息、工具 schema、权限规则或宿主控制。防注入是这个模块的一等约束，而非事后补丁。

### 4. 跨 session 存活，且恢复是安全的

长任务天然可能跨越进程退出、崩溃与 `--resume`。goals 追求 goal 状态可从记录重建；且恢复时，任何"曾经 active"的 goal 必须降级为 paused——因为驱动循环已不在运行，绝不能让一个 goal 在无人知情时"自己又跑起来"。恢复的默认姿态是停、等用户显式 resume。

### 5. 与运行调度、权限、存储保持职责分离

goals 拥有"长任务循环"的编排，但不拥有 Run 的创建机制、并发与 sandbox（那是 run-manager）、不拥有权限决策（那是 permission/policy）、不拥有底层存储实现（那是 services）。goals 追求的是：编排它们，而不是替代它们。

---

## 二、Duties（职责）

### 1. 定义并维护单个 goal 的持久状态与生命周期规则

负责：
- 维护每个 session **恰好一个** current goal，从记录重建其内存态
- 定义生命周期状态机：`active`（唯一推进态）/ `paused`（存在但不推进，可恢复）/ `complete`（瞬态，宣告即清、从不落盘）；无 goal 用 `null` 表示
- 记录 `GoalActor`（`user | model | runtime | system`）与 `pauseReason`，用"谁停的 + 原因"折叠所有非 active 且可恢复的停因：用户插话、预算到顶、安全阀、模型自判需输入或无法继续、运行时报错都归一为 `paused`
- **不区分暂停缘由的枚举**：所有 `paused` 同等处理，恢复路径统一为 `/goal resume`。`pauseReason` 仅供 UI 展示与模型 light note 使用，不驱动恢复逻辑分支
- 作为所有状态迁移的**唯一入口**（create / resume / pause / markComplete / cancel / replaceObjective / incrementTurn / recordTokenUsage），并在入口处校验 actor 边界与迁移合法性

### 2. 编排续跑循环（GoalDriver）

负责：
- 在 `runtime/run-manager` **之上**编排：为 goal 起一个续跑 Run，`waitForCompletion` 读取 `{status, terminalReason}`，据此决定 pause / 续投下一轮；run 的 `terminalReason` 只会被转换成 goal 的 `pauseReason`
- 每轮先递增 turn 计数，使"模型声明 complete 的那一轮"被计入统计
- 把各终止分支映射到状态迁移：run cancelled → `pause`，run failed → `pause`，模型已清记录或非 active → 结束循环，**预算到顶 → `pause`**，**续跑轮数达 1000-turn 系统绝对上限 → `pause`**
- 每轮循环顶部检查预算与安全阀（借鉴 kimi 的跨轮守卫骨架：循环顶部判定→到顶 pause）
- 只在 goal `active` 时推进；paused / complete / null 都不续投
- **不做 auto-resume**：用户插话打断 goal 后，goal pause；用户完成小任务后自行 `/goal resume` 恢复。goal 的 turn 与普通任务的 turn 共享同一 session、同一 message history，不做 context 隔离
- 当 goal 从 active 进入 paused/cancelled 时，通过 adapter 提供的 execution-control port 等待当前 goal execution 停止；goals 只声明停止语义，不依赖 RunManager/SubagentHost 实现

### 3. 提供模型自判终止与预算设置的工具

负责：
- 提供 `CreateGoal` / `UpdateGoal`（active / paused / complete）/ `GetGoal` / `SetGoalBudget` 工具定义与执行逻辑，供模型在自审后声明终止、读取当前状态或记录用户要求的预算
- 工具经 `sessionId` 定位并变更本 session 的 goal store（复用 tool-scheduler 现有的 `ToolExecutionContext`）
- `SetGoalBudget` 是 opt-in 的：main 只翻译用户、system 或 developer 明确给出的限制，不得自行估算或发明；不设则无产品级预算约束
- 用户不直接传结构化参数，也不提供 `/goal budget`；tool 每次接受一个 `{ value, unit }`，unit 支持 turns/tokens/milliseconds/seconds/minutes/hours
- time 预算只累计 active pursuit，paused 时间不计；在 continuation 边界执行，不承诺精确 deadline
- `UpdateGoal(complete)` 是 main 的最后生命周期动作：main 必须先等待/收敛 subagents，完成目标、验证与最终结论；工具返回后输出最终回答并结束，不再开始新工作

### 4. 生成续跑提醒与 paused light note

负责：
- 提供 GoalInjector：根据当前 goal 状态产出模型可见文本（纯函数、无副作用）。`active` 生成全量续跑提醒（进度 + 预算报告 + 自审指令）；`paused` 生成 light note（不自动干活，提示可 `/goal resume`）；无 goal 返回空
- 以 `<untrusted_objective>` / `<untrusted_completion_criterion>` 包裹并做 HTML 转义
- `active` 续跑提醒作为续跑 Run 的 user 消息写入持久 history（仿 kimi 的 append-only 方式），旧提醒可被 compact 自然压缩，最新提醒始终在尾部
- `paused` light note 只作为普通用户 prompt 的模型可见前缀，不展示到 UI transcript，不触发 GoalDriver，也不自动恢复 goal

### 5. 提供生命周期命令的后端能力

负责：
- 为 `commands` 层暴露 goal 生命周期操作：创建（`/goal <objective>`）、查询（`/goal status`）、`pause` / `resume` / `cancel` / `replace <objective>`；其中命令 `replace` 路由到 store 的 `replaceObjective`
- 命令层只做解析与转发，具体的状态迁移与合法性判断由 goals 承担

### 6. 定义持久化数据模型并委托存储

负责：
- 定义 goal 的持久化数据模型（事件/快照结构、turnsUsed、tokensUsed、wallClockMs、budgetLimits、pauseReason）
- 把记录的 append/list 委托给 `services/database`（与 snapshot 模块同一姿态），不自建存储层
- 由 `GoalStore.rebuild()` 回放记录重建状态，并提供恢复归一化（`normalizeAfterReplay`）：进程重启 / `--resume` 后，把落盘的 active goal 降级为 paused

### 7. 暴露 goal 快照供上层展示

负责：
- 提供 goal 快照（objective、status、turnsUsed、tokensUsed、wallClockMs、budgetLimits、budgetReport、pauseReason 等机器可读结构），供 CLI `/goal status` 与后续 Web UI（button / 卡片）读取
- 只输出数据，不耦合具体渲染

---

## 三、Non-Duties（非职责）

### 1. 不负责 Run 的创建机制与执行

goals 通过调用 `runtime/run-manager` 的 `create()` / `waitForCompletion()` 来编排续跑，但不管理 Run 的并发策略、sandbox 租约、abort 机制或台账——那是 run-manager 的职责。goals 只关心"这一轮 Run 结束后，goal 该往哪个状态走、要不要再来一轮"。

### 2. 不负责权限决策或工具审批

goal 工作在何种权限模式下、某次工具调用是否需要用户批准，由 `permission` / `policy` 决定。goals 在既定权限模式下推进循环，不放宽、不收紧权限，也不代替用户审批。

### 3. 不实现底层存储

goals 定义 goal 的数据模型并委托 `services/database` 落盘，不自建文件/DB 存储层，不管理存储配额或清理策略的底层实现。

### 4. 不负责上下文组装与压缩

每轮上下文的拼装、token 估算与压缩由 `core/context` / `core/system-prompt` 负责。goals 只**产出**模型可见文本：active 续跑提醒作为 user 消息写入 history，由现有消息系统持久化；paused light note 由 adapter 加到普通用户 prompt 的模型输入前缀。提醒在 history 中的位置、是否被 compact 压缩，由 context 模块按既有规则决定。**无需新建通用注入子系统**——goals 用现有的消息 append 与 adapter prompt 边界即可。

### 5. 不做 master/subagent 多智能体编排

本模块走单-agent 自审路线：同一个 agent 每轮自审并通过工具自判终止。goals 不派生 subagent、不实现"master 监控 + 重启 subagent"式的多智能体循环——那与 `agents/tasks` 是不同的能力，明确不在本模块范围内。

但 goals 对“离开 active 后执行必须停止”负责：它通过抽象 port 请求 adapter 停止 goal-owned primary 与当时的 active subagents。停止的具体实现、subagent 续接与 close 仍属于 execution/main agent，不构成 goals 拥有多智能体编排。

### 6. 不做 auto-resume，不区分暂停缘由驱动恢复

goals **不自动恢复**被插话打断的 goal。用户插话 → goal pause → 用户完成小任务 → 用户自行 `/goal resume`。所有 `paused` 同等处理，不因暂停缘由区分恢复路径。goal 的 turn 与普通任务的 turn 共享同一 session 与 message history，不做 context 隔离。

### 7. 不负责 UI 渲染与交互面板

goals 暴露快照与生命周期操作，具体的 CLI 文本渲染、Web button / 卡片由 UI 层实现。CLI 保持 `/goal` 命令式控制；Web 中 `/goal...` 是 Goal 管理面板入口，参数只用于预填或高亮对应动作，不直接执行生命周期子命令。首版**不含** `/goal next` 排队。

### 8. 不解释工具语义或判断任务内容对错

某次工具调用在语义上意味着什么、目标本身是否"值得做"，不是 goals 的职责。goals 只记录由模型声明的状态迁移与运行时触发的终止，不对目标内容做价值判断。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `commands` | 被依赖 | `/goal` 系列命令解析后转发到 goals 的生命周期操作；命令层不持有状态机 |
| `runtime/run-manager` | 依赖 | GoalDriver 调用 `create()` / `waitForCompletion()` 编排续跑 Run；adapter 取消 active goal run 后由 run-manager 产出 `cancelled` completion；run-manager 保持 turn-agnostic，不感知 goal |
| `core/tool-scheduler` | 被依赖 | goal 工具（CreateGoal / UpdateGoal / GetGoal / SetGoalBudget）作为 builtin 工具注册，经 `sessionId` 定位并变更 goal store |
| `core/context` / `core/system-prompt` | 被依赖 | 上下文组装/压缩由其负责；续跑提醒作为普通 user 消息在 history 中，由 context 按既有规则组装与压缩 |
| `services/database` | 依赖 | goal 事件/快照索引与元数据落盘，供进程重启后重建 |
| `permission` / `policy` | 无直接依赖 | goal 循环在既定权限模式下运行；审批由 permission 层处理 |
| `runtime/stream-bridge` / UI | 被依赖 | CLI `/goal status` 与后续 Web UI 读取 goal 快照展示 |
| `agents/tasks` | 明确分离 | subagent 编排是独立能力，goals 不复用它做多智能体循环 |
| adapter execution control | 依赖抽象端口 | goal 离开 active 时请求停止当前 goal execution；adapter 负责映射到 goal-owned run 与 parent subagents |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：GoalDriver 在 run-manager 之上编排续跑，据完成态决定去向
```typescript
// goals/driver.ts（示意）
while (true) {
  const goal = store.get()
  if (goal?.status !== "active") return
  if (isBudgetExhausted(goal) || isSafetyCapReached(goal)) {
    await store.pause("budget or safety cap reached", "runtime")
    return
  }
  await store.incrementTurn()
  const completion = await runManager.create(/* 续跑 run: reminder as user message */)
    .then((r) => runManager.waitForCompletion(r.runId))
  if (completion.status === "cancelled") { await store.pause("interrupted"); return }
  if (completion.status === "failed")    { await store.pause("runtime error"); return }
  const next = store.get()
  if (next === null || next.status !== "active") return // 模型已 UpdateGoal(complete/paused)
}
```

正确：UpdateGoal 工具经 sessionId 变更 goal store
```typescript
// goals/tools.ts 中的 UpdateGoal（示意）
execute(params, ctx) {
  const store = goals.storeFor(ctx.sessionId)
  return store.applyModelUpdate({ status: params.status, reason: params.reason })
}
```

正确：SetGoalBudget 工具 opt-in 设预算
```typescript
// goals/tools.ts 中的 SetGoalBudget（示意）
execute(params, ctx) {
  const store = goals.storeFor(ctx.sessionId)
  return store.setBudgetLimits({ tokenBudget: params.tokenBudget, ... })
}
```

错误：goals 不应自己截断上下文或决定注入位置
```typescript
// 错误：不应该在 goals 中
context.insertAt(0, reminder); context.compact()

// 正确：goals 把 reminder 作为 user 消息写入 history，组装/压缩由 context 负责
const reminder = goals.injector.render(sessionId)
await messageManager.appendUserMessage(sessionId, reminder)
```

### 5.2 职责外的示例

错误：goals 不应管理 Run 的并发/sandbox
```typescript
// 错误：不应该在 goals 中
const lease = await sandboxManager.acquire(sessionId)

// 正确：续跑 Run 的 sandbox 与并发由 run-manager 负责，goals 只调用 create()/waitForCompletion()
```

错误：goals 不应代替用户审批权限
```typescript
// 错误：不应该在 goals 中
const ok = await permission.ask("Run this command during the goal?")

// 正确：goal 循环在既定权限模式下运行，审批由 permission 层完成
```

错误：goals 不应派生 subagent 做多智能体循环
```typescript
// 错误：不应该在 goals 中
await tasks.spawnSubagent({ objective })

// 正确：单-agent 自审——同一 agent 每轮自审并通过工具自判终止
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：goals 把"朝可验证目标持续推进、可自审终止、有 opt-in 预算与不可配置安全阀兜底、可跨 session 恢复"的长任务循环，做成由 `/goal` 启动、独立于单轮 Run 的一等能力。
- 能清楚回答"这个模块不该做什么"：不管理 Run 机制、不做权限决策、不实现底层存储、不组装/压缩上下文、不做多智能体编排、不做 auto-resume、不区分暂停缘由驱动恢复、不渲染 UI、不判断任务内容对错。
- 职责与其他模块无明显重叠：run-manager（Run 台账与执行）、permission/policy（审批）、services/database（存储）、core/context（上下文组装）、agents/tasks（多智能体）边界清晰；goals 只拥有"长任务循环编排 + goal 状态机 + 预算追踪 + 续跑提醒文本 + goal 工具"。
