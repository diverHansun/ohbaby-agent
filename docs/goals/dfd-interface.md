# goals 模块 dfd-interface.md

本文档以**数据流优先、接口从属**的视角，说明 `goals` 模块的数据从哪来、经过什么、流向哪，以及承载这些流动的接口。概念沿用 [data-model.md](./data-model.md)，结构沿用 [architecture.md](./architecture.md)，不引入新职责。

---

## 一、Context & Scope（上下文与范围）

goals 处在"命令/模型触发"与"运行执行/上下文/存储"之间，是长任务循环的编排中枢。本文档只描述数据如何进出 goals，不画全局拓扑。

**输入来源：**
- `commands`：`/goal` 系列命令（创建/状态/暂停/恢复/取消/替换，可带预算参数）。
- `core/tool-scheduler`：模型调用 goal 工具（CreateGoal / UpdateGoal / GetGoal / SetGoalBudget）。
- `runtime/run-manager`：续跑 Run 的完成信号（`RunCompletion`）。
- 宿主启动流程：进程重启 / `--resume` 时的重建触发。

**输出目标：**
- `runtime/run-manager`：请求起一轮续跑 Run。
- `core/message`（经 run-manager 输入）：续跑提醒文本作为 user 消息写入持久 history。
- `services/database`：追加 GoalRecord、读取以重建。
- `runtime/stream-bridge` → CLI / Web：goal 快照与变更事件。

**Level-0 上下文图（goals 与外部模块的数据往来）：**

```
   /goal 命令 ─────────────▶┌─────────────────────────────┐─────▶ run-manager
   (commands)               │                             │       create / waitForCompletion
                           │                             │◀───── RunCompletion{status,reason}
   goal 工具 ──────────────▶│           goals             │
   (tool-scheduler)         │  ┌───────────────────────┐  │─────▶ message history (经 run-manager 输入)
                           │  │ Store · Driver ·      │  │       续跑提醒作为 user 消息 append
   RunCompletion ──────────▶│  │ Injector · Budget ·   │  │
   (run-manager)            │  │ Persistence           │  │─────▶ services/database
                           │  └───────────────────────┘  │◀───── GoalRecord (重建)
   重建触发 ───────────────▶│                             │
   (host resume/--resume)   │                             │─────▶ stream-bridge → CLI / Web
                           └─────────────────────────────┘       goal 快照 / 变更事件
```

> 续跑提醒作为普通 user 消息写入 history，无需新建通用注入子系统。组装/压缩由 `core/context` 按既有规则处理。

---

## 二、Data Flow Description（数据流描述）

本节先给两张过程图（续跑循环 / 持久化重建），再逐流文字描述。

**图 1 — GoalDriver 续跑循环（流 B，仅 `active` 推进）：**

```
start ┌──────────────┐  预算到顶或安全阀触发  ┌─────────────┐
─────▶│  读 GoalStore │─────────────────────▶│ pause       │──▶ 退出循环
      └──────┬───────┘                       └─────────────┘
             │ active 且预算/安全阀未到顶
             ▼
      ┌──────────────┐   ┌───────────────────────────┐
      │ incrementTurn │─▶│ 渲染续跑提醒(流D)          │
      └──────────────┘   │  首轮 = objective          │
                         │  后续 = GOAL_CONTINUATION_CORE│
                         │    + progress + budget     │
                         └─────────────┬─────────────┘
                                        ▼ 作为 user 消息
                           ┌───────────────────────────┐
                           │ run-manager.create         │
                           └─────────────┬─────────────┘
              (Run 内: 模型可调 goal 工具[流C])
                                        ▼ waitForCompletion
                              ┌───────────────────┐
                              │   RunCompletion    │
                              └─────────┬─────────┘
        succeeded & active ┌────────────┼──────────────────────┐ failed
                           │            │ succeeded &           │ → pause(runtime-error)
                           ▼            │ (complete / 非 active) ▼
                     回到"读 GoalStore"  ▼                   cancelled
                                   退出循环            → pause(interrupted)
```

**图 2 — 持久化与重建（流 G）：**

