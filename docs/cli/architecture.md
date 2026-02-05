# cli 模块 architecture.md

本文档描述 `cli` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

cli 模块采用**扁平化结构 + 中间件模式**，代码简洁直观：

```
命令行输入: iris-code -p "帮我写一个函数"
                │
                ▼
        ┌───────────────────────────────────────────┐
        │              args.ts                       │
        │         解析命令行参数                      │
        │    { prompt: "帮我写一个函数" }             │
        └───────────────────┬───────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────────────┐
        │            bootstrap.ts                    │
        │         按顺序初始化各模块                   │
        │    Log → Handlers → Config → Core         │
        └───────────────────┬───────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
    ┌───────────────┐               ┌───────────────┐
    │  交互模式      │               │  非交互模式    │
    │startInteractive│              │ executePrompt │
    │    ↓          │               │      ↓        │
    │  UI.render()  │               │Lifecycle.run()│
    └───────────────┘               └───────────────┘
```

### 文件结构

```
src/cli/
├── index.ts          # 模块入口，导出 main()
├── bootstrap.ts      # 初始化流程编排、stdin 读取
├── handlers.ts       # 全局异常/信号处理
├── args.ts           # 参数解析 + isInteractive()
├── error.ts          # CliArgumentError, CliConfigError
├── exit-codes.ts     # EXIT_CODES + getExitCodeForError()
└── commands/         # Slash 命令（复杂度高，保留子目录）
    ├── index.ts
    ├── parser.ts
    ├── renderer.ts
    └── formatters/
```

### 主要文件及职责

