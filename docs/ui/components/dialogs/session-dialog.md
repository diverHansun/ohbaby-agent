# SessionDialog 会话选择弹窗

## 一、职责

SessionDialog 显示已有会话列表，供用户切换到其他会话或新建会话。通过 `/session` 命令触发。

## 二、视觉结构

```
+-- Select Session ---------------------+
|                                       |
|    + New Session                      |
|  > main-session  (current)            |    ← 焦点项 + 当前标记
|    debug-session  2024-03-08          |
|    refactor-auth  2024-03-07          |
|                                       |
+---------------------------------------+
```

### 列表项显示

- 第一项固定为 "New Session" 选项，使用 `+` 前缀
- 后续项为已有会话，显示会话名称 + 创建日期
- 当前活跃会话显示 `(current)` 后缀标记
- 焦点项使用 `>` 前缀和高亮样式

## 三、交互设计

| 按键 | 行为 |
|------|------|
| Up / Down | 在会话列表间移动焦点 |
| Enter | 选中当前焦点项，调用 `onRespond` |
| Esc | 取消选择，调用 `onCancel` |

列表使用 shared/ScrollableList 组件。

## 四、数据输入

```typescript
interface SessionDialogData {
  type: 'session'
  sessions: SessionInfo[]        // 已有会话列表
  currentSessionId: string       // 当前会话 ID
}

interface SessionInfo {
  id: string                     // 会话 ID
  name: string                   // 会话名称
  createdAt: number              // 创建时间戳
}
```

数据来源：
- `sessions` 列表来自 session 模块的 `listSessions()` 接口
- `currentSessionId` 来自 SessionContext.sessionId

## 五、响应值

```typescript
// onRespond 的参数
interface SessionDialogResult {
  action: 'new' | 'switch'
  sessionId?: string             // switch 时提供目标会话 ID
}
```

请求方（/session 命令处理逻辑）根据 action 类型执行创建新会话或切换会话。

## 六、设计约束

1. **不直接操作会话**：只返回用户选择，由命令处理逻辑执行操作
2. **"New Session" 固定在首位**：不参与排序
3. **会话列表按时间倒序**：最新创建的排在前面
4. **打开时焦点定位到当前会话**：初始 selectedIndex 指向 currentSessionId 对应项

## 七、文档自检

- [x] 视觉结构已定义（New Session + 会话列表 + current 标记）
- [x] 交互规则符合统一规范（Up/Down + Enter + Esc）
- [x] 数据来源已说明
- [x] 响应值类型已定义（new / switch 两种 action）
- [x] 使用 ScrollableList 组件
