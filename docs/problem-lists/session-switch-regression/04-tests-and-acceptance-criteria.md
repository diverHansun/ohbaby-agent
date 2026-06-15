# 04 - /sessions 会话切换回归：测试与验收标准

> 创建日期: 2026-06-15
> 目标: 修复前先写失败用例，修复后用自动化和手工流程验收

## 1. 当前已执行检查

### 1.1 端口修复基线提交

已提交:

```text
3ed8fec1 fix: avoid daemon port conflicts in npm installs
```

提交 hook 已通过:

```text
pnpm run lint
pnpm run typecheck
```

### 1.2 当前针对测试

已执行:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --passWithNoTests
```

结果:

```text
2 files passed
88 tests passed
```

结论:

- 现有测试没有覆盖本次 `/sessions` 空白 transcript 回归。
- 需要新增 regression test，不能只靠现有测试判断修复完成。

## 2. 必须新增的自动化测试

### 2.1 TUI app refresh test

目标:

验证收到非 `/new` 的 `session.selected` 后，TUI 会从 `client.getSnapshot()` 拉取当前 client view，并恢复目标 session transcript。

建议文件:

- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

测试要点:

1. 初始化 store 为 `session_1`。
2. 模拟 daemon 先推送按旧 view 过滤的 `snapshot.replaced`，其中 `session_2.messages=[]`。
3. 再推送 `command.result.delivered`，action 为:

```ts
{
  kind: "session.selected",
  data: { choiceId: "session_2" }
}
```

4. mock `client.getSnapshot()` 返回按新 view 过滤后的 snapshot:

```ts
{
  activeSessionId: "session_2",
  sessions: [
    { id: "session_1", messages: [] },
    { id: "session_2", messages: [{ ...history }] }
  ]
}
```

5. 断言最终渲染包含 `session_2` 的历史消息，不显示空会话 logo。

### 2.2 `/new` 不触发历史 refresh

目标:

确保 `/new` 仍然清屏并显示 fresh logo，不被新增 refresh 逻辑误伤。

测试要点:

1. 推送 `command.result.delivered`，action 为:

```ts
{
  kind: "session.selected",
  data: { choiceId: "session_new", source: "new" }
}
```

2. 断言:

- 调用了 clear sequence。
- 不额外调用用于恢复历史的 session refresh，或即使有 snapshot 也不把旧 session transcript 渲染回来。

### 2.3 race guard test

目标:

避免快速连续切换 session 时，旧 `getSnapshot()` 晚到覆盖新 session。

测试要点:

1. 连续发送 `session.selected(session_2)` 和 `session.selected(session_3)`。
2. 让 `session_3` 的 `getSnapshot()` 先 resolve。
3. 再让 `session_2` 的 `getSnapshot()` 后 resolve。
4. 断言最终 active session 仍是 `session_3`，消息也是 `session_3`。

### 2.4 daemon snapshot after selection test

目标:

验证 daemon 在收到 `command.result.delivered(session.selected)` 后，当前 client 的 `getSnapshot()` 返回目标 session view。

建议文件:

- `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts`

测试要点:

1. client A 初始化为 `session_1`。
2. backend snapshot 中存在 `session_2` 且有 messages。
3. daemon 收到 selected action 后更新 client A view。
4. client A 调用 `getSnapshot()`。
5. 断言:

- `activeSessionId === "session_2"`
- `session_2.messages.length > 0`
- client B 仍看不到 `session_2` messages，除非 B 自己切过去。

## 3. 修复后必须执行的命令

本次实现已新增:

- TUI contract: 已有 session selection 后刷新 snapshot 并恢复目标 transcript。
- TUI contract: 慢初始化 snapshot 不覆盖已经成功刷新的目标 session。
- TUI contract: 连续快速选择多个 session 时，旧 refresh 晚到不会覆盖最新选择。
- TUI contract: `/new` 会让已有 session 的 pending refresh 失效，旧 refresh 不能覆盖 fresh 页面。
- daemon integration: session selection 更新当前 client view 后，`getSnapshot()` 返回目标 transcript。
- daemon integration: A 窗口切 session 不改变 B 窗口 view，B 仍看不到 A 的目标 transcript。

最小必跑:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --passWithNoTests
pnpm run typecheck
pnpm run lint
```

建议补跑:

```powershell
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts tests/integration/cli/daemon-terminal.integration.test.ts --passWithNoTests
```

发布前必跑:

```powershell
pnpm test
pnpm run build
```

本次已通过:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --passWithNoTests
pnpm vitest run packages/ohbaby-agent/src/services/session/project-root.unit.test.ts packages/ohbaby-agent/src/services/session/store.unit.test.ts packages/ohbaby-agent/src/services/session/database-store.integration.test.ts packages/ohbaby-agent/src/services/session/manager.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts tests/integration/tui/persistent-display.integration.test.tsx tests/integration/cli/prompt-process.integration.test.ts --passWithNoTests
pnpm vitest run packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/state-file.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/main.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts packages/ohbaby-cli/src/cli/commands/run.unit.test.ts packages/ohbaby-cli/src/cli/commands/terminal.unit.test.ts tests/integration/cli/daemon-auto-spawn.integration.test.ts tests/integration/cli/daemon-terminal.integration.test.ts tests/integration/cli/daemon-global-fifo.integration.test.ts tests/integration/cli/prompt-process.integration.test.ts --no-file-parallelism --passWithNoTests
pnpm run typecheck
pnpm run lint
```

## 4. 手工验收标准

### 4.1 单窗口 session 切换

步骤:

1. `pnpm start`
2. 输入一条消息并等待响应。
3. 执行 `/new`。
4. 确认显示大 logo 和空 prompt。
5. 执行 `/sessions`。
6. 选择第一步创建的旧会话。

验收:

- 旧会话历史消息恢复。
- 不显示大 logo。
- status bar 的 session id 与目标 session 一致。

### 4.2 双窗口隔离

步骤:

1. 窗口 A: `pnpm start`，进入 fresh session。
2. 窗口 B: 同一 project root 下 `pnpm start`。
3. A 发送消息并形成 session A。
4. B 发送消息并形成 session B。
5. A 执行 `/sessions` 切到 session B 或另一个历史 session。

验收:

- A 的切换不改变 B 的 active session。
- B 不会突然重绘成 A 的历史。
- A 能看到自己选择的目标 session 历史。

### 4.3 `/resume` 恢复

步骤:

```powershell
pnpm start -- --resume <session-id>
```

或在 TUI 中执行:

```text
/resume --session_id <session-id>
```

验收:

- 目标 session 历史恢复。
- 不显示 fresh logo。
- 不影响其他窗口 active session。

### 4.4 npm 安装版本回归

在发布候选包后执行:

```powershell
npm install -g ohbaby-cli@latest
ohbaby
```

验收:

- 默认启动为 fresh session。
- `/sessions` 选择历史会话能恢复 transcript。
- `/new` 显示干净大 logo。
- 多窗口互不跟随切换。

## 5. Review 检查清单

代码 review 时必须确认:

- 没有移除 `snapshotForClient()` 的 inactive messages 过滤。
- 没有让 daemon 全局 `activeSessionId` 覆盖每个 client view。
- 新增 refresh 只针对已有 session selection，不针对 `/new`。
- refresh 有 disposed guard。
- 如果存在并发 refresh，有 sequence guard。
- 测试覆盖了 daemon-filtered snapshot 的真实失败序列。
- `pnpm run lint`、`pnpm run typecheck`、相关 vitest 均通过。
