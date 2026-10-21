# ohbaby-sdk 与 ohbaby-server 结构整理

2026-10-21 完成首轮代码改造，实施分支为 `codex/sdk-server-boundaries`，基线为 `7bc75168`。已分批提交，尚未合并或推送，等待用户审查。测试结果及一项已在基线复现的 E2E 失败见 [05 验收记录](improve-1/05-implementation-acceptance.md)。

本议题整理 `ohbaby-sdk` 和 `ohbaby-server` 两个包的文件组织，保持运行时行为。公开导出仅按确认的范围调整：SDK 新增 `DaemonStartupIntent`，移除 command-record 的 12 个名字；agent 公开其中 3 个类型。起因是用户审视包职责时提出三点：sdk 和 server 各有一个 rpc 目录，容易混淆；sdk 文件大多平铺，看不出分层；server 的可维护性需要改善。

实施顺序为 Stage 1 → Stage 2 → Stage 1b → Stage 3。00–04 保留规划和验收标准，05 记录实际结果。

## 轮次与边界

| 轮次 | 开启日期 | 触发 | 内容 |
|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-10-21 | 首轮 | sdk 按职责分目录、`rpc/` 改名、`DaemonStartupIntent` 去重、command-record 归回 agent、`create-app.ts` 按结构拆分 |

本轮包括：

- `ohbaby-sdk/src` 按职责分成几个子目录，`rpc/` 改名为 `in-process-rpc/`。公开入口仍然只有 `index.ts`，Stage 1 本身不改导出名。
- `DaemonStartupIntent` 的定义收进 sdk，server、CLI、Web 引用同一份类型。
- command-record 源码及单测移回 agent；SDK 移除其导出，server 从 agent 引入需要的 3 个类型。
- `ohbaby-server/src/app/create-app.ts` 从 3409 行缩减至 396 行，拆出 OpenAPI 文档、请求解析 helper、SSE 广播、按业务分组的路由模块。`createDaemonServerApp` 仍是唯一组装点，行为不变。

JSON-RPC 的协议和远程客户端继续留在 server，理由见 [00 §2](improve-1/00-discussion.md)。其余不在本轮的内容见 [02 §2.8](improve-1/02-optimization-plan-and-change-scope.md)。

LLM 客户端抽包是另一个议题，见 [ohbaby-llm 抽包](../2026-10-21-llm-package-extraction/README.md)，在本议题之后实施。

## 文档地图

| 文件 | 内容 |
|---|---|
| [00-discussion.md](improve-1/00-discussion.md) | 已确认的决策与边界 |
| [01-problem-analysis-and-current-state.md](improve-1/01-problem-analysis-and-current-state.md) | 两个包的现状与问题，带代码锚点 |
| [02-optimization-plan-and-change-scope.md](improve-1/02-optimization-plan-and-change-scope.md) | 方案、四个实施阶段、关键改动清单 |
| [03-reference-projects.md](improve-1/03-reference-projects.md) | 参考项目的包划分与协议放置方式 |
| [04-test-and-acceptance.md](improve-1/04-test-and-acceptance.md) | 测试与验收标准 |
| [05-implementation-acceptance.md](improve-1/05-implementation-acceptance.md) | 实施结果、测试证据、子代理复审及剩余限制 |

02 是本轮实施依据，04 是验收依据。代码和相关架构文档已同步，后续审查以 05 的实际结果为准。

## 相关文档

- [ohbaby-sdk 架构](../../ohbaby-sdk/architecture.md)：文件布局和命令记录归属已同步。
- [ohbaby-server 架构](../../ohbaby-server/architecture.md)：文件树和组装职责已同步。
- [Hono app 组装与传输](../../ohbaby-server/hono-app/01-app-assembly-and-transport.md)：本轮按其“唯一组装点”约束拆分。
- [远程 TUI daemon RPC](../2026-08-28-remote-tui-daemon-rpc/README.md)：`createRPC`、`CoreAPI`、`SDKAPI` 的签名约束在本轮保持。
- [route-a 新包方案](../server/04-route-a-new-package.md)：§5 关于 SDK 不收 wire 格式的决定在本轮保持。
