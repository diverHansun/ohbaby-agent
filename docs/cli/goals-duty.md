# CLI 模块目标与职责

当前代码位于 `packages/ohbaby-cli/src/`。CLI 是进程组合根：解析命令、创建 `CoreApiHost`、选择 TUI/非交互/daemon surface，并负责退出码和清理。

## 设计目标

1. `ohbaby` 默认启动交互 TUI；`ohbaby run [prompt..]` 运行一次非交互 Prompt；`ohbaby serve [start|status|stop|ps]` 管理 Web/remote daemon。
2. 所有 surface 都经 SDK 派生的 `CoreAPI`/`SDKAPI` seam 使用同一 `UiBackendClient` 合同，不直接调用 backend 内部 service。
3. 非交互 `run` 使用 `submitPromptAndWait`；该方法仅组合 durable accepted 与 wait 两个 primitive。
4. CLI 只负责 argv、stdin/stdout/stderr、退出码、signal 和 host 生命周期。Prompt、session、permission、command 等领域规则属于 SDK/backend。
5. 命令 handler、stdout renderer 和组合根均可用 fake host 独立测试。

## 当前命令

| 入口 | 语义 |
|---|---|
| `ohbaby` | 启动本地 TUI；可用 `--continue`、`--resume` 或显式 remote 参数 |
| `ohbaby run [prompt..]` | 非交互执行；无位置参数时读取管道 stdin |
| `ohbaby serve [action]` | 启动或管理 daemon/Web surface |
| `--mode plan\|auto` | 初始 permission mode |
| `--permission default\|full-access` | 初始 permission level |

旧 `-p/--prompt` 已删除并由 strict yargs 拒绝。

## 非职责

- 不维护 slash-command grammar；解析/解析结果合同来自 SDK，执行属于 backend。
- 不实现 Ink 组件；TUI 在 `packages/ohbaby-cli/src/tui/`。
- 不在 CLI 复制 `UiBackendClient` 方法清单或领域 DTO。
- 不把 `run`、TUI 与 Server 做成三套 Prompt 执行逻辑。

## 依赖规则

- `packages/ohbaby-cli/src/bin.ts` 装配 Agent/Server 动态依赖与 CLI surface。
- TUI 和命令 handler 面向 SDK 派生 seam，不 import Agent 内部模块。
- Agent core/service 不依赖 CLI。
