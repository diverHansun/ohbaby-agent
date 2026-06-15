# 02 - /sessions 会话切换回归：修复方案与实施计划

> 创建日期: 2026-06-15
> 目标: 修复已有 session 切换后空白/logo 回归，同时保留多窗口隔离
> 当前实施: 采用方案 B，在 TUI 收到已有 session selection 后主动刷新当前 client view snapshot

## 1. 修复原则

必须同时满足:

1. 不放宽 daemon 的 client-scoped session view 隔离。
2. `/sessions` 选择已有 session 后恢复历史 transcript。
3. `/resume <session-id>` 恢复历史 transcript。
4. `/new` 和默认 fresh startup 保持干净大 logo 页面。
5. 多窗口互不跟随切换: A 窗口切 session 不影响 B 窗口 active session。

## 2. 不建议的修复

### 2.1 不要保留所有 inactive session messages

不要把 `snapshotForClient()` 改成给每个 client 返回所有 session 的 messages。

原因:

- 会破坏 v0.1.2 的多窗口隔离。
- A 窗口可能收到 B 窗口正在工作的 transcript。
- permission、runtime、run 状态也需要按 client view 过滤，不能只修 messages。

### 2.2 不要只改 Header 的 logo 判断

把 `state.messages.length === 0` 改成其他条件只能隐藏症状。真正问题是目标 session transcript 没有进入 store。

## 3. 可选方案 A：调整命令事件顺序

思路:

```text
/sessions validated choice
  -> emit command.result.delivered(session.selected)
  -> daemon updates ClientView.activeSessionId
  -> backend selectSession()
  -> publish snapshot.replaced
  -> daemon filters snapshot by new ClientView
  -> target session transcript is visible
```

优点:

- 事件顺序更符合“先声明当前 client 选择，再发布目标 snapshot”。
- daemon 端不需要额外 RPC。

风险:

- `/resume` 的 session id 需要先验证再 emit action，否则可能先把 UI 切到一个无效 session。
- `context.emitAction()` 当前会立即发布 `command.result.delivered`，不是命令结束后统一发布。调整顺序会改变 command service 的事件语义。
- 如果 `selectSession()` 在 action 已发出后失败，会出现 UI 已切换但后端切换失败的短暂不一致。

适用方式:

- 对 `/sessions` 可以在选择项已验证后先 emit action，再 `selectSession()`。
- 对 `/resume` 建议先增加显式 validate/preflight 能力，或让 `selectSession()` 拆成 validate 和 commit 两步，再考虑重排。

## 4. 可选方案 B：TUI 在已有 session selected 后刷新 snapshot

思路:

```text
daemon current behavior:
  snapshot.replaced filtered by old ClientView
  command.result.delivered(session.selected)
  daemon updates ClientView before sending event to owner client

TUI behavior:
  receives command.result.delivered(session.selected without source="new")
  calls client.getSnapshot()
  applies snapshot.replaced from current daemon client view
```

关键点:

- `packages/ohbaby-cli/src/tui/app.tsx` 已经有初始化时的 `client.getSnapshot()` 和 `store.replaceSnapshot()` 路径。
- daemon 在广播 `command.result.delivered` 时会先执行 `updateClientViewsFromEvent()`，再把事件路由给 client。
- 因此 TUI 收到 `session.selected` 后再调用 `getSnapshot()`，拿到的是按新 `ClientView.activeSessionId` 过滤后的 snapshot。

优点:

- 修改面小，主要在 TUI 层。
- 不改变 daemon 的安全过滤逻辑。
- 不需要调整 command service 的事件顺序。
- 同时适用于 `/sessions` 和 `/resume`。

注意点:

- 只应对已有 session 切换刷新，不应对 `/new` 的 `source: "new"` 做同样处理。
- 需要避免旧请求晚到覆盖新请求，可以使用 sequence guard。
- 如果刷新失败，应显示 recoverable runtime notice 或保持当前状态，不能导致 TUI 崩溃。

建议实现方向:

```ts
function isExistingSessionSelectionEvent(tuiEvent: TuiEvent): boolean {
  if (
    tuiEvent.type !== "command.result.delivered" ||
    tuiEvent.action?.kind !== "session.selected"
  ) {
    return false;
  }
  const data = tuiEvent.action.data;
  return isStringRecord(data) && data.source !== "new";
}
```

在 `packages/ohbaby-cli/src/tui/app.tsx` 的 event subscription 中:

```ts
eventDispatcher.dispatch(tuiEvent);

if (isExistingSessionSelectionEvent(tuiEvent)) {
  const sequence = ++sessionRefreshSequenceRef.current;
  void client.getSnapshot().then((snapshot) => {
    if (!disposedRef.current && sequence === sessionRefreshSequenceRef.current) {
      store.replaceSnapshot(snapshot);
    }
  });
}
```

也可以在执行顺序上先触发刷新再 dispatch，但需要小心 command runtime 清理、command panel 收尾和 coalescer 的事件顺序。首版建议采用“dispatch 后刷新”，并用 regression test 锁定最终状态。

## 5. 可选方案 C：daemon 支持 session selected 后补发 snapshot

思路:

daemon 在 `command.result.delivered(session.selected)` 更新 client view 后，对该 client 发送一次按新 view 过滤后的 `snapshot.replaced`。

优点:

- TUI 不需要主动 RPC。
- 事件模型更偏“server pushes the selected view”。

风险:

- daemon 需要在 `broadcast()` 内或之后异步读取 backend snapshot，并向单个 SSE client 发送事件。
- 需要处理目标 client 已断开、command owner 清理、permission router 过滤等边界。
- 实现复杂度高于方案 B。

## 6. 推荐路线

推荐先采用方案 B:

1. 先补失败测试，复现 daemon-filtered snapshot + selected action 后缺失 transcript。
2. 在 TUI event subscription 中识别非 `/new` 的 `session.selected`。
3. 对该事件触发一次 `client.getSnapshot()`。
4. 用 sequence guard 防止旧刷新覆盖新刷新。
5. 保留 `/new` 的 `NEW_SESSION_CLEAR_SEQUENCE` 行为，不给 `/new` 做历史 snapshot 刷新。
6. 后续再评估是否把事件顺序整理为方案 A，作为架构清理项。

## 7. 实施步骤

### Step 1 - 增加 regression test

先写一个失败用例，描述当前缺陷:

- 输入: 旧 client view 过滤后的 snapshot，目标 session messages 为空。
- 事件: `command.result.delivered(session.selected choiceId=session_2)`。
- 期望: 最终 TUI 通过刷新 snapshot 恢复 `session_2` messages。

### Step 2 - TUI event refresh

新增 helper:

- `isExistingSessionSelectionEvent()`
- `sessionRefreshSequenceRef`
- `refreshSnapshotForSelectedSession()` 或内联 callback

### Step 3 - 不改变 `/new`

保留:

- `isNewSessionSelectionEvent()`
- `NEW_SESSION_CLEAR_SEQUENCE`
- 大 logo 只由真实空会话触发

### Step 4 - 回归测试

跑针对测试和全量关键检查:

```powershell
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --passWithNoTests
pnpm run typecheck
pnpm run lint
```

### Step 5 - 手工验收

至少在 pnpm 本地模式验证:

```powershell
pnpm start
```

手工操作:

1. 创建一个会话并发送消息。
2. `/new` 创建新会话，确认显示 logo。
3. `/sessions` 切回旧会话，确认历史消息恢复。
4. 新开第二个 PowerShell 窗口运行 `pnpm start`，确认默认 fresh，不跟随第一个窗口。
5. 两个窗口分别 `/sessions` 切不同会话，确认互不影响。
