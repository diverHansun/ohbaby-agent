# todo-list 模块 data-model.md

本文档定义 `todo-list` 的领域事实、运行时状态和 UI 投影。

**前置文档**：`goals-duty.md`、`architecture.md`

## 一、领域模型

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export type TodoList = readonly TodoItem[];
```

### TodoStatus

| 值 | 含义 |
|----|------|
| `pending` | 尚未开始 |
| `in_progress` | 正在处理；同一列表可有多个 |
| `completed` | 已完成 |

### TodoItem 约束

| 字段 | 约束 |
|------|------|
| `content` | trim 后非空，最多 100 个 Unicode 字符 |
| `status` | 仅三种枚举值 |

不定义 `id`、`priority`、`cancelled` 或其他元数据。数组位置表达执行顺序和隐式优先级。

### TodoList 约束

- 0–10 项。
- 是某个 session/context scope 的完整当前值。
- 写入时整体替换，不允许部分成功。
- 对外读取和事件传输均使用不可变副本。

## 二、运行时状态

```ts
type SessionTodoState =
  | { readonly kind: "unloaded" }
  | { readonly kind: "loaded"; readonly todos: TodoList };
```

`unloaded` 与 `loaded + []` 语义不同：

- unloaded 可触发一次历史恢复；
- loaded + [] 可能来自成功清空，不能重新恢复旧列表。

该状态按现有 `scopedSessionKey(sessionId, contextScopeId)` 保存。二者属于运行时上下文，不进入 TodoItem；主 context 的 `contextScopeId` 为空。

## 三、UI 投影模型

建议由 `ohbaby-sdk` 共享：

```ts
export interface UiTodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export interface UiSessionTodoList {
  readonly sessionId: string;
  readonly todos: readonly UiTodoItem[];
  readonly visible: boolean;
}
```

- `todos` 是领域列表的完整副本。
- `visible` 是 run 生命周期派生的展示投影，不是 Agent 可写状态，也不用于历史恢复。
- `UiSnapshot.todos?: readonly UiSessionTodoList[]` 缺失时按空列表处理，兼容旧 snapshot。
- `todo.updated` 直接携带一个 session 的 `sessionId/todos/visible` 完整替换值。

UI 可自行派生完成数量、溢出数量和紧凑选择，不把这些冗余值写入协议。

## 四、生命周期

### 创建/更新

首次成功 `todo_write` 或历史恢复使对应 session/context scope 进入 loaded。每次成功变更整体替换数组。

### 清空

`todo_write([])` 将状态设置为 loaded + [] 并使 UI 投影隐藏。

### run 结束

只把 UI 投影 `visible` 设为 false，不删除 TodoList。

### 新 run/resume

恢复列表后，存在 `pending` 或 `in_progress` 才重新设为可见；全 completed 历史保持隐藏。

### session 销毁

runtime 可释放对应内存投影；持久消息生命周期仍由 session/message 模块管理。

## 五、所有权

| 数据 | 所有者 |
|------|--------|
| Todo 内容、状态、数组顺序 | Agent，通过 `todo_write` 完整提交 |
| 当前 loaded 状态和数组副本 | TodoService |
| 成功工具事务 | session/message 系统 |
| UI `visible` 投影 | 后端 UI projection |
| TUI 展开/收起 | 当前 TUI 客户端内存 |
| Web 滚动位置 | 当前 Web 客户端/浏览器 |

## 六、完成后的自检

- [x] 领域事实只有 content/status 和数组顺序。
- [x] loaded 空列表不会与未恢复混淆。
- [x] UI 生命周期字段没有污染 Agent 工具契约。
- [x] 所有派生计数和客户端交互态均未持久化。
