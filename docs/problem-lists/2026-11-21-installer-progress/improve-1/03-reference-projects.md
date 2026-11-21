# 参考项目

> 2026-11-21 对照本地 `../` 下的参考项目源码，以及 npm 和 PowerShell 的公开源码整理。方案见 [02](02-optimization-plan-and-change-scope.md)。

## 3.1 借鉴来源

| 项目 | 路径或链接 | 调研范围 |
|---|---|---|
| opencode | `../opencode/install`（bash，492 行） | 下载进度条、PATH 提示、结尾输出 |
| codex | `../codex/scripts/install/install.sh`、`install.ps1` | 阶段行、PATH 提示、Windows 下载 |
| Step-Code | `../Step-Code/infra/release/install.sh`、`install.ps1` | 下载进度、`[n/N]` 阶段行 |
| npm 11.19.0 | npm 公开源码（`lib/utils/display.js`、`lib/utils/reify-output.js`） | spinner 的显示条件和关闭方式，结论见 00 §2.3 |
| PowerShell | PowerShell 仓库 `v6.0.0-alpha.18` 的 Web cmdlet 源码，MicrosoftDocs、dotnet-api-docs | `Invoke-WebRequest` 的底层实现和进度刷新频率，结论见 00 §2.1.1 |

ZCode 也在 `../` 下，但它是桌面应用，用的是图形安装程序，没有命令行安装脚本，本议题不参考。

## 3.2 各项目的做法

### opencode

- **下载进度条**（`download_with_progress`，第 265 行起）：stderr 是 TTY 时，curl 带 `-D` 在后台下载，前台每 0.1 秒用 `ls -ln` 读一次文件大小，从响应头文件里取最后一个 `Content-Length`，用 `\r` 重画。`sleep 0.1` 失败时退回 `sleep 1`。开始时隐藏光标，函数返回时用 `RETURN` trap 恢复光标、删掉响应头文件。
- 源码注释说明了为什么用 `ls` 而不是 `wc -c`：busybox 的 `wc -c` 会把整个文件读一遍。
- 进度条 50 格，用 `■` 和 `･`，整条橙色，后面只有百分比。
- 非 TTY、Windows（Git Bash 等）或自定义进度失败时，退回 `curl -#`。
- 结尾打印大号 logo，再给出 `exec $SHELL` 和 `opencode` 两条命令。

### codex

- **阶段行**：`step()` 打印 `==> 文案`，不编号、不上色。依次是 `Installing Codex CLI`（或 `Updating Codex CLI from A to B`）、`Detected platform`、`Resolved version`、`Downloading Codex CLI`、`Installing standalone package to …`。
- **下载不显示进度**：sh 用 `curl -fsSL`，ps1 在脚本开头全局设置 `$ProgressPreference = "SilentlyContinue"` 后调用 `Invoke-WebRequest`。
- **PATH 提示**（`print_launch_instructions`）：分别告诉用户当前终端和以后的终端怎么用，当前终端给出 `export PATH="…:$PATH" && codex`，不让用户 `source` 配置文件。
- Windows 上告诉用户当前 PowerShell 会话可以直接运行 `codex`，以后的窗口要重开。
- 结尾询问是否立即启动 Codex。

### Step-Code

- **sh 的下载**：`curl -fL --progress-bar`，直接用 curl 自带的 `#` 进度条；没有 curl 时用 `wget --show-progress`。
- **ps1 的阶段行**：`Write-Progress-Step` 打印 `  [n/6] 文案`，整行 `DarkGray`，共 6 步（检测平台、解析发布清单、下载、安装、安装附带工具、冒烟测试）。
- **ps1 的下载**：`Invoke-WebRequest`，没有关闭 `$ProgressPreference`，所以显示 PowerShell 自带的进度。
- 成功时打印一行绿色的 `installed stepcode X to <路径>`。

### npm 和 PowerShell 源码

