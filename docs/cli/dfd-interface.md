# cli 模块 dfd-interface.md

本文档描述 `cli` 模块与外部模块的数据流和接口定义。

**模块位置**：
- 代码：`src/cli/`
- 文档：`docs/cli/`

---

## 一、Context and Scope（上下文与范围）

cli 模块是 iris-code 的入口层，处于系统最外层：

```
┌─────────────────────────────────────────────────────────┐
│                     用户终端                             │
│              命令行输入 / stdin 管道                      │
└───────────────────────────┬─────────────────────────────┘
                            │ argv / stdin
                            ▼
┌─────────────────────────────────────────────────────────┐
│                      cli 模块（扁平化结构）               │
│                   （本文档描述范围）                       │
│  ┌────────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐ │
│  │bootstrap.ts│ │args.ts │ │error.ts│ │  commands/   │ │
│  │handlers.ts │ │        │ │exit-   │ │              │ │
│  │            │ │        │ │codes.ts│ │              │ │
│  └─────┬──────┘ └───┬────┘ └───┬────┘ └──────┬───────┘ │
└────────┼────────────┼──────────┼─────────────┼─────────┘
         │            │          │             │
         ▼            ▼          ▼             ▼
┌───────────────────────────────────────────────────────────┐
│                    下层模块                                │
│   utils / config / ui / lifecycle / commands              │
└───────────────────────────────────────────────────────────┘
```

**与本模块交互的外部模块**：

| 模块 | 代码位置 | 关系 |
|------|----------|------|
| utils | `src/utils/` | 依赖（Log、IrisError、cleanup） |
| config | `src/config/` | 依赖（加载配置） |
| ui | `src/ui/` | 依赖（交互模式启动） |
| lifecycle | `src/core/lifecycle/` | 依赖（非交互模式执行） |
| commands | `src/commands/` | 间接依赖（通过 cli/commands） |

---

## 二、Data Flow Description（数据流描述）

### 2.1 典型数据流：交互模式启动

```
1. 用户在终端输入 "iris-code"（无参数）
2. Node.js 调用 main() 入口函数
3. bootstrap 解析 argv:
   - 调用 args.parseArgs(process.argv)
   - 返回 { help: false, version: false, prompt: undefined }
4. bootstrap 初始化日志:
   - 调用 Log.init({ level: 'INFO' })
5. bootstrap 注册异常处理:
   - 调用 setupExceptionHandlers()
6. bootstrap 加载配置:
   - 调用 config.loadConfig()
   - 返回 Config 对象
7. bootstrap 初始化核心模块:
   - 调用 initializeCore(config)
   - 初始化 MCP、Agent 等模块
8. bootstrap 判断模式:
   - isInteractive(args) = true
9. bootstrap 启动 UI:
   - 调用 UI.render({ sessionId })
   - UI 模块接管终端
```

### 2.2 数据流：非交互模式执行

```
1. 用户输入 "iris-code -p '帮我写一个函数'"
2. bootstrap 解析 argv:
   - 返回 { prompt: '帮我写一个函数' }
3. 初始化流程同上（日志、异常处理、配置、核心模块）
4. bootstrap 判断模式:
   - isInteractive(args) = false
5. bootstrap 执行 prompt:
   - 调用 executePrompt(args.prompt)
   - 内部调用 Lifecycle.run(sessionId, { role: 'user', content: prompt })
   - 消费 AsyncGenerator 直到完成
6. 等待执行完成
7. bootstrap 执行清理:
   - 调用 runExitCleanup()
8. 退出程序:
   - process.exit(0)
```

### 2.3 数据流：stdin 管道输入

```
1. 用户输入 "echo '问题' | iris-code"
2. bootstrap.ts 解析 argv:
   - 返回 { prompt: undefined }
3. bootstrap.ts 检测 stdin:
   - process.stdin.isTTY = false
4. bootstrap.ts 读取 stdin:
   - 调用 readStdin() 读取管道输入
5. 执行流程同非交互模式:
   - 调用 Lifecycle.run(sessionId, { role: 'user', content: stdinContent })
```

### 2.4 数据流：参数错误

```
1. 用户输入 "iris-code --invalid-option"
2. args.parseArgs 抛出 CliArgumentError
3. 异常处理器捕获错误:
   - log.error('Argument error', { error })
   - 输出帮助信息到 stderr
   - 调用 process.exit(EXIT_CODES.ARGUMENT_ERROR)
```

### 2.5 数据流：全局异常

