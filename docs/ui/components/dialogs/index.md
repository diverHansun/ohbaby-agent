# Dialogs 弹窗组件概述

## 一、定位

弹窗组件提供模态交互界面，在用户响应之前冻结 Prompt 输入。弹窗采用**队列管理模式**，由 DialogManager 统一调度：多个弹窗请求按优先级排队，同一时刻只显示一个。

对应职责追溯：goals-duty.md D7（弹窗管理）、G5（组件化与性能）。

## 二、弹窗类型

| 弹窗 | 文档 | 类型 | 优先级 | 触发来源 |
|------|------|------|--------|---------|
| PermissionDialog | [permission-dialog.md](./permission-dialog.md) | 确认 | high | permission 模块（Bus 事件） |
| ModelDialog | [model-dialog.md](./model-dialog.md) | 选择 | normal | /model 命令 |
| SessionDialog | [session-dialog.md](./session-dialog.md) | 选择 | normal | /session 命令 |
| ConfirmDialog | [confirm-dialog.md](./confirm-dialog.md) | 确认 | normal | 各类需要确认的操作 |

管理器文档：[dialog-manager.md](./dialog-manager.md)

## 三、统一交互模式

所有弹窗（除 PermissionDialog 的 suggest 输入模式外）遵循统一的键盘交互规范：

| 按键 | 行为 |
|------|------|
| Up / Down | 在选项间移动焦点 |
| Enter | 确认当前焦点选项 |
| Esc | 取消并关闭弹窗 |

不使用字母键（如 y/n/a）进行选项选择，统一使用方向键导航。

## 四、弹窗与 Prompt 的焦点隔离

弹窗显示期间，Prompt 组件停止响应输入：

- 焦点隔离通过 Context 标记实现：`AppStateContext.dialog.current !== null` 时，Prompt 进入冻结状态
- 弹窗组件通过 `useKeypress` 独立监听键盘事件
- 弹窗关闭后（`dialog.current` 变为 null），Prompt 自动恢复

这种方式不需要显式的 focus/blur 管理，只需读取状态标记。

## 五、弹窗渲染位置

弹窗在 DefaultLayout 内部渲染，位于 Prompt 正上方（与 LoadingIndicator 同一区域）。渲染优先级：

- 有弹窗时：显示弹窗，隐藏 LoadingIndicator
- 无弹窗时：正常显示 LoadingIndicator（如果 loading.isActive）

## 六、回调模式

弹窗的响应结果通过 `DialogRequest` 上携带的回调函数传递：

```typescript
interface DialogRequest {
  id: string
  type: DialogType
  data: DialogData
  priority: DialogPriority
  onRespond?: (result: unknown) => void    // 用户确认
  onCancel?: () => void                     // 用户取消
}
```

弹窗组件是纯 UI 组件，不直接调用业务模块（如 Permission.respond()）。回调由请求方（如 usePermission hook）在创建 DialogRequest 时提供，弹窗组件只负责调用回调、传递用户选择。

## 七、视觉基础结构

所有弹窗共享基础视觉框架（由 Dialog 基础组件提供）：

```
+-- Title -------------------------+
|                                  |
|         Content Area             |
|                                  |
+----------------------------------+
|  > Option 1                      |
|    Option 2                      |
|    Option 3                      |
+----------------------------------+
```

- Title：弹窗标题，加粗显示
- Content Area：弹窗主体内容（描述、列表等）
- Options：选项列表，`>` 标记当前焦点项

## 八、文档自检

- [x] 弹窗类型完整（Permission、Model、Session、Confirm）
- [x] 队列管理模式已说明
- [x] 统一交互规范已定义（Up/Down + Enter + Esc）
- [x] 焦点隔离机制已描述（Context 标记法）
- [x] 回调模式已说明（DialogRequest 携带回调）
- [x] 渲染位置和优先级已明确
