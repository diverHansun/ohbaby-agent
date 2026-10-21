# ohbaby-sdk 与 ohbaby-server 结构整理

2026-10-21 开启第一轮。代码基线为 `codex/workspaceless-settings` 分支 `7bc75168`，尚未实施。

本议题整理 `ohbaby-sdk` 和 `ohbaby-server` 两个包的文件组织，不改变任何对外行为。起因是用户审视包职责时提出三点：sdk 和 server 各有一个 rpc 目录，容易混淆；sdk 文件大多平铺，看不出分层；server 的可维护性需要改善。

实施时间：等 `codex/workspaceless-settings` 合入 `main` 之后再开工。开工前按当时代码重新核对 02 里的行号快照。

## 轮次与边界

| 轮次 | 开启日期 | 触发 | 内容 |
|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-10-21 | 首轮 | sdk 按职责分目录、`rpc/` 改名、`DaemonStartupIntent` 去重、`create-app.ts` 按结构拆分 |

本轮包括：

- `ohbaby-sdk/src` 按职责分成几个子目录，`rpc/` 改名为 `in-process-rpc/`。公开入口仍然只有 `index.ts`，导出名不变。
- `DaemonStartupIntent` 目前在 server、CLI、Web 各有一份相同的定义，收进 sdk，删除另外两份。
- `ohbaby-server/src/app/create-app.ts`（3409 行）拆成 OpenAPI 文档、请求解析 helper、SSE 广播、按业务分组的路由模块。`createDaemonServerApp` 仍是唯一组装点，行为不变。

JSON-RPC 的协议和远程客户端继续留在 server，理由见 [00 §2](improve-1/00-discussion.md)。其余不在本轮的内容见 [02 §2.8](improve-1/02-optimization-plan-and-change-scope.md)。

LLM 客户端抽包是另一个议题，见 [ohbaby-llm 抽包](../2026-10-21-llm-package-extraction/README.md)，在本议题之后实施。

## 文档地图

| 文件 | 内容 |
|---|---|
| [00-discussion.md](improve-1/00-discussion.md) | 已确认的决策与边界 |
| [01-problem-analysis-and-current-state.md](improve-1/01-problem-analysis-and-current-state.md) | 两个包的现状与问题，带代码锚点 |
| [02-optimization-plan-and-change-scope.md](improve-1/02-optimization-plan-and-change-scope.md) | 方案、三个实施阶段、关键改动清单 |
| [03-reference-projects.md](improve-1/03-reference-projects.md) | 参考项目的包划分与协议放置方式 |
| [04-test-and-acceptance.md](improve-1/04-test-and-acceptance.md) | 测试与验收标准 |
| 05-implementation-acceptance.md | 预留：实施完成后由验收模式写入，规划期不存在 |

02 是后续实施的依据，04 是验收依据。本次只写文档，不改代码。

## 相关文档

- [ohbaby-sdk 架构](../../ohbaby-sdk/architecture.md)：§3 文件布局在实施后同步。
- [ohbaby-server 架构](../../ohbaby-server/architecture.md)：§3 文件树在实施后同步。
- [Hono app 组装与传输](../../ohbaby-server/hono-app/01-app-assembly-and-transport.md)：本轮按其“唯一组装点”约束拆分。
- [远程 TUI daemon RPC](../2026-08-28-remote-tui-daemon-rpc/README.md)：`createRPC`、`CoreAPI`、`SDKAPI` 的签名约束在本轮保持。
- [route-a 新包方案](../server/04-route-a-new-package.md)：§5 关于 SDK 不收 wire 格式的决定在本轮保持。
