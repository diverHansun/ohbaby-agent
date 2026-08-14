# CLI 数据模型

## 进程级模型

| 概念 | 当前语义 |
|---|---|
| yargs command args | terminal、run 或 serve 的一次性启动参数 |
| `CliCoreHost` | `CoreAPI`、`SDKAPI` callbacks 与 `dispose` 的生命周期集合 |
| stdout renderer | 观察 `UiEvent` 并写 stdout/stderr，不拥有领域状态 |
| daemon state | serve status/stop/ps 使用的进程观测数据 |

## Exit code

权威定义在 `packages/ohbaby-cli/src/cli/exit-codes.ts`：

| 值 | 名称 | 语义 |
|---|---|---|
| 0 | `ok` | succeeded 或正常命令完成 |
| 1 | `failure` | failed、cancelled 或一般运行失败 |
| 2 | `usage` | yargs/输入用法错误 |
| 130 | `interrupted` | Prompt interrupted 或用户中止 |

## Prompt completion

`run` 接收 `UiPromptCompletion`：

- `succeeded`：exit 0；
- `failed`：输出结构化错误 code/message，exit 1；
- `cancelled`：输出取消提示，exit 1；
- `interrupted`：输出结构化错误，exit 130。

这四种都是领域终态并正常 resolve。查询、权限、传输、存储和 wait abort 等技术失败才 reject。Completion 不承载完整回答；回答过程来自 `UiEvent`，最终内容可由 snapshot 查询。
