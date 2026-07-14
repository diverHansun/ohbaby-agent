# utils 模块 architecture.md

本文档描述 utils 模块的内部架构与设计模式。所有设计基于 goals-duty.md 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

utils 模块是 ohbaby-agent 的底层基础设施层，位于所有业务模块之下，提供通用工具函数和统一的基础设施。

### 核心架构

```
src/utils/
├── index.ts                 # 公开接口统一导出
│
├── logger.ts               # 日志系统
├── error.ts                # 错误处理基类
├── cleanup.ts              # 生命周期清理
│
├── paths.ts                # 路径操作（现有 + 增强）
├── file-type.ts            # 文件类型检测（现有）
├── normalize.ts            # 路径规范化辅助（可选，可合并到 paths）
│
├── lazy.ts                 # 懒加载
├── defer.ts                # 资源释放
│
├── format.ts               # 文本格式化
├── truncate.ts             # 智能截断
│
├── command-parser/         # 命令解析（新增）
│   ├── index.ts            # 统一导出
│   ├── types.ts            # 类型定义
│   ├── bash-parser.ts      # tree-sitter-bash 解析
│   └── powershell-parser.ts # PowerShell 解析
│
├── summary.ts              # 会话总结（现有）
└── testHelpers.ts          # 测试辅助（现有）
```

### 组件依赖关系

```
                    ┌─────────────────────────────────────┐
                    │           上层业务模块               │
                    │  agent / tools / permissions / ...  │
                    └─────────────────────────────────────┘
                                      │
                                      │ 依赖
                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           utils 模块                                 │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │  logger.ts  │  │  error.ts   │  │ cleanup.ts  │  基础设施       │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐                                   │
│  │  paths.ts   │  │ file-type.ts│                 路径/文件         │
│  └─────────────┘  └─────────────┘                                   │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐                                   │
│  │   lazy.ts   │  │  defer.ts   │                 模式工具         │
│  └─────────────┘  └─────────────┘                                   │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐                                   │
│  │  format.ts  │  │ truncate.ts │                 文本处理         │
│  └─────────────┘  └─────────────┘                                   │
│                                                                      │
│  ┌───────────────────────────────┐                                   │
│  │  command-parser/              │                 命令解析         │
│  │  - bash-parser.ts             │                                   │
│  │  - powershell-parser.ts       │                                   │
│  └───────────────────────────────┘                                   │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐                                  │
│  │  summary.ts │  │testHelpers.ts│                辅助工具         │
│  └─────────────┘  └──────────────┘                                  │
└──────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ 依赖
                                      ▼
                    ┌─────────────────────────────────────┐
                    │          Node.js 标准库              │
                    │    fs / path / os / async_hooks     │
                    └─────────────────────────────────────┘
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 命名空间模式（Namespace Pattern）

日志系统采用命名空间模式组织。

```typescript
export namespace Log {
  export type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  export interface Logger { ... }

  export function create(tags?: Record<string, string>): Logger
  export function init(options: InitOptions): Promise<void>
  export function setLevel(level: Level): void
}
```

理由：
- 将相关类型和函数组织在一起
- 避免命名冲突
- 借鉴 OpenCode 的设计模式
- 便于按需导入

### 2.2 工厂模式（Factory Pattern）

Logger 实例通过工厂函数创建。

```typescript
// 各模块创建自己的 logger 实例
const log = Log.create({ service: 'bash' })
const anotherLog = Log.create({ service: 'mcp-manager' })
```

理由：
- 各模块拥有独立的 logger 实例
- 支持不同的标签配置
- 便于日志来源追踪
- 符合 goals-duty 中"各模块有自己的 logger"的设计

### 2.3 继承模式（Inheritance Pattern）

错误系统采用类继承模式。

```typescript
// utils/error.ts - 基类
export class IrisError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'IrisError'
  }
}

// permissions/errors.ts - 业务模块继承
export class PermissionDeniedError extends IrisError {
  constructor(path: string) {
    super('PERMISSION_DENIED', `Access denied: ${path}`, { path })
  }
}
```

理由：
- 简单直观，符合 KISS 原则
- 各模块定义自己的错误类型，符合 SRP 原则
- 支持 instanceof 检查
- 不引入额外依赖（如 Zod）

### 2.4 注册模式（Registry Pattern）

清理系统采用函数注册模式。

```typescript
// 注册清理函数
registerCleanup(() => {
  // 同步清理
})

registerCleanup(async () => {
  // 异步清理
})

// 程序退出时执行
await runExitCleanup()
```

理由：
- 解耦注册和执行
- 支持多个模块注册各自的清理逻辑
- 借鉴 Gemini-CLI 的设计

### 2.5 懒加载模式（Lazy Initialization）

高开销资源延迟初始化。

```typescript
const parser = lazy(async () => {
  const { Parser } = await import('web-tree-sitter')
  await Parser.init()
  return new Parser()
})

