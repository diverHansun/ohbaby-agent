# SessionDialog — interaction subject='session' 的选择 renderer

## 一、职责

SessionDialog 渲染 `UiInteractionRequest` 中 `kind='select-one'` 且 `subject='session'` 的请求，供用户切换到其他会话或选择新建会话。

它不是顶层 dialog type，而是 **interaction source 下的 subject renderer**。

---

## 二、输入数据

```typescript
interface SessionDialogProps {
  request: UiInteractionRequest
  onRespond: (response: UiInteractionResponse) => void
  onCancel: () => void
}
```

要求：
- `request.kind === 'select-one'`
- `request.subject === 'session'`
- `request.options` 包含会话项以及可选的 "new session" 项

---

## 三、视觉结构

- 标题：优先使用 `request.prompt`；没有时回退为 `Select Session`。
- 列表项：来自 `request.options`。
- 当前会话标记：若 options 文本中包含当前状态说明可直接显示。

SessionDialog 不从 TuiStore.sessions 自行拼装交互列表；交互选项应由 backend 在 `interaction.requested` 的 options 中准备好。

---

## 四、交互设计

| 按键 | 行为 |
|---|---|
| Up / Down | 在会话列表间移动焦点 |
| Enter | 选中当前焦点项，调用 `onRespond({ kind: 'accepted', choiceId })` |
| Esc | 取消选择，调用 `onCancel()` |

列表可以使用 shared/ScrollableList 组件。

---

## 五、响应值

```typescript
onRespond({ kind: 'accepted', choiceId: selectedOptionId })
```

`choiceId` 可能代表已有 sessionId，也可能代表 backend 约定的 "new session" 选项。具体语义由 backend 解释。

---

## 六、触发方式说明

SessionDialog 的打开时机由 backend 决定：当用户执行 `/session` 或其他需要切换会话的命令时，backend 发布 `interaction.requested { kind: 'select-one', subject: 'session' }`，TUI 才渲染本组件。

TUI 不本地决定 `/session` Enter 是否打开 selector。

---

## 七、设计约束

1. **不直接操作会话**：只返回 `choiceId`，由 backend 恢复命令后执行切换或新建。
2. **选项完全来自 `request.options`**：不从 session service 或旧 SessionContext 直接查询。
3. **属于 interaction renderer**：不作为顶层 dialog source 出现。

---

## 八、文档自检

- [x] 已重定位为 interaction subject renderer。
- [x] 数据来源从 session 模块查询改为 `request.options`。
- [x] 响应值改为 SDK `UiInteractionResponse`。
- [x] 已明确 TUI 不本地决定打开时机。
