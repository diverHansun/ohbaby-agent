# cli 模块 data-model.md

本文档描述 `cli` 模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| CliArgs | argv 解析结果，只影响进程启动方式 |
| RunMode | 交互或非交互运行模式 |
| CliSurface | 当前进程使用的输出 surface：TUI 或 stdout |
| ExitCode | 进程退出码 |
| StdoutEventSink | 非交互模式下消费 SDK events 的文本 renderer |

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| CliArgs | Value Object | 启动时创建，之后不变 |
| RunMode | Value Object | 从 argv/stdin 派生 |
| CliSurface | Value Object | 一次启动只选择一种 |
| ExitCode | Value Object | 静态常量 |
| StdoutEventSink | Service | 订阅事件并输出文本，不持久化状态 |

---

## 三、Key Data Fields（关键数据字段）

### 3.1 CliArgs

| 字段 | 含义 | 来源 |
|------|------|------|
| `help` | 是否显示启动参数帮助 | `-h` / `--help` |
| `version` | 是否显示版本号 | `-v` / `--version` |
| `prompt` | 非交互 prompt | `-p` / `--prompt` |

CliArgs 不包含 slash command，也不包含模型、会话、权限等业务状态。

### 3.2 RunMode

| 模式 | 条件 | Surface |
|------|------|---------|
| Interactive | stdin 是 TTY 且无 `prompt` | TUI |
| NonInteractive | 有 `prompt` 或 stdin 管道输入 | stdout event sink |

### 3.3 ExitCode

| 值 | 名称 | 语义 |
|----|------|------|
| 0 | SUCCESS | 正常完成 |
| 1 | GENERAL_ERROR | 未分类错误 |
| 2 | ARGUMENT_ERROR | argv 参数错误 |
| 3 | CONFIG_ERROR | 配置错误 |
| 4 | AUTH_ERROR | 认证错误 |
| 5 | NETWORK_ERROR | 网络错误 |
| 130 | USER_INTERRUPT | Ctrl+C |

### 3.4 StdoutEventSink

StdoutEventSink 消费 SDK events：

| 事件 | 行为 |
|------|------|
| `message.part.delta` | 输出文本增量 |
| `command.result.delivered` | 输出简洁结果 |
| `command.failed` | 输出 stderr 并设置失败状态 |
| `run.updated` | 识别完成/失败状态 |
| `interaction.requested` | 非交互模式无法处理时输出错误 |

---

## 四、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建者 | 生命周期 |
|------|--------|----------|
| CliArgs | CLI args parser | 进程生命周期 |
| UiBackendClient | `bin.ts` | 进程生命周期 |
| TUI instance | `ohbaby-cli` | 交互模式生命周期 |
| StdoutEventSink | CLI | 非交互模式生命周期 |
| ExitCode | CLI | 进程退出时使用 |

---

## 五、与其他模块的概念边界

| 概念 | CLI 视角 | SDK/backend 视角 |
|------|----------|------------------|
| prompt | 启动输入文本 | `submitPrompt()` payload |
| command | 不解析 | SDK parser + backend execution |
| runtime state | 不持有 | SDK event/snapshot |
| interaction | stdout 模式通常不可处理 | backend 请求 UI round-trip |

---

## 六、文档自检

- [x] CLI 数据模型只包含进程入口概念。
- [x] 不再包含 sessionId 或 lifecycle 内部请求。
- [x] 非交互 surface 通过 SDK events 表达。
