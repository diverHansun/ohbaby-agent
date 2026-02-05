# cli 模块 data-model.md

本文档描述 `cli` 模块的核心概念与数据模型。

**模块位置**：
- 代码：`src/cli/`
- 文档：`docs/cli/`

---

## 一、Core Concepts（核心概念）

cli 模块作为程序入口层，核心概念较少但重要：

| 概念 | 一句话说明 |
|------|-----------|
| **CliArgs** | 解析后的命令行参数，决定程序运行行为 |
| **RunMode** | 程序运行模式，交互或非交互 |
| **ExitCode** | 程序退出码，表示执行结果的语义化状态 |
| **CliError** | CLI 层错误类型，区分参数错误和配置错误 |

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| CliArgs | Value Object | 解析后不可变，无身份概念 |
| RunMode | Value Object | 布尔判断结果，无状态 |
| ExitCode | Value Object | 静态常量，不可变 |
| CliError | Value Object | 创建后不可变，用于抛出 |

**说明**：cli 模块不持有任何 Entity（有身份、有生命周期的对象），所有概念都是 Value Object。

---

## 三、Key Data Fields（关键数据字段）

### 3.1 CliArgs

用户通过命令行传入的参数，解析后的结构化表示。

| 字段 | 含义 | 来源 |
|------|------|------|
| `help` | 是否请求帮助信息 | `-h` / `--help` |
| `version` | 是否请求版本号 | `-v` / `--version` |
| `prompt` | 非交互模式的用户输入 | `-p` / `--prompt` |

**边界说明**：
- CliArgs 仅包含启动时的参数，不包含运行时状态
- stdin 输入不是 CliArgs 的一部分，由 bootstrap.ts 单独处理

### 3.2 RunMode

程序的运行模式，由 `isInteractive()` 函数判断。

| 模式 | 条件 | 行为 |
|------|------|------|
| Interactive | `stdin.isTTY && !args.prompt` | 启动 UI，用户交互 |
| Non-Interactive | `args.prompt` 或 `!stdin.isTTY` | 执行一次后退出 |

**判断优先级**：
1. 有 `prompt` 参数 → Non-Interactive
2. stdin 不是 TTY → Non-Interactive
3. 默认 → Interactive

### 3.3 ExitCode

程序退出时返回的状态码，供脚本或父进程判断执行结果。

| 值 | 名称 | 语义 |
|----|------|------|
| 0 | SUCCESS | 正常完成 |
| 1 | GENERAL_ERROR | 未分类错误 |
| 2 | ARGUMENT_ERROR | 命令行参数错误 |
| 3 | CONFIG_ERROR | 配置文件错误 |
| 4 | AUTH_ERROR | 认证失败（API Key） |
| 5 | NETWORK_ERROR | 网络请求失败 |
| 130 | USER_INTERRUPT | 用户中断（Ctrl+C） |

**设计约定**：
- 退出码遵循 Unix 惯例（0 成功，非 0 失败）
- 130 = 128 + SIGINT(2)，表示信号中断

### 3.4 CliError

CLI 层的错误类型，继承自 `IrisError` 基类。

| 类型 | 使用场景 | 对应退出码 |
|------|----------|-----------|
| `CliArgumentError` | 参数解析失败、未知参数 | 2 |
| `CliConfigError` | 配置加载失败（CLI 层发现） | 3 |

**与其他错误的关系**：
- `AuthError`、`NetworkError` 等由其他模块定义
- cli 模块通过 `getExitCodeForError()` 统一映射

---

## 四、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建时机 | 归属 | 生命周期 |
|------|----------|------|----------|
| CliArgs | 程序启动时 | args.ts | 解析后不变，直到程序退出 |
| RunMode | bootstrap 判断时 | bootstrap.ts | 判断后不变 |
| ExitCode | 编译时 | exit-codes.ts | 静态常量 |
| CliError | 错误发生时 | error.ts | 抛出后由处理器消费 |

**说明**：
- cli 模块不持有长期状态
- 所有数据都是"一次性"的：创建 → 使用 → 程序退出

---

## 五、概念关系图

```
┌─────────────────────────────────────────────────────────────┐
│                      程序启动                                │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                       CliArgs                                 │
│  { help: boolean, version: boolean, prompt?: string }        │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      RunMode 判断                             │
│              isInteractive(args) → boolean                   │
└──────────────┬───────────────────────────────┬───────────────┘
               │                               │
               ▼                               ▼
       ┌───────────────┐               ┌───────────────┐
       │  Interactive  │               │Non-Interactive│
       │   UI.render() │               │Lifecycle.run()│
       └───────────────┘               └───────┬───────┘
                                               │
                                               ▼
                                       ┌───────────────┐
                                       │   ExitCode    │
                                       │  (0 / 1-5 /   │
                                       │    130)       │
                                       └───────────────┘
```

---

## 六、与其他模块的概念边界

| 概念 | cli 模块的理解 | 其他模块的理解 |
|------|---------------|---------------|
| prompt | 命令行传入的用户输入文本 | lifecycle: 用户消息的 content |
| sessionId | 由 cli 创建，传递给 UI/lifecycle | session: 会话的唯一标识 |
| config | cli 只调用加载，不关心内部结构 | config: 完整的配置对象 |

**边界说明**：
- cli 模块使用最小化的概念视图
- 详细的 prompt 结构、session 管理由下层模块负责

---

## 七、文档自检

- [x] 所有概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在架构或数据流中都被使用
- [x] 概念数量克制（4 个核心概念）
- [x] 与 dfd-interface.md 中的数据定义一致
