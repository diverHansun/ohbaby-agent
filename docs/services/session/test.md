# session 模块 test.md

本文档描述 `session` 模块的测试策略与验证方法。测试围绕职责而非代码结构，关注交互边界而非内部实现。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责（对应 goals-duty.md）：

| 职责 | 测试重点 |
|------|----------|
| D1: 会话 CRUD | 验证创建、读取、更新、删除的正确性 |
| D2: 项目识别与关联 | 验证 projectId 生成的稳定性和一致性 |
| D3: 会话列表管理 | 验证列表、过滤、排序功能 |
| D4: 元数据维护 | 验证标题、时间戳、状态等字段的正确更新 |
| D5: 统计信息维护 | 验证统计数据的增量更新 |
| D6: 文件系统存储 | 验证数据持久化和恢复 |

### 不在测试范围

以下内容由其他模块负责测试：

- 消息内容的存储和管理（Conversation 模块）
- 执行循环的协调（lifecycle 模块）
- 底层文件读写的正确性（Storage 模块）
- git 命令的执行结果（依赖 git 本身的可靠性）

---

## 二、Critical Scenarios（关键场景）

### 场景 1: 创建会话并持久化

**前置条件**：
- 目录存在且可访问
- Storage 模块正常工作

**验证要点**：
- 生成的 sessionId 格式正确（session_<timestamp>_<random>）
- projectId 正确识别（git 或 path hash）
- 所有必需字段都已初始化
- 会话文件正确写入 ~/.ohbaby-agent/storage/session/<projectId>/<sessionId>.json
- 文件内容可反序列化为 Session 对象

### 场景 2: 项目 ID 生成的稳定性

**前置条件**：
- 存在 git 仓库的目录
- 无 git 的普通目录

**验证要点**：
- 同一 git 仓库多次调用返回相同的 projectId
- git 仓库在不同路径下（相同 git root）返回相同 projectId
- 无 git 的目录返回基于路径的稳定 hash
- 同一目录多次调用返回相同的 projectId

### 场景 3: 获取不存在的会话

**前置条件**：
- sessionId 不存在于任何项目中

**验证要点**：
- get(sessionId) 返回 null
- 不抛出异常
- 不创建任何副作用

### 场景 4: 按项目列出会话

**前置条件**：
- 项目中存在多个会话
- 会话有不同的状态（active/archived）
- 会话有不同的更新时间

**验证要点**：
- 返回属于指定项目的所有会话
- status 过滤正确（只返回 active 或 archived）
- 排序正确（按 updatedAt 或 createdAt）
- limit 限制正确
- 不返回其他项目的会话

### 场景 5: 获取最近访问的会话（跨项目）

**前置条件**：
- 存在多个项目，每个项目有多个会话
- 会话有不同的 updatedAt 时间

**验证要点**：
- 返回所有项目中最近更新的会话
- 按 updatedAt 降序排序
- limit 限制正确
- 包含来自不同项目的会话

### 场景 6: 更新会话元数据

**前置条件**：
- 会话已存在

**验证要点**：
- 只更新提供的字段
- 未提供的字段保持不变
- updatedAt 自动更新
- 更新持久化到文件

### 场景 7: 增量更新统计信息

**前置条件**：
- 会话已存在
- stats.messageCount 初始值已知

**验证要点**：
- messageCount 正确增加指定数量
- lastMessageAt 更新为当前时间
- updatedAt 自动更新
- 更新持久化到文件

### 场景 8: touch 更新时间戳

**前置条件**：
- 会话已存在
- 记录原始 updatedAt

**验证要点**：
- updatedAt 更新为当前时间
- 其他字段保持不变
- 更新持久化到文件

### 场景 9: 归档会话

**前置条件**：
- 会话状态为 active

**验证要点**：
- status 更新为 archived
- updatedAt 自动更新
- getByProject() 使用 status: 'active' 过滤时不返回该会话
- 使用 status: 'archived' 过滤时返回该会话

### 场景 10: 删除会话

**前置条件**：
- 会话已存在

**验证要点**：
- 会话文件被删除
- get(sessionId) 返回 null
- 不影响其他会话

### 场景 11: 并发创建会话

**前置条件**：
- 同时创建多个会话

**验证要点**：
- 每个会话的 sessionId 唯一
- 所有会话都正确持久化
- 无文件覆盖或丢失

---

## 三、Integration Points（集成点测试）

### 与 Storage 模块集成

**正常情况**：
- 正确传递 key 路径（["session", projectId, sessionId]）
- 正确序列化和反序列化 Session 对象
- 正确处理 null 返回（文件不存在）

**异常情况**：
- Storage.write() 失败：抛出明确错误
- Storage.read() 失败：返回 null 或抛出错误
- 文件损坏：反序列化失败时的处理

### 与 git 命令集成

**正常情况**：
- git 仓库存在时正确获取 root commit hash
- 正确处理多个 root commit 的情况（取第一个）
- 正确缓存结果或读取 .git/opencode 文件

**异常情况**：
- 不是 git 仓库：fallback 到路径 hash
- git 命令不可用：fallback 到路径 hash
- .git 目录不可读：fallback 到路径 hash

### 与 Conversation 模块的协作

**正常情况**：
- Conversation 写入消息后调用 incrementStats()
- 统计信息正确更新

**异常情况**：
- 调用 incrementStats() 时 sessionId 不存在：应抛出错误
- 并发更新统计：最后一次写入生效（文件覆盖语义）

### 与 lifecycle 模块的协作

**正常情况**：
- lifecycle 根据 sessionId 执行对话
- 执行完成后 touch() 更新时间

**异常情况**：
- sessionId 不存在：返回 null，由 lifecycle 处理

---

## 四、Verification Strategy（验证策略）

### 单元测试策略

**SessionManager 测试**：
- Mock Storage 模块和 ProjectIdentifier
- 验证业务逻辑（CRUD、过滤、排序）
- 验证错误处理

**ProjectIdentifier 测试**：
- Mock git 命令执行
- 验证 projectId 生成逻辑
- 验证 fallback 机制

**SessionStore 测试**：
- Mock Storage 接口
- 验证数据持久化逻辑
- 验证路径构建

### 集成测试策略

**文件系统集成**：
- 使用临时目录进行真实文件读写
- 验证完整的 CRUD 流程
- 测试后清理文件

**git 集成**：
- 准备测试用的 git 仓库
- 验证 projectId 生成
- 测试 fallback 机制

### Mock 策略

**Storage Mock**：
```typescript
模拟返回预定义的 Session 数据
支持配置：
- 成功/失败场景
- 返回值
- 异常抛出
```

**ProjectIdentifier Mock**：
```typescript
模拟返回预定义的 projectId
支持配置：
- git 模式 / path 模式
- 不同目录返回不同 ID
```

### 测试数据

**Fixtures 目录**：
```
__tests__/fixtures/
├── sessions/           # 预定义 Session 对象
├── git-repos/          # 测试用 git 仓库
└── invalid-data/       # 无效数据用于错误测试
```

---

## 五、测试优先级

| 优先级 | 场景 | 理由 |
|--------|------|------|
| P0 | 创建会话、获取会话 | 核心功能 |
| P0 | 项目 ID 生成稳定性 | 数据一致性关键 |
| P1 | 列出会话、过滤排序 | 用户体验关键 |
| P1 | 统计信息更新 | 与 Conversation 协作关键 |
| P2 | 归档、删除 | 辅助功能 |
| P2 | 边界情况（并发、错误） | 健壮性 |

---

## 六、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试策略关注行为而非覆盖率
- [x] 集成点测试覆盖主要协作模块
- [x] 测试优先级清晰合理
