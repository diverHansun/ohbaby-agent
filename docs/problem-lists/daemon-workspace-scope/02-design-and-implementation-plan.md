# Daemon Workspace Scope: 修改与实施计划

> **归档状态**：该思路已放弃，由 `docs/problem-lists/server` 方案替代。本文中的 scope resolver、daemon 启动锁、state ownership 等内容不再作为当前实施计划，仅供后续理解旧方案取舍。

## 1. v0.1.4 推荐目标

v0.1.4 的目标不是做完整的全局 daemon 架构，而是先让本地 CLI daemon 具备稳定的多路径使用能力：

- daemon scope 规则明确。
- 同一 scope 并发启动只 spawn 一次。
- 不同 scope 的 daemon 可并存、可查看、可停止。
- daemon 断开后 TUI 能恢复连接或给出可操作提示。
- 不把 session view reset 的终端清屏修复回退。

## 2. Scope 策略选项

### 方案 A: git-root scope

规则：

```ts
scopeRoot = await Project.getProjectRoot(cwd) ?? path.resolve(cwd);
```

表现：

- repo root 和 repo 子目录共享 daemon。
- 非 git 目录按 cwd 独立。

优点：

- 符合很多开发工具对“项目”的理解。
- 一个 repo 的 session、MCP、配置、环境变量更容易统一。
- 解决从 `packages/foo` 启动重复 daemon 的问题。

风险：

- 用户如果希望 repo 子目录拥有独立 daemon，需要额外参数或配置。
- monorepo 中不同 package 的隔离语义可能不足。

### 方案 B: canonical-cwd scope

规则：

```ts
scopeRoot = path.resolve(cwd);
```

表现：

- repo root 和 repo 子目录是不同 daemon。
- 只保证同一个 cwd 并发启动只 spawn 一次。

优点：

- 最符合“我从哪里启动，就属于哪里”的直觉。
- 不会强行合并 repo root/subdir。
- 改动最小。

风险：

- 当前多路径多 daemon 的现象会被保留为产品语义。
- 用户从相邻目录启动时可能仍觉得 daemon 太多。
- session/project root 逻辑和 daemon scope 逻辑可能继续不一致。

### 方案 C: hybrid explicit scope

规则：

```text
默认使用 canonical cwd scope。
支持 --workspace-root <path> 或配置项选择 scope root。
后续可增加 --scope git-root。
```

表现：

- 默认不强行合并 root/subdir。
- 需要共享 daemon 时用户可以显式指定。

优点：

- 尊重用户对 root/subdir 不一定共享 daemon 的判断。
- 为后续 git-root、monorepo package-root、global daemon 留扩展口。

风险：

- v0.1.4 多一个参数和文档解释成本。
- 自动化体验不如方案 A。

### 当前推荐

短期推荐 **方案 C 的内部结构，先不急着暴露全部 CLI 参数**：

- 内部新增 `DaemonScope` 对象，而不是继续散落使用 cwd。
- 默认 scope 可以先保持 canonical cwd，避免违背用户对 root/subdir 的判断。
- 同时保留 git-root resolver 能力，作为后续配置或命令参数接入点。

这样可以先修 daemon 生命周期问题，又不把 root/subdir 是否共享 daemon 这个产品决策提前写死。

## 3. 新增核心类型

建议新增文件：

```text
packages/ohbaby-agent/src/runtime/daemon/scope.ts
```

初版类型：

```ts
export type DaemonScopeMode = "cwd" | "git-root";

export interface DaemonScope {
  readonly mode: DaemonScopeMode;
  readonly root: string;
  readonly stateFilePath: string;
  readonly pidFilePath: string;
  readonly startLockPath: string;
  readonly workdir: string;
}
```

初版 resolver：

```ts
export async function resolveDaemonScope(input?: {
  readonly directory?: string;
  readonly mode?: DaemonScopeMode;
}): Promise<DaemonScope>
```

路径建议：

```text
<scopeRoot>/.ohbaby/daemon-state.json
<scopeRoot>/.ohbaby/daemon.pid
<scopeRoot>/.ohbaby/daemon-start.lock
```

说明：

- 即使默认 mode 先用 `cwd`，也应通过这个 resolver 统一派生路径。
- 后续切换成 `git-root` 时，不需要再改 daemon 其它层。

## 4. 客户端侧启动锁

### 问题

server pid file lock 太晚。两个 terminal 同时发现 daemon 不存在时，都会进入 spawn。

### 方案

在 `ensureDaemonRunning()` 进入 read-state/health/spawn 流程前，先持有 start lock：

```text
acquire daemon-start.lock
  read state again
  health check again
  healthy -> return connection
  unhealthy -> spawn
  wait ready
release lock
```

实现建议：

- Windows 下不要依赖 flock。
- 可复用 `fs.open(path, "wx")` 风格。
- lock 文件内容写入 pid、createdAt、scopeRoot。
- 如果 lock pid 已死亡或 lock 超时，允许清理。

### 验收

两个进程同时调用 `ensureDaemonRunning()`：

- `spawn` 只调用一次。
- 两个调用最终拿到同一个 host/port/authToken。

## 5. State owner / generation

### 问题

旧 daemon 停止、崩溃、或失败启动时，可能把 state 写成 `stopped/crashed`，而此时新 daemon 已经写了 `running`。

