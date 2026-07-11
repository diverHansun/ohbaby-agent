# 1. 问题分析与代码现状

## 1.1 问题陈述

在 subagent 调用机制、context scope、sandbox scope 改进之后，**goal 模式长任务**在以下场景下的完成度与鲁棒性仍不足：

1. goal 续跑 Run 内 primary 调用 `subagent_run`（含 foreground / background）。
2. goal 因用户命令、预算、安全阀或插话而停止时，execution 层 in-flight subagent 是否与 goal 语义一致。
3. goal 暂停/恢复与用户普通 prompt、subagent 手动续接之间的边界是否可预测、可测试。

核心矛盾不是 goals 模块内部设计差，而是 **编排层（goals）与执行层（agents/subagent-host）之间缺少显式交叉契约**；行为部分依赖 adapter 隐式编排（如用户 Esc 走 `interruptRunTree`），部分路径完全未触达 subagent（如 `/goal pause`）。

---

## 1.2 已确认的产品分层（讨论结论）

```
goal 层（编排）     ：任务是否续跑、预算展示、/goal resume
main agent 层（执行）：是否委托、subagent_run / status / close
context 层          ：各 subagent 实例上下文长度与 compact（与 goal token 预算解耦）
adapter 层（桥接）  ：goal 可见停止时 interrupt 主+子；不 close
prompt 层          ：complete 前收敛 subagent、完成目标/验证/最终结论；工具返回后输出最终回答；按需 close
```

**已确认契约摘要**

| 触发 | goal | subagent |
|------|------|----------|
| goal active，进入下一轮 continuation | 续跑 | 允许存活（含 background 跨轮） |
| goal pause（Esc/插话/预算/安全阀/`/goal pause`） | paused | interrupt，实例保留，queue 保留 |
| `/goal cancel` | 清 goal 记录 | 同 pause：interrupt 保留 |
| goal complete（模型 `UpdateGoal(complete)`） | 清 goal 记录 | 正常路径下已全部结束；若仍有 active subagent，runtime interrupt 兜底但不 close |
| `/goal resume` | 用户恢复续跑 | 不自动 drain；main 自行 `subagent_run` |
| goal **paused** 期间用户发普通 prompt | goal 仍 paused | 走 user prompt 处理琐事；**不**自动续跑 goal objective（仅 light note 提示） |
| subagent 销毁 | — | 仅 `subagent_close`，由 main 按需 |

`complete` 的顺序契约是：main 先等待或收敛全部 subagent，完成目标、验证与最终结论，再调用 `UpdateGoal(complete)`；工具返回后输出最终回答并结束。complete-time interrupt 只是防御模型违反顺序的安全网，不是正常的收尾机制。

---

## 1.3 goals 模块现状（按 plan-module-design 结构）

### 1.3.1 goals-duty（职责边界）

来源：`docs/goals/goals-duty.md`

**Design Goals（与长任务相关）**

- 长任务循环一等能力：跨 Turn 自延续、自审计、自终止。
- 终止来源：模型自审、用户控制、opt-in 预算、不可配置安全阀。
- objective 不可信数据包裹（`<untrusted_objective>`）。
- 跨 session 存活；恢复时 active 降级 paused。
- 与 run-manager、permission、storage 职责分离。

**Duties（GoalDriver 等）**

- GoalStore 唯一状态入口；GoalDriver 在 run-manager 之上编排续跑。
- 不做 auto-resume；用户插话后 goal pause，用户自行 `/goal resume`。
- 续跑提醒作为 user 消息 append 到 history。

**Non-Duties（与本议题直接相关）**

- **不做 master/subagent 多智能体编排**（Non-Duty 5）：goals 不派生 subagent、不实现 master 监控循环。
- 未声明：primary 在 goal turn 内通过工具 spawn 的 subagent，在 goal pause/cancel/complete 时如何处理。

**缺口**：Non-Duty 5 正确排除了 goals 拥有 subagent 编排，但未写 **交叉边界**：goal 停时 execution 层是否应 interrupt 子任务。这是本议题要补的文档与 adapter 契约，不是扩大 goals 职责。

### 1.3.2 architecture（内部结构）

来源：`docs/goals/architecture.md`

**五组件**

