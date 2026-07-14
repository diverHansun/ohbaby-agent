# 01. 现状与问题分析

## 1. 分析基线

- 仓库：`ohbaby-agent`
- Commit：`dbf3360b546d17d2dff404965429ecb24b08e394`
- 日期：2026-07-14
- 分析范围：Todo 工具、Goal 生命周期、in-process adapter、Web/CLI Todo 投影、system prompt、历史恢复与测试

## 2. 当前结构

### 2.1 Todo 工具与存储

`packages/ohbaby-agent/src/tools/todo.ts` 当前提供：

- `TodoItem = { content, status }`；
- `TodoStore.read(sessionId, contextScopeId?)`；
- `TodoStore.write(sessionId, todos, contextScopeId?)`；
- 主 session 与 subagent 通过 `contextScopeId` 隔离；
- 每次 `todo_write` 替换整份列表；
- 历史恢复扫描最近一次成功的 `todo_write` tool part；
- 最多 10 项，每项最多 100 个 Unicode 字符。

当前 key 的本质是：

```text
sessionId + contextScopeId?
```

其中 primary run 没有 `contextScopeId`，所以同一 session 内的 ordinary task 与所有 Goal 共享一份 main Todo。

### 2.2 Goal 生命周期

`packages/ohbaby-agent/src/goals/` 已具备：

- 稳定的 `goalId`；
- active / paused / complete 状态；cancel 通过 clear 表达，不是驻留状态；
- 自动 continuation；
- pause、cancel、预算停止与 subagent execution interrupt；
- complete 后允许当前 main run继续输出最终回答；
- `/goal replace` 原地修改 objective，并保留当前 `goalId`；
- `CreateGoal({ replace: true })` 清理旧 Goal 并生成新 `goalId`。

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 启动 Goal continuation 时会标记：

```ts
{ owner: "goal", sessionId, suppressGoalContextNote: true }
```

这已经提供了识别 goal-owned primary run 的入口，但 Todo 工具尚未消费该 ownership。

### 2.3 Todo UI 投影

in-process adapter 当前：

- run 开始时读取 main session Todo，并通过 `showTodoForRun` 发布；
- `todo_write` 成功后向 UI 发布最新列表；
- subagent Todo 不发布到主 UI；
- 每个 run terminal 都调用 `hideTodoAfterRun`。

Web 与 CLI 消费的是 adapter 选出的单一 Todo 投影，SDK 事件不需要知道 Goal 或内部 scope。

### 2.4 Prompt

`packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md` 已分别描述 Todo 与 Goal 的使用规则，但两部分之间没有契约：

- 没有说明复杂 Goal 应在何时创建 Todo；
- 没有说明 Goal continuation 中应维护同一 Todo；
- 没有说明 complete 前 reconcile Todo；
- 没有说明 Todo 不构成 Goal complete 硬门禁。

Goal continuation 的核心提示位于 `packages/ohbaby-agent/src/goals/constants.ts`，当前同样缺少 Todo 对账指引。

## 3. 问题清单

### P1. Main Todo 只有 session scope，发生 workload 串扰

现状：ordinary task 与 active/paused Goal 共用相同的 main Todo key。

可复现场景：

```text
Goal A 创建 Todo A
→ pause Goal A
→ 用户发起普通任务
→ main 读取或写入 Todo B
→ resume Goal A
→ Goal A 读取到 Todo B，Todo A 已被覆盖
```

根因不是缺少 `goalId`，而是 TodoStore 与 tool execution context 没有 workload ownership 维度。

影响：

- 模型依据错误列表继续工作；
- UI 向用户展示不属于当前任务的进度；
- complete/cancel/replace 后旧列表可能残留到普通任务；
- 历史恢复可能恢复最近一次其他 workload 的写入。

### P2. Todo UI 跟随物理 run，而不是逻辑 Goal

每个 continuation 结束都会执行 `hideTodoAfterRun`，下一轮再 `showTodoForRun`。

影响：

- continuation 边界出现 hide/show 闪烁；
- UI 展开状态和用户视觉连续性可能被重置；
- “Goal 仍 active”与“面板已隐藏”语义冲突；
- adapter 无法表达等待下一轮 continuation 的逻辑活动状态。

### P3. 历史恢复没有 workload filter

Todo 恢复只按 session/context 找最后一次成功的 `todo_write`。增加内存 scope 但不修改恢复元数据，会在进程重建或 cache miss 时重新串扰。

影响：

- 内存期测试可能通过，重启/恢复后失败；
- compact 或 transcript replay 后出现非确定行为；
- 旧的 ordinary write 可能被错误认领为 Goal Todo。

### P4. 动态 scope 解析会在 complete 时产生同 run 竞态

Goal complete 会先更新/清理 Goal 状态，随后 main agent 才输出最终回答。如果 Todo 在每次 read/write/render 时查询 `getActiveGoal()`：

```text
run 开始属于 goal:<goalId>
→ UpdateGoal(complete)
→ active Goal 被清除
→ 同一 run 后续解析为 ordinary scope
```

