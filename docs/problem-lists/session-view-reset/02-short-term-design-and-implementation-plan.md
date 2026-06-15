# Session View Reset: 修改与实施计划

## 1. 推荐方向

短期采用 Gemini CLI 和 Kimi Code 的稳定做法:

- 保留现有 `CommittedTranscript` + guarded `<Static>`，继续保护 PowerShell prompt 输入时的无闪烁体验。
- 引入一个明确的“会话视图重置”原语，只在 session boundary 触发。
- `/sessions` 和 `/resume` 选择已有 session 时，先确认目标 snapshot，再清理 terminal surface 并渲染目标 session。
- `/new` 和 fresh startup 继续使用干净画布语义。

这不是长期虚拟 viewport 的最终形态，但它能以最小风险修复 npm/Windows 真实场景中的旧消息残留。

## 2. 术语

### Session Boundary

会话边界是会让当前 terminal surface 代表另一个 session 的动作:

- fresh startup: 默认 `ohbaby` 进入一个新的空会话视图。
- `/new`: 当前窗口切到新会话或复用项目下空会话。
- `/sessions`: 当前窗口切到用户选择的历史 session。
- `/resume`: 当前窗口显式恢复某个历史 session。

### Transcript Delta

不是会话边界，只是当前 session 内的内容变化:

- `message.appended`
- `message.part.delta`
- `runtime.updated`
- spinner tick
- tool call running/completed 更新
- prompt 输入、删除、移动光标

这些路径不能触发 hard clear。

## 3. 新增原语

建议在 `packages/ohbaby-cli/src/tui/app.tsx` 内先引入局部 helper，等稳定后再拆到独立文件:

```ts
type TranscriptSurfaceResetReason =
  | "new-session"
  | "switch-session";
```

短期 helper 的职责:

```ts
function resetTranscriptSurface(reason: TranscriptSurfaceResetReason): void {
  writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
  setScreenGeneration((current) => current + 1);
  setActiveCommandPanel(null);
}
```

说明:

- `writeStdout()` 负责清 terminal 当前屏幕和 scrollback。
- `screenGeneration` 负责让 `AppShell`、`Header`、`TranscriptViewport`、`PromptDock` 重新挂载。
- `setActiveCommandPanel(null)` 避免 session picker overlay 残留。
- `reason` 第一版可只用于代码可读性和测试命名，后续可接入 debug log。

注意: fresh startup 的 `clearOnStart` 发生在首次 render 前，当前仍保留一次性直接写 clear sequence 的实现，不在 render 期调用会推进 React state 的 helper。它和 `resetTranscriptSurface()` 共享同一个 `SESSION_VIEW_CLEAR_SEQUENCE` 语义，但触发位置不同。

常量建议:

```ts
export const SESSION_VIEW_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
```

短期为了减少破坏，可以先保留 `NEW_SESSION_CLEAR_SEQUENCE` 作为 alias:

```ts
export const NEW_SESSION_CLEAR_SEQUENCE = SESSION_VIEW_CLEAR_SEQUENCE;
```

这样已有测试和外部引用不会一次性全部改名。

## 4. 事件处理顺序

### 4.1 `/new`

`/new` 已经通过 `data.source === "new"` 明确标记。

期望顺序:

```text
command.result.delivered(session.selected, source="new")
  -> eventDispatcher.dispatch(tuiEvent)
  -> resetTranscriptSurface("new-session")
  -> 当前 frame 渲染空会话 logo + prompt
```

说明:

- `/new` 是明确的空画布语义，可以立即清理。
- `/new` 不应触发历史 session snapshot refresh。
- 如果后端复用当前项目下的空 session，用户仍应看到干净空会话画布。

### 4.2 `/sessions` 或 `/resume` 选择已有 session

当前 v0.1.3 已经有 `client.getSnapshot()` 刷新路径。需要在这个路径中加入 session surface reset。

推荐顺序:

```text
command.result.delivered(session.selected, choiceId=session_2)
  -> selectedExistingSessionIdFromEvent(tuiEvent) = session_2
  -> eventDispatcher.dispatch(command result without session.selected action)
  -> requestSequence += 1
  -> targetSessionIdRef = session_2
  -> client.getSnapshot()
  -> 验证 requestSequence 仍是最新
  -> 验证 snapshot.activeSessionId === session_2
  -> resetTranscriptSurface("switch-session")
  -> store.replaceSnapshot(snapshot)
  -> 渲染 session_2 历史消息
```

关键点:

- 目标 snapshot 未确认前不清屏，避免 daemon 错误或网络错误导致用户当前视图变成空白。
- 目标 snapshot 未确认前不 dispatch 原始 `session.selected` action，避免前端 store 先把当前窗口切到目标 session 后又刷新失败。
- 只应用最新一次 switch 请求，旧请求返回时必须丢弃。
- 只接受 `snapshot.activeSessionId === targetSessionId` 的结果，防止旧 snapshot 覆盖新选择。
- 成功后不显示 fresh logo，应该显示目标历史 session 的 transcript。

### 4.3 切换失败

如果 `client.getSnapshot()` 失败:

```text
保持当前 terminal surface
保留当前 store
显示可恢复错误 notice
允许用户再次执行 /sessions
```

不要:

- 先清屏再报错。
- 回退到某个旧 session。
- 修改别的窗口的 active session。

## 5. 与 Gemini CLI 的对应关系

Gemini CLI 的短期可借鉴点:

```text
D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\AppContainer.tsx
```

关键模式:

