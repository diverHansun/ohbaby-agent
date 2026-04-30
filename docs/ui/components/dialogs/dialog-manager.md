# DialogManager — 弹窗队列管理器

## 一、职责

DialogManager 是弹窗系统的中枢组件，负责管理弹窗队列、调度显示顺序，并按 `source` / `kind + subject` 分发到具体 renderer。

它读取 `AppStateContext.dialog` 获取当前弹窗状态，通过 `AppActionsContext.closeCurrentDialog` 推进队列。

---

## 二、队列管理

### 2.1 入队

弹窗请求通过 `AppActionsContext.enqueueDialog()` 加入队列。队列按优先级排序：

| 优先级 | 行为 |
|---|---|
| high | 插入到队列最前面（但不打断当前显示的弹窗） |
| normal | 追加到队列末尾 |

通常：permission = high，interaction = normal。

### 2.2 出队

用户响应或取消后，DialogManager 调用 `closeCurrentDialog()`：

1. 执行当前弹窗的 `onRespond` 或 `onCancel` 回调。
2. 从队列中取出下一个弹窗设为 `current`。
3. 如果队列为空，`current` 设为 null。

---

## 三、两层分发

### 3.1 顶层分发：按 source

| source | 分发目标 |
|---|---|
| `permission` | PermissionDialog |
| `interaction` | 进入第二层分发 |

### 3.2 第二层分发：按 kind + subject

当 `current.source === 'interaction'` 时：

| kind | subject | renderer | primitive |
|---|---|---|---|
| `select-one` | `model` | ModelDialog | SelectableList |
| `select-one` | `session` | SessionDialog | SelectableList |
| `confirm` | 任意 | ConfirmDialog | 独立小组件 |
| 其他 | 任意 | Generic fallback（未来补充） | — |

示例：

```tsx
if (current.source === 'permission') {
  return <PermissionDialog request={current.request} ... />
}

if (current.source === 'interaction') {
  const req = current.request

  if (req.kind === 'select-one' && req.subject === 'model') {
    return <ModelDialog request={req} ... />
  }

  if (req.kind === 'select-one' && req.subject === 'session') {
    return <SessionDialog request={req} ... />
  }

  if (req.kind === 'confirm') {
    return <ConfirmDialog request={req} ... />
  }

  return <GenericInteractionDialog request={req} ... />
}
```

---

## 四、回调转发

DialogManager 在分发时封装回调逻辑：

1. 弹窗组件调用 `onRespond(result)` 或 `onCancel()`。
2. DialogManager 执行 `current.onRespond(result)` 或 `current.onCancel()`。
3. 然后调用 `closeCurrentDialog()` 推进队列。

弹窗组件不需要知道队列的存在，只需调用回调。

---

## 五、渲染位置

DialogManager 在 DefaultLayout 内部渲染，与 LoadingIndicator 共享同一区域（Prompt 正上方）。

```text
if (dialog.current !== null) {
  // 渲染弹窗，LoadingIndicator 被条件隐藏
  return <对应弹窗组件 />
}

return null
```

---

## 六、Context 依赖

| Context | 读取字段 | 用途 |
|---|---|---|
| AppStateContext | `dialog.current`, `dialog.queue` | 获取当前弹窗和队列 |
| AppActionsContext | `closeCurrentDialog` | 推进队列 |

---

## 七、设计约束

1. **不包含业务逻辑**：DialogManager 只做队列管理和类型分发，不直接调用 `client.respond*()`。
2. **单弹窗原则**：同一时刻最多显示一个弹窗。
3. **不打断当前弹窗**：高优先级弹窗插队到队列前面，但不打断当前显示。
4. **弹窗组件无队列感知**：具体 renderer 不知道队列的存在。
5. **renderer 不等于来源**：ModelDialog/SessionDialog 是 interaction renderer，不是顶层来源。
6. **B' 原则由 renderer 执行，不由 DialogManager 执行**：DialogManager 不关心 request.options 与本地数据的组合，这是各 renderer 自己的职责，参见 [dialogs/index.md §一·五](./index.md)。

---

## 八、文档自检

- [x] 队列管理流程完整。
- [x] 顶层 source 分发和第二层 kind+subject 分发已定义。
- [x] 回调转发机制已说明。
- [x] 渲染位置和与 LoadingIndicator 的关系明确。
- [x] 设计约束反映了新交互模型。
