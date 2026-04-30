# ModelDialog — interaction subject='model' 的选择 renderer

## 一、职责

ModelDialog 渲染 `UiInteractionRequest` 中 `kind='select-one'` 且 `subject='model'` 的请求，供用户在 backend 允许的模型列表中挑选目标模型。

它是 **interaction source 下的 subject renderer**，不是顶层 dialog type。呈现上复用 [SelectableList](../shared/selectable-list.md) primitive。

对应职责追溯：goals-duty.md D5（DialogManager）、components/dialogs/index.md §一·五（B' 原则）。

---

## 二、核心设计原则（来自 B'）

1. **request.options 是权威候选集合**——ModelDialog 只呈现 backend 允许的模型，不能展示 options 以外的项。
2. **TuiStore + LocalUiMemory 仅做呈现增强**——当前 runtime model identity（用于匹配 current 项）和 recentModelChoiceIds（排序 Recent category）来自 TuiStore 和 LocalUiMemory，但不能扩大候选集合。
3. **MVP 不提供 favorite**——recent 自动维护，favorite 列入 v2。

---

## 三、输入数据

```typescript
interface ModelDialogProps {
  request: UiInteractionRequest  // kind='select-one', subject='model'
  onRespond: (response: UiInteractionResponse) => void
  onCancel: () => void
}
```

要求：
- `request.kind === 'select-one'`
- `request.subject === 'model'`
- `request.options` 非空，每项含 `id`（稳定标识）和 `label`
- `request.prompt`（可选）作为弹窗标题

---

## 四、数据组装

ModelDialog 在渲染前按如下步骤把三方数据合并为 `SelectableListOption[]`：

```text
① 权威候选集合
   authorityOptions = request.options             // id + label

② LocalUiMemory 过滤出有效 recent
   recentValid = LocalUiMemory.getRecentModels()
                  .filter(id => authorityOptions.has(id))
                  // 不在 options 里的 id 静默丢弃

③ TuiStore 读取当前激活模型
   currentModelIdentity = useRuntime()?.model ?? null
   currentId = findMatchingOptionId(authorityOptions, currentModelIdentity)

④ 构造 SelectableListOption[]
   - "Recent" category：按 recentValid 顺序从 authorityOptions 中取对应项
   - "All" 或 "By Provider" category：authorityOptions 中剩余的项
   - 每一项的 title 来自 request.options[i].label
   - footer 可用 request.options[i].metadata.provider（backend 扩展字段，若有）
   - gutter：若 id === currentId，渲染 ● 标记（current 语义）
```

> 注意：上图 "By Provider" 分组依赖 backend 在 `request.options` 里提供 provider 元数据。MVP 阶段 backend 尚未承诺此字段，**默认退化为单一 "All" category**。等 SDK 扩展 options metadata 后再补分组。

---

## 五、视觉结构

```
┌─ {request.prompt ‖ "Select model"} ────────────────┐
│  > {search}                                          │
│                                                      │
│  Recent                                              │
│  ●  Claude Opus 4.7                                  │   ← gutter ● = currentId
│ >   Claude Sonnet 4.6                                │   ← > = focus
│                                                      │
│  All                                                 │
│     Claude Haiku 4.5                                 │
│     GPT-5                                            │
│     Gemini 2.5 Pro                                   │
│     ...                                              │
├──────────────────────────────────────────────────────┤
│  ⏎ select   esc cancel                               │
└──────────────────────────────────────────────────────┘
```

布局细节由 [SelectableList §五](../shared/selectable-list.md) 统一定义，ModelDialog 只提供 options 数组和 callbacks。

---

## 六、交互设计

交互行为由 SelectableList 统一处理（Up/Down/Enter/Esc/搜索），ModelDialog 只关注 **onSelect 和 onCancel 的后置动作**：

### 6.1 onSelect（accepted 路径）

```text
1. 调用 onRespond({ kind: 'accepted', choiceId: option.id })
   -> DialogManager 执行 current.onRespond -> backend 解释 choiceId -> 执行模型切换
2. 把同一个 choiceId 写入 LocalUiMemory.pushRecentModel(choiceId)
```

LocalUiMemory 写入发生在 accepted 响应被提交之后；它只记录用户选择，不代表 backend 已经成功切换模型。若 `onRespond` 抛出同步错误，则不写入 recent。

### 6.2 onCancel（取消路径）

```text
1. 不写入 LocalUiMemory
2. 调用 onCancel()
   -> DialogManager 执行 current.onCancel -> backend 处理用户放弃
```

---

## 七、搜索行为

- `filterMode='local-fuzzy'`，由 SelectableList 内部处理。
- 搜索范围：`title`（模型名）。如果 backend 在 options 里提供了 provider 名，也纳入搜索范围（metadata.provider）。
- 有搜索 query 时：塌缩为平铺，"Recent" / "All" 的 category 小标题消失；结果按匹配度排序。
- 清空 query：恢复分组，焦点回到 currentId 项（如在列表中）。

---

## 八、Context 与数据依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `useRuntime()` | TuiStore selector | 读取当前 runtime model identity，用于匹配 request option 并标记 current |
| `LocalUiMemory.getRecentModels()` | LocalUiMemory hook | 读取 recent 排序 |
| `LocalUiMemory.pushRecentModel()` | LocalUiMemory API | 写入 accepted 时的选择 |

不读：AppStateContext、AppActionsContext、KeypressContext（键盘由 SelectableList 内部处理）。

---

## 九、响应值

```typescript
onRespond({ kind: 'accepted', choiceId: string })
```

`choiceId` 是 `request.options[i].id`，由 backend 解释为具体的 `providerID + modelID` 或其他格式。UI 不解析 choiceId 的内容。

---

## 十、设计约束

1. **不直接切换模型**：只回传 `choiceId`，由 backend 执行模型切换。
2. **不扩大候选集合**：LocalUiMemory 的 recent 在展示前必须与 `request.options` 求交集。
3. **MVP 无 favorite**：v2 通过 SelectableList 的 `actions[]` 扩展 favorite toggle。
4. **MVP 无 By-Provider 分组**：依赖 backend options metadata，后续 SDK 扩展后补。
5. **MVP 无 variant 二级弹窗**：如果未来模型有 thinking-depth 等变体，在 accepted 后链式打开 VariantDialog；不在本文档定义。
6. **属于 interaction renderer**：不作为顶层 dialog source 出现。

---

## 十一、文档自检

- [x] B' 原则已声明（request.options 权威 + 增强只做呈现）
- [x] 数据组装四步流程清晰（权威集合 → recent 求交集 → current 读取 → 构造 options）
- [x] onSelect accepted 路径：先 onRespond，再写 LocalUiMemory recent
- [x] onCancel 路径：不写 LocalUiMemory
- [x] MVP 排除项（favorite / By-Provider 分组 / VariantDialog 链）已显式列出
- [x] 无 Context 直接依赖；键盘由 SelectableList 处理
- [x] 响应值只回传 choiceId，不解析内容
