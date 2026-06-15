# 02 目标与非目标

> 本文档更新 server 规划的目标：先恢复 CLI 的可预测性，再把 server 作为显式能力建设。默认 `ohbaby` 不应继续依赖隐藏 daemon。

## 背景

当前 ohbaby 已经有一套 daemon/server 代码：HTTP JSON-RPC、SSE、权限路由、prompt queue、state/pid 文件、auto-spawn 等。它解决了一部分多窗口和前后端协作问题，但也把默认 CLI 的生命周期变复杂了：

- 用户只是运行 `ohbaby`，却可能触发后台进程发现、启动、连接、重启、旧状态复用。
- 多路径、多窗口、版本升级后容易出现 stale daemon、旧 session 被误复用、连接失败、端口/状态文件漂移。
- 默认 CLI 的错误模型变成“前台 UI + 后台 daemon + 持久化 session + 网络传输”的混合体，调试成本偏高。

四个参考项目的复核结论是：默认 CLI 应该是当前命令生命周期内的 runtime。server 可以很强，但必须是显式入口。

## 功能目标

| 优先级 | 目标 | 说明 |
|--------|------|------|
| P0 | 默认 `ohbaby` 走 in-process runtime | 不自动 discover/start daemon；前台进程退出即释放 runtime |
| P0 | 默认启动创建新 session | 同一 project root 下新开窗口默认是新 session；恢复历史必须显式选择 |
| P0 | `/new` 与首次启动显示干净启动视图 | 不带 PowerShell 历史、不混入旧 transcript；历史 session 切换才渲染历史消息 |
| P0 | 保留显式 server 能力 | `ohbaby serve` 或未来 `ohbaby-server` 启动 HTTP/SSE server，用于 web/app/attach |
| P1 | 支持显式 attach | TUI 或 headless run 可以连接用户指定 server URL，不隐式启动 |
| P1 | server 负责多客户端协调 | 权限、prompt queue、SSE replay、CORS、auth、session writer 仲裁只属于 server 模式 |
| P2 | 抽 `packages/ohbaby-server` | 当 web/app/ACP/A2A 或重协议依赖真实落地时执行 |

## 非功能目标

| 维度 | 要求 |
|------|------|
| 可预测性 | 默认 CLI 不依赖端口、pid 文件、state 文件、后台重启 |
| 可测试性 | CLI in-process 与 server/remote 两套路径分别测试，不互相污染 |
| 依赖隔离 | HTTP/CORS/mDNS/auth/OpenAPI/ACP/A2A 不进入核心 agent runtime |
| 显式生命周期 | 长生命周期 server 必须由用户显式启动、显式连接、显式停止 |
| 渐进迁移 | 先改默认路径，再重命名/抽包；避免一次性大迁移影响 npm 稳定性 |
| 失败可解释 | 连接失败只发生在显式 remote/server 模式；默认 CLI 失败就是当前进程失败 |

## 明确非目标

- 不继续把 hidden daemon auto-spawn 作为默认 CLI 路径。
- 不在 v0.1.x 短期内强行引入 ACP/A2A。
- 不默认开放 LAN 访问、mDNS、TLS、多用户权限模型。
- 不自动重放用户 prompt。server 断开后应重新 discover/start，并提示用户重新提交。
- 不把“session 持久化”解释为“多个终端可同时写同一个 session”。同 session 多写者要么由显式 server 仲裁，要么由文件锁/lease 拒绝或只读化。

## SWE 判断

### SRP

CLI 的职责是驱动一个终端会话；server 的职责是提供多客户端、远程传输、鉴权、CORS、重连、事件分发。把这两类生命周期混在默认路径里，是 daemon 问题反复出现的根因。

### YAGNI

当前 npm CLI 用户最需要的是稳定启动、稳定输入、稳定切换 session。web/app/ACP/A2A 是未来能力，不应让默认 CLI 先承担 server 拓扑成本。

### 依赖倒置

核心 runtime 应暴露稳定的 `CoreApiHost` / `UiBackendClient` 契约。CLI 默认直接使用本地实现；server 通过 adapter 暴露 HTTP/SSE；attach 通过 remote client 使用同一契约。

### 故障隔离

默认 CLI 没有网络连接失败、端口冲突、旧 daemon 版本、state 文件漂移这些故障面。显式 server 失败时也更容易解释：启动失败、认证失败、连接失败或 server 已退出。

## 当前决策

短期推荐路线 C：默认 CLI in-process + 显式 server。路线 A 作为长期抽包方案保留；路线 B 降级为历史/fallback。
