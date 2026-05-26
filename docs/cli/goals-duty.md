# cli 模块 goals-duty.md

本文档定义 `cli` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`packages/ohbaby-agent/src/bin.ts` 及 CLI 入口相关文件
- 文档：`docs/cli/`

---

## 一、模块定位

**一句话说明**：cli 模块是 `ohbaby` 进程的组合根，负责解析 argv、创建 `UiBackendClient`、选择交互或非交互 surface，并统一退出码与进程清理。

**如果没有这个模块**：
- `ohbaby-agent` 和 `ohbaby-cli` 缺少唯一合法的组合入口。
- 交互 TUI 与非交互 stdout 输出会各自绕过 SDK 协议。
- 进程级错误处理、stdin、退出码和清理流程会分散在多个模块中。

---

## 二、Design Goals（设计目标）

### G1: Composition Root 清晰

CLI 是唯一允许同时依赖 `ohbaby-agent` backend adapter 和 `ohbaby-cli` frontend package 的位置。除入口文件外，任何 backend core/service/adapter 不得 import TUI。

### G2: 统一 SDK 通道

交互模式和非交互模式都通过 `UiBackendClient` 与 backend 通信。CLI 不绕过 SDK 直接调用 lifecycle、message、session 或 commands。

### G3: 进程职责克制

CLI 只处理进程入口相关职责：argv、stdin、stdout/stderr、信号、退出码、清理。业务执行交给 backend，界面渲染交给对应 surface。

### G4: Surface 分离

交互模式启动 Ink TUI；非交互模式使用最小 stdout renderer 订阅 SDK events 并输出文本。两种 surface 共享 backend client。

### G5: 可测试

argv 解析、run mode 判断、exit code 映射和 stdout event sink 都可独立测试，不需要启动完整 TUI。

---

## 三、Duties（职责）

### D1: Bin 入口

提供 `ohbaby` 可执行入口，接收 Node 进程传入的 argv/stdin/signal。

### D2: 命令行参数解析

MVP 参数：

| 参数 | 短选项 | 类型 | 说明 |
|------|--------|------|------|
| `--help` | `-h` | boolean | 显示 CLI 启动参数帮助 |
| `--version` | `-v` | boolean | 显示版本号 |
| `--prompt <text>` | `-p` | string | 非交互模式，提交一次 prompt |

Slash command 不属于 argv 参数，由 TUI 或 stdout surface 通过 SDK command grammar 处理。

### D3: Backend client 创建

创建 in-process backend adapter，获得 `UiBackendClient`。

### D4: 运行模式分流

| 条件 | 模式 | 行为 |
|------|------|------|
| 有 `-p` 参数 | 非交互 | 创建 stdout renderer，订阅 events，调用 `submitPrompt()` |
| stdin 有管道输入 | 非交互 | 读取 stdin 后同上 |
| stdin 是 TTY 且无参数 | 交互 | 调用 `renderTerminalUi({ client })` |

### D5: 非交互 stdout renderer

非交互模式下，CLI 提供最小 event sink：
- 输出 assistant text delta。
- 输出 command/result/error 的简洁文本。
- 将 fatal error 映射为 stderr 和退出码。

该 renderer 不依赖 Ink，不实现 TUI 组件。

### D6: 进程级错误与退出码

统一处理：
- argv 参数错误。
- 配置/认证/网络等启动错误。
- backend event 中的 fatal error。
- SIGINT / SIGTERM。

### D7: 清理流程

进程退出前调用 backend adapter 的清理能力，并执行本进程注册的同步/异步 cleanup。

---

## 四、Non-Duties（非职责）

### N1: 不负责业务逻辑

CLI 不执行 lifecycle、commands、session、message、MCP、permission 等业务逻辑。

### N2: 不负责 slash command parser/resolver

Slash command 的纯解析和 resolver 属于 `ohbaby-sdk`。CLI 不维护 `parser.ts`、`renderer.ts` 或 command formatter。

### N3: 不负责 TUI 渲染

Ink 组件树、DialogManager、补全 UI 和 prompt 交互属于 `ohbaby-cli`。

### N4: 不负责 command catalog

Command catalog 的创建、分类、可见性和执行属于 backend `commands` 模块。

### N5: 不作为常规依赖层

CLI 是进程组合根，不应被 backend service 或 TUI component import。

---

## 五、硬性依赖规则

1. `ohbaby-cli` 不得 import `ohbaby-agent` 的任何模块。
2. `ohbaby-agent` core/services/adapters 不得 import `ohbaby-cli`。
3. `packages/ohbaby-agent/src/bin.ts` 是 V1 唯一允许同时 import `ohbaby-agent` backend adapter 与 `ohbaby-cli` 的文件。
4. 若未来引入顶层 orchestrator 包，该例外从 `bin.ts` 迁移到 orchestrator，其他规则不变。

---

## 六、文档自检

- [x] CLI 的存在意义限定为进程组合根。
- [x] 明确排除了 slash command 和业务执行。
- [x] 交互与非交互都通过 SDK 通道。
