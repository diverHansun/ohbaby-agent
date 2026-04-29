# session 模块 test.md

本文档描述 `services/session` 的测试策略。session 测试关注会话元数据语义、Project 协作和 database 持久化。

---

## 一、Test Scope（测试范围）

### 覆盖

| 职责 | 测试重点 |
|------|----------|
| D1: 会话 CRUD | 创建、读取、更新、删除 |
| D2: 与 Project 协作 | 使用 Project 返回的 projectId/rootPath |
| D3: 会话列表管理 | SQL 过滤、排序、limit |
| D4/D4.1: 元数据与父子关系 | status/title/agent/parentId/childrenIds |
| D5: 统计信息维护 | message_count、last_message_at、updated_at |
| D6: SQLite 元数据存储 | 使用真实 database schema.session 验证持久化 |

### 不覆盖

- Message/Part 内容读写（core/message 测试）
- Database pragma、迁移、外键基础设施（services/database 测试）
- Storage 文件对象读写（services/storage 测试）
- Project 模块内部 git 检测算法（Project 模块测试）

---

## 二、Critical Scenarios（关键场景）

| 场景 | 预期结果 |
|------|----------|
| 创建会话 | 插入 `session` 表，返回完整 Session，发布 Created 事件 |
| 获取不存在会话 | 返回 null，不产生副作用 |
| 按项目列出 | `project_id` 过滤正确，按 `updated_at` 降序 |
| 获取最近会话 | 跨项目按 `updated_at` 降序，limit 生效 |
| 更新标题/status | 只更新指定字段，`updated_at` 前进 |
| incrementStats | `message_count` 增量正确，`last_message_at` 更新 |
| 创建子会话 | 子会话继承父会话 `projectId`，父子关系原子更新 |
| 删除会话 | 调用 Message 清理后删除 `session` 行 |
| 并发创建 | sessionId 唯一，所有行可查询 |
| database 写失败 | 不发布成功事件，错误向上透传 |

---

## 三、Integration Points（集成点）

### 与 services/database

使用真实 database 模块和临时 SQLite / 内存 DB：
- 初始化 schema
- 通过 SessionManager 创建多条会话
- 直接查询 `schema.session` 验证字段落库
- 验证 list/getRecent 不依赖文件遍历

### 与 Project

单元层可 mock Project 模块返回固定 projectId；集成层使用 Project fixture 验证同一目录返回稳定 projectId。

### 与 Message

删除会话时 mock Message.removeMessages，验证调用顺序：先清理消息，再删除 session 元数据。若 Message 清理失败，session 行不应被删除。

---

## 四、Verification Strategy（验证策略）

### 单元测试

| 组件 | 策略 |
|------|------|
| SessionManager | mock SessionStore / Project / Bus / Message，验证业务语义 |
| SessionStore | 使用真实 database 模块，验证 Drizzle 查询和映射 |
| idGenerator | 纯函数测试，验证格式和唯一性 |

### 集成测试

- 使用临时 SQLite 或 `:memory:` database
- 每个测试独立初始化 database，结束后关闭连接
- 不 mock database，避免掩盖 schema 与查询不匹配

---

## 五、文档自检

- [x] 测试语义已从 Storage 文件读写迁移到 database
- [x] 覆盖父子会话事务边界
- [x] 保留 Project/Message/Bus 的协作测试
- [x] 未把 database 基础设施测试重复放入 session 模块
