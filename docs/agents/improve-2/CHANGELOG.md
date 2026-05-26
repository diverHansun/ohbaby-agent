# Agents Improve-2 Changelog

本记录用于 merge 前后快速核对 agents improve-1 / improve-2 的公共契约变化、行为变化与后续候选事项。

## 新增公共 API

### `core/agents`

- `runAgent`
- `extractFinalOutput`
- `AgentRunHandle`
- `AgentRunCoordinator`
- `AgentRunEventSource`
- `AgentRunInput`
- `AgentRunResult`

### `agents`

- `AgentService`
- `AgentServiceOptions`
- `StartSessionParams`
- `AgentSessionStartResult`

### `services/session`

- `SessionManager.ensureRoot`

## 移除公共 API

下列旧 subagent 专用抽象已删除，避免 primary agent 与 subagent 形成两套并行执行机制：

- `SubagentExecutor`
- `SubagentExecutorOptions`
- `createSubagentRunner`
- `SubagentRunner`
- `SubagentRunnerResult`
- `SubagentToolCallSummary`
- `SubagentSessionManager`
- `SubagentMessageWriter`
- `createSubagentMessageWriter`
- `createRuntimeSubagentSessionManager`
- `SubagentPromptMessageBuilder`
- `AgentPromptMessageBuilder`
- `AgentRunRecord`

## 重命名

- `agents` 侧的 `SystemPromptProvider` 重命名为 `AgentPromptProvider`，避免与 `core/system-prompt` 的 `SystemPromptProvider` 同名不同义。

## 行为变化

- primary agent 启动路径改为 `AgentService.startSession -> core/agents.runAgent -> RunManager -> Lifecycle.runSession`。
- task/subagent 同步执行路径继续通过 `AgentService.executeTask` / `AgentTaskManager`，但底层同样消费 `core/agents.runAgent`。
- `core/agents` 不再预组装 prompt messages；context 组装由 `Lifecycle.runSession` 通过 `context.prepareTurn` 负责。
- UI stream envelope 会在 run 创建前使用确定的 `runId` 预订阅事件，避免快速完成的 run 丢失事件。
- `AgentRunResult` 使用 `mode` 判别 union；wait 成功分支只暴露 `finalOutput`，wait 失败分支只暴露 `error`。
- `RunManager` 仍保留 legacy `messages` 入口以兼容现有直接调用方；agent 路径使用 `directory / modelId` 进入 session-run 模式。

## 验证记录

- `pnpm -F ohbaby-agent typecheck`
- `pnpm run lint -- --no-cache`
- `pnpm test`
- `tests/smoke/tui-real-provider.smoke.test.tsx` 真实 provider smoke，覆盖 TUI 主链路、read 工具、Tavily `web_search`、explore child session resume、task child shell/file edit。
- 子代理复审：架构边界与数据流均通过。

## 后续候选

- 将 `SubagentExecuteParams / SubagentResult` 命名收敛为更中性的 `TaskInvocationParams / TaskInvocationResult`，并评估是否保留 deprecated alias。
- 为 `AgentTaskManager` 增加 DB-backed task store，避免重启后丢失长生命周期任务状态。
