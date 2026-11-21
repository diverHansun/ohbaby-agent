# 优化方案与改动面

> 本文是实施会话的执行依据，验收标准见 [04](04-test-and-acceptance.md)。按用户要求，本文不写关键改动清单。确认过程见 [00](00-discussion.md)，问题编号 P1–P5 见 [01](01-problem-analysis-and-current-state.md)。

## 2.1 方案总览

本轮只改"用户在终端里看到什么"，不碰安装目录布局、安装锁和版本切换。改动分三块，彼此独立：

- `install.sh`：加 4 步阶段行，下载 Node.js 时画进度条，最后打印统一的成功摘要。
- `install.ps1`：同样的阶段行和摘要；下载改用 `HttpWebRequest` 分块读取，自己画进度条。
- `ohbaby uninstall`：执行时每完成一步打印一行，最后明确告诉用户已经卸载。

`ohbaby update` 不改。它走脚本安装时会下载目标版本的安装脚本，并让脚本直接继承终端运行，所以新输出会自动出现在 update 里。

一次全新安装在终端里会是这样（TTY、UTF-8、支持颜色）：

```
[1/4] Checking the current installation
[2/4] Downloading Node.js 24.22.3 for darwin-arm64
      ━━━━━━━━━━━━━━━━━━━━━━━━──────────  62%  18.4 / 29.7 MB     ← stderr，下载完即清除
      Node.js 24.22.3  29.7 MB  verified
[3/4] Installing ohbaby 0.2.0
⠋                                                                ← npm 自己的 spinner
added 312 packages in 18s
[4/4] Activating ohbaby 0.2.0

Installed ohbaby 0.2.0.
  Launcher  ~/.local/bin/ohbaby
  PATH      Added to ~/.zshrc. For this terminal, run: export PATH="$HOME/.local/bin:$PATH"
  Start     ohbaby
```

输出流的分工两个平台相同：

```
stdout ─ 阶段行、下载收尾行、npm 的 "added N packages"、成功摘要
stderr ─ 进度条（只在 TTY 上画）、npm spinner、警告和错误（带 "ohbaby installer:" 前缀）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 阶段划分 | 固定 4 步，`[n/4]` 编号，跳过的步骤改文案不跳号（00 §2.3） | 用户能看出还剩多少；编号固定，测试好写 | 按实际执行的步骤动态编号 | 已安装时第 2、3 步只有一行"已存在" |
| 进度条位置 | 只给 Node.js 压缩包画；`SHASUMS256.txt` 和 npm 不画 | 压缩包占下载量的绝大部分；npm 自己有 spinner（00 §2.3 已核实） | 给所有下载画条；自己做 spinner | 无 |
| sh 的下载方式 | curl 放后台，前台轮询文件大小并重画，参考 opencode（00 §2.1） | 只用 POSIX sh 和 curl，不加依赖；curl 自带的 `-#` 进度条样式无法定制 | `curl -#`；`curl --write-out` 回调 | 要自己处理后台进程的结束和 Ctrl-C |
| Windows 的下载方式 | `[Net.WebRequest]::Create` 分块读写，每 250 ms 重画（00 §2.1.1） | 5.1 的 `Invoke-WebRequest` 本身就基于它，代理、PAC、TLS 行为不变；不需要 `Add-Type` | `curl.exe`（不读系统代理和 PAC）；开 PowerShell 自带进度（每 10 KB 刷新，拖慢下载） | 下载代码从 1 行变成约 40 行 |
| 字符选择 | 输出编码是 UTF-8 用 `━` `─`，否则用 `#` `-`（00 §2.1） | cp437 没有 `━`，cp936 可能按双宽显示 | 一律 ASCII；一律 Unicode | 要判断编码 |
| 颜色 | 只在 TTY、没有 `NO_COLOR`、`TERM` 不是 `dumb` 时上色；sh 用 ANSI，Windows 用 `[Console]::ForegroundColor` | 5.1 的 conhost 不一定开 VT 处理 | Windows 也用 ANSI | Windows 只能用 16 色里的 `DarkYellow` |
| 成功摘要 | 第 4 步全部做完后一次性打印（00 §2.4） | 现在的提示散在各处，用户要自己拼 | 边做边打印 | 要把 PATH 的结果先存下来，最后再打印 |
| 卸载提示 | 步骤行，不画进度条（00 §2.2） | 每步都算不出百分比 | 进度条；什么都不打印 | 无 |
| 测试 | 四层：非 TTY 集成测试、PTY 显示测试、卸载单元测试、真机验收（00 §2.5） | 大部分逻辑在非 TTY 下就能测；显示效果只能靠 PTY 和真机 | Windows ConPTY 自动化 | Windows 显示效果只靠人工验收 |

