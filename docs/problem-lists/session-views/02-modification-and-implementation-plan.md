# 02 - Session Views 修改与实施计划

> 创建日期: 2026-06-14
> 状态: 草案，待审阅
> 原则: 先用测试复现 daemon 多窗口问题，再按最小行为边界修复

---

## 1. 目标

本计划修复 daemon 模式下 TUI 多窗口 session view 共享的问题，使每个 PowerShell/terminal 窗口拥有独立的 active session view。

目标行为:

1. 默认 `ohbaby` 创建 fresh client view，不恢复上一个窗口的 active session。
2. `ohbaby --continue` 明确恢复当前 project 的最新 session。
3. `ohbaby --resume <session-id>` 明确恢复指定 session。
4. `/new` 只切换当前窗口到新 session，不影响其他窗口。
   - 对 fresh/null client view，`/new` 必须跳过跨窗口的空 session 复用，避免 B 窗口复用 A 窗口刚创建的空 session。
5. `/sessions` 和 `/resume` 只切换当前窗口。
6. 其他窗口可以看到 session list 更新，但不会自动显示别人的 transcript。
7. fresh startup 和 `/new` 进入干净的大 logo 首屏。

---

## 2. 非目标

本次不处理:

1. session browser 的 UI 重做。
2. session retention、删除、搜索策略。
3. worktree 自动创建。
4. daemon supervisor 生命周期重构。
5. 后台任务、remote attach、web/app 适配。

这些内容可以在 session view 隔离稳定后再规划。

---

## 3. 推荐方案

推荐方案: **daemon client view 作为 active session 的唯一来源**。

核心思路:

```text
持久化层:
  保存所有 sessions/messages/runs

daemon backend:
  执行 prompt、命令、工具、模型请求

daemon server clientViews:
  保存每个 connected client 的 activeSessionId

TUI store:
  只渲染当前 client view
  不从 session.updated 推断 active session
  经过 daemon 过滤后送达的 message.appended 可作为当前 client 的归属信号
```

设计边界:

```text
session exists      -> 全局事实，可被所有窗口看到
active session view -> client-local 事实，只属于当前窗口
```

---

## 4. 分阶段实施

### Phase 1: 让默认 daemon client 注册 fresh view

现状:

```text
default ohbaby
  -> startupIntent = undefined
  -> RemoteDaemonClient.ensureInitialized() return
  -> no client view
```

修改方向:

1. 将默认启动表达为显式 fresh intent。
2. `RemoteDaemonClient.ensureInitialized()` 对 fresh intent 也调用 `initializeClient`。
3. `resolveStartupActiveSessionId()` 对 fresh intent 返回 `null`。

建议协议形态:

```ts
export type DaemonStartupSessionMode =
  | { readonly type: "fresh" }
  | { readonly type: "continue" };

export interface DaemonStartupIntent {
  readonly startupSessionMode?: DaemonStartupSessionMode;
  readonly resumeSessionId?: string;
  readonly initialPermission?: {
    readonly level: PermissionLevel;
    readonly mode: PermissionMode;
  };
}
```

`startupIntentFromOptions()` 建议默认返回:

```ts
{
  startupSessionMode: { type: "fresh" }
}
```

如果 `--continue`:

```ts
{
  startupSessionMode: { type: "continue" }
}
```

如果 `--resume session_x`:

```ts
{
  resumeSessionId: "session_x"
}
```

注意: `resumeSessionId` 和 `startupSessionMode.type === "continue"` 仍应互斥。

---

### Phase 2: server 端维护 client-scoped active session

现状:

```ts
case "executeCommand":
  return backend.executeCommand(invocation);
```

问题:

`backend.executeCommand()` 内部会调用共享 `stateStore.setActiveSessionId()`，导致其他窗口也被影响。

修改方向:

1. `clientViews` 存储每个 client 的 `activeSessionId`。
2. server 包装 session-changing operations，并把结果应用到当前 `clientId`。
3. 对 backend 的共享 active session 使用要降到最低，最终让它只服务 in-process 或兼容路径。

推荐拆分:

```text
executeCommand(invocation, clientId)
  -> backend.executeCommand(invocation)
  -> inspect command.result.delivered/action
  -> if action.kind === "session.selected":
       clientViews[clientId].activeSessionId = selectedSessionId
       send client-scoped snapshot to this client
```

