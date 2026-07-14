# memory 模块 data-model.md

本文档定义 `memory` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: Memory（记忆）

**定义**：Memory 是存储在 OHBABY.md 文件中的长期信息，用于在多次会话间保持上下文。

**边界**：
- 开始：用户或 AI 添加记忆条目
- 持续：文件持久化存储
- 结束：用户手动删除文件或 AI 删除条目

**与其他概念的关系**：
```
一个 AI 系统
├── Global Memory（全局记忆）
│   ├── 存储位置：~/.ohbaby/OHBABY.md
│   ├── 作用范围：所有项目
│   └── 内容：用户通用偏好、习惯
│
└── Project Memory（项目记忆）
    ├── 存储位置：{projectRoot}/OHBABY.md
    ├── 作用范围：特定项目
    └── 内容：项目规则、约定、上下文

每个会话
├── 加载 Global + Project 合并后的记忆
└── 在对话过程中可能添加新记忆
```

### 概念 2: Memory Scope（记忆作用域）

**定义**：记忆的作用范围，分为全局和项目两个层级。

**Global vs Project**：

| 维度 | Global | Project |
|------|--------|---------|
| 存储路径 | `~/.ohbaby/OHBABY.md` | `{projectRoot}/OHBABY.md` |
| 作用范围 | 所有项目 | 特定项目 |
| 内容示例 | "用户偏好使用 TypeScript" | "本项目使用 Vitest 测试框架" |
| 版本控制 | 不提交（个人配置） | 可提交（团队共享） |

### 概念 3: Memory Entry（记忆条目）

**定义**：OHBABY.md 文件中 `## Ohbaby Added Memories` Header 下方的单条记忆。

**格式**：
```markdown
- 2026-01-01 22:00:00: 这是一条记忆内容
```

**组成部分**：
- 列表标记：`-`
- 时间戳：`YYYY-MM-DD HH:MM:SS`（19 字符）
- 分隔符：`: `
- 内容：自由文本

### 概念 4: User-Written Content（用户手写内容）

**定义**：OHBABY.md 文件中 `## Ohbaby Added Memories` Header 上方的用户自定义内容。

**特点**：
- 用户完全控制
- AI 不可修改
- 可使用任意 Markdown 格式
- 优先级高于 AI 添加的内容

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| MergedMemory | Value Object（值对象） | 临时组装的数据，无独立生命周期 |
| MemoryEntry | Value Object（值对象） | 从文件解析出的临时对象 |
| OHBABY.md 文件 | 持久化存储 | 真正的 Entity，但不在内存中表示 |

**说明**：Memory 模块不包含内存中的 Entity，所有数据都是文件内容的临时表示。

---

## 三、Key Data Fields（关键数据字段）

### MergedMemory 数据结构

```typescript
interface MergedMemory {
  // ======== 全局记忆 ========
  global: string                // 全局 OHBABY.md 的原始内容
                                // 来源：~/.ohbaby/OHBABY.md
  
  // ======== 项目记忆 ========
  project: string               // 项目 OHBABY.md 的原始内容
                                // 来源：{projectRoot}/OHBABY.md（向上查找）
  
  // ======== 合并内容 ========
  merged: string                // 合并后的内容（添加来源标记）
                                // 格式：<!-- Global Memory --> + global + --- + <!-- Project Memory --> + project
}
```

### MemoryEntry 数据结构

```typescript
interface MemoryEntry {
  // ======== 索引 ========
  index: number                 // 条目索引（0-based）
                                // 用于 update 和 remove 操作
  
  // ======== 时间戳 ========
  timestamp: string             // 格式：2026-01-01 22:00:00
                                // 添加时自动生成
  
  // ======== 内容 ========
  text: string                  // 记忆内容（纯文本）
}
```

### 操作输入类型

```typescript
interface AddMemoryInput {
  scope: 'global' | 'project'   // 作用域
  fact: string                  // 要添加的事实
  directory?: string            // 项目目录（project 时必需）
}

interface UpdateMemoryInput {
  scope: 'global' | 'project'
  directory?: string
  index: number                 // 要更新的条目索引
  newText: string               // 新内容
}

interface RemoveMemoryInput {
  scope: 'global' | 'project'
  directory?: string
  index: number                 // 要删除的条目索引
}
```

---

## 四、Lifecycle & Ownership（生命周期与归属）

### OHBABY.md 文件生命周期

