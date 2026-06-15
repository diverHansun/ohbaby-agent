# Daemon Workspace Scope: 测试、验收与审查标准

> **归档状态**：该思路已放弃，由 `docs/problem-lists/server` 方案替代。本文中的 daemon scope 测试矩阵不再作为当前验收标准，新的验收重点以 `docs/problem-lists/server/07-route-c-cli-inprocess-explicit-server.md` 为准。

## 1. 测试目标

v0.1.4 的 daemon 测试需要证明：

1. 多路径启动行为可解释。
2. 同一 scope 并发启动只 spawn 一个 daemon。
3. 不同 scope 可并存且互不污染。
4. daemon 断开后 TUI 可恢复或给出可操作提示。
5. session view reset 和 terminal flicker 回归不被破坏。

## 2. Scope resolver 单元测试

建议新增：

```text
packages/ohbaby-agent/src/runtime/daemon/scope.unit.test.ts
```

### TEST-SCOPE-01: cwd scope

```text
Given: directory = D:\Projects\repo\packages\cli
And: mode = cwd
Then: scope.root = resolved directory
And: stateFilePath = <root>\.ohbaby\daemon-state.json
And: pidFilePath = <root>\.ohbaby\daemon.pid
And: startLockPath = <root>\.ohbaby\daemon-start.lock
```

### TEST-SCOPE-02: git-root scope

```text
Given: directory is inside a git repo
And: mode = git-root
Then: scope.root = repo root
```

### TEST-SCOPE-03: git-root fallback

```text
Given: directory is not inside a git repo
And: mode = git-root
Then: scope.root = resolved directory
```

### TEST-SCOPE-04: root/subdir decision guard

该测试按最终产品决策落地：

- 如果选择 cwd scope，root/subdir 应是不同 scope。
- 如果选择 git-root scope，root/subdir 应是同 scope。
- 如果选择 hybrid，默认行为和显式行为都要覆盖。

## 3. Spawn/start lock 测试

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts
```

### TEST-SPAWN-01: 同一 scope 并发只 spawn 一次

```text
Given: 两个 ensureDaemonRunning() 同时执行
And: 初始 state 缺失
When: 第一个调用持有 start lock 并 spawn
Then: 第二个调用等待 lock
And: lock 释放后二次 health check 复用第一个 daemon
And: spawn 调用次数为 1
```

### TEST-SPAWN-02: lock stale 后可恢复

```text
Given: daemon-start.lock 存在
And: lock pid 已死亡或超过超时时间
When: ensureDaemonRunning()
Then: 清理 stale lock
And: 正常 spawn 或复用 daemon
```

### TEST-SPAWN-03: spawn cwd 使用 scope workdir

```text
Given: scope.workdir = D:\Projects\repo
When: defaultSpawn()
Then: child process SpawnOptions.cwd = scope.workdir
```

## 4. State owner 测试

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts
packages/ohbaby-agent/src/runtime/daemon/state-file.unit.test.ts
```

### TEST-STATE-01: running state 写入 daemonId

```text
When: daemon starts
Then: daemon-state.json includes daemonId and scopeRoot
```

### TEST-STATE-02: old daemon stop 不覆盖 new daemon running

```text
Given: state belongs to daemon_new and status=running
When: daemon_old attempts to write stopped
Then: state remains daemon_new running
```

