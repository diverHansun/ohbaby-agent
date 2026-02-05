# memory 模块 architecture.md

本文档描述 `memory` 模块的内部架构设计。

---

## 一、Architecture Overview（架构概览）

### 1.1 架构风格

Memory 模块采用**简单文件管理架构**，无持久化中间层，直接操作文件系统：

```
                    调用方（lifecycle、Agent、Commands）
                                │
                                ▼
                    ┌───────────────────┐
                    │  Memory 模块      │
                    │                   │
                    │  load / add       │
                    │  update / remove  │
                    │  listEntries      │
                    └─────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     ┌─────────────────┐             ┌─────────────────┐
     │ MemoryDiscovery  │             │  MemoryParser   │
     │ (文件查找)       │             │  (内容解析)     │
     └─────────┬───────┘             └─────────┬───────┘
               │                               │
               └───────────────┬───────────────┘
                               ▼
                        ┌─────────────────┐
                        │   文件系统 (fs)  │
                        │  IRIS.md 文件    │
                        └─────────────────┘
```

### 1.2 设计原则

- **无缓存**：每次读取都从文件系统获取最新内容
- **无状态**：不维护内存中的记忆副本
- **直接 IO**：不使用 Storage 模块，直接操作文件系统
- **向上查找**：项目记忆支持从当前目录向上查找到项目根

### 1.3 IRIS.md 文件位置

| 类型 | 路径 | 说明 |
|------|------|------|
| 全局记忆 | `~/.iris-code/IRIS.md` (Linux/macOS) | XDG 配置目录 |
| 全局记忆 | `%APPDATA%/iris-code/IRIS.md` (Windows) | Windows 应用数据目录 |
| 项目记忆 | `{projectRoot}/IRIS.md` | 项目根目录，与 `.gitignore` 同级 |

**设计说明**：
- 项目级 IRIS.md 放在项目根目录（而非 `.iris-code/` 内）
- 这样设计使 IRIS.md 更易被用户发现和编辑
- 便于加入版本控制与团队共享

---

## 二、File Structure（文件结构）

```
src/core/memory/
├── index.ts              # 模块导出入口
├── types.ts              # 类型定义
├── constants.ts          # 常量定义
├── memory-manager.ts     # 核心逻辑：load, add, update, remove, listEntries
├── memory-discovery.ts   # 文件发现：查找 IRIS.md
├── memory-parser.ts      # 内容解析：解析条目、计算新内容
└── memory-tools.ts       # Tool 定义：memory_add, memory_update, memory_remove, memory_list
```

### 2.1 文件职责

| 文件 | 职责 | 导出 |
|------|------|------|
| index.ts | 统一导出 | `Memory` namespace |
| types.ts | 类型定义 | `MergedMemory`, `MemoryEntry`, `AddMemoryInput` 等 |
| constants.ts | 常量定义 | `MEMORY_HEADER`, `TIMESTAMP_FORMAT` |
| memory-manager.ts | 核心业务逻辑 | `load`, `add`, `update`, `remove`, `listEntries`, `refresh` |
| memory-discovery.ts | 文件路径查找 | `getGlobalMemoryPath`, `findProjectMemoryPath` |
| memory-parser.ts | 内容解析和生成 | `parseEntries`, `computeNewContent`, `mergeMemory` |
| memory-tools.ts | AI Tools 定义 | `MemoryTools` (4个工具) |

---

## 三、Core Types（核心类型）

### 3.1 MergedMemory

```typescript
// src/core/memory/types.ts

/**
 * 合并后的记忆内容
 */
export interface MergedMemory {
  /** 全局记忆内容（原始 Markdown） */
  global: string
  
  /** 项目记忆内容（原始 Markdown） */
  project: string
  
  /** 合并后的内容（添加来源标记后拼接） */
  merged: string
}
```

### 3.2 MemoryEntry