```
  每次迁移 ──▶ append GoalRecord ──▶ services/database
                                          │
  进程重启 / --resume ──▶ rebuild ◀────────┘
                            │
                            ▼
              normalizeAfterReplay:  active ──▶ paused（reason: 重启后降级）
                                     游离 complete ──▶ 清除
```

### 流 A：启动（命令直写 store）

1. 用户输入 `/goal <objective>`（模块外，commands）。
2. commands 解析后调用 goals 的**创建入口**，把 objective（及可选 criterion、可选预算参数）传入（进入模块）。
3. 模块内：GoalStore 执行 create 迁移 → 置 `active`；若有预算参数则 `setBudgetLimits`；GoalPersistence 追加一条 `goal.create` 记录 → 落 `services/database`（模块外）。
4. 模块内：goals 调用**驱动入口**启动 GoalDriver（进入流 B）。
5. 输出：向 stream-bridge 发布一次 `goal.updated`（created）快照。

分支：objective 为空 → 拒绝，不建记录。`CreateGoalInput.replace` 是"已有 goal 时允许新建覆盖"的布尔开关；它不同于 `/goal replace` 路由到的 `replaceObjective`。

### 流 B：续跑循环（GoalDriver，模块内主循环）

每一轮迭代：

1. 读 GoalStore 当前态；若 `active` 且（任一已设 turn/token/active-time 预算到顶 **或** 续跑轮数达 1000-turn 系统绝对上限）→ pause（写入 `pauseReason`）→ 退出循环。
2. incrementTurn（追加记录：turn 计数、wall-clock 锚点）。
3. 渲染续跑提醒文本（流 D）：首轮=objective、后续轮=GOAL_CONTINUATION_CORE + 进度 + 预算报告。
4. 起一轮续跑 Run：调用 `run-manager.create(...)`，输入为**续跑提醒文本作为 user 消息**；`waitForCompletion` 等待 `RunCompletion`。该 Run 执行期间，模型可见 goal 工具。token 消耗由 GoalDriver 在 Run 完成后 `recordTokenUsage`。
5. 依 `RunCompletion.status` 分支（把执行结果翻译成状态迁移）：
   - `succeeded` 且 goal 仍 `active` → 回到步骤 1，续下一轮。
   - `succeeded` 但 goal 已清（complete）或非 active（模型经流 C 改了状态）→ 退出循环。
   - `cancelled` → pause（`pauseReason: "interrupted"`）→ 退出循环。
   - `failed` → pause(`runtime-error`, reason) → 退出循环。（`failed` 已是 llm-client provider 重试耗尽 / 不可重试后的真失败——瞬时超时在 Run 内由继承的重试策略兜过，与正常对话一致；goals 不加自己的重试层。）
6. 每次迁移 → 追加记录 + 发布快照。

一条不变量：**只有 `active` 才推进**；循环退出即意味着 goal 进入 paused、complete 或 null 之一。

### 流 C：模型自判与调整（工具，模块内迁移）

1. 某轮 Run 执行中，模型调用 goal 工具（模块外 tool-scheduler 调度）。
2. 工具 `execute(params, ctx)` 以 `ctx.sessionId` 定位本 session 的 GoalStore（进入模块）。
3. 模块内迁移：`UpdateGoal(complete/paused/active)` / `GetGoal`（只读）/ `SetGoalBudget`（opt-in 设预算）/ `CreateGoal`（prose 自主请求）。
4. 追加记录 + 发布快照；驱动循环在本轮 Run 完成后（流 B 步骤 5）读到新状态并据此续跑或退出。

约束：`SetGoalBudget` 是 opt-in 的，仅当用户明确要求时模型才调用。`replaceObjective` 亦经此类迁移替换 objective；`CreateGoalInput.replace` 仅表示"创建时允许覆盖已有 goal"。

### 流 D：续跑提醒与 light note（模块内产出 → 不同入口消费）

