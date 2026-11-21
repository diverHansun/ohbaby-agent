# 01 现状与问题分析

> 基线：`main` 分支 `86473f63`（v0.1.19 之后），分析日期 2026-11-21。行号是这一版的快照，定位以函数名为准。本文只描述现状，方案见 02。

## 1.1 问题陈述

| ID | 用户看到的 | 技术原因 |
|---|---|---|
| P1 | 下载 Node.js 时终端没有任何动静，看不出下载到哪了，也看不出是不是卡住了 | `install.sh` 用 `curl -fsSL` 关掉了进度；`install.ps1` 设了 `$ProgressPreference = 'SilentlyContinue'` |
| P2 | 从开始到结束，用户不知道安装分几步、现在在哪一步 | 两份脚本都没有阶段提示。sh 在 `finish_install` 之前完全不输出；ps1 只有一行 "Downloading…" |
| P3 | 最慢的 `npm install` 开始前没有提示，突然冒出 npm 的 spinner 和 "added N packages" | 脚本在调用 npm 前后不打印任何东西 |
| P4 | 装完后不知道下一步该敲什么，也不确定当前终端能不能直接用 | 完成信息分散，顺序乱，缺少"下一步"提示；ps1 只给一句 "Reopen other terminals" |
| P5 | `ohbaby uninstall` 确认后一直没有输出，最后也没说"已卸载" | `uninstall.ts` 执行各步时不输出进度，结尾只打印保留了哪些数据 |

## 1.2 已确认的分界

本议题只改终端输出，不改安装目录布局、安装锁、版本切换和 PATH 写入逻辑（00 第 4 节）。两份安装脚本（POSIX sh 和 Windows PowerShell 5.1）各自独立实现同一套输出约定；`ohbaby uninstall` 是 TypeScript 代码，跟随同一种视觉风格。

```
用户 ──curl | sh──▶ install.sh ──┐
用户 ──irm | iex──▶ install.ps1 ─┼──▶ 终端（stdout 阶段行 / stderr 进度条与错误）
ohbaby update ──继承 stdio──▶ 目标版本的安装脚本 ─┘
ohbaby uninstall ──▶ uninstall.ts ──▶ 终端
```

## 1.3 `install.sh` 现状

### 1.3.1 职责与流程

`main`（`packages/ohbaby-cli/install.sh:526`）按以下顺序执行，括号内是目前的输出：

| 顺序 | 函数 | 做什么 | 现在输出什么 |
|---|---|---|---|
| 1 | `select_platform`（:171）、`check_daemon`（:149）、`take_install_lock`（:210） | 平台检测、确认 daemon 已停、拿安装锁 | 无 |
| 2 | `prepare_node`（:272） | 下载 Node 归档和 `SHASUMS256.txt`、校验、解压、试跑 | 无；`download`（:255）用 `curl -fsSL --connect-timeout 15` |
| 3 | `run_private_npm view`（main 内） | 用 `$(...)` 捕获 npm 输出，查出目标版本号 | 无 |
| 4 | `prepare_release`（:317） | `npm install` 到 `.partial` 目录，试跑后改名 | 只有 npm 自己的输出 |
| 5 | `prepare_launcher`（:356）、写 `current`、`publish_launcher`（:388） | 发布启动器、切换版本 | 无 |
| 6 | `finish_install`（:503） | 版本行、`configure_path`（:410）、`clean_old_installations`（:448）、`offer_npm_removal`（:479）、Launcher 行 | 见 1.3.3 |

### 1.3.2 输出流与终端判断

- 正常信息用 `printf` 写 stdout；`fail`（:3）、`warn`（:8）写 stderr，带 `ohbaby installer:` 前缀。
- 脚本里没有任何 TTY 判断，也没有颜色。唯一跟终端有关的是 `offer_npm_removal` 通过 `/dev/tty` 提问（:483 附近），这是上一轮参考 codex 的做法。
- `curl | sh` 时 stdin 是管道，stdout 和 stderr 仍然是终端。这一点决定了进度显示只能按 stdout 或 stderr 判断 TTY。
- 信号处理：`trap cleanup_on_exit 0`，`INT`、`HUP`、`TERM` 分别转为退出码 130、129、143（:571–574）。`cleanup_on_exit`（:242）清理下载目录、临时启动器和安装锁。现在所有子进程都在前台运行，Ctrl-C 会直接发给 curl，所以不需要额外结束子进程。

### 1.3.3 完成信息

