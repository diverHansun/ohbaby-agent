# message 模块 architecture.md

本文档描述 `message` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

message 模块采用**简单分层架构**，将职责分为三个层次：

```
┌─────────────────────────────────────────────────────────────────┐
│ MessageManager（对外接口层）                                     │
│                                                                  │
│ 职责：                                                           │
│ - 提供统一的消息管理 API                                          │
│ - 协调消息和 Part 的 CRUD 操作                                    │
│ - 调用 Bus 广播事件                                              │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ MessageStore（存储层）                                │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 消息和 Part 数据的读写操作                          │      │
│   │ - 按 sessionId 和 messageId 组织存储路径               │      │
│   │ - 调用底层 Storage 接口                               │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐      │
│   │ MessageConverter（格式转换层）                        │      │
│   │                                                      │      │
│   │ 职责：                                               │      │
│   │ - 将内部消息格式转换为 LLM SDK 格式                    │      │
│   │ - 过滤无效消息（curated history）                     │      │
│   └──────────────────────────────────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Storage 模块    │
                     │ (底层文件读写)   │
                     └─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Bus 模块        │
                     │ (事件广播)       │
                     └─────────────────┘
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **MessageManager** | 对外 API 入口，实现 CRUD 和事件广播 |
| **MessageStore** | 消息和 Part 的持久化层，封装文件操作 |
| **MessageConverter** | 消息格式转换，toModelMessages 等 |
| **types.ts** | 消息和 Part 的类型定义 |
| **factory.ts** | 消息和 Part 的创建工厂函数 |
| **idGenerator.ts** | ID 生成工具函数 |

### 组件间依赖关系

```
MessageManager
    ├── MessageStore（调用）
    ├── MessageConverter（调用）
    └── Bus（调用）

MessageStore
    └── Storage 模块（依赖）

MessageConverter
    └── 无外部依赖（纯函数）
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 分层架构（简化版）

**使用理由**：
- 职责分离：API 层、存储层、转换层各司其职
- 便于测试：可独立 mock MessageStore 测试 MessageManager
- 符合单一职责原则（SRP）

**不采用复杂分层的理由**：
- message 模块逻辑相对简单，不需要引入 Service、Repository、DAO 等多层抽象
- 三层已足够满足当前需求，遵循 YAGNI 原则

### 2. 依赖注入

**使用理由**：
- MessageManager 通过构造函数注入 Storage 和 Bus
- 便于单元测试时替换实现
- 符合依赖倒置原则（DIP）

**实现方式**：
```typescript
interface MessageManagerDeps {
  storage: Storage
  bus: Bus
}

function createMessageManager(deps: MessageManagerDeps): MessageManager {
  // ...
}
```

### 3. 工厂函数

**使用理由**：
- 提供消息和 Part 创建的便捷函数
- 封装 ID 生成和默认值设置
- 保持创建逻辑的一致性

**实现方式**：
```typescript
function createUserMessage(input: CreateUserMessageInput): UserMessage {
  return {
    id: generateMessageId(),
    role: 'user',
    time: { created: Date.now() },
    ...input
  }
}
```

### 4. 未使用的模式

**未使用单例模式**：
- MessageManager 可由调用方管理实例生命周期
- 便于测试时创建多个独立实例

**未使用观察者模式（内部）**：
- 事件广播通过外部 Bus 模块完成
- 模块内部不维护订阅者列表

**未使用缓存模式**：
- 遵循设计目标 G2（实时持久化），不维护内存缓存
- 每次查询从 Storage 读取，确保一致性

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/core/message/
├── index.ts                  # 模块入口，导出公共 API
├── manager.ts                # MessageManager 实现
├── store.ts                  # MessageStore 实现
├── converter.ts              # MessageConverter 实现
├── types.ts                  # 类型定义（Message, Part 等）
├── factory.ts                # 消息和 Part 创建工厂函数
├── idGenerator.ts            # ID 生成工具函数
├── events.ts                 # 事件类型定义
└── __tests__/
    ├── manager.test.ts
    ├── store.test.ts
    ├── converter.test.ts
    └── factory.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 导出 MessageManager、类型和工厂函数 |
