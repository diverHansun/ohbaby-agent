# 03. 参考项目借鉴

## 1. 调研范围与证据边界

| 项目 | Commit | 定位 |
| --- | --- | --- |
| Codex | `5c19155cbd93bfa099016e7487259f61669823ff` | `update_plan`、Goal identity、跨 turn accounting 与 UI |
| Kimi Code | `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` | Agent ToolStore Todo、Goal、resume/compaction 与 TUI/Web |
| Claude Code 参考仓库 | `75e2b3b95b303982449603388aba159fbaf67ba4` | TodoWrite、Task V2 scope resolver、persistent UI 与 soft completion |

Claude Code 本地仓库在 `AGENTS.md` 中声明为反编译/逆向实现，并包含 stub 与 feature flag。因此相关结论只作为这个本地参考仓库的工程证据，不声称代表 Anthropic 官方上游。

## 2. Codex

### 2.1 观察

Codex 的 `update_plan` 工具参数只有：

- `explanation`；
- 完整的 `plan[]` 快照。

它没有 `planId`、`goalId`、threadId 或 turnId。app-server 在工具执行之外给通知补充 `thread_id + turn_id`，说明执行身份由 runtime/harness 注入，不由模型提供。

主要证据：

- `/Users/hansun025/Projects/code-cli/codex/codex-rs/protocol/src/plan_tool.rs`
- `/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/tools/handlers/plan.rs`
- `/Users/hansun025/Projects/code-cli/codex/codex-rs/app-server/src/bespoke_event_handling.rs`

Codex Goal 与 plan 不同，是带稳定 `goal_id` 的持久状态。每次 create/replace 生成新 Goal identity，turn 绑定 active goal，并使用 expected goal id 防止旧 turn 的 accounting 结果污染新 Goal。

主要证据：

- `/Users/hansun025/Projects/code-cli/codex/codex-rs/state/migrations/0029_thread_goals.sql`
- `/Users/hansun025/Projects/code-cli/codex/codex-rs/state/src/runtime/goals.rs`
- `/Users/hansun025/Projects/code-cli/codex/codex-rs/ext/goal/src/accounting.rs`

Goal continuation prompt 鼓励复杂任务使用 `update_plan`、持续维护并在结束前对账，但 `update_goal(complete)` runtime 不读取 plan。

### 2.2 借鉴

- 执行身份由 runtime 注入，不暴露在 Todo tool schema；
- 完整 Todo snapshot 适合模型重写和 reconcile；
- Goal 使用稳定 ID 保护跨 turn 状态，证明 thread/session ID 不是充分的 workload identity；
- complete 前依靠 prompt audit，而不是 plan/Todo hard gate；
- UI progress 不应在每个物理 turn 结束时无条件清除。

### 2.3 不照搬

- `update_plan` 没有 durable current-plan store，只依赖历史事件；
- plan 只有 thread/turn 上下文，没有 workload scope；
- restart 后不能可靠恢复当前 checklist UI；
- 一些 plan 不变量只写在 prompt/tool description，handler 不强校验。

### 2.4 对本方案的结论

`goal:<goalId>` 延续 Codex 的 identity 注入和 stale-write 隔离思想，同时补上 Codex plan 在同 thread 多 workload 之间可能串扰的缺口。

## 3. Kimi Code

### 3.1 观察

Kimi Todo 是 Agent 级 ToolStore 中的单一 `todo` key：

- 数据只有 title/status；
- 每次写入替换完整列表；
- main 与 subagent 因 Agent 实例不同而隔离；
- 同一个 main Agent 中，普通任务与不同 Goal 共享 Todo。

主要证据：

- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/tools/builtin/state/todo-list.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/tool/index.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/index.ts`

Kimi Goal 有稳定 UUID，新建/replace 会创建新 ID，但 Goal lifecycle 不切换 TodoStore key。因此 pause → ordinary → resume 仍会串 Todo。

Kimi 的 ToolStore update 可以 replay；compaction 会把当前 Todo 带入摘要；Todo 长时间不更新会给模型 soft reminder。TUI Todo 跨 turn 常驻，而 Web 从 transcript 扫描最后一次 Todo write，两端在全部完成后的显示语义并不完全一致。

主要证据：

- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/goal/index.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/records/index.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/compaction/full.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/injection/todo-list.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/apps/kimi-code/src/tui/components/chrome/todo-panel.ts`

### 3.2 借鉴

- Todo 使用完整快照，适合恢复与 compaction；
- main/subagent 的 Todo 默认隔离；
- active workload 的 UI 跨物理 turn 保持；
- stale Todo 通过软提醒让模型重写；
- Todo 是轻量执行进度，不替代 Goal objective 或正式 Plan；
- complete 不因 Todo pending 被 runtime 阻塞。

### 3.3 不照搬

- 单 Agent 单 Todo key；
- pause/ordinary/resume 不切 workload ownership；
- TUI 与 Web 各自推导 Todo 可见性；
- history/compaction 只读当前单 key，不能过滤 workload；
- Goal complete/cancel/replace 不处理 Todo 投影。

### 3.4 对本方案的结论

最关键启示是 scope 必须在 goal-owned run 开始时冻结到最终回答结束。否则 `UpdateGoal(complete)` 清除 Goal 后，同一 run 会错误回到 ordinary Todo。