所有决策都可回退：每个 Stage 只改一个文件或一个命令，回退就是还原那几个文件。本轮没有不可逆决策。

## 2.3 分阶段实施

三个 Stage 互不依赖，可以分开提交，也可以并行做。建议顺序是 1 → 2 → 3：Stage 1 的输出格式定下来后，Stage 2 照着做。三个 Stage 都属于 improve-1。

### Stage 1：`install.sh`

回应 P1（下载没有进度）、P2（没有阶段）、P3（`npm install` 没有提示）、P4（摘要分散）。

**1. 输出辅助函数**

在 `main` 开头、`select_platform` 之前初始化一次显示状态：

- `ui_out` 和 `ui_err`：stdout、stderr 是否是 TTY（`[ -t 1 ]`、`[ -t 2 ]`）。`curl | sh` 下 stdin 是管道，但这两个仍然是终端。
- 是否画进度条：stderr 是 TTY，并且 `TERM` 不是 `dumb`。`dumb` 终端不认 `\r` 以外的控制码，和 npm 一样整条不画。
- 是否上色：对应的流是 TTY，`NO_COLOR` 没有设置或为空，`TERM` 不是 `dumb`。stdout 和 stderr 分开判断。
- 金色：`COLORTERM` 是 `truecolor` 或 `24bit` 时用 `\033[38;2;212;162;79m`（`#D4A24F`），否则用 `\033[33m`。暗色用 `\033[2m`。
- 字符：`${LC_ALL:-${LC_CTYPE:-${LANG:-}}}` 里含 `UTF-8` 或 `utf8`（不区分大小写）时用 `━` 和 `─`，否则用 `#` 和 `-`。
- 终端宽度：依次尝试 `( stty size </dev/tty ) 2>/dev/null`、`$COLUMNS`，都拿不到时按 80 列。只在画进度条前读一次。子 shell 加外层重定向的写法和脚本里现有的 `( : </dev/tty ) 2>/dev/null` 一致，打不开 `/dev/tty` 时不会往 stderr 漏错误。

新增 `stage n text`：打印 `[n/4] text`。stdout 上色时编号用金色，文字用正常颜色。

**2. 阶段行**

| 步骤 | 在哪里打印 | 文案 |
|---|---|---|
| 1 | `main` 里初始化显示状态之后，`select_platform` 之前 | `Checking the current installation` |
| 2 | `prepare_node` 开头 | 需要下载：`Downloading Node.js $NODE_VERSION for $os-$arch`；`$node_dir` 已存在：`Node.js $NODE_VERSION is already present` |
| 3 | `npm view` 拿到 `$version` 之后，`prepare_release` 开头 | 需要安装：`Installing ohbaby $version`；release 目录已存在：`ohbaby $version is already installed` |
| 4 | `prepare_release` 返回之后 | `Activating ohbaby $version` |

第 1 步之前不能有任何输出，失败时仍然只输出 `ohbaby installer: …` 一行错误。`npm install` 的命令行参数不变，保留 npm 的 spinner 和 `added N packages` 行。

**3. 下载进度条**

新增 `download_node_archive url dest`，只用于 Node.js 压缩包。`SHASUMS256.txt` 继续用现在的 `download`。

