# todo-list 模块 use-case.md

本文档描述 TodoList 的关键业务流程。

**前置文档**：`goals-duty.md`、`architecture.md`、`data-model.md`、`dfd-interface.md`

## 一、用例概览

| 用例 | 动作 | 对应职责 |
|------|------|----------|
| UC1 | Agent 原子替换 TodoList | D1、D2、D3 |
| UC2 | Agent 读取当前 TodoList | D1、D3、D4 |
| UC3 | session 从历史恢复 | D4 |
| UC4 | UI 同步并按 run 生命周期显示 | D5 |
| UC5 | UI transcript 隐藏 Todo 工具 | D6 |

## 二、UC1：替换列表

1. Agent 调用 `todo_write({ todos })`。
2. 工具校验列表数量、对象字段、content 和 status。
3. 任一项非法：返回 Agent 可修正错误；旧状态不变；不发布事件。
4. 全部合法：TodoService 以防御性副本整体替换当前 session 列表并标记 loaded。
5. 新旧列表相同：调用成功，不重复发布事件。
6. 列表变化：后端更新 UI 投影并发布 `todo.updated`。
7. call/result 保留在核心消息历史，但不进入 UI transcript。

### 分支

- `todos=[]`：显式清空并立即隐藏面板。
- 多个 `in_progress`：合法，保持输入顺序。
- 第 11 项或 content 超过 100 Unicode 字符：整次拒绝。

## 三、UC2：读取列表

1. Agent 调用 `todo_read({})`。
2. TodoService 检查当前 session 是否 loaded。
3. 若 unloaded，执行 UC3 一次；若 loaded，直接读取，包括 loaded + []。
4. 返回完整列表的 Agent 可读输出和结构化 metadata。
5. 不修改状态、不产生 `todo.updated`、不进入正常 transcript。

## 四、UC3：从消息历史恢复

1. runtime 提供当前 session 的消息历史。
2. recovery adapter 从后向前找 `todo_write` call。
3. 对候选检查对应 result 是否成功完成，并重新验证其完整输入。
4. 失败、取消、拒绝、未完成或损坏候选被跳过，继续向前。
5. 命中最后一个有效成功写入后恢复其数组；成功 `[]` 也立即命中。
6. 没有有效候选则恢复为空。
7. TodoService 进入 loaded，后续读取不得再次扫描并覆盖结果。

恢复异常记录 warning 并降级为空，不使 session resume 失败。

## 五、UC4：UI 同步与生命周期

### 当前 run 内更新

1. 后端收到 TodoService change。
2. 生成当前 session 的完整 `UiSessionTodoList`。
3. 非空写入将 `visible` 设为 true，即使新列表全部 completed。
4. 写入 snapshot state 并发布 `todo.updated`。
5. Web/TUI reducer 替换目标 session 投影，selector 只选择 active main session。

### run 结束

1. runtime 收到终态。
2. 保留 Todo 数组，只把 UI 投影设为 hidden。
3. 客户端隐藏 Dock/Panel。

### 新 run/resume

1. TodoService 保留或恢复列表。
2. 若存在 pending/in_progress，投影重新可见。
3. 若为空或全 completed，保持隐藏。

### 客户端表现

- Web 全量渲染最多 10 项，限高滚动。
- TUI 紧凑态最多 5 项，有溢出时 Ctrl+T 展开到最多 10 项。
- 两端均保持权威数组顺序。

## 六、UC5：Transcript 静默

1. 核心流仍生成 Todo call/result，Agent 正常接收成功或错误。
2. UI message projection 识别工具名并跳过 call/result part。
3. Web/TUI 渲染层对旧 snapshot 中的 Todo part 再做防御性过滤。
4. Todo 进度只通过专用 Dock/Panel 呈现，不生成完成摘要。

## 七、关键失败与决策点

| 编号 | 场景 | 行为 |
|------|------|------|
| FP1 | 写入参数非法 | 原子拒绝，保留旧值，无事件 |
| FP2 | 历史候选损坏 | 跳过候选并 warning，不崩溃 |
| FP3 | snapshot 缺少 todos | 客户端按空处理 |
| FP4 | 事件断线/乱序 | snapshot resync 覆盖本地状态 |
| FP5 | 子 Agent 更新 Todo | 只更新其 context scope 事实，不发布主 UI 投影，不进入主 Dock |
| DP1 | 全部完成是否立刻隐藏 | 否；当前 run 保持，run 结束隐藏 |
| DP2 | 相同列表是否发事件 | 否；成功但抑制重复事件 |
| DP3 | UI 是否可编辑 | 否；通过自然语言让 Agent 重写 |

## 八、完成后的自检

- [x] 所有职责都有可执行用例。
- [x] 更新、读取、恢复、UI 生命周期和 transcript 均覆盖。
- [x] 多 session、失败事务和空数组语义没有歧义。
