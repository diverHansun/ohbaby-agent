# Dialogs — 弹窗组件概述

本文档描述 TUI 弹窗系统的分层结构与统一交互规则。

---

## 一、定位

弹窗组件提供模态交互界面，在用户响应之前冻结 Prompt 输入。弹窗采用**队列管理模式**，由 DialogManager 统一调度：多个请求按优先级排队，同一时刻只显示一个。

对应职责追溯：goals-duty.md D5（DialogManager）。

---

## 二、两层分类

### 2.1 顶层来源（source）

DialogManager 只识别两种顶层来源：

| source | 文档 | 优先级 | 来源 |
|---|---|---|---|
| `permission` | [permission-dialog.md](./permission-dialog.md) | high | SDK `permission.requested` |
| `interaction` | [dialog-manager.md](./dialog-manager.md) | normal | SDK `interaction.requested` |

### 2.2 interaction 内部的 renderer

`interaction` 来源的请求再按 `kind + subject` 派发到具体 renderer：

| renderer | 文档 | 适用条件 |
|---|---|---|
| ModelDialog | [model-dialog.md](./model-dialog.md) | `kind='select-one'` 且 `subject='model'` |
| SessionDialog | [session-dialog.md](./session-dialog.md) | `kind='select-one'` 且 `subject='session'` |
| ConfirmDialog | [confirm-dialog.md](./confirm-dialog.md) | `kind='confirm'` 的通用确认 |
| GenericSelect / TextInput Dialog | 未来可补 | 其他 `kind + subject` 组合 |

ModelDialog 和 SessionDialog 不再是顶层 dialog type，而是 **interaction subject renderer**。

---

## 三、统一交互规范

所有弹窗遵循统一的键盘交互规范：

| 按键 | 行为 |
|---|---|
| Up / Down | 在选项间移动焦点 |
| Enter | 确认当前焦点项 |
| Esc | 取消并关闭弹窗 |

PermissionDialog 的 suggest 输入模式是唯一例外：Esc 在输入模式下先退回选择模式，不直接关闭弹窗。

---

## 四、Prompt 冻结

弹窗显示期间，Prompt 组件停止响应输入：

- `AppStateContext.dialog.current !== null` 时，Prompt 进入冻结状态。
- 弹窗组件通过 `useKeypress` 独立监听键盘事件。
- 弹窗关闭后，Prompt 自动恢复。

---

## 五、回调模式

DialogRequest 由 usePermission / useInteraction 创建，携带回调：

```typescript
interface DialogRequest {
  id: string
  source: 'permission' | 'interaction'
  request: UiPermissionRequest | UiInteractionRequest
  priority: 'high' | 'normal'
  onRespond?: (result: unknown) => void
  onCancel?: () => void
}
```

弹窗组件是纯 UI renderer，不直接调用 backend 模块。它们只负责调用回调，将结果回传给创建请求的 hook。

---

## 六、渲染位置

弹窗在 DefaultLayout 内部渲染，位于 Prompt 正上方（与 LoadingIndicator 同一区域）。

- 有弹窗时：显示弹窗，隐藏 LoadingIndicator。
- 无弹窗时：正常显示 LoadingIndicator（如果 loading.isLoading）。

---

## 七、文档自检

- [x] 顶层来源只保留 permission 和 interaction。
- [x] ModelDialog/SessionDialog 已重定位为 interaction subject renderer。
- [x] Prompt 冻结和回调模式清晰。
- [x] 渲染位置和优先级已明确。
