# 多进程同开一个会话的占用规则

本议题于 2026-11-10 记录，**待讨论，尚未规划**。它不属于 side chat、fork、撤销重发这一批，等这一批合入 main 后再和用户详细讨论、设计。

## 起因

同一个 SQLite 数据库可以被多个后端进程共用：

- daemon 服务 Web，以后也服务桌面 app（由 Web 演变而来，以后以 app 为主）。
- 进程内 TUI 不走 daemon，在自己的进程里起一个完整后端。

用户预期的使用场景：主要用桌面 app，同时开着 TUI 配合工作，两边的工作区路径可能不同。

验收撤销重发后端时（2026-11-10），已经零散落地了几条跨进程规则：

- side chat 按进程归属：`data.sideChat.ownerId` 加 PID。
- goal 驱动者登记：`app_state` 里的 goal-driver，`packages/ohbaby-agent/src/goals/persistence.ts`。只有驱动者能暂停或清除 goal，其他后端返回 `SESSION_RUNNING`。
- 撤销遇到别的进程正在跑的轮次，返回 `SESSION_RUNNING`。
- `run_ledger` 和 prompt 调度用 `ownerId` 加 `ownerPid`。

每个功能各打一个补丁，功能越多，补丁越多。

## 参照：Codex 的做法

用户在 Codex 的桌面 app 和 CLI 上试过：

- CLI 里的对话，app 要关掉再打开才能看到，没有实时同步。
- 同一个会话在 CLI 里开着时，app 这边只读，提示 “This is open in another app. Close it there to continue here”，提供 Retry 和 Fork chat 两个按钮。

## 要讨论的问题

1. 同一个会话被两个后端同时打开时，谁能写（发提问、撤销、压缩、控制 goal），另一端显示什么。是否学 Codex：一个会话同一时刻只归一个进程，另一端只读，提供 Retry 和 Fork chat。fork 后端已经实现，可以直接接上。
2. 两端工作区路径不同时怎么处理。会话已有 `SESSION_MOVED` 和 `assertSessionInWorkspace`。
3. 上面零散的规则能否收拢成一条统一的“会话占用”规则，现有实现如何迁移。
4. 跨进程实时同步要不要做。
5. 另一条路是让 TUI 也连 daemon。这和“TUI 走进程内”的既定策略冲突，要说明取舍。

讨论时每个问题先对比 `code-cli/` 下的参考项目（codex、opencode、kimi-code、ZCode、deepseek-harness、claude-code），确认后再按 plan-code-improvement 产出 improve-1 的 00 至 04。

## 相关议题

| 议题 | 关系 |
|---|---|
| [side chat](../2026-11-04-side-chat/README.md) | 按进程归属的 side chat |
| [会话 fork](../2026-11-04-session-fork/README.md) | 另一端点 Fork chat 时调用它 |
| [撤销重发](../2026-11-04-conversation-undo/README.md) | 00 第 6 节的 D1、D2 记录了这次讨论的起点 |