```
1. 程序运行中发生未捕获异常
2. process.on('uncaughtException') 捕获
3. handleFatalError(error):
   - 根据错误类型确定退出码
   - log.error('Fatal error', { error })
   - 调用 runSyncCleanup()
   - 调用 process.exit(exitCode)
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### main()

程序主入口函数

```typescript
async function main(): Promise<void>
```

**调用者**：Node.js 入口点（package.json bin）

**行为**：
- 调用 bootstrap(process.argv)
- 交互模式下不返回（UI 控制主循环）
- 非交互模式下执行完成后退出

#### parseArgs()

解析命令行参数（供测试使用）

```typescript
function parseArgs(argv: string[]): CliArgs
```

**参数说明**：
- `argv`：命令行参数数组（process.argv）

**返回值**：
```typescript
interface CliArgs {
  help: boolean
  version: boolean
  prompt?: string
}
```

#### CliArgumentError / CliConfigError

CLI 层错误类型

```typescript
class CliArgumentError extends IrisError {
  constructor(message: string, data?: Record<string, unknown>)
}

class CliConfigError extends IrisError {
  constructor(message: string, data?: Record<string, unknown>)
}
```

#### EXIT_CODES

退出码常量

```typescript
const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  ARGUMENT_ERROR: 2,
  CONFIG_ERROR: 3,
  AUTH_ERROR: 4,
  NETWORK_ERROR: 5,
  USER_INTERRUPT: 130,
}
```

### 3.2 依赖的外部接口

| 模块 | 接口 | 用途 |
|------|------|------|
| utils | `Log.init(options)` | 初始化日志系统 |
| utils | `Log.create(tags)` | 创建 logger 实例 |
| utils | `registerCleanup(fn)` | 注册清理函数 |
| utils | `runSyncCleanup()` | 执行同步清理 |
| utils | `runExitCleanup()` | 执行异步清理 |
| config | `loadConfig()` | 加载配置 |
| ui | `render(options: RenderOptions)` | 启动交互 UI |
| lifecycle | `Lifecycle.run(sessionId, request, options?)` | 执行 prompt（非交互模式） |

### 3.3 cli/commands 子模块接口

cli/commands 子模块的接口定义见 `docs/cli/commands/dfd-interface.md`。

主要接口：
- `executeSlashCommand(input, context, commandService)` - 执行 Slash 命令
- `isSlashCommand(input)` - 判断是否为 Slash 命令

---

## 四、Data Ownership and Responsibility（数据归属与责任）

| 数据 | 创建者 | 更新者 | 说明 |
|------|--------|--------|------|
| argv | Node.js | - | 命令行参数，只读 |
| CliArgs | args.ts | - | 解析后的参数对象，创建后不变 |
| Config | config 模块 | config 模块 | cli 只读取，不修改 |
| Logger 实例 | utils/Log | - | cli 模块创建自己的实例 |
| 退出码 | exit-codes.ts | - | 静态常量 |

**责任边界说明**：
- cli 模块不持有任何持久化状态
- cli 模块不修改其他模块的数据
- cli 模块只负责"启动"和"协调"，不负责"业务逻辑"

---

## 五、信号处理协议

### SIGINT (Ctrl+C)

| 场景 | 处理方式 |
|------|----------|
| 初始化阶段 | 立即退出，退出码 130 |
| 交互模式运行中 | 由 UI 模块处理（双击 Ctrl+C 中断） |
| 非交互模式运行中 | 中断执行，退出码 130 |

### SIGTERM

| 场景 | 处理方式 |
|------|----------|
| 任何阶段 | 执行清理后正常退出，退出码 0 |

---

## 六、错误码到退出码的映射

```typescript
function getExitCodeForError(error: Error): number {
  if (error instanceof CliArgumentError) {
    return EXIT_CODES.ARGUMENT_ERROR
  }
  if (error instanceof CliConfigError) {
    return EXIT_CODES.CONFIG_ERROR
  }
  if (IrisError.isInstance(error)) {
    switch (error.code) {
      case 'AUTH_ERROR':
        return EXIT_CODES.AUTH_ERROR
      case 'NETWORK_ERROR':
        return EXIT_CODES.NETWORK_ERROR
      default:
        return EXIT_CODES.GENERAL_ERROR
    }
  }
  return EXIT_CODES.GENERAL_ERROR
}
```

---

## 七、与 UI 模块的启动协议

cli 模块启动 UI 模块时，传递 `RenderOptions`：

```typescript
// ui 模块定义的选项
interface RenderOptions {
  sessionId?: string   // 会话 ID（可选，UI 可自行创建）
  prompt?: string      // 初始 prompt（可选）
}

// bootstrap.ts
async function startInteractive(): Promise<void> {
  const sessionId = await Session.create()

  // 启动 UI（UI 模块接管控制权）
  await UI.render({ sessionId })
}
```

**说明**：
- UI 模块自行管理配置和工作目录
- cli 只传递必要的 sessionId
- prompt 参数用于非交互模式传递初始输入（可选）

---

## 八、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 接口定义关注语义而非实现细节
- [x] 信号处理协议明确