### 方案

在 state 中加入 daemon owner：

```ts
interface DaemonState {
  readonly daemonId?: string;
  readonly scopeRoot?: string;
  readonly status: "running" | "stopping" | "stopped" | "crashed";
  ...
}
```

Supervisor 启动时生成 `daemonId`。写 state 时：

- `running` 写入当前 daemonId。
- `stopping/stopped/crashed` 只允许覆盖同 daemonId 的 state。
- 如果 state 已经属于另一个 running daemon，旧进程不应覆盖。

### 验收

模拟旧 daemon stop 与新 daemon running 交错：

- 最终 state 仍指向新 daemon。
- 旧 daemon 不会把新 daemon 标记为 stopped。

## 6. Remote client reconnect

### 问题

`RemoteDaemonClient` 固定 baseUrl。daemon 重启后，TUI 仍连接旧 port。

### 短期方案

在 auto-spawn 默认路径下，让 remote client 持有 reconnect provider：

```ts
type DaemonReconnectProvider = () => Promise<RunningDaemonConnection>;
```

RPC 遇到 transport error 时：

1. 判断是否为连接层错误。
2. 调用 reconnect provider 重新 discovery。
3. 重建 baseUrl/authToken。
4. 重新 initializeClient。
5. 对安全读操作重试一次。
6. 对写操作不自动重试，避免重复提交。

安全读操作：

```text
getSnapshot
getContextWindowUsage
listCommands
getCurrentModel
```

写操作：

```text
submitPrompt
executeCommand
respondPermission
respondInteraction
abortRun
compactSession
connectModel
```

写操作失败后的 TUI 行为：

- 恢复用户输入或保留当前 prompt。
- 显示可恢复错误，例如：

```text
Daemon reconnected. Please submit again.
```

### SSE reconnect

SSE 断线后应自动重新连接：

```text
SSE error/close
  -> backoff
  -> reconnect provider
  -> initializeClient
  -> open /api/events
  -> getSnapshot
  -> dispatch snapshot.replaced
```

短期 backoff 可简单：

```text
250ms, 500ms, 1000ms, max 2000ms
```

## 7. CLI status/stop scope-aware

当前 `ohbaby serve status` 随 cwd 读取不同 state。这可以保留，但必须明确。

短期建议：

```text
ohbaby serve status
  显示当前 scope 的 daemon

ohbaby serve status --all
  后续再做，列出全局 registry 中所有 daemon
```

v0.1.4 如果不做全局 registry，则先不做 `--all`，但 status 输出应包含 scope root：

```text
daemon status: running pid=7864 scope=C:\Users\...
```

## 8. 实施步骤

### Step 1: 新增 daemon scope resolver

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/scope.ts
packages/ohbaby-agent/src/runtime/daemon/scope.unit.test.ts
```

内容：

- 支持 cwd scope。
- 支持 git-root scope，但默认策略由产品决策控制。
- 派生 state/pid/startLock/workdir。

### Step 2: `ensureDaemonRunning()` 接入 scope

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/spawn.ts
```

内容：

- 增加 `scope?: DaemonScope` 或 `scopeRoot/startLockPath/pidFilePath/workdir` options。
- defaultSpawn 使用 `scope.workdir`。
- stateFile 使用 `scope.stateFilePath`。
- spawn 前后在 start lock 中完成二次 health check。

### Step 3: `startDaemonServer()` 接入 scope

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/main.ts
packages/ohbaby-agent/src/runtime/daemon/supervisor.ts
```

内容：

- start server 时显式传入 pid/state/workdir。
- `readDaemonStatus()` 和 `stopDaemonFromState()` 支持 scope 参数。
- state 中记录 scopeRoot。

### Step 4: `buildCoreAPIImpl()` 统一解析 scope

文件：

```text
packages/ohbaby-agent/src/host/core-api-factory.ts
```

内容：

- 默认 daemon 模式下先 resolve scope。
- 将 scope 传给 ensureDaemonRunning。
- remote explicit port 模式不走 scope。
- in-process 模式可继续使用当前 cwd/projectDirectory。

### Step 5: CLI serve 命令输出 scope

文件：

```text
packages/ohbaby-cli/src/cli/commands/serve.ts
packages/ohbaby-cli/src/cli/commands/types.ts
```

内容：

- `status` 输出 scope root。
- `stop` 停止当前 scope daemon。
- 不在 v0.1.4 强行做 `--all`，除非实现全局 registry。

### Step 6: Remote client reconnect

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/client.ts
packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts
```

内容：

- 支持 connection 更新。
- 支持 SSE reconnect。
- 读 RPC 可 retry once。
- 写 RPC 不自动 replay。

### Step 7: TUI prompt 错误处理优化

文件：

```text
packages/ohbaby-cli/src/tui/components/prompt/index.tsx
packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

内容：

- 写操作连接失败时恢复 prompt 文本。
- 显示可恢复错误。
- 不清空用户输入后只留下 `fetch failed`。

## 9. 暂不做的事

v0.1.4 暂不做：

- 单一全局 daemon 管理所有 workspace。
- daemon registry `--all` 全量管理界面。
- monorepo package-level 自动识别。
- Web/App frontends 的远程 daemon 协议扩展。
- 改写 session storage 数据模型。
- 回退 session view reset 或 terminal flicker 修复。