| 文件 | 职责 |
|------|------|
| **index.ts** | 模块入口，导出 main() 函数 |
| **bootstrap.ts** | 初始化流程编排、模式分流、stdin 读取 |
| **handlers.ts** | 全局异常处理、信号处理、退出清理 |
| **args.ts** | 命令行参数解析、模式判断 |
| **error.ts** | CLI 错误类型定义（继承 IrisError） |
| **exit-codes.ts** | 退出码常量和 getExitCodeForError() 映射 |
| **commands/** | Slash 命令解析与渲染（见独立文档） |

---

## 二、Design Pattern and Rationale（设计模式与理由）

### 1. 中间件模式（Middleware Pattern）

**使用理由**：
- 初始化步骤有明确的顺序依赖
- 便于在步骤间插入日志或调试信息
- 单个步骤失败时可清晰定位

**实现方式**：
```typescript
// bootstrap.ts
export async function bootstrap(argv: string[]): Promise<void> {
  // 1. 解析参数
  const args = parseArgs(argv)

  // 2. 初始化日志
  await Log.init({ level: 'INFO' })

  // 3. 注册异常处理
  setupExceptionHandlers()

  // 4. 加载配置
  const config = await loadConfig()

  // 5. 初始化核心模块
  await initializeCore(config)

  // 6. 启动模式分流
  if (isInteractive(args)) {
    await startInteractive()
  } else {
    const prompt = args.prompt ?? await readStdin()
    await executePrompt(prompt)
    await runExitCleanup()
    process.exit(0)
  }
}
```

### 2. 继承模式（Inheritance Pattern）- 错误类

**使用理由**：
- 复用 `utils/error.ts` 中的 `IrisError` 基类
- CLI 模块定义自己的错误类型
- 支持 instanceof 类型检查

**实现方式**：
```typescript
// error.ts
import { IrisError } from '@/utils'

export class CliArgumentError extends IrisError {
  constructor(message: string, data?: Record<string, unknown>) {
    super('CLI_ARGUMENT_ERROR', message, data)
  }
}

export class CliConfigError extends IrisError {
  constructor(message: string, data?: Record<string, unknown>) {
    super('CLI_CONFIG_ERROR', message, data)
  }
}
```

### 3. 未使用的模式

**未使用依赖注入容器**：
- 依赖关系简单，通过参数传递即可
- 避免引入额外复杂度
- KISS 原则

**未使用单例模式**：
- 各模块通过参数接收依赖
- 便于测试时 mock

---

## 三、各文件详细设计

### bootstrap.ts

职责：初始化流程编排、模式分流、stdin 读取

```typescript
// bootstrap.ts (< 100 行)
export async function bootstrap(argv: string[]): Promise<void>
async function startInteractive(): Promise<void>
async function executePrompt(prompt: string): Promise<void>
async function readStdin(): Promise<string>
```

### handlers.ts

职责：全局异常处理、信号处理

```typescript
// handlers.ts (< 80 行)
export function setupExceptionHandlers(): void
export function handleFatalError(error: Error): never
```

### args.ts

职责：命令行参数解析、模式判断

```typescript
// args.ts (< 60 行)
export function parseArgs(argv: string[]): CliArgs
export function isInteractive(args: CliArgs): boolean

const CLI_OPTIONS = {
  help: { alias: 'h', type: 'boolean', description: '显示帮助信息' },
  version: { alias: 'v', type: 'boolean', description: '显示版本号' },
  prompt: { alias: 'p', type: 'string', description: '非交互模式执行 prompt' },
}
```

### error.ts 和 exit-codes.ts

职责：错误类型和退出码管理

```typescript
// error.ts (< 30 行)
export class CliArgumentError extends IrisError { ... }
export class CliConfigError extends IrisError { ... }

// exit-codes.ts (< 40 行)
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  ARGUMENT_ERROR: 2,
  CONFIG_ERROR: 3,
  AUTH_ERROR: 4,
  NETWORK_ERROR: 5,
  USER_INTERRUPT: 130,
}

export function getExitCodeForError(error: Error): number
```

### 对外稳定接口

以下内容构成模块的公共 API：
- `main()` - 程序主入口
- `parseArgs()` - 参数解析（供测试使用）
- `CliArgumentError`、`CliConfigError` - 错误类型
- `EXIT_CODES` - 退出码常量

### 内部实现

以下内容为内部实现，可自由重构：
- 初始化步骤的具体顺序
- 异常处理器的实现细节
- yargs 配置细节
- stdin 读取的具体方式

---

## 四、Architectural Constraints and Trade-offs（约束与权衡）

### 约束 1: 入口代码行数限制

**当前选择**：每个文件不超过 100 行

**代价**：
- 需要拆分为多个小文件
- 文件数量增加

**理由**：
- 符合 G1 设计目标（简洁入口）
- 便于阅读和维护
- 便于定位问题

### 约束 2: 最小启动参数

**当前选择**：MVP 仅支持 `-h`、`-v`、`-p` 三个参数

**代价**：
- 部分功能需要通过配置文件或 Slash 命令实现

**理由**：
- 避免参数膨胀
- 遵循 YAGNI 原则
- 未来可按需扩展

### 约束 3: 同步异常处理

**当前选择**：全局异常处理器立即执行清理并退出

**代价**：
- 异步清理可能被跳过

**理由**：
- 确保程序能正常退出
- 避免异常后程序挂起

---

## 五、初始化流程详细设计

### 步骤依赖关系

```
parseArgs ──┬── Log.init ──┬── setupHandlers ──┬── loadConfig ──┬── initCore
            │              │                   │                │
            │              │ 需要日志记录      │ 需要日志+异常   │ 需要配置
            │ 最先执行      │ 异常处理         │ 处理才能安全    │
            │              │                   │ 加载配置       │
```

### 异常处理策略

```typescript
// handlers.ts

export function setupExceptionHandlers(): void {
  const log = Log.create({ service: 'cli' })

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason })
    handleFatalError(normalizeError(reason))
  })

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { error })
    handleFatalError(error)
  })

  process.on('SIGINT', () => {
    log.info('Received SIGINT')
    runSyncCleanup()
    process.exit(EXIT_CODES.USER_INTERRUPT)
  })

  process.on('SIGTERM', () => {
    log.info('Received SIGTERM')
    runSyncCleanup()
    process.exit(EXIT_CODES.SUCCESS)
  })
}
```

---

## 六、模式判断逻辑

```typescript
// args.ts

export function isInteractive(args: CliArgs): boolean {
  // 有 prompt 参数 → 非交互
  if (args.prompt) {
    return false
  }

  // stdin 不是 TTY → 非交互（管道输入）
  if (!process.stdin.isTTY) {
    return false
  }

  // 默认交互模式
  return true
}
```

---

## 七、与 cli/commands 的关系

`cli/commands` 是 cli 模块的子模块，负责 Slash 命令的解析和渲染。

**调用关系**：
```
┌─────────────────────────────────────────────────────────┐
│                      ui 模块                            │
│              接收用户输入 "/model list"                  │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                   cli/commands 子模块                    │
│   1. parser 解析: { path: "model list", args: "" }      │
│   2. 调用 CommandService.execute()                       │
│   3. renderer 渲染 CommandResult                         │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                   commands 模块                          │
│              执行业务逻辑，返回结果                       │
└─────────────────────────────────────────────────────────┘
```

**说明**：cli/commands 的详细设计见 `docs/cli/commands/` 目录下的文档。

---

## 八、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构足够简单，各文件职责清晰
- [x] 文件行数限制明确
