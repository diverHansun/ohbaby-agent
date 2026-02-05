# DialogManager 对话框队列管理器

> 待撰写：DialogManager 详细设计

## 职责

管理对话框队列，确保一次只显示一个对话框。

## 队列管理

```typescript
interface DialogQueue {
  queue: DialogRequest[]
  current: DialogRequest | null
}

// 流程
enqueue(dialog) → 如果 current 为空，立即显示
用户响应 → dequeue() → 显示下一个或清空 current
```

## 为什么不叠加显示？

- 终端 UI 中按钮组件容易错位
- 用户体验更清晰（一次专注一个决策）
- 实现更简单可靠

## API 设计

待补充...
