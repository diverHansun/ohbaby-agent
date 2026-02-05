# usePermission 权限对话框 Hook

> 待撰写：usePermission 详细设计

## 职责

管理权限对话框状态，处理权限请求。

## 核心功能

- 订阅 `Permission.Event.Updated` 事件
- 维护当前权限请求
- 提供响应方法

## 返回值

```typescript
{
  currentRequest: PermissionRequest | null
  respond: (response: PermissionResponse) => void
}
```

## 与 DialogManager 的协作

待补充...
