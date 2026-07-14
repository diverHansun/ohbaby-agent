# 04. 测试与验收标准

## 1. 测试策略

遵循仓库 `docs-test/classification.md`：

- 纯 scope/key/recovery 逻辑：unit；
- Todo tool schema 与 adapter/UI 事件边界：contract；
- Goal continuation、pause/resume/complete 的组合链路：integration；
- 模型是否在复杂 Goal 中合理创建、维护并 reconcile Todo：显式启用的 real evaluation；
- Web/CLI 只验证共享 UI 契约，不复制 Goal 状态机测试。

真实 API 测试默认跳过，不进入常规 preflight 的必需路径；需要根目录 `.env` 中的 `ZAI_API_KEY`，执行期间不得打印或写入 key。

## 2. 验收标准

| AC | 要求 | 优先级 | 主要证据 |
| --- | --- | --- | --- |
| AC-1 | Goal Todo 使用内部 `goal:<goalId>` scope，工具 schema 不暴露 scope | P0 | unit + contract |
| AC-2 | ordinary、Goal、subagent Todo 互相隔离 | P0 | unit + integration |
| AC-3 | active Goal Todo 跨 continuation 保持可见且无 hide/show 闪烁 | P0 | adapter contract + integration |
| AC-4 | pause 隐藏但保留 Goal Todo；ordinary task 不覆盖；resume 恢复 | P0 | integration |
| AC-5 | complete 清 Goal 后，当前 main run 到最终回答仍使用原 scope | P0 | contract + integration |
| AC-6 | complete 前 prompt 要求 reconcile Todo，但 runtime 不以 Todo 为硬门禁 | P0 | unit/contract + real eval |
| AC-7 | cancel/新 Goal/replace 不把旧 Goal Todo 投影到错误 workload | P0 | integration |
| AC-8 | history recovery 只恢复相同 scope 的成功 write | P0 | unit |
| AC-9 | 没有 scope metadata 的旧历史只属于 ordinary session | P1 | unit |
| AC-10 | Web/CLI 消费同一 adapter projection，不新增公开 goal/scope 字段 | P1 | contract + UI unit |
| AC-11 | 简单 Goal 不被强制创建 Todo；复杂 Goal 使用高层里程碑 | P1 | real eval |
| AC-12 | TodoItem、最大 10 项/100 字符、full-replace 语义保持兼容 | P1 | existing + regression unit |
| AC-13 | persistent Goal 重启后的完整自动接管链路仍按产品路线延后 P2 | P2 | 文档记录，不作为本轮 blocker |

## 3. 自动化场景矩阵

### T-1：Scope key 隔离

```text
ordinary write O
Goal A write A
Goal B write B
subagent S write S
```

分别读取时只能看到所属列表；在任一 scope 写空数组不得清除其他 scope。

- 类型：unit
- 位置：`packages/ohbaby-agent/src/tools/todo.unit.test.ts`
- 覆盖：AC-1、AC-2、AC-12

### T-2：工具 schema 不暴露 scope

断言 `todo_read` / `todo_write` 的公开参数中没有 `goalId`、`scope`、`workScopeId`，但内部 execution context 能选择 Goal scope。

- 类型：contract
- 覆盖：AC-1

### T-3：Goal Todo 跨 continuation 数据连续

```text
Goal A Turn 1 写 Todo
→ Turn 1 terminal
→ Goal 仍 active
→ Turn 2 启动并 todo_read
```

Turn 2 读取同一列表，不能创建 ordinary key 的副本。

- 类型：integration
- 覆盖：AC-2、AC-3

### T-4：Continuation UI 不闪烁

在 T-3 链路中记录 UI todo events：

- Goal active 时 Turn 1 terminal 不发 hide；
- Turn 2 start 不产生 hide → show 序列；
- 幂等 show/update 不重置列表；
- empty Todo 不强制展示空面板。

- 类型：adapter contract
- 覆盖：AC-3、AC-10

### T-5：Pause → ordinary → resume

```text
Goal A Todo A
→ pause Goal A
→ UI hide, store 保留 A
→ ordinary Todo O
→ ordinary 回答及其 background subagent 全部 settlement
→ resume Goal A
→ UI/Tool 恢复 A，不是 O
```

- 类型：integration
- 覆盖：AC-2、AC-4

### T-6：Complete 顺序与 frozen scope

```text
Goal A run acquire goal:A
→ todo_write reconcile A
→ UpdateGoal(complete) 清 GoalStore
→ 同一 run 再 todo_read / 生成最终回答
→ 仍读取 A
→ run terminal 后 hide
```