| 组件 | 职责 |
|------|------|
| GoalStore | 聚合根、状态机、预算、replay |
| GoalDriver | 续跑循环；读 `GoalTurnOutcome`，不知 subagent |
| GoalInjector | 续跑提醒 / paused light note（纯函数） |
| goal 工具组 | CreateGoal / UpdateGoal / GetGoal / SetGoalBudget |
| GoalPersistence | append 记录，委托 database |

**关键架构决策**

- GoalDriver 站在 run-manager **之上**，不把 goal 语义塞进 Run（编排/执行分离）。
- 状态 out-of-band：goal 结构化状态不在可压缩 history 内。
- 刻意不引入 GoalQueue、PauseCause 枚举、auto-resume、独立注入子系统。

**与 subagent 的关系**

- 架构文档第四节提到「若后续引入 master/subagent 需回 goals-duty 讨论」，当前 **无 GoalQueue**。
- 代码上 GoalDriver 仅依赖 `GoalTurnRunner.runTurn(sessionId, prompt)` 端口（`packages/ohbaby-agent/src/goals/types.ts`），不 import agents。

### 1.3.3 data-model（领域概念）

来源：`docs/goals/data-model.md`

**goal 侧核心概念**

- Goal / Objective / GoalStatus（active | paused | complete 瞬态）
- GoalActor、PauseReason（展示用，不驱动恢复分支）
- GoalBudgetLimits / GoalBudgetReport / SafetyCap / UsageCounters
- GoalRecord / GoalSnapshot / GoalChange

**与 subagent 的关联**

- data-model **无** `goalId` 与 subagent 的 join 字段。
- 隐式关联：同一 `parentSessionId`（primary session）。

**agents 侧对应概念**（`packages/ohbaby-agent/src/agents/subagents/types.ts`）

- SubagentInstanceRecord：`subagentId`, `parentSessionId`, `sessionId`（child）, `contextScopeId`, `status`, `pendingQueue`, `ownerId`/`ownerPid`
- SubagentRunMode：`foreground` | `background`
- status：`pending | running | completed | failed | timed_out | interrupted | cancelled`

**三套「运行中」词汇无统一映射表**

| 层 | 词汇 |
|----|------|
| goal | active / paused / complete(瞬态) / null |
| subagent | pending / running / interrupted / timed_out / ... |
| run | pending / running / succeeded / cancelled / interrupted |

边界处有翻译（如 RunCompletion cancelled -> goal pause），但 **无共享类型或 ADR**。

**预算产品契约修正**

- 用户不直接传结构化预算，也不提供 `/goal budget`。限制写在自然语言 objective/对话中，main 只翻译用户、system 或 developer 明确给出的限制。
- `SetGoalBudget` 采用 `{ value, unit }`，每次设置一个维度，支持 turns/tokens/milliseconds/seconds/minutes/hours；禁止 main 自行估算或发明预算。
- time 统计 active pursuit，paused 时间不计；只在 continuation 边界判定，不承诺精确 deadline。subagent 自身 timeout 仍由 execution 层负责。
- 未声明预算时不创建产品级限制；系统安全阀始终为 1000 goal turns，不进入预算报告，也不能被显式 turn budget 绕过。

### 1.3.4 dfd-workflow（数据流）

来源：`docs/goals/dfd-interface.md`、`docs/agents/dfd-interface.md`

**goal 续跑主路径（Level-1）**

```
/goal resume 或 create
  -> GoalService.ensureDriving
  -> driveGoal 循环
       -> incrementTurn
       -> renderGoalTurnPrompt
       -> GoalTurnRunner.runTurn (adapter 注入)
            -> submitPromptInternal(owner: goal)
            -> AgentService.startSession + runManager.waitForCompletion(primary runId)
            -> [Run 内] toolScheduler -> subagent_run -> SessionSubagentHost.run
       -> goalOutcomeFromRunCompletion -> recordTokenUsage(仅 primary)
       -> 映射 cancelled/failed -> store.pause
```

**已存在的 interrupt 桥（仅部分路径）**

```
用户 prompt 抢占 goal slot
  -> interruptGoalPromptInFlight (ui-inprocess.ts:1541-1557)
  -> abortPromptRun (ui-inprocess/runtime-controller.ts:109-112)
  -> interruptRunTree (ui-runtime/composition.ts:478-494)
       -> runManager.cancel(primaryRunId)
       -> subagentHost.interruptByParent(parentSessionId)
  -> pauseGoal("interrupted")
```