// 首次调用时初始化，后续复用
const p = await parser()
```

理由：
- 避免启动时加载不必要的资源
- 单个资源加载失败不影响全局
- MCP 模块使用此模式初始化客户端
- 借鉴 OpenCode 的设计

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 文件职责划分

#### logger.ts

职责：日志系统的工厂和管理

内容：
- `Log` 命名空间
  - `Level` 类型：日志级别枚举
  - `Logger` 接口：日志器接口定义
  - `create(tags?)`: 创建 logger 实例
  - `init(options)`: 初始化日志系统（文件输出等）
  - `setLevel(level)`: 设置全局日志级别
  - `file()`: 获取当前日志文件路径

关键设计：
```typescript
export namespace Log {
  export type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

  export interface Logger {
    debug(message: string, extra?: Record<string, unknown>): void
    info(message: string, extra?: Record<string, unknown>): void
    warn(message: string, extra?: Record<string, unknown>): void
    error(message: string, extra?: Record<string, unknown>): void
    tag(key: string, value: string): Logger
    time(message: string): Disposable
  }

  export interface InitOptions {
    print?: boolean      // 仅输出到 stderr，不写文件
    level?: Level        // 日志级别
    maxFiles?: number    // 保留的日志文件数量
  }
}
```

#### error.ts

职责：提供错误基类和格式化工具

内容：
- `IrisError` 类：错误基类
- `formatError(error)`: 格式化错误为字符串
- `getErrorMessage(error)`: 提取错误消息

关键设计：
```typescript
export class IrisError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: Record<string, unknown>,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'IrisError'
  }

  static isInstance(error: unknown): error is IrisError {
    return error instanceof IrisError
  }

  toObject(): { code: string; message: string; data?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      data: this.data
    }
  }
}
```

#### cleanup.ts

职责：管理程序退出时的清理函数

内容：
- `registerCleanup(fn)`: 注册异步或同步清理函数
- `registerSyncCleanup(fn)`: 注册仅同步清理函数
- `runSyncCleanup()`: 执行同步清理
- `runExitCleanup()`: 执行所有清理（包括异步）

关键设计：
```typescript
type CleanupFn = (() => void) | (() => Promise<void>)

const cleanupFunctions: CleanupFn[] = []
const syncCleanupFunctions: Array<() => void> = []

export function registerCleanup(fn: CleanupFn): void
export function registerSyncCleanup(fn: () => void): void
export function runSyncCleanup(): void
export async function runExitCleanup(): Promise<void>
```

#### paths.ts

职责：路径操作和项目路径管理

内容：
- `ProjectPaths` 类（现有）：项目路径管理
- `normalizePath(path)`: 路径规范化
- `contains(parent, child)`: 检查子路径
- `overlaps(a, b)`: 检查路径交集

关键设计：
```typescript
export class ProjectPaths {
  static readonly CONFIG_DIR = '.ohbaby'
  static getGlobalConfigPath(): string
  static getPermissionsPath(cwd?: string): string
  static getMCPConfigPath(cwd?: string): string
  static ensureDirectoryExists(filePath: string): void
}

export function normalizePath(p: string): string
export function contains(parent: string, child: string): boolean
export function overlaps(a: string, b: string): boolean
```

#### file-type.ts（现有）

职责：文件类型检测

内容：
- `isTextFile(filePath)`: 综合判断是否为文本文件
- `isTextFileByExtension(filePath)`: 基于扩展名判断
- `isTextFileByContent(filePath)`: 基于内容判断
- `parseContentType(contentType)`: 解析 MIME 类型

#### lazy.ts

职责：延迟初始化工具

内容：
- `lazy<T>(fn)`: 同步懒加载
- `lazyAsync<T>(fn)`: 异步懒加载

关键设计：
```typescript
export function lazy<T>(fn: () => T): () => T {
  let value: T | undefined
  let initialized = false

  return () => {
    if (!initialized) {
      value = fn()
      initialized = true
    }
    return value!
  }
}

export function lazyAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined

  return () => {
    if (!promise) {
      promise = fn()
    }
    return promise
  }
}
```

#### defer.ts

职责：资源自动释放

内容：
- `defer(fn)`: 创建 Disposable 对象

关键设计：
```typescript
export function defer(fn: () => void | Promise<void>): Disposable {
  return {
    [Symbol.dispose]() {
      fn()
    }
  }
}