同时断言 primary run 未被 Goal complete interrupt，straggler subagent 在最终完成前已 settlement。

- 类型：contract + integration
- 覆盖：AC-5、AC-6

### T-7：Runtime 无 Todo hard gate

直接构造 Goal objective 已完成、Todo 仍含 pending 的状态，调用 Goal complete：

- runtime 仍允许合法 complete；
- GoalService/UpdateGoal 不读取 TodoStore；
- 不自动把 pending 改为 completed；
- prompt 测试仍必须包含 reconcile 指引。

- 类型：unit + contract
- 覆盖：AC-6

### T-8：Cancel 不污染 ordinary

Goal A 写 Todo A 后 cancel：

- A 不再作为当前 UI projection；
- ordinary read 不返回 A；
- 新普通 Todo 可正常写入；
- A 的底层历史/数据是否保留不影响当前视图。

- 类型：integration
- 覆盖：AC-7

### T-9：新 Goal 获得新 scope

`CreateGoal({ replace: true })` 生成新 goalId：

- 新 Goal 不读取旧 Goal Todo；
- 旧 run 即使延迟 settlement，也不能把 UI 切回旧 scope；
- 新 Goal write 不覆盖旧 scope。
- 若 `CreateGoal({ replace: true })` 在 `goal:A` run 内创建 `goal:B`，当前 run lease 保持 A；settlement 后 projection 切到 B，下一 continuation 才读取 B。

- 类型：integration
- 覆盖：AC-7

### T-10：`/goal replace` 行为

该测试在产品确认后锁定。按推荐方案：

- replace 保持相同 goalId 和 Todo scope；
- continuation prompt 要求依据新 objective 立即重写/reconcile；
- 不自动清空 Todo；
- 新旧 objective 明显不相干时，模型应 full-replace 列表。

- 类型：unit + real eval
- 覆盖：AC-7、AC-11

若产品决定 replace 生成新 identity，则本测试改为断言新 scope，不同时保留两种语义。

### T-11：Scope-aware history recovery

历史中交错存在：

```text
ordinary success write
Goal A success write
Goal B failed/aborted write
Goal B success write
subagent success write
```

每个 scope 只恢复自己最后一次成功 write；失败/aborted write 不参与。

- 类型：unit
- 覆盖：AC-8

### T-12：Legacy history

历史 tool result 没有 workload metadata：

- ordinary scope 可以恢复；
- Goal A scope 不认领；
- 不修改旧 transcript；
- 首次 Goal read 返回空列表。

- 类型：unit
- 覆盖：AC-9

### T-13：Compaction / session reconstruction

在 Goal Todo 写入后触发已有 compact/reconstruction seam：

- 当前 Goal scope 恢复正确列表；
- ordinary 列表不被注入 Goal continuation；
- 不要求 daemon 重启后自动恢复并继续完整 Goal pursuit，该能力仍是 P2。

- 类型：integration
- 覆盖：AC-8、AC-13 的非自动接管部分

### T-14：Subagent 隔离

Active Goal 中 subagent 使用自己的 Todo：

- 不发布到 main Todo UI；
- 不读取/覆盖 `goal:<goalId>`；
- subagent 完成后 main 根据结果显式更新主 Todo；
- subagent instance 保留与否不改变 scope。

- 类型：integration
- 覆盖：AC-2、AC-10

### T-15：Scope lease 抵抗状态竞态

使用可控 deferred promise 制造：

```text
run A acquire goal:A
→ Goal complete/replace
→ run A 延迟的 Todo publish 到达
```

断言延迟事件不能写入 ordinary/new Goal，也不能抢占新 workload 的 UI projection。

- 类型：adapter contract
- 覆盖：AC-5、AC-7

### T-16：Prompt asset

断言生成后的 system prompt 同时包含：

- Todo 的条件触发，而非 Goal 强制；
- continuation 维护现有列表；
- complete 前 reconcile；
- Todo 不能替代 objective、实际工作或验证；
- 没有 Todo runtime hard gate 的错误描述；
- 模型不传内部 scope。

- 类型：unit
- 位置：`packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts`
- 覆盖：AC-6、AC-11

### T-17：Web/CLI UI 一致性

对统一 adapter event/snapshot 断言：

- active continuation 显示；
- pause/complete settlement 隐藏；
- resume 恢复；
- event payload 不增加 goalId/workScopeId；
- Web 与 CLI 不自行扫描 transcript 决定 scope。

再覆盖 snapshot rebuild：

- active Goal 选择该 Goal scope；
- paused/no Goal 选择 ordinary scope 且 hidden；
- initial snapshot 中无 scope 的 stale projection 不覆盖重建结果。

