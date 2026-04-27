# memory 模块 dfd-interface.md

本文档描述 `memory` 模块的数据流与对外接口。数据流优先，接口从属于数据流。

**模块位置**：
- 代码：`src/core/memory/`
- 文档：`docs/core/memory/`

---

## 一、Context & Scope（上下文与范围）

### 模块位置

memory 模块位于 ohbaby-code 的核心层，作为长期记忆管理的中心：

```
┌─────────────────────────────────────────────────────────────────┐
│ 调用层（lifecycle、Agent、Commands）                             │
└────────────────────────┬────────────────────────────────────────┘
                         │ load / add / update / remove
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       MemoryManager                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 管理 OHBABY.md 文件的读写，提供 CRUD 接口                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────┬───────────┬───────────┬────────────────────────────────┘
         │           │           │
         ▼           ▼           ▼
     Project     文件系统        Bus
```

### 交互模块

| 模块 | 代码位置 | 交互方向 | 说明 |
|------|----------|----------|------|
| lifecycle | `src/lifecycle/` | 输入 | 会话开始时加载记忆 |
| Agent | `src/agents/` | 输入 | AI 通过 Tools 添加/更新/删除记忆 |
| Commands | `src/commands/` | 输入 | 用户命令（/memory add）调用 Memory |
| Project | `src/project/` | 输出 | 调用 `Project.fromDirectory()` 获取项目根路径 |
| Bus | `src/bus/` | 输出 | 发布记忆变更事件 |
| 文件系统 | Node.js fs | 输出 | 直接读写 OHBABY.md 文件 |

---

## 二、Data Flow Description（数据流描述）

### 主数据流 1：会话开始时加载记忆

```
1. [lifecycle] 会话开始，准备加载上下文
   └── 输入：currentDirectory

2. [lifecycle -> Memory] 调用 Memory.load(directory)
   │
   ├──> 2.1 [Memory -> Project] 获取项目根路径
   │    ├── 调用 Project.fromDirectory(directory)
   │    └── 得到 { id, rootPath }
   │
   ├──> 2.2 [Memory] 加载全局记忆
   │    ├── 获取路径：getGlobalMemoryPath()
   │    │   └── ~/.config/ohbaby-code/OHBABY.md (Linux/macOS)
   │    │   └── %APPDATA%/ohbaby-code/OHBABY.md (Windows)
   │    ├── 读取文件（不存在返回 ''）
   │    └── globalContent = 文件内容
   │
   ├──> 2.3 [Memory] 加载项目记忆
   │    ├── 调用 findProjectMemoryPath(directory, rootPath)
   │    │   ├── 从 directory 向上查找 OHBABY.md
   │    │   ├── 找到第一个即返回路径
   │    │   └── 未找到返回 null
   │    ├── 读取文件（不存在返回 ''）
   │    └── projectContent = 文件内容
   │
   └──> 2.4 [Memory] 合并记忆
        ├── 调用 mergeMemory(globalContent, projectContent)
        │   ├── 添加 HTML 注释标记来源
        │   └── 用 --- 分隔符拼接
        └── 返回 { global, project, merged }

3. [lifecycle] 使用记忆内容
   ├── 构建 System Prompt（独立）
   ├── 将 memory.merged 作为单独的 system 消息
   └── 发送给 LLM

说明：新记忆在下次会话生效，当前会话不自动刷新
```

### 主数据流 2：AI 添加记忆（通过 Tool）

```
1. [Agent] 执行过程中判断需要记住某个信息
   └── 调用 Tool: memory_add

2. [Memory Tools] 接收工具调用
   ├── 参数：
   │   ├── scope: 'global' | 'project'
   │   └── fact: '要记住的内容'
   │
   └── 调用 Memory.add({ scope, fact, directory })

3. [Memory.add] 处理添加逻辑
   │
   ├──> 3.1 确定文件路径
   │    ├── scope === 'global': getGlobalMemoryPath()
   │    └── scope === 'project': findProjectMemoryPath(...)
   │
   ├──> 3.2 读取当前文件内容
   │    └── currentContent = fs.readFile(filePath) || ''
   │
   ├──> 3.3 计算新内容
   │    ├── 调用 computeNewContent(currentContent, fact)
   │    │   ├── 检查是否存在 '## Ohbaby Added Memories'
   │    │   ├── 不存在：添加 Header 和第一条
   │    │   └── 存在：追加到末尾
   │    ├── 添加时间戳：formatTimestamp()
   │    │   └── 格式：2026-01-01 22:00:00
   │    └── newContent = 完整文件内容
   │
   ├──> 3.4 写入文件
   │    ├── 确保目录存在（mkdir -p）
   │    └── fs.writeFile(filePath, newContent)
   │
   └──> 3.5 发布事件
        └── Bus.publish(Memory.Event.Added, { scope, text: fact })

4. [外部] 返回成功（无需确认）
```

