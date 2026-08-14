# improve-2：各端采用、Web façade 与旧契约收口

> 前置条件：[`improve-1`](../improve-1/) 已按其验收门通过。
> 本轮性质：在底层合同稳定后迁移 CLI/TUI/Web/Server，并删除旧双轨。
> 状态：已实施并关闭首次审查欠账；自动化、真实服务 E2E 与独立复审证据见 [`05-implementation-acceptance.md`](./05-implementation-acceptance.md)。

## 本轮目标

1. CLI、TUI、Web 与远程 client 根据使用场景选择 `submitPromptAccepted`、`waitForPrompt` 或 `submitPromptAndWait`。
2. 让一个 `BrowserDaemonClient` 实例实现 SDK 的 `UiBackendClient`；不再维护手写的完整 `OhbabyWebClient` 业务合同。
3. 保留 `OhbabyWebRuntime` 作为浏览器应用 façade，集中 workspace、导航、连接生命周期和 store，而不是再造第二个 SDK client。
4. 消除 `getSnapshot` 冲突：SDK client 异步读取 `UiSnapshot`，Web store 同步读取 `StoreSnapshot`。
5. 每个活动 workspace 同时只有一个逻辑 SSE 订阅；每个 `UiEvent` 只解包一次，并从同一个分发点依次更新 store、通知 SDK subscriber。
6. 补齐 Web transport 对 `waitForPrompt`、`respondInteraction` 等权威合同能力的支持。
7. 删除旧 `submitPrompt`、旧 RPC method、`UiPromptQueueClient`、`supportsPromptQueue`、`CoreAPI`/`SDKAPI` 手抄方法列表与无价值逐方法 wrapper、`TuiEvent` 重复联合和 Web 手抄业务合同；若 RPC 正/反向 seam 仍需要名称，则保留从 SDK 权威能力派生的薄 alias。
8. 复验三类外部写入口的命令记录只有一个所有者，前端与 raw backend 不重复记录。

## 本轮不做

- 不把 TUI 改为 HTTP/SSE。
- 不把 workspace、目录选择、导航或浏览器连接状态塞入 SDK。
- 不新增第二套 Web business client、第二条 SSE 或第二个事件联合。
- 不把 `UiCommandRecord` 作为 HTTP/JSON-RPC 请求体。
- 不建设审计数据库、重放系统或合规账本。
- 不顺便改 UI 视觉、会话业务规则或 daemon 部署拓扑。

## 阅读顺序

1. [`00-discussion.md`](./00-discussion.md)：冻结已确认取舍。
2. [`01-problem-analysis-and-current-state.md`](./01-problem-analysis-and-current-state.md)：说明当前代码为什么仍有双轨。
3. [`02-optimization-plan-and-change-scope.md`](./02-optimization-plan-and-change-scope.md)：按依赖顺序给出迁移和删除计划。
4. [`03-reference-projects.md`](./03-reference-projects.md)：说明参考项目影响了什么、没有影响什么。
5. [`04-test-and-acceptance.md`](./04-test-and-acceptance.md)：定义本轮完成条件。

## 完成定义

本轮完成不以“新方法已经出现”为准，而以“旧知识已经消失”为准：业务调用方只依赖 SDK 权威能力，Web 只有一个 backend client 实例与一条活动 workspace 事件流，兼容符号和 fallback 已删除，相关单元、契约、集成、构建与文档检查全部通过。
