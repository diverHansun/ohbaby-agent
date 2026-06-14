# 01 - Session Views 现有问题与代码分析

> 创建日期: 2026-06-14
> 状态: 草案，待审阅
> 目标版本建议: v0.1.2

---

## 1. 背景

`ohbaby-cli@0.1.1` 已经修复 npm 安装后的 Ink/React 渲染依赖漂移问题，但在真实 npm 全局安装后，用户又发现 daemon 模式下的 session 视图隔离存在问题:

1. 在同一个 project root 下打开第二个 PowerShell 窗口并运行 `ohbaby`，当前行为会恢复或跟随上一个窗口的 session。
2. 在一个窗口里切换 session 后，其他 PowerShell 窗口也会跟着切换，无法做到多窗口并行。
3. 默认 `ohbaby` 进入一个 fresh session，或在 TUI 内执行 `/new` 后，用户期望看到干净的大 logo 首屏，不应保留之前 PowerShell 中的执行历史。

这些问题不是 npm 发布机制本身造成的。v0.1.1 固定了 TUI renderer 依赖，但 session 视图问题来自 daemon 重构后遗留的共享状态与事件广播边界。

---

## 2. 期望行为

### 2.1 默认启动

`ohbaby` 默认行为应是:

```text
same project root + new terminal window + ohbaby
  -> fresh client view
  -> activeSessionId = null
  -> 显示 Ohbaby 大 logo 和空 prompt
  -> 不自动恢复其他窗口的 session
```

只有显式恢复入口才应恢复历史:

```bash
ohbaby --continue
ohbaby --resume <session-id>
```

### 2.2 多窗口隔离

同一个 daemon 进程可以服务多个 TUI 窗口，但每个窗口的 `activeSessionId` 必须是 client-scoped:

```text
Window A active = session_A
Window B active = session_B

Window A /sessions -> select session_C
  -> Window A active = session_C
  -> Window B active 仍然 = session_B
```

### 2.3 新 session 清屏

默认 fresh 启动和 `/new` 都应进入一个干净页面:

```text
clear terminal screen
render Ohbaby logo
render empty prompt box
render status bar for the current fresh session view
```

`--continue` 和 `--resume` 是否清屏可以单独决定。当前建议是不默认清屏，因为用户显式恢复历史时通常希望看到上下文；如果产品希望所有 TUI 启动都沉浸式清屏，可以在计划中扩展为配置项。

---

## 3. 现有启动链路

CLI 入口在 `packages/ohbaby-cli/src/cli/commands/terminal.ts`:

```ts
const host = await runtime.buildCoreAPI({
  ...(args.continue === true ? { continue: true } : {}),
  ...(useInProcess
    ? { daemon: false, inProcess: true }
    : { daemon: true }),
  ...(resume === undefined ? {} : { resume }),
});
```

当前默认 `ohbaby` 会使用 daemon:

```text
ohbaby
  -> createTerminalCommand()
  -> buildCoreAPI({ daemon: true })
  -> buildCoreAPIImpl()
  -> ensureDaemonRunning()
  -> createRemoteCoreApiHost()
  -> RemoteDaemonClient
```

只有 `--continue` 或 `--resume` 被传入时，入口才会在渲染前拉一次 snapshot:

```ts
if (resume !== undefined || args.continue === true) {
  await host.core.getSnapshot();
}
```

这说明默认启动没有明确表达“fresh client view”，也没有触发 daemon client 初始化。

---

## 4. 根因一: 默认启动没有注册 client view

`packages/ohbaby-agent/src/host/core-api-factory.ts`:

```ts
function startupIntentFromOptions(
  options: CoreApiFactoryOptions,
): DaemonStartupIntent | undefined {
  const intent: DaemonStartupIntent = {
    ...(options.continue === true
      ? { startupSessionMode: { type: "continue" as const } }
      : {}),
    ...(options.resume === undefined ? {} : { resumeSessionId: options.resume }),
    ...(!options.mode && !options.permission
      ? {}
      : {
          initialPermission: {
            level: options.permission ?? "default",
            mode: options.mode ?? "auto",
          },
        }),
  };
  return Object.keys(intent).length === 0 ? undefined : intent;
}
```

当默认 `ohbaby` 不带 `--continue`、`--resume`、`--mode`、`--permission` 时，`startupIntent` 是 `undefined`。

`packages/ohbaby-agent/src/runtime/daemon/client.ts`:

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

因此默认启动不会调用 daemon server 的 `initializeClient`。没有 `initializeClient`，server 端 `clientViews` 就没有这个窗口的记录。

---

## 5. 根因二: 没有 client view 时回落到 daemon 后端全局 active session

`packages/ohbaby-agent/src/runtime/daemon/server.ts`:

