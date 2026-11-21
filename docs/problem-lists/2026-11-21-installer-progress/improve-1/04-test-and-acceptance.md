# 测试与验收

> 本文是验收依据，方案见 [02](02-optimization-plan-and-change-scope.md)。测试分四层，2026-11-21 确认（00 §2.5）。

## 4.1 测试范围

| 层 | 覆盖什么 | 放在哪里 | 在哪里跑 |
|---|---|---|---|
| L1 非 TTY 输出 | 阶段行、下载收尾行、成功摘要的文字和顺序；stdout 和 stderr 的分工；没有颜色码和 `\r` | 扩展 `tests/integration/cli/install-unix.integration.test.ts` 和 `install-windows.integration.test.ts` | CI 三个平台，"Installer scripts" 步骤 |
| L2 TTY 显示 | `install.sh` 的进度条、字符和颜色的选择、窄终端、没有总大小、Ctrl-C 清理 | 新增 `tests/integration/cli/install-unix-tty.integration.test.ts` | CI 的 macOS 和 Linux，加进 "Installer scripts" 步骤 |
| L3 卸载输出 | 步骤行、`done` 和 `failed`、结尾文案 | 新增 `packages/ohbaby-cli/src/cli/commands/uninstall.unit.test.ts` | CI 的 `pnpm test:unit` |
| L4 真机验收 | Windows 的显示效果和代理；macOS、Linux 的真实下载；`ohbaby update` | 手动，结果写进 05 | Windows 实机、macOS、树莓派 |

不做的测试：

- Windows 的 TTY 显示不做自动化。ConPTY 在 CI 上不稳定，而这部分风险主要是"看起来对不对"，断言测不出来，交给 L4。
- 不测具体颜色值和进度条每一帧的内容。L2 只检查关键片段出现与否。

## 4.2 关键场景与用例

### L1 非 TTY 输出

现有测试用 `execFile` 运行脚本，stdout 和 stderr 都是管道，正好是非 TTY 场景。在现有用例上加断言，尽量不新增用例。

| ID | 场景 | 验证点 | Stage |
|---|---|---|---|
| T1 | 全新安装 | stdout 依次出现 `[1/4] Checking the current installation`、`[2/4] Downloading Node.js 24.22.3 for <平台>`、收尾行 `Node.js 24.22.3 … verified`、`[3/4] Installing ohbaby <版本>`、`[4/4] Activating ohbaby <版本>`、空行、`Installed ohbaby <版本>.`、`Launcher`、`PATH`、`Start` 行 | 1、2 |
| T2 | 用同一版本重跑 | 第 2 步是 `Node.js 24.22.3 is already present`；第 3 步是 `ohbaby <版本> is already installed`；摘要第一行是 `ohbaby <版本> is already installed.` | 1、2 |
| T3 | 从 A 版本切换到 B 版本 | 摘要第一行是 `Updated ohbaby from A to B.` | 1、2 |
| T4 | PATH 的四种情况 | Unix 已在 PATH：包含 `is already in PATH`；Windows 已在用户 PATH：包含 `is already in your user PATH`；sh 刚写入：`Added to ~/.zshrc. For this terminal, run: export PATH=`；`OHBABY_NO_MODIFY_PATH=1`：`Not changed.`；sh 识别不出 shell：`Not changed.`。Windows 刚写入：`Added to your user PATH. Open a new terminal to use the updated PATH.` | 1、2 |
| T5 | `Start` 行 | Unix 沿用命令名或路径判断。Windows 总是输出带引号的完整 PowerShell 启动命令，严格模式下已有同名函数也能完成安装 | 1、2 |
| T6 | 输出流 | 成功安装时 stderr 为空（现有断言保留，不放宽）；stdout 里没有 `\x1b` 和 `\r` | 1、2 |
| T7 | 旧提示已删除 | stdout 里没有 `Activated ohbaby`、`Launcher: `、安装目录路径 | 1、2 |
| T8 | 第 4 步出现警告（PATH 写入失败，现有用例） | 警告在 stderr；摘要仍然打印；退出码为 1 | 1 |
| T9 | 失败路径（registry 失败、校验失败、daemon 检查失败等现有用例） | stderr 只有 `ohbaby installer:` 开头的错误；stdout 里没有摘要；安装锁已释放（daemon 检查失败发生在下载之前，可以顺带证明新增变量已在 trap 前初始化） | 1 |
| T10 | Linux | 摘要最后一行是非登录 SSH 的提示 | 1 |
| T11 | ps1 文件 | 仍然是纯 ASCII（现有用例） | 2 |

