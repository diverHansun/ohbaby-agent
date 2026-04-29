# session 模块 dfd-interface.md

本文档描述 `services/session` 的数据流与对外接口。session 元数据持久化在 `services/database` 的 `session` 表中。

---

## 一、Context & Scope（上下文与范围）

```
CLI / UI / lifecycle / agents
        │
        ▼
SessionManager
        ├── Project.fromDirectory()
        ├── SessionStore
        │       └── getDatabase() + schema.session
        └── Bus.publish(Session.Event.Created)
```

### 交互模块

| 模块 | 方向 | 说明 |
|------|------|------|
| CLI/UI/Commands | 输入 | 创建、选择、列出会话 |
| lifecycle | 输入 | 获取会话、更新统计 |
| agents/SubagentExecutor | 输入 | 创建子会话 |
| Project | 输出 | 获取 projectId/rootPath |
| core/message | 输出 | 删除会话时清理关联消息 |
| services/database | 输出 | 读写 `session` 表 |
| Bus | 输出 | 发布会话创建等事件 |

---

## 二、Data Flow Description（数据流）

### 2.1 创建会话

```
调用方 create(projectDirectory, options)
  → SessionManager
  → Project.fromDirectory(projectDirectory)
  → 生成 sessionId 和 Session 元数据
  → SessionStore.insert(session)
       → db.insert(schema.session)
  → Bus.publish(Session.Event.Created)
  → 返回 Session
```

**关键语义**：
- 如果指定 `parentId`，SessionManager 先读取父会话并继承其 `projectId`
- `message_count` 初始为 0，`last_message_at` 初始为空或创建时间
- 创建成功后才发布事件

### 2.2 获取会话

```
get(sessionId)
  → SessionStore.get(sessionId)
       → db.select().from(schema.session).where(id = sessionId)
  → Session | null
```

不再遍历文件目录；`id` 是主键，按 sessionId 查询应是直接索引查询。

### 2.3 列出项目会话

```
listByProject(projectId, options)
  → SessionStore.listByProject(projectId, options)
       → WHERE project_id = projectId
       → optional status filter
       → ORDER BY updated_at DESC
       → optional LIMIT
  → Session[]
```

### 2.4 获取最近会话

```
getRecent(limit)
  → SessionStore.getRecent(limit)
       → ORDER BY updated_at DESC
       → LIMIT n
  → Session[]
```

### 2.5 更新统计信息

```
lifecycle/message 写入消息后
  → SessionManager.incrementStats(sessionId, delta)
  → SessionStore.updateStats(sessionId)
       → UPDATE session
          SET message_count = message_count + delta,
              last_message_at = now,
              updated_at = now
```

统计更新是显式调用，不由 database 自动触发。

### 2.6 创建子会话

```
SubagentExecutor createChild(parentSessionId, options)
  → SessionStore.get(parentSessionId)
  → 使用父会话 projectId 创建子 Session
  → withTransaction:
       INSERT child session
       UPDATE parent.data.childrenIds 或 parent metadata
  → 返回 child Session
```

若父子关系需要同时更新父会话和子会话，SessionStore 应使用 `withTransaction()` 保证原子性。

### 2.7 删除会话

```
remove(sessionId)
  → SessionStore.get(sessionId)
  → Message.removeMessages(sessionId)
  → SessionStore.remove(sessionId)
       → DELETE FROM session WHERE id = sessionId
  → 返回 void
```

删除消息内容由 Message 模块负责；session 模块只删除 session 元数据。

---

## 三、Interface Definition（接口定义）

```typescript
interface SessionManager {
  create(projectDirectory: string, options?: CreateSessionOptions): Promise<Session>
  get(sessionId: string): Promise<Session | null>
  listByProject(projectId: string, options?: ListSessionOptions): Promise<Session[]>
  getRecent(limit?: number): Promise<Session[]>
  update(sessionId: string, patch: UpdateSessionPatch): Promise<Session>
  incrementStats(sessionId: string, delta: SessionStatsDelta): Promise<Session>
  remove(sessionId: string, options?: RemoveSessionOptions): Promise<void>
}
```

### SessionStore 内部接口

```typescript
interface SessionStore {
  insert(session: Session): Promise<void>
  get(sessionId: string): Promise<Session | null>
  listByProject(projectId: string, options?: ListSessionOptions): Promise<Session[]>
  getRecent(limit: number): Promise<Session[]>
  update(sessionId: string, patch: UpdateSessionPatch): Promise<Session>
  remove(sessionId: string): Promise<void>
}
```

SessionStore 使用 `getDatabase()` 和 `schema.session`，但这些细节不暴露给调用方。

---

## 四、Data Ownership & Responsibility（数据归属）

| 数据 | 创建者 | 持久化位置 | 说明 |
|------|--------|------------|------|
| Session 元数据 | session 模块 | database `session` 表 | title/status/agent/project_id/stats |
| projectId/rootPath | Project 模块 | session 行中的 project_id/data | session 只消费结果 |
| Message/Part | message 模块 | database `message` / `part` 表 | session 不读取消息内容 |
| 会话事件 | session 模块 | Bus | 创建/状态变化时发布 |

---

## 五、文档自检

- [x] 所有持久化路径已改为 database
- [x] 不再引用 Storage 作为 session 依赖
- [x] 列表查询明确使用 SQL 过滤/排序
- [x] 父子会话的事务边界已说明