```ts
case "getSnapshot": {
  const snapshot = await backend.getSnapshot();
  return permissionRouter.filterSnapshotForClient(
    snapshotForClient(snapshot, clientViews.get(request.clientId)),
    request.clientId,
  );
}
```

`snapshotForClient()` 只有在 view 存在时才覆盖 `activeSessionId`:

```ts
function snapshotForClient(
  snapshot: UiSnapshot,
  view: ClientView | undefined,
): UiSnapshot {
  if (!view) {
    return snapshot;
  }
  return {
    ...snapshot,
    ...(view.activeSessionId === undefined
      ? {}
      : { activeSessionId: view.activeSessionId }),
    ...
  };
}
```

默认 fresh 窗口没有 client view，所以拿到的是共享 backend snapshot。daemon server 只创建一个 backend:

```text
startDaemonServer()
  -> createPersistentUiBackendClient()
  -> createDaemonHttpServer({ backend })
```

这个 backend 内部的 `stateStore.activeSessionId` 是进程内共享变量。结果是:

```text
Window A 创建 session_A
  -> backend.activeSessionId = session_A

Window B 默认 ohbaby
  -> no client view
  -> getSnapshot() 返回 backend.activeSessionId
  -> Window B 显示 session_A
```

---

## 6. 根因三: /new、/sessions、/resume 修改共享 backend active session

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的 `/new` 路径:

```ts
async function activateSessionForNewCommand(input: {
  readonly publishUpdate: boolean;
  readonly session: UiSession;
}): Promise<CommandSessionSummary> {
  sessionIds.reserve(input.session.id);
  await upsertSession(input.session);
  await stateStore.setActiveSessionId(input.session.id);
  ...
  await publishSnapshotReplacement();
}
```

新建 session 时也会修改共享 active:

```ts
sessionIds.reserve(session.id);
await upsertSession(session);
await stateStore.setActiveSessionId(session.id);
publish({ type: "session.updated", session: cloneSession(session) });
await publishSnapshotReplacement();
```

`/sessions` 和 `/resume` 选择 session 时:

```ts
sessions: {
  createSession: createSessionFromCommand,
  listSessions: listSessionsFromState,
  async selectSession(sessionId: string): Promise<void> {
    await assertCanUseAsPrimarySession(sessionId);
    const session = await stateStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await stateStore.setActiveSessionId(sessionId);
    await publishSnapshotReplacement();
  },
},
```

这些命令当前是在共享 backend 上执行的。daemon server 对 `executeCommand` 也只是直接转发:

```ts
case "executeCommand":
  return backend.executeCommand(
    request.params[0] as Parameters<UiBackendClient["executeCommand"]>[0],
  );
```

所以一个窗口执行 `/new` 或切换 session，会改变 daemon backend 的全局 `activeSessionId`。

---

## 7. 根因四: 事件广播没有按 client view 过滤或改写

daemon server 当前广播全部非权限事件:

```ts
private broadcast(event: UiEvent): void {
  this.options.permissionRouter.observeEvent(event);
  for (const client of Array.from(this.clients)) {
    const filtered = this.options.permissionRouter.filterEventForClient(
      event,
      client.clientId,
    );
    if (filtered) {
      writeSse(client.response, { event: filtered, type: "ui.event" });
    }
  }
}
```

权限事件通过 `PermissionRouter` 做了 client 过滤，但普通 session/message/run 事件没有按 `activeSessionId` 做隔离。

这会导致:

```text
Window A 创建 session_A
  -> daemon broadcast session.updated(session_A)
  -> Window B 也收到 session.updated(session_A)
```

---

## 8. 根因五: TUI reducer 会自动 adopt 别人的 session

`packages/ohbaby-cli/src/tui/store/events.ts`:

```ts
case "session.updated":
  return rebuildFromCollections(state, {
    activeSessionId: state.activeSessionId ?? event.session.id,
    sessions: upsertById(state.sessions, event.session),
  });

case "message.appended": {
  const next = rebuildFromCollections(state, {
    activeSessionId: state.activeSessionId ?? event.sessionId,
    sessions: updateSessionMessages(
      state.sessions,
      event.sessionId,
      (messages) => [...messages, event.message],
    ),
  });
  ...
}
```

这段逻辑在单窗口或 in-process 模式里是方便的: 如果当前还没有 active session，收到第一条 session/message 事件就自动激活它。

但在 daemon 多窗口场景里，这会破坏 fresh 窗口:

```text
Window B activeSessionId = null
Window A broadcast session.updated(session_A)
Window B reducer:
  state.activeSessionId ?? event.session.id
  -> activeSessionId = session_A
```

所以即使 daemon server 让默认启动创建了 `clientViews[WindowB].activeSessionId = null`，只要事件继续广播给 Window B，TUI 仍会被动切到 Window A 的 session。

---

## 9. 清屏现状

