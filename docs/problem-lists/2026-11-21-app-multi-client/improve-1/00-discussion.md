# 讨论记录与已确认要点

> 2026-11-21 开始与用户逐项讨论，每确认一项就更新本文。
>
> 术语：本文的"运行时"指 ohbaby 的 agent 运行时和 server，也就是 `ohbaby` 命令本身；"daemon"指 `ohbaby serve` 起的全局服务进程；"客户端"指连接 daemon 的 Web 页面、App 窗口，或用 `--remote-port` 连上来的 TUI。

## 1. 背景

项目目前通过 CLI 安装，提供 TUI 和 Web 两种界面。接下来要做 App 端。动手之前，需要先回答三个问题：

1. Web 和 App 能不能共用一个 daemon，能不能同时打开。
2. TUI 和 Web/App 能不能操作同一个会话，同时发提示词时会怎样。
3. App 自带的运行时和用户另外安装的 CLI 版本不一致时怎么办。

## 2. 现状要点

以下事实是 2026-11-21 对照代码核实的：

| 项 | 现状 |
|---|---|
| daemon 数量 | 每个 `OHBABY_HOME` 至多一个 serve，靠用户级 pid/state 文件和文件锁保证 |
| 多客户端 | daemon 已支持多个客户端：每个客户端注册 clientId，事件通过 SSE 推给所有客户端，同一会话的提示词先进先出排队，权限请求归发起提示词的客户端处理（`packages/ohbaby-server/src/coordination/`） |
| 默认 TUI | in-process，不连 daemon，可以和 daemon 同时运行（ADR-001） |
| 跨进程防双写 | TUI 和 daemon 共用同一个 SQLite。`claimPendingRun` 用 `BEGIN IMMEDIATE` 事务保证同一会话最多一个运行中的 run，后来的一方收到 `SessionRunBusyError` |
| 版本门禁 | CLI 和正在运行的 server 版本必须完全一致，不一致就拒绝复用，也不自动杀掉旧 server |
| 数据库降级保护 | 新版本迁移过的数据库，旧版本打开时报 `DatabaseNewerThanProgramError`，提示先升级（`packages/ohbaby-agent/src/services/database/index.ts:254`） |
| 隔离方式 | `OHBABY_HOME` 决定 pid、state 和数据库的位置。端口默认 4096，被占用时自动改用系统分配的随机端口 |
| 页面鉴权 | daemon 只允许回环地址访问，token 注入在它返回的 HTML 里，同源页面直接可用 |

## 3. 已确认：同一会话的处理（2026-11-21）

| 决策项 | 结论 |
|---|---|
| 默认 TUI | 保持 in-process，不改成默认连 daemon |
| 默认 TUI 和 Web/App 同开一个会话 | 只保证不双写：后发提示词的一方收到 busy 错误，不排队。很可能也看不到对方的实时输出（待实测，见第 9 节） |
| 需要真正一起操作同一会话 | 用 `ohbaby --remote-port` 让 TUI 连上 daemon，这时它和 App、Web 一样是客户端，享有排队和事件广播 |

参考项目的做法与我们相反：opencode 和 codex 都让 TUI 默认连 daemon，codex 连不上时再退回内嵌模式。我们沿用 ADR-001，因为终端不应该受网络和服务故障影响。

## 4. 已确认：Web 和 App 共用一个 daemon（2026-11-21）

Web 和 App 共用同一个 daemon，可以同时打开。App 启动 daemon 后，用户在浏览器里打开的 Web 页面连的是同一个服务，两边都只是客户端。

讨论时考虑过"App 和 Web 各起一个 daemon"，没有采用，理由如下：

- 版本冲突的根源不在 daemon，而在数据库。只要机器上有两个版本的运行时，新版本迁移过数据库后，旧版本连 TUI 都打不开。分开 daemon 并不能解决这个问题。
- 要彻底避开，就得让 App 用另一个 `OHBABY_HOME`，把数据也分开。代价是 App 看不到终端和 Web 的会话，配置和 API key 要再配一遍，不值得。

