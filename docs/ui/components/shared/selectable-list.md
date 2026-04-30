# SelectableList 选择列表 primitive

## 一、职责

SelectableList 是面向"从一组候选中挑选一项"场景的通用呈现 primitive，封装了搜索框、分组渲染、当前项标记、焦点导航、底部提示条等交互细节。它是 ModelDialog、SessionDialog 以及未来 Agent / Theme / MCP 等"select-one"类弹窗共同复用的视觉骨架。

与 [ScrollableList](./scrollable-list.md) 的区别：
- ScrollableList 提供"短列表 + 焦点 + 滚动窗口"的底层机制，是组件内部使用的低层 primitive。
- SelectableList 在 ScrollableList 之上叠加了**搜索 / 分组 / 标签 / 当前项标识 / tone 着色**等"挑选场景专用"的呈现逻辑。

对应职责追溯：goals-duty.md G5（Surface-Owned Rendering）、components/dialogs/index.md（呈现增强属于 UI）。

---

## 二、设计原则

1. **纯呈现 primitive，不持有数据**：所有候选项由父组件以 `options` 传入。primitive 不调 SDK、不读 TuiStore、不写 LocalUiMemory。
2. **通过稳定 id 标识候选项**：父组件需为每个 option 提供 `id`，primitive 用 `id` 做相等比较（用于 `currentId` 高亮），不依赖对象引用相等或 `value` 字段。
3. **不泄漏样式/主题细节**：色彩通过语义化的 `tone` 标签暴露，具体颜色映射由 styles 层决定。
4. **零 Context 依赖**：所有交互通过 Props 传入；primitive 通过 `useKeypress` hook 监听键盘，但不直接读 AppState 或 TuiStore。
5. **MVP 故意不做的能力**：行级 action 快捷键、多选、异步 loading、滚动定位 API。这些列入 v2，避免 primitive 早期复杂化。

---

## 三、Props 定义

```typescript
interface SelectableListOption<V = unknown> {
  id: string                            // 稳定标识；dialog 场景下 id === choiceId
  value?: V                             // 可选透传 payload，由父组件解释
  title: string                         // 主标签
  description?: string                  // 副标签（同行右侧 dim 色，详见 §五）
  category?: string                     // 分组小标题；同 category 自动聚合
  footer?: string                       // 行末附属文字（更新时间、Free 标签、provider 名等）
  gutter?: ReactNode                    // 行首图标位（spinner / current 标记 / 警示符）
  disabled?: boolean                    // 不可选；焦点会跳过
  tone?: 'default' | 'muted' | 'accent' | 'warning' | 'danger'
}

interface SelectableListProps<V = unknown> {
  title: string                         // dialog 标题（顶部展示）
  options: SelectableListOption<V>[]
  currentId?: string                    // 当前已激活项的 id；primitive 用 gutter 标记
  onSelect: (option: SelectableListOption<V>) => void
  onCancel: () => void                  // Esc 触发
  onMove?: (option: SelectableListOption<V>) => void  // 焦点移动通知（用于"二次确认"等状态清理）
  filterMode?: 'local-fuzzy' | 'controlled'
  onFilter?: (query: string) => void    // controlled 模式下父级负责过滤
  size?: 'small' | 'medium' | 'large'   // 决定 max height / padding
  emptyText?: string                    // 列表为空时展示
}
```

### 字段补充说明

