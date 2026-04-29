# PermissionDialog — 权限确认弹窗

## 一、职责

PermissionDialog 渲染 SDK `UiPermissionRequest`，收集用户的授权决策。它是顶层 `source='permission'` 的唯一 renderer，优先级为 high。

对应职责追溯：goals-duty.md D5（DialogManager）、N4（权限决策由 backend 负责，UI 只收集响应）。

---

## 二、输入数据

```typescript
interface PermissionDialogProps {
  request: UiPermissionRequest
  onRespond: (response: UiPermissionResponse) => void
  onCancel: () => void
}
```

`request` 由 `usePermission` 从 TuiStore.permissions 取出并入队，DialogManager 分发给本组件。

---

## 三、视觉结构

- 标题：使用 `request.title`。
- 描述：使用 `request.description`。
- 选项：来自 `request.choices`，按顺序渲染。

每个选项至少显示：
- `label`
- 可选的说明文本（若后续 SDK choices 扩展 description 字段）

---

## 四、交互设计

| 按键 | 行为 |
|---|---|
| Up / Down | 在 choices 间移动焦点 |
| Enter | 选择当前焦点项，调用 `onRespond({ choiceId })` |
| Esc | 调用 `onCancel()` |

Esc 的语义由 usePermission 决定：通常映射为 deny 选项。

---

## 五、响应值

本组件不定义权限语义，只返回 SDK 响应：

```typescript
interface UiPermissionResponse {
  choiceId: string
  remember?: boolean
}
```

具体 `choiceId` 对应 allow/deny/remember 哪种行为，由 backend 提供的 `request.choices` 决定。

---

## 六、设计约束

1. **不做权限判断**：只收集用户选择。
2. **不直接调用 backend**：通过 `onRespond` / `onCancel` 回调。
3. **选项完全由 SDK request 提供**：不在 UI 层硬编码 allow/deny/always 文本。
4. **属于顶层 permission 来源**：不走 interaction.kind + subject 分发。

---

## 七、文档自检

- [x] 输入数据已对齐 SDK `UiPermissionRequest`。
- [x] 响应值已对齐 SDK `UiPermissionResponse`。
- [x] 不再直接引用 permission 模块或 backend Bus。
- [x] 选项来源改为 `request.choices`。
