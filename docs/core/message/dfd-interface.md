# message 模块 dfd-interface.md

本文档描述 `core/message` 的数据流与接口。message/part 持久化在 `services/database` 中，Bus 只用于观察事件。

---

## 一、Context & Scope（上下文与范围）

```
lifecycle / tools / agents
        │
        ▼
MessageManager
        ├── MessageStore
        │       └── getDatabase() + schema.message/schema.part
        ├── MessageConverter
        └── Bus.publish(Message.Event.*)
```

### 交互模块

| 模块 | 方向 | 说明 |
|------|------|------|
| lifecycle | 输入 | 创建 user/assistant message，追加 step/tool parts |
| tool-scheduler | 输入 | 写入 ToolPart / ToolResultPart |
| agents/SubagentExecutor | 输入 | 写入 SubtaskPart |
| services/database | 输出 | 读写 `message` / `part` 表 |
| Bus | 输出 | 发布 Message/Part 更新事件 |
| LLM provider | 输出 | 通过 MessageConverter 获取模型消息 |

---

## 二、Data Flow Description（数据流）

### 2.1 创建 Message

```
createMessage(input)
  → factory 生成 id / timestamps / role
  → MessageStore.insertMessage(message)
       → db.insert(schema.message)
          columns: id, session_id, role, agent, created_at, updated_at, data
  → Bus.publish(Message.Event.Updated)
  → 返回 Message
```

`message.data` 不包含 Part 内容；Part 通过 `part` 表独立保存。

### 2.2 追加或更新 Part

```
appendPart(messageId, part)
  → MessageStore.upsertPart(part)
       → db.insert(schema.part).onConflictDoUpdate(...)
  → MessageStore.touchMessage(messageId)
  → Bus.publish(Message.Event.PartUpdated)
  → 返回 Part
```

**关键语义**：
- Part 可以流式更新，例如 TextPart delta 或 ToolPart 状态变化
- `order_index` 决定同一 message 下的展示顺序
- DB 写入成功后才发布事件

### 2.3 查询会话消息

```
listBySession(sessionId)
  → SELECT message WHERE session_id = ?
       ORDER BY created_at ASC
  → SELECT part WHERE session_id = ?
       ORDER BY message_id, order_index ASC
  → 组装 MessageWithParts[]
```

MessageStore 可以选择两次查询后在内存组装，避免 N+1 查询。database 只提供 schema 和连接，不负责组装领域对象。

### 2.4 转换为模型消息

```
toModelMessages(sessionId)
  → MessageStore.listBySession(sessionId)
  → MessageConverter.curate(history)
  → MessageConverter.toModelMessages(history)
  → 返回 provider 可消费的 messages
```

Converter 是纯函数，不访问 database 或 Bus。

### 2.5 删除会话消息

```
removeMessages(sessionId)
  → MessageStore.deleteBySession(sessionId)
       → DELETE part WHERE session_id = ?
       → DELETE message WHERE session_id = ?
  → Bus.publish(Message.Event.Removed / PartRemoved)
```

删除多表数据应使用 database transaction，避免删除了 message 但残留 part。

### 2.6 崩溃恢复相关查询

runtime/run-manager 或恢复逻辑不直接扫描 JSON 文件，而是通过 message/part 表查询：

```sql
SELECT *
FROM part
WHERE session_id = ?
  AND type = 'step-start'
ORDER BY created_at DESC;
```

具体恢复语义属于 runtime/run-ledger 和 run-manager；message 只保证 Part 可查询。

---

## 三、Interface Definition（接口定义）

```typescript
interface MessageManager {
  createMessage(input: CreateMessageInput): Promise<Message>
  updateMessage(messageId: string, patch: UpdateMessagePatch): Promise<Message>
  appendPart(messageId: string, part: Part): Promise<Part>
  updatePart(partId: string, patch: UpdatePartPatch): Promise<Part>
  listBySession(sessionId: string): Promise<MessageWithParts[]>
  removeMessage(messageId: string): Promise<void>
  removeMessages(sessionId: string): Promise<void>
  toModelMessages(sessionId: string): Promise<ModelMessage[]>
}
```

### MessageStore 内部接口

```typescript
interface MessageStore {
  insertMessage(message: Message): Promise<void>
  updateMessage(messageId: string, patch: UpdateMessagePatch): Promise<Message>
  upsertPart(part: Part): Promise<void>
  updatePart(partId: string, patch: UpdatePartPatch): Promise<Part>
  listBySession(sessionId: string): Promise<MessageWithParts[]>
  deleteBySession(sessionId: string): Promise<void>
}
```

---

## 四、Data Ownership & Responsibility（数据归属）

| 数据 | 创建者 | 持久化位置 | 说明 |
|------|--------|------------|------|
| Message 行 | message 模块 | database `message` 表 | role/session/agent/timestamps + data JSON |
| Part 行 | message 模块 | database `part` 表 | type/order/session/message + data JSON |
| Message 事件 | message 模块 | Bus | 仅观察流 |
| Snapshot artifact | snapshot/storage | storage + database pointer | message 只可引用 snapshot id/cursor |

---

## 五、文档自检

- [x] 所有数据流已从 Storage 文件操作改为 database 表操作
- [x] Part 流式 upsert 和顺序语义清晰
- [x] Bus 不再被描述为持久化路径
- [x] 删除多表数据的事务边界已说明
