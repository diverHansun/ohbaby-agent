# 讨论记录与已确认要点

> 2026-10-21 与用户讨论定稿。方案见 [02](02-optimization-plan-and-change-scope.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)。

## 1. 背景与动机

用户审视 `ohbaby-sdk` 和 `ohbaby-server` 的职责划分后提出三个问题：

1. sdk 有 `src/rpc`，server 有 `src/protocols/jsonrpc`，两者是否冲突？
2. sdk 的文件大多平铺，分层看不清，要不要分目录？
3. 参考 code-cli 下的 TS 项目，看本项目要不要迁移文件、新建包。

讨论后，用户把整理工作分成两个议题、两次实施：本议题负责 sdk 与 server 的结构整理；LLM 客户端抽包另立议题（[ohbaby-llm 抽包](../../2026-10-21-llm-package-extraction/README.md)），在本议题之后实施。两个议题都等 `codex/workspaceless-settings` 合入 `main` 后再动代码。Web 端针对 workspaceless 的前端规划放在本议题之后，不等 LLM 抽包。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 两个 rpc 目录 | 职责不同，不合并。sdk 的 `rpc/` 是进程内的“假 RPC”（JSON 克隆模拟进程边界），server 的 `protocols/jsonrpc/` 是真正走 HTTP 的协议 |
| sdk `rpc/` 改名 | 改为 `in-process-rpc/`。`createRPC`、`CoreAPI`、`SDKAPI` 的名字和签名不变 |
| JSON-RPC 协议与客户端放哪 | 继续留在 `ohbaby-server`。理由：Web 端不用 JSON-RPC，走自己的 REST `/v1/*`；客户端唯一的使用者是 CLI 的远程 TUI，而 CLI 本来就要加载 server；现有文档 server D5、N5 和 route-a §5 都把远程客户端和 wire 格式划给 server |
| `DaemonStartupIntent` | 收进 sdk 作为共享契约，删除 CLI（`bin.ts`）和 Web（`wire.ts` 的 `WebStartupIntent`）里的两份副本。route-a §5 已把这一项列为可选的 SDK 增量 |
| sdk 分目录 | 按职责分成 `contract/`、`sync/`、`in-process-rpc/`、`slash-command/` 等几个子目录（具体见 02）。`index.ts` 仍是唯一公开入口，导出名不变（`command-record` 一项除外，见下一行），不新增子路径导出 |
| `command-record.ts` | 2026-10-21 实施中补充确认：移出 sdk，放进 agent 的 `host/`。它是执行命令并记录结果的逻辑，函数只有 agent 的 `ui-command-gateway.ts` 使用，类型只有 agent 和 server 使用，CLI 和 Web 都不用，不属于前后端契约。sdk 因此少导出这一组名字 |
| `create-app.ts` 拆分程度 | 纯结构拆分：OpenAPI 文档、请求解析 helper、SSE 广播、按业务分组的路由模块各自成文件。`createDaemonServerApp` 仍是唯一组装点，行为零变化 |
| 路由模块放哪 | `protocols/web/routes/<领域>.ts`，与 `docs/ohbaby-server/hono-app/01` 的目标布局一致 |
| 现有测试 | `create-app` 的 4 个测试文件只通过 `createDaemonServerApp` 测试，Stage 1b 只改命令记录类型 import，随后拆分时不改，作为行为不变的安全网 |
| 关键改动清单 | 用户要求在 02 中列出，承重项带符号和行号快照 |
| 实施时间 | `codex/workspaceless-settings` 合入 `main` 之后。开工前按当时代码核对行号 |

## 3. 已确认：边界（不做的事）

| 项 | 处理 |
|---|---|
| 把 `protocol.ts` 或远程客户端 `client.ts` 挪进 sdk | 不做。与现有文档决策冲突，且没有实际使用者受益 |
| 鉴权从各路由内联调用改成 Hono 中间件 | 本轮不做，会改变行为；登记为后续候选 |
| CORS | 不做，当前没有需求 |
| 拆分 `coordination/client-view.ts`（1177 行） | 本轮不做；它是一个职责相对集中的类，登记为后续候选 |
| Web 端改用 sdk 的 REST 客户端 | 不做。Web 保留自己的 wire 层（`docs/ohbaby-web/goals-duty.md` ND4），本轮只让它改用 sdk 的 `DaemonStartupIntent` |
| sdk 增加子路径导出（如 `ohbaby-sdk/contract`） | 不做，目前没有按需加载的需求 |
| LLM 客户端抽包 | 另一个议题 |

## 4. 已确认：与关联议题的关系

- [远程 TUI daemon RPC](../../2026-08-28-remote-tui-daemon-rpc/README.md)：该议题要求 `createRPC`、`CoreAPI`、`SDKAPI` 签名不变，本轮遵守。
- [route-a 新包方案](../../server/04-route-a-new-package.md) §5：SDK 不收 seqNum 信封、wire 格式和 CORS，本轮遵守；只采纳其中“`DaemonStartupIntent` 可以进 SDK”这一项。
- [Hono app 组装与传输](../../../ohbaby-server/hono-app/01-app-assembly-and-transport.md)：`createDaemonServerApp` 是唯一组装点，不为目录形状而拆。本轮拆分的理由是单文件 3409 行，审阅和定位困难，属于实际的可维护性问题。
- [全局单 Daemon](../../2026-07-11-global-single-daemon/README.md)：`create-app` 只处理单个工作区，不注入 `InstanceStore`。拆出的路由模块同样只拿单工作区依赖。

## 5. 参考项目

调研了 dsh（deepseek-harness）、kimi-code、claude-code、ZCode，并简要看了 opencode 和 pi。结论：协议放在独立包还是 server 内部，各项目做法不一；小包内部平铺、大包按职责分子目录是共同做法。详见 [03](03-reference-projects.md)。
