# 00. 讨论与决策记录

## 1. 目标

当 Goal 面临较多任务、用户自然语言包含多个交付项、工作需要分步骤推进，或持续展示完成情况有明显价值时，main agent 可以使用 Todo 规划和呈现执行进度。

本轮不追求“每个 Goal 都有 Todo”，而是让 Todo 在被使用时具备正确的 ownership、恢复能力和 UI 生命周期。

## 2. 已确认决策

### D1. Goal Todo 使用内部 workload scope

采用：

```text
goal:<goalId>
```

该值由运行时根据 goal-owned primary run 注入：

- 用户不传；
- 模型不传；
- `todo_read` / `todo_write` 工具 schema 不新增 scope 参数；
- TodoItem 不增加 `goalId`；
- UI SDK 不暴露内部 scope。

这样可以阻断：

```text
Goal A Todo
→ pause
→ ordinary task Todo
→ resume Goal A
→ Goal A Todo 被 ordinary task 覆盖
```

### D2. Goal active 期间 Todo 跨 continuation 持续可见

Todo 面板的显隐生命周期跟随逻辑 workload，而不是每个物理 run：

- Goal continuation run 结束、下一轮 continuation 尚未开始时，不隐藏 Goal Todo；
- continuation 之间不重复清空或卸载面板；
- pause/cancel 后隐藏当前 Goal Todo，但保留数据；
- resume 同一 Goal 后恢复同一 Todo；
- complete 在当前 main run 输出最终回答后再隐藏。

### D3. Complete 前软性 reconcile，不设硬门禁

推荐顺序：

```text
完成实际工作与验证
→ reconcile 当前 Goal Todo
→ UpdateGoal(complete)
→ main agent 输出最终回答
→ 当前 run settlement 后隐藏 Goal Todo
```

运行时不会因为 Todo 仍有 `pending` 或 `in_progress` 而拒绝 complete。原因是：

- Goal objective 才是完成判定的权威；
- Todo 可能过时、被重写或不适用于简单 Goal；
- 硬门禁会把辅助视图升级成第二套状态机；
- 模型仍须在 prompt 与真实 API 评估中接受约束。

### D4. Todo 的使用由任务结构决定

建议创建 Todo 的条件：

- 有多个可独立核验的交付项；
- 存在明显依赖或顺序；
- 需要较长调查、实现、验证链路；
- 向用户持续展示进度有价值。

不以用户输入长度作为唯一触发条件，也不为简单、单步骤 Goal 创建形式化列表。Todo 上限仍是 10 项，因此应表达里程碑，而不是机械复制每条自然语言要求。

### D5. Main 与 subagent 的 Todo 相互隔离

- main agent 维护 Goal 的主 Todo；
- subagent 继续使用自己的 `contextScopeId` Todo；
- subagent 不直接改写 main Goal Todo；
- main 根据 subagent 的结果推进或重写主 Todo。

scope 优先级为：

```text
subagent context scope
> goal-owned primary run scope
> ordinary session scope
```

### D6. Scope 必须在 run 开始时冻结

不能在每次 Todo 调用时仅查询“当前 active Goal”。`UpdateGoal(complete)` 会先清除 Goal，而 main 仍需输出最终回答；动态解析会让同一个 run 中途从 `goal:<goalId>` 切回 ordinary scope。

因此 goal-owned run 在启动时取得 scope lease，并保持到 run settlement：

```text
run start: workloadScope = goal:<goalId>
→ Todo read/write/render 均使用该 scope
→ UpdateGoal(complete) 可以清除 GoalStore
→ 当前 run 仍持有原 scope
→ final answer
→ run end 释放 lease
```

## 3. 待本轮继续对齐的问题

### Q1. `/goal replace` 是否沿用 Todo scope（本轮决定）

OhBaby 当前 `/goal replace` 是原地更新 objective，并保留 `goalId`；而 `CreateGoal({ replace: true })` 会创建新 `goalId`。Codex 和 Kimi Code 的 replace 倾向创建新 Goal identity。

本轮采用：

- `/goal replace`：保持现有“同一 Goal 原地修订”的语义，沿用 `goal:<goalId>`，并要求模型立即 reconcile 或重写 Todo；
- `CreateGoal({ replace: true })`：新 `goalId`，自然获得新 Todo scope；
- 如果产品希望 `/goal replace` 代表全新任务，应先统一 Goal identity 语义，再让 Todo 随新 ID 切换，不为 Todo 单独引入 revision/tombstone。

该推荐遵循最小机制原则，并避免让 Todo 反向改变 Goal 的既有产品语义。

`CreateGoal({ replace: true })` 的模型路径与 slash replace 不同。它会创建新 `goalId`，因此状态机规则是：

- 当前 goal-owned run 已取得的 lease 不切换，仍只能读写旧 Goal scope；
- 新 Goal 立即成为 GoalStore 中的 active identity，但它的 Todo scope 从下一轮 run 开始使用；
- 当前 run settlement 时，adapter 按最新 active Goal 重新选择 UI projection；
- 旧 run 的延迟 Todo event 不得写入或投影到新 Goal scope；
- 不在一个 run 内动态迁移 lease，也不让旧 run 帮新 Goal 初始化 Todo。

### Q2. 升级前未分 scope 的旧 Todo 如何处理（本轮决定）

本轮采用保守兼容：

- 没有 workload scope 元数据的历史 Todo 视为 ordinary session Todo；
- 不猜测它属于哪个 Goal，也不自动搬迁；
- 升级后首次进入 active Goal 时，如果没有对应 scoped Todo，则从空列表开始；
- 这样会牺牲一次旧 Goal Todo 的自动继承，但避免错误认领和跨任务污染。

发布说明必须明确这项一次性体验变化；不增加基于“最近 active Goal”等启发式迁移。

## 4. 参考项目范围

- `/Users/hansun025/Projects/code-cli/codex`
- `/Users/hansun025/Projects/code-cli/kimi-code`
- `/Users/hansun025/Projects/code-cli/claude-code`

三个项目共同支持“运行时注入 ownership、Todo/Plan 作为软执行视图、完成前依靠模型对账而非硬门禁”的方向；它们也共同暴露了 session/agent 单 scope 容易串扰的问题。

## 5. 实施门槛

在用户确认 Q1 与 Q2 前，不创建开发分支、不修改生产代码。确认后按 [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) 分阶段实现，并以 [04-test-and-acceptance.md](./04-test-and-acceptance.md) 为验收契约。
