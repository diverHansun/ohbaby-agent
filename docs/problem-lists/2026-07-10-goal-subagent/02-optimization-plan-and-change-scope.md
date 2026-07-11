# 2. 优化方案与改动面

## 2.1 设计原则（实施时不得违反）

1. **goals 模块不 import SessionSubagentHost**；不新增 GoalQueue、不实现 master/subagent 循环。
2. **goal 可见停止**（pause / cancel / turn/token/active-time 预算或安全阀触发的 pause / 用户 Esc 插话）=> adapter 调用与 Esc 等价的 **interrupt goal-owned primary + 当前 active subagents**，**禁止** `subagent_close`。
3. **goal complete** => main 必须先收敛 subagents，完成目标、验证与最终结论；调用 complete 后输出最终回答并结束。若 complete 时仍有 active subagent，adapter 只做 interrupt 兜底，不 close。
4. **goal resume** => 不自动 drain subagent queue；main 通过 `subagent_run(subagent_id)` 续接。
5. **预算与耗时** => 用户不直接传结构化参数；main 只翻译明确的 turn/token/active-time 限制，tool 每次设置一维，禁止自行发明。time 排除 paused 区间且只在 continuation 边界判定；goal token 只计 primary，subagent 上下文由 `core/context` 管理，不做 rollup。
6. **系统安全阀** => 1000 goal turns，始终生效、不可配置、不进入 BudgetReport；未声明预算时不创建产品级限制，不做预算式收敛。
7. **background** => goal active 时允许跨 continuation 轮存活；goal 进入 pause/cancel 触发的 interrupt 后必须停止执行。

---

## 2.2 架构：交叉边界契约

建议由 goals 编排层依赖一个抽象 execution-control port，adapter 提供实现。goals 不认识 RunManager 或 SessionSubagentHost，只声明“离开 active 时必须停止本 goal 执行”的语义：

```typescript
/** goal 编排层声明停止意图，adapter 实现执行层中断。 */
interface GoalExecutionControlPort {
  /** 中断当前 goal-owned primary（若有）与当时的 active subagent；不 close。 */
  interruptGoalExecution(input: {
    sessionId: string;
    reason: string;
    /** complete 为 false，让 main 当前 run 继续输出最终回答。 */
    includePrimary: boolean;
  }): Promise<void>;
}
```

adapter 实现复用现有 `interruptRunTree` 与 `interruptByParent`，但必须保留 goal 执行所有权：

- 只有 `promptInFlightOwner === "goal"` 且 session 匹配时才取消 primary，不能按 session 粗暴取消普通 user prompt。
- **若无 active primary run** 但 subagent 仍在 `host.active` 或 store 为 running/pending：**必须**仍调用 `interruptByParent(parentSessionId)`（覆盖 goal turn 窗间期仅 background draining 的情形）。
- 仅在 goal 从 `active` 离开时执行；对已经 paused 的 goal 再 pause/cancel，不清扫暂停期间普通任务创建的 subagent。
- 操作必须可重复调用且结果幂等，不靠 `pauseReason` 猜测是否已经中断。

状态迁移与副作用顺序固定为：**先把 goal 持久化为 paused/clear，关闭下一轮调度入口；再 await execution interrupt**。不用同步 `GoalStore.onChange` fire-and-forget 异步副作用。

**触发矩阵（目标态）**

| 事件 | goal store | interrupt 主+子 | subagent_close |
|------|------------|-----------------|----------------|
| 用户 Esc / 用户 prompt 抢占 goal | pause | 已有 | 否 |
| `/goal pause` | pause | **新增** | 否 |
| `UpdateGoal(paused)`（模型） | pause | **新增**（与 `/goal pause` 同语义） | 否 |
| `/goal cancel` | cancel | **新增** | 否 |
| 预算/安全阀 pause（driver） | pause | **新增** | 否 |
| `UpdateGoal(complete)`（正常已收敛） | clear | 无 active 执行 | 否 |
| `UpdateGoal(complete)`（异常仍有 active subagent） | clear | **interrupt straggler 兜底** | 否 |
| `/goal resume` | resume + ensureDriving | 否 | 否 |

说明：

- `complete` 必须位于 main 的最终收尾：先等待/检查 subagent，完成目标与验证并准备好最终结论；调用 `UpdateGoal(complete)` 后输出最终回答并结束，不再开始新工作。
- complete-time interrupt 是违反顺序时的安全网；保留 record/context，不调用 `subagent_close`。
- 当前多路径多 daemon 部署只保证当前 daemon 内 cancellation。跨 daemon 远程 cancellation 等全局单 daemon 架构演进时统一处理。

---

## 2.3 代码改动面