不画进度条时（见上面的条件），直接调用现在的 `download`，行为和现在一样。

要画进度条时：

1. 后台运行 `curl -fsSL --connect-timeout 15 -D "$headers" -o "$dest" "$url" &`，记下 `curl_pid`。`$headers` 放在 `$download_dir` 里，跟着现有清理逻辑一起删掉。参数里只多了 `-D`。
2. 隐藏光标（`\033[?25l`），用 `curl_pid` 和一个标记变量记下"光标已隐藏"，供清理时恢复。
3. 当 `kill -0 "$curl_pid"` 成功时循环：
   - 总大小：只看 `$headers` 里**最后一个** `HTTP/` 状态行之后的那段响应头，取其中的 `Content-Length`，不区分大小写，去掉 `\r`。有重定向时 `-D` 会写下多段响应头，302 那段常带 `Content-Length: 0`；轮询时可能只写完了 302 那段。拿不到、不是纯数字或者不大于 0 时，一律按"没有总大小"处理。dash 里除以 0 是致命错误，会直接让脚本退出，所以这一步必须在做除法之前判断。
   - 已下载：`[ -f "$dest" ]` 成立时才读 `ls -ln "$dest"` 的第 5 列，curl 还没创建文件时按 0 处理，避免 `ls` 往 stderr 报错。不用 `wc -c`，busybox 的实现会把整个文件读一遍（opencode 源码注释）。
   - 百分比封顶 100%。
   - 用 `\r` 回到行首，重画整行，以 `\033[K` 结尾。
   - 睡眠 0.1 秒。`sleep 0.1` 不被支持时（启动时试一次）改为每秒一次。
4. 写成 `curl_status=0; wait "$curl_pid" || curl_status=$?`，然后清空 `curl_pid`。脚本开着 `set -e`，直接写 `wait` 失败时会跳过自定义错误直接退出。变量名不要用 `status`，`finish_install` 已经用了。`curl_status` 不为 0 时报现在的错误：`Download failed: … Check your proxy or set OHBABY_NODE_MIRROR.`
5. 用 `\r\033[K` 清掉进度条那一行，恢复光标。

进度条这一行的格式：

| 情况 | 显示 |
|---|---|
| 有总大小，终端不少于 60 列 | `      ━━━━━━━━━━━━━━━━━━━━━━━━──────────  62%  18.4 / 29.7 MB`，24 格，已完成部分金色，未完成部分暗色 |
| 有总大小，终端少于 60 列 | `      62%  18.4 / 29.7 MB` |
| 没有总大小（chunked 传输） | `      18.4 MB` |

大小按 1 MB = 1,048,576 字节、保留一位小数，用 `$(( ))` 整数运算算出来，不依赖 `bc`。Windows 用同一个换算。

**4. 下载收尾行**

校验通过、解压之前，向 stdout 打印一行 `      Node.js 24.22.3  29.7 MB  verified`，TTY 和非 TTY 都打印。大小取下载完成后的文件大小。

**5. Ctrl-C 和退出清理**

先在 `main` 里和现有的 `download_dir=`、`lock_owned=0` 放在一起，于 `trap cleanup_on_exit 0` 之前初始化 `curl_pid=` 和 `cursor_hidden=0`。脚本开着 `set -u`，不初始化的话，下载开始前的任何退出（比如 daemon 检查失败）都会让清理函数因为变量未定义而中断，安装锁就释放不掉了。

`cleanup_on_exit` 新增两件事，并且要放在现有的删除临时目录、释放锁之前做：

- `curl_pid` 不为空时，`kill "$curl_pid" 2>/dev/null || :`，再 `wait "$curl_pid" 2>/dev/null || :`。非交互式 sh 里后台进程会忽略 SIGINT，Ctrl-C 结束不了 curl，必须显式结束它，否则 curl 还会往已经删掉的目录里写文件。
- `cursor_hidden` 为 1 时，向 stderr 输出 `\r\033[K\033[?25h`。

`trap 'exit 130' INT` 等现有的 trap 不变。

