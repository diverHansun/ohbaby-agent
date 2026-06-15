# Session View Reset: 现有问题与代码分析

## 1. 背景

当前 `ohbaby` 的 TUI 已经解决过两个相关但方向相反的问题:

1. PowerShell/Windows Terminal 中，prompt 输入和删除时不应导致历史消息区域反复闪烁。
2. 使用 `/sessions` 切换历史会话时，旧会话消息不应继续留在终端里，新会话消息也不应接在旧会话后面追加。

第一个问题依赖 `CommittedTranscript` + Ink `<Static>` 缓解。第二个问题要求整个会话视图可以被替换。冲突点在于: `<Static>` 是 append-only 输出，写进终端 scrollback 后，React remount 或 store 替换不能删除已经写出的旧内容。

因此，本轮问题不是单纯的 session 数据错误，而是 TUI 缺少明确的“会话视图重置”边界。

## 2. 当前用户可见问题

### 2.1 `/sessions` 切换后旧消息残留

复现路径:

1. 当前窗口打开 `session_1`，终端中已经显示 `session_1` 的历史消息。
2. 输入 `/sessions`，选择 `session_2`。
3. 后端和 TUI store 已经切到 `session_2`。
4. 终端真实显示层仍保留 `session_1` 之前写入的 Static 内容。
5. `session_2` 的内容接着追加，用户看到两个 session 的 transcript 混在一起。

这说明 data store 层的 `activeSessionId` 可以是正确的，但 terminal surface 没有被清理。

### 2.2 不能用“禁用 Static”作为修复

禁用 `<Static>` 可以让 transcript 更容易被替换，但会把之前修过的 PowerShell 闪烁问题带回来。现有测试已经把这个方向作为风险保护:

- `packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx`
- 测试名: `never clears the terminal scrollback while a tall live message streams`
- 目标: streaming 期间不能清 scrollback，避免长消息和 prompt 更新触发明显闪烁。

所以正确方向不是回退到全动态 transcript，而是区分:

- 普通消息更新: 不清屏，继续保护无闪烁。
- 会话边界切换: 有控制地重置当前会话视图。

## 3. 代码路径分析

### 3.1 清屏序列

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

修复前基线中只有 `/new` 语义的清屏常量:

```ts
export const NEW_SESSION_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
```

修复后当前实现已扩展为会话视图语义，并保留旧导出作为 alias:

```ts
export const SESSION_VIEW_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
export const NEW_SESSION_CLEAR_SEQUENCE = SESSION_VIEW_CLEAR_SEQUENCE;
```

语义:

- `\x1b[2J`: 清当前屏幕。
- `\x1b[3J`: 清 scrollback。
- `\x1b[H`: 光标回左上角。

关键语义已经从“新会话清屏”扩大为“会话视图边界重置”。保留 `NEW_SESSION_CLEAR_SEQUENCE` 是兼容层，新代码优先使用 `SESSION_VIEW_CLEAR_SEQUENCE`。

### 3.2 startup 清屏

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
packages/ohbaby-cli/src/cli/commands/terminal.ts
```

`terminal.ts` 会按启动意图传入 `clearOnStart`:

```ts
clearOnStart: resume === undefined && args.continue !== true
```

`app.tsx` 中只执行一次:

```ts
if (clearOnStart && !didClearOnStartRef.current) {
  writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
  didClearOnStartRef.current = true;
}
```

这说明默认 fresh startup 已经有“进入一个干净画布”的产品语义。这里使用的是兼容 alias，实际 clear sequence 与 `SESSION_VIEW_CLEAR_SEQUENCE` 相同。

### 3.3 `/new` 清屏

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

修复前基线中只对 `/new` 做 hard clear:

```ts
const isNewSessionSelection = isNewSessionSelectionEvent(tuiEvent);
if (isNewSessionSelection) {
  snapshotRefreshSequenceRef.current += 1;
  writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
  setScreenGeneration((current) => current + 1);
  setActiveCommandPanel(null);
}
```

修复后当前实现把这一组动作收敛到 `resetTranscriptSurface("new-session")`，仍由 `isNewSessionSelectionEvent()` 通过 `action.kind === "session.selected"` 和 `data.source === "new"` 判断。

### 3.4 既有 session 切换在目标 snapshot 确认后重置 terminal surface

文件:

```text
packages/ohbaby-cli/src/tui/app.tsx
```

修复前基线中，`/sessions` 或 `/resume` 选择已有 session 后只会触发:

```text
command.result.delivered(session.selected)
  -> selectedExistingSessionIdFromEvent()
  -> client.getSnapshot()
  -> store.replaceSnapshot(snapshot)
