# TodoList 开发前讨论结论

## 1. 讨论目标

本轮讨论不是继续扩展 Todo 成任务管理系统，而是冻结一个适合 Agent 高频读写、可在 Web/TUI 稳定展示的最小契约。

## 2. 已确认决策

### D-01：保留两个 snake_case 工具

- 写工具：`todo_write`
- 读工具：`todo_read`
- `todo_write` 必须传完整数组，使用整体替换语义。
- `todo_read` 无参数，只返回当前 session/context scope 的列表。

### D-02：TodoItem 保持最小

```ts
type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}
```

- 删除 `id`、`priority` 和 `cancelled`。
- 不加入时间戳、owner、blocker、activeForm 等字段。
- 数组顺序就是执行顺序和隐式优先级，后端与 UI 均不得重排权威数组。
- 允许多个项目同时为 `in_progress`。

### D-03：规模与校验

- 后端硬上限为 10 项。
- 单项 `content` 上限为 100 个 Unicode 字符，去除首尾空白后必须非空。
- 任一项目不合法时整次写入失败，旧列表保持不变，也不发布事件。
- `todo_write([])` 是合法的显式清空。
- 相同完整列表重复写入可成功；当列表和 `visible` 投影都未变化时，不重复发布 `todo.updated`。

### D-04：事实源与恢复

- 运行时使用按 session/context scope 隔离的内存投影。
- 不新增 Todo 专用文件、数据库表或浏览器本地存储。
- 可恢复事实源是消息历史中最后一次成功完成的 `todo_write`。
- 失败、拒绝、取消或没有成功结果的写调用不能成为恢复点。
- 成功的 `todo_write([])` 是有效最终事实，恢复后仍为空。
- 内部必须区分“尚未加载”与“已加载且为空”，避免已清空列表被旧历史重新覆盖。

### D-05：正式 UI 契约

- Web 与 TUI 都只消费后端提供的 `UiSnapshot` 和 `todo.updated`，不各自扫描消息历史。
- Todo 内容事实与 UI 生命周期投影分开：`TodoItem` 仍只有 `content/status`；后端投影额外携带当前 session 的可见性，保证重连和 snapshot resync 一致。
- `todo_read` 不产生 UI 事件；成功且发生变化的 `todo_write` 产生完整列表替换事件。
- UI 的展开/收起状态只保存在当前客户端内存中，不持久化。

### D-06：显示生命周期

- run 运行中：非空列表可见。
- 当前 run 内所有项目刚完成：继续显示到 run 结束。
- run 结束：立即隐藏，但不自动清空后端列表。
- `todo_write([])`：立即隐藏。
- 新 run/resume：仅当恢复列表中存在 `pending` 或 `in_progress` 时重新显示。
- session 切换时只展示当前主 session 的投影。

### D-07：Web 与 TUI 呈现

- Web 借鉴 OpenCode：composer 上方的 TodoDock，完整渲染最多 10 项，通过固定最大高度和纵向滚动控制空间。
- TUI 借鉴 Kimi Code：紧邻 Prompt 上方；紧凑态最多 5 项，`Ctrl+T` 在有溢出时切换展开/收起，展开后最多展示后端允许的 10 项。
- TUI 紧凑选择：优先纳入所有 `in_progress`（最多 5），再补数组中最早的 `pending`，有剩余位置时保留最近的 `completed`；最后按原数组顺序显示。
- TUI 溢出提示保持简单：`+N more · ctrl+t to expand`。
- 完成项在上、未完成项在下的视觉误读不能通过反转数组解决；权威数组顺序始终保持，状态只用图标/颜色表达。

### D-08：Transcript 静默

- `todo_read` 和 `todo_write` 的 tool call/result 均不进入 Web/TUI 正常 transcript。
- 不显示 `✓ Todo updated · 3/7 finished`、原始 JSON 或工具结果正文。
- 工具失败也不在普通 transcript 中显示；错误仍返回 Agent 以便修正重试，并保留在底层消息历史/诊断信息中。
- 只有 TodoDock/TodoPanel 表达进度状态。

### D-09：session 与子 Agent 隔离

- 每个 session/context scope 拥有独立 TodoList。
- 主 session 的 TodoDock 只显示主 session Todo。
- 子 Agent Todo 不汇总到主 TodoDock，也不为未来子 Agent 详情页预设计额外字段。

## 3. 已接受的实现判断

- 不为无 `id` 的项目制造持久身份；React key 可使用仅限渲染周期的组合键，不能反向进入领域模型。
- UI 可见性属于可重建的展示投影，不属于 Agent 可写的 Todo 事实。
- 对相同数组做结构比较以抑制重复事件，数组最多 10 项，比较成本可忽略。
- 恢复失败应保留明确日志，但不能使 session resume 失败。

## 4. 本轮不再开放的范围

- 不增加 priority、cancelled、用户勾选、拖拽排序、跨 session 汇总。
- 不增加独立持久化。
- 不把 Todo 工具调用重新放回 transcript。
- 不把 Web/TUI 历史推导作为降级方案。

## 5. 进入开发的门槛

- 上级七份设计文档与本结论一致。
- 父级 `docs/tools/` 的 Todo 摘要契约已同步。
- `01` 中的问题均在 `02` 有对应处理项。
- `02` 的每个阶段均在 `04` 有可执行验收。
- 用户确认本 problem-list 后，才进入临时分支实施。