**6. 成功摘要**

`finish_install` 改成这样：先做完第 4 步剩下的工作，再一次性打印摘要。

- `configure_path` 不再直接打印，改为设置变量 `path_note`，只在失败时返回非零。文案见 00 §2.4 的 PATH 行表格。识别不出 shell 和设置了 `OHBABY_NO_MODIFY_PATH=1` 时都用 `Not changed. Add ~/.local/bin to PATH, or run the launcher directly.`
- `clean_old_installations` 和 `offer_npm_removal` 照旧执行。`offer_npm_removal` 里的询问、"Kept the npm installation at …" 都保留在第 4 步里，出现在摘要之前。
- 警告（PATH 配置失败、npm 副本卸载失败）照旧写 stderr，出现在摘要之前，退出码仍为 1。
- 最后打印一个空行和摘要：

```
<第一行>
  Launcher  <启动器路径>
  PATH      <path_note>
  Start     <ohbaby 或启动器路径>
```

第一行：`$previous` 为空时是 `Installed ohbaby $version.`；`$previous` 和 `$version` 不同时是 `Updated ohbaby from $previous to $version.`；相同时是 `ohbaby $version is already installed.`

`Start` 行：取 `command -v ohbaby` 结果所在的目录，去掉末尾多余的 `/` 后和 `$launcher_dir` 比较，相同时显示 `ohbaby`，否则显示启动器的完整路径。PATH 里写成 `~/.local/bin/` 时，`command -v` 会返回 `…/bin//ohbaby`，所以不能直接拿整条路径比。这样也覆盖了"保留了 npm 副本、它在 PATH 里排在前面"的情况。

摘要里的路径把 `$HOME` 开头的部分换成 `~`，`export` 命令里保留字面的 `$HOME`。Linux 上关于非登录 SSH 命令的提示放在摘要最后。删掉现在的 `Activated ohbaby … at <安装目录>`、`ohbaby … is installed at …` 和 `Launcher: …` 三行。

**DoD**

- 04 中"非 TTY 输出"和"TTY 显示"两层里与 `install.sh` 相关的用例全部通过，包括 Ctrl-C 用例。
- macOS 和 Linux 上现有安装器集成测试全部通过。为新文案调整断言时，不放宽"成功安装时 stderr 为空"这一条。
- `sh -n install.sh` 通过。集成测试用 `sh` 运行脚本，Linux CI 上的 `sh` 就是 dash，macOS 上是 bash 的 sh 模式，所以两种 shell 都会被覆盖。CI 里没有 `shellcheck`，本轮不新增。

### Stage 2：`install.ps1`

回应 P1、P2、P3、P4。

**1. 输出辅助函数**

在 `Invoke-OhbabyInstall` 开头初始化一次：

- 是否上色：`NO_COLOR` 没有设置或为空，`TERM` 不是 `dumb`。
- 是否画进度条：`-not [Console]::IsErrorRedirected`，并且 `TERM` 不是 `dumb`。
- 字符：`[Console]::OutputEncoding.CodePage -eq 65001` 时用 `[char]0x2501`（`━`）和 `[char]0x2500`（`─`），否则用 `#` 和 `-`。脚本文件保持纯 ASCII，现有测试会检查。
- 终端宽度：`[Console]::WindowWidth`，拿不到（会抛异常）时按 80 列。

新增 `Write-Stage n text`：上色时用 `Write-Host "[n/4]" -ForegroundColor DarkYellow -NoNewline` 加 `Write-Host " text"`，否则直接 `Write-Host "[n/4] text"`。阶段行和摘要都用 `Write-Host`，和现在一样。

**2. 阶段行**

| 步骤 | 在哪里打印 | 文案 |
|---|---|---|
| 1 | `Invoke-OhbabyInstall` 开头，读架构之前 | `Checking the current installation` |
| 2 | `Initialize-Node` 里，判断完私有 Node 是否存在之后 | `Downloading Node.js $nodeVersion for win-$Architecture`；已存在：`Node.js $nodeVersion is already present` |
| 3 | `Resolve-InstallVersion` 返回之后，`Install-Release` 里判断完 release 是否存在 | `Installing ohbaby $Version`；已存在：`ohbaby $Version is already installed` |
| 4 | `Install-Release` 返回之后 | `Activating ohbaby $version` |