```typescript
/**
 * 记忆条目（AI 添加区域的单条记忆）
 */
export interface MemoryEntry {
  /** 条目索引（0-based） */
  index: number
  
  /** 时间戳（格式：2026-01-01 22:00:00） */
  timestamp: string
  
  /** 条目内容 */
  text: string
}
```

### 3.3 操作输入类型

```typescript
/**
 * 添加记忆输入
 */
export interface AddMemoryInput {
  /** 作用域：全局或项目级 */
  scope: 'global' | 'project'
  
  /** 要添加的事实/信息 */
  fact: string
  
  /** 项目目录（scope='project' 时必需） */
  directory?: string
}

/**
 * 更新记忆输入
 */
export interface UpdateMemoryInput {
  scope: 'global' | 'project'
  directory?: string
  
  /** 要更新的条目索引 */
  index: number
  
  /** 新的内容 */
  newText: string
}

/**
 * 删除记忆输入
 */
export interface RemoveMemoryInput {
  scope: 'global' | 'project'
  directory?: string
  
  /** 要删除的条目索引 */
  index: number
}
```

---

## 四、Core Functions（核心函数）

### 4.1 Memory.load

**签名**：
```typescript
async function load(directory: string): Promise<MergedMemory>
```

**流程**：
```
1. 调用 Project.fromDirectory(directory)
   └─> 获取 { id, rootPath }

2. 加载全局记忆
   ├─> 获取全局路径：getGlobalMemoryPath()
   │   └─> XDG 配置目录 + IRIS.md
   └─> 读取文件内容（不存在则返回空字符串）

3. 加载项目记忆
   ├─> 调用 findProjectMemoryPath(directory, rootPath)
   │   ├─> 从 directory 向上查找 IRIS.md
   │   └─> 找到第一个即停止，未找到返回 null
   └─> 读取文件内容（不存在则返回空字符串）

4. 合并记忆
   ├─> 调用 mergeMemory(globalContent, projectContent)
   │   ├─> 添加 HTML 注释标记来源
   │   └─> 用 ---  分隔符拼接
   └─> 返回 { global, project, merged }
```

### 4.2 Memory.add

**签名**：
```typescript
async function add(input: AddMemoryInput): Promise<void>
```

**流程**：
```
1. 确定文件路径
   ├─> scope === 'global': getGlobalMemoryPath()
   └─> scope === 'project': findProjectMemoryPath(...)

2. 读取当前内容
   └─> fs.readFile() 或 '' (文件不存在)

3. 计算新内容
   ├─> 调用 computeNewContent(currentContent, input.fact)
   │   ├─> 检查是否存在 MEMORY_HEADER
   │   ├─> 不存在：添加 Header 和第一条
   │   └─> 存在：追加到末尾
   └─> 添加时间戳：formatTimestamp()

4. 写入文件
   ├─> 确保目录存在（fs.mkdir recursive）
   └─> fs.writeFile(filePath, newContent)

5. 发布事件
   └─> Bus.publish(Memory.Event.Added, { scope, text })
```

### 4.3 Memory.update

**签名**：
```typescript
async function update(input: UpdateMemoryInput): Promise<void>
```

**流程**：
```
1. 确定文件路径并读取内容

2. 解析 AI 添加区域的条目
   └─> parseEntries(content)

3. 验证索引合法性
   ├─> index < 0 || index >= entries.length
   └─> 抛出异常

4. 更新指定条目
   ├─> 保留 Header 上方的用户手写区域
   ├─> 更新 entries[index].text = newText
   └─> 重新组装文件内容

5. 写入文件并发布事件
   └─> Bus.publish(Memory.Event.Updated, { scope, index, newText })
```

### 4.4 Memory.remove

**签名**：
```typescript
async function remove(input: RemoveMemoryInput): Promise<void>
```

**流程**：
```
1. 确定文件路径并读取内容

2. 解析条目并验证索引

3. 删除指定条目
   ├─> entries.splice(index, 1)
   └─> 重新组装文件内容

4. 写入文件并发布事件
   └─> Bus.publish(Memory.Event.Removed, { scope, index })
```