// 使用示例
using cleanup = defer(() => fs.closeSync(fd))
```

#### format.ts

职责：文本格式化工具

内容：
- `formatWithLineNumbers(content, options?)`: 添加行号
- `checkEmptyContent(content)`: 检查空内容

关键设计：
```typescript
export interface FormatOptions {
  startLine?: number     // 起始行号，默认 1
  maxLineLength?: number // 单行最大长度，默认 10000
}

export function formatWithLineNumbers(
  content: string | string[],
  options?: FormatOptions
): string

export function checkEmptyContent(content: string): string | null
```

#### truncate.ts

职责：智能截断工具

内容：
- `truncateIfTooLong(result, tokenLimit?)`: 根据 token 限制截断

关键设计：
```typescript
const DEFAULT_TOKEN_LIMIT = 20000
const CHARS_PER_TOKEN = 4
const TRUNCATION_GUIDANCE = '... [results truncated]'

export function truncateIfTooLong(
  result: string | string[],
  tokenLimit?: number
): string | string[]
```

#### summary.ts（现有）

职责：会话总结提示构建

内容：
- `buildSummaryPrompt(messages)`: 构建总结提示

#### testHelpers.ts（现有）

职责：测试辅助工具

内容：
- `createTempProject(options?)`: 创建临时测试项目

#### command-parser/（新增）

职责：Shell 命令解析工具

组成：
- `index.ts`: 统一导出接口
- `types.ts`: 类型定义
- `bash-parser.ts`: tree-sitter-bash 解析器（Unix/macOS/Git Bash）
- `powershell-parser.ts`: PowerShell 解析器（Windows）

关键设计：
```typescript
// command-parser/types.ts

/** 解析后的命令结构 */
export interface ParsedCommand {
  /** 命令头部列表（如 ['git', 'echo']） */
  roots: string[]
  
  /** 解析是否出错 */
  hasError: boolean
  
  /** 详细的命令段（用于高级分析） */
  details: CommandDetail[]
}

/** 单个命令段的详细信息 */
export interface CommandDetail {
  /** 命令文本 */
  text: string
  
  /** 命令根（如 'git'） */
  root: string
  
  /** 检测到的路径参数 */
  paths: string[]
}

// command-parser/index.ts

import { Shell } from '@/shell'

/**
 * 解析命令并返回结构化数据
 * 根据当前 shell 类型自动选择解析器
 */
export function parseCommand(command: string): ParsedCommand

/**
 * 提取命令头部列表（快捷方法）
 * @example getCommandRoots('git push && npm install') // ['git', 'npm']
 */
export function getCommandRoots(command: string): string[]

/**
 * 检测命令中的路径参数
 * @example detectPaths('rm -rf /etc/passwd') // ['/etc/passwd']
 */
export function detectPaths(command: string): string[]

/**
 * 判断命令是否匹配指定模式
 * 支持通配符匹配（如 'git push*'）
 */
export function matchesPattern(command: string, pattern: string): boolean
```

平台策略：
- Unix/macOS/Git Bash：使用 tree-sitter-bash 解析
- Windows（PowerShell）：使用 PowerShell 原生 AST 解析（通过 spawnSync 调用）

使用示例：
```typescript
import { getCommandRoots, detectPaths, matchesPattern } from '@/utils/command-parser'

// bash 工具中使用
const roots = getCommandRoots('git push && npm install')
// ['git', 'npm']

const paths = detectPaths('rm -rf /etc/passwd ~/important')
// ['/etc/passwd', '~/important']

// Policy 模块中使用
const isCritical = matchesPattern('git push -f origin main', 'git push*')
// true
```

#### index.ts

职责：统一导出公开接口

内容：
```typescript
// 基础设施
export { Log } from './logger.js'
export { IrisError, formatError, getErrorMessage } from './error.js'
export { registerCleanup, registerSyncCleanup, runSyncCleanup, runExitCleanup } from './cleanup.js'

// 路径和文件
export { ProjectPaths, normalizePath, contains, overlaps } from './paths.js'
export { isTextFile, isTextFileByExtension, isTextFileByContent } from './file-type.js'

// 模式工具
export { lazy, lazyAsync } from './lazy.js'
export { defer } from './defer.js'

// 文本处理
export { formatWithLineNumbers, checkEmptyContent } from './format.js'
export { truncateIfTooLong } from './truncate.js'

// 命令解析
export { 
  parseCommand, 
  getCommandRoots, 
  detectPaths, 
  matchesPattern,
  type ParsedCommand,
  type CommandDetail
} from './command-parser/index.js'

