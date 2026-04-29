# cli 模块 dfd-interface.md

本文档描述 `cli` 模块与外部模块的数据流和接口定义。

---

## 一、Context & Scope（上下文与范围）

CLI 是进程入口层，位于用户终端和 SDK/backend/TUI 之间：

```
用户终端 argv/stdin/signal
        │
        ▼
cli composition root
        │
        ├─ creates UiBackendClient via backend adapter
        ├─ interactive: renderTerminalUi({ client })
        └─ non-interactive: stdout sink + submitPrompt()
```

本文档只描述进程入口的数据流，不描述 backend 内部执行和 TUI 组件渲染。

---

## 二、Data Flow Description（数据流描述）

### 2.1 交互模式启动

1. 用户执行 `ohbaby`。
2. CLI 解析 argv，得到无 prompt 的 `CliArgs`。
3. CLI 创建 in-process backend adapter，获得 `UiBackendClient`。
4. CLI 调用 `renderTerminalUi({ client })`。
5. TUI 调用 SDK client 获取 snapshot、catalog 并订阅 events。
6. 后续输入、命令、interaction 均由 TUI 通过 SDK client 处理。

### 2.2 非交互 prompt

1. 用户执行 `ohbaby -p "..."`。
2. CLI 解析 `prompt`。
3. CLI 创建 `UiBackendClient`。
4. CLI 创建 stdout event sink，并调用 `subscribeEvents()`。
5. CLI 调用 `submitPrompt(prompt)`。
6. Backend 通过 SDK events 推送 message/run/result。
7. Stdout sink 输出文本并根据最终 run 状态决定退出码。

### 2.3 stdin 管道输入

1. 用户执行 `echo "..." | ohbaby`。
2. CLI 检测 stdin 非 TTY。
3. CLI 读取 stdin 内容作为 prompt。
4. 后续流程同非交互 prompt。

### 2.4 参数错误

1. argv parser 发现未知参数或缺失参数值。
2. CLI 创建 `CliArgumentError`。
3. CLI 输出启动参数帮助到 stderr。
4. CLI 以 `ARGUMENT_ERROR` 退出。

### 2.5 非交互 interaction

1. Backend 发布 `interaction.requested`。
2. Stdout sink 判断当前 surface 不支持交互式选择。
3. Stdout sink 输出错误提示。
4. CLI 请求 abort 或等待 backend command 失败事件，并以非零退出码结束。

---

## 三、Interface Definition（接口定义）

### CLI 对外入口

| 接口 | 语义 |
|------|------|
| `ohbaby` | 启动交互 TUI |
| `ohbaby -p <text>` | 非交互提交 prompt |
| `echo <text> \| ohbaby` | 非交互提交 stdin |

### CLI 内部稳定接口

| 接口 | 语义 |
|------|------|
| `parseArgs(argv)` | 解析进程参数 |
| `readStdin()` | 读取管道输入 |
| `createStdoutEventSink()` | 创建非交互 renderer |
| `getExitCodeForError(error)` | 错误到退出码映射 |

### CLI 依赖的外部接口

| 模块 | 接口 | 用途 |
|------|------|------|
| `ohbaby-agent` adapter | `createInProcessUiBackendClient()` | 创建 SDK client |
| `ohbaby-tui` | `renderTerminalUi({ client })` | 启动交互 UI |
| `ohbaby-sdk` | `UiBackendClient` | 统一通信协议 |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 责任 |
|------|--------|------|
| argv | Node 进程 | CLI 读取，不修改 |
| CliArgs | CLI | 只用于启动分流 |
| UiBackendClient | backend adapter | CLI 持有并注入 surface |
| SDK events | backend adapter | CLI/TUI 订阅消费 |
| stdout output | StdoutEventSink | 非交互渲染 |
| ExitCode | CLI | 进程退出语义 |

---

## 五、信号处理协议

| 场景 | 处理 |
|------|------|
| 初始化阶段 Ctrl+C | 清理后退出 130 |
| TUI 运行中 Ctrl+C | 交给 TUI surface 处理 |
| 非交互运行中 Ctrl+C | 调用 `abortRun()`，退出 130 |
| SIGTERM | 清理后退出 |

---

## 六、文档自检

- [x] 数据流没有绕过 SDK。
- [x] CLI 不直接调用 lifecycle 或 commands。
- [x] 交互与非交互 surface 的数据责任明确。