### 主数据流 3：AI 查看当前记忆

```
1. [Agent] 需要查看当前有哪些记忆
   └── 调用 Tool: memory_list

2. [Memory Tools] 接收工具调用
   ├── 参数：
   │   └── scope: 'global' | 'project'
   │
   └── 调用 Memory.listEntries(scope, directory)

3. [Memory.listEntries] 处理查询逻辑
   │
   ├──> 3.1 确定文件路径并读取内容
   │
   ├──> 3.2 调用 parseEntries(content)
   │    ├── 定位 '## Ohbaby Added Memories'
   │    ├── 提取 Header 下方的列表
   │    └── 解析每行：
   │        ├── 格式：- 2026-01-01 22:00:00: 内容
   │        └── 提取 { index, timestamp, text }
   │
   └──> 3.3 返回 MemoryEntry[]

4. [Agent] 获取条目列表
   ├── 决定是否需要更新/删除某条
   └── 可能调用 memory_update 或 memory_remove
```

### 主数据流 4：AI 更新记忆

```
1. [Agent] 发现某条记忆需要更新
   └── 先调用 memory_list 获取索引

2. [Agent] 调用 Tool: memory_update
   ├── 参数：
   │   ├── scope: 'global' | 'project'
   │   ├── index: 要更新的条目索引
   │   └── newText: 新的内容

3. [Memory.update] 处理更新逻辑
   │
   ├──> 3.1 确定文件路径并读取内容
   │
   ├──> 3.2 解析并验证
   │    ├── 调用 parseEntries(content)
   │    ├── 检查 index 是否合法
   │    └── index >= entries.length 则抛出异常
   │
   ├──> 3.3 更新条目
   │    ├── 保留 Header 上方的用户手写区域
   │    ├── 更新 entries[index].text = newText
   │    ├── 保持时间戳不变
   │    └── 重新组装文件内容
   │
   ├──> 3.4 写入文件
   │    └── fs.writeFile(filePath, newContent)
   │
   └──> 3.5 发布事件
        └── Bus.publish(Memory.Event.Updated, { scope, index, newText })

4. [外部] 返回成功（无需确认）
```

### 主数据流 5：AI 删除记忆

```
1. [Agent] 发现某条记忆已过时
   └── 先调用 memory_list 获取索引

2. [Agent] 调用 Tool: memory_remove
   ├── 参数：
   │   ├── scope: 'global' | 'project'
   │   └── index: 要删除的条目索引

3. [Memory.remove] 处理删除逻辑
   │
   ├──> 3.1 确定文件路径并读取内容
   │
   ├──> 3.2 解析并验证索引
   │
   ├──> 3.3 删除条目
   │    ├── entries.splice(index, 1)
   │    └── 重新组装文件内容（索引自动调整）
   │
   ├──> 3.4 写入文件
   │
   └──> 3.5 发布事件
        └── Bus.publish(Memory.Event.Removed, { scope, index })

4. [外部] 返回成功（无需确认）
```

### 主数据流 6：用户手动刷新记忆

```
1. [用户] 手动编辑了 OHBABY.md，需要刷新
   └── 执行命令：/memory refresh

2. [Commands] 接收命令
   └── 调用 Memory.refresh(directory)

3. [Memory.refresh] 重新加载记忆
   ├── 调用 Memory.load(directory)
   ├── 获取最新的 { global, project, merged }
   └── 发布 Memory.Event.Refreshed 事件

4. [Bus] 广播事件
   ├── lifecycle 可以监听此事件
   └── 决定是否更新当前会话（通常不自动更新）

说明：刷新操作不会自动影响当前会话，新内容在下次会话生效
```

---

## 三、Interface Definition（接口定义）

### 3.1 核心接口

#### Memory.load

**签名**：
```typescript
async function load(directory: string): Promise<MergedMemory>
```

**参数**：
- `directory`: string - 当前工作目录（用于定位项目记忆）

**返回值**：
```typescript
interface MergedMemory {
  global: string    // 全局记忆原始内容
  project: string   // 项目记忆原始内容
  merged: string    // 合并后的内容（添加来源标记）
}
```

**行为说明**：
1. 调用 `Project.fromDirectory()` 获取项目根路径
2. 读取全局 OHBABY.md（`~/.config/ohbaby-code/OHBABY.md`）
3. 从 `directory` 向上查找项目 OHBABY.md，找到第一个即停止
4. 合并两个文件内容，添加 HTML 注释标记来源
5. 文件不存在时返回空字符串，不报错

