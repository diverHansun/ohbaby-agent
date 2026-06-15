# 07 路线 C：默认 CLI in-process + 显式 server

> 这是当前推荐的短期稳定方案。目标不是删除 server 能力，而是把 server 从默认 CLI 路径中拿出来，变成用户显式选择的能力。

## 一句话

`ohbaby` 默认启动本进程 runtime；`ohbaby serve` 或未来 `ohbaby-server` 显式启动 HTTP/SSE server；`ohbaby attach <url>` 或 `ohbaby run --attach <url>` 显式连接远端/本地 server。

## 目标拓扑

```text
默认 CLI:

ohbaby
  -> terminal command
  -> CoreAPI factory(inProcess)
  -> persistent UI backend
  -> agent runtime

显式 server:

ohbaby serve / ohbaby-server
  -> HTTP/SSE server
  -> CoreAPI host
  -> persistent UI backend
  -> agent runtime

显式 attach:

ohbaby attach http://127.0.0.1:PORT
  -> remote client
  -> HTTP/SSE server
```

## 用户语义

| 场景 | 预期行为 |
|------|----------|
| `ohbaby` | 在当前 project root 下创建新 session，不恢复旧 session |
| 同一目录再开一个终端运行 `ohbaby` | 创建另一个新 session，不复用上一个窗口的 active session |
| `/new` | 当前窗口进入新 session，并显示干净启动视图 |
| `/sessions` 选择历史 session | 清空当前会话视图并完整渲染目标 session 的历史消息 |
| `ohbaby serve` | 显式启动 server，打印 URL、认证信息和停止方式 |
| `ohbaby attach <url>` | 连接指定 server；连接失败只提示失败，不自动启动 |
| server 断开 | 自动重新 discover/start 只在显式 server 模式允许；提示用户重新提交 prompt，不自动重放 |

## 为什么它比默认 daemon 稳

默认 daemon 把三类生命周期叠在一起：

1. 终端 UI 生命周期。
2. agent runtime/session 生命周期。
3. 后台 server 进程生命周期。

一旦叠在一起，版本升级、多路径启动、多窗口、旧 state 文件、端口冲突、session active 指针都会互相影响。路线 C 把它们拆开：

- 默认 CLI：只有当前进程，失败就是当前进程失败。
- 显式 server：才处理端口、认证、CORS、SSE、重连、多客户端。
- attach：用户明确知道自己连接了一个外部 runtime。

## 分阶段实施

### C0 文档确认

- 完成本文档和边界文档。
- 明确路线 C 作为短期主线，路线 A 作为长期抽包目标，路线 B 作为 fallback。

### C1 默认路径回到 in-process

建议改动点：

- `packages/ohbaby-cli/src/cli/commands/terminal.ts`
  - 默认传 `{ daemon: false, inProcess: true }`。
  - `--daemon` 改为显式 opt-in，并标记为实验/兼容。
- `packages/ohbaby-agent/src/host/core-api-factory.ts`
  - 只有显式 `daemon === true` 或显式 remote 参数时才调用 `ensureDaemonRunning()`。
  - 默认分支直接 `createPersistentUiBackendClient(...)`。

验收：

- npm 安装后的 `ohbaby` 默认不创建 daemon state/pid 文件。
- 同一目录两个终端运行 `ohbaby`，得到两个不同的新 session。
- 关闭终端后没有残留后台 daemon。

### C2 server 入口显式化

建议改动点：

- 保留 `ohbaby serve`，但文案从 daemon 改为 server。
- `serve start/status/stop` 如果仍依赖 state-file/pid-file，应标记为 detached server 兼容能力；短期优先支持 foreground server。
- 新增或规划 `ohbaby attach <url>`，等价于 remote client 模式。

验收：

- `ohbaby serve` 明确打印监听地址、认证 token/设置方式、停止方式。
- `ohbaby` 不会因为发现已有 server 就自动 attach。
- `ohbaby attach` 连接失败时只报错，不自动重放 prompt。

### C3 server/protocol 与 runtime 解耦

建议改动点：

- server 层只依赖 `CoreApiHost`/`UiBackendClient` 契约。
- CLI 默认路径不 import HTTP server、pid/state-file、CORS、auth。
- 借鉴 Opencode 的 injected fetch/client 思路：同一个 client abstraction 可打 in-process host，也可打 HTTP server。

验收：

- `rg "ensureDaemonRunning|startDaemonServer|pid-file|state-file"` 在默认 CLI 路径中不可达。
- server 相关测试和 CLI in-process 测试可单独运行。

### C4 触发后抽 `ohbaby-server`

只有出现以下真实需求时执行：

- web/app 进入开发并需要长期 server surface。
- ACP/A2A 或其他重协议 SDK 需要引入。
- server auth/CORS/event replay/OpenAPI 独立演进影响 agent 包边界。

抽包时迁移目标参考 [`08-daemon-module-boundaries.md`](./08-daemon-module-boundaries.md)。

## 测试与验收标准

### CLI 默认

- `pnpm start` 与 npm 全局安装后的 `ohbaby` 行为一致。
- 默认启动不会复用上一次 active session。
- 两个终端同 cwd 同时启动，不共享 active session 指针。
- `/new` 是干净 logo 页面；`/sessions` 是完整历史 transcript 页面。
- 输入中断、spinner、prompt 框不因为传输层重连产生重复渲染。

### 显式 server

- `ohbaby serve` 前台启动、前台停止，退出后清理资源。
- `ohbaby attach <url>` 可以连接显式 server。
- server 断开后提示重新提交，不自动重放 prompt。
- auth、CORS、SSE replay、permission routing 只在 server 测试里验证。

### 回归

- `docs/problem-lists/terminal-daemon/` 中的终端闪烁修复不得回退。
- `docs/problem-lists/sessions-ui-backend/` 中的 session 切换修复不得回退。
- npm pack/install 本机验证必须覆盖默认 CLI 与显式 server 两条路径。

## 风险

| 风险 | 缓解 |
|------|------|
| 从默认 daemon 切回 in-process 后，已有用户依赖 daemon 行为 | 保留显式 `--daemon` 或 `ohbaby serve` 兼容期，并在 README 说明 |
| 多窗口同时 resume 同一 session 出现竞争 | 短期拒绝/提示，长期由文件锁或显式 server 仲裁 |
| 抽包过早导致迁移风险过大 | 先完成 C1/C2，不在短期强制 `packages/ohbaby-server` |
| server 断开后用户 prompt 丢失 | 不自动重放，提示用户重新提交；后续可做本地草稿保留 |

## 推荐结论

先执行 C1 和 C2。也就是：默认 CLI 回到 in-process，server 入口显式化。等 web/app 或 ACP/A2A 真正推进，再执行 C3/C4 抽象和抽包。
