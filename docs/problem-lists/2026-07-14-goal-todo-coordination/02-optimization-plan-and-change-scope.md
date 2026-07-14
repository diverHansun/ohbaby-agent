# 02. 优化方案与改动面

## 1. 设计目标

1. 同一 session 内，ordinary、不同 Goal、subagent 的 Todo 不互相覆盖。
2. Active Goal 的 Todo 跨 continuation 连续展示，不被物理 run 边界打断。
3. Pause/cancel/complete 后切换 UI 投影，但数据保留且 ownership 清晰。
4. Complete 前由模型 reconcile Todo，runtime 仍只根据 Goal objective/status 完成状态转换。
5. 不增加公开工具参数，不污染 TodoItem，不新增数据库。
6. 兼容现有 session/context Todo，并可从历史 tool result 恢复正确 scope。

## 2. 目标架构

```text
GoalService / GoalStore
  └─ 提供稳定 goalId 与 Goal 生命周期
                 │
                 │ goal-owned run start
                 ▼
Adapter / runtime composition
  └─ 捕获 TodoWorkScopeLease = goal:<goalId>
                 │
                 ├─ 注入 todo_read / todo_write 的内部执行上下文
                 ├─ 选择 TodoStore key
                 ├─ 过滤 history recovery
                 └─ 控制当前 session 的单一 UI 投影
                              │
                              ▼
TodoService / TodoStore
  └─ sessionId + contextScopeId? + workScopeId?

Web / CLI SDK
  └─ 仍只接收当前 Todo 列表与 visible/hidden 状态
```

边界原则：

- Goal 提供 workload identity，但不拥有 Todo 数据；
- Todo 管理列表，但不决定 Goal 是否完成；
- adapter/runtime 负责把当前 run 的 ownership 组合起来；
- UI 只消费投影结果，不参与 scope 解析。

## 3. 内部 scope 模型

以下是概念接口，最终命名可在实现阶段按现有代码风格调整：

```ts
type TodoWorkScopeId = `goal:${string}`;

interface TodoScope {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly workScopeId?: TodoWorkScopeId;
}

interface TodoWorkScopeLease {
  readonly workScopeId?: TodoWorkScopeId;
}
```

Store key 扩展为：

```text
sessionId + contextScopeId? + workScopeId?
```

解析优先级：

| 执行类型 | contextScopeId | workScopeId | 最终 ownership |
| --- | --- | --- | --- |
| subagent | 有 | 忽略 main Goal scope | subagent 自己的 context scope |
| goal-owned primary run | 无 | `goal:<goalId>` | 当前 Goal workload |
| ordinary primary run | 无 | 无 | 普通 session workload |

不建议把 `goal:<goalId>` 填进 `contextScopeId`。前者表达“为哪个 workload 工作”，后者表达“哪个 agent context 在工作”，语义正交。

## 4. Run-start scope lease

### 4.1 捕获时机

Goal driver 调用 continuation runner 时，必须把当前 snapshot 的 `goalId` 与 prompt 一起传给 adapter。adapter 接受并启动 primary prompt 时，根据显式 owner identity 捕获：

```text
owner = goal + explicit goalId
→ workScopeId = goal:<goalId>
```

ordinary prompt 则为 `undefined`。

不允许 adapter 在每次 Todo 调用时反查 GoalStore。若 `owner = goal` 却缺少 `goalId`，这是内部不变量错误：拒绝启动该 run、记录 error notice，并让 Goal driver 按失败路径 pause；绝不降级到 ordinary scope。

scope lease 必须随当前 run 保留到 terminal settlement，不随 GoalStore 的中途变化重新解析。

### 4.2 为什么不能按工具调用动态查询

`UpdateGoal(complete)` 会在最终回答前清理 Goal。如果按调用动态查询 active Goal，同一 run 会出现 scope 跳变。run lease 将状态切换限制在明确边界：

```text
run start   acquire scope
run body    stable scope
run end     release scope
next run    resolve again
```

### 4.3 最小传播范围

优先在 adapter/tool composition 注入一个窄 Todo scope resolver 或 lease，不把通用 `workScopeId` 扩散到所有 core message、provider request 和生命周期类型。

只有当实现证明现有 tool execution context 无法安全承载时，才扩大公共运行上下文；不得为未来可能的其他 workload 预先设计通用 workflow scope 框架。

## 5. TodoStore 与历史恢复

### 5.1 Store

- `read` / `write` 内部接收完整 TodoScope 或增加内部 `workScopeId` 参数；
- ordinary 与未升级的调用保持现有默认 key；
- Goal scope 不改变 TodoItem schema 与校验规则；
- 空数组只清空当前 scope，不影响同 session 其他 scope。

### 5.2 Tool result metadata

成功的 `todo_write` result metadata 记录内部 workload scope，例如：