**未接 subagent 的 goal 停止路径（interrupt 缺口）**

```
/goal pause  -> GoalService.pauseGoal  -> store.pause only
/goal cancel -> GoalService.cancelGoal -> store.cancel only
预算/安全阀   -> driveGoal 顶部 store.pause -> return（无 interrupt）
UpdateGoal(paused) -> store.pause only（与 /goal pause 同缺口）
```

**complete 收尾缺口**

```
complete -> store.markComplete -> 清 goal（当前无 main 收敛 prompt，也无 active subagent 防御性 interrupt）
```

**token 流**

- `goalOutcomeFromRunCompletion`（`ui-inprocess.ts:1692-1710`）仅取 primary run 的 `completion.usage.totalTokens`。
- subagent 在 child session 独立 run 上消耗 token，**不进入** goal `tokensUsed`（与产品决策一致：goal UI 只展示 primary；subagent 上下文由 context 模块管）。

### 1.3.5 non-functional（工程约束）

来源：`docs/goals/non-functional.md`

与交叉面相关的既有约束：

- 串行不并发；插话先暂停 goal。
- 不做 auto-resume；不做 master/subagent（Non-Duty 延后）。
- 安全 > 可靠 > 可预测终止 > 可观测 > 简单 > 性能。
- 不可接受：恢复后 active goal 自动续跑；静默失败。

**缺失的非功能声明**

- goal 可见停止时，execution 层 in-flight subagent 必须 interrupt（不 close）——尚未写入 non-functional。
- goal complete 不强制 close subagent；本轮同时补 main 收敛 prompt 与 active straggler 的 interrupt-only 兜底。
- 当前多个路径各自启动 daemon；停止只保证当前路径对应 live daemon 内的执行，不做跨 daemon 远程 cancellation。

### 1.3.6 test（测试覆盖）

来源：`docs/goals/test.md`、`docs/agents/` 下测试

**goals 已有**

- `driver.unit.test.ts`、`store.unit.test.ts`、`injection.*.test.ts`
- `goal-compact.integration.test.ts`（compact x goal，无 subagent）
- `ui-inprocess.contract.test.ts` 中 goal 中断（无 subagent）

**agents/subagent 已有**

- `subagent-host.unit.test.ts`（interrupt、queue、timeout、close 等，厚）
- `ui-inprocess.contract.test.ts` 中 parent abort + subagent（无 goal 上下文）

**交叉缺口**

- 全库 **零** `goal * subagent` 联合测试（`grep` 无匹配）。
- 上述契约（pause/cancel/budget + in-flight subagent）无回归网。

---

## 1.4 实例与进程生命周期（代码事实）

ohbaby 存在三层，不可混谈：

| 层 | 代表 | 进程退出后 |
|----|------|------------|
| AgentInstance | `core/agents/instance.ts` 单次 turn 运行时对象 | 释放，不持久 |
| SubagentInstanceRecord | `subagent_instance` 表或内存 store | 取决于 backend |
| SessionSubagentHost.active | AbortController、drain、queue 调度 | 释放 |

**CLI in-process（默认）**

- `composition.ts` 默认 `InMemorySubagentInstanceStore`。
- 退出时 `host.dispose()` -> `markOwnedInterrupted`；record 不落盘。
- **重启 CLI 后无法唤醒** subagent（除非 persistent backend）。

**serve / persistent（`ui-persistent.ts`）**

- `DatabaseSubagentInstanceStore` + SQLite。
- 启动时 `recoverInterrupted()`：owner 已死的 pending/running -> interrupted；**不自动 drain**。
- child session 消息/context 仍在 DB；main 可通过 `subagent_run(subagent_id=...)` **显式续接**（新建 AgentInstance，恢复 context scope）。

文档依据：`docs/agents/dfd-interface.md` 第五节 Error & Recovery。

---

## 1.5 主要代码缺口（带位置）

