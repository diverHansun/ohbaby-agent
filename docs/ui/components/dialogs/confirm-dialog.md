# ConfirmDialog — interaction kind='confirm' 的通用 renderer

## 一、职责

ConfirmDialog 渲染 `UiInteractionRequest` 中 `kind='confirm'` 的通用确认请求，提供简单的二选一（确认/取消）交互。

它不是顶层 dialog type，而是 **interaction source 下的 kind renderer**。

---

## 二、输入数据

```typescript
interface ConfirmDialogProps {
  request: UiInteractionRequest
  onRespond: (response: UiInteractionResponse) => void
  onCancel: () => void
}
```

要求：
- `request.kind === 'confirm'`
- `request.prompt` 作为标题或主体说明

如果 backend 未来为 confirm 提供标准化的确认/取消按钮文案，可通过 `request.options` 承载；否则本组件使用默认文本 `Confirm` / `Cancel`。

---

## 三、视觉结构

- 标题：若 `request.subject` 存在，可作为语义标题；否则回退为 `Confirm`。
- 消息：使用 `request.prompt`。
- 选项：两个固定选项（Confirm / Cancel），除非 `request.options` 明确提供替代文本。

---

## 四、交互设计

| 按键 | 行为 |
|---|---|
| Up / Down | 在确认和取消之间切换焦点 |
| Enter | 选择当前焦点项 |
| Esc | 调用 `onCancel()` |

确认时调用：

```typescript
onRespond({ kind: 'accepted', choiceId: 'confirm' })
```

如果 backend 提供了显式 option id，则使用该 option id。

---

## 五、设计约束

1. **不直接执行操作**：只回传确认结果，由 backend 恢复命令后决定后续动作。
2. **属于 interaction renderer**：不作为顶层 dialog source 出现。
3. **默认文本可回退**：当 request 未提供细化选项时，使用内置 Confirm/Cancel 文本。

---

## 六、文档自检

- [x] 已重定位为 interaction kind renderer。
- [x] 输入数据改为 SDK `UiInteractionRequest`。
- [x] 响应值改为 SDK `UiInteractionResponse`。
- [x] 不再直接引用旧 `ConfirmDialogData` 类型。