```ts
{
  count,
  todos,
  internalWorkScopeId?: "goal:<goalId>"
}
```

命名需明确为内部数据，不进入模型工具参数与公开 UI payload。恢复时必须同时匹配：

```text
session/context ownership + internal workload scope
```

### 5.3 旧历史兼容

- metadata 没有 work scope：只属于 ordinary session；
- 不将旧 write 猜测迁移到某个 Goal；
- 失败、取消或未完成的 `todo_write` 不参与恢复；
- 不引入数据迁移脚本或新表。

## 6. UI 生命周期契约

UI 始终只展示当前 session 的一个 Todo projection，不新增 scope picker。

| 事件 | 数据 | UI 行为 |
| --- | --- | --- |
| ordinary run start | 读取 ordinary scope | 有未完成项则显示 |
| ordinary run end | 保留 ordinary 数据 | 沿用现有普通任务显隐规则 |
| Goal run start | 读取 `goal:<goalId>` | 有列表则显示；写入后立即显示 |
| active continuation run end | 保留 Goal 数据 | 不隐藏，不发无意义的 hide/show |
| 下一轮 Goal continuation start | 读取同一 scope | 维持或幂等刷新，不闪烁 |
| Goal pause | 保留 Goal 数据 | 当前 run settlement 后隐藏 |
| Goal resume | 读取同一 goalId scope | 恢复原列表 |
| Goal cancel | 保留数据供审计/历史 | settlement 后隐藏，不污染 ordinary |
| Goal complete | 保留当前 run scope | 最终回答结束后隐藏 |
| 新 Goal | 使用新 goalId scope | 不继承其他 Goal 列表 |

这里的“持续可见”是逻辑状态，不表示 UI 必须显示空列表。Goal 尚未创建 Todo，或模型把列表清空时，面板可以不显示。

Web 与 CLI 均继续消费 adapter 的统一事件/快照，不能分别从 transcript 猜测当前 workload。

## 7. Goal 状态转换语义

### 7.1 Pause / resume

```text
active Goal A + scope goal:A
→ pause: interrupt current execution, hide projection, retain goal:A data
→ ordinary request: use ordinary scope
→ resume A: reacquire goal:A, restore Todo A
```

Goal resume 仍重新接管整个 session；ordinary primary run 与其 background subagent 在对用户完成回答前必须 settlement，subagent instance 是否保留不影响 Todo ownership。

### 7.2 Complete

```text
verify objective
→ todo_read / todo_write reconcile in frozen goal scope
→ UpdateGoal(complete)
→ GoalStore clear + straggler subagent settlement
→ main final answer
→ primary run settlement
→ hide Goal Todo projection
```

`UpdateGoal(complete)` 不读取 Todo，不检查全部 completed，也不自动改写 Todo。

### 7.3 Cancel

Cancel 不清空 ordinary scope，也不让 Goal Todo 继续投影。是否未来提供历史 Goal Todo 查看能力属于新产品范围，本轮只保留底层数据与 transcript 证据。

### 7.4 Replace（已决定）

采用：

- `/goal replace` 保留 goalId 与 scope；
- prompt 要求模型根据新 objective 立即重写/reconcile Todo；
- `CreateGoal({ replace: true })` 创建新 goalId 与新 scope；
- 不为 Todo 单独引入 scope revision。

`CreateGoal({ replace: true })` 使用另一条明确规则：

```text
current run lease = goal:A
→ CreateGoal(replace) creates active goal:B
→ current run remains bound to goal:A until settlement
→ no Todo operation in current run can write goal:B
→ settlement reselects projection from latest active Goal
→ next continuation acquires goal:B
```

这会让新 Goal 的 Todo 初始为空，直到下一轮由模型按新 objective 创建；这是 identity 隔离的预期行为。实现不在 run 内换 lease，也不自动复制旧 Todo。

### 7.5 Projection 选择规则

- `publishTodoWrite`：仅投影 primary write，且 event scope 必须与当前 active prompt lease 相同；无 active prompt 或 scope 不匹配的延迟事件只更新底层 store，不抢占 UI。
- `showTodoForRun`：显式读取当前 run lease，不读取“最近一份 primary Todo”。
- active Goal continuation terminal：若 GoalStore 仍是同一 goalId，不 hide。
- run settlement：若最新 active Goal 与 run lease 不同，切换到最新 Goal scope；若无 active Goal 或已 paused，隐藏当前 projection。
- `syncTodoProjectionsFromSource` / snapshot rebuild：先恢复 Goal projection，再选择 active Goal scope；没有 active Goal 时选择 ordinary scope 并保持 hidden。
- subagent write：始终不进入 main Todo projection。

## 8. Prompt 契约

### 8.1 Primary base prompt

补充：

