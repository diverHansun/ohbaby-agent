# 5. 实施验收文档

本文对照 [02](02-optimization-plan-and-change-scope.md) 和 [04](04-test-and-acceptance.md) 验收 improve-1 的实施结果。实施会话的自测和真机记录收在 §5.7，结论以 §5.1 和 §5.5 为准。

## 5.1 元信息

| 项 | 值 |
|---|---|
| 议题 / 轮次 | 安装器进度显示 / improve-1 |
| 规划文档版本 | `817b0088` 首次入库。`6e7bba30` 在实施中修订了 00、02、04 的 Windows 摘要和 W2 定义，见 §5.3 |
| 实施范围 | `86473f63..6e7bba30`：`a57ae43a`（install.sh）、`4dfd230d`（install.ps1）、`b79d92c1`（uninstall）、`817b0088`（文档）、`6e7bba30`（Windows 摘要修正）。`f1fa5606` 是 App 议题文档，不在本轮 |
| 验收日期 | 2026-11-21 |
| 结论 | **部分通过。** 三个 Stage 的功能都已落地，本机全量测试、树莓派和 Windows 真机主流程通过。发布门未通过：HEAD 的 GitHub Actions Windows 作业失败（测试夹具问题，见 §5.5.2 #1），W8、W9、U3 仍未验收 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---|---|---|---|
| Stage 1 · 输出辅助函数（TTY、颜色、字符、宽度） | 完成 | 按 02 实现。stdout、stderr 分开判断颜色，`TERM=dumb` 不画进度 | [install.sh](../../../../packages/ohbaby-cli/install.sh)、T21–T24、T29 |
| Stage 1 · 4 个阶段行 | 完成 | 文案、位置与 02 表一致；第 1 步之前没有输出 | T1、T8 |
| Stage 1 · 后台 curl 下载进度条 | 调整 | 按 02 实现。另外让 `content_length` 跳过 3xx 响应头里的长度（02 只要求取最后一段），因为树莓派真机发现轮询时会读到重定向自带的非零长度 | [install.sh#L62](../../../../packages/ohbaby-cli/install.sh#L62)、T25 |
| Stage 1 · 收尾行、清理与 Ctrl-C | 完成 | trap 恢复光标、结束 curl、删下载目录和锁；INT 返回 130，TERM 返回 143 | T26、T27，真机 U1、U2 |
| Stage 1 · 成功摘要与 `Start` 行 | 部分 | 三种首行和 `Start` 判断与 02 一致。重跑时 PATH 行仍说 `Added to`，与实际不符，见 §5.5.2 #3 | [install.sh#L585](../../../../packages/ohbaby-cli/install.sh#L585) |
| Stage 2 · `Write-Stage` 和阶段行 | 完成 | 与 sh 同一套文案 | W1，Windows CI 的 ASCII 用例 |
| Stage 2 · `HttpWebRequest` 分块下载 | 完成 | 64 KB 缓冲、250 ms 重画、`ohbaby-installer` User-Agent、`finally` 恢复颜色并清行 | W1、W3–W7，受控镜像测速 |
| Stage 2 · 成功摘要 | 调整 | `Start` 由"按 `Get-Command` 判断"改为固定输出 `& '<启动器>'`；PATH 行改为"打开新终端"。原因是升级子进程和严格模式下的真机问题，02 已同步修订 | `6e7bba30`、W11 |
| Stage 3 · 步骤行、`done`/`failed`、npm 行 | 完成 | `UninstallStep` 类型排除 `windows-manual`，手动删除命令移到步骤之后 | T40–T46 |
| Stage 3 · 颜色与 `isStdoutTTY` | 完成 | 用局部 `Chalk` 实例，不影响全局 chalk | [uninstall.ts](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.ts) |
| 收尾 · 发布说明 | 完成 | `unreleased.md` 新增 4 条。最后一条是发布前检查，不是面向用户的变更，见 §5.5.2 #10 | [unreleased.md](../../../releases/unreleased.md) |
| 2.4 · CI、`@lydell/node-pty` | 完成 | CI 的 Installer scripts 步骤加入 TTY 测试文件 | [ci.yml](../../../../.github/workflows/ci.yml) |

越界扫描：diff 中没有 02 未提及的代码改动。`serve.unit.test.ts` 多一行，是给测试 runtime 补 `isStdoutTTY`。

## 5.3 规划 vs 实际差异

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
|---|---|---|---|---|
| 数据结构 | 02 §Stage 3：步骤类型由 `UninstallAction` 派生 | 新增 `UninstallStep = Exclude<UninstallAction, windows-manual>`，`windows-manual` 拆成独立分支 | 让手动删除不进入编号步骤，由类型保证 | 正面。编译期就挡住"手动步骤被编号" |
| 数据流 | 02 §Stage 1-3：取最后一段响应头的 `Content-Length` | 同时跳过 3xx 段的长度 | 真机重定向响应带正文和真实长度，轮询时会把它当成总大小 | 修好一个真实缺陷。`Content-Length:123`（无空格）和带前导零的长度会被当作未知大小，只显示 MB，无害 |
| 协议 / 接口 | 规划初版：Windows `Start` 按 `Get-Command` 结果显示 `ohbaby` 或路径；W2 只看 `IsErrorRedirected` | 固定输出 `& '<启动器>'`；W2 区分进程 stderr 与 PowerShell 错误流 | `ohbaby update` 在子 PowerShell 里运行，父终端 PATH 不刷新；严格模式下读 `.Path` 会抛错 | 更可靠，代价是 Windows 用户总看到一条较长的命令。实施会话改了 00、02、04，属于规划修订，应由用户确认过 |
| 文件 / 包结构 | 02 §2.4 | 一致。新增 `install-unix-tty.integration.test.ts` 和 `uninstall.unit.test.ts` | — | 无 |
| 错误处理 / 边界 | 02 §Stage 1-5：PATH 写入失败时摘要照常打印 | 一致。但 macOS bash 写完 `.bashrc`、写 `.bash_profile` 失败时，摘要显示 `Not changed` | 部分写入没有单独的文案 | 低。极少见，警告行已写到 stderr |
| 依赖变更 | 根 `devDependencies` 加 `@lydell/node-pty` | 一致，版本与 ohbaby-server 相同 | — | 只影响测试 |

## 5.4 实施理由与注意事项

- **sh 的后台 curl 和轮询**沿用 opencode 的做法，只依赖 POSIX sh 和 curl。代价是要自己管 curl 的结束和 Ctrl-C，trap 里已按"先结束 curl、再删目录和锁"的顺序处理。改这段代码时要保持这个顺序。
- **3xx 长度过滤**是树莓派真机上发现的。旧实现只取最后一段响应头，但轮询时 curl 可能刚写完重定向那段，百分比会按一个 154 字节的总大小计算。T25 的夹具已改成带正文和真实长度的 302，并让最终响应延迟 600 ms，能在旧解析上复现失败。
- **Windows `Start` 固定给启动器命令**是因为脚本看不到调用它的终端：`irm | iex` 时是同一进程，`ohbaby update` 时是子进程。固定给出可复制的命令，在两种入口下都对。
- **W2 的两种重定向**：`powershell ... 2>err.txt`（进程级）关闭进度；同进程 `iex ... 2>err.txt` 只重定向 PowerShell 错误流，控制台仍画进度、文件为空。发布说明已写明后一种行为。
- **Windows CI 与本地结果不一致的原因**：本地 Windows 用户名没有 8.3 短名，CI 的 `runneradmin` 有（`RUNNER~1`）。断言里的路径来自 `tmpdir()`，脚本打印的是展开后的长路径。以后在 Windows 测试里比较脚本输出的路径时，要先把临时目录转成长路径。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

验收会话在 HEAD `6e7bba30`、macOS arm64 上复跑：安装器和卸载相关测试 34 项通过、1 项跳过（Windows 专用）；全量单测 5,525 项通过、2 项跳过；`pnpm typecheck` 通过；`pnpm lint` 0 错误、266 条警告；`sh -n`、`dash -n` 通过；`install.ps1` 纯 ASCII。GitHub Actions 结果见下表的 CI 行。

**L1 非 TTY（T1–T11）**

| ID | 结果 | 证据与说明 |
|---|---|---|
| T1、T2、T3 | 通过 | `install-unix` "installs and reruns"；Windows 主用例。顺序用 `expectInOrder` 检查，空行没有严格断言 |
| T4 | 部分 | Unix 四种情况都有断言。Windows 的 `is already in your user PATH` 和 `Added to your user PATH` 没有自动化断言（所有 Windows 用例都设了 `OHBABY_NO_MODIFY_PATH=1`），由真机 W11 覆盖 |
| T5 | 通过 | Unix 三种情况；Windows 严格模式、同名函数、含 `'` 和中文的路径 |
| T6 | 部分 | Unix 断言 stderr 为空。Windows 只断言 stdout 无控制字符，没有断言 stderr 为空 |
| T7 | 通过 | Unix 断言旧三行已删除。Windows 断言旧的两种提示已删除。04 写的"不含安装目录路径"与新摘要的 `Launcher` 行冲突，04 措辞应修订 |
| T8、T10、T11 | 通过 | — |
| T9 | 部分 | 只有"早期 daemon 检查失败"证明了 stderr 只有一行错误、stdout 无摘要。其他失败路径只用 `stringContaining` |

**L2 PTY（T20–T29）**

| ID | 结果 | 证据与说明 |
|---|---|---|
| T20、T22、T23、T24、T28、T29 | 通过 | `install-unix-tty` 对应用例 |
| T21 | 通过（偏弱） | 帧宽 24 格、只含 `#` 和 `-`，但没断言出现过 `#` |
| T25 | 部分 | 无长度的分支可靠。有长度的分支允许全程只有 MB 帧，百分比检查在 `if` 里，可以空过。04 要求的 `Content-Length: 0` 重定向没有单独用例（解析逻辑已覆盖这种情况） |
| T26、T27 | 通过（有保留） | macOS 的 `/bin/sh`、`/bin/dash` 和 Ubuntu CI 的 dash 都跑过，退出码、`\x1b[?25h`、锁和下载目录都有断言。保留意见：测试里 sh 是会话首进程，它退出时内核会给前台进程组发 SIGHUP，curl 即使没被 trap 结束也会断开，所以"连接已关闭"这条断言证明不了 trap 生效。此推断未做实验验证。真机 Ctrl-C（`curl | sh`，交互 shell 仍在）已确认锁释放、下载结束 |

**L3 卸载（T40–T46）**：全部通过，在三个平台上都能跑（用模拟 `process.platform`）。T43 把 npm 输出模拟成空，04 §4.3 说的"npm 输出与步骤行交错"没有自动化覆盖，由 U5 和 W12 真机覆盖。

**4.4 回归**：目录布局、锁、PATH 失败退出 1、损坏下载不发布、ASCII、`script-uninstall` 原有用例都在。下载失败提示里的代理和 `OHBABY_NODE_MIRROR`、`OHBABY_NON_INTERACTIVE=1` 跳过 npm 副本询问、非 TTY 卸载不带 `-y` 报错，这三项没有测试，代码未改动，风险低。

**L4 真机与发布门（04 §4.5）**

| 项 | 结果 | 证据 |
|---|---|---|
| CI 三平台 | **未通过** | 运行 `44916993222`：macOS、Ubuntu 通过；Windows 在 Installer scripts 步骤失败，`Start` 行断言用 `RUNNER~1` 短路径，脚本输出长路径。Windows 作业后续的 typecheck、lint、单测、build 都没有执行 |
| T26 在 macOS 和 Linux | 通过 | 同一次运行的 macOS、Ubuntu 作业 |
| W1–W7、W10–W12 | 通过 | §5.7。W7 在系统手动代理下完成下载，User-Agent 在受控镜像上确认，未看到代理日志 |
| W8 PAC | 未做 | 台式机没有配置 PAC |
| W9 速度 | 部分 | 受控限速镜像：旧 7.15 / 7.36 秒，新 7.15 / 7.13 秒。公网对照未完成 |
| U1、U2、U4、U5 | 通过 | macOS、树莓派真机，§5.7 |
| U3 Terminal.app、iTerm2 | 未做 | — |
| 发布说明 | 通过 | `unreleased.md` |

### 5.5.2 SWE 层面评估（聚焦改动面）

总体看，这一轮改动守住了 KISS。三个 Stage 各改一个文件或一个命令，没有为了"两个平台共用"去造抽象，每个平台保留一小段自己的显示代码。输出流分工清楚：进度只走 stderr，摘要只走 stdout，非 TTY 下的输出和以前一样干净。卸载侧用类型把"手动步骤"排除在编号之外，比运行时判断更稳。sh 的后台进程管理是全轮最复杂的部分，trap 顺序、`set -e` 下的 `wait` 写法、dash 除零都按 02 处理了，并有两种 shell 的自动化和真机证据。

剩下的问题集中在两类：一是测试断言强度不够或与环境耦合，二是几处摘要文案和实际状态对不上。都不涉及架构，修起来是局部改动。

| # | 发现 | 严重性 | SWE 依据 | 建议 |
|---|---|---|---|---|
| 1 | Windows 集成测试用 `tmpdir()` 拼期望路径，CI 上是 8.3 短路径，与脚本输出的长路径不符，导致 Windows 作业失败、后续步骤全部跳过。见 [install-windows 测试#L39](../../../../tests/integration/cli/install-windows.integration.test.ts#L39) | 高（阻塞发布门） | 测试与运行环境耦合；本地通过不能代表 CI | 用 `realpath.native(root)` 得到长路径再拼 `installDir`，或在比较前统一展开。修后重跑三平台 CI |
| 2 | Windows 作业因 #1 没有跑 typecheck、lint、全量单测和 build，Windows 上这些检查在 HEAD 没有 CI 证据 | 高（随 #1 解决） | 发布门要求三平台全绿 | 修 #1 后确认完整运行 |
| 3 | Unix 重跑时，配置块已存在，PATH 行仍显示 `Added to …`。见 [install.sh#L585](../../../../packages/ohbaby-cli/install.sh#L585) | 中 | 摘要要反映实际状态（02 §2.6"摘要误导用户"） | 改成 `Configured in …`，首次和重跑都成立；或者让 `append_path_block` 返回是否真的写入 |
| 4 | macOS bash 写入 `.bashrc` 成功、`.bash_profile` 失败时，摘要显示 `Not changed`。见 [install.sh#L572](../../../../packages/ohbaby-cli/install.sh#L572) | 低 | 同上 | 失败时保留已写入的文件名，例如 `Added to ~/.bashrc; could not update ~/.bash_profile` |
| 5 | T25 有长度的用例可以在没有任何百分比帧的情况下通过。见 [install-unix-tty 测试#L327](../../../../tests/integration/cli/install-unix-tty.integration.test.ts#L327) | 中 | 断言必须能在目标缺陷存在时失败 | 对 `redirect-length` 断言至少出现一帧百分比；补一个 `Content-Length: 0` 的 302 用例，与 04 对齐 |
| 6 | T26、T27 的"连接关闭"可能由 SIGHUP 而非 trap 造成（推断，未实验） | 低 | 测试应能区分修复前后 | 断言连接关闭早于 PTY 退出，或检查 curl PID；也可以让 PTY 里的外层 shell 比脚本活得久 |
| 7 | Windows 缺少 T4 两种 PATH 文案和 T6 stderr 为空的断言 | 低 | 04 写明了 Windows 也要覆盖 | 加一个 `OHBABY_NO_MODIFY_PATH=0`、隔离注册表项的用例，或至少断言 stderr 为空 |
| 8 | T9 的多数失败路径没断言 stdout 无摘要；三个回归项没有测试 | 低 | 回归清单要能被自动发现 | 在现有失败用例里补 `expect(stdout).not.toContain("Launcher")`；回归项可后续补 |
| 9 | 卸载结尾写 `removed from your PATH`，实际删的是用户 PATH。见 [uninstall.ts#L201](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.ts#L201) | 低 | 与安装摘要的"user PATH"用词一致 | 改成 `your user PATH` |
| 10 | `unreleased.md` 第 4 条是发布前检查，不是用户能感知的变更 | 低 | 发布说明面向用户 | 移到发布检查清单或 04 §4.5 |
| 11 | 04 T7 要求 stdout 不含安装目录路径，与新摘要的 `Launcher` 行冲突 | 低 | 规划文档自相矛盾 | 回规划模式把 T7 改成"不含旧的三行" |
| 12 | `Content-Length:123` 和前导零长度被当作未知大小 | 极低 | 失败方向安全，只少了百分比 | 不改 |

建议修复顺序：#1（解锁发布门）→ #3、#5 → #9、#4、#7 → 其余随手处理。#11 需要回到规划模式修订 04。

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|---|---|---|
| [install.sh](../../../../packages/ohbaby-cli/install.sh) | 显示状态初始化、`stage`、后台 curl 进度条、3xx 长度过滤、trap 清理、统一摘要 | 修改（+188 / −13） |
| [install.ps1](../../../../packages/ohbaby-cli/install.ps1) | `Write-Stage`、`HttpWebRequest` 分块下载与进度、`Add-InstallPath` 返回值、统一摘要和启动命令 | 修改（+120 / −13） |
| [uninstall.ts](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.ts) | 步骤行、`done`/`failed`、金色编号、Windows 手动删除命令后置、结尾文案 | 修改（+76 / −17） |
| [uninstall-plan.ts](../../../../packages/ohbaby-cli/src/install/uninstall-plan.ts) | `UninstallStep` 类型、`describeUninstallStep` | 修改 |
| [types.ts](../../../../packages/ohbaby-cli/src/cli/commands/types.ts)、[bin.ts](../../../../packages/ohbaby-cli/src/bin.ts) | runtime 增加 `isStdoutTTY` | 修改 |
| [uninstall.unit.test.ts](../../../../packages/ohbaby-cli/src/cli/commands/uninstall.unit.test.ts) | T40–T46 | 新增 |
| [install-unix-tty.integration.test.ts](../../../../tests/integration/cli/install-unix-tty.integration.test.ts) | T20–T29，含重定向和 Ctrl-C | 新增 |
| [install-unix.integration.test.ts](../../../../tests/integration/cli/install-unix.integration.test.ts)、[install-windows.integration.test.ts](../../../../tests/integration/cli/install-windows.integration.test.ts) | L1 新文案、严格模式与特殊路径 | 修改 |
| [ci.yml](../../../../.github/workflows/ci.yml)、根 `package.json`、`pnpm-lock.yaml` | CI 跑 TTY 测试；加 `@lydell/node-pty` | 修改 |
| [unreleased.md](../../../releases/unreleased.md) | Installer progress 一节 | 修改 |

## 5.7 真机与自测记录

所有安装都在临时 HOME、安装目录和数据目录里进行，结束后已清理，远端用户 PATH 已恢复原值。0.1.20 只是回环测试源里的临时版本，用于验证升级，仓库版本仍是 0.1.19。

| 环境 | 做了什么 | 结果 |
|---|---|---|
| macOS arm64（实施会话） | 真实 `curl \| sh` 从 nodejs.org 下载；伪终端看进度；重跑；`ohbaby update 0.1.20 -y`；TUI 启动退出；内置浏览器打开安装包里的 Web；脚本卸载和 npm 卸载 | 通过。Ctrl-C 返回 130，dash 下 SIGTERM 返回 143，锁和下载目录都清掉 |
| 树莓派 Ubuntu aarch64（`/bin/sh` 为 dash） | 两组 POSIX 集成测试 24 项；SSH 伪终端真实下载；首次安装、重跑、重定向长度、ASCII、窄终端、Ctrl-C；真实 0.1.18 → 0.1.19 升级；卸载五步 | 通过。在这里发现 3xx 长度缺陷并修复，T25 夹具同步加强。摘要末尾有非登录 SSH 提示 |
| Windows x64，PowerShell 5.1（代码页 936） | `irm \| iex` 走回环慢速镜像和公网；系统手动代理下载；严格模式首次安装、重跑、升级、卸载；Ctrl-C | 通过。ASCII 进度条、金色、颜色恢复、清行；Ctrl-C 释放锁后重跑成功；父终端旧 PATH 时复制 `Start` 能启动新版本 |
| Windows x64，PowerShell 7.7（UTF-8） | 同进程 `2>` 安装；Ctrl-C | 通过。Unicode 进度条，错误流文件为空，`Start` 命令实跑通过 |
| Windows 自动化（台式机） | Node 25.6.0 和 24.22.3 各跑 12 项 Windows 安装器和卸载测试 | 通过。注意：台式机用户名没有 8.3 短名，所以没复现 CI 的 #1 |

实施过程中发现并已修复的问题：卸载单测在 Windows 上用宿主平台路径模拟 macOS；Windows 严格模式下读 `Get-Command` 结果的 `.Path` 报错；Windows 升级子进程里说"当前窗口已就绪"误导父终端；W2 两种重定向未区分；重定向响应的 `Content-Length` 被当成总大小。

## 5.8 本轮以外的记录

以下事项来自实施会话的观察，不属于本议题，供相关议题跟进：

- [脚本安装 README](../../2026-11-17-script-install/README.md) 和本轮 [02 §2.8](02-optimization-plan-and-change-scope.md#28-不在本轮) 仍写着"CLI 脚本改下载 SEA"。按 [App 打包方案](../../2026-11-21-app-packaging/improve-1/00-discussion.md)，CLI 和 App 各自安装，这两处应更新。
- [App 多客户端方案](../../2026-11-21-app-multi-client/improve-1/00-discussion.md) 第 6 节说只设 `OHBABY_HOME` 就能隔离数据库，但默认 SQLite 路径仍走系统数据目录（[ohbaby-home.ts](../../../../packages/ohbaby-agent/src/paths/ohbaby-home.ts#L125)），还需要 `OHBABY_DB_PATH`。
- CLI 更新、卸载会停止同一 `OHBABY_HOME` 下的空闲 daemon（[preflight.ts](../../../../packages/ohbaby-cli/src/update/preflight.ts#L82)），App 或 Web 连接可能被断开。App 接入后应验收这个场景的提示和重连。