| 字段 | 说明 |
|---|---|
| `id` | 必填且需稳定。`SelectableList` 用 `id` 计算 `currentId` 高亮；父组件在 `onSelect` 回调里直接拿到 option，再决定如何上报 `choiceId`（dialog 场景下两者相等）。 |
| `value` | 可选。当父组件需要在 `onSelect` 拿到比 `id` 更丰富的 payload 时使用，例如 `{ providerID, modelID }`。 |
| `tone` | 语义化色调标签。primitive 不持有色值，由 styles 层把 `tone` 映射到 `dialog.toneDefault` / `dialog.toneMuted` 等 token（见 [styles/tokens.md](../../styles/tokens.md)）。 |
| `gutter` | 行首一格区域，可放任意 ReactNode（最常见：spinner、`●`、`✓`、`⚠`）。父组件按业务语义决定。 |
| `filterMode` | `local-fuzzy` 时 primitive 在内部对 `options` 做模糊匹配；`controlled` 时 primitive 仅把 `query` 通过 `onFilter` 抛给父级，父级返回新的 `options`。MVP 默认 `local-fuzzy`。 |
| `size` | 控制弹窗最大高度与内边距：small ≈ 6 行可见、medium ≈ 10 行、large ≈ 14 行。具体数值由 styles 层定义。 |

### 关于 matcher

契约只暴露 `local-fuzzy` 这一抽象层级。具体匹配算法（fuzzysort / 自研 / 复用 [prompt/completion.md](../prompt/completion.md) 的 matcher）属于实现细节，不在 spec 写死，便于后续统一补全体验。

---

## 四、交互设计

### 4.1 键盘映射

| 按键 | 行为 |
|---|---|
| Up / Down | 在可见项之间移动焦点；遇 `disabled` 项跳过；到边界**循环**（与 ScrollableList 一致） |
| Home / End | 跳到首项 / 末项 |
| Enter | 选中当前焦点项，调用 `onSelect(option)`；当前焦点为 disabled 时无操作 |
| Esc | **直接关闭**，调用 `onCancel()`；不做"先清空搜索"的双义处理 |
| 任意可打印字符 | 进入搜索框（搜索框默认占据列表顶部）；删除键回退；后续清空搜索由 Ctrl+U 实现（v2） |

### 4.2 焦点 vs 当前项的视觉区分

primitive 严格区分两种语义，避免符号冲突：

| 语义 | 视觉位置 | 形式 |
|---|---|---|
| **焦点（focus）**：用户当前正在选哪一项 | 整行 | 整行 inverse 高亮，或行首 `>` cursor（具体形式由 styles 层决定，primitive 只抛 `focus=true` 标志） |
| **当前（current）**：当前已激活项（如已选用模型） | gutter | 在 `gutter` 区渲染 `●` 或 `✓` 标记；不与焦点抢符号 |

如果父组件已经传入了 `gutter`（例如某 session 在 streaming 显示 spinner），那么 primitive 不再叠加 current 标记——父组件应自行决定优先级（一般状态指示比"当前激活"更紧迫）。

### 4.3 description 与 footer 的布局规则

- `description` 默认渲染在 title **同行右侧**，使用 dim 色（`tokens.text.secondary`）。
- 终端宽度不足时，primitive **降级**为：description 换到下一行缩进展示，或在末尾用 `…` 截断。**不允许 description 与 title 视觉重叠**。
- `footer` 始终渲染在行末右对齐位置；当 `description` 与 `footer` 同时存在且空间不够时，优先保证 `footer`，截断 `description`。

### 4.4 搜索时的分组行为

- 无 query：按 options 数组中**首次出现的 category 顺序**渲染分组小标题；primitive 不重排 category，也不重排同 category 内的项顺序。
- 有 query（`local-fuzzy` 或 `controlled` 都一样）：**塌缩为平铺列表**，不再渲染 category 小标题；focus 跳到首个匹配项。
- query 清空回到无 query 状态：恢复分组渲染，焦点回到原 currentId（若不在结果中则回到第一项）。

### 4.5 onMove 的用途

`onMove` 在焦点移动到新项时触发，主要服务于**二次确认**类场景：

> 例如 SessionDialog 的删除键："首次按 d → 提示 'Press d again to confirm' → 用户按方向键移动到其他项 → 确认提示自动消失"。父组件用 `onMove` 清掉 `toDelete` 状态。

---

## 五、视觉规则总览

