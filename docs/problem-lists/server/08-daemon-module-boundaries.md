# 08 `runtime/daemon` 模块边界

> 本文回答“daemon 版块需要保留什么、删除什么”。结论不是整包删除，而是按职责拆分：server/protocol 能力保留，隐藏生命周期能力退出默认 CLI 路径。

## 当前分类

`packages/ohbaby-agent/src/runtime/daemon/` 里的文件实际属于三类职责。

| 类别 | 文件 | 判断 |
|------|------|------|
| server/protocol | `server.ts`、`client.ts`、`protocol.ts`、`auth.ts` | 保留，但语义应从 daemon 改为 explicit server/remote client |
| 协调能力 | `prompt-queue.ts`、`permission-router.ts` | 保留在 server 模式；默认 in-process CLI 不应依赖全局 FIFO |
| 生命周期管理 | `spawn.ts`、`supervisor.ts`、`state-file.ts`、`pid-file.ts`、`main.ts` | 从默认路径移除；仅作为显式 detached server 兼容能力保留或逐步淘汰 |
| 类型/错误/索引 | `types.ts`、`errors.ts`、`index.ts` | 随新边界重命名、拆分、缩小导出面 |
| 待审计 legacy | `bootstrap.ts`、`app-events.ts` | 审计引用后决定删除或迁移；不要盲目保留 |

## 应保留的能力

### 1. 显式 server

保留 HTTP/SSE server 的价值：

- web/app 未来需要连接 agent runtime。
- attach 模式需要远端/本地 server URL。
- 多客户端 permission routing、prompt queue、event replay 只能由 server 统一仲裁。

但它应该由 `ohbaby serve` 或未来 `ohbaby-server` 显式启动。

### 2. remote client

`client.ts` / `protocol.ts` 的远程契约仍然有价值：

- CLI attach 可以复用。
- npm 包的集成测试可以启动 server 后用 client 验证。
- 未来 SDK 可以选择 HTTP client 或 injected local client。

### 3. 权限与 prompt 协调

`permission-router.ts`、`prompt-queue.ts` 属于多客户端 server 语义：

- server 模式下，一个 prompt run 可能来自 CLI、web 或 app。
- 权限问题必须回到发起方。
- 全局 FIFO 只适合 server 统一调度，不适合作为默认 CLI 的隐藏依赖。

## 应从默认 CLI 删除的东西

### 1. hidden auto-spawn

需要从默认路径移除：

- `terminal.ts` 默认 `{ daemon: true }`。
- `core-api-factory.ts` 默认进入 `ensureDaemonRunning()`。
- 启动 `ohbaby` 时隐式 discover/start/reuse daemon。

默认 CLI 应直接 in-process。

### 2. state/pid 文件参与默认启动

默认 `ohbaby` 不应读取或写入 daemon state/pid 文件来决定 active session 或 server 地址。否则 npm 升级、多路径启动、旧进程残留都会影响用户的普通 CLI。

### 3. daemon 断线自动重放 prompt

即使在显式 server 模式下，也不建议自动重放用户 prompt。可自动重新 discover/start server，但应该提示用户重新提交，避免重复执行工具、重复修改文件或重复扣费。

## 可保留但需要降级的东西

### `spawn.ts`

短期可保留给显式 `--daemon` 或 SDK helper，但不应被默认 CLI import。长期有两种去向：

- 删除：只保留 foreground `ohbaby serve`。
- 迁移：放到 `ohbaby-server/lifecycle/`，作为显式 detached server 管理。

### `supervisor.ts`

如果未来需要 detached server，可以保留；如果只支持 foreground server，则不需要。不要把 supervisor 当作默认 CLI 稳定性的补丁。

### `state-file.ts` / `pid-file.ts`

只适用于 detached server。如果短期保留，必须限定为 explicit server lifecycle，不参与默认 session 选择。

### `main.ts`

应拆成两层：

- server composition：启动 HTTP/SSE server。
- lifecycle wrapper：foreground/detached 的启动方式。

默认 CLI 不应经过这层。

## 未来抽包建议

当路线 A 触发时，建议目标结构：

```text
packages/ohbaby-server/src/
  server/
    http-server.ts
    routes.ts
    sse.ts
  client/
    remote-client.ts
  protocol/
    jsonrpc.ts
    events.ts
  coordination/
    prompt-queue.ts
    permission-router.ts
    event-bus.ts
  auth/
    token.ts
    cors.ts
  lifecycle/
    foreground.ts
    detached.ts        # optional
    pid-file.ts        # optional
    state-file.ts      # optional
```

`ohbaby-agent` 保留：

```text
packages/ohbaby-agent/src/
  host/
    core-api-factory.ts     # 只选择 local/remote，不做 hidden spawn
  ui-inprocess/
  backend/
  services/
  project/
  session/
```

## 导出面调整

当前 `packages/ohbaby-agent/src/index.ts` 如果直接导出 daemon lifecycle，应逐步收口：

- `startDaemonServer` -> `startServer` 或移动到 server 包。
- `readDaemonStatus` / `stopDaemonFromState` 只作为 detached server 兼容 API。
- 默认 CLI 不从 public index 触达 daemon lifecycle。

## 删除前检查清单

- `rg "bootstrapRuntime|app-events|ensureDaemonRunning|startDaemonServer|readDaemonStatus|stopDaemonFromState"`。
- 确认默认 CLI、run、tests 是否仍引用这些文件。
- 先增加 deprecation/warning，再删除 public API。
- npm pack/install 本机验证默认 `ohbaby` 不再创建 daemon 状态。

## 推荐顺序

1. 先移除默认 auto-spawn。
2. 再把用户可见文案从 daemon 改为 server。
3. 保留显式 `ohbaby serve`，避免 web/app 规划断档。
4. 最后按真实需求决定是否抽 `packages/ohbaby-server`。
