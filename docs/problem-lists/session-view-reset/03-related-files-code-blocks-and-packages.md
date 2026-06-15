# Session View Reset: 涉及文档、代码块与包

## 1. ohbaby 当前代码

### 1.1 TUI app 主入口

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

职责:

- 持有 `screenGeneration`。
- 持有 `clearOnStart` 一次性清屏逻辑。
- 订阅 UI event。
- 处理 `/new` 的 `session.selected`。
- 处理已有 session selection 后的 `client.getSnapshot()` refresh。
- 渲染 `AppShell`、`HeaderContainer`、`TranscriptViewportContainer`、`DialogManager`、`PromptDockContainer`。

当前关键代码块:

```ts
export const SESSION_VIEW_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
export const NEW_SESSION_CLEAR_SEQUENCE = SESSION_VIEW_CLEAR_SEQUENCE;
```

```ts
if (clearOnStart && !didClearOnStartRef.current) {
  writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
  didClearOnStartRef.current = true;
}
```

```ts
function resetTranscriptSurface(reason: TranscriptSurfaceResetReason): void {
  writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
  setScreenGeneration((current) => current + 1);
  setActiveCommandPanel(null);
}
```

```ts
type TranscriptSurfaceResetReason =
  | "new-session"
  | "switch-session";
```

```ts
eventDispatcher.dispatch(commandResultWithoutSessionSelection(tuiEvent));
// ...
resetTranscriptSurface("switch-session");
store.replaceSnapshot(snapshot);
```

注意:

- helper 第一版可以留在 `OhbabyTerminalApp` 内，因为需要访问 hook state 和 `writeStdout`。
- fresh startup 的 `clearOnStart` 当前发生在首次 render 前，不应在 render 期调用会 `setScreenGeneration()` 的 helper；它只需要共享同一 clear sequence 语义。
- fresh startup 仍调用兼容 alias `NEW_SESSION_CLEAR_SEQUENCE`，该 alias 指向 `SESSION_VIEW_CLEAR_SEQUENCE`。
- existing session switch 路径在目标 snapshot 确认前不会直接 dispatch 原始 `session.selected` action。
- 如果后续需要测试纯逻辑，可把 event classification 拆成纯函数，helper 本体仍留在组件内。

### 1.2 CLI terminal command

文件:

```text
packages/ohbaby-cli/src/cli/commands/terminal.ts
packages/ohbaby-cli/src/cli/commands/types.ts
```

职责:

- 解析启动参数。
- 设置 startup session mode。
- 将 `clearOnStart` 传给 TUI。

当前关键语义:

```ts
clearOnStart: resume === undefined && args.continue !== true
```

短期不建议修改这部分。默认 fresh startup 清屏一次的产品语义是正确的。

### 1.3 TUI render 入口

文件:

```text
packages/ohbaby-cli/src/tui/index.tsx
packages/ohbaby-cli/src/tui/index.unit.test.tsx
```

职责:

- 调用 Ink `render()`。
- 开启 `incrementalRendering: true`。

当前关键行为:

```ts
render(<OhbabyTerminalApp ... />, { incrementalRendering: true })
```

这属于防闪烁基础设施，不应回退。

### 1.4 committed transcript

文件:

```text
packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.tsx
packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.unit.test.tsx
```

职责:

- 渲染稳定历史 transcript。
- 在 Windows TTY 默认使用 Ink `<Static>`。
- 非 TTY 和测试路径默认保持动态渲染。

当前关键代码块:

```ts
const useStatic = shouldUseStaticTranscript({
  isTTY: stdout.isTTY,
});
```

```tsx
<Static items={items as TranscriptItem[]}>
  {(item): ReactElement => (
    <MessageRow ... />
  )}
</Static>
```

短期不建议修改 `shouldUseStaticTranscript()` 默认策略。修复点应在 session boundary surface reset，而不是禁用 Static。

### 1.5 transcript 分层

文件:

```text
packages/ohbaby-cli/src/tui/store/transcript.ts
packages/ohbaby-cli/src/tui/store/events.ts
```

职责:

- 从 snapshot/events 构建 `messages`、`committedItems`、`liveMessage`。
- 保持 committed item 引用稳定，减少重绘。
- 在 active session 或 snapshot 替换时重建 transcript。

需要注意的旧注释:

```text
session switch rebuilds because the viewport remounts its <Static> region
```

该注释需要修正。真实 TTY 中，viewport remount 不足以清理 terminal scrollback，必须配合 session surface reset。

### 1.6 TUI app contract tests

文件:

```text
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

当前相关测试:

- `clears screen before repainting a new session`
- `clears screen once before rendering a fresh startup frame`
- `repaints the current empty frame when /new reuses the active session`
- `does not clear screen for ordinary session selection actions`
- `refreshes the selected existing session snapshot after session selection`
- stale refresh sequence guard 相关测试

需要调整:

- 将 `does not clear screen for ordinary session selection actions` 改为 session boundary 清理测试。
- 保留 stale sequence guard。
- 新增“最后一次 clear 之后只看到目标 session 内容”的断言。

### 1.7 防闪烁 contract tests

文件:

```text
packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx
packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.flicker.contract.test.tsx
```

职责:

- 确保长 live message streaming 时不会清 scrollback。
- 确保 command panel 和 dialog 不触发大面积终端清理。

这些测试是本轮修改的安全边界。

## 2. ohbaby 相关文档

### 2.1 终端闪烁历史

路径:

```text
docs/ohbaby-cli/tui-improve-2
docs/ohbaby-cli/tui-improve-3
docs/ohbaby-cli/tui-improve-4
```

关键结论:

- improve-2: Static 可减闪，但会导致跨 session stale transcript。
- improve-3: committed/live split + Windows TTY guarded Static 修复 PowerShell 闪烁。
- improve-4: 长期需要独立 transcript viewport，不应继续在 `CommittedTranscript` 中堆局部 patch。

### 2.2 session view / daemon / backend 历史

路径:

```text
docs/problem-lists/session-views
docs/problem-lists/session-switch-regression
docs/problem-lists/sessions-ui-backend
docs/problem-lists/terminal-daemon
```

关键结论:

- daemon 多窗口 client view 隔离已经是核心产品语义。
- v0.1.3 的 session switch regression 修复解决了目标 snapshot 刷新顺序问题。
- 本轮是在该基础上补 terminal surface reset，不应重开 daemon 协议设计。

## 3. 参考项目

### 3.1 Gemini CLI: Static refresh

文件:

```text
D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\AppContainer.tsx
D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\components\MainContent.tsx
D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\hooks\useSessionResume.ts
```

已核验锚点:

- `AppContainer.tsx:666-671`
- `MainContent.tsx:310-319`
- `useSessionResume.ts` 中在 resume 后调用 `refreshStatic()`，强制 Static 重新渲染历史。

关键模式:

```ts
stdout.write(ansiEscapes.clearTerminal);
setHistoryRemountKey((prev) => prev + 1);
```

```tsx
<Static key={uiState.historyRemountKey} items={[...]}>
  {(item) => item}
</Static>
```

借鉴点:

- Static 可以继续用于性能和减少闪烁。
- 替换历史时需要 clear + remount。
- `refreshStatic` 是显式 UI action，不是散落在每个事件 handler 中的临时逻辑。

### 3.2 Kimi Code: session switch lifecycle

文件:

```text
D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\kimi-tui.ts
D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\actions\replay-ops.ts
```

已核验锚点:

- `kimi-tui.ts:2069-2085`
- `kimi-tui.ts:3522-3533`
- `replay-ops.ts` 暴露 `hydrateTranscriptFromReplay()`，负责从 replay 数据恢复目标 session transcript。

关键模式:

```ts
this.resetSessionRuntime();
await this.setSession(session);
await this.syncRuntimeState(session);
this.clearTranscriptAndRedraw();
await hydrateTranscriptFromReplay(...);
```

借鉴点:

- 切 session 是一个完整 lifecycle。
- 要先处理 runtime、live text、tool UI、spinner。
- 清空当前 transcript surface 后，再 hydrate/replay 目标 session。

### 3.3 Claude Code: virtual list / alternate screen

文件:

```text
D:\Projects\Code-cli\claude-code\src\components\Messages.tsx
D:\Projects\Code-cli\claude-code\src\components\VirtualMessageList.tsx
D:\Projects\Code-cli\claude-code\src\screens\REPL.tsx
D:\Projects\Code-cli\claude-code\packages\@ant\ink\src\core\clearTerminal.ts
```

已核验锚点:

- `Messages.tsx:794-797`
- `Messages.tsx:957-962`
- `REPL.tsx` 中维护 `conversationId`，切换/清理对话时 bump identity。
- `packages\@ant\ink\src\core\clearTerminal.ts:74`

关键模式:

```ts
const messageKey = useCallback(
  (msg: RenderableMessage) => `${msg.uuid}-${conversationId}`,
  [conversationId],
);
```

```tsx
<VirtualMessageList
  messages={renderableMessages}
  itemKey={messageKey}
  ...
/>
```

借鉴点:

- 长期应让应用拥有 viewport，而不是完全依赖 terminal scrollback。
- conversation/session id 应进入 message key，避免跨会话复用错误。
- clear terminal 是基础设施能力，而不是临时字符串。

### 3.4 opencode: route-scoped session viewport

文件:

```text
D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\routes\session\index.tsx
D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\component\dialog-session-list.tsx
```

已核验锚点:

- `routes\session\index.tsx:129-136`
- `routes\session\index.tsx:1058-1066`
- `dialog-session-list.tsx` 负责 session 列表选择入口。

关键模式:

```ts
const session = createMemo(() => sync.session.get(route.sessionID));
const messages = createMemo(() => sync.data.message[route.sessionID] ?? []);
```

```tsx
<scrollbox ...>
  <For each={messages()}>
    ...
  </For>
</scrollbox>
```

借鉴点:

- session id 是 view identity。
- messages 从 `route.sessionID` 派生，不从全局 active transcript 混取。
- scrollbox 是应用管理的 viewport，session 切换天然替换消息集合。

## 4. npm/包影响

本轮短期方案不需要新增 npm 依赖。

涉及现有包:

```text
ink
ink-testing-library
react
vitest
ohbaby-sdk
```

需要注意:

- 不要因为文档或短期修复改 package version。
- 后续真正发布 v0.1.4 或其他版本时，再统一更新 `package.json`、lockfile、tag 和 npm publish。

## 5. 候选代码边界

短期推荐只触碰:

```text
packages/ohbaby-cli/src/tui/app.tsx
packages/ohbaby-cli/src/tui/app.contract.test.tsx
packages/ohbaby-cli/src/tui/store/events.ts
```

其中 `events.ts` 只建议修注释或新增纯函数测试，不建议重构 reducer。

除非测试证明必要，短期不触碰:

```text
packages/ohbaby-agent/src/runtime/daemon/server.ts
packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.tsx
packages/ohbaby-cli/src/tui/store/transcript.ts
packages/ohbaby-cli/src/cli/commands/terminal.ts
```

这样可以把风险集中在 TUI surface reset，不重新打开 daemon/session backend 的已修复问题。
