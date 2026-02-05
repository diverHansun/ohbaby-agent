# useHistory 输入历史 Hook

> 待撰写：useHistory 详细设计

## 职责

管理输入历史，支持 ↑/↓ 导航。

## 核心功能

- 记录提交的输入
- ↑ 键获取上一条历史
- ↓ 键获取下一条历史
- 循环导航

## 返回值

```typescript
{
  history: string[]
  currentIndex: number
  navigateUp: () => string | undefined
  navigateDown: () => string | undefined
  addToHistory: (input: string) => void
}
```
