# session 模块 architecture.md

本文档描述 `services/session` 模块在 SQLite 持久化方案下的内部结构。session 只管理会话元数据，不管理消息内容。

---

## 一、Architecture Overview（总体架构）

session 模块采用简单分层架构：`SessionManager` 负责业务语义，`SessionStore` 负责数据库读写，Project 模块负责项目识别。

```
CLI / Commands / lifecycle / agents
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ SessionManager                                               │
│ - create / get / list / update / remove                      │
│ - 维护 title/status/messageCount/lastMessageAt 等元数据       │
│ - 发布 Session.Event.Created                                 │
└───────────────┬───────────────────────────────┬─────────────┘
                │                               │
                ▼                               ▼
        Project 模块                    SessionStore
        Project.fromDirectory()          getDatabase() + schema.session
                                                │
                                                ▼
                                      services/database
                                      session table
```

### 主要组件

| 组件 | 职责 |
|------|------|
| **SessionManager** | 对外 API 入口，实现会话生命周期和元数据更新 |
| **SessionStore** | 封装 `session` 表查询，不包含业务决策 |
| **idGenerator** | 生成 sessionId |
| **types.ts** | Session、CreateSessionOptions、ListOptions 等类型 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 分层架构

SessionManager 不直接拼 SQL，SessionStore 不决定业务状态迁移。这样可以独立测试“业务语义”和“数据库查询”。

### 2. Repository-like Store

SessionStore 是本模块内部的 repository-like 层。它可以使用 Drizzle 和 `schema.session` 构造查询，但不对外暴露数据库细节。

### 3. Project 模块外置

项目识别、git root 检测和 projectId 生成由 Project 模块负责。session 只消费 Project 返回的 `projectId/rootPath`，避免把项目管理逻辑重新塞回 session。

### 4. 不使用 Storage

session 元数据需要按项目、更新时间、状态查询，也需要和 message/part/run 等结构化数据保持一致，因此使用 `services/database`。`services/storage` 只用于文件对象，不作为 session 的依赖。

---

## 三、Module Structure & File Layout（模块结构）

```
src/services/session/
├── index.ts            # 模块入口，导出公共 API
├── manager.ts          # SessionManager
├── store.ts            # SessionStore，依赖 services/database
├── types.ts            # Session / CreateSessionOptions / ListOptions
├── id-generator.ts     # sessionId 生成
├── events.ts           # Session 事件定义
└── __tests__/
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `manager.ts` | 核心逻辑 | 创建、更新、删除、统计维护、事件发布 |
| `store.ts` | 数据访问 | 读写 `schema.session`，封装 Drizzle 查询 |
| `types.ts` | 类型定义 | Session 领域类型和选项 |
| `id-generator.ts` | 工具函数 | 生成稳定唯一的 sessionId |

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1：SQLite vs JSON 文件

**当前选择**：SQLite `session` 表。

**理由**：recent sessions、project sessions、status filter、messageCount 更新都属于结构化查询。JSON 文件需要遍历目录，无法可靠支撑 daemon 并发和崩溃恢复。

### 约束 2：SessionStore 内部化

SessionStore 是内部实现，不作为公共 API 导出。调用方只依赖 SessionManager，避免外部绕过事件发布或业务校验直接改表。

### 约束 3：统计更新主动调用

message/lifecycle 在合适时机主动调用 `incrementStats()` 或等价方法更新 `message_count`、`last_message_at`。事件驱动可作为后续优化，但 MVP 用显式调用保持路径清晰。

---

## 五、扩展预留点

| 扩展功能 | 预留方式 |
|----------|----------|
| 会话分叉 | `parent_id` 字段 |
| 标签系统 | `data` JSON 列 |
| 会话归档 | `status` 字段 |
| 最近会话查询优化 | `updated_at` / `last_message_at` 索引 |

---

## 六、文档自检

- [x] SessionStore 已从 Storage 文件读写改为 database 表读写
- [x] Project 识别职责不再放在 session 内部
- [x] session 与 message 的职责边界清晰
- [x] 架构保持简单，没有引入额外服务层
