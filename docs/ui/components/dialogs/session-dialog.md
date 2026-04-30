# SessionDialog — interaction subject='session' 的选择 renderer

## 一、职责

SessionDialog 渲染 `UiInteractionRequest` 中 `kind='select-one'` 且 `subject='session'` 的请求，供用户在 backend 允许的会话列表中切换到其他会话或创建新会话。

它是 **interaction source 下的 subject renderer**，不是顶层 dialog type。呈现上复用 [SelectableList](../shared/selectable-list.md) primitive。

对应职责追溯：goals-duty.md D5（DialogManager）、components/dialogs/index.md §一·五（B' 原则）。

---

## 二、核心设计原则（来自 B'）

1. **request.options 是权威候选集合**——SessionDialog 只呈现 backend 允许的会话项，不能展示 options 以外的项。
2. **TuiStore.sessions 仅做展示增强**——用于补充每个会话行的状态信息（streaming 中 → spinner、标题、更新时间），但展示的 id 集合不超出 `request.options`。
3. **`__new__` 必须由 backend 显式声明**——如果 backend 允许新建会话，必须在 `request.options` 里包含一个特殊项（例如 `id='__new__'` + `label='New session'`），UI 不自动注入此选项。

---

## 三、输入数据

```typescript
interface SessionDialogProps {
  request: UiInteractionRequest  // kind='select-one', subject='session'
  onRespond: (response: UiInteractionResponse) => void
  onCancel: () => void
}
```

要求：
- `request.kind === 'select-one'`
- `request.subject === 'session'`
- `request.options` 每项含 `id`（sessionId 或特殊值）和 `label`
- `request.prompt`（可选）作为弹窗标题

---

## 四、数据组装

SessionDialog 按如下步骤把三方数据合并为 `SelectableListOption[]`：

```text
① 权威候选集合
   authorityOptions = request.options             // id（sessionId / '__new__' 等）+ label

② TuiStore 数据求交集并增强
   tuiSessions = useSessionSummaries()            // TuiStore 里已知的会话快照
   对 authorityOptions 中的每一项：
     若 id 存在于 tuiSessions：
       - title   = tuiSessions[id].title（覆盖 request label；保持与 ChatView 一致）
       - footer  = Locale.time(tuiSessions[id].time.updated)（相对时间）
       - gutter  = useRuns() 中有正在进行的 run 属于该 session → <Spinner />
       - category = 按 time.updated 日期分组（Today / Yesterday / YYYY-MM-DD）
     若 id 为特殊值（'__new__' 等，不在 tuiSessions）：
       - 使用 request label，不做增强；无 footer，无 gutter
       - category = 'Actions'（或 backend 提供的分组信息）

③ TuiStore 读取当前激活会话
   currentSessionId = useActiveSessionId()

④ LocalUiMemory 过滤出有效 recent
   recentValid = LocalUiMemory.getRecentSessions()
                  .filter(id => authorityOptions.has(id))
   // recent 仅用于 "Recently visited" category 的排序；
   // 对于会话列表这类"已经按日期分组"的场景，recent 的价值有限，
   // MVP 可以只用于调整"Today"内部的顺序，不单独创建 Recent category。

⑤ 构造最终 SelectableListOption[]
   - 分组顺序：Today（recent 调整内部顺序）→ Yesterday → 更早各日期 → Actions
   - currentId = currentSessionId
```

> 分组实现依赖 tuiSessions 里的 `time.updated`。如果 backend options 里的 id 不存在于 TuiStore（例如其他用户的会话），只展示 request label，无 footer 和 category，排在最后。

---

## 五、视觉结构

```
┌─ {request.prompt ‖ "Sessions"} ─────────────────────┐
│  > {search}                                          │
│                                                      │
│  Today                                               │
│  ●  Refactor auth module          2 min ago          │  ← gutter ● = currentId
│ >   ⠋ Streaming bug fix            12 min ago        │  ← spinner = 正在执行
│     Write tests for hooks         1 hour ago         │
│                                                      │
│  Yesterday                                           │
│     Setup CI pipeline             ~                  │
│     Scaffold ohbaby-sdk           ~                  │
│                                                      │
│  Actions                                             │
│     + New session                                    │  ← __new__（backend 声明）
├──────────────────────────────────────────────────────┤
│  ⏎ open   esc cancel                                 │
└──────────────────────────────────────────────────────┘
```