**示例**：
```typescript
const memory = await Memory.load('/path/to/project/src')
// => {
//   global: '# Global rules\n...',
//   project: '# Project context\n...',
//   merged: '<!-- Global Memory from ... -->\n...\n---\n<!-- Project Memory ... -->\n...'
// }
```

---

#### Memory.add

**签名**：
```typescript
async function add(input: AddMemoryInput): Promise<void>
```

**参数**：
```typescript
interface AddMemoryInput {
  scope: 'global' | 'project'
  fact: string
  directory?: string  // scope='project' 时必需
}
```

**行为说明**：
1. 确定文件路径（全局或项目）
2. 读取当前文件内容
3. 检查是否存在 `## Ohbaby Added Memories` Header
4. 不存在则添加 Header，存在则追加到末尾
5. 添加时间戳（格式：`2026-01-01 22:00:00`）
6. 写入文件（不存在时自动创建目录和文件）
7. 发布 `Memory.Event.Added` 事件

**示例**：
```typescript
await Memory.add({
  scope: 'project',
  fact: '本项目使用 shadcn/ui 组件库',
  directory: '/path/to/project'
})
```

---

#### Memory.update

**签名**：
```typescript
async function update(input: UpdateMemoryInput): Promise<void>
```

**参数**：
```typescript
interface UpdateMemoryInput {
  scope: 'global' | 'project'
  directory?: string
  index: number      // 要更新的条目索引（0-based）
  newText: string    // 新内容
}
```

**行为说明**：
1. 读取文件并解析 AI 添加区域的条目
2. 验证 `index` 是否合法（< entries.length）
3. 更新指定索引的条目内容（保持时间戳不变）
4. 只修改 `## Ohbaby Added Memories` 下方的内容
5. 用户手写区域（Header 上方）不受影响
6. 写入文件并发布 `Memory.Event.Updated` 事件

**异常**：
- 索引越界时抛出 `RangeError`

**示例**：
```typescript
await Memory.update({
  scope: 'project',
  index: 2,
  newText: '本项目使用 Vitest 和 Playwright 进行测试',
  directory: '/path/to/project'
})
```

---

#### Memory.remove

**签名**：
```typescript
async function remove(input: RemoveMemoryInput): Promise<void>
```

**参数**：
```typescript
interface RemoveMemoryInput {
  scope: 'global' | 'project'
  directory?: string
  index: number  // 要删除的条目索引
}
```

**行为说明**：
1. 读取文件并解析条目
2. 验证索引合法性
3. 删除指定索引的条目
4. 重新组装文件（剩余条目索引自动调整）
5. 写入文件并发布 `Memory.Event.Removed` 事件

**异常**：
- 索引越界时抛出 `RangeError`

**示例**：
```typescript
await Memory.remove({
  scope: 'global',
  index: 5
})
```

---

#### Memory.listEntries

**签名**：
```typescript
async function listEntries(
  scope: 'global' | 'project',
  directory?: string
): Promise<MemoryEntry[]>
```

**返回值**：
```typescript
interface MemoryEntry {
  index: number      // 条目索引（0-based）
  timestamp: string  // 时间戳（YYYY-MM-DD HH:MM:SS）
  text: string       // 条目内容
}
```

**行为说明**：
1. 读取文件内容
2. 定位 `## Ohbaby Added Memories` Header
3. 解析 Header 下方的列表项
4. 只解析以 `-` 开头的行
5. 返回索引化的条目数组

**示例**：
```typescript
const entries = await Memory.listEntries('project', '/path/to/project')
// => [
//   { index: 0, timestamp: '2026-01-01 21:00:00', text: '...' },
//   { index: 1, timestamp: '2026-01-01 21:05:00', text: '...' }
// ]
```

---

#### Memory.refresh

**签名**：
```typescript
async function refresh(directory: string): Promise<void>
```

**行为说明**：
1. 调用 `Memory.load(directory)` 重新加载
2. 发布 `Memory.Event.Refreshed` 事件
3. 不返回内容（调用方可重新调用 load）

**使用场景**：
- 用户手动编辑 OHBABY.md 后刷新
- 通过命令 `/memory refresh` 触发

**示例**：
```typescript
await Memory.refresh('/path/to/project')
// 发布事件通知其他模块记忆已更新
```

---

### 3.2 Memory Tools 接口

Memory 模块内部定义 4 个 AI 工具：

#### Tool 1: memory_add

