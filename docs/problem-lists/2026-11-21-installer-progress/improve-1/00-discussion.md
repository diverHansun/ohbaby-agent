# 讨论记录与已确认要点

> 2026-11-21 开始与用户逐项讨论，每确认一项就更新本文。推理过程见 01，实施方案见 02。

## 1. 背景与动机

v0.1.19 发布了脚本安装（`install.sh` 和 `install.ps1`）。一次全新安装要下载约 30–50 MB 的 Node.js，再用私有 npm 安装 `ohbaby-cli`，整个过程可能持续几十秒到几分钟，但用户在终端里几乎看不到任何输出：

- `install.sh` 下载 Node 时用 `curl -fsSL`，`-s` 关掉了进度显示。
- `install.ps1` 为了下载速度设了 `$ProgressPreference = 'SilentlyContinue'`，只打印一行 "Downloading Node.js…"。
- 最慢的 `npm install` 前后没有提示，用户分不清安装是卡住了还是还在进行。

`docs/releases/unreleased.md` 已经把"安装器显示进度"和"安装完成后显示版本、启动器位置、何时需要开新终端"列为 v0.2.0 计划。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 议题落点 | 新开独立议题 `docs/problem-lists/2026-11-21-installer-progress/`，不放进脚本安装议题的 improve-2（2026-11-21） |
| 关键改动清单 | 02 不写（2026-11-21） |
| "等待界面"指什么 | 终端里安装命令的输出，不是在 ohbaby TUI 里新增命令 |
| 下载和安装 | 需要进度条（2026-11-21 用户确认） |
| `ohbaby update` | 不单独改。走脚本安装时，update 下载目标版本的安装脚本并继承终端运行（`packages/ohbaby-cli/src/cli/commands/update.ts` 的 `installWithScript`），自动获得新的输出 |
| 下载进度条样式 | 两个平台画同一款进度条（2026-11-21 用户选定方案 B），见 2.1 节 |
| `ohbaby uninstall` | 显示过程，但用步骤行，不用进度条，见 2.2 节（2026-11-21） |
| 阶段行 | 固定 4 步，`[n/4]` 编号，见 2.3 节（2026-11-21） |

### 2.1 下载进度条

样式如下，sh 和 ps1 保持一致：

```
[2/4] Downloading Node.js 24.22.3 for darwin-arm64
      ━━━━━━━━━━━━━━━━━━━━━━━━──────────  62%  18.4 / 29.7 MB
```

- 已下载的部分用金色 `━`，未下载的部分用暗色 `─`，后面跟百分比和已下载、总大小。金色沿用 TUI 主题的 `gold`（深色 `#D4A24F`）。
- 下载完成后，这一行收成一句 `Node.js 24.22.3  29.7 MB  verified`，不在终端里留下整条进度条。
- 字符按输出编码选择，两个平台用同一条规则（2026-11-21 确认）：
  - 输出编码是 UTF-8 时用 `━` 和 `─`。POSIX 看 locale（`LC_ALL`、`LC_CTYPE`、`LANG`）；Windows 看 `[Console]::OutputEncoding` 是否为 65001。
  - 其他情况用 `#` 和 `-`。原因：Windows PowerShell 5.1 的控制台通常是 OEM 代码页，437 里没有 `━`，会显示成 `?`；936 里有，但可能按两列宽显示，进度条会折行。
  - ps1 用 `[char]0x2501` 生成字符，脚本文件保持纯 ASCII。
- 只在 TTY、没有设置 `NO_COLOR`、`TERM` 不是 `dumb` 时上色。sh 优先用真彩色，不支持时退回黄色。Windows 用 `[Console]::ForegroundColor` 切换到 `DarkYellow`，不用 ANSI 码，因为 PowerShell 5.1 的 conhost 不一定开启 VT 处理。
- 进度条固定 24 格宽，整行约 55 列。终端窄于 60 列时只显示文字，不画进度条。
- 服务器没有返回文件大小（chunked 传输）时不画进度条，只显示已下载多少 MB。
- sh 的实现参考 opencode：curl 在后台下载，前台轮询文件大小并重画，Ctrl-C 时结束 curl 并恢复光标。

### 2.1.1 Windows 下载实现（2026-11-21 确认）

