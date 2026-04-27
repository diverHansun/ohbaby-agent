# session 模块 dfd-interface.md

本文档描述 `session` 模块的数据流与对外接口。数据流优先，接口从属于数据流。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

session 模块位于 ohbaby-code 的服务层，作为会话元数据管理的中心：

```
┌─────────────────────────────────────────────────────────────────┐
│ 调用层（CLI / UI）                                               │
└────────────────────────┬────────────────────────────────────────┘
                         │ 创建/获取/列出会话
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SessionManager                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 管理会话元数据，提供 CRUD 和项目关联功能                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────┬───────────┬───────────┬────────────────────────────────┘
         │           │           │
         ▼           ▼           ▼
     lifecycle      Message       Storage
```

### 交互模块

| 模块 | 代码位置 | 交互方向 | 说明 |
|------|----------|----------|------|
| CLI/UI | `src/cli/` | 输入 | 接收创建会话、列出会话等请求 |
| lifecycle | `src/lifecycle/` | 输入 | 获取 sessionId，更新统计 |
| SubagentExecutor | `src/agents/` | 输入 | 创建子会话 |
| Project | `src/project/` | 输出 | 调用 `Project.fromDirectory()` 获取 projectId |
| Message | `src/core/message/` | 输出 | 删除会话时调用 `Message.removeMessages()` |
| Storage | `src/storage/` | 输出 | 持久化会话数据到文件系统 |

---

## 二、Data Flow Description（数据流描述）

### 主数据流 1：创建新会话

```
1. [外部] CLI/UI 发起创建会话请求
   └── 输入：projectDirectory, title?, agentName?
   
2. [SessionManager] 调用 Project 模块识别项目
   ├── 调用 Project.fromDirectory(projectDirectory)
   └── 得到 { id: projectId, rootPath: projectRoot, vcs }
   
3. [SessionManager] 生成会话数据
   ├── 生成 sessionId（时间戳 + 随机数）
   ├── 初始化 Session 对象
   │   ├── id, projectId
   │   ├── title（默认或用户提供）
   │   ├── agentName（默认 'default'）
   │   ├── createdAt, updatedAt（当前时间）
   │   ├── status: 'active'
   │   └── stats: { messageCount: 0, lastMessageAt: createdAt }
   └── 构建完整 Session 对象

4. [SessionStore] 持久化会话
   ├── 调用 Storage.write(["session", projectId, sessionId], session)
   └── 文件写入 ~/.local/share/ohbaby-code/storage/session/<projectId>/<sessionId>.json

5. [外部] 返回创建的 Session 对象
   └── 包含 sessionId，供后续使用
```

**注意**：项目识别逻辑已迁移至 Project 模块，详见 `docs/project/dfd-interface.md`

### 主数据流 2：获取会话

```
1. [外部] 根据 sessionId 获取会话
   └── 输入：sessionId
   
2. [SessionManager] 读取会话数据
   ├── 调用 SessionStore.get(sessionId)
   └── SessionStore 调用 Storage.read(["session", "*", sessionId])
       └── 遍历所有项目目录查找

3. [外部] 返回 Session 对象或 null
```

### 主数据流 3：列出项目会话

```
1. [外部] 获取指定项目的会话列表
   └── 输入：projectId, options?
   
2. [SessionManager] 查询会话
   ├── 调用 SessionStore.listByProject(projectId, options)
   ├── SessionStore 调用 Storage.list(["session", projectId])
   └── 读取所有匹配的 JSON 文件

3. [SessionManager] 过滤和排序
   ├── 按 status 过滤（如只要 active）
   ├── 按 updatedAt 排序
   └── limit 限制数量

4. [外部] 返回 Session 数组
```

### 主数据流 4：更新统计信息

```
1. [lifecycle] 写入消息后调用更新
   └── 输入：sessionId, delta: { messageCount: +1 }
   
2. [SessionManager] 增量更新统计
   ├── 调用 SessionStore.get(sessionId) 读取当前会话
   ├── 更新 stats.messageCount += delta.messageCount
   ├── 更新 stats.lastMessageAt = Date.now()
   ├── 更新 updatedAt = Date.now()
   └── 调用 SessionStore.update(sessionId, updatedSession)

3. [SessionStore] 持久化更新
   └── 调用 Storage.write(["session", projectId, sessionId], session)
```

### 主数据流 5：获取最近会话

```
1. [外部] 获取最近访问的会话（跨项目）
   +-- 输入：limit?

2. [SessionManager] 读取所有会话
   |-- 调用 SessionStore.getRecent(limit)
   |-- SessionStore 调用 Storage.list(["session"])
   |   +-- 遍历所有项目目录
   |-- 读取所有会话 JSON 文件
   |-- 按 updatedAt 降序排序
   +-- 取前 N 个

3. [外部] 返回 Session 数组
```

### 主数据流 6：创建子会话（子代理）

