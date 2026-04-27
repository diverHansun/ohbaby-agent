# utils 模块 dfd-interface.md

本文档描述 utils 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

utils 模块是 ohbaby-agent 的底层基础设施层，被所有上层业务模块依赖。

### 交互模块

| 模块 | 交互方式 | 说明 |
|------|---------|------|
| agent | 依赖 utils | 使用 logger、cleanup |
| tools | 依赖 utils | 使用 paths、file-type、format、truncate |
| permissions | 依赖 utils | 使用 paths（contains 检查） |
| sessions | 依赖 utils | 使用 summary |
| llm | 依赖 utils | 使用 logger、error |
| config | 依赖 utils | 使用 paths |
| mcp | 依赖 utils | 使用 lazy、logger |
| ui | 依赖 utils | 使用 logger |

---

## 二、Data Flow Description（数据流描述）

### 2.1 日志数据流

```
业务模块
    │
    │ 调用 Log.create({ service: 'xxx' })
    ▼
┌─────────────────────────────────────┐
│            utils/logger.ts           │
│                                      │
│  创建 Logger 实例                    │
│  ├─ 绑定 service 标签               │
│  └─ 关联全局日志配置                │
└─────────────────────────────────────┘
    │
    │ 返回 Logger 实例
    ▼
业务模块
    │
    │ log.info('message', { key: value })
    ▼
┌─────────────────────────────────────┐
│            utils/logger.ts           │
│                                      │
│  格式化日志消息                      │
│  ├─ 添加时间戳                      │
│  ├─ 添加耗时                        │
│  ├─ 添加标签                        │
│  └─ 添加消息内容                    │
└─────────────────────────────────────┘
    │
    ├─────────────────┬─────────────────┐
    │                 │                 │
    ▼                 ▼                 ▼
  stderr           日志文件          （未来扩展）
```

### 2.2 错误处理数据流

```
业务模块定义错误类型
    │
    │ class MyError extends IrisError
    ▼
┌─────────────────────────────────────┐
│         permissions/errors.ts        │
│                                      │
│  class PermissionDeniedError         │
│    extends IrisError                 │
└─────────────────────────────────────┘
    │
    │ 抛出错误
    ▼
上层调用者
    │
    │ 捕获并处理
    ▼
┌─────────────────────────────────────┐
│            错误处理逻辑              │
│                                      │
│  if (IrisError.isInstance(error))   │
│    ├─ error.code                    │
│    ├─ error.message                 │
│    └─ error.data                    │
└─────────────────────────────────────┘
    │
    │ 格式化输出
    ▼
┌─────────────────────────────────────┐
│         utils/error.ts               │
│                                      │
│  formatError(error)                  │
│  → "[PERMISSION_DENIED] Access..."  │
└─────────────────────────────────────┘
```

### 2.3 清理函数数据流

```
应用启动
    │
    ▼
各模块注册清理函数
    │
    ├─ registerCleanup(() => closeMcpConnections())
    ├─ registerCleanup(async () => await flushLogs())
    └─ registerSyncCleanup(() => cleanupTempFiles())
    │
    ▼
┌─────────────────────────────────────┐
│          utils/cleanup.ts            │
│                                      │
│  cleanupFunctions: CleanupFn[]       │
│  syncCleanupFunctions: (() => void)[]│
└─────────────────────────────────────┘
    │
    │ 程序退出信号
    ▼
┌─────────────────────────────────────┐
│          utils/cleanup.ts            │
│                                      │
│  runExitCleanup()                    │
│  ├─ runSyncCleanup()                │
│  │    └─ 执行同步清理函数           │
│  └─ 顺序执行异步清理函数            │
└─────────────────────────────────────┘
    │
    ▼
process.exit()
```

### 2.4 路径检查数据流

```
permissions 模块
    │
    │ 检查文件是否在允许范围内
    ▼
┌─────────────────────────────────────┐
│          utils/paths.ts              │
│                                      │
│  contains(projectDir, targetPath)    │
│  ├─ normalizePath(projectDir)       │
│  ├─ normalizePath(targetPath)       │
│  └─ 比较路径前缀                    │
└─────────────────────────────────────┘
    │
    │ 返回 boolean
    ▼
permissions 模块
    │
    │ 根据结果决定是否允许操作
    ▼
允许 / 拒绝
```