### L2 TTY 显示（`install.sh`）

用 `@lydell/node-pty` 在伪终端里运行 `install.sh`。pnpm 的隔离布局下 `tests/` 引用不到 ohbaby-server 的依赖，所以把它加为根目录的 devDependency，版本与 ohbaby-server 相同（02 §2.4）。不用系统的 `script` 命令，因为 macOS 和 Linux 上它的参数不一样。本地测试服务器分块、带延迟地返回压缩包，让轮询至少能看到几次中间状态。

| ID | 场景 | 验证点 | Stage |
|---|---|---|---|
| T20 | UTF-8、80 列、有 `Content-Length` | 输出里出现 `━`、`%`、`MB`；结束后有 `\r\x1b[K` 清行和 `\x1b[?25h` 恢复光标；之后出现收尾行；进度条的内容只出现在 stderr 对应的输出里（PTY 合并了两条流时，改为检查收尾行之后不再有 `━`） | 1 |
| T21 | `LANG=C`、`LC_ALL` 和 `LC_CTYPE` 未设置 | 出现 `#` 和 `-`，没有 `━` | 1 |
| T22 | `NO_COLOR=1` | 没有 `\x1b[3`、`\x1b[38;2` 这类颜色码；光标控制码仍然有 | 1 |
| T23 | 服务器不返回 `Content-Length`（chunked） | 没有进度条字符，只有 `MB` | 1 |
| T24 | 50 列 | 没有进度条字符，有百分比 | 1 |
| T25 | 服务器先返回带 `Content-Length: 0` 的 302，再返回文件；另一个用例里最终响应不带长度 | 脚本不报错、正常装完；第一种情况百分比不超过 100%；第二种情况按没有总大小处理，只显示 `MB` | 1 |
| T29 | `TERM=dumb` | 没有进度条字符、`\r` 和光标控制码 | 1 |
| T26 | 下载中途发 Ctrl-C | 退出码 130；后台 curl 已经结束（测试服务器看到这条下载连接被关闭；服务器一直慢速发送、不主动结束响应，所以连接关闭只可能是 curl 退出）；安装锁目录已删除；临时下载目录已删除；输出里有 `\x1b[?25h` | 1 |
| T27 | 下载中途发 SIGTERM 给脚本 | 退出码 143；curl 已结束；锁已释放 | 1 |
| T28 | 私有 Node 已存在 | 没有进度条，第 2 步是 `is already present` | 1 |

T26 是本轮风险最高的用例，必须在 macOS 和 Linux（dash）上都通过。

### L3 卸载输出

在 `uninstall.unit.test.ts` 里用假的 runtime 和临时目录驱动命令，捕获 stdout 和 stderr。

