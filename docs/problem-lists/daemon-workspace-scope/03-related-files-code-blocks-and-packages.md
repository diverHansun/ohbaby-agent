# Daemon Workspace Scope: 涉及文件、代码块与包

> **归档状态**：该思路已放弃，由 `docs/problem-lists/server` 方案替代。本文列出的 daemon 文件和代码块仅作为旧方案参考，新的边界以 `docs/problem-lists/server/08-daemon-module-boundaries.md` 为准。

## 1. 当前 daemon 相关代码

### 1.1 auto-spawn discovery

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/spawn.ts
```

当前关键代码：

```ts
const DEFAULT_STATE_FILE = resolve(".ohbaby", "daemon-state.json");
```

```ts
cwd: process.cwd(),
```

```ts
const stateFile =
  options.stateFile ??
  new JsonDaemonStateFile(options.stateFilePath ?? DEFAULT_STATE_FILE);
```

问题：

- 默认 state file 绑定当前 cwd。
- 默认 child cwd 绑定当前 cwd。
- 没有统一 scope resolver。
- 没有客户端侧 start lock。

候选改动：

- 接收 `DaemonScope`。
- 使用 `scope.stateFilePath`。
- 使用 `scope.workdir`。
- 在 spawn 前后持有 `scope.startLockPath`。

### 1.2 daemon server lifecycle

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/main.ts
packages/ohbaby-agent/src/runtime/daemon/supervisor.ts
```

当前关键代码：

```ts
const DEFAULT_STATE_DIR = ".ohbaby";
const DEFAULT_STATE_FILE = resolve(DEFAULT_STATE_DIR, "daemon-state.json");
```

```ts
options.pidFilePath ?? resolve(DEFAULT_STATE_DIR, "daemon.pid")
```

```ts
options.stateFilePath ?? resolve(DEFAULT_STATE_DIR, "daemon-state.json")
```

候选改动：

- `startDaemonServer()` 接收 `scope` 或显式 `scopeRoot`。
- `readDaemonStatus()` 接收 scope 参数。
- `stopDaemonFromState()` 接收 scope 参数。
- `Supervisor` 写 state 时携带 daemonId/scopeRoot。

### 1.3 Core API factory

文件：

```text
packages/ohbaby-agent/src/host/core-api-factory.ts
```

当前关键代码：

```ts
const connection = await discoverDaemon({
  currentVersion: getAgentPackageVersion(),
  ...(options.daemonStateFilePath === undefined
    ? {}
    : { stateFilePath: options.daemonStateFilePath }),
});
```

候选改动：

- 在默认 daemon 模式 resolve daemon scope。
- 把 scope 传给 discoverDaemon。
- createRemoteCoreApiHost 时传入 reconnect provider。

### 1.4 Remote daemon client

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/client.ts
```

当前关键代码：

```ts
this.baseUrl = `http://${host}:${String(options.port)}`;
```

```ts
response = await this.fetchImpl(`${this.baseUrl}/api/rpc`, ...);
```

```ts
const url = new URL(`${this.baseUrl}/api/events`);
```

候选改动：

- connection 从 readonly 变成可更新状态。
- 增加 reconnect provider。
- SSE loop 失败后可重连。
- 读 RPC 连接失败后可 retry once。
- 写 RPC 连接失败不自动 replay。

### 1.5 CLI terminal command

文件：

```text
packages/ohbaby-cli/src/cli/commands/terminal.ts
```

职责：

- 默认 `ohbaby` 进入 daemon 模式。
- `--in-process` 或 `--daemon=false` 进入嵌入式模式。
- `--remote-port` 进入显式 remote 模式。

候选改动：

- 如需暴露 scope 选择，可在这里加 CLI option。
- v0.1.4 不建议先扩展太多参数，优先内部稳定。

### 1.6 CLI serve command

文件：

```text
packages/ohbaby-cli/src/cli/commands/serve.ts
packages/ohbaby-cli/src/cli/commands/types.ts
```

职责：

- `ohbaby serve start`
- `ohbaby serve status`
- `ohbaby serve stop`

候选改动：

- status 输出当前 scopeRoot。
- stop 停止当前 scope daemon。
- start 显式使用当前 scope 派生 pid/state/workdir。

## 2. project 模块

### 2.1 Project root resolver

文件：

```text
packages/ohbaby-agent/src/project/project-manager.ts
```

当前能力：

```ts
export async function getProjectRoot(
  directory: string,
): Promise<string | null>
```

行为：

- 从 directory 向上寻找 `.git`。
- 支持 `.git` 目录、文件、符号链接。
- 找不到返回 `null`。

### 2.2 Project info resolver

文件：

```text
packages/ohbaby-agent/src/project/project-manager.ts
packages/ohbaby-agent/src/project/project-identifier.ts
```

当前能力：

```ts
export async function fromDirectory(directory: string): Promise<ProjectInfo>
```

```ts
export async function getGitProjectId(
  worktree: string,
): Promise<string | null>
```

行为：

- git repo 返回 `{ id, rootPath, vcs: "git" }`。
- 非 git 或 git id 失败返回 global project，rootPath 为 resolved directory。

对 daemon 的意义：

- 可以支持 git-root scope。
- 不能直接决定产品是否应合并 root/subdir。
- 不建议直接复用 `ProjectInfo.id` 作为 state 文件名，短期用 root path 派生路径更直观。

## 3. 现有测试

### 3.1 daemon auto-spawn

文件：

```text
tests/integration/cli/daemon-auto-spawn.integration.test.ts
```

现有测试：

```text
starts one daemon for two default core hosts
```

现有限制：

- 通过同一个 `daemonStateFilePath` 注入证明复用。
- 没覆盖真实 cwd 多路径。
- 没覆盖两个进程同时竞争。

需要补充：

- 同一 scope 并发只 spawn 一次。
- 不同 scope 可并存。
- status/stop 使用当前 scope。

### 3.2 daemon spawn unit

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts
```