`packages/ohbaby-cli/src/tui/app.tsx` 已经定义清屏序列:

```ts
export const NEW_SESSION_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
```

当前只在 `/new` 命令产生 `session.selected` 且 `source === "new"` 时清屏:

```ts
if (isNewSessionSelectionEvent(tuiEvent)) {
  writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
  setScreenGeneration((current) => current + 1);
  setActiveCommandPanel(null);
}
```

判断函数:

```ts
function isNewSessionSelectionEvent(tuiEvent: TuiEvent): boolean {
  if (
    tuiEvent.type !== "command.result.delivered" ||
    tuiEvent.action?.kind !== "session.selected"
  ) {
    return false;
  }
  const data = tuiEvent.action.data;
  return isStringRecord(data) && data.source === "new";
}
```

问题是默认 `ohbaby` fresh startup 不会触发这个 event。因此用户在 PowerShell 输入 `ohbaby` 后，TUI 会在当前屏幕继续渲染，之前的命令历史会留在上方。

---

## 10. 当前测试覆盖缺口

已有一个看起来接近的测试:

`tests/integration/tui/persistent-display.integration.test.tsx`

```ts
it("keeps a second fresh terminal blank after another terminal creates a session", async () => {
  const clientA = createPersistentUiBackendClient({ dbPath, ... });
  const clientB = createPersistentUiBackendClient({ dbPath, ... });
  ...
});
```

这个测试覆盖的是两个独立 `createPersistentUiBackendClient` 实例共享 DB 的场景。它没有通过 daemon server，也没有复现真实 npm 全局安装后的默认路径:

```text
ohbaby
  -> daemon true
  -> one daemon server
  -> one shared backend
  -> many remote clients
```

另一个已有测试:

`tests/integration/cli/daemon-terminal.integration.test.ts`

```ts
it("submits through one remote client and resumes history through another", async () => {
  ...
});
```

该测试目前强调另一个 remote client 能看到历史 session 内容，但没有断言默认 fresh client 的 `activeSessionId` 必须为 `null`，也没有断言事件不会把它自动激活。

---

## 11. 参考项目启发

### 11.1 Gemini CLI

`D:\Projects\Code-cli\gemini-cli\docs\cli\session-management.md` 的设计把“保存历史”和“恢复历史”分开:

- 默认交互自动保存历史。
- 恢复历史需要显式 `--resume` 或 TUI 内 `/resume`。
- session 是 project-scoped。
- 并行工作建议使用 Git worktrees，避免文件改动冲突。

对 Ohbaby 的启发:

```text
默认启动不等于恢复 latest session。
恢复必须来自显式用户意图。
project-scoped history 可以保留，但 active view 必须是窗口级别。
```

### 11.2 opencode

`D:\Projects\Code-cli\opencode\packages\app\src\app.tsx` 通过 `/session/:id?` 路由表达当前 session。`dialog-select-file.tsx` 里选择 session 后显式 `navigate(.../session/<id>)`，`dialog-fork.tsx` fork 后也显式导航到 forked session。

对 Ohbaby 的启发:

```text
session selection 应该是显式 view selection。
事件可以更新 session list，但不应隐式改变当前 view。
```

### 11.3 Kimi Code

`D:\Projects\Code-cli\kimi-code\packages\kaos\src\local.ts` 明确让每个 `LocalKaos` 实例持有自己的 `_cwd`，而不是改动 `process.cwd()`。它的测试也覆盖并发操作和 resume 行为。

对 Ohbaby 的启发:

```text
不要把多 client 的可变 view 状态放在 process-global/backend-global 变量里。
每个客户端需要自己的 view state。
```

### 11.4 Claude Code 本地参考仓库

`D:\Projects\Code-cli\claude-code\docs\features\daemon.md` 和 `daemon-restructure-design.md` 把 daemon supervisor、worker、attach/logs/status 的边界拆开。虽然实现形态不同，但它强调后台进程和前台 attach/view 的分离。

对 Ohbaby 的启发:

```text
daemon 可以共享运行时资源，但前台窗口 attach 到哪个 session 应该是窗口自己的状态。
```

---

## 12. 当前结论

这个问题应按 `v0.1.2` 处理，原因是:

1. `v0.1.1` 已经发布到 npm，不能修改同版本包内容。
2. 修复涉及 daemon protocol、server event routing、TUI reducer、startup UX，属于行为修复，不是 release note 修改。
3. 当前 `ohbaby-cli@0.1.1` 依赖 `ohbaby-agent@0.1.0` 和 `ohbaby-sdk@0.1.0`，如果协议或类型发生变化，应同步 bump 包版本，避免 npm 用户拿到不匹配的组合。

建议目标:

```text
ohbaby-cli@0.1.2
ohbaby-agent@0.1.2
ohbaby-sdk@0.1.2
root workspace version -> 0.1.2
```