平台写成 `win-x64`、`win-arm64`，和 Node.js 的压缩包命名一致，也和 sh 的 `darwin-arm64` 写法对齐。删掉现在的 `Downloading Node.js $nodeVersion for Windows $Architecture...`。

**3. 下载**

`Get-NodeDownload` 改用 `HttpWebRequest`，两个下载（压缩包和 `SHASUMS256.txt`）都走它，加一个开关参数决定是否画进度条，只给压缩包打开。

1. `$request = [Net.WebRequest]::Create($Url)`。不改 `Proxy`、`Credentials`、`Timeout`、`ReadWriteTimeout`，使用默认值：系统代理和 PAC 照旧生效，默认不发送代理凭据，和现在一致（00 §2.1.1）。TLS 1.2 由脚本开头现有的 `ServicePointManager.SecurityProtocol` 设置保证。
   - 要显式设置 `$request.UserAgent = 'ohbaby-installer'`。`Invoke-WebRequest` 会自动带上 `WindowsPowerShell/5.1` 之类的 User-Agent，裸的 `HttpWebRequest` 不带。有些企业代理和自建镜像会拒绝没有 User-Agent 的请求。这是本轮唯一的请求头变化，只是把"有 User-Agent"这件事保持住，具体字符串变了。
2. `GetResponse()` 拿到响应，`ContentLength` 为 -1 时表示没有总大小。
3. 用 64 KB 缓冲区从响应流读到 `[IO.File]::Create($Destination)` 打开的文件流。
4. 用 `[Diagnostics.Stopwatch]` 计时，每 250 ms 向 `[Console]::Error` 写一次 `` `r `` 加整行进度（格式同 Stage 1 的表格）。画已完成部分前把 `[Console]::ForegroundColor` 设为 `DarkYellow`，画完未完成部分前设为 `DarkGray`，最后恢复成进入函数时保存的颜色。
5. 读完后写 `` `r ``、一行空格、再写 `` `r ``，清掉进度条。
6. `finally` 里依次关闭文件流和响应、恢复颜色。Ctrl-C 或网络错误都会走到这里。半截文件在 `.node-v….partial` 目录里，下次运行时现有的 `Remove-TreeIfPresent $partial` 会清掉；安装锁由外层现有的 `finally` 释放。
7. 任何异常都包装成现在的错误：`Could not download '$Url'. Check your proxy settings or set OHBABY_NODE_MIRROR. …`。

不再设置 `$ProgressPreference`，因为不再调用 `Invoke-WebRequest`。

PowerShell 7 的 `irm | iex` 也会运行这段代码。`HttpWebRequest` 在 .NET Core 里仍然可用，底层换成了 `HttpClient`，默认同样使用系统代理。这一点列入 04 的 Windows 真机验收。

**4. 下载收尾行**

校验通过、解压之前，`Write-Host "      Node.js $nodeVersion  29.7 MB  verified"`，大小取下载完成后的文件大小。

**5. 成功摘要**

- `Add-InstallPath` 返回布尔值：注册表里的用户 PATH 被改写时返回 `$true`，本来就有时返回 `$false`。修改当前进程 `$env:Path` 的逻辑不变。
- 删掉现在结尾的 `Installed ohbaby $version at '$installDir'.` 和 `Reopen other terminals…`、`Run '…ohbaby.cmd' or add …` 三种提示。
- `Remove-OldNpmInstall` 做完后打印一个空行和摘要，格式与 sh 相同：

| 行 | 内容 |
|---|---|
| 第一行 | 与 sh 相同的三种情况，`$previous` 为空、不同、相同 |
| `Launcher` | `$binDir\ohbaby.cmd` 的完整路径 |
| `PATH` | `Add-InstallPath` 返回 `$true`：`Added to your user PATH. This window is ready; open a new terminal for other windows.`；返回 `$false`：`<binDir> is already in PATH.`；`OHBABY_NO_MODIFY_PATH=1`：`Not changed. Add <binDir> to PATH, or run the launcher directly.` |
| `Start` | `Get-Command ohbaby` 的第一个结果正好是我们的 `ohbaby.cmd` 时显示 `ohbaby`，否则显示启动器完整路径 |

ps1 在第 4 步出错时会抛异常、不打印摘要，这一点保持不变。`Write-Warning` 输出的清理警告会出现在摘要之前。

**DoD**

- 04 中"非 TTY 输出"一层在 Windows CI 上全部通过，包括纯 ASCII 检查。
- 04 中 Windows 真机验收清单全部完成，结果记录在 05。

### Stage 3：`ohbaby uninstall`

回应 P5（卸载没有过程提示，结尾也没有"已卸载"）。

改动只在 `packages/ohbaby-cli/src/cli/commands/uninstall.ts`，另在 `packages/ohbaby-cli/src/install/uninstall-plan.ts` 里加一个生成步骤文案的函数。确认前列出计划的部分（`describeUninstallAction`）不变。

**执行阶段的输出**

- 步骤总数 N 只算会真正改动文件或 PATH 的 action。`windows-manual` 只是打印删除说明，不算一步：执行循环跳过它，现在写在 `executeUninstallAction` 里的那段说明文字抽成单独的函数，在结尾的提示之后调用。
- 普通步骤：先写 `[i/N] <文案>`，按本次所有步骤里最长的文案补空格对齐，执行 action，成功后补 `  done` 和换行；失败时补 `  failed` 和换行，再按现在的方式把错误写到 stderr、退出码为 1。
- npm 步骤：先写完整的一行 `[1/1] Uninstalling ohbaby-cli from <prefix>`，再运行 npm。npm 的 spinner 和 `removed N packages` 照常输出，这一步不补 `done`。
- 编号的颜色和安装器一致：stdout 是 TTY 且没有 `NO_COLOR` 时用 `#D4A24F`。命令的 runtime 现在只有 `isStdinTTY`，要在 `CliCommandRuntime` 上加一个 `isStdoutTTY`，由它决定是否上色；颜色用包里已有的 `chalk` 创建一个单独的实例，按 `isStdoutTTY` 和 `NO_COLOR` 设定颜色级别，不直接读 `process.stdout`，这样单元测试能控制。不新增依赖。
- 路径里 `$HOME` 开头的部分显示为 `~`（Windows 不缩写）。