- 下载 API 改用 `[Net.WebRequest]::Create`（即 `HttpWebRequest`），分块读取响应流并写入文件，自己画进度条。
- 不用 `curl.exe`：它只读环境变量和 `--proxy`，不读系统代理，也不支持 PAC，企业网络用户会下载失败。
- 不开 PowerShell 5.1 自带的进度显示：它每读 10 KB 刷新一次，下载 30 MB 要刷新约 3000 次，正是现在设 `SilentlyContinue` 的原因。我们每 250 ms 刷新一次。
- 选 `HttpWebRequest` 的理由：现在的 `Invoke-WebRequest` 在 5.1 里就基于它，所以系统代理、PAC、TLS 设置的行为与现状一致；不需要 `Add-Type`；不会先把整个文件读进内存。
- 只在 `-not [Console]::IsErrorRedirected` 时画进度条，写到 stderr。
- 代理凭据维持现状，默认不发送。本议题只改显示，不改网络行为。
- 以上依据来自 MicrosoftDocs、dotnet-api-docs、curl 文档，以及 PowerShell 仓库 `v6.0.0-alpha.18` 中从 Windows PowerShell 移植的 Web cmdlet 源码（旁证，5.1 源码不公开）。各启动方式下 `IsErrorRedirected` 的取值、`` `r `` 刷新效果、配色、代理环境下的下载和速度，都要在 Windows 真机上验证，列入 04。

### 2.2 `ohbaby uninstall` 的过程提示

确认之后，每执行完一步打印一行；最后明确说"已卸载"，再说明保留了哪些数据：

```
[1/3] Removing the PATH block from ~/.zshrc        done
[2/3] Removing the launcher at ~/.local/bin/ohbaby   done
[3/3] Removing ~/.ohbaby/install                     done

ohbaby is uninstalled.
Kept your configuration at …, sessions at …, and database at ….
```

- Windows 脚本安装时，命令运行期间还在使用安装目录里的 Node，删不掉这个目录，所以结尾不说"已卸载"，改为 `ohbaby is removed from your PATH. To finish, delete the installation directory after this command exits:`，后面接 PowerShell 和 cmd 的删除命令，再打印保留了哪些数据（2026-11-21 审查时确认）。
- `[n/N]` 的格式和颜色与安装器一致。
- npm 卸载那一步仍然交给 npm 自己的 spinner。
- 改动在 `packages/ohbaby-cli/src/cli/commands/uninstall.ts`，步骤文案函数放在 `packages/ohbaby-cli/src/install/uninstall-plan.ts`，和现有的 `describeUninstallAction` 放在一起。

### 2.3 阶段行

sh 和 ps1 都固定 4 步，编号 `[n/4]` 用金色，文字用正常颜色：

| 步骤 | 文案 | 包含的工作 |
|---|---|---|
| 1 | `Checking the current installation` | 平台检测、daemon 检查、拿安装锁 |
| 2 | `Downloading Node.js 24.22.3 for darwin-arm64`，下面接进度条 | 下载、校验、解压。私有 Node 已存在时改为 `Node.js 24.22.3 is already present`，不跳号 |
| 3 | `Installing ohbaby 0.2.0` | `npm view` 查版本号，再 `npm install`。期间显示 npm 自带的 spinner。该版本已安装时改为 `ohbaby 0.2.0 is already installed` |
| 4 | `Activating ohbaby 0.2.0` | 切换 `current`、发布启动器、写 PATH、清理旧版本、询问是否删除 npm 安装的副本 |

- 第 3 步先用 `npm view` 查到版本号，再打印这一行。文案里直接写真实版本，不先打印 "latest" 再补。
- 阶段行写 stdout，进度条写 stderr，错误仍写 stderr 并带 `ohbaby installer:` 前缀。
- 不在 TTY 时只打印纯文本：阶段行和下载收尾行照常打印，不上色，不画进度条，不输出 `\r`。`TERM=dumb` 时同样不画进度条。
- 不加 `ohbaby installer` 标题行。`ohbaby update` 调用脚本前已经打印 "Update ohbaby from x to y"，直接安装时第一行 `[1/4]` 也足以说明正在做什么。
- npm 自己的输出（spinner 和 `added N packages in Xs`）保留，不加 `--loglevel`、`--silent` 或 `--no-progress`。2026-11-21 对照 npm 11.19.0 源码核实：
  - stdout 和 stderr 都是 TTY、`TERM` 不是 `dumb`、不在 CI 时，npm 在 stderr 上显示 spinner，跟 stdin 无关，所以 `curl | sh` 下能显示。命令 200 ms 内结束则不画。
  - `--loglevel=error` 或 `warn` 关不掉 spinner，只有 `--silent` 和 `--no-progress` 能关。npm 退出前会清掉 spinner 所在的行。
  - `added N packages in Xs` 写 stdout，只有 `--silent` 或 `--json` 能去掉。
  - 脚本用 `$(...)` 捕获 `npm view` 的输出，这时 stdout 不是 TTY，所以查版本号时不会出现 spinner。

### 2.4 成功摘要（2026-11-21 确认）

第 4 步的所有事情（包括询问是否删除 npm 安装的副本）做完后，空一行，统一打印摘要。sh 和 ps1 格式一致：

```

Installed ohbaby 0.2.0.
  Launcher  ~/.local/bin/ohbaby
  PATH      Added to ~/.zshrc. For this terminal, run: export PATH="$HOME/.local/bin:$PATH"
  Start     ohbaby
