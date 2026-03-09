# ScrollableList 可滚动选择列表

## 一、职责

ScrollableList 提供固定高度的可滚动选项列表，支持键盘上下导航和选中高亮。主要用于弹窗内的选项选择（ModelDialog、SessionDialog 等），不用于消息列表。

与 VirtualizedList 的区别：ScrollableList 面向短列表选择场景，内部管理焦点状态和键盘导航；VirtualizedList 面向长列表渲染场景，外部控制滚动。

## 二、Props 定义

```typescript
interface ScrollableListProps<T> {
  items: T[]                                              // 选项列表
  renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode
  maxVisibleItems?: number                                // 最大可见项数，默认 8
  selectedIndex?: number                                  // 外部控制的选中索引
  onSelect?: (item: T, index: number) => void             // Enter 确认回调
  onChange?: (index: number) => void                       // 焦点变化回调
  isActive?: boolean                                      // 是否激活键盘监听
}
```

## 三、交互设计

### 3.1 键盘导航

| 按键 | 行为 |
|------|------|
| Up / Down | 移动焦点到上一项 / 下一项 |
| Enter | 确认选中当前焦点项，触发 onSelect |
| Home / End | 跳转到首项 / 末项 |

焦点到达列表边界时**循环**（末尾按 Down 回到首项，首项按 Up 到末尾）。

### 3.2 滚动窗口

当列表项数超过 `maxVisibleItems` 时，列表内部维护一个滚动窗口：

- 焦点项始终在可见区域内
- 焦点向下移出窗口时，窗口向下滑动
- 焦点向上移出窗口时，窗口向上滑动

### 3.3 选中高亮

当前焦点项通过 `isSelected` 参数传给 `renderItem`，由使用方决定高亮样式（通常为反色或加粗 + 前缀标记）。

## 四、键盘事件监听

ScrollableList 通过 `useKeypress` hook 监听键盘事件。`isActive` Props 控制是否激活监听，用于解决弹窗嵌套时的焦点冲突：

- 弹窗处于前台时 `isActive = true`
- 弹窗关闭或不可见时 `isActive = false`

## 五、使用场景

| 场景 | maxVisibleItems | 说明 |
|------|----------------|------|
| ModelDialog | 6 | 模型列表通常不超过 20 个 |
| SessionDialog | 8 | 会话列表可能较长 |
| 其他选择场景 | 按需 | 通用选择组件 |

## 六、设计约束

1. **零 Context 依赖**：通过 Props 接收数据和回调
2. **不做虚拟化**：面向短列表场景（通常 < 50 项），全量渲染
3. **不含滚动条 UI**：通过截断显示和焦点跟随实现"滚动"感
4. **键盘事件由 useKeypress 管理**：不直接调用 process.stdin

## 七、文档自检

- [x] 与 VirtualizedList 的区别已在职责中说明
- [x] 键盘导航规则完整（含循环和跳转）
- [x] 滚动窗口机制已描述
- [x] isActive 焦点控制已说明
- [x] 使用场景已列举
