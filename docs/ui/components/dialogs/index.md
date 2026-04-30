# Dialogs — 弹窗组件概述

本文档描述 TUI 弹窗系统的分层结构与统一交互规则。

---

## 一、定位

弹窗组件提供模态交互界面，在用户响应之前冻结 Prompt 输入。弹窗采用**队列管理模式**，由 DialogManager 统一调度：多个请求按优先级排队，同一时刻只显示一个。

对应职责追溯：goals-duty.md D5（DialogManager）、G4（Semantic Interaction）、G5（Surface-Owned Rendering）。

---

## 一·五、核心设计原则（B' — 受约束的混合模式）

> **interaction.requested 定义本次交互的授权边界和可响应 choice；UI 可以用 TuiStore 与 LocalUiMemory 增强展示，但最终 choice 必须落在 backend 允许的集合内。**

落到三条可执行准则，所有 dialog renderer 都必须遵守：

1. **触发权属于 backend**——何时打开 dialog、是否允许打开，由 SDK `permission.requested` / `interaction.requested` 决定。TUI 不本地决定开弹窗时机。
2. **可响应 choice 属于 backend**——`request.options`（或 `request.choices`）是**权威候选集合**，UI 不得通过任何手段扩大集合。LocalUiMemory 中存在但不在 `request.options` 的 id 必须**静默丢弃**。
3. **呈现属于 UI**——搜索、分组、排序、recent 标记、当前项标识、滚动、tone 着色等纯视觉/交互行为由 UI 自由决定，不需要 backend 配合。

这条原则与 [goals-duty.md](../../goals-duty.md) 的 G4/G5/N1/N2 一致：UI 不执行业务逻辑、不维护 catalog 真相，只做投影、增强呈现、回传 choiceId。

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

| renderer | 文档 | 适用条件 | 复用 primitive |
|---|---|---|---|
| ModelDialog | [model-dialog.md](./model-dialog.md) | `kind='select-one'` 且 `subject='model'` | [SelectableList](../shared/selectable-list.md) |
| SessionDialog | [session-dialog.md](./session-dialog.md) | `kind='select-one'` 且 `subject='session'` | [SelectableList](../shared/selectable-list.md) |
| ConfirmDialog | [confirm-dialog.md](./confirm-dialog.md) | `kind='confirm'` 的通用确认 | 独立小组件 |
| GenericSelect / TextInput Dialog | 未来可补 | 其他 `kind + subject` 组合 | 视情况复用 |

ModelDialog 和 SessionDialog 不再是顶层 dialog type，而是 **interaction subject renderer**。它们共享同一个呈现 primitive `SelectableList`，差异只在数据组织和 onSelect 后的副作用。

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

## 五·五、数据来源与呈现增强

按 §一·五 的 B' 原则，所有 select-one 类 dialog 在准备 SelectableList 的 `options` 时遵循同一套组装流程：

```text
权威候选集合 = request.options           ← 不可扩大、不可覆盖
            │
            ▼
呈现增强  := TuiStore selector  (例：useSessionSummaries、useActiveSessionId、useRuntime model identity)
         +  LocalUiMemory       (例：getRecentSessions、getRecentModels)
            │
            ▼
最终 SelectableListOption[]
   - id          来自 request.options[i].id（权威）
   - title       优先 request 的 label，必要时由 TuiStore 增强
   - category    UI 自定义分组（Recent / By-Provider / Today / ...）
   - footer      由 TuiStore 数据填充（更新时间、provider 名等）
   - gutter      状态指示（spinner / current 标记）
   - currentId   来自 TuiStore（如 activeSessionId 或 runtime model identity 匹配出的 option id）
```

**写入 LocalUiMemory** 仅发生在 accepted 路径：renderer 先调用 `onRespond({ kind:'accepted', choiceId })`，再把同一个 `choiceId` 记录为 recent。取消（onCancel / Esc）不写入。

---

## 六、渲染位置

弹窗在 DefaultLayout 内部渲染，位于 Prompt 正上方（与 LoadingIndicator 同一区域）。

- 有弹窗时：显示弹窗，隐藏 LoadingIndicator。
- 无弹窗时：正常显示 LoadingIndicator（如果 loading.isLoading）。

---

## 七、文档自检

- [x] 顶层来源只保留 permission 和 interaction。
- [x] ModelDialog/SessionDialog 已重定位为 interaction subject renderer。
- [x] B' 原则（授权边界 + 呈现增强）已写入 §一·五，并被各 renderer 引用。
- [x] 数据组装流程统一（§五·五）：request.options 权威 + TuiStore/LocalUiMemory 增强。
- [x] LocalUiMemory 写入时机限定在 accepted 路径，cancel 不写入。
- [x] Prompt 冻结和回调模式清晰。
- [x] 渲染位置和优先级已明确。