步骤文案：

| action | 文案 |
|---|---|
| `shell-config`、`fish-config` | `Removing the PATH block from <path>` |
| `launcher` | `Removing the launcher at <path>` |
| `directory` | `Removing <path>` |
| `windows-path` | `Removing <path> from your user PATH` |
| `npm` | `Uninstalling ohbaby-cli from <prefix>` |

`shell-config` 这类 action 在文件里没有 PATH 块时什么也不做，也照样显示 `done`。`done` 的意思是"这一步检查并处理完了"。本轮不为了区分"删了"和"本来就没有"去改各个 action 的返回值。

**结尾**

步骤全部完成后空一行：

- macOS、Linux 脚本安装和 npm 安装：打印 `ohbaby is uninstalled.`，再打印现有的 `Kept your configuration at …` 行。
- Windows 脚本安装：命令运行时还在使用安装目录里的 Node，删不掉这个目录，所以不能直接说"已卸载"。打印 `ohbaby is removed from your PATH. To finish, delete the installation directory after this command exits:`，接着打印现有 `windows-manual` 的 PowerShell 和 cmd 删除命令，最后打印 `Kept your configuration at …` 行。

> Windows 脚本安装的结尾文案是写 02 时根据代码补充的细节，2026-11-21 用户审查时确认，见 00 §2.2。

**DoD**

