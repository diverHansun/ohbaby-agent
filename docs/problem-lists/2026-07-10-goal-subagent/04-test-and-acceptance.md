# 4. 测试与验收标准

## 4.1 测试原则

- 围绕 **职责与交叉边界**，不围绕内部类名。
- 遵循项目测试分类：`unit` / `contract` / `integration`（见 `docs-test/classification.md`）。
- 默认 deterministic 测试禁止真实 LLM API；另提供 opt-in 真实 API eval 验证模型服从 complete/subagent 收敛与“不发明预算”，默认 CI 跳过且不输出密钥。
- goals/subagent 端口协作放在 `tests/integration/agents/goal-subagent-lifecycle.integration.test.ts`；需要从 `/goal`、`submitPrompt` 等 UI 公共入口验证 primary run 与 child run 时序的场景，放在 `ui-inprocess.contract.test.ts`，仍使用真实 runtime composition。
- `GoalService` 的端口路由与预算 schema 等局部行为继续放 co-located unit/contract 测试。

---

## 4.2 验收标准（AC）

### AC-1 goal active 跨 continuation 时 background 可存活

**场景**

1. 创建 active goal，driver 跑 Turn 1。
2. Turn 1 内 `subagent_run(mode=background)`，立即返回 subagent_id。
3. Turn 1 succeeded，driver 进入 Turn 2（goal 仍 active）。

**验收**

- Turn 2 开始时，background subagent store status 为 `running` 或 queue draining。
- goal status 仍为 `active`。
- 未调用 `subagent_close`。

### AC-2 `/goal pause` interrupt 在跑 subagent，不 close

**场景**

1. active goal + in-flight foreground 或 background subagent。
2. 用户执行 `/goal pause`（非 Esc 路径）。

**验收**

- goal status = `paused`。
- subagent status = `interrupted`（或等价 paused 执行态）。
- `closedAt` 未设置；`pendingQueue` 保留（若曾排队）。
- primary run 已 cancel 或 settled。

### AC-3 `/goal cancel` 与 pause 对 subagent 同语义

**场景**

1. active goal + running subagent。
2. `/goal cancel`。

**验收**

- goal snapshot = null（记录清除）。
- subagent **interrupted**，**未** close。
- 与 AC-2 subagent 侧断言一致；区别仅在 goal 不可 `/goal resume`。

### AC-4 预算/安全阀 pause interrupt 子任务

**场景**

1. active goal，设低 turn、token 或 active-time 预算（或 inject 低 safetyCap）。
2. 某轮内启动 background subagent。
3. 下一轮 loop 顶触发 budget pause。

**验收**

- goal paused，pauseReason 含 budget/safety。
- subagent interrupted，未 close。
- background 不再继续 drain（无 orphan 写文件）：除 status 断言外，需 spy/mock 证明 interrupt 后无新的 subagent turn 启动或写盘（避免 cooperative-abort 漏网假阳性）。

### AC-5a goal paused 期间用户普通 prompt 不续跑 goal

**场景**

1. goal 为 paused（任意 pause 原因）。
2. 用户发送普通 prompt（非 `/goal resume`）。

**验收**

- goal 仍为 paused；GoalDriver 未 ensureDriving。
- 走 user prompt 路径；模型可见 paused light note，**不**注入 active 续跑提醒。
- 用户可处理琐事；恢复 goal 仍需 `/goal resume`。

### AC-5 `/goal resume` 不自动 drain subagent

**场景**

1. 满足 AC-2 后 goal paused，subagent interrupted + 非空 pendingQueue。
2. `/goal resume`，driver 续跑。

**验收**

- goal active，driver 跑新一轮 continuation。
- subagent **未**自动变为 running；queue **未**自动 drain。
3. main 显式 `subagent_run(subagent_id, prompt)` 后可 claim 并继续。

### AC-6 用户 Esc / 插话（回归，已有路径）

**场景**

