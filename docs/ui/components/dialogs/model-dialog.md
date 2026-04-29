# ModelDialog — interaction subject='model' 的选择 renderer

## 一、职责

ModelDialog 渲染 `UiInteractionRequest` 中 `kind='select-one'` 且 `subject='model'` 的请求，供用户选择目标模型。

它不是顶层 dialog type，而是 **interaction source 下的 subject renderer**。

---

## 二、输入数据

```typescript
interface ModelDialogProps {
  request: UiInteractionRequest
  onRespond: (response: UiInteractionResponse) => void
  onCancel: () => void
}
```

要求：
- `request.kind === 'select-one'`
- `request.subject === 'model'`
- `request.options` 包含可选模型项

---

## 三、视觉结构

- 标题：优先使用 `request.prompt`；没有时回退为 `Select Model`。
- 列表项：来自 `request.options`。
- 当前模型标记：若 options 文本中包含当前状态说明可直接显示；若后续 SDK 为 option 增加 `current` 元数据，可用 `(current)` 标记。

ModelDialog 不从 runtime 直接拉取模型列表或当前模型信息；这些都应由 backend 在 `interaction.requested` 的 options 中准备好。

---

## 四、交互设计

| 按键 | 行为 |
|---|---|
| Up / Down | 在模型列表间移动焦点 |
| Enter | 选中当前焦点模型，调用 `onRespond({ kind: 'accepted', choiceId })` |
| Esc | 取消选择，调用 `onCancel()` |

列表可以使用 shared/ScrollableList 组件，当选项过多时支持滚动。

---

## 五、响应值

```typescript
onRespond({ kind: 'accepted', choiceId: selectedOptionId })
```

具体 option id 到 provider/model 的映射由 backend 解释，UI 只回传 choiceId。

---

## 六、触发方式说明

ModelDialog 的打开时机由 backend 决定：当用户执行 `/model` 或其他需要模型选择的命令时，backend 发布 `interaction.requested { kind: 'select-one', subject: 'model' }`，TUI 才渲染本组件。

TUI 不本地决定 `/model` Enter 是否打开 selector。

---

## 七、设计约束

1. **不直接切换模型**：只返回 `choiceId`，由 backend 恢复命令后执行切换。
2. **列表数据完全来自 `request.options`**：不查询 provider/runtime。
3. **属于 interaction renderer**：不作为顶层 dialog source 出现。

---

## 八、文档自检

- [x] 已重定位为 interaction subject renderer。
- [x] 数据来源从 backend 列表查询改为 `request.options`。
- [x] 响应值改为 SDK `UiInteractionResponse`。
- [x] 已明确 TUI 不本地决定打开时机。