| `manager.ts` | 核心逻辑 | 实现所有对外 API，协调各组件 |
| `store.ts` | 存储层 | 封装文件读写，依赖 Storage |
| `converter.ts` | 转换层 | 格式转换，纯函数 |
| `types.ts` | 类型定义 | Message、Part、Event 等类型 |
| `factory.ts` | 工厂函数 | 创建消息和 Part 的便捷函数 |
| `idGenerator.ts` | 工具函数 | ID 生成算法 |
| `events.ts` | 事件定义 | 消息事件类型 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `MessageManager` 及其公共方法
- `Message`、`Part` 等类型定义
- `toModelMessages()` 格式转换函数
- 工厂函数（`createUserMessage` 等）
- 事件类型定义

### 内部实现

以下内容为内部实现，可自由重构：
- `MessageStore` 类（仅被 MessageManager 内部使用）
- ID 生成算法
- 存储路径组织方式

---

## 四、Storage Path Design（存储路径设计）

消息和 Part 分开存储，路径设计如下：

```
存储路径结构：

["message", sessionId, messageId] -> Message
  └── 存储消息元数据（不含内容）

["part", messageId, partId] -> Part
  └── 存储消息内容（text, tool, reasoning 等）
```

**设计理由**：
- Part 独立存储支持流式更新
- 按 messageId 分组便于批量读取
- 支持细粒度的增删改操作

**示例**：
```
~/.ohbaby-code/storage/
├── message/
│   └── session_xxx/
│       ├── message_001.json    # UserMessage
│       └── message_002.json    # AssistantMessage
└── part/
    ├── message_001/
    │   └── part_001.json       # TextPart
    └── message_002/
        ├── part_001.json       # TextPart
        ├── part_002.json       # ToolPart
        └── part_003.json       # StepFinishPart
```

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: 无内存缓存 vs 缓存优化

**当前选择**：不维护内存缓存，每次查询从 Storage 读取

**代价**：
- 查询性能略低（需要文件 I/O）
- 频繁查询可能产生一定开销

**理由**：
- 简化状态管理，避免缓存一致性问题
- 消息查询频率相对较低（主要在循环开始时）
- KISS 原则，避免过早优化
- 如有性能问题，可后续添加缓存层

### 约束 2: Part 分离存储 vs 消息内嵌

**当前选择**：Part 独立于 Message 存储

**代价**：
- 查询时需要额外读取 Part 文件
- 存储结构略复杂

**理由**：
- 支持流式更新（每个 Part 独立写入）
- 支持细粒度操作（单独更新某个 Part）
- 与 opencode 设计一致

### 约束 3: 同步事件 vs 异步事件

**当前选择**：Bus 事件同步发布

**代价**：
- 事件处理可能阻塞主流程

**理由**：
- 简化实现，避免异步复杂性
- 事件处理通常很快（只是通知 UI）
- 如有需要，Bus 内部可改为异步

### 约束 4: 完整 Part 类型 vs 按需定义

**当前选择**：完整定义所有 Part 类型，但功能可分阶段实现

**代价**：
- 类型定义较多
- 部分类型 MVP 阶段未使用

**理由**：
- 保持类型稳定，避免后续频繁修改
- 与 opencode 对齐，便于参考
- 类型定义本身不增加运行时开销

---

## 六、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| 消息压缩 | 预留 CompactionPart 类型 |
| 子任务 | 预留 SubtaskPart 类型 |
| 文件快照 | 预留 SnapshotPart、PatchPart 类型 |
| 消息缓存 | MessageStore 可添加缓存层 |
| 消息过期 | 可基于 createdAt 实现清理 |

---

## 七、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构支持 KISS 和 YAGNI 原则
