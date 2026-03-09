# Spinner 加载动画

## 一、职责

Spinner 提供终端中的旋转加载动画，使用 braille dots 字符序列实现。作为纯展示组件，被 LoadingIndicator 和 ToolPart（running 状态）使用。

## 二、Props 定义

```typescript
interface SpinnerProps {
  isActive?: boolean             // 是否激活旋转，默认 true
  color?: string                 // 字符颜色，默认蓝色
  interval?: number              // 帧间隔（ms），默认 80
}
```

## 三、动画帧序列

使用 braille dots 字符集实现旋转效果：

```
帧序列: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
```

每帧显示一个字符，按 interval 间隔循环切换。Spinner 始终占用 1 个字符宽度。

## 四、生命周期

| isActive | 行为 |
|---------|------|
| true | 启动 setInterval 定时器，循环切换帧 |
| false | 停止定时器，显示最后一帧（静止） |

组件卸载时自动清除定时器（useEffect cleanup）。

## 五、使用场景

| 场景 | 颜色 | 说明 |
|------|------|------|
| LoadingIndicator | 蓝色 | 加载指示器中，剑图标左侧 |
| ToolPart (running) | 蓝色 | 工具执行中的状态图标 |

## 六、设计约束

1. **零 Context 依赖**：通过 Props 控制
2. **单字符宽度**：不影响布局
3. **不含文本**：Spinner 只输出动画字符，附带文本由使用方提供

## 七、文档自检

- [x] braille dots 帧序列已定义
- [x] Props 完整，含 interval 控制
- [x] 定时器清理已说明
- [x] 使用场景已列举