布局细节由 [SelectableList §五](../shared/selectable-list.md) 统一定义。

---

## 六、交互设计

### 6.1 onSelect（accepted 路径）

```text
1. 调用 onRespond({ kind: 'accepted', choiceId: option.id })
   -> DialogManager 执行 current.onRespond
   -> backend 解释 choiceId（sessionId → 切换会话；'__new__' → 创建新会话）
2. 把同一个 choiceId 写入 LocalUiMemory.pushRecentSession(choiceId)
```

LocalUiMemory 写入发生在 accepted 响应被提交之后；它只记录用户选择，不代表 backend 已经成功完成会话切换或创建。若 `onRespond` 抛出同步错误，则不写入 recent。

### 6.2 onCancel（取消路径）

```text
1. 不写入 LocalUiMemory
2. 调用 onCancel()
```

### 6.3 gutter 优先级

当同一行同时有"streaming（spinner）"和"currentId（●）"两个语义时：
- **Spinner 优先**：streaming 状态更紧迫，用 spinner 替代 ●。
- 用户在视觉上仍能感知这是当前会话（整行 highlight + currentId 对应的焦点初始位置）。

---

## 七、搜索行为

- `filterMode='local-fuzzy'`，由 SelectableList 内部处理。
- 搜索范围：`title`（会话标题）。
- 有 query 时：塌缩为平铺，日期分组小标题消失；`__new__` 等特殊项**不纳入搜索**（除非 query 为空），保留在底部。
- MVP 不实现 controlled（服务端搜索），因为会话列表已经在 TuiStore 本地可用。

---

## 八、Context 与数据依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `useSessionSummaries()` | TuiStore selector | 读取会话列表（title / time.updated）做展示增强 |
| `useActiveSessionId()` | TuiStore selector | 读取当前会话 id（标记 current） |
| `useRuns()` | TuiStore selector | 检测哪些 session 有正在进行的 run（spinner gutter） |
| `LocalUiMemory.getRecentSessions()` | LocalUiMemory hook | 读取 recent 排序（影响 Today 内部顺序） |
| `LocalUiMemory.pushRecentSession()` | LocalUiMemory API | 写入 accepted 时的选择 |

不读：AppStateContext、AppActionsContext、KeypressContext。

---

## 九、响应值

```typescript
onRespond({ kind: 'accepted', choiceId: string })
```

`choiceId` 是 `request.options[i].id`：
- 普通 sessionId：backend 执行会话切换。
- `'__new__'` 或其他特殊值：backend 执行新建会话或其他语义动作。

UI 不解析 choiceId 含义，由 backend 全权解释。

---

## 十、设计约束

1. **`__new__` 必须 backend 声明**：UI 不自动注入新建会话选项。
2. **不扩大候选集合**：TuiStore 或 LocalUiMemory 中存在但不在 `request.options` 里的会话，不得展示。
3. **不直接操作会话**：只回传 `choiceId`，由 backend 执行切换/新建逻辑。
4. **MVP 无 delete/rename**：v2 通过 SelectableList `actions[]` 扩展行级操作（`d` 删除二次确认、`r` 重命名等）。
5. **MVP 无 controlled 搜索**：本地 fuzzy 已足够，不需要服务端搜索往返。
6. **属于 interaction renderer**：不作为顶层 dialog source 出现。

---

## 十一、文档自检

- [x] B' 原则已声明（request.options 权威 + TuiStore 增强）
- [x] `__new__` 必须 backend 显式声明，UI 不自注入
- [x] 数据组装四步流程清晰（权威集合 → TuiStore 增强 → current 读取 → LocalUiMemory 排序）
- [x] gutter 优先级（spinner > ● current marker）已说明
- [x] accepted 路径：先 onRespond，再写 LocalUiMemory recent
- [x] cancel 路径：不写 LocalUiMemory
- [x] MVP 排除项（delete/rename / controlled 搜索）已显式列出
- [x] 响应值只回传 choiceId，UI 不解析含义
