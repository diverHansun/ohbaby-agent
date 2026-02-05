# tools 模块 data-model.md

本文档定义 `tools` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 Tool（工具）

工具是一个可执行的功能单元，接收参数并返回结果。

**组成要素**：

| 要素 | 类型 | 说明 |
|------|------|------|
| name | string | 工具唯一标识符 |
| description | string | 工具功能描述（供 LLM 理解） |
| parameters | ZodSchema | 参数定义和验证 |
| execute | function | 执行函数 |

### 1.2 ToolContext（执行上下文）

工具执行时的上下文信息，由 ToolScheduler 提供。

| 字段 | 说明 |
|------|------|
| sessionId | 所属会话标识 |
| messageId | 关联的消息标识 |
| callId | 本次调用标识 |
| signal | AbortSignal，用于取消执行 |

### 1.3 ToolOutput（工具输出）

工具执行的返回结果。

| 字段 | 说明 |
|------|------|
| content | 主要输出内容（字符串） |
| metadata | 可选的元数据（用于 UI 显示） |
| error | 可选的错误信息 |

---

## 二、Data Types（数据类型）

### 2.1 核心接口

```typescript
// 工具定义接口
interface Tool<TParams = unknown> {
  name: string
  description: string
  parameters: z.ZodType<TParams>
  execute: (params: TParams, context: ToolContext) => Promise<ToolOutput>
}

// 执行上下文
interface ToolContext {
  sessionId: string
  messageId: string
  callId: string
  signal: AbortSignal
}

// 工具输出
interface ToolOutput {
  content: string
  metadata?: Record<string, unknown>
  error?: ToolError
}

// 工具错误
interface ToolError {
  type: ToolErrorType
  message: string
}
```

### 2.2 错误类型枚举

```typescript
type ToolErrorType =
  | 'FileNotFoundError'
  | 'PermissionDeniedError'
  | 'BinaryFileError'
  | 'TimeoutError'
  | 'InvalidParameterError'
  | 'ExecutionError'
  | 'NetworkError'
  | 'OutputTruncatedWarning'
```

### 2.3 工具定义辅助函数

```typescript
namespace Tool {
  function define<TParams>(config: {
    name: string
    description: string
    parameters: z.ZodType<TParams>
    execute: (params: TParams, context: ToolContext) => Promise<ToolOutput>
  }): Tool<TParams>
}
```

---

## 三、Tool Parameters（工具参数定义）

### 3.1 read 工具

```typescript
const ReadParams = z.object({
  file_path: z.string().describe('要读取的文件的绝对路径'),
  offset: z.number().optional().describe('起始行号（从 1 开始）'),
  limit: z.number().optional().describe('读取的行数限制'),
})
```

### 3.2 write 工具

```typescript
const WriteParams = z.object({
  file_path: z.string().describe('要写入的文件的绝对路径'),
  content: z.string().describe('要写入的内容'),
})
```

### 3.3 edit 工具

```typescript
const EditParams = z.object({
  file_path: z.string().describe('要编辑的文件的绝对路径'),
  old_string: z.string().describe('要替换的原始文本'),
  new_string: z.string().describe('替换后的新文本'),
  replace_all: z.boolean().optional().describe('是否替换所有匹配'),
})
```

### 3.4 glob 工具

```typescript
const GlobParams = z.object({
  pattern: z.string().describe('glob 匹配模式，如 "**/*.ts"'),
  path: z.string().optional().describe('搜索的基础路径'),
})
```

### 3.5 grep 工具

```typescript
const GrepParams = z.object({
  pattern: z.string().describe('正则表达式搜索模式'),
  path: z.string().optional().describe('搜索的基础路径'),
  include: z.string().optional().describe('文件过滤模式，如 "*.ts"'),
})
```

### 3.6 list 工具

```typescript
const ListParams = z.object({
  path: z.string().optional().describe('要列出的目录路径'),
  ignore: z.array(z.string()).optional().describe('要忽略的模式列表'),
})
```

