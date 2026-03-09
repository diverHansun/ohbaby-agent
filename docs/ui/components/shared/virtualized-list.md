# VirtualizedList 虚拟化列表

## 一、职责

VirtualizedList 是消息列表的核心渲染引擎。它只渲染终端可见区域内的列表项，避免长对话（数百条消息）时的性能问题。VirtualizedList 不包含滚动条 UI，只负责虚拟化计算和渲染。

对应职责追溯：goals-duty.md D4（虚拟化列表）、G5（组件化与性能）。

## 二、核心概念

| 概念 | 说明 |
|------|------|
| Viewport | 终端可见区域，由 height（行数）决定 |
| Overscan | 可见区域上下的缓冲区，预渲染额外项以减少滚动时的空白闪烁 |
| 估算高度 | 未渲染项的高度通过 estimatedItemHeight 回调估算 |
| 实际高度 | 已渲染项的高度由 Ink 的 measureElement 测量后缓存 |

## 三、Props 定义

```typescript
interface VirtualizedListProps<T> {
  items: T[]                                              // 数据列表
  renderItem: (item: T, index: number) => React.ReactNode // 渲染函数
  estimatedItemHeight: (item: T, index: number) => number // 高度估算函数
  height: number                                          // 可见区域高度（行数）
  overscan?: number                                       // 缓冲区大小，默认 3
  scrollOffset?: number                                   // 外部控制的滚动偏移
  onScroll?: (offset: number) => void                     // 滚动回调
}
```

## 四、高度估算策略

VirtualizedList 采用**内容感知估算**，根据数据项的类型和内容长度预估高度（行数），而非使用固定值。

### 4.1 为什么不用固定高度

消息列表中各项高度差异大：一条短文本可能 2 行，一条包含多个 ToolPart 的消息可能 20+ 行。固定高度估算会导致滚动位置严重偏移。

### 4.2 估算规则

`estimatedItemHeight` 由 MessageList 提供，根据 `MessageWithParts` 的内容估算：

| 消息类型 | 估算策略 |
|---------|---------|
| UserMessage | 文本行数 + 1（前缀行） |
| AssistantMessage | 各 Part 高度之和 |
| SystemMessage | 固定 2 行 |

Part 高度估算：

| Part | 估算策略 |
|------|---------|
| TextPart | `ceil(text.length / terminalWidth)` + Markdown 结构额外行 |
| ReasoningPart | 折叠时 1 行，展开时按文本长度估算 |
| ToolPart | 2 行（状态行 + 结果行） |
| FilePart | 1 行 |

### 4.3 高度校正

当列表项实际渲染后，通过 Ink 的 `measureElement` 获取真实高度，存入 `itemHeights` 缓存（以 item key 为索引）。后续滚动计算优先使用缓存的真实高度。

## 五、渲染流程

```
1. 计算总高度（已测量项用真实高度，未测量项用估算高度）
2. 根据 scrollOffset 计算可见区域的起止索引
3. 扩展 overscan 缓冲区
4. 只渲染 [startIndex - overscan, endIndex + overscan] 范围的项
5. 上下方用空 Box 占位，高度等于不可见项的累计高度
```

## 六、滚动控制

VirtualizedList 自身不监听键盘或鼠标事件。滚动由外部通过 `scrollOffset` Props 控制：

- MessageList 内的 `useAutoScroll` hook 负责计算滚动偏移
- 鼠标滚轮事件由 `useMouse` 传入，转化为偏移量变化
- 键盘 Page Up/Down 由 `useKeypress` 传入

## 七、与 ScrollableList 的区别

| 特性 | VirtualizedList | ScrollableList |
|------|----------------|----------------|
| 用途 | 长列表渲染（消息列表） | 短列表选择（弹窗选项） |
| 高度估算 | 内容感知，动态 | 固定每项高度 |
| 滚动控制 | 外部驱动（Props） | 内部管理（键盘导航） |
| 选中状态 | 无 | 有（焦点高亮） |

## 八、设计约束

1. **零 Context 依赖**：通过 Props 接收所有数据
2. **不含滚动条 UI**：滚动条由使用方自行添加
3. **不管理选中状态**：只负责虚拟化渲染
4. **参考实现**：gemini-cli 的 VirtualizedList 组件

## 九、文档自检

- [x] 内容感知估算策略已定义，含各消息/Part 类型的估算规则
- [x] 高度校正机制已说明（measureElement + 缓存）
- [x] 渲染流程清晰（计算 --> 筛选 --> 占位 --> 渲染）
- [x] 滚动控制的外部驱动方式已说明
- [x] 与 ScrollableList 的区别已明确