1. active goal turn 内 blocking foreground subagent + 并行 background。
2. 用户发送普通 prompt 或 Esc。

**验收**

- goal paused（interrupted）。
- 全部 active subagent interrupted。
- 与 AC-2 子任务侧一致。
- 现有 contract test 扩展，而非仅 unit mock。

### AC-7 goal complete 的正常收敛顺序

**场景**

1. active goal，main 等待并检查所有 subagent 已 completed/interrupted/timed_out/failed 等非 active 状态。
2. main 完成目标与验证，准备好最终回答内容。
3. main 调用 `UpdateGoal(complete)`，随后输出最终回答并结束当前 run，不再开始新工作。

**验收**

- goal 记录清除。
- subagent record 仍存在，`closedAt` 空（除非 main 此前已 close）。
- **无**批量 subagent_close 调用。
- complete 后无 active subagent execution。

### AC-7a complete 时仍有 in-flight background（异常安全网）

**场景**

1. 同一 goal turn 内 `subagent_run(background)` 后立即 `UpdateGoal(complete)`。

**验收**

- goal 清除；active subagent 被 interrupt，但不 close。
- `closedAt` 为空，record/context 保留。
- 该路径是防御模型违反 complete 顺序的兜底，不作为 main 的正常收尾方式。

### AC-8 token 预算仅计 primary（回归声明）

**场景**

1. active goal，设 token 预算。
2. Turn 内 primary 低 token，subagent 高 token（fake usage）。

**验收**

- goal `tokensUsed` 仅反映 primary completion usage。
- 预算 pause 仅按 primary 累计触发（与产品决策一致；文档化行为）。

### AC-8a 自然语言预算翻译与 active-time

**验收**

- `/goal` 不提供 budget 子命令；用户不直接传结构化 flags。
- `SetGoalBudget` schema 为 `{ value, unit }`，unit 支持 turns/tokens/milliseconds/seconds/minutes/hours，每次只设置一个维度。
- tool 描述明确只翻译用户、system 或 developer 明确限制，不得自行估算或发明。
- `wallClockMs` 只累计 active pursuit，paused 时间不计；BudgetReport 含 time limit/reached/remaining，在 continuation 边界触发 pause。

### AC-8c 系统安全阀与预算分离

- 常量为 1000 goal turns，始终生效，显式 turn budget 不能绕过。
- 未声明预算时 `budgetLimits` 为空，BudgetReport 不展示 1000，也不产生预算式收敛提示。
- 测试可注入低安全阀；命中后 pause，不 complete。

### AC-8b paused goal 的 cancel 不误伤普通任务

**场景**

1. active goal 已 pause，旧 goal execution 已 interrupted。
2. 用户在 paused 期间启动普通 prompt；普通 prompt 可包含自己的 subagent。
3. 用户执行 `/goal cancel` 清除 paused goal。

**验收**

- goal 清除。
- 当前普通 user prompt/subagent 不被当作 goal execution 取消。

### AC-9 persistent 重启 + 手动续接（integration，可选 Phase B）

**场景**

1. DatabaseSubagentInstanceStore + 运行中 subagent。
2. 模拟 runtime dispose / 新 runtime 启动 + recoverInterrupted。

**验收**

- subagent store status = interrupted。
- `/goal resume` 后 main `subagent_run(subagent_id)` 可 claim 续跑。
- child session context 仍可读。

---

## 4.3 测试矩阵（MVP 最小集）

