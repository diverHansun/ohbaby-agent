# todo-list 模块 dfd-interface.md

本文档描述 `todo-list` 与 ToolScheduler、session/message、UI runtime、Web/TUI 的数据流和接口契约。

**前置文档**：`goals-duty.md`、`architecture.md`、`data-model.md`

## 一、上下文与边界

```text
Agent <-> ToolScheduler <-> todo_read / todo_write <-> TodoService
                                                        ^       |
                                                        |       v
                                              session history  UI projection
                                                                  |
                                                     UiSnapshot + todo.updated
                                                                  |
                                                           Web / TUI
```

Web/TUI 不直接访问 TodoService 或 session history。

## 二、工具接口

### `todo_write`

**分类**：ToolScheduler 中为 write，保证与同 session 的写波次串行；权限层视为 session 内部状态更新并默认放行，不弹出外部写权限确认。

**参数**：

```ts
{
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

约束：数组最多 10 项；content trim 后非空且最多 100 个 Unicode 字符；对象不接受额外字段。

**行为**：

1. 完整校验输入。
2. 原子替换 runtime 为当前调用解析出的 `sessionId + contextScopeId? + internal workScopeId?` 列表；公开参数不接受 scope。
3. `[]` 表示显式清空。
4. 相同列表可返回成功但不发布重复更新事件。

**输出**：Agent 可读的当前列表，以及供内部调用方使用的结构化 `count/todos/internalWorkScopeId?` metadata。内部 scope 不进入工具参数或 UI payload；输出不进入正常 UI transcript。

### `todo_read`

**分类**：readonly。

**参数**：空对象，不接受额外字段。

**行为**：返回 runtime 为当前调用解析出的完整列表；若尚未加载，先执行一次 scope-aware 懒恢复；不改变列表，不发布 `todo.updated`。

**输出**：Agent 可读列表和结构化 `count/todos` metadata，同样不进入正常 UI transcript。

## 三、TodoService 内部接口语义

### `read(sessionId, contextScopeId?, workScopeId?)`

- 返回防御性副本。
- unloaded 时可调用注入的 history recovery port，完成后转为 loaded。

### `replace(sessionId, todos, contextScopeId?, workScopeId?)`

- 调用者必须传入已验证完整数组，服务仍保持不可变复制边界。
- 返回 `{ todos, todosChanged }` 或等价结果。
- UI projection 同时比较列表和 `visible`；只有完整投影不变时才不重复发事件。

### `recover(sessionId, contextScopeId?, workScopeId?, messages)`

- 从后向前检查 `todo_write`。
- 必须同时存在匹配 callId 的成功完成 result。
- result metadata 的 `internalWorkScopeId` 必须与目标 workload scope 一致；缺少 metadata 只匹配 ordinary。
- 失败、拒绝、取消、pending/running 或损坏参数均跳过。
- 命中第一个有效候选即停止；有效 `[]` 也停止。
- 无候选或无法读取历史时降级为 loaded + []，恢复错误写 warning，但不使 resume 失败。

### `release(sessionId)`

session 真正从 runtime 释放时清理该 session 的主 context 与全部子 context 内存状态。不得因一次 run 结束而释放或清空。

### `releaseScope(sessionId, contextScopeId)`

子 Agent context 关闭时只清理该 scope 的内存状态，不影响同一 child session 的其他 context。

## 四、UI 契约

### Snapshot

```ts
interface UiSnapshot {
  // existing fields...
  readonly todos?: readonly UiSessionTodoList[];
}
```

旧客户端/旧 snapshot 缺少该字段时等价于无 Todo。数组按 sessionId 表达投影，不嵌入消息记录。

### Event

```ts
interface UiTodoUpdatedEvent {
  readonly type: "todo.updated";
  readonly sessionId: string;
  readonly todos: readonly UiTodoItem[];
  readonly visible: boolean;
  readonly timestamp?: number;
}
```

事件是完整替换而不是 patch。只有主 context 写入才形成 UI 投影；子 Agent context 写入不发布 `todo.updated`，也不进入 `UiSnapshot.todos`。客户端只替换匹配 sessionId 的主投影；列表相同但可见性变化仍属于有效更新。事件断线后使用新 snapshot 覆盖本地结果。

### 可见性转换

| 触发 | todos | visible |
|------|-------|---------|
| 当前 run 成功写入非空数组 | 新列表 | true |
| 当前 run 写入空数组 | [] | false |
| 当前 run 将全部项目标为 completed | 全 completed | true，保持到 run 结束 |
| run 结束 | 保留 | false |
| 新 run 开始且有未完成项 | 保留 | true |
| 新 run 开始且全 completed/空 | 保留 | false |

Goal 模式覆盖上表的 run-end 规则：active Goal 的同一 workload scope 在相邻 continuation 间不隐藏，非空列表（含全 completed）保持可见供 complete 前对账；pause/cancel/complete 或 identity 切换时才切走。UI 仍只看到每个 session 的单一当前投影，事件不携带 `goalId`/scope。

## 五、Transcript 数据流

核心 message history 继续保存 Todo tool call/result，用于 Agent 语义和恢复。向 `UiMessagePart` 投影或客户端渲染时过滤 `todo_read`、`todo_write`：

```text
core message history ──> recovery adapter (可见)
                    └──> UI message projection (过滤) ──> transcript
TodoService ────────────────────────────────────────────> TodoDock/Panel
```

失败结果也只返回 Agent/诊断，不生成正常 transcript 项。过滤不得影响其他工具。

## 六、数据所有权与责任

| 数据/动作 | 责任方 |
|-----------|--------|
| 生成工具调用 | Agent/runtime |
| 参数校验与输出 | Todo tool facade |
| session 当前列表与 loaded 状态 | TodoService |
| 成功事务持久记录 | session/message |
| snapshot、event、visible | UI projection/runtime |
| active main session 选择 | Web/TUI selector |
| Web 滚动、TUI Ctrl+T 展开 | 各客户端本地状态 |

## 七、完成后的自检

- [x] 双工具输入、输出、副作用和错误边界完整。
- [x] 恢复只接受最后一次成功完成写入。
- [x] snapshot/event 与 transcript 分流明确。
- [x] 所有客户端行为均可由正式 UI 契约驱动。
