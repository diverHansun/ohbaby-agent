# session 模块 goals-duty.md

本文档定义 `session` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：session 模块负责管理会话的生命周期和元数据，为对话提供持久化的身份标识和组织结构。

**如果没有这个模块**：
- lifecycle 无法知道应该将消息写入哪个会话
- 用户无法恢复之前的对话
- 对话历史无法按项目分类管理
- 多会话场景下缺乏统一的管理入口

---

## 二、Design Goals（设计目标）

### G1: 简单可靠

会话管理是基础设施，必须保持简单、稳定。创建、读取、更新、删除操作应直观且不易出错。

### G2: 项目级组织

会话必须与项目关联，支持按项目浏览和管理。用户在不同项目间切换时，应能快速定位相关会话。

### G3: 支持恢复

用户意外退出后，应能看到最近的会话列表并选择继续。会话元数据应实时更新，确保状态准确。

### G4: 低耦合

session 模块只管理元数据，不涉及消息内容。与 Message 模块职责清晰分离，避免循环依赖。

### G5: 可扩展但克制

为未来功能（如会话分叉、标签分类）预留字段，但当前版本不实现这些功能。遵循 YAGNI 原则。

---

## 三、Duties（职责）

### D1: 会话 CRUD

提供会话的创建、读取、更新、删除基本操作：
- 创建会话时生成唯一 sessionId
- 按 sessionId 查询会话信息
- 更新会话元数据（标题、状态等）
- 删除会话

### D2: 与 Project 模块协作

通过调用 Project 模块获取项目信息：
- 创建会话时调用 `Project.fromDirectory(directory)` 获取 projectId
- 使用 Project 模块返回的 rootPath 作为项目目录
- 按 projectId 组织会话查询和列表

**不再负责**：项目 ID 生成、Git root 检测等逻辑已迁移至 Project 模块。

### D3: 会话列表管理

提供按不同维度列出会话的能力：
- 获取指定项目的所有会话
- 获取最近访问的会话（跨项目）
- 支持按时间排序

### D4: 元数据维护

管理会话的基本信息：
- 标题（默认自动生成，可手动编辑）
- 创建和更新时间戳
- 会话状态（active/archived）
- Agent 名称
- 父会话 ID（用于子代理会话）

### D4.1: 父子会话关系管理

支持子代理创建子会话：
- 创建会话时可指定 parentId
- 子会话继承父会话的 projectId
- 提供查询子会话列表的能力
- 父会话删除时可选择级联删除子会话

### D5: 统计信息维护

维护会话的统计数据：
- 消息数量
- 最后消息时间
- 接收 lifecycle 模块的主动更新调用

### D6: SQLite 元数据存储

将会话元数据持久化到 `services/database` 的 `session` 表：
- 以 `id` 作为主键
- 以 `project_id` 支持按项目查询
- 以 `updated_at` / `last_message_at` 支持最近会话列表
- 将不参与查询的扩展字段放入 `data` JSON 列
- 依赖 database 的事务、索引和 WAL 并发语义

### D7: 事件发布

通过 Bus 发布会话状态事件：
- `Session.Event.Created`：会话创建成功后发布
- 供 Commands 模块和 UI 层订阅

**注意**：`Session.Event.Switched` 事件由 Commands 模块发布，Session 模块仅提供数据接口。

---

## 四、Non-Duties（非职责）

### N1: 不负责消息内容管理

消息的存储、查询、格式化由 Message 模块负责。session 模块只维护会话级别的元数据。

### N2: 不负责执行循环协调

会话内对话的具体执行流程由 lifecycle 模块负责。session 模块只在循环开始前提供会话信息，循环结束后更新统计。

### N3: 不负责"当前会话"状态管理

哪个会话是"当前活跃"的，由 UI 层或调用层维护。session 模块不持有全局状态。

### N4: 不负责项目识别与 ID 生成

项目 ID 生成、Git root 检测等逻辑由 Project 模块负责。Session 模块只是使用 Project 返回的结果。

### N5: 不直接与 LLM 或工具交互

session 模块是纯数据管理层，不调用 LLM、不执行工具、不处理业务逻辑。

### N6: 不负责会话间的数据迁移

会话分叉、合并、导入导出等高级功能暂不在职责范围内（预留扩展可能）。

---

## 五、设计约束与假设

### 约束

1. **依赖 Database 模块**：使用 `services/database`（SQLite/Drizzle）读写 `session` 表
2. **单机环境**：当前版本不考虑多机同步；同一 DB 的写入由单后端入口协调
3. **不依赖 Storage 模块**：storage 只用于 artifact/log 等文件对象，不存 session 元数据
4. **依赖 Project 模块**：项目识别通过 Project 模块完成

### 假设

1. 同一 sessionId 可能被多个 runtime 路径读取；写入冲突由 database 的单后端入口、事务和 SQLite 锁语义约束
2. Database 模块已完成迁移并启用 WAL / foreign_keys / busy_timeout
3. Project 模块的 projectId 生成算法稳定

---

## 六、与其他模块的关系

| 模块 | 代码位置 | 关系 | 调用接口 | 说明 |
|------|----------|------|----------|------|
| Project | `src/project/` | 依赖 | `Project.fromDirectory()` | 创建会话时获取 projectId 和 rootPath |
| Message | `src/core/message/` | 依赖 | `Message.removeMessages()` | Session.remove() 调用 Message 清理关联消息 |
| lifecycle | `src/lifecycle/` | 被依赖 | `SessionManager.get/incrementStats` | lifecycle 在开始执行前获取 sessionId，结束后调用 incrementStats |
| SubagentExecutor | `src/agents/` | 被依赖 | `SessionManager.create` | 子代理执行时创建子会话 |
| Database | `src/services/database/` | 依赖 | `getDatabase()` + `schema.session` | 使用 SQLite/Drizzle 读写 session 表 |
| CLI/UI | `src/cli/` | 被依赖 | `SessionManager.list/create` | 用户界面调用 session 创建、列出、选择会话 |
| Bus | `src/bus/` | 依赖 | `Bus.publish()` | 发布 `Session.Event.Created` 事件 |
| Commands | `src/commands/` | 被依赖 | `SessionManager.get/create` | Commands 模块调用 Session 接口执行会话相关命令 |

**重要依赖说明**：Session 模块依赖 Project 模块获取 projectId，详见 `docs/project/dfd-interface.md`

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