如果发现现有 `executeCommand()` 没有足够结果可供 server 判断，则有两条可选路线:

#### 路线 A: 扩展 UiBackendClient.executeCommand 返回值

```ts
interface ExecuteCommandResult {
  readonly selectedSessionId?: string;
  readonly createdSessionId?: string;
}
```

优点:

- 类型明确。
- server 不需要解析事件。

代价:

- 涉及 `ohbaby-sdk`/agent/cli 类型面，需要同步 bump。
- 需要补所有实现与测试。

#### 路线 B: 让 command action 成为 server 可观察事件

server 监听 `command.result.delivered`，如果该 event 属于当前 request，就更新当前 client view。

优点:

- 对现有命令服务侵入小。

代价:

- 需要事件关联 request/client，否则可能误把别的 client 的 command result 吃进来。
- 并发命令时更容易出错。

推荐路线 A。它更像公共协议修复，虽然改动稍大，但更容易测试和维护。

---

### Phase 3: prompt submit 后绑定当前 client view

现状:

`submitPrompt` 会根据 options 或 backend active session 创建/复用 session。

daemon server 已有:

```ts
const submitOptions = optionsForClientSubmit(
  options,
  clientViews.get(request.clientId),
);
```

但 enqueue 后没有把实际使用的 session 写回 `clientViews[clientId]`。

修改方向:

1. 当 client view active = null，提交第一条 prompt 时，应为当前 client 创建/选择 session。
2. prompt controller 返回实际使用的 `sessionId`。
3. daemon server 将 `clientViews[clientId].activeSessionId` 更新为该 `sessionId`。

推荐结果:

```ts
interface SubmitPromptResult {
  readonly sessionId: string;
}
```

如果公共接口暂时不想改返回值，可以在 prompt 队列项中记录 `clientId`，由 backend 发布一个 client-owned session selection event。但这会把事件关联复杂度提前引入，不如返回结果直接。

---

### Phase 4: 事件广播按 view 过滤或改写

事件可以分成三类:

| 事件类型 | 是否广播给所有 client | 是否改变 active view |
|---|---:|---:|
| `session.updated` | 是 | 否 |
| `snapshot.replaced` | 是，但必须按 client 改写 | 是，以 client view 为准 |
| `message.*` / `run.*` / `part.*` | 只发给该 session 的 active/owner clients | 否 |
| permission events | 维持现有 PermissionRouter | 由 PermissionRouter 决定 |

推荐规则:

```text
session.updated:
  - 所有窗口都可以知道 session metadata/list 更新
  - TUI reducer 不得因为它自动 active

message.appended/message.updated/message.part.delta/run.updated:
  - 只发给 activeSessionId === event.sessionId 的 client
  - 或在 TUI reducer 里忽略非 active session 的 transcript event

snapshot.replaced:
  - server 发送前调用 snapshotForClient(snapshot, clientViews[clientId])
```

建议优先 server 端过滤 transcript 事件，TUI 端再加防线。原因是无关 transcript 不应该进入 fresh 窗口的本地状态。

---

### Phase 5: TUI reducer 停止隐式 adopt active session

现状:

```ts
activeSessionId: state.activeSessionId ?? event.session.id
activeSessionId: state.activeSessionId ?? event.sessionId
```

修改方向:

1. `session.updated` 只更新 collection，不改变 active session。
2. `message.appended` 只应在 daemon 已过滤并投递到当前 client 时进入 TUI；如果当前 view 仍为 `null`，可将该 transcript event 作为当前 client 的 first-owned session 绑定依据。
3. 如果某个 session 只是通过 `session.updated` 出现在列表里，fresh view 不显示它的 transcript。
4. active session 只通过以下方式改变:
   - startup snapshot
   - client-scoped `snapshot.replaced`
   - explicit `session.selected` result
   - current client submit prompt 后由 daemon 投递到该 client 的首个 transcript event

示意:

```ts
case "session.updated":
  return rebuildFromCollections(state, {
    activeSessionId: state.activeSessionId,
    sessions: upsertById(state.sessions, event.session),
  });
```

---

### Phase 6: fresh startup 清屏

现有 `/new` 已有:

```ts
export const NEW_SESSION_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
```

建议引入启动选项:

```ts
interface TerminalUiOptions {
  readonly clearOnStart?: boolean;
}
```

CLI 默认 fresh startup:

```ts
OhbabyTerminalApp clearOnStart={resume === undefined && args.continue !== true}
```

或者更明确:

```ts
const isFreshStartup = resume === undefined && args.continue !== true;
```

TUI 首次 render 前写入:

```ts
if (clearOnStart) {
  writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
}
```

注意:

1. 只执行一次，避免 Ink rerender 时重复清屏。
2. `/new` 仍保留现有清屏逻辑。
3. 若后续希望 `--resume` 也清屏，应单独加入配置或 CLI flag，不在本次扩大范围。

---

### Phase 7: 版本同步与发布

因为修复可能改到 daemon protocol 和 SDK 类型，建议统一 bump:

```text
root package.json: 0.1.2
packages/ohbaby-sdk/package.json: 0.1.2
packages/ohbaby-agent/package.json: 0.1.2
packages/ohbaby-cli/package.json: 0.1.2
```

发布依赖应从 workspace 解析为:

```json
{
  "ohbaby-agent": "0.1.2",
  "ohbaby-sdk": "0.1.2"
}
```

发布顺序:

```text
1. ohbaby-sdk@0.1.2
2. ohbaby-agent@0.1.2
3. ohbaby-cli@0.1.2
```

如果最终没有改 SDK public types，可以讨论是否保留 `ohbaby-sdk@0.1.0`。但当前建议同步到 `0.1.2`，降低 MVP 阶段的包组合认知成本。

---

## 5. 备选方案

### 方案 B: 启动时强制 in-process

让默认 `ohbaby` 不用 daemon，回到每个窗口独立 backend。

优点:

- 变更少。
- 多窗口天然隔离。

缺点:

- 放弃 daemon 重构的价值。
- prompt FIFO、后台共享能力、未来 web/app 适配都会受影响。
- 不是修复根因。

不推荐。

### 方案 C: 保留共享 backend active，只在 TUI 层忽略事件

优点:

- 改动集中在 CLI TUI。

缺点:

- `getSnapshot()` 仍可能返回错误 active session。
- `/new`、`/sessions` 仍修改全局状态。
- 多窗口切换问题只被局部遮住。

不推荐。

---

## 6. 推荐实施顺序

1. 写 daemon 默认 fresh view 的失败测试。
2. 写 daemon 事件广播不会激活 fresh client 的失败测试。
3. 写 `/new` 和 `/sessions` 只影响当前 client 的失败测试。
4. 写 fresh startup 清屏测试。
5. 扩展 protocol/types。
6. 修改 `startupIntentFromOptions()` 和 `RemoteDaemonClient.ensureInitialized()`。
7. 修改 daemon server `clientViews` 与 event routing。
8. 修改 backend command/prompt 返回值或 client-owned action。
9. 修改 TUI reducer，移除隐式 active adoption。
10. 修改 TUI startup 清屏。
11. 更新版本号和 packaging smoke。
12. 本地验证、npm pack 验证、全局安装验证。

---

## 7. 实施风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| SDK 类型扩散 | `submitPrompt`/`executeCommand` 返回值变化可能影响多处实现 | 先设计最小返回类型，并统一 bump |
| prompt queue 并发 | daemon prompt queue 当前按队列执行，clientId/sessionId 需要关联 | 在 queue item 中保留 clientId，并用测试覆盖 |
| 事件过滤过度 | 过滤 transcript 事件后，session list 仍需更新 | `session.updated` 继续广播，message/run 过滤 |
| in-process 回归 | in-process 仍需要自动激活本窗口 session | reducer 改动要配合 explicit selection/result，不能只靠事件 |
| 清屏重复 | Ink rerender 可能重复执行 effect | 用 `useRef` 或初始化阶段保证 only once |

---

## 8. 完成定义

完成后必须满足:

```text
Window A: ohbaby -> prompt "A"
Window B: ohbaby -> fresh blank, 不显示 A
Window A: /new -> A 显示新空 session
Window B: 仍保持自己的空/当前 session
Window B: /new -> B 获得另一个新空 session，不复用 A 的空 session
Window B: /sessions -> select old session
Window A: 不跟随 B
```

并且:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:integration
npm pack packages/ohbaby-cli
npm install -g <packed-ohbaby-cli.tgz>
ohbaby --version
ohbaby
```

真实安装验证必须在 Windows PowerShell/Windows Terminal 至少打开两个 tab 手动确认。
