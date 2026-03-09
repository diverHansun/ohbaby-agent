# DialogManager 弹窗队列管理器

## 一、职责

DialogManager 是弹窗系统的中枢组件，负责管理弹窗队列、调度弹窗的显示顺序、按类型分发到具体的弹窗组件。它读取 `AppStateContext.dialog` 获取当前弹窗状态，通过 `AppActionsContext.closeCurrentDialog` 推进队列。

对应职责追溯：goals-duty.md D7（弹窗管理）。

## 二、队列管理

### 2.1 入队

弹窗请求通过 `AppActionsContext.enqueueDialog()` 加入队列。队列按优先级排序：

| 优先级 | 行为 |
|--------|------|
| high | 插入到队列最前面（但不打断当前显示的弹窗） |
| normal | 追加到队列末尾 |
| low | 追加到队列末尾 |

### 2.2 出队

用户响应或取消后，DialogManager 调用 `closeCurrentDialog()`：

1. 执行当前弹窗的 `onRespond` 或 `onCancel` 回调
2. 从队列中取出下一个弹窗设为 `current`
3. 如果队列为空，`current` 设为 null

### 2.3 状态流转

```
queue: [], current: null         ← 空闲，不渲染
         |
    enqueueDialog(request)
         |
queue: [], current: request      ← 显示弹窗
         |
    用户响应 / 取消
         |
    closeCurrentDialog()
         |
queue: [next], current: next     ← 显示下一个
  或 queue: [], current: null     ← 回到空闲
```

## 三、类型分发

DialogManager 根据 `current.type` 将弹窗分发到具体组件：

| type | 组件 | 说明 |
|------|------|------|
| `permission` | PermissionDialog | 权限确认弹窗 |
| `model` | ModelDialog | 模型选择弹窗 |
| `session` | SessionDialog | 会话选择弹窗 |
| `confirm` | ConfirmDialog | 通用确认弹窗 |

DialogManager 将 `current.data` 作为 Props 传入具体弹窗组件，同时传入 `onRespond` 和 `onCancel` 回调。

## 四、回调转发

DialogManager 在分发时封装回调逻辑：

1. 弹窗组件调用 `onRespond(result)` 或 `onCancel()`
2. DialogManager 执行 `current.onRespond(result)` 或 `current.onCancel()`
3. 然后调用 `closeCurrentDialog()` 推进队列

弹窗组件不需要知道队列的存在，只需调用回调即可。

## 五、渲染位置

DialogManager 在 DefaultLayout 内部渲染，与 LoadingIndicator 共享同一区域（Prompt 正上方）。渲染逻辑：

```
if (dialog.current !== null) {
  // 渲染弹窗，LoadingIndicator 被条件隐藏
  return <对应弹窗组件 />
}
// 否则 DialogManager 返回 null，LoadingIndicator 正常显示
```

## 六、Context 依赖

| Context | 读取字段 | 用途 |
|---------|---------|------|
| AppStateContext | `dialog.current`, `dialog.queue` | 获取当前弹窗和队列 |
| AppActionsContext | `closeCurrentDialog` | 推进队列 |

## 七、设计约束

1. **不包含弹窗 UI**：DialogManager 只做队列管理和类型分发，不渲染弹窗 UI
2. **单弹窗原则**：同一时刻最多显示一个弹窗
3. **不打断当前弹窗**：高优先级弹窗插队到队列前面，但等待当前弹窗关闭后再显示
4. **弹窗组件无队列感知**：具体弹窗组件不知道队列的存在

## 八、文档自检

- [x] 队列管理流程完整（入队、出队、状态流转）
- [x] 高优先级插队规则已说明
- [x] 类型分发规则已定义（4 种弹窗类型）
- [x] 回调转发机制已说明
- [x] 渲染位置和与 LoadingIndicator 的关系已明确
- [x] Context 依赖已列出