影响：

- complete 前最后一次 Todo reconcile 与最终 UI 可能落到不同 scope；
- 最终回答阶段可能误显示普通 Todo；
- 竞态依赖工具调用顺序，难以通过静态 store key 修复。

因此 scope 必须是 run-start snapshot/lease，而不是 GoalStore 的动态派生值。

### P5. Prompt 未建立 Goal 与 Todo 的软协作契约

当前模型可能：

- 对复杂 Goal 不创建 Todo；
- 每轮 continuation 创建新列表；
- 实际完成后忘记更新 Todo；
- Todo 仍 stale 就 complete；
- 为简单 Goal 过度规划；
- 把 Todo 当成 objective 的替代品。

这类问题不能靠 runtime hard gate 修复，需要系统提示、Goal continuation 提示和真实模型评估共同约束。

### P6. 缺少 Goal × Todo 组合测试

现有测试分别覆盖 Todo 和 Goal，但没有锁定：

- ordinary 与 Goal Todo 隔离；
- active Goal 跨 continuation 保持 Todo 可见；
- pause → ordinary → resume 恢复；
- complete 清 Goal 后当前 run 仍持有原 scope；
- scope-aware history recovery；
- subagent Todo 与 main Goal Todo 隔离；
- 模型在 complete 前对账但 runtime 不做硬门禁。

## 4. 七个维度的系统分析

| 维度 | 当前状态 | 判断 |
| --- | --- | --- |
| 模块职责 | TodoStore 管列表，GoalService 管 Goal，adapter 管 UI/运行编排 | 基本合理，不应把 Todo 塞入 GoalStore |
| 数据流 | Tool context 只有 session/context scope，Goal owner 只留在 adapter | ownership 信息在到达 Todo 前丢失 |
| 状态与生命周期 | Goal 跨 run，Todo UI 按 run 显隐 | 两套生命周期粒度不一致 |
| 接口与依赖 | Todo 工具公开参数简洁；Goal 与 Todo 无直接依赖 | 应通过窄 resolver/lease 接合，避免领域互相 import |
| 扩展性 | 已有稳定 goalId、完整 Todo snapshot、统一 UI 投影 | 支持低成本增加内部 workload scope |
| 可测试性 | Store、adapter、Goal 均已有 unit/contract 基础 | 缺少组合场景和可观察 scope seam |
| 一致性与维护性 | Web/CLI 共享 adapter 事件；Todo 权威文档只描述 session/context | 设计基础好，但文档和恢复语义需同步扩展 |

## 5. 代码与现有文档偏差

| 文档/契约 | 当前描述 | 新问题 |
| --- | --- | --- |
| `docs/tools/todo-list/goals-duty.md` | Todo scope 是 session/context，run end 隐藏 | 无法表达 Goal workload 与跨 continuation 可见性 |
| `docs/tools/todo-list/architecture.md` | Todo 与 Goal 平行 | 仍正确，但需补充 composition-level scope resolver |
| `docs/tools/todo-list/data-model.md` | TodoItem 不含 Goal 字段 | 应保持；scope 属于 store key/metadata，不属于 TodoItem |
| `docs/goals/goals-duty.md` | Goal 不拥有 subagent/其他工具状态 | 应保持；Goal 只提供 identity，Todo 自己管理列表 |
| Goal continuation prompt | 聚焦 objective 与完成验证 | 缺少有条件使用 Todo、complete 前 reconcile 的软契约 |

## 6. 软件工程判断

### 6.1 保持权威状态单一

Goal objective/status 是业务权威，Todo 是派生的执行视图。让 `UpdateGoal(complete)` 读取 Todo 会形成双写、双权威和状态组合爆炸。

### 6.2 ownership 是运行时上下文，不是模型输入

`goalId`、sessionId、contextScopeId 都是执行身份。让模型在工具参数中传 scope 会增加伪造、误传和 prompt 负担，也破坏信息隐藏。

### 6.3 用最小新机制解决真正问题

已有稳定 `goalId`、完整列表替换、统一 adapter 投影和历史 tool part，无需新增数据库或通用 workflow 引擎。最小充分机制是：

```text
Todo key 增加内部 workload scope
+ run-start scope lease
+ scope-aware recovery
+ workload-aware UI visibility
```

### 6.4 避免把 primary `contextScopeId` 语义污染成 Goal scope

`contextScopeId` 当前表达 agent/subagent 执行上下文；primary 没有该值是已有不变量。复用它承载 Goal 会混淆“谁在执行”与“为哪个 workload 执行”，并影响 subagent 隔离逻辑。

## 7. 总体结论

现有 Goal 与 Todo 各自结构健康，问题集中在 composition layer：缺少 workload identity 的传播与逻辑生命周期协调。

推荐保持两个领域独立，在 adapter/runtime 捕获 goal-owned run 的 `goal:<goalId>` scope lease，再通过窄接口提供给 Todo 工具、恢复逻辑与 UI 投影。这样能解决串扰和闪烁，同时不引入第二套 Goal 状态机。
