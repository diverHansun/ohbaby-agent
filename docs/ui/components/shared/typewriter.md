# Typewriter 打字机效果

## 一、职责

Typewriter 实现文本逐字显示的打字机动画效果。接收完整文本，按设定速率逐字渲染，直到全部显示完毕。用于 HomeView 的欢迎文本等需要视觉过渡的场景。

## 二、Props 定义

```typescript
interface TypewriterProps {
  text: string                   // 完整文本
  speed?: number                 // 每字符间隔（ms），默认 30
  onComplete?: () => void        // 全部显示完成回调
  children?: (displayedText: string) => React.ReactNode  // 渲染函数
}
```

## 三、行为规则

1. 组件挂载后，从空字符串开始，每隔 speed 毫秒增加一个字符
2. 当所有字符显示完毕后，调用 onComplete 回调（如果提供）
3. 如果 text Props 改变，重置动画从头开始

### 渲染方式

- 如果提供了 `children` 渲染函数，将 `displayedText` 传入由使用方渲染
- 如果未提供 `children`，默认使用 `<Text>` 组件直接渲染

## 四、与流式响应的关系

Typewriter 不用于 AI 流式响应的逐字显示。流式响应的增量渲染由 TextPart 组件直接订阅 Bus 事件实现，数据本身就是逐步到达的，不需要人工延迟。

Typewriter 仅用于已有完整文本但希望添加视觉过渡的场景。

## 五、使用场景

| 场景 | speed | 说明 |
|------|-------|------|
| HomeView 欢迎文本 | 30 | 副标题逐字出现 |

## 六、设计约束

1. **零 Context 依赖**：通过 Props 控制
2. **不处理流式数据**：仅用于静态文本的视觉效果
3. **定时器清理**：组件卸载时清除 setInterval

## 七、文档自检

- [x] Props 定义完整，含渲染函数模式
- [x] 与流式响应的区别已明确
- [x] 行为规则清晰（挂载 --> 逐字 --> 完成回调）
- [x] 使用场景已列举