1. `active`：GoalDriver 在起续跑 Run 前调用 `renderGoalTurnPrompt`，渲染全量提醒（objective + 进度 + 预算报告 + 自审指令）。
2. `active` 输出：全量提醒作为续跑 Run 的 **user 消息**经 run-manager.create 输入写入持久 history。
3. `paused`：普通用户 prompt 提交前，adapter 调用 `renderGoalContextNote`，渲染 light note（说明 goal 存在、不会自动推进、可 `/goal resume`）。
4. `paused` 输出：light note 只作为本次普通用户 Run 的模型可见前缀；UI transcript 仍展示用户原始输入，不触发 GoalDriver，不自动恢复 goal。
5. 关键性质：active 续跑提醒**每轮重新渲染、作为 user 消息 append 到 history**——旧提醒可被 compact 压缩，最新提醒在尾部。light note 只补充 paused goal 的可见性，不承担续跑职责。

### 流 E：插话中断（不做 auto-resume）

1. goal 续跑期间用户发来普通消息（模块外）→ CLI in-process adapter 识别当前 in-flight owner 是 `goal`，等待 goal run 注册完成后取消该 run，再启动用户 Run → goal 的续跑 Run 被 `cancelled`。对用户可见语义是 interrupt-current，但实现点在 adapter 边界，而不是给普通 user/user prompt 全局启用 run-manager `interrupt-current`。
2. 流 B 步骤 5 捕获 `cancelled` → GoalStore pause（`pauseReason: "interrupted"`）→ 退出循环。
3. 用户的小任务在**同一 session** 中执行，共享 message history。模型能看到 goal 的工作 + 用户的插话。
4. 用户完成小任务后，自行 `/goal resume` → goal 回 active → GoalDriver 重入续跑循环（回到流 B）。

**不自动恢复。** 不追踪队列状态，不区分 cancelReason，driver **不自动重入**——只由 `/goal resume` 显式触发（该启动仍走 ensure-driving，幂等）。简单、可预测。

### 流 G：持久化与重建

1. 每次迁移 → GoalPersistence 追加 GoalRecord → `services/database`（模块外）。
2. 进程重启 / `--resume` → 宿主触发重建入口 → 回放记录重建 GoalStore 态 → `normalizeAfterReplay` 把 `active` 降级为 `paused`，清理游离的 `complete`。

### 流 H：快照输出

1. 任何迁移 → 发布 `goal.updated{goal, sessionId}` 经 stream-bridge → CLI / Web 渲染（模块外）。`goal: null` 表示 goal 已完成或取消，UI 应隐藏状态条。
2. `/goal status` → 读取当前 GoalSnapshot 返回命令层。

---

## 三、Interface Definition（接口定义，语义层）

### 3.1 goals 对外暴露（inbound）

| 逻辑接口 | 输入含义 | 输出含义 | 同步性 | 服务的数据流 |
|---|---|---|---|---|
| 生命周期操作（create / status / pause / resume / cancel / replaceObjective；命令名为 `/goal replace`） | sessionId + objective/criterion（按操作）；预算仅经模型工具翻译 | 迁移结果 / 当前快照 / 错误 | 同步迁移，create·resume 触发异步驱动 | A, C, E, H |
| 驱动启动（ensure-driving） | sessionId | 确保 active goal 有恰一个 driver 在跑（幂等）；由 create 与 `/goal resume` 显式触发，不自动 | 异步 | A, B, UC-4 resume |
| 注入渲染（render-injection） | sessionId + goal snapshot | active 续跑提醒、paused light note，或"无" | 同步、纯函数 | D |
| 快照读取（get-snapshot） | sessionId | GoalSnapshot 或 null | 同步 | H |
| goal 工具（CreateGoal/UpdateGoal/GetGoal/SetGoalBudget） | 工具参数 + ctx.sessionId | 迁移后的快照 / 只读快照 | 同步迁移 | C |
| 重建与归一（rebuild / normalizeAfterReplay） | sessionId（及记录来源） | 重建后的 store 态 | 异步 | G |

### 3.2 goals 依赖的外部接口（outbound）

