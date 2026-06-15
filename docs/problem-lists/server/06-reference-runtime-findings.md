# 06 参考项目运行时复核

> 本文记录 2026-06-15 对 `gemini-cli`、`kimi-code`、`claude-code`、`opencode` 的只读复核结论。重点不是照搬实现，而是识别它们如何划分默认 CLI、server、session、remote/ACP 能力。

## 总结

四个项目没有采用“默认交互式 CLI 背后隐藏启动一个常驻 daemon/server”的模型。

| 项目 | 默认 CLI | server/remote 能力 | 对 ohbaby 的启发 |
|------|----------|--------------------|------------------|
| Gemini CLI | 前台父进程 supervisor 重新拉起子进程，真实 TUI/runtime 在当前命令生命周期内 | A2A server、ACP、devtools 是显式模式或独立包 | 可以有很薄的前台 launcher，但不要变成跨命令常驻 daemon |
| Kimi Code | 单前台进程，`KimiHarness` + `KimiTUI` + in-process fake RPC | SDK/vis server 是独立能力，默认 CLI 不起本地 server | 保留接口边界，但不要为了边界强行引入网络拓扑 |
| Claude Code | 普通 CLI 直接 render REPL 并调用 query/runtime | daemon、remote-control、ACP 都是显式入口或独立 package | 默认 CLI 与 long-running server 的职责分离清楚 |
| Opencode | 默认 TUI 是前台 worker + injected fetch；`run` 直接打 in-process server app fetch | `serve`、`web`、`attach`、desktop sidecar、SDK helper 显式启用 server | server 抽象可以很强，但默认路径不需要 hidden daemon |

## Gemini CLI

关键事实：

- 默认 `gemini` 入口会有一个轻量前台父进程，用 `spawn(process.execPath, ...)` 拉起真实 CLI 子进程。
- 子进程进入 `main()` 后启动 interactive UI，Ink render 直接绑定当前 stdin/stdout。
- `--resume`、`--list-sessions`、`--delete-session` 是显式 session 操作；默认无 resume 时创建新 session id。
- A2A server 是独立 package/bin；ACP、devtools、gemma router 等不是默认交互式 CLI 的隐藏主路径。

可借鉴点：

- 前台 launcher/supervisor 可以用于 Node flags、环境准备、升级检查，但生命周期必须跟当前 CLI 绑定。
- session 恢复要显式；默认新建会话更符合用户直觉。

不应照搬：

- Gemini 的前台 relaunch 不是 daemon，不能拿它证明 ohbaby 默认 auto-spawn 后台 daemon 合理。

## Kimi Code

关键事实：

- 默认入口进入 `runShell()`，创建 `KimiHarness` 和 `KimiTUI`，然后 `tui.start()`。
- SDK/Core 使用 in-process fake RPC：通过 JSON serialize/deserialize 和异步调度保留边界，但不走 socket。
- TUI 支持 `/new`、`/sessions`/`/resume`、`/fork`；切换 session 时会重置 UI runtime 并重放 transcript。
- session 按 workDir key 持久化，但跨进程同一 session 的强锁并不明显。

可借鉴点：

- ohbaby 可以保留 `CoreApiHost`/`UiBackendClient` 的接口边界，同时让默认 CLI 直接 in-process。
- `/sessions` 切换需要明确的“会话视图重置”原语，不能依赖终端历史自然覆盖。

不应照搬：

- Kimi 的跨进程同 session 写入并不是强一致方案。ohbaby 如果要支持多窗口同 session 写入，应放到显式 server 仲裁。

## Claude Code

关键事实：

- 默认 CLI fast-path 只处理 `--acp`、`--daemon-worker`、remote-control、daemon 等显式模式。
- 普通交互路径进入前台 REPL，提交 prompt 后直接调用 query async generator。
- daemon 是显式 `claude daemon start/status/stop/...`。
- remote-control server、ACP link server 是独立 package/模块，有独立 auth、CORS、transport、event bus、SSE/WS replay。

可借鉴点：

- server 包可以独立演进 auth、CORS、event bus、SSE/WS、session-scoped token。
- 默认 CLI 不应该承担这些 server 复杂度。

不应照搬：

- Claude 的 remote-control 体系服务于云端/订阅/feature gate，ohbaby 当前不需要提前引入同等复杂度。

## Opencode

关键事实：

- 裸 `opencode` 启动 TUI thread，TUI 创建前台 Worker。
- 默认没有监听端口；TUI 用 worker RPC 提供 injected fetch 和 event source。
- `run` 默认在当前进程 `bootstrap(process.cwd())` 后，用 SDK custom fetch 调 `Server.Default().app.fetch(request)`。
- `serve`、`web`、`attach` 是显式 command；只有显式 network 参数时才启动 HTTP listener。
- SDK 支持 `baseUrl` 或 injected `fetch`，同一 client 可以打 HTTP server，也可以打 in-process app。

可借鉴点：

- server abstraction 可以保留为核心能力，但“监听端口/长生命周期”必须显式。
- injected fetch/client 是一条很好的迁移路径：CLI 默认不走网络，server 模式复用同一协议模型。
- per-directory/per-project `Instance` lifecycle 和 `disposeAll()` 对 ohbaby 的 project/runtime 边界有参考价值。

不应照搬：

- Opencode 的 Hono/OpenAPI/control-plane/workspace proxy 很重，ohbaby 短期不需要整体迁移到类似体系。

## 对 ohbaby 的共同结论

1. 默认 `ohbaby` 应是当前终端窗口的前台 runtime。
2. `ohbaby serve` / 未来 `ohbaby-server` 应是显式 server，而不是默认 CLI 的隐藏依赖。
3. 多窗口默认应该创建独立 session；恢复、attach、共享 session 都必须显式。
4. session 多写者不能靠“大家都读写同一持久化目录”解决；需要 server 仲裁或文件锁/lease 策略。
5. 代码上应把 server/protocol/transport 与 agent runtime 拆开，让默认 CLI 不看到端口、pid、state-file、CORS、auth。