## 5. 已确认：版本策略（2026-11-21）

原则是**同一台机器上的运行时保持同一个版本**。CLI 和 App 可以各带一份运行时，但版本号要一致，共用同一份数据。

2026-11-21 用户补充发布渠道：App 单独发布 macOS、Windows、Linux 的安装包；现有的 CLI 安装命令（npm、curl、PowerShell 脚本）只负责 TUI 和 Web，不涉及 App 的下载。两条渠道互相独立，同一台机器上同时装了 CLI 和 App 是正常情况。

| 决策项 | 结论 |
|---|---|
| 发布方式 | App 和 CLI 用同一个版本号、同一条发布流程一起发布，但分别分发 |
| App 的运行时 | App 安装包里自带运行时（Node SEA 独立可执行文件） |
| 安装 `ohbaby` 命令 | App 不提供。App 自带的运行时只供 App 自己使用，放在安装包内，不写进脚本安装目录，也不修改 PATH（2026-11-21 确认，取代早先"App 提供安装 ohbaby 命令"的设想） |
| CLI 与 App 并存 | 两边同版本发布、各自升级来保持一致。短暂不一致时，由下一行的弹窗和数据库降级提示兜底：CLI 提示 `ohbaby update`，App 提示更新 App（sidecar 因 `DatabaseNewerThanProgramError` 启动失败时，"启动失败"页识别出这个错误，给出更新入口；macOS 签名前只能打开 Release 页面）。App 不碰 PATH，因此不需要处理 npm 用户的 PATH 冲突 |
| 版本不一致 | 例如用户另有一份 npm 安装的旧版正在运行 serve，App 弹窗说明两个版本号和"正在运行的任务会被中断"，用户确认后才重启服务。不静默替换 |

参考依据（opencode，2026-11-21 核实）：

- 桌面端和 CLI 共用一条发布流水线（`.github/workflows/release.yml` 中 `build-desktop` 依赖 `build-cli`，两者使用同一个 `OPENCODE_VERSION`）。
- 桌面端把 CLI 二进制作为 extraResources 打进安装包。菜单里的"Install CLI"会把它装进 curl 安装脚本使用的同一个目录 `~/.opencode/bin/`。这一点我们不采用，App 和 CLI 分渠道发布、互不写入。
- 版本不一致时静默替换旧服务（`packages/client/src/service-probe.ts:22-32`）。CLI 那边也是 `mismatch: "replace"`，从代码推断，两个不同版本可能互相替换对方的服务（未实测）。我们改成弹窗确认，这样也符合"不自动杀掉旧 server"的既有规则。

## 6. 已确认：自改自测靠 `OHBABY_HOME` 隔离（2026-11-21）

用 ohbaby App 开发 ohbaby 本身时，可以同时测试开发版的 Web 服务，不需要改架构：

- 正式版 App 使用默认的 `~/.ohbaby`，用来写代码。
- 开发版用 `OHBABY_HOME=<开发目录>` 启动，pid、state、数据库都独立。4096 端口已被占用时自动换成随机端口。

App 开发版还需要两点：开发脚本自动设置 `OHBABY_HOME`；使用不同的 app id，否则会被正式版的单实例锁挡住。代价是开发实例的数据是隔离的，API key 需要单独配置。

参考：opencode 的开发版使用带 `.dev` 后缀的应用身份 `ai.opencode.desktop.dev`（`packages/desktop/electron-builder.config.ts:45`）。

## 7. 已确认：App 退出时 daemon 的去留（2026-11-21）

| 情况 | 处理 |
|---|---|
| daemon 由 App 启动，退出时没有其他客户端 | 随 App 一起关闭 |
| daemon 由 App 启动，退出时还有其他客户端（如浏览器里的 Web 页面） | 先弹窗提示"还有 N 个连接，关闭后它们会断开"，用户确认后再关闭。连接数用现有的 `GET /v1/connections` 查询 |
| daemon 是用户在终端里用 `ohbaby serve` 启动的 | App 只连接，退出时不关闭 |