| 依赖接口 | goals 期望的语义 | 同步性 | 风险 |
|---|---|---|---|
| run-manager `create` + `waitForCompletion` | 起一轮续跑 Run（输入含 user 消息）并返回 `{status, terminalReason, usage?}`；goal run 被 adapter 取消后以 `cancelled` completion 收敛 | 异步 | 契约需稳定；取消无需区分 cancelReason（所有 cancelled → pause，写入 `pauseReason`） |
| core/message（经 run-manager 输入） | 续跑提醒文本作为 user 消息写入持久 history，由现有消息系统持久化、由 context 按既有规则组装与压缩 | 同步写入 | 无新风险，复用现有机制 |
| services/database | 追加 GoalRecord、按 session 读取重建 | 异步 | schema 演进需兼容重放 |
| stream-bridge | 发布 goal 快照/变更事件 | 异步、尽力而为 | 观察者缺失不得影响状态权威 |

> 说明：GoalDriver 的抽象依赖是"提交一轮续跑 Run 并等待 completion"。CLI in-process adapter 目前用内部 submit 边界承接这件事，并以 `owner: "goal"` 与普通用户 prompt 分流，避免标题、UI transcript 与用户 prompt 串扰；其他宿主可直接对接 run-manager，但必须保留同样的 owner-aware interrupt 语义。

---

## 四、Data Ownership & Responsibility（数据归属与责任）

- **goal 状态与生命周期**：goals **独占**创建、更新、销毁权。任何模块（命令/工具/驱动）都只能经 GoalStore 唯一入口迁移，不得旁路改状态。
- **续跑 Run**：run-manager 拥有 Run 的创建、并发、sandbox、取消与台账；goals 只**读**其完成信号并翻译成 goal 迁移，不拥有 Run。
- **续跑提醒文本**：goals 拥有其**措辞与生成**；写入 history 后，组装位置与压缩由 context 模块按既有规则决定。提醒是持久数据——旧的可被 compact 压缩，最新的在尾部。
- **续跑轮计数、三维预算与安全阀**：`turnsUsed` / `tokensUsed` / `wallClockMs` 单调累计且不因 compact 回退；time 只累计 active pursuit，paused 时间不计，预算在 continuation 边界判定。安全阀是始终生效的 1000-turn 系统绝对上限，不在 goal 数据上、不进入 BudgetReport、不对外暴露。

### Goal 停止与 subagent 执行流

```text
active goal -> pause/cancel/runtime pause
  -> GoalStore 先持久化 paused/clear（阻止下一 continuation）
  -> GoalExecutionControlPort.interruptGoalExecution(sessionId, reason)
  -> adapter 仅取消 goal-owned primary run
  -> SessionSubagentHost.interruptByParent(sessionId)
  -> active subagent => interrupted；pendingQueue/record/context 保留；不 close
```

若 goal 已 paused，随后 `/goal cancel` 只清 goal，不重新清扫 session，避免误伤 paused 期间普通 prompt 创建的执行。`/goal resume` 不触达 subagent；main 之后显式决定是否续接。

complete 正常流要求 main 已收敛全部 subagents，并完成目标、验证与最终结论；调用 complete 后输出最终回答并结束。若仍有 active subagent，adapter 执行 interrupt-only safety net，随后 goal 保持 cleared。当前只控制本路径对应的 live daemon，不向其他 daemon 发送远程 cancellation。
- **持久记录**：services/database 拥有字节存储；goals 拥有 **GoalRecord 的 schema 与重建/归一逻辑**，是唯一能把记录解释成 goal 态的模块。
- **快照事件**：goals 拥有快照的**内容**；stream-bridge/UI 拥有其**传输与渲染**。

---

## 五、文档自检

- 每条数据流都能说清来去：A 启动、B 续跑、C 模型自判与预算、D 提醒写入 history、E 插话中断（不自动恢复）、G 重建、H 快照。
- 每个接口都映射到具体数据流（见 3.1/3.2 末列），无悬空接口。
- 责任无重叠：状态归 goals、Run 归 run-manager、组装归 context、存储归 database、传输归 stream-bridge。
- 无需新建通用注入子系统——续跑提醒作为普通 user 消息写入 history，用现有消息系统即可。