| ID | 场景 | 验证点 | Stage |
|---|---|---|---|
| T40 | macOS 脚本安装，`-y` | 每个 action 一行 `[i/N] … done`，N 等于 action 数；最后是 `ohbaby is uninstalled.` 和 `Kept your configuration at …` | 3 |
| T41 | Linux 脚本安装 | N 比 macOS 少一步（没有 `.bash_profile`） | 3 |
| T42 | Windows 脚本安装 | `windows-manual` 不算一步，N 为 1；结尾是 `ohbaby is removed from your PATH. To finish, …`，接着是 PowerShell 和 cmd 的删除命令，再是 `Kept your configuration` | 3 |
| T43 | npm 安装 | `[1/1] Uninstalling ohbaby-cli from <prefix>` 单独成行，后面没有 `done`；最后是 `ohbaby is uninstalled.` | 3 |
| T44 | 某一步失败（比如目录删除抛错） | 该行以 `failed` 结尾；stderr 有错误信息；退出码为 1；没有 `ohbaby is uninstalled.` | 3 |
| T45 | 用户在确认提示里回答 n | 只有计划列表，没有步骤行 | 3 |
| T46 | `isStdoutTTY` 为 false，或设置了 `NO_COLOR` | 没有颜色码；`isStdoutTTY` 为 true 时编号带颜色 | 3 |

### L4 真机验收

**Windows**（00 §2.1.1 列出的各项）。每一项都在 Windows PowerShell 5.1 和 PowerShell 7 下各做一次，除非另有说明：

| ID | 检查项 | 通过标准 |
|---|---|---|
| W1 | `irm … \| iex` 全新安装 | 进度条正常刷新、不折行；结束后清掉并出现收尾行；摘要正确 |
| W2 | 区分进程 stderr 与 PowerShell 错误流 | 进程 stderr 连接终端时，`irm \| iex` 和 `powershell -File` 可见进度。重定向 PowerShell 进程的 stderr 时不画进度。同进程执行 `irm … \| iex 2>err.txt` 时终端仍可见进度，文件没有进度内容 |
| W3 | 中文系统（代码页 936） | 用 `#` 和 `-`，进度条不折行 |
| W4 | Windows Terminal 下 `chcp 65001` | 用 `━` 和 `─` |
| W5 | 配色 | 金色编号和进度条可读；中断或完成后，控制台颜色恢复原样 |
| W6 | 下载中途 Ctrl-C | 进度条行被清掉，颜色恢复；重跑能成功；锁已释放 |
| W7 | 系统代理（手动设置的代理服务器） | 下载成功；代理日志里请求带 `ohbaby-installer` User-Agent（能看到日志时） |
| W8 | PAC 脚本 | 下载成功 |
| W9 | 下载速度 | 与改动前的版本相比，同一网络下用时没有明显增加（差距在 20% 以内） |
| W10 | `ohbaby update` | 能看到阶段行和进度条；最后是脚本摘要加 update 自己的 `Updated ohbaby to X.` |
| W11 | 已在用户 PATH、刚写入用户 PATH、升级后的父终端 | PATH 行描述用户 PATH 的变更。父终端 PATH 尚未更新时，仍可复制 `Start` 命令启动新版本 |
| W12 | `ohbaby uninstall` | 步骤行和结尾文案与 T42 一致 |

**macOS 和 Linux**：

| ID | 检查项 | 通过标准 |
|---|---|---|
| U1 | macOS 上真实 `curl … \| sh`，从 nodejs.org 下载 | 进度条、收尾行、摘要正确；`export` 命令复制运行后，当前终端能直接用 `ohbaby` |
| U2 | 树莓派上真实 `curl … \| sh` | 同 U1；摘要最后有 SSH 提示 |
| U3 | Terminal.app 和 iTerm2 各看一次 | `COLORTERM` 是 `truecolor` 或 `24bit` 时显示真彩色金色，否则退回黄色；两种情况都清晰可读 |
| U4 | `ohbaby update` | 同 W10 |
| U5 | `ohbaby uninstall` | 与 T40 或 T41 一致 |

## 4.3 集成边界

