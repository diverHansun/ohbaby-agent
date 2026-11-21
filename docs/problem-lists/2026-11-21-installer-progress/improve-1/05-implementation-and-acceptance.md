# 实施与验收

2026-11-21 在 `feat/installer-progress` 的当前工作区验收，基线为 `86473f63`。**独立复验结论为部分通过，发布门未通过。** Windows 原生运行新增卸载单测时有两条失败。另有 Windows 摘要问题已复现，详见下文。发布标准见 [04](04-test-and-acceptance.md#45-验收标准发布门)。

## 安装边界

当前脚本和 npm 安装交付 `ohbaby` 命令，用于启动默认的进程内 TUI，或通过 `ohbaby serve` 启动 Web 后台。脚本提供四步安装、Node.js 下载进度及摘要，`ohbaby update` 沿用目标版本脚本，`ohbaby uninstall` 在终端显示步骤并保留配置、会话和数据库。

桌面 App 通过独立的 Electron 安装包分发和更新，包内自带 Node SEA 运行时。CLI 和 App 各自管理安装文件，按同一版本发布，共用用户数据。Web 和 App 可连接同一个后台服务，TUI 用 `--remote-port` 加入同一后台。本次改动范围与两个 App 议题一致。见[多客户端与版本](../../2026-11-21-app-multi-client/improve-1/00-discussion.md)和[App 打包](../../2026-11-21-app-packaging/improve-1/00-discussion.md)。

## 首次验收

所有安装操作在临时 HOME、安装目录和数据目录内执行。测试用本机已有的 Node.js 24.22.3、当前分支构建出的 CLI 和 Web 文件、局部 npm 包及依赖。下载和版本分发来自本地素材，升级用本地响应替代 CDN 请求。测试期间使用真实的 `curl | sh` 入口、npm、CLI 启动器及升级和卸载代码。

| 场景 | 结果 |
|---|---|
| macOS 非 TTY 首次安装、同版本重跑、升级 | 通过。四步顺序、校验行、三种摘要状态和无控制字符输出符合预期。运行摘要里的 `export` 后可按命令名启动。实际执行 `ohbaby update 0.1.20 -y`，版本切换成功并保留上一版，出现脚本和 CLI 两条更新摘要。 |
| macOS 伪终端 | 通过。用分块文件下载替身验证 UTF-8 真彩色、ASCII 和 `NO_COLOR`、重定向后有长度和无长度、`TERM=dumb`、保留 npm 的原生 spinner。50 列通过 `COLUMNS=50` 验证文字回退。当前环境拒绝经 `/dev/tty` 读取大小，实际终端自动测宽留给正常环境测试。 |
| 取消与失败路径 | `curl \| sh` 中按 Ctrl-C 返回 130，dash 下向脚本发送 SIGTERM 返回 143。两次均结束测试下载子进程、恢复光标、清理下载目录及安装锁。归档校验失败时未发布运行时或启动器，PATH 写入失败返回 1，摘要仍打印，启动器可用。 |
| macOS 脚本和 npm 卸载 | 通过。脚本卸载无 `-y` 时要求确认，带 `-y` 时输出六个步骤，清除安装器的 PATH 配置块、启动器和安装目录，保留用户配置、会话和数据库。npm 全局卸载输出一个编号步骤、npm 自己的结果及完成提示。 |
| Web 和 TUI | CLI 包内有构建后的 Web 资源。实际启动器在伪终端绘制了默认 TUI 的初始界面。Web 应用、TUI 和服务端应用的三组单测及契约测试共 502 项通过。浏览器到后台的端到端连接受本地端口限制。 |
| 静态检查和相关单测 | `pnpm build`、`pnpm typecheck`、`pnpm lint`、改动涉及的 TypeScript 文件格式检查、`sh -n`、`dash -n`、`git diff --check` 通过。CLI 相关单测共 80 项通过。PowerShell 纯 ASCII 和启动器标记检查通过。 |

## 发现的问题

1. **Windows 的当前窗口提示可能误导。** 脚本更新的是执行脚本的 PowerShell 进程。`ohbaby update` 使用子 PowerShell 执行 `-File`，调用它的父终端不会因此刷新 PATH。若父终端未加载新 PATH，照摘要直接输入 `ohbaby` 仍可能找不到命令或运行旧副本。建议用一条适合两种入口的摘要，保留可直接调用的启动器路径，避免新增调用模式。见 [install.ps1](../../../../packages/ohbaby-cli/install.ps1#L593) 和 [update.ts](../../../../packages/ohbaby-cli/src/cli/commands/update.ts#L84)。
2. **W2 混用了两种 stderr 重定向。** 进度使用 `[Console]::Error`，`IsErrorRedirected` 看的是系统标准错误句柄。同一 PowerShell 进程执行 `irm … | iex 2>err.txt` 时，`2>` 捕获的是 PowerShell 错误流，按现实现仍会在控制台画进度。建议把进程级 stderr 重定向与 PowerShell 的错误流重定向分别列入验收，先确认产品需要保证哪一种行为。见 [install.ps1](../../../../packages/ohbaby-cli/install.ps1#L181) 和 [PowerShell 重定向说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection?view=powershell-5.1)。
3. **Unix 重跑误报本次写入了 shell 配置。** 在含安装器配置块、当前 PATH 尚未刷新时复现。配置块保持一份，摘要仍显示 `Added to ~/.zshrc`。改成 `Configured in …` 就能同时覆盖首次安装和重跑。见 [install.sh](../../../../packages/ohbaby-cli/install.sh#L536)。
4. **Windows 卸载摘要的 PATH 范围可写清楚。** 已执行的操作是删除注册表中的用户 PATH 项。现有终端仍可能解析到启动器，安装目录要等命令退出后手动删除。建议把摘要中的 `your PATH` 改为 `your user PATH`。见 [uninstall.ts](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.ts#L199)。
5. **Windows 的 `Start` 检查在严格模式下可能报错。** 若调用者启用了 `Set-StrictMode` 且已有同名函数或别名，`Get-Command` 的第一个结果可能没有 `Path` 属性。可先检查结果是不是应用程序，再读取路径。此项来自代码审查，待 Windows 复现。见 [install.ps1](../../../../packages/ohbaby-cli/install.ps1#L612)。

Windows 两条 PATH 提示与重定向差异来自代码审查。以上修改建议本轮仅记录，便于逐项确认。

### 首次验收环境的限制

- 两组 POSIX 安装器集成测试共 26 项，均在测试镜像启动时遇到本地端口 `listen EPERM`。上面的离线验证覆盖了核心路径，三平台 GitHub Actions 的结果仍待确认。
- 当前环境无法解析 `nodejs.org`，macOS 的公网下载及 Terminal.app、iTerm2 两套外观尚未复验。用户已报告树莓派 Ubuntu 和台式机跑过真机测试。独立复验尝试通过 `ssh hansun-pi` 和 `ssh hansun-desktop` 连接，两个连接均在建立前返回 `Operation not permitted`。未在远端创建测试文件。
- Windows 实跑用例在 macOS 跳过。PowerShell 5.1 和 7 的进度、Ctrl-C、PATH、卸载、代理与 PAC 待汇总到 [04 的真机清单](04-test-and-acceptance.md#l4-真机验收)。
- Pi 的默认配置目录无法创建信任锁，临时配置也没有可用模型，`copilot/gemini-4-neon` 未返回审核结果。独立代码审查的要点已并入上文。

## 2026-11-21 独立复验

使用本轮工作区构建的 CLI 和 Web 资源做测试包。已有依赖继续使用公开的 0.1.19 包。测试用的 0.1.20 仅改 CLI 包版本号。npm 使用回环测试源分发这两个包，升级命令的 CDN 脚本请求指向同一测试源。Node.js 归档和校验文件来自 nodejs.org。安装和数据使用临时路径。Windows 通过 `hansun-desktop-ts` 连接，局域网别名连接超时。

| 检查 | 实测结果 |
|---|---|
| macOS arm64 自动化 | 相关测试 34 项通过，Windows 专用用例跳过。全量单测 5,525 项通过、2 项跳过。构建、类型检查、相关格式检查、`sh -n` / `dash -n` 和 diff 检查通过。Lint 退出码为 0，报告 266 条警告。 |
| macOS arm64 安装与卸载 | 用 `curl \| sh` 下载并校验真实 Node.js 24.22.3。伪终端显示进度，重跑显示已安装，`ohbaby update 0.1.20 -y` 切换版本并保留上一版。安装后的 TUI 能启动并正常退出。内置浏览器打开了安装包提供的 Web 界面，从测试 daemon 加载工作区。脚本版卸载清掉启动器、PATH 配置块及安装目录，保留会话文件与独立 SQLite 文件。另在临时 npm 全局前缀验证了编号行、npm 自己的结果和卸载后的数据保留。 |
| Ubuntu aarch64 自动化 | 两组 POSIX 安装器集成测试共 24 项通过。测试确认 `/bin/sh` 是 dash，Ctrl-C 与 SIGTERM 均释放安装锁并关闭下载连接。 |
| Ubuntu aarch64 安装与卸载 | 树莓派经 SSH 伪终端用 `curl \| sh` 下载官方 Node.js 归档，观察到 UTF-8 进度条。SSH 在 npm 阶段断开。重新连接后复用已校验的私有 Node 完成首次安装及重跑，摘要含非登录 SSH 提示。执行 PATH 指引后可按命令名启动，`ohbaby update 0.1.20 -y` 成功。卸载输出五步，移除测试安装、启动器和配置块，保留会话和数据库标记文件。 |
| Windows x64 自动化 | 原生 Windows 安装器集成测试 2 项通过。卸载单测 5 项通过、2 项失败，失败用例模拟 macOS 后仍使用 Windows 路径。 |
| Windows 终端与下载 | 原生 PowerShell 5.1 和 7.7 经 SSH 终端运行 `irm \| iex`。回环慢速镜像提供官方 ZIP，5.1 在 936 下绘制 ASCII，7.7 在 65001 下绘制 Unicode。两种终端记录均观察到金色、正常颜色恢复和进度行清除。5.1 也完成公网 Node.js 下载和哈希校验。进程 stderr 重定向时无进度帧，同进程 PowerShell 的 `2>` 文件为空而控制台仍有进度。5.1 下载途中 Ctrl-C 清行并释放锁，随后重跑成功。 |
| Windows PATH、升级与卸载 | 在测试项上实际写入及删除用户 PATH，恢复后核对了原值。直接执行安装脚本时，当前 PowerShell 可以用 `ohbaby` 启动，重跑能识别已有 PATH。实际调用 `ohbaby update 0.1.20 -y` 成功切换版本并保留上一版。此时摘要说当前窗口已就绪，父终端实际仍解析到原命令。卸载打印单步及两种删除命令，用户 PATH 项已删除，父终端仍能解析待手动删除的启动器。执行手动删除后，会话和数据库标记文件均保留。 |

### 发布前需要处理的问题

1. **Windows CI 的两条卸载单测失败。** 测试用 `node:path` 的原生 `join` 构造路径，只切换了 `process.platform`。结果在 Windows 上给模拟 macOS 的格式化函数传入反斜杠路径，断言仍要求 `~/install` 和 `~/npm-global`。修正测试夹具即可。见 [卸载单测](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.unit.test.ts#L95)。
2. **Windows 安装后可能以错误退出。** 实机启用 `Set-StrictMode -Version Latest` 并定义一个同名 `ohbaby` 函数后，安装器在读第一个命令的 `.Path` 时抛错。摘要只需先确认找到的是 `Application`。见 [install.ps1](../../../../packages/ohbaby-cli/install.ps1#L612)。
3. **PATH 和重定向的文案要与实际行为一致。** Unix 复验再次观察到已有配置块时重跑仍显示 `Added to`。macOS 的第二个 bash 配置文件写入失败时，第一个文件可能已改，摘要却写 `Not changed`。Windows 真机已复现升级子进程提示 `Start ohbaby`，父终端仍运行原命令。摘要可以直接给出可运行的启动器路径。卸载结尾应写明清理的是用户 PATH。W2 应分别定义进程 stderr 与 PowerShell 错误流的行为。见 [Unix 摘要](../../../../packages/ohbaby-cli/install.sh#L585)、[Windows 摘要](../../../../packages/ohbaby-cli/install.ps1#L593)和 [Windows 卸载结尾](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.ts#L199)。
4. **T25 的带长度重定向用例可漏报。** 当前断言允许没有任何百分比帧。给返回长度的分支加一条必须有百分比帧的断言。当前解析也会把 `Content-Length:123` 和带前导零的合法长度降级为未知大小。见 [PTY 用例](../../../../tests/integration/cli/install-unix-tty.integration.test.ts#L320)。

四步输出、npm 自带 spinner 和现有激活、卸载机制能满足本轮主流程。POSIX 后台 curl 的结束、等待和光标恢复有两套 shell 的实测支撑。平台保留各自的小段显示代码即可。上述差异可以在路径夹具、文案和现有判断中修正。

### App 的安装边界和两项待补设计

- CLI 安装提供默认的进程内 TUI 和 Web 所需的 `ohbaby serve`。Electron 安装包负责自身的 sidecar、分发和更新。两条安装路径可以保持独立，共享同版本服务及用户数据。脚本安装 README 和本轮 02 §2.8 仍把「CLI 脚本改下载 SEA」写成 App 的后续工作，应按最新决定更新这两处。见 [脚本安装 README](../../2026-11-17-script-install/README.md)、[02 §2.8](02-optimization-plan-and-change-scope.md#28-不在本轮)和 [App 打包方案](../../2026-11-21-app-packaging/improve-1/00-discussion.md)。
- 多客户端方案第 6 节称仅设置 `OHBABY_HOME` 即可隔离数据库。当前默认 SQLite 路径仍走系统数据目录。开发版还需要显式设置 `OHBABY_DB_PATH` 或对应启动参数，并验证 TUI、daemon 和数据库迁移都落在测试范围。另需注意 CLI 维护检查可能从调用目录读旧的项目内 daemon 状态，测试脚本也应从隔离目录启动。见 [App 多客户端方案](../../2026-11-21-app-multi-client/improve-1/00-discussion.md#6-已确认自改自测靠-ohbaby_home-隔离2026-11-21)、[数据路径](../../../../packages/ohbaby-agent/src/paths/ohbaby-home.ts#L125)和 [daemon 范围](../../../../packages/ohbaby-server/src/runtime/daemon/scope.ts#L42)。
- CLI 更新、卸载会尝试停止同一 `OHBABY_HOME` 下的空闲 daemon。当前空闲检查覆盖运行中的任务和终端，普通 App 或 Web 连接仍可能断开。App 接入后应验收一个场景：App 可见且空闲时运行 CLI 维护命令，检查断线提示和重连。见 [CLI 维护检查](../../../../packages/ohbaby-cli/src/update/preflight.ts#L82)和 [daemon 空闲检查](../../../../packages/ohbaby-server/src/runtime/daemon/server.ts#L426)。

### 发布验收余项

- 当前工作区需要修复两条 Windows 单测后再跑 GitHub Actions 三平台矩阵。
- Windows 的系统代理、PAC 和与旧版的同网络速度对照尚未验收。受控镜像收到了 `ohbaby-installer` User-Agent。
- macOS 的输出已用真实下载及伪终端复验。Terminal.app 与 iTerm2 的双应用外观仍待看。Windows 终端外观以 SSH 终端记录为证据。
- 本轮升级复用了已校验的私有 Node。升级中重新下载 Node 的进度由单独的全新安装验证。测试包通过回环分发，尚无正式发布后的 CDN 与 npm 链路结果。

本地、树莓派和 Windows 的临时安装、数据、测试脚本和缓存已清理。核查了测试进程退出、回环端口释放和远端测试目录移除。Windows 用户 PATH 已恢复原值，两台远端机器的原有启动器仍能解析。

### 分批提交前复查

卸载单测现在用模拟平台的路径格式构造命令输入，实际临时文件仍用宿主平台的路径。macOS 上复跑安装器及卸载相关测试，37 项通过，跳过 1 项 Windows 专用用例。这次两条 Windows SSH 路径均连接超时，修正后的卸载单测仍待 Windows CI 或真机复核。