### 2.3.1 adapter / composition（主改动）

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` | 暴露 subagent interrupt 能力；GoalService 接收 awaited `GoalExecutionControlPort`，不从同步 onChange 发副作用 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 实现 owner-aware `interruptGoalExecution`；复用 `promptInFlightOwner/sessionId` 与 run-ready barrier |
| `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts` | 类型面增加 parent subagent interrupt 能力（若 adapter 需要） |

**实现要点**

- command 路径（`/goal pause|cancel`）：先迁移 goal 状态，再 await `interruptGoalExecution`；若已 paused，cancel 只清 goal，不误伤普通任务。
- `/goal cancel` 与 pause 对 subagent **同语义**：interrupt 保留实例。
- `UpdateGoal(paused)`（经 `GoalService.updateFromTool`）与 `/goal pause` 同 interrupt 语义。
- driver 内 turn/token budget、safety、failed/cancelled pause：全部经 GoalService 的统一 awaited pause 路径，不直接 `store.pause` 后 fire-and-forget。
- 避免 goals 模块直接依赖：回调由 `createUiRuntimeComposition` 注入 GoalService deps 或包装 `GoalTurnRunner`。

**不建议**

- 在 `GoalStore.pause` 内 import subagentHost（破坏分层）。

### 2.3.2 goals 模块（小改动，可选）

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/goals/service.ts` | 所有 active→paused/cancel 与 complete 统一 await `GoalExecutionControlPort`；同步 onChange 只做投影 |
| `packages/ohbaby-agent/src/goals/types.ts` | 定义 `GoalExecutionControlPort` 与 `includePrimary` 语义 |

goals 核心 store/driver/injection **不必**为 subagent 改逻辑。

### 2.3.3 agents 模块（通常无需改）

| 文件 | 说明 |
|------|------|
| `packages/ohbaby-agent/src/agents/subagent-host.ts` | 现有 `interruptByParent` 已满足；verify pause/cancel 路径调用即可 |
| `packages/ohbaby-agent/src/tools/subagent.ts` | 无改动 |

### 2.3.4 文档改动

| 文件 | 改动 |
|------|------|
| `docs/goals/goals-duty.md` | Non-Duty 补充：goal resume 不恢复 subagent；goal 可见停止时 adapter interrupt execution（不 close） |
| `docs/goals/non-functional.md` | 增加：goal 停时 in-flight subagent 不得继续改仓库；complete 不强制 close |
| `docs/agents/dfd-interface.md` | 增加 goal x subagent 交叉流一行 |
| `docs/goals/test.md` | 引用交叉测试场景（或指向本 problem-list 04） |
| `docs/core/system-prompt/prompts/primary/base.md` | **本轮**：complete 前等待/检查 subagent，完成目标、验证与最终结论；工具返回后输出最终回答并结束；实例过多/上下文乱时按需 `subagent_close` |

### 2.3.5 可选增强（非 MVP）

| 项 | 说明 | 优先级 |
|----|------|--------|
| `spawnedByRunId` on SubagentInstanceRecord | 区分本轮 vs 遗留 background | 低 |
| `SessionExecutionView` 只读聚合 | UI/debug：goal + subagents + runs | 低 |
| Esc 非协作 abort 硬超时 | interruptByParent 限时 detach | 中（execution follow-up） |
| 跨 daemon cancellation | 当前路径以外 owner 的远程停止 | 后续全局 daemon 架构统一处理 |

---

## 2.4 数据流（目标态）

```
goal pause/cancel/explicit-budget-or-safety-pause
  -> GoalStore 迁移
  -> GoalExecutionControlPort（awaited）
  -> interruptGoalExecution(sessionId)
       -> [optional] runManager.cancel(goalOwnedPrimaryRunId)
       -> subagentHost.interruptByParent(parentSessionId)
  -> subagent: status=interrupted, pendingQueue 保留, closedAt 空

goal resume
  -> store.resume + ensureDriving
  -> driveGoal（不触达 subagent）
  -> main agent 自行 subagent_run(subagent_id) 续接

goal active + continuation turn N+1
  -> background subagent 可仍在 drain（不变）
```

---

## 2.5 实施阶段建议

### Phase A（MVP，本 problem-list 核心）

1. adapter + GoalService port：pause / cancel / runtime budget pause => awaited interruptGoalExecution。
2. 集成测试 3–5 条（见 04-test-and-acceptance.md）。
3. complete 前收敛 prompt + complete-time active straggler interrupt-only 兜底。
4. 移除整个 `/goal budget` 子命令；把 `SetGoalBudget` 改为 Kimi 风格的单维 `{value, unit}`，恢复 active-time schema/计算，禁止模型自行发明预算。
5. 安全阀改为始终生效的 1000 goal turns；与用户预算分离，不进入 BudgetReport。
5. 文档更新 goals-duty、agents dfd、non-functional。

### Phase B（后续）

1. 可选 `spawnedByRunId`、SessionExecutionView。
2. persistent 模式下 restart + goal resume + 遗留 subagent 场景测试。
3. 全局单 daemon 后设计跨路径/跨 daemon cancellation。

### 明确不做

- goal complete / cancel 时批量 `subagent_close`。
- goal token 预算 rollup subagent。
- goals 内嵌 SubagentHost 或 GoalQueue。
- 精确 wall-clock deadline（time budget 只在 continuation 边界判定）。

---

## 2.6 可逆性

| 决策 | 可逆性 |
|------|--------|
| adapter interrupt 钩子 | 可逆（两向门） |
| 交叉集成测试 | 可逆 |
| spawnedByRunId 字段 | 可逆（migration 可加可弃） |
| prompt complete 收敛规则 | 可逆（prompt 迭代） |

---

## 2.7 与 subagent-context 分支的关系

subagent-context 分支交付：context scope、sandbox scope、interruptRunTree、queue、timeout。

本议题 **依赖** 上述能力，**追加** goal 生命周期到 interrupt 的接线与测试。不在 subagent-context 分支内实现 Phase A，避免 scope 膨胀。
