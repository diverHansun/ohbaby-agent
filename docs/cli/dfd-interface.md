# CLI 数据流与接口

## 默认 TUI

1. `runOhbabyCli()` 解析全局选项与默认 command。
2. `terminal.ts` 创建本地 in-process host，或按 `--remote-port` 创建 remote host。
3. TUI 通过 `CoreAPI` 查询/写入，通过 `SDKAPI.subscribeEvents` 接收唯一事件流。
4. UI 退出后 host dispose。

## 非交互 Prompt

1. 用户执行 `ohbaby run hello`，或 `echo hello | ohbaby run`。
2. `run.ts` 校验非空 Prompt，创建 in-process host 和 stdout renderer。
3. 订阅 `UiEvent` 后调用 `core.submitPromptAndWait(prompt)`。
4. 该组合先 durable accepted，随后按 receipt 的 `promptId` wait。
5. stdout renderer 输出消息/命令过程；completion 只决定终态和 exit code。
6. finally 中 unsubscribe 并 dispose。

## Daemon

`ohbaby serve start` 启动 Server；浏览器/remote CLI 通过 Server 的 REST 或 JSON-RPC 写入，并通过 SSE 收同一 `UiEvent` 数据流。`serve status/stop/ps` 只管理和观测 daemon。

## 稳定接口

| 接口 | 位置 |
|---|---|
| `runOhbabyCli()` | `packages/ohbaby-cli/src/bin.ts` |
| `createRunCommand()` | `cli/commands/run.ts` |
| `createTerminalCommand()` | `cli/commands/terminal.ts` |
| `createServeCommand()` | `cli/commands/serve.ts` |
| `EXIT_CODES` | `cli/exit-codes.ts` |

旧 `ohbaby -p`、`parseArgs()`、`runCli()` 和独立 `CliArgs.prompt` 不是当前接口。
