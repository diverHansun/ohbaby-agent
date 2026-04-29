# message 模块 test.md

本文档描述 `core/message` 的测试范围与验证策略。测试重点是消息/Part 领域语义、database 持久化和事件发布顺序。

---

## 一、Test Scope（测试范围）

### 覆盖

| 职责 | 测试重点 |
|------|----------|
| Message CRUD | message 表插入、更新、删除 |
| Part CRUD / streaming | part 表 upsert、order_index、delta 更新 |
| Session 查询 | 按 session_id 读取并组装 MessageWithParts |
| Converter | curated history 与 provider message 转换 |
| Event publishing | DB 写入成功后发布 Message.Event.* |
| 多表删除 | message/part 删除使用事务保持一致 |

### 不覆盖

- database pragma / 迁移基础设施（services/database 测试）
- storage artifact 文件读写（services/storage 测试）
- lifecycle 的执行循环
- tool-scheduler 的工具执行结果正确性

---

## 二、Critical Scenarios（关键场景）

| 场景 | 预期结果 |
|------|----------|
| 创建 user message | `message` 表有对应行，role/session_id 正确，发布 Updated |
| 创建 assistant message 后追加 TextPart | `part` 表有对应行，message.updated_at 前进，发布 PartUpdated |
| 流式更新同一 Part | upsert 后只保留一行，data JSON 为最新内容 |
| 多个 Part 顺序读取 | 按 `order_index` 组装，顺序稳定 |
| listBySession | 返回 MessageWithParts[]，不产生 N+1 文件遍历 |
| removeMessages(sessionId) | message/part 表相关行全部删除 |
| removeMessages 中途失败 | transaction 回滚，不留下半删除状态 |
| DB 写入失败 | 不发布成功事件，错误向上透传 |
| toModelMessages | 过滤/转换结果符合 provider 输入要求 |
| 并发追加 Part | 每个 partId 唯一，最终可按 order_index 读取 |

---

## 三、Integration Points（集成点）

### 与 services/database

使用真实 database 模块：
- 初始化临时 SQLite 或内存 DB
- 通过 MessageManager 写入 message/part
- 直接查询 `schema.message` / `schema.part` 验证字段和 JSON data
- 验证外键或 transaction 失败时的行为

### 与 Bus

使用 fake Bus 记录事件：
- 成功写入后才发布事件
- 失败写入不发布事件
- PartUpdated payload 包含 sessionId/messageId/partId

### 与 Session

message 不直接维护 session 统计；统计更新由 lifecycle/session 协作测试覆盖。message 测试只验证 `session_id` 正确落库和查询。

---

## 四、Verification Strategy（验证策略）

### 单元测试

| 组件 | 策略 |
|------|------|
| MessageManager | fake MessageStore + fake Bus，验证调用顺序和事件 |
| MessageStore | 真实 database，验证 Drizzle 查询和映射 |
| MessageConverter | 纯函数测试 |
| factory/idGenerator | 纯函数测试 |

### 集成测试

- 使用真实 database，不 mock Drizzle
- 每个测试独立初始化 DB
- 使用 fake Bus 捕获事件
- 不使用 services/storage mock，因为 message 不再依赖 storage

---

## 五、文档自检

- [x] 测试范围已从 Storage 文件读写迁移到 database
- [x] 覆盖流式 Part 更新和顺序
- [x] 覆盖 DB 成功后再发布事件的不变量
- [x] 不重复测试 database 基础设施
