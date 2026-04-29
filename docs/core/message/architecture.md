# message 模块 architecture.md

本文档描述 `core/message` 模块在 SQLite 持久化方案下的内部结构。message 模块负责消息与 Part 的领域语义、读写顺序和事件广播；底层结构化持久化由 `services/database` 提供。

---

## 一、Architecture Overview（总体架构）

```
lifecycle / tool-scheduler / agents
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ MessageManager                                               │
│ - create/update/remove message                               │
│ - append/update/remove part                                  │
│ - publish Message.Event.*                                    │
└───────────────┬───────────────────────────────┬─────────────┘
                │                               │
                ▼                               ▼
        MessageStore                    MessageConverter
        getDatabase() + schema           toModelMessages()
        message / part tables            curated history
                │
                ▼
        services/database
```

### 主要组件

| 组件 | 职责 |
|------|------|
| **MessageManager** | 对外 API，维护消息/Part 生命周期，决定何时发布事件 |
| **MessageStore** | 封装 `message` / `part` 表读写，不发布事件 |
| **MessageConverter** | 将内部 MessageWithParts 转换为 LLM SDK 消息 |
| **factory.ts** | 创建 Message / Part 的默认字段和 ID |
| **events.ts** | 事件类型定义 |

---

## 二、Database Persistence Model（数据库持久化模型）

message 模块使用两张表：

| 表 | 用途 |
|----|------|
| `message` | 保存 message 级别索引字段：id、session_id、role、agent、created_at、updated_at；`data` JSON 保存除 Part 内容外的 Message 领域字段 |
| `part` | 保存每个 Part：id、message_id、session_id、type、order_index、timestamps；`data` JSON 保存完整 Part 对象 |

### 为什么 Part 独立成表

- 支持流式输出：assistant 消息可以先创建，再逐步 upsert Part
- 支持按 session 查询运行状态：例如查找 step-start 但没有 step-finish 的 run 线索
- 支持细粒度事件：PartUpdated 不需要重写完整 message blob
- 支持 database 索引：`session_id`、`message_id/order_index`、`type` 可参与查询

---

## 三、Design Pattern & Rationale（设计模式与理由）

### 1. 分层架构

MessageManager 处理领域语义和事件，MessageStore 处理数据库读写，MessageConverter 保持纯函数。这样可以分别测试业务行为、SQL 映射和格式转换。

### 2. Store 作为内部 Repository

MessageStore 是内部 repository-like 层，依赖 `services/database` 的 `getDatabase()` 和 `schema`。它不作为公共 API 导出，避免外部绕过 MessageManager 的事件发布和顺序约束。

### 3. 无内存缓存

每次查询从 database 读取最新数据。daemon 模式下可能有 scheduler、用户输入、runtime worker 等多个路径写同一 session；缓存会增加一致性风险。

### 4. 事件与持久化顺序

写入 database 成功后再发布 Bus 事件。若 DB 写入失败，不发布成功事件，避免 UI 或 runtime 观察到不存在的数据。

---

## 四、Module Structure & File Layout（模块结构）

```
src/core/message/
├── index.ts          # 公共 API
├── manager.ts        # MessageManager
├── store.ts          # MessageStore，依赖 services/database
├── converter.ts      # MessageConverter
├── types.ts          # Message / Part / MessageWithParts
├── factory.ts        # 创建工厂
├── id-generator.ts   # ID 生成
├── events.ts         # Message.Event.*
└── __tests__/
```

### 文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `manager.ts` | 领域协调 | 调用 store，发布事件，维护顺序 |
| `store.ts` | 数据访问 | 读写 `schema.message` / `schema.part` |
| `converter.ts` | 纯转换 | 面向 LLM SDK 的消息格式转换 |
| `factory.ts` | 创建逻辑 | ID、时间戳、默认字段 |

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1：SQLite vs JSON 文件

**当前选择**：SQLite `message` / `part` 表。

**理由**：message/part 需要按 session、message、type、时间查询，也要支持 daemon 多 Run 写入和崩溃恢复。JSON 文件遍历无法可靠支持这些查询。

### 约束 2：JSON 列保留领域弹性

Message 和 Part 类型演进较快。索引字段拆成关系型列，复杂内容放入 `data` JSON 列，可以减少迁移频率，同时保留 SQL 查询能力。

### 约束 3：Part 顺序显式化

Part 使用 `order_index` 保证读取顺序。不能依赖插入时间推断最终展示顺序，因为流式更新、重试和工具结果可能乱序到达。

### 约束 4：Bus 只做观察流

Bus 事件用于 UI / runtime 订阅更新，不作为 database 写入确认机制。database 是消息持久化的权威来源。

---

## 六、扩展预留点

| 扩展功能 | 预留方式 |
|----------|----------|
| 消息压缩 | CompactionPart / data JSON |
| 子任务 | SubtaskPart |
| turn 级回滚 | snapshot 的 message cursor 指向 message/part 表位置 |
| 成本统计 | StepFinishPart data + message/part 索引 |

---

## 七、文档自检

- [x] MessageStore 已从 Storage 文件读写改为 database 表读写
- [x] message/part 的关系型列与 JSON 列分工清晰
- [x] 写入成功后再发布事件的顺序已说明
- [x] 不再保留旧的 storage path 设计