```typescript
{
  name: 'memory_add',
  description: '保存重要信息到长期记忆。当用户明确要求记住某事，或AI判断某信息对未来会话有价值时使用。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'global: 适用所有项目 | project: 仅当前项目'
      },
      fact: {
        type: 'string',
        description: '要记住的事实或信息，应简洁明确'
      }
    },
    required: ['scope', 'fact']
  }
}
```

#### Tool 2: memory_update

```typescript
{
  name: 'memory_update',
  description: '更新已有的记忆条目。先使用 memory_list 查看所有条目和索引，再更新指定条目。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'project'] },
      index: {
        type: 'number',
        description: '要更新的条目索引（从 memory_list 获取）'
      },
      newText: {
        type: 'string',
        description: '新的内容'
      }
    },
    required: ['scope', 'index', 'newText']
  }
}
```

#### Tool 3: memory_remove

```typescript
{
  name: 'memory_remove',
  description: '删除过时或错误的记忆条目。先使用 memory_list 查看所有条目，再删除指定条目。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'project'] },
      index: {
        type: 'number',
        description: '要删除的条目索引（从 memory_list 获取）'
      }
    },
    required: ['scope', 'index']
  }
}
```

#### Tool 4: memory_list

```typescript
{
  name: 'memory_list',
  description: '列出所有记忆条目，查看索引、时间戳和内容。用于在 update 或 remove 前确认要操作的条目。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'project'] }
    },
    required: ['scope']
  }
}
```

---

### 3.3 事件接口

```typescript
namespace Memory.Event {
  // 添加条目
  Added = {
    type: 'memory.added',
    properties: {
      scope: 'global' | 'project',
      text: string
    }
  }
  
  // 更新条目
  Updated = {
    type: 'memory.updated',
    properties: {
      scope: 'global' | 'project',
      index: number,
      newText: string
    }
  }
  
  // 删除条目
  Removed = {
    type: 'memory.removed',
    properties: {
      scope: 'global' | 'project',
      index: number
    }
  }
  
  // 刷新记忆
  Refreshed = {
    type: 'memory.refreshed',
    properties: {
      directory: string
    }
  }
}
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| OHBABY.md 文件 | Memory 模块（首次 add） | 自动创建目录和文件 |
| 用户手写区域 | 用户 | 手动编辑 |
| AI 添加区域 | AI（通过 Tools） | 调用 Memory Tools |
| 时间戳 | Memory 模块 | 自动生成 |

### 数据更新责任

| 数据 | 更新者 | 说明 |
|------|--------|------|
| AI 添加区域 | AI（通过 Tools） | update/remove 操作 |
| 用户手写区域 | 用户 | Memory 模块不修改 |
| 文件合并 | Memory 模块 | load() 时动态合并 |

### 数据删除责任

| 数据 | 删除者 | 说明 |
|------|--------|------|
| 单条记忆 | AI（通过 Tools） | Memory.remove() |
| 整个文件 | 用户 | 手动删除文件 |

---

## 五、使用示例

### 示例 1：lifecycle 加载记忆

```typescript
// src/lifecycle/lifecycle-manager.ts

async function startSession(directory: string) {
  // 1. 加载记忆
  const memory = await Memory.load(directory)
  
  // 2. 构建系统提示词（独立）
  const systemPrompt = await SystemPrompt.build({
    agent: 'default',
    // 不包含 memory
  })
  
  // 3. 组装 LLM 消息
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: memory.merged, name: 'memory' },
    ...conversationMessages
  ]
  
  // 4. 发送给 LLM
  await llm.chat(messages)
}
```

### 示例 2：AI 添加记忆

```typescript
// Agent 执行过程中

// AI 判断需要记住某个信息
await Memory.add({
  scope: 'project',
  fact: '用户偏好使用 CSS Modules 而不是 Tailwind',
  directory: currentDirectory
})
// 无需确认，直接写入
```

### 示例 3：AI 查看并更新记忆

```typescript
// 1. 查看当前记忆
const entries = await Memory.listEntries('global')
// => [
//   { index: 0, timestamp: '...', text: '用户偏好使用 TypeScript' },
//   { index: 1, timestamp: '...', text: '用户喜欢详细注释' }
// ]

// 2. 发现某条需要更新
await Memory.update({
  scope: 'global',
  index: 0,
  newText: '用户偏好使用 TypeScript strict 模式并启用所有严格检查'
})
```

---

## 六、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义关注语义，未绑定具体实现
- [x] 与 lifecycle、Project、Agent 的协作方式明确
- [x] 事件定义完整
- [x] Tools 接口清晰
- [x] 无需确认机制（系统内部操作）
