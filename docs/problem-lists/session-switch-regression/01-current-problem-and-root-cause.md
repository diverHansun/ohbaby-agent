# 01 - /sessions 会话切换回归：现有问题与根因

> 创建日期: 2026-06-15
> 当前基线: `fix/v0.1.3-daemon-port-title` / `3ed8fec1`
> 状态: 根因已确认；修复采用 TUI selected-session snapshot refresh 路线

## 1. 用户可见问题

当前回归集中在已有会话恢复路径:

1. 在 `pnpm start` 或已安装的 `ohbaby` 中执行 `/sessions`。
2. 选择一个已有历史消息的 session 并按 Enter。
3. TUI 没有恢复该 session 的历史消息，而是重新显示大 logo 和空 prompt。

期望行为:

- 默认 fresh 启动和 `/new` 才显示大 logo。
- `/sessions` 选择已有 session 后应恢复该 session 的 transcript。
- `/resume <session-id>` 也应恢复目标 session，而不是显示空会话页面。

## 2. 已确认现象

最小事件序列可以复现 store 层状态:

```powershell
pnpm exec tsx -e "import { createStateFromSnapshot, applyTuiEvent } from './packages/ohbaby-cli/src/tui/store/events.ts'; const t='2026-06-14T00:00:00.000Z'; const msg=(id,text)=>({id,createdAt:t,role:'user',parts:[{type:'text',text}]}); const snapshot={activeSessionId:'session_1',permissions:[],runs:[],status:{kind:'idle'},sessions:[{id:'session_1',title:'One',createdAt:t,updatedAt:t,messages:[msg('m1','old visible')]},{id:'session_2',title:'Two',createdAt:t,updatedAt:t,messages:[]}]}; let state=createStateFromSnapshot(snapshot); state=applyTuiEvent(state,{type:'snapshot.replaced', snapshot}); state=applyTuiEvent(state,{type:'command.result.delivered', commandRunId:'command_1', clientInvocationId:'inv_1', timestamp:1, action:{kind:'session.selected', data:{choiceId:'session_2'}}}); console.log(JSON.stringify({activeSessionId:state.activeSessionId,messages:state.messages,committedItems:state.committedItems}, null, 2));"
```

输出:

```json
{
  "activeSessionId": "session_2",
  "messages": [],
  "committedItems": []
}
```

这说明最终 active session 已经切到 `session_2`，但目标 session 的消息集合为空。TUI 的 header 判断 `state.messages.length === 0`，因此会显示空会话 logo。

## 3. 相关代码链路

### 3.1 `/sessions` 命令先切换后发 action

`packages/ohbaby-agent/src/commands/builtin.ts:382`

```ts
await options.sessions?.selectSession?.(response.choiceId);
context.emitAction(
  action("session.selected", { choiceId: response.choiceId }),
);
```

`/resume` 也类似:

`packages/ohbaby-agent/src/commands/builtin.ts:439`

```ts
await options.sessions.selectSession(sessionId);
context.emitOutput(dataOutput("session.current", { sessionId }));
context.emitAction(action("session.selected", { choiceId: sessionId }));
```

### 3.2 `selectSession` 会立即发布 snapshot

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:1341`

```ts
async selectSession(sessionId: string): Promise<void> {
  await assertCanUseAsPrimarySession(sessionId);
  const session = await stateStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  await stateStore.setActiveSessionId(sessionId);
  await publishSnapshotReplacement();
}
```

因此 daemon 收到事件的实际顺序是:

```text
snapshot.replaced      // global activeSessionId 已经变成目标 session
command.result.delivered(session.selected)
```

### 3.3 daemon 会按旧 client view 过滤 snapshot

`packages/ohbaby-agent/src/runtime/daemon/server.ts:325`

```ts
function snapshotForClient(
  snapshot: UiSnapshot,
  view: ClientView | undefined,
): UiSnapshot {
  if (!view) {
    return snapshot;
  }
  const activeSessionId = view.activeSessionId;
  return {
    ...snapshot,
    ...(activeSessionId === undefined
      ? {}
      : {
          activeSessionId,
          sessions: snapshot.sessions.map((session) =>
            session.id === activeSessionId
              ? session
              : { ...session, messages: [] },
          ),
        }),
  };
}
```

当 `/sessions` 选择 `session_2` 时，daemon 中该窗口的 `ClientView.activeSessionId` 仍是 `session_1`。所以这次 `snapshot.replaced` 会被过滤为:

```text
snapshot.activeSessionId = session_1
session_1.messages = kept
session_2.messages = []
```

这一步本身是为多窗口隔离设计的，不能简单删除，否则会把其他窗口的 session transcript 泄露给当前窗口。

### 3.4 client view 的更新晚了一步

`packages/ohbaby-agent/src/runtime/daemon/server.ts:804`

```ts
case "command.result.delivered": {
  const owner = this.commandOwnerForEvent(event);
  const selectedSessionId = selectedSessionIdFromCommandAction(event.action);
  if (owner !== undefined && selectedSessionId !== undefined) {
    this.setClientActiveSession(owner, selectedSessionId);
  }
  return;
}
```

daemon 只有在收到 `command.result.delivered(session.selected)` 后，才把该 client 的 view 切到目标 session。可此时目标 session 的 snapshot 已经按旧 view 过滤并发送出去了。

### 3.5 TUI store 只切 active id，不会自动补拉历史

`packages/ohbaby-cli/src/tui/store/events.ts:239`

```ts
case "command.result.delivered": {
  const selectedSessionId = selectedSessionIdFromCommandAction(event.action);
  const next =
    selectedSessionId === undefined
      ? clearCommandRuntime(state, event.commandRunId)
      : clearCommandRuntime(
          rebuildFromCollections(state, {
            activeSessionId: selectedSessionId,
          }),
          event.commandRunId,
        );
  return next;
}
```

`rebuildFromCollections` 会从当前 `sessions` 集合中取目标 session 的 messages。由于 daemon 前一条 snapshot 已经把目标 session messages 清空，最终 `state.messages` 为空。

## 4. 为什么现有测试没有抓住

已执行:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --passWithNoTests
```

结果:

```text
2 files passed, 88 tests passed
```

测试空洞:

1. `packages/ohbaby-cli/src/tui/store/events.unit.test.ts:387` 只覆盖“目标 session 已经缓存完整 transcript”的场景。
2. `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` 覆盖 in-process backend，没有经过 daemon `snapshotForClient` 过滤。
3. `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts` 覆盖多窗口隔离和 startup resume，但没有覆盖“`snapshot.replaced` 先按旧 view 过滤，随后 `session.selected` 才更新 view”的完整事件序列。

## 5. 根因结论

这是 v0.1.2 多窗口 session view 隔离修复后的事件顺序回归:

```text
/sessions or /resume
  -> backend selectSession()
  -> publish snapshot.replaced
  -> daemon filters snapshot by old ClientView.activeSessionId
  -> target session messages are stripped
  -> command.result.delivered(session.selected)
  -> daemon updates ClientView.activeSessionId
  -> TUI switches active id but has no target transcript
  -> state.messages.length === 0
  -> logo is rendered
```

不能通过移除 snapshot 过滤解决，因为过滤是多窗口隔离的核心防线。修复应保证“当前窗口切到目标 session 后，能拿到按新 client view 过滤后的 snapshot”。