### 2.5 懒加载数据流

```
mcp 模块
    │
    │ 定义懒加载资源
    ▼
┌─────────────────────────────────────┐
│          utils/lazy.ts               │
│                                      │
│  const client = lazyAsync(async () =>│
│    await createMcpClient()           │
│  )                                   │
└─────────────────────────────────────┘
    │
    │ 返回 getter 函数
    ▼
mcp 模块
    │
    │ 首次调用 await client()
    ▼
┌─────────────────────────────────────┐
│          utils/lazy.ts               │
│                                      │
│  执行初始化函数                      │
│  缓存结果                            │
└─────────────────────────────────────┘
    │
    │ 后续调用 await client()
    ▼
┌─────────────────────────────────────┐
│          utils/lazy.ts               │
│                                      │
│  直接返回缓存结果                    │
└─────────────────────────────────────┘
```

### 2.6 文本格式化数据流

```
tools/fileRead.ts
    │
    │ 读取文件内容
    ▼
┌─────────────────────────────────────┐
│         utils/format.ts              │
│                                      │
│  formatWithLineNumbers(content)      │
│  ├─ 分割为行数组                    │
│  ├─ 处理超长行                      │
│  └─ 添加行号前缀                    │
└─────────────────────────────────────┘
    │
    │ 返回格式化字符串
    ▼
┌─────────────────────────────────────┐
│        utils/truncate.ts             │
│                                      │
│  truncateIfTooLong(result)           │
│  ├─ 估算 token 数量                 │
│  └─ 必要时截断                      │
└─────────────────────────────────────┘
    │
    │ 返回最终结果
    ▼
LLM 上下文
```

---

## 三、Interface Definition（接口定义）

### 3.1 日志系统接口

#### Log.create

创建 Logger 实例。

```typescript
function create(tags?: Record<string, string>): Logger
```

输入：
- tags：可选，日志标签键值对

输出：
- Logger 实例

使用场景：
- 各模块在初始化时创建自己的 logger

#### Log.init

初始化日志系统。

```typescript
function init(options: InitOptions): Promise<void>
```

输入：
- options.print：是否仅输出到 stderr
- options.level：日志级别
- options.maxFiles：保留的日志文件数量

输出：
- Promise，初始化完成

使用场景：
- 应用启动时调用一次

#### Logger.info / debug / warn / error

记录日志。

```typescript
function info(message: string, extra?: Record<string, unknown>): void
```

输入：
- message：日志消息
- extra：可选，附加数据

输出：
- 无（写入日志输出）

#### Logger.time

开始时间追踪。

```typescript
function time(message: string): Disposable
```

输入：
- message：操作描述

输出：
- Disposable，作用域结束时自动记录耗时

### 3.2 错误处理接口

#### IrisError 构造函数

```typescript
constructor(
  code: string,
  message: string,
  data?: Record<string, unknown>,
  options?: ErrorOptions
)
```

输入：
- code：错误码
- message：错误消息
- data：可选，附加数据
- options：可选，错误选项（如 cause）

#### IrisError.isInstance

类型守卫函数。

```typescript
static isInstance(error: unknown): error is IrisError
```

输入：
- error：待检查的值

输出：
- boolean，是否为 IrisError 实例

#### formatError

格式化错误为字符串。

```typescript
function formatError(error: unknown): string
```

输入：
- error：任意错误

输出：
- 格式化的错误字符串

### 3.3 清理系统接口

#### registerCleanup

注册清理函数。

```typescript
function registerCleanup(fn: CleanupFn): void
```

输入：
- fn：清理函数（同步或异步）

输出：
- 无

#### runExitCleanup

执行所有清理函数。

```typescript
function runExitCleanup(): Promise<void>
```

输入：
- 无

输出：
- Promise，所有清理完成

### 3.4 路径操作接口

#### normalizePath

规范化路径。

```typescript
function normalizePath(p: string): string
```

