# session 模块 data-model.md

本文档定义 `session` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: Session（会话）

**定义**：Session 是用户与 AI 进行一次完整对话的逻辑单元，包含会话的元数据但不包含具体的消息内容。

**边界**：
- 开始：用户创建新会话或恢复已有会话
- 结束：用户主动关闭或归档会话

**与其他概念的关系**：
```
一个 Project（项目）
|-- Session 1: "实现登录功能"（主会话）
|   |-- 包含 N 条 Message（由 Message 模块管理）
|   +-- 子 Session 1.1: "explore - 文件搜索"（子代理会话）
|       +-- 包含 K 条 Message
|-- Session 2: "修复性能问题"
|   +-- 包含 M 条 Message
+-- ...
```

### 概念 2: Project（项目）

**定义**：Project 代表了一个代码仓库或工作目录，用于组织和分类 Session。

**识别方式**（由 Project 模块负责）：
- **Git 项目**：git root commit hash
- **非 Git 目录**：固定值 `"global"`

**详细说明**：见 `docs/project/goals-duty.md`

**特点**：
- 项目 ID 由 Project 模块动态生成，不持久化
- 同一个 Git 仓库在任意位置产生相同的项目 ID
- Session 模块通过调用 `Project.fromDirectory()` 获取 projectId

### 概念 3: SessionStats（会话统计）

**定义**：Session 的汇总统计信息，用于快速呈现会话的活跃度和规模。

**更新时机**：
- lifecycle 模块每次写入消息后主动调用更新

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| Session | Entity（实体） | 有唯一标识（sessionId），有生命周期 |
| Project | Value Object（值对象） | 仅作为标识符使用，无独立行为 |
| SessionStats | Value Object（值对象） | 嵌入在 Session 中，无独立身份 |

---

## 三、Key Data Fields（关键数据字段）

### Session 完整数据结构

```typescript
interface Session {
  // ======== 标识 ========
  id: string                    // 格式: session_<timestamp>_<random>
  projectId: string             // 项目 ID（git hash 或 path hash）
  
  // ======== 基本信息 ========
  title: string                 // 会话标题
  agentName: string             // 使用的 Agent 名称，默认 'default'
  
  // ======== 时间信息 ========
  createdAt: number             // 创建时间戳（毫秒）
  updatedAt: number             // 最后更新时间戳（毫秒）
  
  // ======== 状态 ========
  status: SessionStatus         // 'active' | 'archived'
  
  // ======== 统计信息 ========
  stats: SessionStats
  
  // ======== 父子关系（子代理支持） ========
  parentId?: string             // 父会话 ID（子代理会话必填）
  childrenIds?: string[]        // 子会话 ID 列表（主会话可选）
  isSubagent: boolean           // 是否为子代理会话（显式标记）
}

interface SessionStats {
  messageCount: number          // 消息总数
  lastMessageAt: number         // 最后一条消息的时间戳
}

type SessionStatus = 'active' | 'archived'
```

### 字段说明

| 字段 | 含义 | 备注 |
|------|------|------|
| id | 会话唯一标识 | 全局唯一，包含时间戳便于排序 |
| projectId | 所属项目 | 用于按项目分目录存储 |
| title | 会话标题 | 默认"New session - 日期"，用户可编辑 |
| agentName | Agent 名称 | 记录使用哪个 Agent 进行对话 |
| createdAt | 创建时间 | 不可变 |
| updatedAt | 更新时间 | 每次 touch() 或修改时更新 |
| status | 会话状态 | active 表示活跃，archived 表示归档 |
| stats | 统计信息 | 由 Conversation 模块触发更新 |
| parentId | 父会话（可选） | 子代理会话必填，指向主会话 |
| childrenIds | 子会话列表（可选） | 主会话的子代理会话 ID 列表 |
| isSubagent | 是否为子代理会话 | 显式标记，便于查询和识别 |

---

## 四、Lifecycle & Ownership（生命周期与归属）

### Session 生命周期

```
创建（create）
    │
    ├── 生成 sessionId
    ├── 关联到 projectId
    ├── 设置初始 title, agentName
    ├── 初始化 stats
    │
    ▼
使用中（active）
    │
    ├── lifecycle 模块根据 sessionId 执行对话
    ├── Conversation 模块写入消息
    ├── Conversation 调用 incrementStats() 更新统计
    ├── 调用 touch() 更新 updatedAt
    │
    ▼
归档（archive）或删除（delete）
    │
    └── 从活跃列表中移除或彻底删除
```

### 数据归属

| 数据 | 创建者 | 管理者 | 说明 |
|------|--------|--------|------|
| Session 元数据 | SessionManager | SessionManager | 完全由 session 模块管理 |
| projectId | ProjectIdentifier | SessionManager | 创建时计算并固化 |
| stats | SessionManager | lifecycle 触发更新 | 初始化由 session，更新由外部触发 |
| 消息内容 | Message 模块 | Message 模块 | session 模块不涉及 |

---

## 五、ID 生成规则

### sessionId 生成

```typescript
function generateSessionId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `session_${timestamp}_${random}`
}

// 示例: session_1703577600000_a1b2c3
```

**特点**：
- 包含时间戳，天然有序
- 包含随机部分，避免冲突
- 可读性好，便于调试

### projectId 获取

```typescript
// 通过 Project 模块获取
import { Project } from '@/project'

async function getProjectId(directory: string): Promise<string> {
  const project = await Project.fromDirectory(directory)
  return project.id
}

// 示例:
// Git 项目: 'a1b2c3d4e5f6...'
// 非 Git 目录: 'global'
```

**详细 ID 生成规则**：见 `docs/project/architecture.md`

---

## 六、数据不变性约束

| 字段 | 可变性 | 说明 |
|------|--------|------|
| id | 不可变 | 会话创建后永不改变 |
| projectId | 不可变 | 会话创建后永不改变 |
| createdAt | 不可变 | 记录创建时间 |
| title | 可变 | 用户可编辑 |
| agentName | 可变 | 理论上可切换 Agent |
| updatedAt | 自动更新 | 任何修改都会更新此字段 |
| status | 可变 | active ↔ archived |
| stats | 自动更新 | 由 Conversation 触发更新 |

---

## 七、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在后续接口和数据流中都有使用场景
- [x] ID 生成规则清晰且稳定
- [x] 数据生命周期和归属明确