## 5. Reconnect 测试

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
```

### TEST-RECONNECT-01: read RPC reconnect + retry

```text
Given: client initialized against daemon A
And: getSnapshot transport fails
When: reconnect provider returns daemon B
Then: client initializes daemon B
And: getSnapshot retries once and succeeds
```

### TEST-RECONNECT-02: write RPC 不自动 replay

```text
Given: submitPrompt transport fails
When: reconnect provider returns daemon B
Then: client updates connection
And: submitPrompt rejects with recoverable error
And: backend does not receive duplicate prompt
```

### TEST-RECONNECT-03: SSE reconnect

```text
Given: SSE stream closes unexpectedly
When: reconnect succeeds
Then: client opens a new /api/events stream
And: calls getSnapshot or emits a snapshot replacement path
And: subsequent events are delivered to existing handlers
```

### TEST-RECONNECT-04: reconnect failure remains recoverable

```text
Given: daemon is gone
And: reconnect provider cannot make a daemon ready
Then: error message includes reconnect context
And: TUI process does not exit
```

## 6. CLI integration tests

### TEST-CLI-01: same scope concurrent terminals

建议新增：

```text
tests/integration/cli/daemon-workspace-scope.integration.test.ts
```

场景：

```text
Given: 两个 terminal host 使用同一 scope
When: 同时 buildCoreAPIImpl({ daemon: true })
Then: spawn 只发生一次
And: 两个 host 均可 getSnapshot
```

### TEST-CLI-02: different scope independent daemons

```text
Given: scope A and scope B
When: 各自启动 ohbaby
Then: A/B state files 不同
And: A stop 不影响 B health
```

### TEST-CLI-03: serve status 输出当前 scope

```text
When: ohbaby serve status
Then: output includes status, pid, updatedAt, scope
```

## 7. TUI contract tests

文件：

```text
packages/ohbaby-cli/src/tui/app.contract.test.tsx
packages/ohbaby-cli/src/tui/components/prompt/index.tsx
```

### TEST-TUI-01: submitPrompt connection failure restores prompt

```text
Given: user typed "hello"
And: client.submitPrompt rejects with recoverable daemon connection error
Then: prompt input contains "hello" again
And: error area shows recoverable daemon message
```

### TEST-TUI-02: reconnect notice 不触发 session clear

```text
Given: active session has transcript
When: daemon reconnect notice is emitted
Then: terminal clear sequence is not written
And: transcript remains visible
```

## 8. 手工验收

### Windows PowerShell / Windows Terminal

1. 安装本地 npm tarball。
2. 关闭旧 pnpm 调试进程。
3. 从同一 scope 开两个 PowerShell tab，几乎同时执行：

```powershell
ohbaby
```

验收：

- 只启动一个 daemon。
- 两个窗口都进入 TUI。
- 一个窗口 `/sessions` 不影响另一个窗口 active session。

4. 从两个不同 scope 分别执行：

```powershell
ohbaby serve status
ohbaby
```

验收：

- status 明确显示不同 scope。
- 不同 scope daemon 互不影响。

5. 手动 kill 当前 scope daemon。

验收：

- TUI 不崩溃。
- 读操作可恢复。
- submit prompt 不重复提交；用户可以重新提交。

## 9. 回归测试命令

建议实现后运行：

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts
pnpm exec vitest run tests/integration/cli/daemon-auto-spawn.integration.test.ts
pnpm exec vitest run tests/integration/cli/daemon-terminal.integration.test.ts
pnpm exec vitest run tests/integration/cli/daemon-global-fifo.integration.test.ts
pnpm exec vitest run tests/integration/tui/persistent-display.integration.test.tsx
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm exec vitest run packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.flicker.contract.test.tsx
pnpm run typecheck
pnpm --filter ohbaby-cli build
```

发布前完整回归：

```powershell
pnpm exec vitest run --passWithNoTests --no-file-parallelism
```

## 10. npm 本机 smoke

实现完成后，按真实发布路径测试：

```powershell
pnpm run build
pnpm --dir packages/ohbaby-sdk pack --pack-destination <temp>
pnpm --dir packages/ohbaby-agent pack --pack-destination <temp>
pnpm --dir packages/ohbaby-cli pack --pack-destination <temp>
npm install -g <temp>\ohbaby-sdk-*.tgz <temp>\ohbaby-agent-*.tgz <temp>\ohbaby-cli-*.tgz
ohbaby --version
ohbaby
```

验收：

- `ohbaby --version` 输出 v0.1.4。
- `ohbaby` 可启动。
- 多路径 daemon 行为符合本轮选择的 scope 策略。

## 11. 审查标准

代码审查重点：

- 是否还有 daemon 默认路径直接使用 `resolve(".ohbaby", ...)`。
- 是否还有 auto-spawn child 直接使用 `cwd: process.cwd()`。
- 是否同一 scope 下存在 spawn 竞态。
- 旧 daemon 是否可能覆盖新 daemon state。
- reconnect 是否会重复提交写操作。
- SSE reconnect 是否泄露旧 handler 或重复事件。
- `serve status/stop` 是否和默认 `ohbaby` 使用同一 scope。
- 是否破坏 session view reset。
- 是否把 root/subdir 共享 daemon 当成未经确认的默认结论。
