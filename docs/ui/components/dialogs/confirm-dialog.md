# ConfirmDialog 通用确认弹窗

## 一、职责

ConfirmDialog 用于需要用户确认的通用操作场景，提供简单的二选一（确认/取消）交互。它是最简单的弹窗类型，优先级为 normal。

## 二、视觉结构

```
+-- Clear Session? ---------------------+
|                                       |
|  This will clear all messages in      |
|  the current session.                 |
|                                       |
+---------------------------------------+
|  > Confirm                            |    ← 焦点项
|    Cancel                             |
+---------------------------------------+
```

### 信息展示

- **标题**：由 `data.title` 提供
- **消息**：由 `data.message` 提供，支持多行文本
- **选项**：两个固定选项，文本可自定义

## 三、交互设计

| 按键 | 行为 |
|------|------|
| Up / Down | 在确认和取消之间切换焦点 |
| Enter | 确认当前焦点选项 |
| Esc | 等同于选择取消 |

## 四、数据输入

```typescript
interface ConfirmDialogData {
  type: 'confirm'
  title: string                  // 弹窗标题
  message: string                // 描述信息
  confirmText?: string           // 确认按钮文本，默认 "Confirm"
  cancelText?: string            // 取消按钮文本，默认 "Cancel"
}
```

## 五、响应值

```typescript
// onRespond 的参数
interface ConfirmDialogResult {
  confirmed: boolean             // true = 确认, false = 取消
}
```

选择确认选项或按 Enter 时：`onRespond({ confirmed: true })`
选择取消选项或按 Esc 时：`onRespond({ confirmed: false })`

## 六、使用场景

| 场景 | title | message |
|------|-------|---------|
| 清空会话 | "Clear Session?" | "This will clear all messages..." |
| 退出确认 | "Exit?" | "Are you sure you want to exit?" |

## 七、设计约束

1. **固定两个选项**：不支持自定义选项数量
2. **默认焦点在确认**：打开时focusIndex = 0（Confirm）
3. **文本可自定义**：确认/取消按钮文本可通过 Props 自定义
4. **无 ScrollableList**：只有两个选项，不需要滚动

## 八、文档自检

- [x] 视觉结构已定义
- [x] 交互规则符合统一规范（Up/Down + Enter + Esc）
- [x] 数据类型和响应值已定义
- [x] 使用场景已列举
- [x] 与 data-model.md 中的 ConfirmDialogData 类型一致
