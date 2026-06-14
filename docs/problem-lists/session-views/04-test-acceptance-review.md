# 04 - Session Views 测试、验收与审查标准

> 创建日期: 2026-06-14
> 状态: 草案，待审阅
> 原则: 先证明旧问题会失败，再证明修复后不会回归

---

## 1. 测试策略

本问题必须覆盖三层:

```text
daemon protocol/server tests
  -> 证明每个 remote client 有独立 view

TUI store/app tests
  -> 证明事件不会隐式激活别人的 session，fresh startup 会清屏

packaging/manual smoke
  -> 证明 npm 安装后的真实 ohbaby 命令行为正确
```

不能只依赖 `createPersistentUiBackendClient()` 的 in-process 测试，因为真实问题发生在:

```text
one daemon server
one shared backend
many remote clients
```

---

## 2. 必须新增或调整的自动化测试

### TEST-DAEMON-01: 默认 remote client 是 fresh view

测试文件建议:

```text
tests/integration/cli/daemon-session-views.integration.test.ts
```

场景:

```text
Given: daemon 已启动
And: client A 默认启动并提交 prompt，创建 session_A
When: client B 默认启动
Then: client B getSnapshot().activeSessionId === null
And: client B snapshot.sessions 包含 session_A metadata
And: client B 不显示 session_A transcript
```

关键断言:

```ts
expect(snapshotB.activeSessionId).toBeNull();
expect(snapshotB.sessions.some((session) => session.id === sessionA)).toBe(true);
expect(JSON.stringify(snapshotB)).not.toContain("client A prompt text");
```

如果产品决定 fresh view 可以看到 session list 但不加载 transcript，上述断言成立。

---

### TEST-DAEMON-02: --continue 显式恢复 latest session

场景:

```text
Given: daemon 中存在 session_A 和 session_B，session_B 更新更晚
When: client C 使用 startupSessionMode: continue
Then: client C activeSessionId === session_B
```

关键断言:

```ts
expect(snapshotC.activeSessionId).toBe(sessionB);
```

目的:

确保默认 fresh 修复不会破坏显式 continue。

---

### TEST-DAEMON-03: --resume 显式恢复指定 session

场景:

```text
Given: daemon 中存在 session_A 和 session_B
When: client C 使用 resumeSessionId: session_A
Then: client C activeSessionId === session_A
```

关键断言:

```ts
expect(snapshotC.activeSessionId).toBe(sessionA);
```

错误场景:

```text
When: resumeSessionId 不存在
Then: initializeClient/getSnapshot 抛出 Session not found
```

---

### TEST-DAEMON-04: 两个窗口切换 session 不互相影响

场景:

```text
Given: client A active = session_A
And: client B active = session_B
When: client A 执行 /sessions 或 /resume 选择 session_C
Then: client A active = session_C
And: client B active = session_B
```

关键断言:

```ts
expect(snapshotA.activeSessionId).toBe(sessionC);
expect(snapshotB.activeSessionId).toBe(sessionB);
```

---

### TEST-DAEMON-05: /new 只影响当前 client

场景:

```text
Given: client A active = session_A
And: client B active = session_B
When: client A executeCommand("/new")
Then: client A active = session_new
And: client B active = session_B
And: session_new 出现在两个窗口的 session list metadata 中
And: client B 不显示 session_new transcript
And: 如果 client B 仍是 fresh/null view，client B 再执行 /new 时必须创建另一个新 session，而不是复用 client A 的空 session
```

关键断言:

```ts
expect(snapshotA.activeSessionId).toBe(sessionNew);
expect(snapshotB.activeSessionId).toBe(sessionB);
expect(snapshotB.sessions.some((session) => session.id === sessionNew)).toBe(true);
```

---

### TEST-DAEMON-06: transcript events 不泄漏到 fresh client

场景:

```text
Given: client B fresh view，activeSessionId = null
When: client A 提交 prompt 并收到 assistant response
Then: client B 不收到 message.appended 或 run.updated 相关渲染事件
Or: client B 收到事件但 reducer 忽略，最终 frame 不包含 A 的 prompt/response
```

优先断言 server 过滤:

```ts
expect(eventsB.map((event) => event.type)).not.toContain("message.appended");
```

如果实现选择 TUI 防线而非 server 过滤，也必须断言:

```ts
expect(frameB).not.toContain("client A prompt");
expect(frameB).not.toContain("client A response");
```

---

### TEST-TUI-01: session.updated 不自动激活

测试文件:

```text
packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

场景:

```ts
const state = createStateFromSnapshot({
  activeSessionId: null,
  sessions: [],
  ...
});

const next = applyTuiEvent(state, {
  type: "session.updated",
  session: makeSession("session_A"),
});

expect(next.activeSessionId).toBeNull();
expect(next.sessions).toContainEqual(expect.objectContaining({ id: "session_A" }));
```

---

### TEST-TUI-02: message.appended 可绑定当前 client 的 fresh view

测试文件:

```text
packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