### 4.5 Memory.listEntries

**签名**：
```typescript
async function listEntries(
  scope: 'global' | 'project',
  directory?: string
): Promise<MemoryEntry[]>
```

**流程**：
```
1. 确定文件路径并读取内容

2. 调用 parseEntries(content)
   ├─> 定位 MEMORY_HEADER
   ├─> 提取 Header 下方的列表
   └─> 解析每行：- 时间戳: 内容

3. 返回 MemoryEntry 数组
```

---

## 五、MemoryDiscovery（文件发现）

### 5.1 全局路径获取

```typescript
function getGlobalMemoryPath(): string {
  // XDG 标准目录
  const configDir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'iris-code')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'iris-code')
  
  return path.join(configDir, 'IRIS.md')
}

// Linux/macOS: ~/.config/iris-code/IRIS.md
// Windows: %APPDATA%/iris-code/IRIS.md
```

### 5.2 项目路径查找（向上查找）

```typescript
async function findProjectMemoryPath(
  startDir: string,
  projectRoot: string
): Promise<string | null> {
  let currentDir = path.resolve(startDir)
  const root = path.resolve(projectRoot)
  
  while (true) {
    const irisPath = path.join(currentDir, 'IRIS.md')
    
    // 检查文件是否存在
    try {
      await fs.access(irisPath, fs.constants.R_OK)
      return irisPath  // 找到第一个即返回
    } catch {
      // 文件不存在，继续向上
    }
    
    // 到达项目根目录仍未找到
    if (currentDir === root) {
      return null
    }
    
    // 向上一级
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      // 到达文件系统根目录
      return null
    }
    currentDir = parentDir
  }
}
```

---

## 六、MemoryParser（内容解析）

### 6.1 条目解析

```typescript
function parseEntries(content: string): MemoryEntry[] {
  const headerIndex = content.indexOf(MEMORY_HEADER)
  if (headerIndex === -1) return []
  
  const afterHeader = content.slice(headerIndex + MEMORY_HEADER.length)
  const lines = afterHeader.split('\n')
  
  const entries: MemoryEntry[] = []
  let index = 0
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue  // 只处理列表项
    
    // 解析格式：- 2026-01-01 22:00:00: 内容
    const match = trimmed.match(/^-\s+(.{19}):\s+(.+)$/)
    if (match) {
      entries.push({
        index: index++,
        timestamp: match[1],
        text: match[2]
      })
    }
  }
  
  return entries
}
```

### 6.2 新内容计算

```typescript
function computeNewContent(currentContent: string, fact: string): string {
  const timestamp = formatTimestamp()
  const newEntry = `- ${timestamp}: ${fact}`
  
  // 检查是否存在 Header
  if (!currentContent.includes(MEMORY_HEADER)) {
    // 首次添加
    const userContent = currentContent.trim()
    const header = `\n\n${MEMORY_HEADER}\n\n`
    return userContent
      ? `${userContent}${header}${newEntry}`
      : `${MEMORY_HEADER}\n\n${newEntry}`
  }
  
  // 追加到末尾
  return `${currentContent.trimEnd()}\n${newEntry}`
}

function formatTimestamp(): string {
  const now = new Date()
  return now.toISOString().slice(0, 19).replace('T', ' ')
  // 格式：2026-01-01 22:00:00
}
```

### 6.3 记忆合并

```typescript
function mergeMemory(globalContent: string, projectContent: string): string {
  const parts: string[] = []
  
  if (globalContent.trim()) {
    parts.push(
      `<!-- Global Memory from ${getGlobalMemoryPath()} -->\n${globalContent.trim()}`
    )
  }
  
  if (projectContent.trim()) {
    parts.push(
      `<!-- Project Memory from <project-root>/IRIS.md -->\n${projectContent.trim()}`
    )
  }
  
  return parts.join('\n\n---\n\n')
}
```

---

## 七、Memory Tools（AI 工具定义）

### 7.1 工具分类