```
┌─ {title} ──────────────────────────────────────┐
│  > {search query}                               │   ← 搜索框（任意字符触发输入）
│                                                 │
│  Favorites                                      │   ← category 小标题（无 query 时）
│  ●  Claude Opus 4.7         Anthropic           │   ← gutter ● = currentId 命中
│ >   Claude Sonnet 4.6       Anthropic           │   ← > = focus
│                                                 │
│  Recent                                         │
│     GPT-5                   OpenAI              │
│     Gemini 2.5 Pro          Google              │
│                                                 │
│  Anthropic                                      │
│     Claude Haiku 4.5        (faster)            │   ← description 同行右侧 dim
├─────────────────────────────────────────────────┤
│  ⏎ select   esc cancel                          │   ← 底部提示条，固定文案
└─────────────────────────────────────────────────┘
```

底部提示条 MVP 写死 `⏎ select   esc cancel`。v2 引入行级 action 快捷键时，再扩展为可配置 `actions[]`。

---

## 六、tone 与 styles 的契约

primitive 不持有色值。`tone` 五个语义值与 styles 的映射约定：

| tone | 含义 | 推荐映射（写在 [tokens.md](../../styles/tokens.md)） |
|---|---|---|
| `default` | 默认普通行 | `text.primary` |
| `muted` | 已弱化（不可用、过时但仍可见） | `text.secondary` |
| `accent` | 视觉强调（推荐项、主推模型） | `text.accent` |
| `warning` | 需要注意（容量不足、弃用警告） | `status.warning` |
| `danger` | 警示性（删除二次确认时整行变色） | `status.error` |

primitive 把 tone 字段透传给 styles 层；styles 层负责定义这五个值在主题里对应的颜色 token。**未来切主题或加亮色主题时，只改 styles，不动 primitive。**

---

## 七、Context 与 hook 依赖

| 依赖 | 用途 |
|---|---|
| `useKeypress` | 监听键盘事件（Up/Down/Enter/Esc/Home/End/可打印字符） |
| `useTerminalSize`（hooks 层） | 根据宽度决定 description 是否需要降级到下一行 |

不读：AppStateContext、AppActionsContext、TuiStore、LocalUiMemory。**所有数据通过 Props 流入，所有交互通过回调流出。**

---

## 八、设计约束

1. **不持有数据**：options 全部由父组件构造；primitive 不知道也不关心数据来源。
2. **不调 SDK / 不读全局 store**：违反此约束就丧失"通用 primitive"地位。
3. **不在契约内写死 matcher 实现**：仅暴露 `filterMode='local-fuzzy' | 'controlled'`。
4. **不挂行级 action 快捷键**（MVP）：v2 时通过单独的 `actions[]` Prop 引入。
5. **不区分焦点和当前**绝对禁止：两种语义用不同视觉位置（行高亮 vs gutter 标记）。
6. **不允许 description 视觉重叠 title**：宽度不足时降级换行或截断。
7. **不感知队列或 dialog 边框**：dialog 容器（边框、阴影、modal 背景）由 DialogManager / DefaultLayout 提供。

---

## 九、使用示例（消费者视角，仅示意）

```tsx
// 由 ModelDialog 调用，非 primitive 的实现示意
<SelectableList
  title="Select model"
  options={enrichedOptions}        // request.options × LocalUiMemory.recentModelChoiceIds
  currentId={runtime.modelChoiceId}
  filterMode="local-fuzzy"
  size="medium"
  onSelect={(option) => onRespond({ kind: 'accepted', choiceId: option.id })}
  onCancel={() => onCancel()}
/>
```

---

## 十、文档自检

- [x] 接口契约完整（id/value 分离、tone 取代 bg、filterMode 抽象 matcher）
- [x] 焦点与当前项的视觉规则明确分离
- [x] 搜索时塌缩为平铺、category 顺序按首次出现
- [x] description 不与 title 重叠的降级规则有明确表述
- [x] 与 ScrollableList 的职责边界已说明
- [x] tone 与 styles 的契约明确，primitive 不持色值
- [x] MVP 排除项（行级 action / 多选 / loading / 滚动定位）已显式列出
- [x] 零 Context 依赖、不调 SDK 的约束已声明