场景:

```ts
const next = applyTuiEvent(stateWithNoActiveSession, {
  type: "message.appended",
  sessionId: "session_A",
  message: makeUserMessage("hello from A"),
});

expect(next.activeSessionId).toBeNull();
```

上面的断言只适用于“未经过 daemon 过滤、代表其他窗口”的事件。实际 TUI reducer 测试应同时覆盖：`session.updated` 不激活；当当前窗口确实收到 transcript event 时，fresh view 可以绑定到该 `sessionId` 并显示内容。

---

### TEST-TUI-03: snapshot.replaced 仍可设置当前 client active session

场景:

```ts
const next = applyTuiEvent(stateWithNoActiveSession, {
  type: "snapshot.replaced",
  snapshot: makeSnapshot({ activeSessionId: "session_A" }),
});

expect(next.activeSessionId).toBe("session_A");
```

目的:

保证 active session 仍能通过明确的 client-scoped snapshot 改变。

---

### TEST-TUI-04: /new 清屏仍工作

测试文件:

```text
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

已有相关测试应保留并调整:

```ts
expect(output).toContain(NEW_SESSION_CLEAR_SEQUENCE);
```

必须断言普通 session selection 不清屏:

```text
/sessions -> select existing session
  -> no NEW_SESSION_CLEAR_SEQUENCE
```

---

### TEST-TUI-05: 默认 fresh startup 清屏一次

场景:

```text
Given: OhbabyTerminalApp clearOnStart=true
When: app initial render
Then: stdout writes NEW_SESSION_CLEAR_SEQUENCE exactly once
And: rerender 不重复写入
```

关键断言:

```ts
expect(writeStdout).toHaveBeenCalledWith(NEW_SESSION_CLEAR_SEQUENCE);
expect(
  writeStdout.mock.calls.filter(([value]) => value === NEW_SESSION_CLEAR_SEQUENCE),
).toHaveLength(1);
```

另一个场景:

```text
Given: clearOnStart=false
Then: 不写 NEW_SESSION_CLEAR_SEQUENCE
```

---

### TEST-PACKAGING-01: v0.1.2 npm pack 依赖一致

测试文件:

```text
tests/integration/cli/packaging-smoke.integration.test.ts
```

必须断言:

```text
ohbaby-cli@0.1.2
  -> ohbaby-agent@0.1.2
  -> ohbaby-sdk@0.1.2
  -> ink@6.6.0
  -> ink-gradient@4.0.1
  -> react@19.2.3
```

---

## 3. 手动验收脚本

### 3.1 Windows 多窗口 fresh startup

前置:

```powershell
npm install -g ohbaby-cli@0.1.2
ohbaby --version
```

期望:

```text
0.1.2
```

步骤:

1. 打开 Windows Terminal tab A。
2. 进入同一个 project root。
3. 执行 `ohbaby`。
4. 输入 `你好 A` 并等待回复。
5. 打开 Windows Terminal tab B。
6. 进入同一个 project root。
7. 执行 `ohbaby`。

验收:

```text
Tab B 显示 Ohbaby 大 logo 和空 prompt。
Tab B 不显示 Tab A 的 prompt 或 assistant response。
Tab B status bar active session 为空或新的 fresh session view。
```

---

### 3.2 多窗口切换隔离

步骤:

1. Tab A 执行 `/new`。
2. Tab A 输入 `A session text`。
3. Tab B 执行 `/new`。
4. Tab B 输入 `B session text`。
5. Tab A 执行 `/sessions`，选择 B 以外的 session。

验收:

```text
Tab A 切换成功。
Tab B 不跟随 Tab A。
Tab B 的 prompt 和 transcript 不闪烁、不切换。
```

---

### 3.3 显式恢复

步骤:

```powershell
ohbaby --continue
```

验收:

```text
恢复当前 project 最近 session。
```

步骤:

```powershell
ohbaby --resume <session-id>
```

验收:

```text
恢复指定 session。
如果 session-id 不存在，显示明确错误，不进入错误 session。
```

---

### 3.4 fresh startup 清屏

步骤:

1. 在 PowerShell 中执行若干命令，例如 `pwd`、`dir`。
2. 执行 `ohbaby`。

验收:

```text
进入 TUI 后屏幕顶部是 Ohbaby 大 logo。
看不到刚才 PowerShell 的命令历史。
清屏没有循环闪烁。
```

---

### 3.5 /new 清屏

步骤:

1. 在 TUI 内输入一些 prompt，产生 transcript。
2. 执行 `/new`。

验收:

```text
屏幕清理。
显示 Ohbaby 大 logo 和新空 prompt。
不会残留上一轮 transcript。
不会影响其他 terminal 窗口。
```

---

## 4. 自动化验证命令

基础验证:

```powershell
pnpm run typecheck
pnpm run test
pnpm run build
```

聚焦验证:

```powershell
pnpm vitest run tests/integration/cli/daemon-session-views.integration.test.ts
pnpm vitest run packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts
pnpm vitest run packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
pnpm vitest run packages/ohbaby-cli/src/tui/store/events.unit.test.ts
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

