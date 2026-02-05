# session 模块 architecture.md

本文档描述 `session` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

session 模块采用**简单分层架构**，将职责分为三个层次：

```
┌─────────────────────────────────────────────────────────────────┐
│ SessionManager（对外接口层）                                     │
│                                                                  │
│ 职责：                                                           │
│ - 提供统一的会话管理 API                                          │
│ - 协调项目识别和会话存储                                          │
│ - 处理业务逻辑（如标题生成、统计更新）                              │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ ProjectIdentifier（项目识别器）                       │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 基于目录路径生成项目 ID                             │      │
│   │ - 优先使用 git root commit hash                      │      │
│   │ - fallback 到目录路径 hash                            │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ SessionStore（存储层）                                │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 会话数据的读写操作                                  │      │
│   │ - 按项目分目录组织文件                                 │      │
│   │ - 调用底层 Storage 接口                               │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Storage 模块    │
                     │ (底层文件读写)   │
                     └─────────────────┘
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **SessionManager** | 对外 API 入口，实现 CRUD 和业务逻辑 |
| **ProjectIdentifier** | 独立的项目 ID 生成逻辑，支持 git 和 fallback |
| **SessionStore** | 会话数据的持久化层，封装文件操作 |

### 组件间依赖关系

```
SessionManager
    ├── ProjectIdentifier（调用）
    └── SessionStore（调用）

SessionStore
    └── Storage 模块（依赖）

ProjectIdentifier
    └── git 命令 / crypto（依赖）
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 分层架构（简化版）

**使用理由**：
- 职责分离：API 层、业务逻辑层、存储层各司其职
- 便于测试：可独立 mock SessionStore 测试 SessionManager
- 符合单一职责原则（SRP）

**不采用复杂分层的理由**：
- session 模块逻辑简单，不需要引入 Service、Repository、DAO 等多层抽象
- 三层已足够满足当前需求

### 2. 依赖注入

**使用理由**：
- SessionManager 通过构造函数注入 Storage 和 ProjectIdentifier
- 便于单元测试时替换实现
- 符合依赖倒置原则（DIP）

**实现方式**：
```typescript
class SessionManager {
  constructor(
    private storage: Storage,
    private projectIdentifier: ProjectIdentifier
  ) {}
}
```

### 3. 未使用的模式

**未使用工厂模式**：
- Session 对象的创建逻辑简单，直接在 SessionManager 中构造即可
- 不需要根据类型创建不同的 Session 实例

**未使用观察者模式**：
- 统计更新通过主动调用 `incrementStats()` 完成
- 避免引入事件系统的复杂性
- 当前规模下显式调用更清晰可控

**未使用单例模式**：
- SessionManager 可由调用方管理实例生命周期
- 便于测试时创建多个独立实例

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/services/session/
├── index.ts                  # 模块入口，导出公共 API
├── sessionManager.ts         # SessionManager 类实现
├── projectIdentifier.ts      # ProjectIdentifier 类实现
├── sessionStore.ts           # SessionStore 类实现
├── types.ts                  # 类型定义（Session, CreateOptions 等）
├── idGenerator.ts            # sessionId 生成工具函数
└── __tests__/
    ├── sessionManager.test.ts
    ├── projectIdentifier.test.ts
    └── sessionStore.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 仅导出 SessionManager 和类型 |
| `sessionManager.ts` | 核心逻辑 | 实现所有对外 API，协调各组件 |
| `projectIdentifier.ts` | 独立逻辑 | 项目 ID 生成，可独立测试 |
| `sessionStore.ts` | 存储层 | 封装文件读写，依赖 Storage |
| `types.ts` | 类型定义 | Session、选项等类型 |
| `idGenerator.ts` | 工具函数 | sessionId 生成算法 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `SessionManager` 类及其公共方法
- `Session` 类型
- `CreateSessionOptions`, `ListOptions` 等选项类型

### 内部实现

以下内容为内部实现，可自由重构：
- `ProjectIdentifier` 类（仅被 SessionManager 内部使用）
- `SessionStore` 类（仅被 SessionManager 内部使用）
- ID 生成算法
- 文件路径组织方式

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: 文件系统存储 vs 数据库

**当前选择**：使用文件系统存储（JSON 文件）

**代价**：
- 查询能力有限（不支持复杂过滤、全文搜索）
- 不支持事务和并发控制
- 大量会话时列表性能可能下降

**理由**：
- MVP 阶段追求简单
- 会话数量级通常不大（单项目几十到几百）
- 避免引入数据库依赖
- 文件格式便于调试和迁移

### 约束 2: 主动统计更新 vs 事件驱动

**当前选择**：Conversation 模块主动调用 `incrementStats()`

**代价**：
- Conversation 模块需要知道 SessionManager 的存在
- 耦合度略高于事件系统

**理由**：
- 简单直接，调用链清晰
- 避免引入事件总线的复杂性
- 当前只有 Conversation 需要更新统计，不需要发布-订阅

### 约束 3: 内置项目管理 vs 独立 Project 模块

**当前选择**：SessionManager 内置 ProjectIdentifier

**代价**：
- 项目管理逻辑与会话管理耦合
- 如需扩展项目功能，可能需要重构

**理由**：
- YAGNI - 当前不需要完整的项目管理
- 项目 ID 生成逻辑简单且稳定
- 减少模块数量，降低整体复杂度

### 约束 4: 同步 API vs 异步 API

**当前选择**：所有方法返回 Promise（异步）

**代价**：
- 调用方必须 await
- 某些同步场景可能显得冗余

**理由**：
- 为未来可能的异步操作预留空间（如远程存储）
- 与 Storage 模块的异步接口保持一致
- Node.js 生态更倾向于异步 API

---

## 五、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| 会话分叉 | Session 类型中预留 `parentId` 字段 |
| 标签系统 | 可在 Session 中添加 `tags: string[]` 字段 |
| 会话导入导出 | SessionStore 提供序列化接口 |
| 多存储后端 | SessionStore 可实现不同的存储策略 |

---

## 六、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构支持 KISS 和 YAGNI 原则