输入：
- p：原始路径

输出：
- 规范化后的路径

说明：
- 处理 Windows 路径大小写问题
- 使用 realpathSync.native

#### contains

检查子路径关系。

```typescript
function contains(parent: string, child: string): boolean
```

输入：
- parent：父路径
- child：子路径

输出：
- boolean，child 是否在 parent 下

### 3.5 懒加载接口

#### lazy

同步懒加载。

```typescript
function lazy<T>(fn: () => T): () => T
```

输入：
- fn：初始化函数

输出：
- getter 函数，首次调用时执行 fn

#### lazyAsync

异步懒加载。

```typescript
function lazyAsync<T>(fn: () => Promise<T>): () => Promise<T>
```

输入：
- fn：异步初始化函数

输出：
- getter 函数，首次调用时执行 fn

### 3.6 文本处理接口

#### formatWithLineNumbers

添加行号。

```typescript
function formatWithLineNumbers(
  content: string | string[],
  options?: FormatOptions
): string
```

输入：
- content：文件内容
- options：可选，格式化选项

输出：
- 带行号的格式化字符串

#### truncateIfTooLong

智能截断。

```typescript
function truncateIfTooLong(
  result: string | string[],
  tokenLimit?: number
): string | string[]
```

输入：
- result：原始结果
- tokenLimit：可选，token 限制

输出：
- 截断后的结果

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 日志数据

| 数据 | 创建者 | 所有者 | 更新者 |
|------|--------|--------|--------|
| 日志配置 | Log.init | utils | 不更新（初始化后不变） |
| 日志文件 | Logger | 文件系统 | Logger（追加写入） |
| Logger 实例 | 各模块 | 各模块 | 无（实例不可变） |

### 错误数据

| 数据 | 创建者 | 所有者 | 更新者 |
|------|--------|--------|--------|
| IrisError 实例 | 业务模块 | 抛出/捕获者 | 无（实例不可变） |

### 清理函数

| 数据 | 创建者 | 所有者 | 更新者 |
|------|--------|--------|--------|
| cleanupFunctions 数组 | utils | utils | 各模块（注册）、utils（清空） |

---

## 五、Usage Examples（使用示例）

### 5.1 日志使用

```typescript
// 模块初始化时
import { Log } from '@/utils'

const log = Log.create({ service: 'bash-tool' })

// 记录信息
log.info('Command executed', { command: 'ls', exitCode: 0 })

// 时间追踪
using timer = log.time('Processing file')
await processFile()
// 自动输出耗时
```

### 5.2 错误使用

```typescript
// 定义模块错误（在业务模块中）
import { IrisError } from '@/utils'

export class PermissionDeniedError extends IrisError {
  constructor(path: string) {
    super('PERMISSION_DENIED', `Access denied: ${path}`, { path })
  }
}

// 使用
throw new PermissionDeniedError('/etc/passwd')

// 捕获
try {
  await readFile(path)
} catch (error) {
  if (IrisError.isInstance(error)) {
    console.error(`[${error.code}] ${error.message}`)
  }
}
```

### 5.3 清理使用

```typescript
import { registerCleanup } from '@/utils'

// 注册清理函数
registerCleanup(async () => {
  await mcpManager.dispose()
})

registerCleanup(() => {
  tempFiles.forEach(f => fs.unlinkSync(f))
})
```

### 5.4 路径检查使用

```typescript
import { contains, normalizePath } from '@/utils'

const projectDir = normalizePath(process.cwd())
const targetPath = normalizePath('/some/file.txt')

if (!contains(projectDir, targetPath)) {
  throw new PermissionDeniedError(targetPath)
}
```

### 5.5 懒加载使用

```typescript
import { lazyAsync } from '@/utils'

const mcpClient = lazyAsync(async () => {
  const client = new McpClient(config)
  await client.connect()
  return client
})

// 首次使用时初始化
const client = await mcpClient()
```

---

## 六、文档自检

- 数据流描述清晰，可追溯输入输出
- 接口定义完整，包含输入输出说明
- 数据归属明确，责任边界清晰
- 提供使用示例，便于理解
