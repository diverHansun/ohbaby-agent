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
| parametersJsonSchema | JSON Schema | 参数定义和模型侧调用提示 |
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
| output | 主要输出内容（字符串） |
| metadata | 可选的元数据（用于 UI 显示） |
| error | 可选的错误信息 |

---

## 二、Data Types（数据类型）

### 2.1 核心接口

```typescript
// 工具定义接口
interface Tool {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
  source: 'builtin'
  category: 'readonly' | 'write' | 'dangerous'
  execute: (
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>
}

// 执行上下文
interface ToolExecutionContext {
  sessionId: string
  messageId: string
  callId: string
  signal: AbortSignal
}

// 工具输出
interface ToolExecutionResult {
  output?: string
  metadata?: Record<string, unknown>
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

### 2.3 工具定义方式

当前内置工具直接返回符合 `Tool` 接口的对象，并使用 `parametersJsonSchema` 声明参数；不在本轮引入 Zod 重写。

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
  expected_mtime_ms: z.number().optional().describe('覆盖既有文件时必须提供的 mtime 校验值'),
  dry_run: z.boolean().optional().describe('仅返回 Unified Diff 预览，不写入文件'),
})
```

### 3.3 edit 工具

```typescript
const EditParams = z.object({
  file_path: z.string().describe('要编辑的文件的绝对路径'),
  old_string: z.string().describe('要替换的原始文本；精确匹配失败时可能按有限空白 fuzzy 比较，需提供足够上下文'),
  new_string: z.string().describe('替换后的新文本'),
  replace_all: z.boolean().optional().describe('是否替换所有匹配'),
  dry_run: z.boolean().optional().describe('仅返回 Unified Diff 预览，不写入文件'),
  expected_mtime_ms: z.number().optional().describe('deprecated；兼容旧调用；edit 不使用该值'),
})
```

### 3.4 glob 工具

```typescript
const GlobParams = z.object({
  pattern: z.string().describe('glob 匹配模式，如 "**/*.ts"'),
  path: z.string().optional().describe('已授权的搜索根'),
  limit: z.number().int().min(1).optional().describe('默认返回 100 个匹配'),
})
```

模式为 rg 根相对 glob；支持字符类，字面 `[id]` 写为 `[[]id]`。绝对或根外模式失败，Windows 分隔符规范化为 `/`。

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
interface BashParams {
  command: string;
  description?: string;
  timeout?: number; // 正整数毫秒；按前后台路径校验
  run_in_background?: boolean; // 默认 false，true 立即后台
  wait_ms?: number; // 前台等待 1–600000 ms，默认 120000
  auto_background?: boolean; // false 禁止本次转换，不能绕过全局关闭
}
```

允许自动转换时默认等待 120000 ms，未完成则在同一任务上申请后台名额，未传 timeout 不设硬截止；显式后台立即返回，同样默认不限时。这两条路径的显式 timeout 最大 86400000 ms。关闭转换或角色没有完整管理工具时，纯前台默认硬超时 120000 ms、最大 600000 ms。显式后台在启动前原子检查名额并提交占位，再 spawn；自动转换的前台阶段不占后台额度。主代理默认 10 个、每个子代理默认 5 个，彼此独立。配置位于 `~/.ohbaby/tools/shell.json` 顶层 `maxRunningBackgroundJobs` 与 `maxRunningSubagentBackgroundJobs`，以及 `autoBackground`（默认 true）和 `defaultForegroundWaitMs`（默认 120000）。

转换提交保存 `mode=background`、`promotedAt` 和首份有界尾部，同步解除当前调用的中止关联；不重启、不改原始 owner/startedAt/timeoutMs。满额停止当前命令，报告 cancelled + capacity-limit；持久化失败报告 cancelled + internal-error，均保留真实 cleanup。转换规则见 [improve-2](2026-11-13-background-tasks/improve-2/02-optimization-plan-and-change-scope.md)。

当前 `task_output` 使用 `job_id`、`block?`、`wait_ms?`；wait_ms 只限制读取等待，不改变进程寿命。`task_kill` 使用 job_id，主动停止对应 cancelled，硬超时对应 timed_out。两者在 improve-3 统一为 task 三动作；当前阶段不提供临时 task_list 工厂。

ShellJobStore 保存历史与持久事实，Registry 只保留尚有进程、输出、清理或写入责任的对象；删除原先按 100 个终态淘汰的缓存。后台保存 32 KiB 尾部和检查点；纯前台不周期复制尾部到数据库。完整字段与空值语义见 [后台任务数据模型](2026-11-13-background-tasks/improve-1/design/data-model.md)。

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
const TodoContent = z.string().trim().min(1).refine(
  (value) => Array.from(value).length <= 100,
  '任务内容最多 100 个 Unicode 字符',
)

const TodoItem = z.object({
  content: TodoContent.describe('任务内容'),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()

const TodoWriteParams = z.object({
  todos: z.array(TodoItem).max(10).describe('完整待办事项列表'),
}).strict()

const TodoReadParams = z.object({}).strict()
```

