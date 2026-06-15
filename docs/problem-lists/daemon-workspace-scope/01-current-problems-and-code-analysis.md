# Daemon Workspace Scope: 当前问题与代码分析

> **归档状态**：该思路已放弃，由 `docs/problem-lists/server` 方案替代。本文仅作为 hidden daemon workspace scope 问题的历史分析材料保留。

## 1. 背景

v0.1.3 已发布。当前 main 上已有一个准备进入 v0.1.4 的 session view reset commit，用来修复 `/sessions` 切换后旧 transcript 残留的问题。

在本机 npm 安装并多窗口、多路径启动 `ohbaby` 后，session 切换问题暂时缓解，但仍偶发 daemon 相关错误：

```text
Daemon connection failed while running submitPrompt: fetch failed
```

用户刻意从多个目录启动 `ohbaby`，这是合理压力测试。CLI 必须能解释并正确处理多路径启动，而不是要求用户只从某一个目录使用。

## 2. 当前可见问题

### 2.1 多路径启动会产生多个 daemon

现场观察到不同目录下 `ohbaby serve status` 返回不同 daemon 状态：

```text
C:\Users\Huang junzhe
  daemon status: running pid=7864

D:\Projects
  daemon status: running pid=36448

D:\Projects\Code-cli\ohbaby-agent
  daemon status: stopped pid=29852
```

这不是单纯的“有孤儿进程”，而是当前设计天然按启动 cwd 读写 state 文件。

### 2.2 `submitPrompt` 期间偶发 `fetch failed`

`RemoteDaemonClient` 在创建时固定一次 daemon connection：

```text
baseUrl = http://host:port
```

之后所有 RPC 都向这个 `baseUrl` 发送请求。若 daemon 在 TUI 打开后退出、重启、端口切换或 state 指向变化，已打开的 TUI 不会重新 discovery。下一次 `submitPrompt` 就会暴露：

```text
Daemon connection failed while running submitPrompt: fetch failed
```

### 2.3 SSE 断线没有 reconnect

当前测试已经把这一点写成已知限制：

```text
keeps SSE connection failures contained until reconnect support exists
```

这说明 SSE 失败会被吞掉，避免直接崩溃，但不会恢复事件流。TUI 仍然活着，用户继续输入时才在 RPC 路径看到连接错误。

### 2.4 同一 scope 并发启动缺少客户端侧启动锁

server 侧有 pid file lock，但 `ensureDaemonRunning()` 的客户端发现流程目前是：

```text
read state
health check
if unhealthy -> spawn
wait state ready
```

两个终端几乎同时启动时，可能都读到“不健康或不存在”，然后都 spawn。server pid lock 可以让其中一个 server 失败，但失败进程仍可能写 `crashed` 或留下短暂竞争状态。

## 3. 当前代码路径分析

### 3.1 auto-spawn discovery 使用 cwd 相对路径

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/spawn.ts
```

关键点：

```ts
const DEFAULT_STATE_FILE = resolve(".ohbaby", "daemon-state.json");
```

```ts
cwd: process.cwd(),
```

```ts
new JsonDaemonStateFile(options.stateFilePath ?? DEFAULT_STATE_FILE);
```

影响：

- state file 默认是 `<cwd>/.ohbaby/daemon-state.json`。
- child daemon 默认在当前 `process.cwd()` 下启动。
- 不同 cwd 会自然得到不同 daemon state。

### 3.2 daemon server 默认 state/pid 也使用 cwd 相对路径

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/main.ts
packages/ohbaby-agent/src/runtime/daemon/supervisor.ts
```

关键点：

```ts
const DEFAULT_STATE_DIR = ".ohbaby";
const DEFAULT_STATE_FILE = resolve(DEFAULT_STATE_DIR, "daemon-state.json");
```

```ts
options.pidFilePath ?? resolve(DEFAULT_STATE_DIR, "daemon.pid")
options.stateFilePath ?? resolve(DEFAULT_STATE_DIR, "daemon-state.json")
```

影响：

- `ohbaby serve status` 与 `ohbaby serve stop` 也随 cwd 改变。
- 手动 daemon 与 auto-spawn daemon 没有统一的 workspace scope resolver。