```

第一行：

| 情况 | 文案 |
|---|---|
| 全新安装 | `Installed ohbaby 0.2.0.` |
| 从其他版本切换过来 | `Updated ohbaby from 0.1.19 to 0.2.0.` |
| 重复运行，版本没变 | `ohbaby 0.2.0 is already installed.` |

PATH 行：

| 情况 | 文案 |
|---|---|
| 已经在 PATH 中 | `~/.local/bin is already in PATH.` |
| sh 刚写入 shell 配置 | `Added to ~/.zshrc. For this terminal, run: export PATH=…` |
| Windows 刚写入用户 PATH | `Added to your user PATH. This window is ready; open a new terminal for other windows.` |
| 设置了 `OHBABY_NO_MODIFY_PATH=1`，或识别不出 shell | `Not changed. Add ~/.local/bin to PATH, or run the launcher directly.` |

- sh 给出 `export` 命令而不是 `source ~/.zshrc`，参考 codex：`source` 会重新执行整份配置文件。
- Windows 脚本会改写当前进程的 `$env:Path`，`irm | iex` 在当前进程中运行，所以当前窗口已经可以直接使用，只需提示其他窗口重开。
- `Start` 行：当前终端能直接运行 `ohbaby` 时显示 `ohbaby`，否则显示启动器的完整路径。
- 不再打印安装目录。`ohbaby uninstall` 会自己找到它，用户需要的是启动器位置。
- Linux 上关于非登录 SSH 命令的提示保留，放在摘要最后。
- 警告（PATH 写入失败、npm 副本卸载失败等）仍写 stderr，打印在摘要之前，退出码仍为 1。
- `ohbaby update` 走脚本安装时，脚本摘要之后还会出现 update 自己的 "Updated ohbaby to X."。这处重复保留，不新增环境变量，也不删除 update 的提示，因为自动更新时那句 "Run ohbaby again to start the new version" 仍然有用。
- 现有集成测试断言 stdout 包含 "is already in PATH"，新文案保留这几个词。

### 2.5 测试方式（2026-11-21 确认）

分四层：

| 层 | 范围 | 在哪里跑 |
|---|---|---|
| 非 TTY 输出 | 扩展现有安装器集成测试：阶段行按顺序出现；摘要第一行的三种情况和 PATH 行的各种情况；stdout 和 stderr 都没有 `\r` 和颜色码；安装成功时 stderr 仍为空 | 三平台 CI |
| TTY 显示 | 新增：用 node-pty 在伪终端里运行 `install.sh`，本地服务器分块慢速返回数据。覆盖 UTF-8 进度条及其收尾行、`LANG=C` 退回 ASCII、`NO_COLOR`、没有 `Content-Length`、50 列窄终端、下载中途 Ctrl-C（退出码 130、后台 curl 被结束、安装锁释放、光标恢复） | macOS 和 Linux CI |
| 卸载输出 | 新增单元测试：每一步输出 `[n/N] … done`，最后输出 "ohbaby is uninstalled." | 单元测试 |
| 真机验收 | Windows：2.1.1 节列出的各项。macOS 和 Linux：真实 `curl \| sh` 从 nodejs.org 下载，Linux 用树莓派；再跑一次 `ohbaby update` | 手动，列入 04 |

- Windows 的 TTY 显示不做自动化测试。ConPTY 测试在 CI 上不稳定，而这部分风险主要是显示效果，靠断言测不出来。
- 测试目录引用不到 ohbaby-server 依赖的 node-pty（pnpm 隔离布局），写 02 时定为把 `@lydell/node-pty` 加为根目录 devDependency，版本相同；不用系统的 `script` 命令，它在 macOS 和 Linux 上参数不同。

## 3. 用户确认记录

- 2026-11-21：新开独立议题；02 不写关键改动清单；下载和安装要进度条；卸载适当显示过程；下载进度条要有 ohbaby 特色，选方案 B。
- 2026-11-21：依次确认阶段行（2.3 节）、Windows 下载实现（2.1.1 节）、成功摘要（2.4 节）、测试方式（2.5 节）。
- 2026-11-21：审查文档时确认 Windows 脚本安装的卸载结尾文案（2.2 节）。

## 4. 已确认：边界（不做的事）

| 项 | 结论 |
|---|---|
| 大号 `OHBABY` logo | 不在安装脚本里打印。`ohbaby update` 每次都会运行安装脚本，大 logo 会反复刷屏；logo 用的方块字符在中文 Windows 上也有显示风险（2026-11-21） |
| 卸载进度条 | 不做。卸载各步都无法计算百分比，只显示步骤行（2026-11-21） |
| Windows 改用 `curl.exe` 下载 | 不做，原因见 2.1.1 节（2026-11-21） |
| 需要认证的代理 | 本议题不改代理凭据行为，有用户反馈再单独处理（2026-11-21） |
| 自己实现 spinner | 不做。最久的 `npm install` 交给 npm 自带的 spinner；解压和查版本号只有几秒，阶段行已经够用（2026-11-21） |
| quiet 或 verbose 开关 | 不加。参考项目都没有，不在 TTY 时输出本来就是纯文本（2026-11-21） |
| `ohbaby installer` 标题行 | 不加，原因见 2.3 节（2026-11-21） |
| 安装目录布局、锁、版本切换 | 不改。本议题只改终端输出 |
| Web 端 | 不涉及 |