// 辅助工具
export { buildSummaryPrompt } from './summary.js'
export { createTempProject } from './testHelpers.js'
```

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 4.1 简单继承 vs Zod 集成错误系统

当前方案：使用简单的类继承实现错误系统

未采用方案：OpenCode 风格的 NamedError + Zod schema

理由：
- 简单继承更直观，符合 KISS 原则
- 不引入 Zod 依赖
- 满足当前需求（错误码、消息、元数据）
- 未来如需 schema 验证，可渐进式升级

代价：
- 不支持运行时 schema 验证
- 序列化不如 Zod 版本自动化

### 4.2 Logger 实例 vs 全局单例

当前方案：各模块通过工厂函数创建自己的 Logger 实例

未采用方案：全局单一 Logger 实例

理由：
- 各模块的日志可通过 service 标签区分来源
- 符合"各模块有自己的 logger"的设计目标
- 便于未来扩展（如模块级日志开关）

代价：
- 需要在每个模块调用 Log.create()
- Logger 实例数量较多（影响微乎其微）

### 4.3 扁平化文件结构 vs 子目录分组

当前方案：所有文件平铺在 src/utils/ 下

未采用方案：按功能分子目录（如 core/、fs/、text/）

理由：
- utils 模块文件数量有限（约 12 个）
- 扁平化结构导入路径更短
- 避免过度组织

代价：
- 如果未来文件数量增加，可能需要重构

### 4.4 重试机制不放在 utils

当前方案：重试机制由 llm-client 模块实现

未采用方案：在 utils 提供通用重试函数

理由：
- 重试与 LLM 调用场景紧密相关
- 避免 utils 职责膨胀
- llm-client 可根据具体场景定制重试策略

代价：
- 如果其他模块需要重试，需要自行实现或从 llm-client 复用

---

## 五、日志系统详细设计

### 5.1 日志输出格式

```
级别  时间戳              耗时    标签         消息
INFO  2024-01-15T10:30:00 +125ms service=bash Command executed
ERROR 2024-01-15T10:30:01 +50ms  service=mcp  Connection failed
```

### 5.2 日志文件管理

```typescript
// 初始化时设置日志文件
await Log.init({
  print: false,           // 写入文件
  level: 'INFO',          // 日志级别
  maxFiles: 10            // 保留最近 10 个日志文件
})

// 日志文件路径
// ~/.ohbaby/logs/2024-01-15T103000.log
```

### 5.3 日志清理策略

```typescript
// 自动清理旧日志
async function cleanup(logDir: string, maxFiles: number) {
  const files = await glob('*.log', { cwd: logDir })
  if (files.length > maxFiles) {
    const filesToDelete = files.slice(0, -maxFiles)
    await Promise.all(filesToDelete.map(f => fs.unlink(f)))
  }
}
```

### 5.4 时间追踪

```typescript
const log = Log.create({ service: 'tools' })

// 使用 using 语法自动记录耗时
using timer = log.time('Processing file')
await processFile()
// 自动输出: INFO ... +500ms service=tools Processing file status=completed duration=500
```

---

## 六、错误处理详细设计

### 6.1 错误类层次结构

```
Error (JavaScript 内置)
  └── IrisError (utils/error.ts)
        ├── PermissionDeniedError (permissions/errors.ts)
        ├── ToolExecutionError (tools/errors.ts)
        ├── ConfigError (config/errors.ts)
        └── LLMError (llm/errors.ts)
```

### 6.2 错误格式化

```typescript
function formatError(error: unknown): string {
  if (error instanceof IrisError) {
    return `[${error.code}] ${error.message}`
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
```

### 6.3 错误序列化

```typescript
const error = new IrisError('TOOL_FAILED', 'Tool execution failed', {
  toolName: 'bash',
  exitCode: 1
})

console.log(error.toObject())
// {
//   code: 'TOOL_FAILED',
//   message: 'Tool execution failed',
//   data: { toolName: 'bash', exitCode: 1 }
// }
```

---

## 七、清理系统详细设计

### 7.1 清理函数执行顺序

```
程序退出信号
    │
    ▼
runExitCleanup()
    │
    ├─ runSyncCleanup()     # 先执行同步清理
    │    ├─ syncFn1()
    │    ├─ syncFn2()
    │    └─ ...
    │
    └─ 异步清理               # 再执行异步清理
         ├─ await asyncFn1()
         ├─ await asyncFn2()
         └─ ...
    │
    ▼
process.exit()
```

### 7.2 错误隔离

```typescript
export async function runExitCleanup(): Promise<void> {
  runSyncCleanup()

  for (const fn of cleanupFunctions) {
    try {
      await fn()
    } catch {
      // 忽略错误，确保所有清理函数都能执行
    }
  }

  cleanupFunctions.length = 0
}
```

---

## 八、文档自检

- 架构服务于 goals-duty.md 中定义的职责
- 组件职责单一、边界清晰
- 设计模式选择有明确理由（命名空间、工厂、继承、注册、懒加载）
- 文件结构反映职责划分
- 与上层模块的集成方式清晰
