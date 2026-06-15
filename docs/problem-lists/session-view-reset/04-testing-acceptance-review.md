# Session View Reset: 测试与验收/审查标准

## 1. 测试目标

本轮测试要同时证明两件事:

1. `/sessions`、`/resume`、`/new`、fresh startup 这些 session boundary 能正确重置会话视图。
2. 普通 streaming、prompt 编辑、spinner、runtime update 不会清屏，不会把终端闪烁问题带回来。

换句话说，测试不再是“是否清屏”，而是“清屏是否只发生在正确边界”。

## 2. 单元测试

### TEST-UNIT-01: session boundary 分类

建议文件:

```text
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

或后续拆出:

```text
packages/ohbaby-cli/src/tui/session-surface-reset.unit.test.ts
```

断言:

```text
command.result.delivered(session.selected, source="new")
  -> new-session boundary

command.result.delivered(session.selected, choiceId="session_2")
  -> existing-session boundary

message.appended
message.part.delta
runtime.updated
session.updated
command.output.delivered
  -> not boundary
```

验收:

- 只有 session boundary 触发 `resetTranscriptSurface()`。
- 普通 transcript delta 不触发 clear sequence。

### TEST-UNIT-02: Static 策略不回退

现有文件:

```text
packages/ohbaby-cli/src/tui/components/transcript/committed-transcript.unit.test.tsx
```

保留断言:

```text
Windows TTY -> shouldUseStaticTranscript() === true
non-TTY -> shouldUseStaticTranscript() === false
OHBABY_TUI_STATIC_TRANSCRIPT=0 -> false
OHBABY_TUI_STATIC_TRANSCRIPT=1 -> true
```

验收:

- 本轮修改不能把 Windows TTY 默认 Static 改成 false。
- 本轮修改不能删除环境变量覆盖能力。

## 3. App contract 测试

### TEST-APP-01: fresh startup 清屏一次

现有语义保留:

```text
Given: clearOnStart=true
When: OhbabyTerminalApp initial render
Then: stdout 中 clear sequence 出现一次
And: clear sequence 是第一段输出
And: rerender 不重复 clear
```

目的:

- 保证默认 `ohbaby` 进入干净画布。

### TEST-APP-02: `/new` 清屏并显示空会话视图

场景:

```text
Given: 当前 session 有历史消息
When: 收到 command.result.delivered(session.selected, source="new")
Then: stdout 出现一次 clear sequence
And: clear 之后显示 prompt
And: 空会话可以显示 logo
And: 旧 session 历史不在 clear 之后出现
```

目的:

- `/new` 仍是新画布语义。
- `/new` 不被 existing session refresh 路径误处理。

### TEST-APP-03: `/sessions` 选择已有 session 后清理旧 terminal surface

场景:

```text
Given: session_1 有文本 "source history"
And: session_2 有文本 "target history"
And: 当前 activeSessionId = session_1
When: 收到 command.result.delivered(session.selected, choiceId=session_2)
And: client.getSnapshot() 返回 activeSessionId=session_2 的 snapshot
Then: stdout 出现一次 clear sequence
And: 最后一次 clear 之后包含 "target history"
And: 最后一次 clear 之后不包含 "source history"
And: 最后一次 clear 之后不包含 fresh logo
```

关键断言形式:

```ts
const output = app.stdout.frames.slice(frameCount).join("");
const clearIndex = output.lastIndexOf(SESSION_VIEW_CLEAR_SEQUENCE);
expect(clearIndex).toBeGreaterThanOrEqual(0);