现有覆盖：

- 健康 daemon 复用。
- state 缺失时 spawn。
- stale pid 时 spawn。
- version mismatch 时 shutdown + spawn。
- never ready 时错误。

需要补充：

- start lock 下二次 health check。
- lock 已被活进程持有时等待。
- lock stale 时清理。
- spawn 默认 cwd 使用 scope workdir。

### 3.3 daemon client integration

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
```

现有覆盖：

- RPC 方法转发。
- auth。
- startup intent。
- transport failure 包装。
- SSE failure contained。

需要补充：

- SSE reconnect。
- 读 RPC reconnect + retry。
- 写 RPC reconnect 但不 replay。
- reconnect 后重新 initializeClient。

### 3.4 project tests

文件：

```text
packages/ohbaby-agent/src/project/project.integration.test.ts
packages/ohbaby-agent/src/project/project-identifier.unit.test.ts
```

现有价值：

- 可作为 daemon scope resolver 的底层保证。
- 需要新增 daemon scope 自己的测试，不应把 daemon 语义塞进 project 模块测试。

## 4. 文档关联

相关历史文档：

```text
docs/problem-lists/terminal-daemon
docs/problem-lists/sessions-ui-backend
docs/problem-lists/session-switch-regression
docs/problem-lists/session-view-reset
```

需要保持一致的结论：

- daemon 是默认 npm 使用路径。
- 多窗口 client view 隔离仍然是产品目标。
- fresh startup 默认不恢复别的窗口 active session。
- session view reset 不应回退。

## 5. 包与发布影响

涉及包：

```text
packages/ohbaby-agent
packages/ohbaby-cli
packages/ohbaby-sdk
```

预计影响：

- `ohbaby-agent`：daemon scope、spawn、server、client reconnect。
- `ohbaby-cli`：serve status 输出、TUI prompt 错误恢复。
- `ohbaby-sdk`：短期不需要改公共类型，除非决定把 reconnect 状态暴露成 SDK event。

v0.1.4 发布前需要同步：

```text
package.json versions
pnpm-lock.yaml
tag v0.1.4
npm publish ohbaby-sdk / ohbaby-agent / ohbaby-cli
```

但当前文档阶段不做版本号修改。

## 6. 借鉴项目锚点

短期主要借鉴：

```text
D:\Projects\Code-cli\gemini-cli
D:\Projects\Code-cli\kimi-code
```

关注点：

- 明确 session/runtime lifecycle。
- 重连和进程管理要有清晰状态。
- TUI 不应把后台连接失败伪装成普通 prompt 错误。

长期继续研究：

```text
D:\Projects\Code-cli\opencode
D:\Projects\Code-cli\claude-code
```

关注点：

- server/workspace registry。
- route-scoped session view。
- managed viewport。
- 多 project daemon 管理。