```

这解决了 v0.1.3 中“目标 session 数据拿不到”的问题，但没有解决 terminal scrollback 已经写入旧 Static 内容的问题。

修复后当前实现调整为:

```text
command.result.delivered(session.selected)
  -> selectedExistingSessionIdFromEvent()
  -> dispatch commandResultWithoutSessionSelection(tuiEvent)
  -> client.getSnapshot()
  -> 验证 request sequence 仍是最新
  -> 验证 snapshot.activeSessionId === selectedExistingSessionId
  -> resetTranscriptSurface("switch-session")
  -> store.replaceSnapshot(snapshot)
```

关键点:

- 在目标 snapshot 确认前不 dispatch 原始 `session.selected` action，避免前端先切到目标 session 后刷新失败。
- `store.replaceSnapshot(snapshot)` 能替换 React state。
- `key={screenGeneration}` 能让 React tree remount。
- `resetTranscriptSurface()` 负责删除之前 `<Static>` 已经写进终端的历史文本。

### 3.5 `CommittedTranscript` 的 Static 策略

文件:

```text
packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.tsx
```

当前策略:

```ts
const useStatic = shouldUseStaticTranscript({
  isTTY: stdout.isTTY,
});

if (useStatic) {
  return (
    <Static items={items as TranscriptItem[]}>
      ...
    </Static>
  );
}
```

`shouldUseStaticTranscript()` 的意图:

- Windows TTY 默认启用 Static，降低 prompt repaint flicker。
- 非 TTY 和重定向输出默认保持动态渲染，方便测试和可替换输出。
- `OHBABY_TUI_STATIC_TRANSCRIPT=0/1` 可覆盖。

这个设计本身仍然有效，但需要与“会话边界重置”配合。

### 3.6 committed/live 分层

文件:

```text
packages/ohbaby-cli/src/tui/store/transcript.ts
```

该层负责把 transcript 分为:

- `committedItems`: 稳定历史，适合进入 Static。
- `liveMessage`: 当前仍在变化的消息尾部，必须保持动态。

这层是防闪烁的基础，不能因为 session switch 问题被删除。

## 4. 已有测试中的冲突

文件:

```text
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

当前存在一个已经过时的断言:

```text
does not clear screen for ordinary session selection actions
```

这个测试保护了 v0.1.2/v0.1.3 的短期假设: 普通 session selection 不清屏。但真实 Windows TTY + Static 场景证明，这个假设会导致旧会话 transcript 残留。

需要调整为:

```text
clears the transcript surface exactly once after an existing session snapshot is confirmed
```

同时必须保留另一类测试:

```text
never clears the terminal scrollback while a tall live message streams
```

也就是说，新的测试边界应该是:

- session boundary 可以清。
- streaming/prompt/runtime delta 不能清。

## 5. 历史文档中的重要结论

### 5.1 improve-2 的结论

`docs/ohbaby-cli/tui-improve-2` 已经记录过:

- `<Static>` 可以减少动态区 repaint。
- 但 `<Static>` 是 append-only，会在 `/resume`、`/sessions` 后留下旧 committed 行。
- 当时选择暂缓 transcript Static，以保证可切换会话视图的正确性。

### 5.2 improve-3 的结论

`docs/ohbaby-cli/tui-improve-3` 后来为了修 PowerShell 闪烁，引入:

- committed/live split。
- Windows TTY guarded Static。
- `/new` hard clear。

但 improve-3 也明确写过一个后续约束:

```text
后续若扩展到所有终端，必须先补 active session 清屏/视口代际策略，并比较 ANSI 序列字节数和 frame 间隔。
```

现在遇到的问题正是这个后续约束变成了现实需求。

## 6. 根因总结

根因可以压缩成一句话:

> 当前 TUI 把“稳定历史输出”与“可替换会话视图”都交给了同一个 Static/terminal scrollback 机制，但 terminal scrollback 只擅长追加，不擅长替换。

更具体地说:

1. `CommittedTranscript` 正确地把稳定历史移入 Static，减少闪烁。
2. `/sessions` 切换正确地刷新了目标 session snapshot。
3. 但没有一个明确的 `resetTranscriptSurface()` 在 session boundary 上清理旧 terminal surface。
4. 因此终端真实输出层仍含旧会话内容。

## 7. 本轮修复必须守住的边界

必须守住:

- 不禁用 Windows TTY guarded Static。
- 不在 streaming 中清屏。
- 不在 prompt 输入、删除、光标移动中清屏。
- 不在 spinner tick 或 runtime status update 中清屏。
- `/sessions` 和 `/resume` 的目标 snapshot 未确认前，不应先把用户屏幕清成空白。
- 切到历史 session 后，应渲染历史消息，而不是显示 fresh logo。
- `/new` 和 fresh startup 才显示空会话 logo。

可以调整:

- 将“普通 session selection 不清屏”的旧测试改为“既有 session 切换是 session boundary，应在目标 snapshot 确认后清理一次 terminal surface”。
- 将 `NEW_SESSION_CLEAR_SEQUENCE` 的使用点抽象为更通用的会话视图重置原语。