### 3.3 `buildCoreAPIImpl()` 只透传显式 stateFilePath

文件：

```text
packages/ohbaby-agent/src/host/core-api-factory.ts
```

关键点：

```ts
const connection = await discoverDaemon({
  currentVersion: getAgentPackageVersion(),
  ...(options.daemonStateFilePath === undefined
    ? {}
    : { stateFilePath: options.daemonStateFilePath }),
});
```

影响：

- 测试可以通过 `daemonStateFilePath` 注入稳定路径。
- 真实 CLI 默认没有计算 workspace root，也没有给 `ensureDaemonRunning()` 传 pid path、workdir 或 scope 信息。

### 3.4 remote client 固定 baseUrl

文件：

```text
packages/ohbaby-agent/src/runtime/daemon/client.ts
```

关键点：

```ts
this.baseUrl = `http://${host}:${String(options.port)}`;
```

```ts
response = await this.fetchImpl(`${this.baseUrl}/api/rpc`, ...);
```

```ts
const url = new URL(`${this.baseUrl}/api/events`);
```

影响：

- 连接建立后没有 rediscover。
- daemon 重启或端口变化后，现有 TUI 不知道新的 daemon 地址。

## 4. `packages/ohbaby-agent/src/project` 是否可用

结论：可以作为修复基础，但当前 daemon 链路还没有接入它。

文件：

```text
packages/ohbaby-agent/src/project/project-manager.ts
packages/ohbaby-agent/src/project/project-identifier.ts
packages/ohbaby-agent/src/project/index.ts
```

已有能力：

```ts
export async function getProjectRoot(directory: string): Promise<string | null>
```

行为：

- 从给定目录向上查找 `.git` 目录、文件或符号链接。
- 找到后返回 git root。
- 找不到则返回 `null`。

```ts
export async function fromDirectory(directory: string): Promise<ProjectInfo>
```

行为：

- 存在 git root 时，用 `git rev-list --max-parents=0 --all` 计算项目 id。
- 失败或非 git 目录时返回 `GLOBAL_PROJECT_ID`，rootPath 为当前 resolved directory。

这说明它可以支持两类策略：

1. git-aware scope：git repo 内所有目录可以归并到 git root。
2. cwd scope：非 git 目录按 canonical cwd 独立成 scope。

但它不能直接回答一个产品问题：

> repo root 和 repo 子目录是否应该共享同一个 daemon？

这是产品体验决策，而不是 project 模块本身的问题。

## 5. 需要澄清的产品边界

### 5.1 已确认边界

- v0.1.4 不应再称为 v0.1.3。
- 多路径启动必须被支持。
- 两个终端同时启动同一 scope，只能 spawn 一个 daemon。
- 连接断开后不应让用户只看到不可恢复的 `fetch failed`。
- 不同 scope 的 daemon 可以并存，但必须可解释、可查看、可停止。

### 5.2 未确认边界

repo root 与 repo 子目录是否同 scope 尚未定论。

可选语义：

```text
方案 A: git-root scope
repo root 与任意子目录共享一个 daemon。
```

```text
方案 B: canonical-cwd scope
repo root 与子目录各自是独立 daemon scope。
```

```text
方案 C: hybrid explicit scope
默认 cwd scope，但提供 --workspace-root 或配置项让用户指定共享 scope。
```

用户已明确不同意“repo root 和 repo 子目录启动只 spawn 一个 daemon”作为未经讨论的结论。因此文档和实现计划必须把这个点保留为决策项。

## 6. 根因总结

当前问题由三条线叠加：

1. daemon state/pid/workdir 默认绑定 `process.cwd()`，导致多路径自然多 daemon。
2. 同一 scope 并发启动没有客户端侧 lock，导致 spawn 竞态。
3. TUI remote client 固定一次 baseUrl，daemon 断开后不会 reconnect。

`project` 模块能解决 scope 计算问题的一部分，但 daemon 生命周期还需要补：

- scope resolver
- start lock
- state owner/generation
- reconnect
- status/stop 的 scope-aware 行为