packaging 验证:

```powershell
pnpm run build
npm pack .\packages\ohbaby-sdk
npm pack .\packages\ohbaby-agent
npm pack .\packages\ohbaby-cli
npm install -g .\ohbaby-cli-0.1.2.tgz
ohbaby --version
```

注意:

`npm install -g .\ohbaby-cli-0.1.2.tgz` 是否能正确安装本地 `ohbaby-agent`/`ohbaby-sdk`，取决于 pack 阶段的依赖解析。若本地 tarball 测试需要同时引用 agent/sdk tarball，应在 packaging smoke 里显式搭建临时 registry 或使用 `npm pack` 产物安装。

---

## 5. 审查标准

### 5.1 行为审查

必须回答“是”:

1. 默认 `ohbaby` 是否不再恢复上一个 terminal 的 active session?
2. `--continue` 是否仍恢复 latest session?
3. `--resume <id>` 是否仍恢复指定 session?
4. `/new` 是否只改变当前窗口，且 fresh/null 窗口不会复用其他窗口的空 session?
5. `/sessions` 和 `/resume` 是否只改变当前窗口?
6. 新窗口是否仍能看到 session list metadata，但不显示非 active transcript?
7. fresh startup 是否清屏?
8. `/new` 是否清屏?

### 5.2 代码审查

必须确认:

1. `RemoteDaemonClient` 默认会初始化 client view。
2. `clientViews` 不再只是权限/启动辅助，而是当前窗口 active session 的来源。
3. `snapshot.replaced` 广播前按 client 改写。
4. `message.*` 和 `run.*` 不会进入无关 client。
5. TUI reducer 不再通过 `session.updated` 隐式激活；`message.appended` 依赖 daemon 的 per-client 过滤作为绑定信号。
6. in-process 模式仍通过明确路径设置 active session。
7. 类型变化同步到 agent、cli、sdk。
8. 没有为了测试添加生产代码里的特殊分支。

### 5.3 测试审查

必须确认:

1. 至少一个测试能在旧实现上失败。
2. daemon remote 多窗口路径被覆盖，不只是两个 persistent client。
3. fresh/null active session 被覆盖。
4. explicit continue/resume 没有回归。
5. 清屏测试断言次数，防止重复清屏。
6. packaging smoke 覆盖 npm 安装后的依赖版本。

### 5.4 发布审查

发布前必须确认:

```text
git tag v0.1.2 指向 main 最新 commit
npm view ohbaby-cli dist-tags.latest == 0.1.2
ohbaby --version == 0.1.2
npm ls -g ohbaby-cli 显示 agent/sdk 版本匹配
```

GitHub Release 建议摘要:

```md
## Fixes

- Fixed daemon session view isolation across multiple terminal windows.
- Default `ohbaby` now starts a fresh client view instead of adopting another window's active session.
- `/new`, `/sessions`, and `/resume` now affect only the current terminal window.
- Fresh startup and `/new` now render a clean Ohbaby screen without previous shell history.

## Upgrade

```bash
npm install -g ohbaby-cli@latest
```
```

---

## 5.5 Review Hardening Acceptance

审查后新增的阻断级验收项:

```text
server.integration:
- fresh/null client getSnapshot() does not contain non-active session messages.
- snapshot.replaced is rewritten and scrubbed per client view.
- session.updated for another session is not delivered to fresh/null view.
- fresh/null submitPrompt gets a generated explicit sessionId before backend.submitPrompt.
- unrelated session.updated cannot rebind a pending fresh prompt client.
- runtime.updated is scoped by run/session owner and does not reach fresh/null view.
- unowned command.result.delivered is dropped instead of broadcast.
```

这些用例必须与原有 default fresh、explicit continue/resume、/new no-reuse、TUI clearOnStart、packaging smoke 一起通过，才可进入 v0.1.2 release/tag 阶段。

---

## 6. 回滚标准

如果 v0.1.2 发布后出现以下情况，应优先回滚 npm latest 到 v0.1.1 或发布 v0.1.3 hotfix:

1. 默认 `ohbaby` 无法启动 daemon。
2. `--continue` 或 `--resume` 无法恢复历史。
3. prompt submit 后无法创建 session。
4. TUI 持续清屏或闪烁，无法输入。
5. npm 全局安装后 agent/sdk 依赖解析失败。

回滚命令示意:

```powershell
npm dist-tag add ohbaby-cli@0.1.1 latest
```

如果 `ohbaby-agent` 或 `ohbaby-sdk` 也发布了 `0.1.2`，需要分别确认它们是否被其他包直接依赖，再决定是否调整各自 dist-tag。