### 3.7 bash 工具

```typescript
const BashParams = z.object({
  command: z.string().describe('要执行的 Shell 命令'),
  description: z.string().describe('命令的简短描述'),
  timeout: z.number().optional().describe('超时时间（毫秒）'),
  workdir: z.string().optional().describe('工作目录'),
})
```

### 3.8 task 工具

```typescript
const TaskParams = z.object({
  description: z.string().describe('任务简述（3-5 词）'),
  prompt: z.string().describe('任务指令'),
  subagent_type: z.string().describe('子代理类型（explore/research）'),
  session_id: z.string().optional().describe('继续现有子 Session'),
})
```

### 3.9 todo 工具

```typescript
const TodoItem = z.object({
  id: z.string().describe('唯一标识符'),
  content: z.string().describe('任务内容'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']).describe('优先级'),
})

const TodoWriteParams = z.object({
  todos: z.array(TodoItem).describe('待办事项列表'),
})
```

---

## 四、Tool Metadata（工具元数据）

### 4.1 通用元数据

```typescript
interface BaseMetadata {
  truncated?: boolean        // 输出是否被截断
  totalCount?: number        // 总数（截断时显示）
  executionTime?: number     // 执行时间（毫秒）
}
```

### 4.2 工具特定元数据

**read 工具**：
```typescript
interface ReadMetadata extends BaseMetadata {
  lineCount: number          // 实际读取的行数
  fileSize: number           // 文件大小
  fileType: 'text' | 'image' | 'pdf' | 'binary'
}
```

**edit 工具**：
```typescript
interface EditMetadata extends BaseMetadata {
  replacementCount: number   // 替换次数
  diff: string               // diff 内容
  diagnostics?: Diagnostic[] // LSP 诊断信息
}
```

**bash 工具**：
```typescript
interface BashMetadata extends BaseMetadata {
  exitCode: number           // 退出码
  command: string            // 执行的命令
}
```

**glob/grep 工具**：
```typescript
interface SearchMetadata extends BaseMetadata {
  matchCount: number         // 匹配数量
  searchPath: string         // 搜索路径
}
```

---

## 五、Output Limits Configuration（输出限制配置）

```typescript
interface ToolLimits {
  read: {
    maxLines: number         // 默认 2000
    maxLineLength: number    // 默认 2000
  }
  bash: {
    maxOutputLength: number  // 默认 30000
    defaultTimeout: number   // 默认 120000 (2分钟)
  }
  glob: {
    maxResults: number       // 默认 100
  }
  grep: {
    maxMatches: number       // 默认 100
  }
}

const DEFAULT_LIMITS: ToolLimits = {
  read: { maxLines: 2000, maxLineLength: 2000 },
  bash: { maxOutputLength: 30000, defaultTimeout: 120000 },
  glob: { maxResults: 100 },
  grep: { maxMatches: 100 },
}
```

---

## 六、Constants（常量定义）

### 6.1 默认忽略模式（list 工具）

```typescript
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/',
  '__pycache__/',
  '.git/',
  'dist/',
  'build/',
  'target/',
  'vendor/',
  '.venv/',
  'venv/',
  '.idea/',
  '.vscode/',
  'coverage/',
  '.cache/',
]
```

### 6.2 支持的图片格式（read 工具）

```typescript
const IMAGE_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'
]
```

### 6.3 禁止读取的文件（read 工具）

```typescript
const BLOCKED_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
]
```

---

## 七、Validation Rules（验证规则）

### 7.1 路径验证

- file_path 必须是绝对路径
- path 参数可以是相对路径（相对于工作目录）
- 路径中的 `..` 需要被解析

### 7.2 参数范围验证

- offset: >= 1
- limit: >= 1
- timeout: > 0, <= 600000 (10分钟)
- num_results: >= 1, <= 100

---

## 八、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 每个工具的参数定义完整
- [x] 验证规则明确
- [x] 类型定义符合 TypeScript 规范