```ts
const refreshStatic = useCallback(() => {
  if (!isAlternateBuffer && !config.getUseTerminalBuffer()) {
    stdout.write(ansiEscapes.clearTerminal);
    setHistoryRemountKey((prev) => prev + 1);
  }
}, ...);
```

```text
D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\components\MainContent.tsx
```

关键模式:

```tsx
<Static key={uiState.historyRemountKey} items={[...]}>
  {(item) => item}
</Static>
```

可借鉴结论:

- Static 不是不能用。
- 但在 history/session 级别替换时，需要显式 clear terminal + remount Static。
- 不要只依赖 React key，因为 key 不能擦除终端 scrollback。

## 6. 与 Kimi Code 的对应关系

Kimi Code 的短期可借鉴点:

```text
D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\kimi-tui.ts
```

切换 session 时:

```ts
private async switchToSession(session: Session, statusMessage: string): Promise<void> {
  this.resetSessionRuntime();
  await this.setSession(session);
  await this.syncRuntimeState(session);
  this.refreshSessionTitle();
  this.clearTranscriptAndRedraw();
  await hydrateTranscriptFromReplay(...);
}
```

清 transcript 时:

```ts
private clearTranscriptAndRedraw(): void {
  this.discardPendingStreamingUiUpdates();
  this.state.transcriptEntries = [];
  this.resetLiveTextRuntime();
  this.resetLiveToolUiState();
  this.stopAllMcpServerStatusSpinners();
  this.state.transcriptContainer.clear();
  this.renderWelcome();
}
```

可借鉴结论:

- session switch 前要停止当前 session 的 live/spinner 状态。
- transcript surface 要清理。
- 然后再 hydrate/replay 目标 session。

ohbaby 短期不需要完全照搬 Kimi 的自定义容器，但要吸收这个生命周期顺序。

## 7. 代码改动计划

### Step 1: 重命名或 alias 清屏常量

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

计划:

- 新增 `SESSION_VIEW_CLEAR_SEQUENCE`。
- 保留 `NEW_SESSION_CLEAR_SEQUENCE` alias，降低测试迁移成本。
- 文档和新测试优先使用 `SESSION_VIEW_CLEAR_SEQUENCE`。

### Step 2: 引入 `resetTranscriptSurface()`

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

计划:

- 把 `/new`、existing session switch 的 render 后清理语义统一到 helper；startup 继续保持 pre-render 一次性 clear。
- helper 内部负责写清屏序列、推进 `screenGeneration`、关闭 command panel。
- 不让各路径散落调用 `writeStdout(NEW_SESSION_CLEAR_SEQUENCE)`。

### Step 3: 调整 existing session switch 路径

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

计划:

- `selectedExistingSessionIdFromEvent()` 保留。
- `client.getSnapshot()` 返回后校验 sequence 和 target session。
- 校验通过后调用 `resetTranscriptSurface("switch-session")`。
- 再 `store.replaceSnapshot(snapshot)` 或以同一同步片段完成 clear + store replace + generation bump。
- 如果返回 snapshot 不匹配，直接丢弃。
- 如果请求失败，不清屏，保留当前视图。

### Step 4: 修正测试语义

文件:

```text
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

计划:

- 删除或改写 `does not clear screen for ordinary session selection actions`。
- 新增 `clears the transcript surface once after an existing session snapshot is confirmed`。
- 在输出中用“最后一次 clear 之后的片段”断言:
  - 包含目标 session 历史。
  - 不包含源 session 历史。
  - 不包含 fresh logo。

### Step 5: 保留防闪烁测试

文件:

```text
packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx
```

计划:

- 不降低该测试强度。
- 明确 streaming 过程中不能出现 `\x1b[3J`。
- 如果新增 helper，要确保该 helper 不被 streaming/runtime path 调用。

### Step 6: 回归 daemon/session view 相关测试

需要覆盖:

```text
docs/problem-lists/terminal-daemon
docs/problem-lists/sessions-ui-backend
docs/problem-lists/session-switch-regression
```

重点确认:

- 多窗口 client view 仍隔离。
- 默认 fresh startup 仍不继承旧 session。
- `/sessions` 只切当前窗口。
- daemon ready 和 npm packaging 不受影响。

## 8. 短期不做的事情

本轮不做:

- 不实现完整 virtual transcript viewport。
- 不切换到 alternate screen。
- 不删除 guarded Static。
- 不引入新包。
- 不改 daemon 协议，除非测试证明现有 event payload 无法表达 session boundary。
- 不改 npm 发布配置和 package version。

这些内容放到长期方案文档中作为后续锚点。

## 9. 长期方案锚点

短期方案修复的是“什么时候可以安全清理 terminal surface”。长期方案应解决“会话视图本身由应用管理，而不是完全交给 terminal scrollback”。

建议后续引入:

```text
TranscriptRenderer
  ├─ NativeScrollbackTranscript
  └─ ManagedTranscriptViewport
```

### NativeScrollbackTranscript

对应当前 guarded Static 路径:

- 适合普通线性对话。
- 性能好。
- 依赖 terminal native scrollback。
- session boundary 需要 hard clear。

### ManagedTranscriptViewport

对应未来 opencode/Claude Code 方向:

- 应用自己管理 viewport。
- 支持 per-session scroll state。
- 支持 stick-to-bottom。
- session switch 时天然替换消息集合。
- 不依赖 terminal scrollback 删除旧内容。

推荐 feature flag:

```text
OHBABY_TUI_TRANSCRIPT_RENDERER=native
OHBABY_TUI_TRANSCRIPT_RENDERER=managed
OHBABY_TUI_TRANSCRIPT_RENDERER=auto
```

短期默认仍为 `native`。