```
[不存在] ────────────────────────────────────┐
    │                                        │
    │ Memory.add() 首次调用                   │ 用户手动删除
    ▼                                        │
[创建文件]                                    │
    │                                        │
    ├── 写入 Header: ## Ohbaby Added Memories  │
    └── 添加第一条记忆                        │
    │                                        │
    ▼                                        │
[持续使用] ◄──────────────────────────────────┘
    │
    ├── Memory.add() 追加条目
    ├── Memory.update() 修改条目
    ├── Memory.remove() 删除条目
    ├── 用户手动编辑
    │
    ▼
[持久化存储]
    │
    └── Memory.load() 读取内容
```

### 数据归属

| 数据 | 创建者 | 管理者 | 说明 |
|------|--------|--------|------|
| Global OHBABY.md | 用户或系统 | Memory 模块 | 第一次 add 时自动创建 |
| Project OHBABY.md | 用户或系统 | Memory 模块 | 第一次 add 时自动创建 |
| User-Written Content | 用户 | 用户 | AI 不可修改 |
| AI Added Entries | AI（通过 Tools） | Memory 模块 | AI 可 add/update/remove |

---

## 五、File Format（文件格式）

### OHBABY.md 完整结构示例

```markdown
# 项目指南

这是用户手写的内容区域。
可以包含任意 Markdown 格式。

## 代码风格偏好
- 使用 TypeScript strict 模式
- 优先使用函数式编程

## Ohbaby Added Memories

- 2026-01-01 21:00:00: 用户偏好使用 Prettier 格式化代码
- 2026-01-01 21:05:00: 本项目使用 Vitest 作为测试框架
- 2026-01-01 22:00:00: 用户希望在代码中添加详细注释
```

**区域划分**：
1. **用户手写区域**（Header 上方）：
   - 用户完全控制
   - AI 只读，不修改
   
2. **AI 添加区域**（Header 下方）：
   - AI 自动管理
   - 用户可手动查看和编辑
   - 格式固定：列表 + 时间戳 + 内容

### 合并后的格式

```markdown
<!-- Global Memory from ~/.ohbaby/OHBABY.md -->
用户全局偏好内容...

## Ohbaby Added Memories
- 2026-01-01 20:00:00: 全局记忆条目1
- 2026-01-01 20:05:00: 全局记忆条目2

---

<!-- Project Memory from /path/to/project/OHBABY.md -->
项目级规则和约定...

## Ohbaby Added Memories
- 2026-01-01 21:00:00: 项目记忆条目1
- 2026-01-01 21:05:00: 项目记忆条目2
```

---

## 六、数据不变性约束

由于 Memory 模块直接操作文件，不维护内存状态，不存在传统意义上的"数据不变性"。

| 操作 | 副作用 | 说明 |
|------|--------|------|
| load() | 只读 | 不修改文件 |
| add() | 追加写入 | 在文件末尾添加条目 |
| update() | 修改写入 | 更新指定索引的条目 |
| remove() | 删除写入 | 删除指定索引的条目 |

**文件操作原则**：
- 每次操作独立执行
- 写入操作原子性由文件系统保证
- 不维护内存缓存

---

## 七、与其他模块数据的关系

### 与 Project 模块

```typescript
// 获取项目根路径用于定位 OHBABY.md
const project = await Project.fromDirectory(directory)
const projectMemoryPath = await findProjectMemoryPath(directory, project.rootPath)
```

### 与 lifecycle 模块

```typescript
// lifecycle 在会话开始时加载记忆
const memory = await Memory.load(directory)

// 将记忆内容传递给 LLM（独立于 System Prompt）
const messages = [
  { role: 'system', content: systemPrompt },
  { role: 'system', content: memory.merged, name: 'memory' },
  ...conversationMessages
]
```

### 与 Agent 模块

```typescript
// AI 通过 Tools 添加记忆
await Memory.add({
  scope: 'project',
  fact: '用户偏好使用 shadcn/ui 组件库',
  directory: currentDirectory
})

// AI 查看当前记忆
const entries = await Memory.listEntries('project', currentDirectory)
```

---

## 八、常量定义

```typescript
// src/core/memory/constants.ts

/**
 * AI 添加区域的 Header
 */
export const MEMORY_HEADER = '## Ohbaby Added Memories'

/**
 * 时间戳格式
 */
export const TIMESTAMP_FORMAT = 'YYYY-MM-DD HH:MM:SS'

/**
 * 全局配置目录名
 */
export const CONFIG_DIR_NAME = 'ohbaby-agent'

/**
 * 记忆文件名
 */
export const MEMORY_FILENAME = 'OHBABY.md'
```

---

## 九、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在后续接口和数据流中都有使用场景
- [x] 文件格式规范清晰
- [x] 数据生命周期和归属明确
- [x] Value Object 设计符合模块特点