| ID | 类型 | 场景 | 优先级 |
|----|------|------|--------|
| T-1 | integration | AC-2 pause + subagent | P0 |
| T-2 | integration | AC-3 cancel + subagent | P0 |
| T-3 | integration | AC-4 budget pause + background | P0 |
| T-4 | contract/integration | AC-1 active 跨轮 background | P0 |
| T-5 | integration | AC-5 resume 不 auto-drain | P0 |
| T-6 | contract/integration | AC-6 Esc 回归 + subagent | P0 |
| T-7 | integration | AC-7 complete 正常收敛 | P1 |
| T-7a | integration | AC-7a complete + running bg => interrupted、未 close | P0 |
| T-8 | integration | 窗间期无 primary run、仅 background 时 interrupt | P0 |
| T-9 | unit | interrupt helper dedup（Esc vs pause） | P1 |
| T-10 | integration | AC-9 persistent 重启 | P2 |
| T-11 | contract | AC-5a paused 琐事 prompt | P1 |
| T-12 | unit/contract | AC-8a 单维预算工具 + active-time + 无 `/goal budget` | P0 |
| T-13 | integration | AC-8b paused cancel 不误伤普通任务 | P0 |
| T-14 | unit | AC-8c 1000-turn 绝对安全阀不进入 BudgetReport、不可绕过 | P0 |
| T-15 | real eval | complete 前 subagent 收敛 + main 不发明预算 | opt-in merge verification |

### 本轮补测证据

| ID / AC | 测试 | 覆盖结果 |
|---------|------|----------|
| T-4 / AC-1 | `ui-inprocess.contract.test.ts` — `keeps goal background work running when the next continuation turn starts` | Turn 1 启动 background，Turn 1 正常结束；Turn 2 primary 已开始时 child 仍 running、未 close，goal 仍 active |
| T-6 / AC-6 | `ui-inprocess.contract.test.ts` — `interrupts the active goal parent and background child before handling a user prompt` | active goal 的 parent 与 background child 均 abort；goal paused 后用户 prompt 才完成 |
| AC-4 强断言 | `goal-subagent-lifecycle.integration.test.ts` — `interrupts background work when the runtime safety cap pauses the goal` | safety pause 后 subagent turn 调用次数不增加，pending queue 保留，证明未继续 drain |
| T-9 | `service.unit.test.ts` — `interrupts execution only once when an active goal is paused repeatedly` | 首次 pause 后再次进入 pause 路径不会重复 interrupt，也不覆盖原 pauseReason |

仍按优先级延期：T-10 persistent 重启完整链路为 P2，不属于 Phase A 的 P0 合并门槛。

---

## 4.4 非目标（本阶段不测）

- subagent context compact 算法正确性（属 `core/context`）。
- sandbox scope 隔离（已在 `2026-07-09-subagent-sandbox-scope` problem-list 覆盖）。
- 真实 2h subagent timeout 墙钟（用 inject 短 deadline）。
- 真实 provider 的长期统计稳定性（本轮只提供 opt-in 单次 eval，不作为 deterministic CI 门禁）。
- 跨 daemon 远程 cancellation（等待全局单 daemon 架构）。

---

## 4.5 通过门槛

Phase A 合并条件：

1. T-1 ～ T-9、T-12 ～ T-14 全绿；T-10 按 P2 延期。
2. 现有 goals 单测 + subagent-host 单测 + 相关 contract **无回归**。
3. `docs/goals/goals-duty.md` 与 `docs/agents/dfd-interface.md` 已更新交叉边界描述。
4. opt-in 真实 API eval 至少人工运行一次并记录结果；默认 CI 仍跳过。

---

## 4.6 测试实现提示

**Fake 结构**

- 复用 `ui-inprocess.contract.test.ts` 的 runtime composition + fake LLM。
- tool call 序列：CreateGoal / subagent_run / UpdateGoal / 命令 API。

**断言点**

- `subagentInstanceStore.get(...).status`
- `subagentInstanceStore.get(...).closedAt`
- `subagentInstanceStore.get(...).pendingQueue.length`
- `goalService.getSnapshot(...).status`
- 最终 goal/subagent/run 状态；仅在最终状态不可见时才 spy 边界调用

**避免**

- 在 `goals/driver.unit.test.ts` 内 mock subagentHost（破坏分层）；交叉测试放 adapter 层。