Todo 不定义 `id` 或 `priority`；数组顺序即执行顺序，允许多个 `in_progress`。Unicode 长度按 code point 计算，避免把一个常见 emoji 计成两个 UTF-16 code unit；组合字素归一化不属于当前版本。详见 [`todo-list/data-model.md`](./todo-list/data-model.md)。

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
  lineCount: number          // 文件总行数
  shownLineCount: number     // 本次返回的行数
  mtimeMs: number            // 读取时的文件 mtime
  sizeBytes: number          // 文件大小
  encoding: 'utf8'
  lineEnding: 'LF' | 'CRLF' | 'mixed' | 'none'
  hasMore: boolean
  nextOffset?: number
}
```

**write 工具**：
```typescript
interface WriteMetadata extends BaseMetadata {
  bytes: number
  created: boolean
  dryRun?: boolean
  diff?: string
  mtimeMs: number
  sizeBytes: number
  encoding: 'utf8'
  lineEnding: 'LF' | 'CRLF' | 'mixed' | 'none'
  wouldCreate?: boolean
}
```

**edit 工具**：
```typescript
interface EditMetadata extends BaseMetadata {
  replacementCount: number   // 替换次数
  dryRun?: boolean
  diff?: string
  mtimeMs: number
  sizeBytes: number
  encoding: 'utf8'
  lineEnding: 'LF' | 'CRLF' | 'mixed' | 'none'
}
```

**bash 工具**：
```typescript
interface BashMetadata extends BaseMetadata {
  jobId: string              // job 逻辑 id
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'lost'
  stopReason?: string | null  // 逻辑终态的来源
  cleanup?: 'in-progress' | 'confirmed' | 'unconfirmed'
  outputComplete?: boolean | null
  truncated: boolean
  exitCode?: number | null    // 终态字段
  signal?: string | null      // 终态字段
}
```

**glob 工具**：
```typescript
interface GlobMetadata {
  count: number
  truncated: boolean
  scanComplete: boolean
  displayLimited: boolean
  stopReason?: 'match-limit' | 'output-limit' | 'record-limit' | 'stdout-limit'
}
```

count 为已采集的返回路径数；displayLimited 表示正文少于采集结果。恰好 limit 且正常结束为完整，观察到 limit+1 才数量截断。正常空扫描才显示无匹配；错误与取消不伪装成功。不提供 visitedFileCount。Grep 的文本/JSON 协议与完整性合同见 [工具接口](dfd-interface.md)，不与 Glob 的 NUL 路径协议共用解析器。

---

## 五、Output Limits Configuration（输出限制配置）

```typescript
interface ToolLimits {
  read: {
    maxLines: number         // 默认 2000
    maxLineLength: number    // 默认 2000
  }
  bash: {
    maxOutputLength: number  // 默认约 32000 字符，内存尾部
    defaultTimeout: number   // 纯前台默认 120000；显式后台没有默认硬超时
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
- timeout：正整数；纯前台 <= 600000，显式后台 <= 86400000（毫秒）
- num_results: >= 1, <= 100

---

## 八、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 每个工具的参数定义完整
- [x] 验证规则明确
- [x] 类型定义符合 TypeScript 规范