`finish_install` 和它调用的函数按下面的顺序打印：

1. `Activated ohbaby X at <安装目录>.` 或 `ohbaby X is installed at <安装目录>.`（:505、:507）
2. PATH 相关，三选一：`… is already in PATH.`（:413）、`Open a new terminal or source your shell configuration…`（:435）、`Add … to PATH to use ohbaby by name.`（:432）
3. 清理旧版本（失败时写 stderr 警告）
4. 询问是否删除 npm 副本；不删时打印 `Kept the npm installation at …`（:497）
5. `Launcher: <路径>`（:519）
6. 仅 Linux：非登录 SSH 命令的提示（:521）

问题在于：用户最关心的"现在能不能用、该敲什么"没有直接说；PATH 提示夹在中间，启动器路径放在最后；npm 副本的询问插在完成信息中间。

## 1.4 `install.ps1` 现状

### 1.4.1 职责与流程

`Invoke-OhbabyInstall`（`packages/ohbaby-cli/install.ps1:425`）的顺序和 sh 基本对应：`Assert-DaemonStopped`（:60）→ `Enter-InstallLock`（:147）→ `Initialize-Node`（:206）→ `Resolve-InstallVersion`（:195）→ `Install-Release`（:253）→ `Install-Launcher`（:280）→ 写 `current` → `Add-InstallPath`（:328）→ `Clear-OldReleases`（:362）→ `Remove-OldNpmInstall`（:389）。

### 1.4.2 下载

- `Get-NodeDownload`（:166）设 `$ProgressPreference = 'SilentlyContinue'`（:168），再用 `Invoke-WebRequest -UseBasicParsing -OutFile`（:170）。
- 关掉进度的原因：Windows PowerShell 5.1 的 Web cmdlet 每读 10 KB 就调用一次 `WriteProgress`，30 MB 要刷新约 3000 次，严重拖慢下载。依据是 PowerShell 仓库 `v6.0.0-alpha.18` 中从 Windows PowerShell 移植的 `StreamHelper.cs`（`ChunkSize = 10000`），属于旁证。
- 网络行为：同一份源码显示 `Invoke-WebRequest` 底层是 `WebRequest.Create`，即 `HttpWebRequest`。因此它使用系统"Internet 选项"中的代理（含 PAC），代理认证时默认不发送凭据，TLS 版本服从脚本开头对 `ServicePointManager.SecurityProtocol` 的设置。新的下载实现必须保持这些行为。
- 唯一的提示是 `Initialize-Node` 里的 `Write-Host "Downloading Node.js … for Windows …"`（:223）。

### 1.4.3 完成信息

- `Installed ohbaby X at '<安装目录>'.`（:506）
- 设了 `OHBABY_NO_MODIFY_PATH=1` 时提示运行 `ohbaby.cmd` 或手动加 PATH（:508），否则提示 "Reopen other terminals…"（:510）。
- `Add-InstallPath` 会同时改写当前进程的 `$env:Path`（:341 附近），而 `irm | iex` 在当前 PowerShell 进程里运行，所以当前窗口其实已经能直接运行 `ohbaby`。现有提示没有把这一点说清楚。

### 1.4.4 约束

- 集成测试要求 `install.ps1` 每个字节都小于 128（`tests/integration/cli/install-windows.integration.test.ts:30`）。非 ASCII 字符只能在运行时用 `[char]` 生成。
- PowerShell 5.1 的 conhost 不一定开启 VT 处理，不能依赖 ANSI 颜色码。控制台通常使用 OEM 代码页：437 里没有 `━`，936 里有（0xA9A5），但可能按两列宽显示。

## 1.5 `ohbaby update` 与 `ohbaby uninstall` 现状

### 1.5.1 update

- 走脚本安装时，`prepareScript`（`packages/ohbaby-cli/src/cli/commands/update.ts:60`）从 jsDelivr 下载**目标版本**的安装脚本，`installWithScript`（:75）设置 `OHBABY_NON_INTERACTIVE=1` 后运行它。
- `runInstallerCommand`（`packages/ohbaby-cli/src/install/child-command.ts:19`）默认 `stdio: "inherit"`（:30），脚本直接写到用户终端，TTY 判断结果与直接安装相同。
- 结论：update 不用单独改。用户第一次从 v0.1.19 升级到带新输出的版本时，看到的就是新脚本的输出。
- 脚本跑完后，update 自己再打印 `Updated ohbaby to X.` 或自动更新的提示（`update.ts` 的 `performUpdate` 末尾）。

