# MaxSizedBox 高度限制容器

## 一、职责

MaxSizedBox 限制其子内容的最大显示高度（行数）。当内容超出最大高度时，截断显示并在底部添加省略提示。用于防止过长的工具输出或文本内容撑开布局。

## 二、Props 定义

```typescript
interface MaxSizedBoxProps {
  maxHeight: number              // 最大高度（行数）
  children: React.ReactNode      // 内容
  overflowIndicator?: string     // 溢出提示文本，默认 "... ({n} more lines)"
}
```

## 三、行为规则

| 内容高度 | 行为 |
|---------|------|
| <= maxHeight | 正常渲染，不截断 |
| > maxHeight | 只显示前 maxHeight - 1 行 + 溢出提示行 |

### 溢出提示

```
... (23 more lines)
```

溢出提示行使用 dimColor 渲染，占用 maxHeight 的最后一行。

## 四、实现方式

MaxSizedBox 使用 Ink 的 `Box` 组件配合 `overflow: hidden` 和固定 `height` 实现截断。溢出检测通过 `measureElement` 比较实际高度与 maxHeight。

## 五、使用场景

| 场景 | maxHeight | 说明 |
|------|-----------|------|
| ToolPart 结果显示 | 10-15 | 工具输出可能很长（如 bash 输出） |
| 代码块 | 20 | Markdown 代码块的最大显示高度 |

## 六、设计约束

1. **零 Context 依赖**：通过 Props 控制
2. **不提供滚动**：超出部分直接截断，不可滚动查看
3. **溢出提示始终在最后一行**：不占用额外空间

## 七、文档自检

- [x] Props 定义完整
- [x] 截断行为规则已说明
- [x] 溢出提示格式已定义
- [x] 使用场景已列举