- npm：stdout 和 stderr 都是 TTY、不在 CI、`TERM` 不是 `dumb` 时显示 spinner，与 stdin 无关；`--loglevel` 关不掉，只有 `--silent` 和 `--no-progress` 能关。详见 00 §2.3。
- PowerShell：5.1 的 `Invoke-WebRequest` 基于 `HttpWebRequest`，每读 10 KB 刷新一次进度，大文件下载因此明显变慢。详见 00 §2.1.1。

## 3.3 取舍

| 来源 | 做法 | ohbaby 的取舍 | 理由 |
|---|---|---|---|
| opencode | 后台 curl 加前台轮询文件大小 | **采用** | 只用 POSIX 工具，样式可以自己定 |
| opencode | 用 `ls -ln` 读大小、取最后一个 `Content-Length`、`sleep 0.1` 退回 `sleep 1` | **采用** | 三处都是踩过坑的细节，直接沿用 |
| opencode | 用 `RETURN` trap 恢复光标 | **改造** | opencode 是 bash 脚本，`RETURN` trap 在 POSIX sh 里没有；它也没有处理 INT，按代码推断，Ctrl-C 时光标不会恢复，后台 curl 也不会被结束。ohbaby 把这两件事放进现有的 `cleanup_on_exit`，INT、TERM、HUP 和正常退出都会走到 |
| opencode | 50 格进度条、`■` 字符、只有百分比 | **改造** | ohbaby 用 24 格，按编码选 `━` 或 `#`，并显示已下载和总大小 |
| opencode | 非 TTY 退回 `curl -#` | **不采用** | 非 TTY 时多半是日志或 CI，`#` 进度条会写一堆字符进日志。ohbaby 非 TTY 时完全不画 |
| opencode | 结尾大号 logo | **不采用** | `ohbaby update` 每次都运行安装脚本，会反复刷屏，见 00 §4 |
| codex | 每个阶段一行提示 | **改造** | 采用"每个阶段一行"，但加上 `[n/4]` 编号，让用户知道还剩几步 |
| codex | 当前终端给出 `export PATH=…`，不用 `source` | **采用** | `source` 会重新执行整份配置文件，见 00 §2.4 |
| codex | Windows 上说明当前会话可直接用 | **采用** | 两边脚本都会修改当前进程的 PATH |
| codex | ps1 关掉进度、静默下载 | **不采用** | 这正是本议题要解决的问题 |
| codex | 安装后询问是否立即启动 | **不采用** | 摘要的 `Start` 行已经够了；update 时也不该再问 |
| Step-Code | ps1 的 `[n/N]` 阶段行 | **采用** | 和 ohbaby 的阶段行形式一致；ohbaby 只给编号上色，文字保持正常颜色，更好读 |
| Step-Code | sh 用 `curl --progress-bar` | **不采用** | 样式没法定制，和 Windows 那边对不齐 |
| Step-Code | ps1 用 PowerShell 自带的进度 | **不采用** | 5.1 下会拖慢下载 |
| npm | 自带 spinner | **采用** | 不自己做 spinner，也不加 `--silent` |

## 3.4 对 02 的影响

- Stage 1 的下载进度条直接来自 opencode，并补上 opencode 没处理的 Ctrl-C 清理。
- Stage 1 和 Stage 2 的阶段行综合了 codex 的"每阶段一行"和 Step-Code 的 `[n/N]` 编号。
- 成功摘要的 PATH 行沿用 codex 的写法：sh 给出 `export` 命令，Windows 说明当前窗口已经可以用。
- Stage 2 的下载方式没有现成参考：codex 和 Step-Code 都直接用 `Invoke-WebRequest`。改用 `HttpWebRequest` 的依据来自 PowerShell 源码和 .NET 文档，见 00 §2.1.1。
- 参考项目都没有 quiet 或 verbose 开关，也没有给卸载做进度显示，这和 00 §4 的边界一致。