### 1.5.2 uninstall

`createUninstallCommand`（`packages/ohbaby-cli/src/cli/commands/uninstall.ts`）的输出：

1. 先列出所有将要执行的动作（:122，文案来自 `describeUninstallAction`）。
2. 询问 `Uninstall ohbaby? [y/N]`。
3. 逐个执行动作（:144），**这一段完全没有输出**。npm 卸载由 npm 自己输出；删除安装目录可能要一两秒。
4. 最后打印 `Kept your configuration at …`（:148），没有一句"已卸载"。

## 1.6 外部工具行为（已核实）

npm 11.19.0 源码（本机 `node@24` 自带）核实结果，决定了第 3 步不需要自己做等待提示：

| 事实 | 依据 |
|---|---|
| stdout 和 stderr 都是 TTY、`TERM` 不是 `dumb`、不在 CI 时显示 spinner，与 stdin 无关 | `@npmcli/config` 的 `progress` 定义；`lib/utils/display.js` |
| spinner 写 stderr，命令 200 ms 内结束则不画，退出前清掉所在行 | `lib/utils/display.js` |
| `--loglevel=error` 或 `warn` 关不掉 spinner；`--silent`、`--no-progress` 可以 | 同上 |
| `added N packages in Xs` 写 stdout，只有 `--silent` 或 `--json` 能去掉 | `lib/utils/reify-output.js` |
| `npm view` 的输出被 `$(...)` 捕获时 stdout 不是 TTY，不显示 spinner | 由前两条推出 |

## 1.7 测试现状

| 测试 | 覆盖 | 和本议题的关系 |
|---|---|---|
| `tests/integration/cli/install-unix.integration.test.ts` | 本地 HTTP 服务器提供假 Node 归档，真实 curl 下载，假 npm；覆盖安装、重复运行、版本切换、锁、daemon、PATH、校验失败 | 多处断言成功时 `stderr` 为空（:188、:232、:294、:433）；断言 stdout 含 "is already in PATH"（:306）。用 `execFile` 运行，不是 TTY |
| `tests/integration/cli/install-windows.integration.test.ts` | 纯 ASCII 检查（:30）；Windows 上的安装、切换、失败回退 | 同样不是 TTY |
| CI `.github/workflows/ci.yml:38` | "Installer scripts" 步骤在三个平台上运行上面两个测试 | 这一步按文件名列出测试，新增的 TTY 测试文件要加进去 |
| `uninstall.ts` | 没有直接的单元测试，只有 `script-uninstall.unit.test.ts` 覆盖底层函数 | 新增输出要补测试 |

缺口：TTY 下的显示完全没有测试，也没有测过下载中途 Ctrl-C。项目在 ohbaby-server 里已经依赖 `@lydell/node-pty`（`packages/ohbaby-server/src/terminal/pty.ts`），可以用来在测试里提供伪终端。

## 1.8 SWE 原则审视

- **复杂度放在哪里**：现在脚本的复杂度集中在锁、daemon 检查和版本切换上，输出几乎为零。本议题新增的复杂度主要是 sh 的后台下载加轮询（要处理子进程和信号），以及 ps1 的分块下载。这两处是本议题风险最高的代码，测试要盯住它们。
- **两份脚本的重复**：sh 和 ps1 必须各写一遍，因为首次安装时没有 Node 可用（上一轮 03 第 3.3 节已经说明）。能做的是把输出约定（阶段文案、进度条格式、摘要格式）写清楚，让两边各自实现、结果一致。
- **不改网络行为**：Windows 换下载 API 时，只能换成同样基于 `HttpWebRequest` 的写法，不能顺手改代理或凭据行为。
- **YAGNI**：不做自己的 spinner、不加 quiet 或 verbose 开关、不打印大 logo（00 第 4 节）。

## 1.9 与既有文档的关系

| 文档 | 关系 |
|---|---|
| [脚本安装 improve-1](../../2026-11-17-script-install/README.md) | 两份安装脚本的权威设计。本议题不改它定下的目录布局、锁和切换顺序，只改输出 |
| `docs/releases/unreleased.md` | 已列出 v0.2.0 计划中的安装进度和完成摘要，实施后据实更新 |
| `README.md`、`README.zh.md`、`packages/ohbaby-cli/README.md` | 只写了安装命令，没有引用安装输出，不需要同步 |