- 复杂、多步骤、依赖明显或需要进度展示的 Goal 才使用 Todo；
- Todo 只写当前可执行的高层里程碑，最多 10 项；
- continuation 中维护现有列表，而不是无故新建；
- subagent 结果由 main 映射回主 Todo；
- objective 变化时重写 Todo；
- Todo 不能替代工作、验证或 Goal objective。

### 8.2 Goal continuation prompt

补充 complete 前顺序：

```text
若当前 Goal 使用过 Todo：
1. 读取并核对 Todo 与实际完成情况；
2. 完成项标记完成；
3. 删除或重写已过时、取消、延期且不再属于 objective 的项；
4. 再调用 UpdateGoal(complete)；
5. 最后向用户回答。
```

明确“不因 Todo pending 而由 runtime 拒绝 complete”，但模型不得故意绕过 reconciliation。

### 8.3 Tool description

Todo 工具不出现 `goalId` 或 scope 参数。`UpdateGoal` 描述可以加入“使用过 Todo 时先对账”的行为提示，但不得声称 runtime 会校验 Todo。

## 9. 分阶段实施

### Phase A：Scope domain 与恢复

- 扩展 TodoStore 内部 key；
- 定义 Todo scope/lease 类型；
- tool result metadata 记录 scope；
- history recovery 按 scope 过滤；
- 加 unit tests 锁定 ordinary/Goal/subagent 隔离和旧历史行为。

### Phase B：Run ownership 接线

- goal-owned primary run 启动时冻结 `goal:<goalId>`；
- 将 lease 注入 Todo tool execution；
- 保证 complete 后到 final answer 期间 scope 不变；
- 加 adapter contract tests。

### Phase C：UI 逻辑生命周期

- active continuation terminal 不再无条件 hide；
- pause/cancel/complete settlement 使用统一显隐规则；
- Web/CLI 不新增 scope 逻辑；
- 测试 event 次数、顺序与 snapshot。

### Phase D：Prompt、评估与权威文档

- 更新 base、Goal continuation、tool description 及生成资产；
- 增加真实 API Goal × Todo 行为评估；
- 更新 Todo 与 Goal 权威文档；
- 运行完整相关测试和 preflight。

## 10. 预期改动面

### 10.1 生产代码

- `packages/ohbaby-agent/src/tools/todo.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Goal continuation owner/active prompt 相关内部类型与 composition wiring
- `packages/ohbaby-agent/src/goals/constants.ts`
- `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md`
- system prompt 生成资产（按仓库既有脚本生成，不手改派生文件）

具体文件以实现期调用链为准；若需要大范围修改 core message 类型，应暂停并重新评审，而不是顺势扩散。

### 10.2 测试

- `packages/ohbaby-agent/src/tools/todo.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Goal × Todo 新 integration test 或扩展现有 Goal integration suite
- prompt asset unit tests
- Web/CLI Todo reducer/panel tests（只在事件契约变化时修改）
- 真实 API evaluation（显式启用，有 key 才运行）

### 10.3 权威文档

- `docs/tools/todo-list/goals-duty.md`
- `docs/tools/todo-list/architecture.md`
- `docs/tools/todo-list/data-model.md`
- `docs/tools/todo-list/dfd-interface.md`
- `docs/tools/todo-list/use-case.md`
- `docs/tools/todo-list/non-functional.md`
- `docs/tools/todo-list/test.md`
- Goal 目录中职责、架构、接口、用例、非功能与测试文档的相关段落

## 11. 明确不改

- TodoItem 的公开字段与最大条目/字符限制；
- Todo 工具公开输入 schema；
- GoalStore 数据模型与数据库 schema；
- `UpdateGoal(complete)` 的 runtime 完成门禁；
- subagent instance 的销毁策略；
- UI 增加多个 Todo 面板或 scope 切换器；
- persistent Goal 重启的完整产品链路。

## 12. 回滚与兼容

- 新 scope 仅为内部 key/metadata 维度，ordinary 默认行为可保持不变；
- 若 UI lifecycle 改动出现回归，可独立回滚为 run-bound 显隐，不需要回滚 scope 隔离；
- 旧 tool result 没有 scope 时按 ordinary 读取，避免破坏历史 session；
- 不做破坏性数据迁移；
- 每个 Phase 应独立提交，便于二分与回滚。

## 13. 完成定义

只有同时满足以下条件才算本优化完成：

- [04-test-and-acceptance.md](./04-test-and-acceptance.md) 的 P0/P1 自动化场景通过；
- Web/CLI 对 active Goal 跨 continuation 无闪烁且行为一致；
- pause → ordinary → resume 不串 Todo；
- complete 后 main 能输出最终回答，同 run scope 不跳变；
- prompt 真实 API 评估证明复杂 Goal 会合理使用并在 complete 前 reconcile Todo；
- runtime 没有新增 Todo complete 硬门禁；
- 权威文档与实现同步。
