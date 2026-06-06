# TUI Status Bar Context Window Usage

日期: 2026-06-05
更新: 2026-06-06
状态: 已纳入 `tui-improve-1` A+C 方案

## 结论

原问题是：TUI 状态栏右侧需要显示当前会话的 token/context window usage，但
`UiSnapshot` 和 SDK API 没有数据来源。

2026-06-06 讨论后，该问题不再延后，纳入
`docs/ohbaby-cli/tui-improve-1/05-a-c-contract-appshell-viewport-plan.md`。

最终口径:

- 显示当前 session 的 context window usage，例如 `38.4K / 1M (4%)`。
- 分母使用模型完整 context window。
- 不使用 input budget ratio。
- 不显示费用。
- 不显示草稿输入 token。
- TUI 不自行估算 token；数据由 agent/SDK 提供。
- 无数据时 status bar 右侧留空。
- `/status` panel 无数据时显示 `Context unavailable`。

## 需要补的契约

SDK:

- `UiContextWindowUsage`
- `UiSnapshot.contextWindowUsages`
- `CoreAPI.getContextWindowUsage({ sessionId })`
- `context.window.updated` 事件

agent:

- `packages/ohbaby-agent/src/core/context/context-window-usage.ts`
- session 级内存缓存，不持久化
- `run.context.prepared` 到 `context.window.updated` 的映射
- `/status` data 增加 `contextWindow`，旧 `context` 可保留一版兼容
- 在接入 TUI 前，用真实 session 验证 `ContextUsage -> UiContextWindowUsage` 映射，
  确认分母为完整模型 context window，而不是 input budget

TUI:

- 只显示 active session 的 usage
- session 切换不能显示其他 session 的旧值
- refresh 失败时保留当前 session 自己的旧缓存并发 warning notice
- 格式化函数放在 `packages/ohbaby-cli/src/tui/render/usage.ts`

legacy `context` alias 删除条件:

- `contextWindow` 在一个 minor 版本内稳定可用；
- TUI 和 `/status` 已只读 `contextWindow`；
- 没有外部消费者继续依赖旧字段。

## 后续阅读

权威设计与实施阶段见:

- `docs/ohbaby-cli/tui-improve-1/05-a-c-contract-appshell-viewport-plan.md`
