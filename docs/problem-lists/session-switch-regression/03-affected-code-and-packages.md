# 03 - /sessions 会话切换回归：涉及代码、文档与包

> 创建日期: 2026-06-15
> 用途: 后续实现和 review 时对照检查

## 1. 主要涉及包

### `packages/ohbaby-agent`

职责:

- command service
- in-process backend
- daemon server
- persistent session store

本次问题的根因主要在 agent 与 daemon 的事件顺序和过滤边界。

### `packages/ohbaby-cli`

职责:

- CLI 入口
- TUI 渲染
- TUI store
- command/dialog/session UI

推荐修复点优先落在 `ohbaby-cli` 的 TUI event subscription 层。

### `packages/ohbaby-sdk`

目前不建议修改 SDK 公共类型。除非后续采用更结构化的 `session.selected` action payload 或新增 command context 字段，否则不需要动。

## 2. 关键代码块

### 2.1 命令实现

文件:

- `packages/ohbaby-agent/src/commands/builtin.ts`

关键位置:

- `handleSessionsCommand()`:
  - `await options.sessions?.selectSession?.(response.choiceId);`
  - `context.emitAction(action("session.selected", { choiceId }))`
- `handleResumeCommand()`:
  - `await options.sessions.selectSession(sessionId);`
  - `context.emitAction(action("session.selected", { choiceId: sessionId }))`
- `handleSessionNew()`:
  - `context.emitAction(action("session.selected", { choiceId: session.id, source: "new" }))`

检查点:

- `/new` 通过 `source: "new"` 明确区分 fresh 页面。
- `/sessions` 和 `/resume` 没有 `source: "new"`，应恢复历史。

### 2.2 command context 发布语义

文件:

- `packages/ohbaby-agent/src/commands/run-context.ts`

关键点:

- `context.emitAction()` 会立即 publish `CommandsEvent.ResultDelivered`。
- 它不是命令结束后的 deferred action。

这会影响“调整命令顺序”方案的风险评估。

### 2.3 in-process session selection

文件:

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

关键位置:

- `sessions.selectSession(sessionId)`
- `stateStore.setActiveSessionId(sessionId)`
- `publishSnapshotReplacement()`

检查点:

- `publishSnapshotReplacement()` 会产生 `snapshot.replaced`。
- 在 daemon 模式下，这个 snapshot 会被 `snapshotForClient()` 按 client view 过滤。

### 2.4 daemon client view

文件:

- `packages/ohbaby-agent/src/runtime/daemon/server.ts`

关键位置:

- `ClientView`
- `initializeClient`
- `resolveStartupActiveSessionId`
- `snapshotForClient`
- `routeEventForClient`
- `updateClientViewsFromEvent`
- `setClientActiveSession`

检查点:

- `snapshotForClient()` 会保留 active session messages，清空 inactive session messages。
- `updateClientViewsFromEvent()` 当前只在 `command.result.delivered(session.selected)` 时更新 client view。
- `snapshot.replaced` 发生在 selected action 之前时，会按旧 view 过滤。

### 2.5 TUI store

文件:

- `packages/ohbaby-cli/src/tui/store/events.ts`

关键位置:

- `case "snapshot.replaced"`
- `case "command.result.delivered"`
- `selectedSessionIdFromCommandAction`
- `rebuildFromCollections`
- `deriveTranscript`

检查点:

- store 是纯 reducer，不应直接发 RPC。
- reducer 只从当前已知 collections 派生 messages。
- 如果 target session 在 collections 中 messages 为空，reducer 无法自行恢复 transcript。

### 2.6 TUI app event subscription

文件:

- `packages/ohbaby-cli/src/tui/app.tsx`

关键位置:

- `subscribeEvents((tuiEvent) => { ... })`
- `eventDispatcher.dispatch(tuiEvent)`
- `client.getSnapshot().then((snapshot) => store.replaceSnapshot(snapshot))`
- `isNewSessionSelectionEvent`
- `HeaderContainer`

检查点:

- 推荐新增 `isExistingSessionSelectionEvent()`。
- 推荐在收到已有 session selected 后触发一次 `client.getSnapshot()`。
- 需要 sequence guard 和 disposed guard。
- `/new` 仍然只走 clear screen + empty prompt，不触发历史恢复。

## 3. 相关测试文件

### 3.1 现有覆盖

- `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`
  - 已覆盖 cached transcript switch。
  - 缺失 daemon-filtered snapshot 后再 selected 的场景。

- `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts`
  - 已覆盖 client view 隔离。
  - 缺失 `/sessions` command event order 对 TUI transcript 的影响。

- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
  - 已覆盖 `/sessions` 和 `/resume` 在 in-process 下可切换。
  - 不能覆盖 daemon `snapshotForClient()` 过滤问题。

- `tests/integration/cli/daemon-terminal.integration.test.ts`
  - 已覆盖默认 fresh 与 explicit continue。
  - 可扩展覆盖 `/sessions` 或 daemon client switching。

### 3.2 建议新增覆盖

优先级从高到低:

1. `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
   - mock client `getSnapshot()`，模拟收到 `session.selected` 后刷新 snapshot。
2. `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts`
   - 明确断言 `command.result.delivered(session.selected)` 后 `getSnapshot()` 返回目标 session messages。
3. `tests/integration/cli/daemon-terminal.integration.test.ts`
   - 端到端验证两个 client/window 互不影响。

## 4. 相关文档

本目录下文档:

- `01-current-problem-and-root-cause.md`
- `02-fix-options-and-implementation-plan.md`
- `03-affected-code-and-packages.md`
- `04-tests-and-acceptance-criteria.md`

历史相关目录:

- `docs/problem-lists/session-views/`
- `docs/problem-lists/terminal-daemon/`
- `docs/problem-lists/sessions-ui-backend/`

## 5. 版本影响

当前已经发布过 `v0.1.2`，并且已提交 daemon 端口修复基线:

- commit: `3ed8fec1 fix: avoid daemon port conflicts in npm installs`

建议本问题作为下一版修复候选:

- 如果只修 TUI refresh 和测试: `v0.1.3` 可接受。
- 如果同时重构 command/session selection 事件顺序: 建议放到 `v0.1.4` 或后续，因为影响面更大。