Memory 工具属于独立的 `memory` 类别（而非 `readonly`/`write`），在 ToolScheduler 中享有特殊权限策略：

| 分类特性 | 说明 |
|----------|------|
| 工具类别 | `memory`（独立类别，非 readonly/write） |
| 默认决策 | 所有模式下均为 ALLOW |
| 并发特性 | 始终可并行执行，不受读写锁限制 |
| 无需确认 | 系统内部操作，不触发 Permission 确认 |

### 7.2 工具操作类型

每个 Memory 工具有其操作类型（read/write），用于描述其行为，但不影响权限决策：

| 工具名称 | 操作类型 | 说明 |
|----------|----------|------|
| memory_list | read | 只读，列出记忆条目 |
| memory_add | write | 写入，添加新记忆 |
| memory_update | write | 写入，更新现有记忆 |
| memory_remove | write | 写入，删除现有记忆 |

### 7.3 Tool 定义

```typescript
// src/core/memory/memory-tools.ts

/**
 * Memory 工具元数据
 * category: 'memory' - 独立类别，默认 ALLOW
 * operationType: 'read' | 'write' - 描述性标记，不影响权限
 */
export const MemoryTools = {
  memory_list: {
    name: 'memory_list',
    category: 'memory',
    operationType: 'read',
    description: '列出当前所有记忆条目，查看索引、时间戳和内容',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] }
      },
      required: ['scope']
    }
  },
  
  memory_add: {
    name: 'memory_add',
    category: 'memory',
    operationType: 'write',
    description: '保存重要信息到长期记忆',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description: '记忆作用域：global 适用所有项目，project 仅当前项目'
        },
        fact: {
          type: 'string',
          description: '要记住的事实或信息'
        }
      },
      required: ['scope', 'fact']
    }
  },
  
  memory_update: {
    name: 'memory_update',
    category: 'memory',
    operationType: 'write',
    description: '更新已有的记忆条目',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] },
        index: { type: 'number', description: '要更新的条目索引' },
        newText: { type: 'string', description: '新的内容' }
      },
      required: ['scope', 'index', 'newText']
    }
  },
  
  memory_remove: {
    name: 'memory_remove',
    category: 'memory',
    operationType: 'write',
    description: '删除过时或错误的记忆条目',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] },
        index: { type: 'number', description: '要删除的条目索引' }
      },
      required: ['scope', 'index']
    }
  }
}
```

---

## 八、Error Handling（错误处理）

### 8.1 错误处理策略

| 场景 | 处理方式 | 返回值 |
|------|----------|--------|
| 文件不存在 | load(): 返回空字符串 | 正常执行 |
| 文件不可读 | 记录警告日志，返回空字符串 | 不中断流程 |
| 文件编码错误 | 尝试 UTF-8 读取，失败则记录错误 | 返回空字符串 |
| 文件过大 (>1MB) | 记录警告日志，仍然读取 | 正常执行 |
| 写入失败 | 抛出异常 | 由调用方处理 |
| 索引越界 | 抛出异常 | 由调用方处理 |
| 目录不存在 | add/update 时自动创建 | 正常执行 |

---

## 九、Performance Considerations（性能考量）

### 9.1 文件读取开销

| 操作 | 预期耗时 | 优化策略 |
|------|----------|----------|
| 读取 IRIS.md (< 100KB) | < 10ms | 无需优化 |
| 向上查找 | < 5ms | 找到第一个即停止 |
| 解析条目 | < 1ms | 简单正则匹配 |

### 9.2 不做的优化（YAGNI）

- **不缓存**：文件内容可能随时被用户手动修改
- **不批量操作**：add/update/remove 逐个执行，确保原子性
- **不异步并行**：全局和项目记忆顺序读取，简单可靠

---

## 十、文档自检

- [x] 架构简单清晰，无过度设计
- [x] 文件结构遵循单一职责原则
- [x] 错误处理策略明确
- [x] 不包含未确认的未来功能
- [x] 向上查找逻辑清晰
- [x] Tools 定义在模块内部，职责明确