| 缺口 | 严重度 | 证据 |
|------|--------|------|
| `/goal pause`/`cancel`/预算 pause 不 interrupt subagent | 高 | `service.ts:117-128`；`driver.ts:24-33` 仅 store.pause |
| goal complete 未检查收敛且无 straggler 兜底 | 高 | `store.ts:183-207`；prompt 未要求 complete 前 status/等待 |
| 零 goal x subagent 集成测试 | 高 | 测试库 grep |
| budget pause 时 background 可能继续跑 | 高 | driveGoal return 不调用 interruptByParent |
| 无 cross-layer 只读视图（goal + subagents + runs） | 中 | 三份 active 注册表独立 |
| `/goal pause` 与 Esc 语义分裂 | 中 | Esc 走 interruptRunTree；pause 仅改 store |
| goal 停止端口若按 session 粗暴取消 primary，可能误伤 paused 期间普通任务 | 高 | UI 已有 `promptInFlightOwner`，运行层却没有 goal owner 字段 |

**已满足或部分满足**

- 用户 Esc/插话：interruptRunTree + interruptByParent（`composition.ts:478-495`，`ui-inprocess.ts:1541-1557`）。
- goal active 跨 continuation 时 background 可存活（`subagent-host.ts:203-216`）。
- goal resume 不自动 drain subagent（设计如此，无 auto-resume）。
- primary token 预算不含 subagent rollup（与产品决策一致，需文档声明）。

---

## 1.6 SWE 原则审视（learn-swe）

轴心：**管理复杂度**；消灭偶然复杂度，保留本质复杂度。

### 1.6.1 做得好的（应保留）

| 原则 | 体现 |
|------|------|
| SRP / 编排 vs 执行分离 | goals-duty Non-Duty 5；GoalTurnRunner 端口 |
| DIP | goals 不依赖 agents 实现；subagent 经 AgentInstance 委托 run-manager |
| 信息隐藏 | GoalStore 聚合根；外部只读 GoalSnapshot |
| YAGNI | 无 GoalQueue、无 PauseCause、无 auto-resume |
| 可测试性（模块内） | goals / subagent-host 单测较完整 |

依据：learn-swe references/README 操作内核；`docs/goals/architecture.md`。

### 1.6.2 偶然复杂度（应消灭）

| 问题 | SWE 依据 | 说明 |
|------|----------|------|
| 横切 interrupt 契约落在 adapter 实现细节 | 02 耦合 / 05 分层 | composition 700+ 行承担隐式编排；pause 与 Esc 行为不一致 |
| 三套 running 状态无映射 | 02 信息隐藏 | 运维/debug 需 mental join 三 store |
| 无 join key（如 spawnedByRunId） | 02 抽象 | 多轮 goal 难区分「本轮 subagent」与「遗留 background」 |
| 零交叉集成测试 | 07 工程实践 | 「难写的测试是设计未固化信号」 |
| 文档未写交叉边界 | 00 代码为人而写 | 读者易误以为「goal active == 无 subagent 在跑」 |

### 1.6.3 有意识的合理权衡（不应破坏）

| 权衡 | 理由 |
|------|------|
| goal token 预算不含 subagent | 产品决策：UI 只展示 primary；subagent 由 context 管 |
| goal complete 不批量 close | complete 是 main 语义收敛；runtime 仅 interrupt 违反顺序的 active straggler |
| goals 不 import subagentHost | 保持编排层 ignorant；interrupt 由 adapter 桥接 |
| background 允许跨 active continuation 轮 | 并行委托是 foreground 模式无法替代的能力 |

### 1.6.4 风险地图（摘要）

| 问题 | 严重性 | 可优化性 | 建议归属 |
|------|--------|----------|----------|
| pause/cancel/budget 不 interrupt 子任务 | 架构级 | 战略投资 | adapter + 集成测试 |
| 无 goal x subagent 测试 | 设计级 | 低垂果实 | adapters 集成/contract |
| complete 前 subagent 未收敛 | 架构级 | 战略投资 | system-prompt + adapter interrupt-only safety net |
| budget 暴露方式与 time 语义不一致 | 设计级 | 低垂果实 | 移除 `/goal budget`，恢复 Kimi 风格单维 `{value, unit}` time schema 与 active-time 计算 |

---

## 1.7 问题根因（一句话）

execution 层单测已证明 subagent interrupt/queue/timeout 在隔离内正确；**goal 长任务鲁棒性的缺口是编排停止与执行停止之间的薄契约缺失**，且该契约未测试、未文档化。这不是「应把 subagent 收进 goals」，而是 **应在 adapter 边界固化「goal 可见停止 => interrupt 主+子，不 close」**。
