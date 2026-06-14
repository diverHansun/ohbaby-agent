# 03 - Session Views 涉及文档、代码块与包索引

> 创建日期: 2026-06-14
> 状态: 草案，待审阅
> 用途: 后续实现与 review 时对照代码位置

---

## 1. 本项目文档

| 路径 | 作用 | 本次关联 |
|---|---|---|
| `README.md` | 用户入口、安装、项目定位 | v0.1.2 release 后需要确认 session 行为描述是否准确 |
| `docs/problem-lists/sessions-ui-backend/` | 之前 session UI/backend 问题拆解 | 可复用文档结构与 session 命令背景 |
| `docs/problem-lists/session-views/01-current-problems-and-code-analysis.md` | 本问题根因分析 | 本轮新增 |
| `docs/problem-lists/session-views/02-modification-and-implementation-plan.md` | v0.1.2 修改计划 | 本轮新增 |
| `docs/problem-lists/session-views/03-docs-code-packages-reference.md` | 文件与包索引 | 本轮新增 |
| `docs/problem-lists/session-views/04-test-acceptance-review.md` | 测试、验收、审查标准 | 本轮新增 |

---

## 2. 参考项目文档与实现

### 2.1 Gemini CLI

路径:

```text
D:\Projects\Code-cli\gemini-cli\docs\cli\session-management.md
```

可借鉴点:

1. 自动保存历史和显式恢复历史分离。
2. `--resume`、`/resume`、`--list-sessions` 作为明确用户意图。
3. session history 按 project scope 管理。
4. 并行工作建议使用 Git worktrees，避免代码文件冲突。

对 Ohbaby 的落地原则:

```text
默认 ohbaby = fresh view
显式 --continue/--resume = restore view
历史可见不等于自动 active
```

### 2.2 opencode

关键路径:

```text
D:\Projects\Code-cli\opencode\packages\app\src\app.tsx
D:\Projects\Code-cli\opencode\packages\app\src\components\dialog-select-file.tsx
D:\Projects\Code-cli\opencode\packages\app\src\components\dialog-fork.tsx
```

观察点:

```ts
<Route path="/session/:id?" component={SessionRoute} />
```

选择 session 后显式导航:

```ts
navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
```

fork 后显式进入新 session:

```ts
navigate(`/${dir}/session/${forked.data.id}`)
```

对 Ohbaby 的落地原则:

```text
session selection 是 view selection。
事件更新数据集合，但不应该隐式改变当前 view。
```

### 2.3 Kimi Code

关键路径:

```text
D:\Projects\Code-cli\kimi-code\packages\kaos\src\local.ts
D:\Projects\Code-cli\kimi-code\packages\kaos\test\e2e\concurrent-operations.test.ts
D:\Projects\Code-cli\kimi-code\packages\agent-core\test\harness\plan-mode-session.test.ts
```

观察点:

`LocalKaos` 每个实例维护自己的 `_cwd`，而不是修改 `process.cwd()`。测试中也覆盖并发操作和 resume 行为。

对 Ohbaby 的落地原则:

```text
窗口级 view state 不应放在 daemon/backend 全局变量里。
每个 client 都应有独立 activeSessionId。
```

### 2.4 Claude Code 本地参考仓库

关键路径:

```text
D:\Projects\Code-cli\claude-code\docs\features\daemon.md
D:\Projects\Code-cli\claude-code\docs\features\daemon-restructure-design.md
D:\Projects\Code-cli\claude-code\docs\task\task-004-assistant-session-attach.md
```

可借鉴点:

1. daemon supervisor 与前台 attach/view 分离。
2. 后台 session 管理命令要有明确命名空间。
3. attach 到哪个 session 是用户显式动作。

对 Ohbaby 的落地原则:

```text
daemon 是共享运行时，不是共享 UI 当前视图。
```

---

## 3. 入口与启动相关代码

### 3.1 CLI terminal command

文件:

```text
packages/ohbaby-cli/src/cli/commands/terminal.ts
```

关键点:

```ts
.option("continue", {
  describe: "resume the latest primary session before starting the terminal UI",
  type: "boolean",
})
.option("resume", {
  describe: "resume a session by id before starting the terminal UI",
  type: "string",
})
.option("daemon", {
  describe: "run the terminal UI through the local daemon",
  type: "boolean",
})
```

当前构造:

```ts
const host = await runtime.buildCoreAPI({
  ...(args.continue === true ? { continue: true } : {}),
  ...(useInProcess
    ? { daemon: false, inProcess: true }
    : { daemon: true }),
  ...(resume === undefined ? {} : { resume }),
});
```

后续关注:

1. 默认 `ohbaby` 是否传 fresh intent。
2. `--continue` 和 `--resume` 是否保持显式恢复语义。
3. 是否向 TUI 传入 `clearOnStart` 或等价选项。

### 3.2 Core API factory

文件:

```text
packages/ohbaby-agent/src/host/core-api-factory.ts
```

当前问题代码:

```ts
return Object.keys(intent).length === 0 ? undefined : intent;
```

后续关注:

1. `DaemonStartupIntent` 是否支持 `{ startupSessionMode: { type: "fresh" } }`。
2. 默认 daemon path 是否总是传 `startupIntent`。
3. in-process path 的初始 snapshot 行为是否与 daemon 一致。

---

## 4. daemon client/server/protocol

### 4.1 Protocol

文件:

```text
packages/ohbaby-agent/src/runtime/daemon/protocol.ts
```

后续可能需要修改:

```ts
export interface DaemonStartupIntent {
  readonly startupSessionMode?: { readonly type: "continue" };
  readonly resumeSessionId?: string;
  readonly initialPermission?: ...;
}
```

建议变为:

```ts
export type DaemonStartupSessionMode =
  | { readonly type: "fresh" }
  | { readonly type: "continue" };
```

### 4.2 Remote daemon client

文件:

```text
packages/ohbaby-agent/src/runtime/daemon/client.ts
```

当前问题代码:

```ts
private async ensureInitialized(): Promise<void> {
  if (this.startupIntent === undefined) {
    return;
  }
  this.initializePromise ??= this.rpc("initializeClient", [this.startupIntent], {
    skipInitialize: true,
  });
  await this.initializePromise;
}
```

后续关注:

1. 默认 startupIntent 不能是 `undefined`。
2. `events()`、`getSnapshot()`、`submitPrompt()`、`executeCommand()` 前都应确保 client 已初始化。
3. 如果 remote explicit connection 没有传 startupIntent，也需要有一个安全默认值。

### 4.3 Daemon server

文件:

```text
packages/ohbaby-agent/src/runtime/daemon/server.ts
```

关键结构:

```ts
interface ClientView {
  readonly activeSessionId?: string | null;
  readonly initialPermission?: ...;
}
```

初始化:

```ts
clientViews.set(request.clientId, {
  activeSessionId: resolveStartupActiveSessionId(snapshot, intent),
  ...
});
```

snapshot 改写:

```ts
snapshotForClient(snapshot, clientViews.get(request.clientId))
```

当前缺口:

1. 没有 client view 时直接返回 backend snapshot。
2. `executeCommand` 没有按 clientId 更新 active view。
3. `submitPrompt` enqueue 后没有把实际 sessionId 写回 client view。
4. `broadcast()` 没有按 client active session 过滤 transcript/run events。
5. `snapshot.replaced` 广播时没有按 client 改写。

---

## 5. backend 与 command service

### 5.1 In-process UI adapter

文件:

```text
packages/ohbaby-agent/src/adapters/ui-inprocess.ts
```

涉及函数:

```text
createSessionFromCommand()
activateSessionForNewCommand()
submitPromptInternal()
sessions.selectSession()
```

当前全局 active 修改:

```ts
await stateStore.setActiveSessionId(input.session.id);
await stateStore.setActiveSessionId(session.id);
await stateStore.setActiveSessionId(sessionId);
```

后续关注:

1. in-process 模式是否继续使用 stateStore active session。
2. daemon 模式是否绕开共享 active session，改为 server client view。
3. `submitPromptInternal()` 是否返回实际使用 sessionId。
4. `executeCommand()` 是否返回 command side effects。

### 5.2 Command types

文件:

```text
packages/ohbaby-agent/src/commands/types.ts
```

当前:

```ts
executeCommand(invocation: UiCommandInvocation): Promise<void>;
```

可能需要:

```ts
interface ExecuteCommandResult {
  readonly selectedSessionId?: string;
  readonly createdSessionId?: string;
}
```

若修改该接口，应同步:

```text
packages/ohbaby-agent/src/commands/service.ts
packages/ohbaby-agent/src/commands/service.unit.test.ts
packages/ohbaby-agent/src/adapters/ui-persistent.ts
packages/ohbaby-agent/src/adapters/ui-inprocess.ts
packages/ohbaby-agent/src/host/core-api-factory.ts
packages/ohbaby-agent/src/runtime/daemon/client.ts
packages/ohbaby-agent/src/runtime/daemon/server.ts
packages/ohbaby-cli/src/tui/components/prompt/index.tsx
packages/ohbaby-cli/src/tui/app.tsx
```

---

## 6. TUI store 与渲染

### 6.1 Store event reducer

文件:

```text
packages/ohbaby-cli/src/tui/store/events.ts
```

当前问题:

```ts
activeSessionId: state.activeSessionId ?? event.session.id
activeSessionId: state.activeSessionId ?? event.sessionId
```

后续关注:

1. `session.updated` 不应改变 active view。
2. `message.appended` 只有在 daemon 已确认属于当前 client view 并投递到该窗口时，才可把 fresh view 绑定到该 session。
3. non-active session 的 transcript events 应在 daemon 层被过滤，不应进入无关窗口。

### 6.2 App 清屏

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

已有:

```ts
export const NEW_SESSION_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
```

已有 `/new` 清屏:

```ts
if (isNewSessionSelectionEvent(tuiEvent)) {
  writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
  setScreenGeneration((current) => current + 1);
  setActiveCommandPanel(null);
}
```

后续关注:

1. 增加 fresh startup 清屏，且只执行一次。
2. 保留 `/new` 清屏。
3. 不让普通 `/sessions` 切换触发清屏，除非明确产品决定。

---

## 7. 测试文件索引

### 7.1 daemon integration

现有:

```text
tests/integration/cli/daemon-terminal.integration.test.ts
tests/integration/cli/daemon-auto-spawn.integration.test.ts
tests/integration/cli/daemon-global-fifo.integration.test.ts
```

建议新增或扩展:

```text
tests/integration/cli/daemon-session-views.integration.test.ts
```

覆盖:

1. 默认 fresh remote client 不继承 daemon backend active session。
2. A/B 两个 remote client 切 session 不互相影响。
3. `/new` 只影响当前 client，且 fresh/null client 不复用其他窗口的空 session。
4. transcript events 不泄漏到 inactive/fresh client。

### 7.2 TUI integration

现有:

```text
tests/integration/tui/persistent-display.integration.test.tsx
```

注意:

该测试是两个独立 persistent backend client，不是 daemon remote 多窗口。后续可以保留，但不能作为 daemon 行为的唯一证明。

建议新增:

```text
tests/integration/tui/daemon-session-views.integration.test.tsx
```

如果直接渲染两个 daemon remote TUI 成本高，可以先在 CLI daemon integration 层覆盖 server/client，再在 TUI contract 层覆盖 reducer 和清屏。

### 7.3 TUI contract/unit

现有:

```text
packages/ohbaby-cli/src/tui/store/events.unit.test.ts
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

建议新增断言:

1. `session.updated` 不会从 `null` 自动设 active。
2. `message.appended` 在经过 daemon per-client 过滤后，可以从 `null` 绑定当前窗口自己的 session。
3. `snapshot.replaced` 仍会设置 active。
4. `/new` 清屏仍工作。
5. fresh startup 清屏只写一次。

### 7.4 daemon unit/integration

现有:

```text
packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts
packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts
packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts
```

建议覆盖:

1. protocol 解析 fresh/continue/resume。
2. remote client 默认会 initialize。
3. server `snapshotForClient` 对 `null` active view 生效。
4. broadcast 对 `snapshot.replaced` 做 per-client rewrite。
5. broadcast 对 transcript events 按 sessionId 过滤。

---

## 8. 包与版本

当前工作区:

```text
root package.json version: 0.1.0
packages/ohbaby-cli/package.json version: 0.1.1
packages/ohbaby-agent/package.json version: 0.1.0
packages/ohbaby-sdk/package.json version: 0.1.0
```

当前 npm:

```text
ohbaby-cli@0.1.1
  ohbaby-agent: 0.1.0
  ohbaby-sdk: 0.1.0
  ink: 6.6.0
  ink-gradient: 4.0.1
  react: 19.2.3
```

v0.1.2 建议:

```text
root: 0.1.2
ohbaby-sdk: 0.1.2
ohbaby-agent: 0.1.2
ohbaby-cli: 0.1.2
```

原因:

1. daemon protocol 很可能会变化。
2. `UiBackendClient`/`CoreAPI` 可能会新增返回值。
3. 用户只安装 `ohbaby-cli`，但实际 runtime 来自 `ohbaby-agent`，版本不一致会增加定位成本。

---

## 9. 预计修改文件清单

高概率修改:

```text
packages/ohbaby-agent/src/runtime/daemon/protocol.ts
packages/ohbaby-agent/src/runtime/daemon/client.ts
packages/ohbaby-agent/src/runtime/daemon/server.ts
packages/ohbaby-agent/src/host/core-api-factory.ts
packages/ohbaby-agent/src/commands/types.ts
packages/ohbaby-agent/src/commands/service.ts
packages/ohbaby-agent/src/adapters/ui-inprocess.ts
packages/ohbaby-agent/src/adapters/ui-persistent.ts
packages/ohbaby-cli/src/tui/store/events.ts
packages/ohbaby-cli/src/tui/app.tsx
packages/ohbaby-cli/src/cli/commands/terminal.ts
package.json
packages/ohbaby-sdk/package.json
packages/ohbaby-agent/package.json
packages/ohbaby-cli/package.json
pnpm-lock.yaml
```

高概率新增测试:

```text
tests/integration/cli/daemon-session-views.integration.test.ts
packages/ohbaby-cli/src/tui/store/events.unit.test.ts
packages/ohbaby-cli/src/tui/app.contract.test.tsx
packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts
packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts
```

可能需要修改:

```text
tests/integration/tui/persistent-display.integration.test.tsx
tests/integration/cli/daemon-terminal.integration.test.ts
tests/integration/cli/daemon-auto-spawn.integration.test.ts
tests/integration/cli/packaging-smoke.integration.test.ts
README.md
```

审查后新增必须对照的实现点:

```text
packages/ohbaby-agent/src/runtime/daemon/server.ts
- createSessionId: fresh/null view submitPrompt uses an explicit generated sessionId.
- snapshotForClient: scrubs non-active session messages and filters runs/status/permissions/context usage.
- routeEventForClient: session.updated and runtime.updated are scoped, not global.
- commandEventBelongsToClient: unowned command result events are not broadcast.
```

---

## 10. Review 时重点看什么

1. 是否还有任何 daemon remote client 在没有 client view 的情况下读取 backend active session。
2. 是否还有 `session.updated` 这类全局 metadata 事件导致隐式 adopt。
3. `snapshot.replaced` 是否在广播前 per-client rewrite。
4. `message.*`/`run.*` 是否不会进入非 active client。
5. `/new`、`/sessions`、`/resume` 是否只改变当前 client；fresh/null client 的 `/new` 是否跳过跨窗口空 session 复用。
6. in-process 模式是否仍能正常创建/恢复 session。
7. package 版本和 npm pack 依赖是否一致。