```
1. [SubagentExecutor] 创建子代理会话
   +-- 输入：parentSessionId, title, agentName

2. [SessionManager] 获取父会话
   |-- 调用 SessionStore.get(parentSessionId)
   +-- 获取父会话的 projectId

3. [SessionManager] 创建子会话
   |-- 生成 sessionId
   |-- 设置 parentId = parentSessionId
   |-- 继承 projectId 从父会话
   |-- 设置 agentName（子代理名称）
   +-- 设置 title（任务描述）

4. [SessionManager] 更新父会话
   |-- 将子 sessionId 添加到父会话的 childrenIds
   +-- 持久化父会话

5. [SessionStore] 持久化子会话
   +-- 调用 Storage.write(["session", projectId, sessionId], session)

6. [SubagentExecutor] 返回创建的子会话
   +-- 包含 sessionId，用于子代理 Lifecycle
```

### 主数据流 7：获取子会话列表

```
1. [外部] 获取指定会话的子会话
   +-- 输入：sessionId

2. [SessionManager] 读取父会话
   |-- 调用 SessionStore.get(sessionId)
   +-- 获取 childrenIds 列表

3. [SessionManager] 批量获取子会话
   |-- 遍历 childrenIds
   +-- 调用 SessionStore.get() 读取每个子会话

4. [外部] 返回子会话数组
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外接口（公共 API）

#### SessionManager.create()

创建新会话。

```
输入：
  - projectDirectory: string - 项目目录路径
  - options?: {
      title?: string          // 会话标题，默认自动生成
      agentName?: string      // Agent 名称，默认 'default'
      parentId?: string       // 父会话 ID（子代理会话必填）
      isSubagent?: boolean    // 是否为子代理会话（默认 false）
    }

输出：
  - Promise<Session>

说明：
  - 自动识别项目 ID（或从父会话继承）
  - 生成唯一 sessionId
  - 立即持久化到文件系统
  - 如果指定 parentId，自动更新父会话的 childrenIds
  - 如果 isSubagent = true，设置 session.isSubagent = true
```

#### SessionManager.get()

根据 sessionId 获取会话。

```
输入：
  - sessionId: string

输出：
  - Promise<Session | null>

说明：
  - 如果会话不存在，返回 null
```

#### SessionManager.getByProject()

获取指定项目的所有会话。

```
输入：
  - projectId: string
  - options?: {
      status?: SessionStatus     // 过滤状态
      limit?: number             // 限制数量
      orderBy?: 'createdAt' | 'updatedAt'
      order?: 'asc' | 'desc'
    }

输出：
  - Promise<Session[]>

说明：
  - 默认按 updatedAt 降序排序
  - 支持状态过滤
```

#### SessionManager.getRecent()

获取最近访问的会话（跨项目）。

```
输入：
  - limit?: number - 返回数量，默认 10

输出：
  - Promise<Session[]>

说明：
  - 按 updatedAt 降序排序
  - 用于会话恢复场景
```

#### SessionManager.update()

更新会话元数据。

```
输入：
  - sessionId: string
  - updates: {
      title?: string
      agentName?: string
      status?: SessionStatus
    }

输出：
  - Promise<Session>

说明：
  - 只更新提供的字段
  - 自动更新 updatedAt
```

#### SessionManager.touch()

更新会话的 updatedAt 时间戳。

```
输入：
  - sessionId: string

输出：
  - Promise<void>

说明：
  - 标记会话为最近访问
  - 用于排序和恢复
```

#### SessionManager.incrementStats()

增量更新会话统计信息。

```
输入：
  - sessionId: string
  - delta: {
      messageCount?: number  // 增量值，如 +1
    }

输出：
  - Promise<void>

说明：
  - lifecycle 模块写入消息后调用
  - 自动更新 lastMessageAt 和 updatedAt
```

#### SessionManager.delete()

删除会话。

```
输入：
  - sessionId: string

输出：
  - Promise<void>

说明：
  - 调用 Message.removeMessages(sessionId) 删除关联消息
  - 然后删除会话元数据文件
```

#### SessionManager.archive()

归档会话。

```
输入：
  - sessionId: string

输出：
  - Promise<void>

说明：
  - 将 status 更新为 'archived'
  - 从活跃列表中移除，但不删除
```

#### SessionManager.getProjectId()

获取或创建项目 ID。

```
输入：
  - projectDirectory: string

输出：
  - Promise<string>

说明：
  - 优先使用 git root commit hash
  - fallback 到目录路径 hash
  - 同一目录多次调用返回相同 ID
```

#### SessionManager.getChildren()

获取指定会话的子会话列表。

```
输入：
  - sessionId: string - 父会话 ID

输出：
  - Promise<Session[]>

说明：
  - 返回所有子代理创建的子会话
  - 按 createdAt 升序排序
  - 用于查看子代理执行历史
```

#### SessionManager.getParent()

获取指定会话的父会话。

```
输入：
  - sessionId: string - 子会话 ID

输出：
  - Promise<Session | null>

说明：
  - 如果是子会话，返回其父会话
  - 如果是主会话（无 parentId），返回 null
