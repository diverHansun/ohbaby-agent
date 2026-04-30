# LocalUiMemory — UI 私有本地记忆

本文档定义 LocalUiMemory 的职责、形状与使用边界。

LocalUiMemory 是 `ohbaby-tui` 中**纯 UI 私有的本地记忆切片**，与 [TuiStore](./tui-store.md) 平级。它存放那些**不属于 SDK 数据投影、但又需要跨弹窗或会话保留**的 UI 偏好与历史信息。

---

## 一、为什么不并入 TuiStore

[tui-store.md](./tui-store.md) 第 4 行明确定义 TuiStore 是"SDK 数据的唯一本地投影"，任何写入都必须来自 snapshot / RPC / 事件。把 UI 私有的 recent/favorite 等数据塞进 TuiStore 会让"投影一致性"变成"投影 + 私有混合状态"，破坏 reducer 的纯净性，也让 selector 消费者无从判断字段来源。

LocalUiMemory 与 TuiStore 平级、各司其职：

| 切片 | 数据来源 | 写入触发 | 例子 |
|---|---|---|---|
| TuiStore | SDK | snapshot / RPC / events | runtime / sessions / messages / catalog / permissions |
| LocalUiMemory | UI 自身 | 用户在 UI 中的动作（选模型、选会话） | recentModelChoiceIds / recentSessionChoiceIds |

两个切片**单向解耦**：LocalUiMemory 不写 TuiStore，TuiStore 不读 LocalUiMemory。需要联合呈现的场景（例如 ModelDialog 排序）由具体消费者（dialog 组件）自己组合两边数据。

---

## 二、职责

- 存储 UI 私有偏好与历史，例如最近选过的模型 / 会话。
- 提供按"最近使用"排序、过滤、回写的最小 API。
- 在 dialog 关闭并选定 `choiceId` 时由对应 dialog 写入。
- 在 dialog 打开时由对应 dialog 读取，与 `request.options` 求交集再用于呈现增强。

**不做的事：**
- **不存 SDK 投影数据**（不复制 sessions/runtime/catalog）。
- **不做权威 catalog**：呈现时如果 LocalUiMemory 中的 id 已不在 `request.options` 里，必须**静默丢弃**，不能扩大 backend 允许的选择集合。
- **不直接调 SDK**。
- **不做业务逻辑**：仅做"列表写入 + 截断 + 去重 + 求交集"。
- **MVP 不持久化**：仅 in-memory，进程退出即丢弃。持久化策略列入 non-functional 后续讨论。

---

## 三、Memory 形状

```typescript
interface LocalUiMemoryState {
  recentModelChoiceIds: readonly string[]      // 模型 dialog 的最近选择 id（FIFO，最新在前）
  recentSessionChoiceIds: readonly string[]    // 会话 dialog 的最近选择 id（FIFO，最新在前）
}

const DEFAULT_RECENT_LIMIT = 5                  // 每类最多保留 5 个，超出 FIFO 淘汰
```

每个 `choiceId` 即对应 dialog 上次成功 `accepted` 时的 `choiceId`：
- ModelDialog 场景下通常是 `"providerID:modelID"` 或 backend 自定义的 stable id（由 `request.options[i].id` 决定，UI 不解析）。
- SessionDialog 场景下通常是 sessionId 或 backend 显式声明的 `__new__` 类特殊 id。

LocalUiMemory **不解释 id 含义**，只做存取。

---

## 四、API（最小集）

```typescript
interface LocalUiMemory {
  // 读取
  getRecentModels(): readonly string[]
  getRecentSessions(): readonly string[]

  // 写入：被 dialog 在 onRespond({ kind: 'accepted', choiceId }) 之后调用
  pushRecentModel(choiceId: string): void
  pushRecentSession(choiceId: string): void
}
```

`pushRecent*` 的语义：
1. 如果 `choiceId` 已在列表中，**先移除再插入到队首**（"提到最前"）。
2. 否则插入到队首。
3. 超出 `DEFAULT_RECENT_LIMIT` 时尾部丢弃。

返回值统一为 `void`：消费者读取时再调 `getRecent*`。

---

## 五、与 request.options 的求交集策略

呈现时，**LocalUiMemory 提供"排序提示"，不提供"候选集合"**。具体步骤（以 ModelDialog 为例）：

```text
1. 取 request.options                               -> 权威候选集合
2. 取 LocalUiMemory.getRecentModels()               -> 最近 id 数组
3. 计算 recentValid = recent.filter(id => options.has(id))
   -> 静默丢弃已不存在的 id（例如对应模型已被 backend 移除）
4. 渲染顺序：
   - "Recent" category：按 recentValid 顺序展示
   - "All" / "By Provider" category：从 options 中剔除已在 Recent 出现的项
```

**绝对禁止**：把 recent 中存在、options 中不存在的 id 重新加到候选集合里。这是 B' 原则的硬边界。

---

## 六、与各模块的访问关系

| 消费者 | 读 | 写 | 说明 |
|---|---|---|---|
| ModelDialog | ✓ getRecentModels | ✓ pushRecentModel（在 accepted 之后） | 用于排序与 "Recent" category 渲染 |
| SessionDialog | ✓ getRecentSessions | ✓ pushRecentSession | 同上 |
| 其他 dialog（v2） | 视场景扩展 | 视场景扩展 | 新增 recent 切片需在本文档登记 |
| TuiStore | ✗ | ✗ | 严格不互访 |
| `useStream` / SDK 事件层 | ✗ | ✗ | 不参与 |

---

## 七、与 React 渲染的接入方式

LocalUiMemory 不依赖 React Context，与 TuiStore 一样通过模块级单例 + `useSyncExternalStore` 暴露：

```typescript
// 提供给 dialog 的 hook
function useRecentModels(): readonly string[]
function useRecentSessions(): readonly string[]
```

写入侧使用直接调用：

```typescript
// 在 dialog 组件内部
function onSelectAccepted(choiceId: string) {
  onRespond({ kind: 'accepted', choiceId })
  localUiMemory.pushRecentModel(choiceId)
}
```

写入会触发对应 hook 重订阅，但因 dialog 此时即将关闭，重渲染影响极小。LocalUiMemory 记录的是"用户选择过"这一 UI 事实，不等待 backend 确认业务动作已完成。

---

## 八、设计约束

1. **与 TuiStore 边界硬隔离**：双方互不读写。
2. **不扩大候选集合**：所有展示必须先与 `request.options` 求交集。
3. **MVP 仅 in-memory**：进程结束即丢弃；持久化策略待后续 non-functional 讨论。
4. **不解释 id 语义**：LocalUiMemory 把 `choiceId` 当不透明字符串。
5. **不做 favorite**（MVP）：favorite 涉及 toggle 快捷键 + 持久化 + 同步策略，复杂度过高，列入 v2。
6. **新增 recent 切片必须显式登记**：避免 LocalUiMemory 演变成"什么都装"的杂物袋。

---

## 九、文档自检

- [x] 与 TuiStore 的职责边界已说明，且双方互不依赖
- [x] Memory 形状只含 recent，不混入 favorite / SDK 数据
- [x] API 仅暴露 get/push，不暴露解释 id 的能力
- [x] 与 `request.options` 求交集的渲染流程明确
- [x] MVP in-memory、不持久化的限定已声明
- [x] 与 React 渲染的接入方式（模块级单例 + useSyncExternalStore）有说明
- [x] 新增切片需登记的约束已写明，避免无序膨胀