参考：opencode 把服务以 detached 方式启动，App 退出后服务留在后台继续运行（`packages/client/src/service-contender.ts:19-43`，桌面端没有调用 `Service.stop`）。ZCode 退出时延迟关闭后端，严格策略下 7.5 秒后强制结束（`packages/desktop/src/main/appShutdownPolicy.ts:15`、`desktopHostProcess.ts:818-823`），其注释也提到强杀宿主进程会让 agent 的子进程变成孤儿（`desktopHostProcess.ts:814-816`）。deepseek-harness 也随窗口一起关闭后端。我们选随 App 关闭，用户关掉 App 后不会留下看不见的后台进程，这和默认 TUI"关窗口即释放"的思路一致。

实施要点（2026-11-22 审查后补充）：

| 要点 | 做法 |
|---|---|
| 识别"自己拉起的" daemon | App 把拉起时的 `{pid, token}` 写进自己的 userData，不只放在内存里。下次启动时和正在运行的 daemon 比对，对得上就当作 App 拉起的。这样 App 崩溃后留下的 daemon，下次启动仍归 App 管，不会被误当成用户在终端里启动的而一直留在后台；比对 token 也能避免 pid 被系统复用后认错进程。现有代码已经用 `{pid, token}` 识别 daemon（`packages/ohbaby-server/src/runtime/daemon/stop.ts` 的 `DaemonIdentity`） |
| 退出前检查 | 除了连接数，还要检查有没有正在运行的任务。daemon 已有空闲检查接口 `POST /api/shutdown/idle`（`packages/ohbaby-server/src/protocols/web/routes/system.ts:38`），忙时返回原因列表（运行中的任务、打开的 Web 终端等，见 `daemon/server.ts:426` 的 `checkIdleShutdown`）。连接数和这些原因合在一个弹窗里提示 |
| 怎么关 | 用户确认后，通过 daemon 自己的停止接口（`POST /api/shutdown`）优雅停止，由 daemon 清理 pty、bash 等子进程。壳不直接 kill sidecar，避免留下孤儿进程 |
| 只连接回环地址 | 用户在终端里启动的 serve 如果绑定的不是回环地址，daemon 不会向页面注入 token（`daemon/server.ts:239`、`static-assets.ts:49-51`），App 窗口会打不开。App 只连接绑定在回环地址上的 daemon，否则显示明确的错误 |

## 8. 已确认：busy 提示说明占用方（2026-11-21）

现在被拒时只报 `Session xxx already has active run(s): ...`，用户看不出会话被谁占着。

| 决策项 | 结论 |
|---|---|
| 判断方式 | run 账本已经记录了占用方的 `owner_pid`。被拒时拿它和当前进程的 pid 比较，不同就说明会话被另一个 ohbaby 进程占用 |
| 错误信息 | `SessionRunBusyError` 增加一个表示"被另一个进程占用"的字段，不加新的数据库列 |
| 提示文案 | Web/App 显示"这个会话正在另一个 ohbaby 窗口（通常是终端）里运行，等它结束后再发" |
| 不做精确分类 | 全局单 daemon 议题规划过 `ownerKind: "local-cli" \| "serve"`，本轮不做。全机只有一个 daemon，从 daemon 这边看，"另一个进程"基本就是终端，精确分类带来的好处抵不上多存一列数据的成本 |

## 9. 留到实现阶段实测

| 项 | 说明 |
|---|---|
| Web 是否能看到 TUI 的实时输出 | 代码中没有找到监听数据库外部变更的逻辑，推测只能刷新或重新同步后才看到。这不影响第 3 节的结论（默认 TUI 和 Web/App 只保证不双写），实测结果只决定界面上要不要加一句提示 |