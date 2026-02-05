# MessageList 消息列表

> 待撰写：消息列表详细设计

## 职责

- 渲染消息列表
- 支持虚拟化（只渲染可见区域）
- 自动滚动到底部
- 消息类型路由分发

## 虚拟化设计

消息列表使用虚拟化技术优化性能：

- 只渲染可见区域的消息
- 不可见消息只占位，不创建 React 组件
- 滚动时动态替换渲染内容

参考 gemini-cli 的 VirtualizedList 实现。

## Props 定义

待补充...

## 消息类型路由

```tsx
function renderMessage(message: Message) {
  switch (message.role) {
    case 'user':
      return <UserMessage ... />
    case 'assistant':
      return <AssistantMessage ... />
    case 'system':
      return <SystemMessage ... />
  }
}
```