const afterClear = output.slice(clearIndex + SESSION_VIEW_CLEAR_SEQUENCE.length);
expect(afterClear).toContain("target history");
expect(afterClear).not.toContain("source history");
expect(afterClear).not.toContain(renderOhbabyLogo());
```

目的:

- 证明目标 session 的 transcript 被渲染。
- 证明旧 session 的 terminal surface 被切断。
- 证明历史 session 切换不是 fresh empty session。

### TEST-APP-04: 目标 snapshot 未确认时不清屏

场景:

```text
Given: 当前 activeSessionId=session_1
When: 收到 session.selected(choiceId=session_2)
And: client.getSnapshot() 失败
Then: stdout 不出现新的 clear sequence
And: 当前视图保持 session_1
And: 显示可恢复错误 notice 或至少不崩溃
```

目的:

- 避免 daemon/network 短暂失败导致用户屏幕被清空。
- 避免 app 在 refresh 成功确认前 dispatch 原始 session selection，导致当前窗口先切到错误 active session。

### TEST-APP-04b: 目标 snapshot activeSessionId 不匹配时丢弃结果

场景:

```text
Given: 当前 activeSessionId=session_1
When: 收到 session.selected(choiceId=session_2)
And: client.getSnapshot() 返回 activeSessionId=session_1 或其他非 session_2 的 snapshot
Then: stdout 不出现新的 clear sequence
And: 当前视图保持 session_1
And: 不渲染 session_2 的历史内容
```

目的:

- 防止 daemon 或异步请求返回错误目标时，把当前 terminal surface 清掉并替换为不匹配的 snapshot。

### TEST-APP-05: 快速切换只应用最新 snapshot

场景:

```text
Given: 当前 activeSessionId=session_1
When: 用户快速选择 session_2，再选择 session_3
And: session_3 snapshot 先返回
Then: 渲染 session_3
When: session_2 snapshot 后返回
Then: 不回退到 session_2
And: 不追加第二次旧 clear 后的 session_2 内容
```

目的:

- 保护 `snapshotRefreshSequenceRef`。
- 防止旧异步请求覆盖新选择。

### TEST-APP-06: streaming 过程中不清屏

现有文件:

```text
packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx
```

保留并强化:

```text
Given: OHBABY_TUI_STATIC_TRANSCRIPT=1
And: fake stdout isTTY=true
When: live message 从 40 行增长到 120 行
Then: stdout 不包含 "\x1b[3J"
```

目的:

- 防止会话视图重置 helper 被误接入 streaming path。

### TEST-APP-07: prompt 编辑不触发 clear

建议新增 contract:

```text
Given: 当前 session 已有 committed message
When: 用户在 prompt 中输入、删除、换行
Then: stdout 不出现 SESSION_VIEW_CLEAR_SEQUENCE
And: committed message 不重复写出多份
```

目的:

- 直接保护“不能把终端闪烁带回来”的核心要求。

## 4. Store/reducer 回归

现有相关文件:

```text
packages/ohbaby-cli/src/tui/store/events.unit.test.ts
packages/ohbaby-cli/src/tui/store/transcript.unit.test.ts
```

需要确认:

- `snapshot.replaced` 仍能完整替换 active session messages。
- store reducer 仍支持原始 `command.result.delivered(session.selected)` 更新 active session id。
- app 的 existing-session switch 路径不会在目标 snapshot 确认前直接 dispatch 原始 `session.selected` action；它只 dispatch 去掉 selection action 的 command result，用于清理 command runtime/UI。
- `message.appended` 不会自动污染其他 client view。
- `committedItems` 在 live delta 下保持引用稳定。
- active session 切换后旧 `committedItems` 和 `liveMessage` 被丢弃。

## 5. daemon/session backend 回归

需要回归的文档范围:

```text
docs/problem-lists/terminal-daemon
docs/problem-lists/sessions-ui-backend
docs/problem-lists/session-switch-regression
```

建议命令:

```powershell
pnpm exec vitest run tests/integration/cli/daemon-terminal.integration.test.ts
pnpm exec vitest run tests/integration/tui/persistent-display.integration.test.tsx
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts
```

验收:

- 默认新窗口不是自动恢复上一个窗口的 active session。
- 多窗口 `/sessions` 切换互不影响。
- `/new` 只影响当前 client view。
- daemon ready 状态不因 TUI surface reset 变化。

## 6. 包发布前 smoke 测试

发布 npm 前建议执行:

```powershell
pnpm install
pnpm build
pnpm test
pnpm pack --filter ohbaby-cli
```

本机 npm 安装 smoke:

```powershell
npm install -g .\packages\ohbaby-cli\ohbaby-cli-<version>.tgz
ohbaby --version
ohbaby
```

手工验收:

1. 默认 `ohbaby` 打开后是干净新会话视图。
2. 输入一个 prompt，等待回复，prompt 输入/删除不闪烁。
3. `/sessions` 切到旧会话，只显示目标旧会话历史。
4. `/new` 后显示空会话 logo，不显示旧 PowerShell 命令历史。
5. 多个 PowerShell tab 同一 project root 下打开 `ohbaby`，互不抢 active session。

## 7. 审查标准

代码审查时重点看:

- 是否存在除 session boundary 以外的新 clear 调用。
- 是否把 `OHBABY_TUI_STATIC_TRANSCRIPT` 默认值改掉。
- 是否把 `CommittedTranscript` 改回全动态路径。
- 是否在 `client.getSnapshot()` 失败前先清屏。
- 是否保留 request sequence guard。
- 是否让 `/sessions` 历史 session 误显示 fresh logo。
- 是否污染 daemon/server 的多窗口 view 隔离逻辑。

## 8. 通过标准

可以认为本轮实现通过，需要同时满足:

- 自动测试中，session switch surface reset 测试通过。
- 自动测试中，flicker contract 测试通过。
- daemon/session backend 回归测试通过。
- Windows Terminal/PowerShell 手工验证中:
  - prompt 输入不恢复明显闪烁。
  - `/sessions` 切换不残留旧会话 transcript。
  - `/new` 和 fresh startup 是干净画布。
  - 多窗口切换互不影响。

只有上述条件同时成立，才适合进入下一次 npm patch release。