- 类型：contract + UI unit
- 覆盖：AC-3、AC-4、AC-10

### T-18：真实模型——复杂 Goal

用真实模型给出 4–6 个有依赖的交付项，模拟 Todo 与 Goal 工具结果：

- 模型创建不超过 10 项的高层 Todo；
- 任务推进时及时更新；
- 不把每个细节拆成低价值条目；
- complete 前先读取/写入 Todo 对账；
- Todo 对账、`UpdateGoal(complete)`、最终回答顺序正确；
- 不发明用户未要求的 Goal requirements 或 budget。

- 类型：opt-in real evaluation
- 覆盖：AC-6、AC-11

### T-19：真实模型——简单 Goal 与 stale Todo

两个子场景：

1. 单步骤简单 Goal：允许不使用 Todo，仍正常完成；
2. objective replace 后存在 stale Todo：模型 full-replace/reconcile，不机械完成旧项。

- 类型：opt-in real evaluation
- 覆盖：AC-6、AC-11

## 4. UI 事件顺序断言

### Active continuation

```text
show/update A
→ run terminal while Goal active
→ no hide
→ next run update A
```

### Pause

```text
Goal status paused
→ interrupt/settlement
→ hide A exactly once
```

### Complete

```text
reconcile A
→ complete Goal
→ final answer while A remains current
→ run terminal
→ hide A exactly once
```

### Resume

```text
resume Goal A
→ acquire goal:A
→ show latest A
```

测试应断言事件顺序和次数，避免只检查最终 visible 状态而漏掉闪烁。

## 5. 真实 API 评估设计

建议扩展现有：

```text
packages/ohbaby-agent/src/goals/goal-completion.real.e2e.test.ts
```

或创建同目录独立的 opt-in Goal × Todo eval。沿用现有约束：

- 根目录 `.env` 加载 `ZAI_API_KEY`；
- 通过独立环境开关 `OHBABY_GOAL_REAL_EVAL=1` 启用；
- 默认 `describe.skip`；
- temperature 为 0；
- 使用有限 step loop 与 360 秒级单测 timeout；
- tool responses 由 harness 模拟，记录调用顺序；
- 失败日志只打印工具名、参数和模型文本，不打印 API key/header；
- 至少连续运行 3 次，不能只依赖单次模型采样。

示例命令：

```bash
OHBABY_GOAL_REAL_EVAL=1 pnpm vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/goals/goal-completion.real.e2e.test.ts
```

### 本轮实现证据（2026-07-14）

- 真实 API 评测连续执行 3 轮，均为 4/4 通过；
- 新增复杂 Goal × Todo 场景均满足 `todo_read → todo_write(reconciled) → UpdateGoal(complete) → final answer`；
- 三轮均未在无 authority 限制时调用 `SetGoalBudget`；
- 该结果作为质量证据记录，确定性 unit/contract/integration 仍是合并门槛。

## 6. 建议执行命令

开发中按最小范围：

```bash
pnpm vitest run packages/ohbaby-agent/src/tools/todo.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm vitest run packages/ohbaby-agent/src/goals/driver.unit.test.ts
pnpm vitest run packages/ohbaby-agent/src/goals/goal-compact.integration.test.ts
pnpm vitest run tests/integration/agents/goal-subagent-lifecycle.integration.test.ts
```

分层回归：

```bash
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm typecheck
pnpm lint
```

合并前：

```bash
pnpm preflight
```

## 7. 完成门槛

### P0 blocker

- T-1～T-8、T-11、T-14～T-16 全部通过；
- T-3/T-4 证明跨 continuation 不 hide/show 闪烁；
- T-5 证明 pause → ordinary → resume 无串扰；
- T-6/T-15 证明 complete 后同 run scope 不跳变；
- runtime 无 Todo hard gate。

### P1 确定性合并门槛

- T-9、T-12、T-13、T-17 通过；
- T-10 按已确认 `/goal replace` 语义通过；
- 权威 Todo/Goal 文档同步；
- preflight 通过。

### 非阻塞质量证据

- T-18/T-19 真实 API 评估建议各连续运行 3 次；
- 模型采样波动不阻塞 deterministic preflight；
- 稳定失败必须修正 prompt 或明确签字接受，不能以长期 skip 代替验证。

### P2 延后项

- daemon/process 重启后自动恢复 active Goal、Todo、continuation 并继续执行的完整 persistent 链路；
- 历史 Goal Todo 浏览/归档 UI；
- 多 Goal Todo scope picker；
- team/shared Todo 或依赖图。

这些延后项不得通过在本轮预埋通用 workflow framework 来实现。