```

#### SessionManager.isSubagentSession()

判断会话是否为子代理会话。

```
输入：
  - sessionId: string

输出：
  - Promise<boolean>

说明：
  - 返回 session.isSubagent 的值
  - 用于快速判断会话类型，决定上下文隔离策略
```

### 3.2 依赖接口（需要注入的依赖）

#### Storage 接口

```
read<T>(key: string[]): Promise<T | null>
  - 读取指定路径的 JSON 文件

write<T>(key: string[], data: T): Promise<void>
  - 写入 JSON 文件，自动创建目录

list(prefix: string[]): Promise<string[][]>
  - 列出匹配前缀的所有文件路径

delete(key: string[]): Promise<void>
  - 删除指定文件
```

#### Message 接口

```
removeMessages(sessionId: string): Promise<void>
  - 删除指定会话的所有消息和 Part
  - Session.delete() 调用此接口清理消息
```

### 3.3 发布的事件（通过 Bus）

Session 模块通过 Bus 发布以下事件，供 Commands 模块和 UI 层订阅。

#### Session.Event.Created

**语义**：通知新会话已创建

**携带数据**：
```typescript
// src/services/session/events.ts
import { BusEvent } from '@/bus/bus-event'
import { z } from 'zod'

export namespace Session {
  export const Event = {
    Created: BusEvent.define("session.created", z.object({
      sessionId: z.string(),        // 新会话 ID
      projectId: z.string(),        // 项目 ID
      title: z.string(),            // 会话标题
      parentId: z.string().optional(), // 父会话 ID（子代理会话）
    })),
  }
}
```

**订阅者**：CLI/UI 层、lifecycle

**触发时机**：`SessionManager.create()` 成功创建会话后

---

#### Session.Event.Switched

**语义**：通知会话已切换

**携带数据**：
```typescript
Switched: BusEvent.define("session.switched", z.object({
  previousSessionId: z.string().optional(),  // 之前的会话 ID（可能为空）
  currentSessionId: z.string(),              // 当前会话 ID
  messages: z.array(z.unknown()),            // 会话消息历史（供 lifecycle 加载）
})),
```

**订阅者**：lifecycle（用于加载会话消息历史）、CLI/UI 层

**触发时机**：Commands 模块执行 `session.choose` 命令时发布

**注意**：此事件由 Commands 模块在调用 Session 接口后发布，而非 Session 模块直接发布。Session 模块仅提供数据，Commands 负责协调和事件发布。

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| Session 元数据 | SessionManager | 通过 create() 创建 |
| sessionId | SessionManager | generateSessionId() 生成 |
| projectId | ProjectIdentifier | 计算 git hash 或 path hash |
| stats 初始值 | SessionManager | 创建时初始化为 0 |

### 数据更新责任

| 数据 | 更新者 | 说明 |
|------|--------|------|
| title, agentName | SessionManager | 通过 update() 修改 |
| status | SessionManager | 通过 archive() 修改 |
| updatedAt | SessionManager | 任何修改都自动更新 |
| stats.messageCount | lifecycle 触发 | 调用 incrementStats() |
| stats.lastMessageAt | lifecycle 触发 | 调用 incrementStats() |

### 数据删除责任

| 数据 | 删除者 | 说明 |
|------|--------|------|
| Session 文件 | SessionManager | 通过 delete() 删除 |
| 相关消息 | Message 模块 | Session 删除不自动删除消息 |

### 数据持有责任

| 数据 | 持有者 | 说明 |
|------|--------|------|
| 会话元数据 | session 模块 | 完全归 session 管理 |
| 消息内容 | Message 模块 | session 不涉及 |
| 当前活跃会话 | CLI/UI 层 | session 不维护全局状态 |

---

## 五、接口使用示例（概念说明）

### 创建并使用会话

```typescript
// 伪代码，说明接口使用方式

// 1. 创建新会话
const session = await sessionManager.create('/path/to/project', {
  title: '实现登录功能'
})

// 2. 在 lifecycle 中使用
const loop = new Lifecycle(deps)
for await (const event of loop.run(session.id, userRequest)) {
  // 执行对话
}

// 3. lifecycle 写入消息后更新统计
await messageManager.updateMessage(userMessage)
await sessionManager.incrementStats(session.id, { messageCount: 1 })

// 4. 更新会话时间戳
await sessionManager.touch(session.id)
```

### 列出和恢复会话

```typescript
// 获取项目下的所有活跃会话
const sessions = await sessionManager.getByProject(projectId, {
  status: 'active',
  orderBy: 'updatedAt',
  order: 'desc'
})

// 获取最近访问的会话（跨项目）
const recentSessions = await sessionManager.getRecent(10)

// 恢复某个会话
const session = recentSessions[0]
// 继续对话...
```

---

## 六、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义关注语义，未绑定具体实现
- [x] 明确了与 Message 模块的协作方式
- [x] 项目 ID 生成逻辑清晰
- [x] 统计更新机制明确（主动调用，非事件驱动）
