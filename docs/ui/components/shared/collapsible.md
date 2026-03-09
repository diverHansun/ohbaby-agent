# Collapsible 可折叠容器

## 一、职责

Collapsible 提供可展开/收起的容器组件。折叠时显示单行摘要，展开时显示完整内容。交互状态由外部控制（受控组件）。

## 二、Props 定义

```typescript
interface CollapsibleProps {
  title: string                    // 折叠时的标题文本
  isExpanded: boolean              // 是否展开
  onToggle: () => void             // 切换回调
  children: React.ReactNode        // 展开后的内容
  titleColor?: string              // 标题颜色，默认 dimColor
}
```

## 三、视觉结构

### 折叠状态

```
> Thinking...                      ← 标题行，dimColor，> 为折叠标记
```

### 展开状态

```
v Thinking...                      ← 标题行，dimColor，v 为展开标记
  这个问题需要分析几个方面...        ← 内容区，缩进显示
  首先考虑数据结构的选择...
```

### 折叠/展开标记

| 状态 | 标记 | 说明 |
|------|------|------|
| 折叠 | `>` | 表示可展开 |
| 展开 | `v` | 表示可收起 |

## 四、交互方式

Collapsible 的展开/折叠由外部控制：

- 使用方监听键盘或鼠标事件，调用 `onToggle` 切换状态
- Collapsible 自身不监听任何输入事件
- ReasoningPart 中通过点击或快捷键触发 toggle

## 五、使用场景

| 场景 | 默认状态 | 说明 |
|------|---------|------|
| ReasoningPart | 折叠 | 推理过程默认隐藏，用户手动展开查看 |

## 六、设计约束

1. **受控组件**：展开状态由 Props 控制，不内部管理
2. **零 Context 依赖**：通过 Props 接收所有数据
3. **不监听输入事件**：交互由使用方负责
4. **内容区不限制高度**：展开后完整显示 children

## 七、文档自检

- [x] Props 定义完整
- [x] 折叠/展开的视觉结构已说明
- [x] 受控组件的交互模式已明确
- [x] 使用场景已列举