| 边界 | 风险 | 由哪些用例覆盖 |
|---|---|---|
| 安装脚本和 curl 子进程 | Ctrl-C 后 curl 残留 | T26、T27 |
| 安装脚本和 npm | npm 的 spinner 被关掉，或输出被吞掉 | U1、U2（测试用的假 npm 不输出 spinner，只能真机看）；代码审查确认 `npm install` 的参数和重定向没有变化 |
| `ohbaby update` 和安装脚本 | update 下的流被重定向，进度条不显示 | W2、W10、U4 |
| ps1 和 .NET 网络栈 | 代理、PAC、TLS 行为变化 | W7、W8 |
| 卸载命令和 npm | npm 输出和步骤行交错 | T43 |

## 4.4 回归清单

下面这些行为本轮不能变，现有测试已经覆盖的保持通过即可：

- 安装目录布局、`current` 指针、启动器内容。
- 安装锁的获取、释放和异常时的回收（`install-unix` 的锁相关用例）。
- 第 4 步出错时保留新旧两个版本、退出码为 1（`reports a failed PATH step after switching and keeps both versions`）。
- 校验失败时不发布 runtime（`refuses a damaged Node download before publishing a runtime`）。
- 下载失败时的错误文案仍然提示代理和 `OHBABY_NODE_MIRROR`。
- `OHBABY_NON_INTERACTIVE=1` 时不询问是否删除 npm 副本。
- ps1 文件纯 ASCII。
- `ohbaby uninstall` 确认前的计划列表不变；非交互终端不带 `-y` 时仍然报错。
- `script-uninstall.unit.test.ts` 的现有用例。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|---|---|---|
| CI | 三个平台的 "Installer scripts" 步骤和 `pnpm test:unit` 全部通过，包括新增的 L1、L2、L3 用例 | GitHub Actions |
| Ctrl-C | T26 在 macOS 和 Linux 上都通过 | CI |
| Windows 真机 | W1–W12 全部通过；W7、W8 至少在一台有代理的机器上做过 | 结果写进 05 |
| macOS 和 Linux 真机 | U1–U5 全部通过 | 结果写进 05 |
| 发布说明 | `docs/releases/unreleased.md` 已更新 | 人工检查 |

Windows 真机项没做完，不发布。

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|---|---|---|
| **sh 的信号处理**：后台 curl 在 Ctrl-C、终端关闭（HUP）、`kill`（TERM）时残留，继续往已删除的目录里写；或者清理顺序不对，锁先被释放，另一个安装进程进来时旧 curl 还在跑 | `cleanup_on_exit` 先 `kill` 加 `wait` curl，再删临时目录、释放锁；T26、T27 | SIGKILL 无法处理，curl 会残留到下载结束。它写的是临时目录，下次运行会重新创建，不影响正确性 |
| **把非 TTY 误判成 TTY**：日志里混进 `\r` 和颜色码，CI 日志变乱 | 只看 `[ -t 2 ]` 和 `IsErrorRedirected`；T6 断言非 TTY 时没有控制字符 | 某些 CI 会给进程分配伪终端（比如开了 `tty: true` 的容器），这时确实会画进度条。这是用户环境的选择，和 npm 的行为一致 |
| **Windows 网络行为变化**：换成 `HttpWebRequest` 后，某些企业代理下失败 | 只换调用方式，不改 `Proxy` 和 `Credentials`；W7、W8 | 需要认证的代理仍然不支持，和现状相同（00 §4） |
| **摘要误导用户**：`Start` 行说可以直接运行 `ohbaby`，实际运行的是旧的 npm 副本，或者当前终端根本找不到命令 | Unix 用 `command -v` 判断；Windows 固定给出启动器命令；T5、W11 | 其他终端可能需要重新载入 PATH；Windows 可先用 `Start` 命令 |
| **进度条把终端弄乱**：窄终端折行、双宽字符、颜色残留 | 窄于 60 列不画进度条；非 UTF-8 用 ASCII；`finally` 恢复颜色；T24、W3、W5 | 安装过程中用户调整窗口大小，进度条可能折行一次。宽度只在开始时读一次，不处理窗口大小变化 |