- 04 中"卸载输出"一层的单元测试全部通过。
- `packages/ohbaby-cli/src/install/script-uninstall.unit.test.ts` 现有用例全部通过。

### 收尾：发布说明

三个 Stage 都完成后，更新 `docs/releases/unreleased.md`。现在"Planned for v0.2.0"下的两条已经写了安装进度和完成摘要，实施后把它们改成已完成的描述，并补一句 `ohbaby uninstall` 会显示每一步的结果。

## 2.4 按包和目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-cli/install.sh` | 显示状态初始化、`stage`、`download_node_archive`、进度条绘制 | `main`、`prepare_node`、`prepare_release`、`configure_path`、`finish_install`、`cleanup_on_exit` | 旧的完成提示三行 | Stage 1 |
| `packages/ohbaby-cli/install.ps1` | `Write-Stage`、进度条绘制 | `Get-NodeDownload`、`Initialize-Node`、`Install-Release`、`Add-InstallPath`、`Invoke-OhbabyInstall` | `$ProgressPreference` 设置、旧的完成提示 | Stage 2 |
| `packages/ohbaby-cli/src/cli/commands/uninstall.ts` | 步骤行输出 | 执行循环和结尾提示 | 无 | Stage 3 |
| `packages/ohbaby-cli/src/install/uninstall-plan.ts` | 步骤文案函数 | 无 | 无 | Stage 3 |
| `packages/ohbaby-cli/src/cli/commands/` | `uninstall.unit.test.ts` | 无 | 无 | Stage 3 测试 |
| `tests/integration/cli/` | PTY 显示测试 | `install-unix.integration.test.ts`、`install-windows.integration.test.ts` | 无 | Stage 1、2 测试，细节见 04 |
| 根目录 `package.json` | 无 | `devDependencies` 加 `@lydell/node-pty`，版本与 `packages/ohbaby-server` 相同 | 无 | PTY 测试用。pnpm 的隔离布局下，`tests/` 引用不到 ohbaby-server 的依赖；版本相同，锁文件里已有，不会多下载 |
| `packages/ohbaby-cli/src/cli/commands/types.ts` | 无 | `CliCommandRuntime` 加 `isStdoutTTY`，默认实现处一并补上 | 无 | Stage 3 |
| `.github/workflows/ci.yml` | 无 | "Installer scripts" 步骤 | 无 | 这一步按文件名列出要跑的测试，新增的 PTY 测试文件要加进去。卸载单元测试由现有的 `pnpm test:unit` 覆盖，不用改 |
| `docs/releases/` | 无 | `unreleased.md` | 无 | 收尾 |

不改：`packages/ohbaby-cli/src/cli/commands/update.ts`、`packages/ohbaby-cli/src/install/child-command.ts`、两份 README 里的安装命令、Web 端。

## 2.5 兼容性

- **脚本的调用方式不变**：环境变量（`OHBABY_INSTALL_VERSION`、`OHBABY_NODE_MIRROR`、`OHBABY_NO_MODIFY_PATH`、`OHBABY_NON_INTERACTIVE` 等）、退出码、安装目录布局都不变。
- **新版 CLI 调用旧版脚本，或旧版 CLI 调用新版脚本**：`ohbaby update` 下载的是目标版本的脚本，只依赖退出码，不解析脚本输出，所以新旧组合都能正常工作，只是显示效果取决于目标版本的脚本。
- **非 TTY 输出有变化**：日志或 CI 里会多出阶段行和收尾行，完成提示换成摘要格式。仓库里只有安装器集成测试解析这些文字，随 Stage 1、2 一起调整。用户脚本如果解析过旧提示（比如 `Activated ohbaby`），会受影响。这些提示从来不是公开接口，在发布说明里提一句即可。
- **`curl | sh` 的 stdin**：不读 stdin。终端宽度从 `/dev/tty` 读，拿不到就按 80 列，不会卡住。

## 2.6 风险与回滚