## 4. Claude Code 参考仓库

### 4.1 观察

TodoWrite V1 使用：

```text
context.agentId ?? sessionId
```

因此 main/subagent 隔离，但 ordinary 与 Goal 仍共享 main session scope。恢复时从 transcript 中最后一次 TodoWrite 读取列表。

主要证据：

- `/Users/hansun025/Projects/code-cli/claude-code/packages/builtin-tools/src/tools/TodoWriteTool/TodoWriteTool.ts`
- `/Users/hansun025/Projects/code-cli/claude-code/src/utils/sessionRestore.ts`

Task V2 的 item 不携带 scope，而由组合层的 `getTaskListId` resolver 根据环境、team 或 session 选择存储目录。这证明 owner identity 更适合位于 store key/resolver，而不是 Task/Todo item。

主要证据：

- `/Users/hansun025/Projects/code-cli/claude-code/src/utils/tasks.ts`
- `/Users/hansun025/Projects/code-cli/claude-code/src/hooks/useTasksV2.ts`

Task UI 使用常驻 store/watcher，跨物理 turn 存在；全部完成后短暂展示再隐藏。Task 使用条件由模型策略决定：多个步骤、复杂任务、Plan Mode、用户显式要求或多个任务，而不是输入长度硬触发。

Goal complete 路径不查询 Todo/Task，final response 也不被 pending Task 硬阻塞。

### 4.2 借鉴

- scope 由组合层 resolver 决定，item 保持纯业务模型；
- logical task UI 独立于物理 run；
- main 与普通 subagent Todo 隔离；
- 复杂度驱动 Todo，而非 Goal 模式强制或字符数阈值；
- soft reminder、验证提醒和完成前 reconciliation；
- 全部完成后可以短暂保留 UI，再由逻辑生命周期隐藏。

### 4.3 不照搬

- standalone session 仍只有单 scope；
- team-shared TaskList 的依赖图、文件锁与 owner 协作复杂度；
- 仅靠 stale reminder 处理用户插话；
- completed 后立即删除底层 Todo 数据；
- 将普通 subagent 改成共享 main Todo 的 teammate 模型。

### 4.4 对本方案的结论

采用 `subagent context > goal-owned run > ordinary session` 的 resolver 顺序，同时由 adapter 显式响应 scope/lifecycle 变化。若未来 scope 落盘，内部语义可保持 `goal:<goalId>`，物理 key 应结构化或安全编码，不能只做字符替换。

## 5. 横向比较

| 议题 | Codex | Kimi Code | Claude 参考仓库 | OhBaby 方案 |
| --- | --- | --- | --- | --- |
| Todo/Plan scope | transient thread/turn context | Agent 单 key | agent/session 或外部 taskListId | session + context + goal workload |
| Goal identity | 稳定 goalId | 稳定 goalId | 参考 fork 有 Goal identity | 已有稳定 goalId |
| 模型传 scope | 否 | 否 | 否 | 否 |
| 跨物理 turn UI | 不主动清 progress | TUI 保持 | watcher 保持 | active Goal 保持 |
| pause→ordinary→resume 隔离 | 未解决 | 未解决 | 未解决 | `goal:<goalId>` 解决 |
| complete hard gate | 无 | 无 | 无 | 无 |
| 完成前 reconcile | prompt | 通用 Todo prompt | soft prompt/hook | Goal 专用 prompt + eval |
| durable current list | 不完整 | ToolStore/replay | store/transcript | TodoStore + scoped recovery |

## 6. 采纳、适配与拒绝

### 直接采纳

- ownership 由 runtime/composition 注入；
- Todo 采用完整列表快照；
- Goal objective 与 Todo 分离；
- 复杂任务才使用 Todo；
- complete 前软性对账；
- main/subagent 默认隔离。

### 结合 OhBaby 适配

- 以现有 stable goalId 建立 `goal:<goalId>` workload scope；
- 将 TodoStore/recovery 做成 scope-aware；
- 将 UI 生命周期从 run-bound 提升为 active-Goal-bound；
- 在 run start 冻结 scope，覆盖 complete 清 Goal 到 final answer 的窗口；
- Web/CLI 继续共享 adapter 投影，避免两端自行解析 transcript。

### 明确拒绝

- 只使用 session/Agent 单 Todo；
- 把 goalId 放进 TodoItem 或模型 tool schema；
- Goal complete 读取 Todo 并硬拒绝；
- 为本轮引入 team queue、依赖图、owner/lock 等协作系统；
- 仅依赖 prompt 解决 ownership 串扰；
- 因参考项目已有某种实现而复制其 UI 不一致或恢复缺口。

## 7. 最终判断

三个参考项目的共同工程方向是：

> Todo/Plan 是模型维护的执行视图，owner identity 由运行时提供，logical workload 可以跨物理 turn，完成前通过软约束对账。

它们的共同缺口是 session/Agent 粒度不足以处理“Goal 暂停后执行普通任务，再恢复 Goal”。OhBaby 已有稳定 `goalId`，因此增加内部 `goal:<goalId>` scope 是最小且针对性的补强，不需要引入更重的计划或任务管理系统。