| 风险 | 可能性 | 影响 | 应对 |
|---|---|---|---|
| sh 后台 curl 在 Ctrl-C、SIGTERM、SIGHUP 时没被结束 | 中 | 临时目录被删后 curl 还在写文件；锁被释放后残留进程 | `cleanup_on_exit` 显式 `kill` 加 `wait`；04 的 PTY 测试覆盖 Ctrl-C |
| 光标没恢复 | 中 | 用户终端里光标消失 | 清理函数里恢复；PTY 测试检查输出里有 `\033[?25h` |
| 不同 sh（dash、busybox ash）对 `sleep 0.1`、`$(( ))`、`kill -0` 的支持不同 | 低 | 进度条刷新慢或报错 | 启动时试一次 `sleep 0.1`；只用 POSIX 算术；Linux CI 上的 `sh` 是 dash，PTY 测试在那里跑 |
| `Content-Length` 在重定向时取错，或为 0 | 中 | 百分比错乱；为 0 时 dash 除法报错，脚本直接退出 | 只看最后一段响应头；不大于 0 按没有总大小处理；百分比封顶 100%；T25 覆盖 |
| 新增的变量在 `set -u` 下未初始化 | 中 | 清理函数中断，安装锁泄漏 | 在 trap 之前初始化；L1 的失败用例（daemon 检查失败等）会走到这条路径 |
| Windows 请求没有 User-Agent | 低 | 部分代理或镜像拒绝下载 | 显式设置 `UserAgent`；W7、W8 |
| Windows 上 `HttpWebRequest` 的代理行为和 `Invoke-WebRequest` 不同 | 低 | 企业网络下载失败 | 依据见 00 §2.1.1；真机在系统代理和 PAC 下各验一次 |
| conhost 里 `` `r `` 重画闪烁、颜色残留 | 中 | 只是不好看 | 250 ms 刷新；`finally` 恢复颜色；真机验收 |
| 中文 Windows 上 `━` 按双宽显示 | 低 | 进度条折行 | 非 65001 编码一律用 ASCII |
| 摘要的 `Start` 行判断错 | 低 | 告诉用户运行 `ohbaby` 却启动了旧的 npm 副本 | 用 `command -v` 和 `Get-Command` 的实际结果判断，不靠推测 |

回滚：每个 Stage 只涉及上表列出的文件，`git revert` 对应提交即可。安装目录、锁和版本指针的格式没有变化，新旧脚本装出来的东西完全一样，回滚后不需要用户做任何事。

## 2.7 与 00 边界对齐检查

| 00 的边界 | 本方案 |
|---|---|
| 不打印大号 `OHBABY` logo | 没有 logo，第一行就是 `[1/4]` |
| 卸载不做进度条 | Stage 3 只有步骤行 |
| Windows 不用 `curl.exe` | Stage 2 用 `HttpWebRequest` |
| 不改代理凭据行为 | `Credentials` 用默认值 |
| 不自己实现 spinner | 第 3 步交给 npm |
| 不加 quiet 或 verbose 开关 | 没有新增参数或环境变量 |
| 不加 `ohbaby installer` 标题行 | 没有 |
| 不改安装目录布局、锁、版本切换 | 只改输出；`cleanup_on_exit` 新增的是结束 curl 和恢复光标，锁的获取和释放顺序不变 |
| 不涉及 Web 端 | 没有 |

## 2.8 不在本轮

| 项 | 原因 | 何时再议 |
|---|---|---|
| 需要认证的代理 | 本议题只改显示 | 有用户反馈时单独开题 |
| Windows 进度条的自动化测试 | ConPTY 在 CI 上不稳定 | CI 环境改善后 |
| 卸载时区分"已删除"和"本来就没有" | 要改各个 action 的返回值，收益小 | 有用户反馈时 |
| 安装器改为下载独立可执行文件 | 属于 App 端适配（Node SEA） | 那个议题开题时，届时进度条代码可以复用 |
| update 和脚本摘要的重复提示 | 00 §2.4 决定保留 | 不再议 |

本轮没有构成分轮事件的切割项，不预留 improve-2。
