# 04 测试与验收

> 本文是实施会话自测和验收会话对照的依据。测试编号在 [02](02-optimization-plan-and-change-scope.md) 各 Stage 的完成定义里引用。

## 4.1 测试范围

| 层次 | 覆盖什么 | 放在哪里、怎么跑 |
|---|---|---|
| 单元测试（U） | 判断安装方式、读单行文本、uninstall 的动作计划、PATH 标记块的删除 | 和源码放在一起，命名 `*.unit.test.ts`，`pnpm test:unit` |
| 集成测试（S） | 真正运行 install.sh 和 install.ps1：安装、重装、升级、失败、加锁、卸载 | `tests/integration/cli/install-script.integration.test.ts`，`pnpm test:integration`；CI 在 ubuntu、windows、macos 上都跑 |
| 实施前探针（P） | 真机上先验证 02 依赖的几个假设，结论可能改 02 | 2026-11-18 已通过 SSH 在树莓派和 Windows 台式机上执行，结果见 4.4 节末尾 |
| 真机验收（R、L、W） | CI 覆盖不到的：没装 Node 的干净机器、真实终端、真实 PATH、arm64、PowerShell 5.1 | 实施完成后通过 SSH 手工执行，macOS 在本机执行 |

不为覆盖率写测试。sh 和 ps1 没有单元测试，它们的行为全部由 S 系列在三个系统上覆盖。

## 4.2 单元测试

| ID | 场景 | 验证点 | 对应 Stage |
|---|---|---|---|
| U1 | 脚本安装的识别 | `OHBABY_INSTALL_DIR` 已设置，且自身目录在 `<安装目录>/releases/<版本>/node_modules/ohbaby-cli` → `script`。安装目录带结尾斜杠、大小写不同（Windows）、经过符号链接（比较 realpath）时结果不变 | 1 |
| U2 | npm 安装的识别 | Unix `<前缀>/lib/node_modules/ohbaby-cli` 能反推出前缀，nvm 风格的前缀（`~/.nvm/versions/node/v24.x`）也对；Windows `<前缀>\node_modules\ohbaby-cli` 只有在 `<前缀>\npm.cmd` 和 `<前缀>\ohbaby.cmd` 都存在时才判为 npm，否则（例如 pnpm、bun 的全局目录）判为 `other` | 1 |
| U3 | 不误判 | 设置了 `OHBABY_INSTALL_DIR`，但自身不在它的 `releases/` 下（例如脚本版 ohbaby 启动的子进程里又运行了 npm 版）→ 不是 `script`；pnpm、源码仓库路径 → `other`。读单行文本时，开头的 BOM、结尾的 `\n` 和 `\r\n` 都被去掉 | 1 |
| U4 | daemon 状态路径 | 2026-11-19 移到前置议题 [daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/improve-1/04-test-and-acceptance.md)的 U7，本议题不再验收 | — |
| U5 | npm 安装的卸载计划 | 动作为"用 `<前缀>` 下的 npm 执行 `uninstall -g --prefix <前缀> ohbaby-cli`"；前缀下没有 npm 时退回 PATH 上的 npm | 3 |
| U6 | 脚本安装的卸载计划 | Unix：删 PATH 标记块、fish 文件、启动脚本、安装目录。Windows：删用户 PATH 项，最后输出两行删除命令，不含删除安装目录的动作。安装目录等于 `OHBABY_HOME`、等于主目录、缺少 `current` 或 `releases/` 时，计划为"拒绝" | 3 |
| U7 | PATH 标记块与启动脚本归属 | 只删除两个标记之间的内容，其他内容和空行保持原样；没有标记块的文件不改；只有开头标记、没有结尾标记时不改并报告。启动脚本第二行不是 `# ohbaby-launcher` 时不删除 | 3 |
| U8 | 脚本只含 ASCII | `install.sh`、`install.ps1` 和它们生成的启动脚本里没有非 ASCII 字符（00 的 5.11 节）。可以直接检查文件字节，不必跑脚本 | 2 |

## 4.3 集成测试

**做法**：沿用 `tests/integration/cli/packaging-smoke.integration.test.ts` 的打包和本地 registry（02 的 C7 把它们抽成共用函数）。在本地 registry 上发布两个测试版本，例如 `0.0.0-install.1` 和 `0.0.0-install.2`。

**环境**：

- 每个用例用临时目录作为 `HOME`（Windows 为 `USERPROFILE`）和 `OHBABY_INSTALL_DIR`，并设置 `OHBABY_NON_INTERACTIVE=1`。
- 通过 `npm_config_registry` 指向本地 registry。
- Node 安装包：第一次从 nodejs.org 下载后缓存到 CI 缓存目录，测试里用本地 HTTP 服务提供，并通过 `OHBABY_NODE_MIRROR` 指向它。这样也顺带测了镜像参数。

| ID | 场景 | 验证点 | 对应 Stage |
|---|---|---|---|
| S1 | 首次安装 | 目录布局与 02 的 2.1 一致；`current`、`node-version` 没有 BOM；启动脚本第二行是 `ohbaby-launcher 1`；通过启动脚本运行 `--version` 输出目标版本；`install.lock` 已删除 | 2 |
| S2 | 同一版本重复运行 | 不重新安装（release 目录的修改时间不变）；启动脚本不重写；不清理任何东西；退出码为 0 | 2 |
| S3 | 升级与清理 | 指定 `OHBABY_INSTALL_VERSION` 先装版本 1，再装版本 2：`current` 指向 2，版本 1 保留。再造一个假的版本 3 目录，并把 `current` 指向它后重新安装版本 2：两个版本之外的目录和没人用的 `runtime/node-v*` 被删掉，不留 `.trash-*` 目录；预先放一个残留的 `.trash-x` 目录，这次清理时也被删掉。换一个 `OHBABY_INSTALL_DIR` 重装：Unix 启动脚本里的安装目录被更新 | 2 |
| S4 | 安装失败不影响旧版本 | 指定一个 registry 上没有的 `OHBABY_INSTALL_VERSION`：停止并提示可能是镜像未同步，什么都没改。让试跑失败（例如在 registry 上放一个 `bin.js` 会直接报错的版本）：退出码非 0，`current` 不变，旧版本仍能运行，锁已释放；下次运行时删掉残留的 `.partial` | 2 |
| S5 | 加锁 | 预先建 `install.lock`，写入当前测试进程的 pid → 安装拒绝并提示；写入一个不存在的 pid → 视为过期锁，安装成功 | 2 |
| S6 | Node 校验失败 | 本地 HTTP 服务返回被改过的安装包 → 停止安装，`runtime/` 下没有新目录，提示校验失败 | 2 |
| S7 | PATH 写入 | Unix：分别模拟 zsh、bash、fish 用户（设置 `SHELL`），标记块写进 00 的 5.7 节规定的文件；运行两次只有一个标记块；设置 `OHBABY_NO_MODIFY_PATH=1` 时不改任何文件。Windows：用户 PATH 前面多了 `<安装目录>\bin`，运行两次不重复；注册表里的值类型保持 `REG_EXPAND_SZ`，原有的 `%变量%` 项没被展开（测试在 `finally` 里恢复原值，失败时也要恢复） | 2 |
| S8 | 已有 npm 版 | 在临时前缀里用本地 registry 装一个 npm 版并放到 PATH 上：非交互模式下不卸载 npm 版，输出里说明 PATH 上会先用到哪一个。再写一个假的 `daemon-state.json`（`status` 为 `running`）指向一个存活的测试进程：提示先停止 daemon，并且不继续安装；`status` 为 `stopped`，或 pid 已不存在时：照常安装。Unix 再加一种：npm 前缀就是 `HOME/.local`，交互式同意卸载后，`~/.local/bin/ohbaby` 仍是脚本版启动脚本（02 第 12 步） | 2 |
| S9 | 路径中有空格和非 ASCII 字符 | `OHBABY_INSTALL_DIR` 设为 `<临时目录>/有 空格/安装`：安装、通过启动脚本运行、卸载都正常。Windows 上再用 `chcp 936` 运行一次启动脚本，结果相同 | 2 |
| S10 | 卸载脚本安装 | 在 S1 的结果上运行 `ohbaby uninstall -y`。Unix：安装目录、启动脚本、PATH 标记块都没了，`OHBABY_HOME` 下的文件还在。Windows：用户 PATH 里没有 `<安装目录>\bin` 了，输出两行删除命令，复制执行后目录被删掉 | 3 |
| S11 | 卸载的边界 | `OHBABY_INSTALL_DIR` 等于 `OHBABY_HOME` 时拒绝，不删除任何文件；npm 版执行 `ohbaby uninstall -y` 后，前缀下的 `ohbaby-cli` 被删除 | 3 |

## 4.4 实施前探针（2026-11-18 SSH 执行）

目的是在写代码前确认 02 依赖的假设。哪一条结果和预期不符，就先回到 00 和 02 修改方案，再开始实施。所有操作都在临时目录里做，不改用户的 PATH，结束后删除。

下面两张表是执行前写的测法，保留原样；实际结果和据此做的修改见本节末尾的「执行结果」。

**Windows 台式机**

| ID | 要确认的假设 | 怎么测 | 不符时怎么办 |
|---|---|---|---|
| P1 | 02 里的 `.cmd` 启动脚本在 cmd 和 PowerShell 里都能用 | 手写 02 的 `.cmd`，指向一个手工准备的版本目录；分别在 cmd、PowerShell 5.1、PowerShell 7 里运行，参数带空格、引号、`&`、`%`；检查退出码能传出来 | 调整 `.cmd` 写法，更新 02 的启动脚本内容 |
| P2 | `.cmd` 运行中被改写会出错，所以启动脚本不能重写 | 运行一个会停住的 `.cmd`（例如中间等待输入），另一个窗口改写它，看原来那个进程的表现；再试括号块加 `exit /b` 的写法 | 如果括号块写法安全，在 02 里记为以后升级启动脚本格式的备选做法；主方案不变 |
| P3 | PowerShell 5.1 默认写文件会带 BOM，`set /p` 读出来会带上乱码 | 分别用 `Set-Content -Encoding UTF8`、`Out-File` 和 `[IO.File]::WriteAllText(…, UTF8Encoding($false))` 写一行版本号，用 `.cmd` 的 `set /p` 读出来拼成路径 | 如果 `WriteAllText` 也有问题，换别的写法并更新 00 的 5.10 节 |
| P4 | 私有 Node 加 `npm install --prefix --ignore-scripts` 装出来的 ohbaby 能用，原生模块能加载 | 下载 node-v24 的 win-x64 zip，用 PowerShell 5.1 的 `Expand-Archive` 解压（记录耗时）；用它的 npm 把当前发布的 `ohbaby-cli` 装进临时前缀；运行 `bin.js --version`；用私有 node 分别加载 `@lydell/node-pty`、`koffi`、`@vscode/ripgrep` 并执行一个最小调用 | `--ignore-scripts` 下哪个模块不能用，就记录原因，修改 02 的安装参数 |
| P5 | 正在运行的版本目录删不掉、改不了名，但其他目录可以 | 用 P4 的 node 运行一个长时间进程，然后对它所在目录分别做删除和改名，确认改名失败时目录里的文件一个都没被删掉（02 第 11 步先改名再删的依据）；另外在杀毒软件开着时，对刚装好的 `.partial` 目录立刻改名，重复 10 次 | 如果刚装好的目录改名偶尔失败，02 第 7 步加入"改名失败等待后重试几次" |
| P6 | 用 `[Environment]::SetEnvironmentVariable` 改用户 PATH 后，新窗口能生效，原有的 `%变量%` 写法不被破坏 | 先备份用户 PATH；如果其中有 `%USERPROFILE%` 这类写法，记录注册表值的类型（REG_EXPAND_SZ）；写入一个测试目录后，检查类型有没有变成 REG_SZ，新开的窗口里展开是否正常；最后恢复原值 | 如果类型被改坏，00 的 5.7 节和 02 第 10 步改为直接写注册表并保留原类型 |

**树莓派（Ubuntu arm64）**

| ID | 要确认的假设 | 怎么测 | 不符时怎么办 |
|---|---|---|---|
| P7 | linux-arm64 的私有 Node 加 npm 装出来的 ohbaby 能用 | 下载 node-v24 linux-arm64 安装包并按 SHASUMS256 校验；确认系统里有解压 `.tar.xz` 需要的 `xz`，没有就改用 `.tar.gz`；其余同 P4 | 记录要用哪种压缩格式，写进 02 第 5 步 |
| P8 | 没有终端时，`( : </dev/tty )` 会失败，从而自动按非交互处理 | 分别执行 `ssh 主机 'sh -c "( : </dev/tty ) && echo tty || echo notty"'` 和加 `-t` 的版本 | 交互判断改用其他办法，更新 00 的 5.7 节 |
| P9 | `~/.local/bin` 存在时，Ubuntu 的 `~/.profile` 会把它加进 PATH；但 `ssh 主机 命令` 不读 `~/.profile` | 建好 `~/.local/bin` 后分别看登录 shell 和 `ssh 主机 'echo $PATH'` 里的 PATH | 如果非登录 SSH 也需要能用，在安装完成的提示里加一句说明，方案不改 |
| P10 | SD 卡上的耗时和空间占用可以接受 | P7 时记录下载、解压、npm 安装各自的耗时，以及最终目录大小 | 写进 README 的平台说明 |

**执行结果（2026-11-18）**

机器：Windows 11 台式机（PowerShell 5.1.26100 和 7，Defender 实时保护开启，系统代码页 65001，936 用 `chcp 936` 模拟）；树莓派 Ubuntu 24.04.5 arm64（SD 卡）。测的是已发布的 `ohbaby-cli` 0.1.18 和 Node 24.22.3。

| ID | 符合预期吗 | 实际结果 | 改了什么 |
|---|---|---|---|
| P1 | 部分不符 | cmd、PowerShell 5.1、PowerShell 7 都能运行，带空格的参数和退出码正确。两个问题：写死中文安装目录的 `.cmd` 在 936 代码页下找不到路径；PowerShell 把 `'x&y'` 这类不带空格的参数原样交给 cmd，cmd 把它拆成两条命令 | 启动脚本改用 `%~dp0..` 推出安装目录；PowerShell 传参限制写进 README，不加装 `.ps1`（00 的 5.11 节，2026-11-19 用户确认） |
| P2 | 不符 | 原写法运行中被改写后，cmd 接着执行错位的新内容；文件没有被锁，改写本身总能成功。node 和 `call exit /b %%errorlevel%%` 写在同一行后，改写不影响正在运行的进程，退出码正确。括号块遇到参数里的 `)` 会解析失败；npm cmd-shim 的跳转写法会清掉 `setlocal` 里的变量 | 02 的 Windows 启动脚本换成同一行写法；"`.cmd` 运行中不能改写"的约束取消 |
| P3 | 符合 | `Set-Content -Encoding UTF8` 带 BOM，`.cmd` 读出 `�?.1.18`；`Out-File` 写成 UTF-16；`WriteAllText` 加 `UTF8Encoding($false)` 正常 | 无。另外发现不带 BOM 的 `.ps1` 被 5.1 按 ANSI 读取，中文会乱码，因此规定脚本只用 ASCII（U8） |
| P4 | 符合 | 下载 32 秒，SHA-256 通过；`Expand-Archive` 33 秒，`tar.exe` 1 秒；npm 安装 68 秒；`--version` 输出 0.1.18；node-pty、koffi、ripgrep 都能用；runtime 加 release 共 256 MB | 02 第 5 步优先用 `tar.exe` |
| P5 | 不符 | 正在运行的版本目录能改名（加载了原生模块也能），`node.exe` 所在的 runtime 目录也能；只加载 JS 时能整个删掉；加载了原生模块时删到一半失败（18971 个文件删掉 2267 个）。Defender 开着时，刚装好的目录立即改名 10 次都成功 | 02 第 11 步改写：先改名再删只为不留半截目录，运行中的旧版本靠保留的两个版本缓冲；不加改名重试 |
| P6 | 不符 | `SetEnvironmentVariable` 把测试变量从 `REG_EXPAND_SZ` 改成 `REG_SZ`，`%USERPROFILE%` 被写死。台式机真实的用户 PATH 是 `REG_EXPAND_SZ` 且含 `%` 写法 | 00 的 5.7 节和 02 第 10 步改为直接读写注册表并广播 `WM_SETTINGCHANGE`；Stage 3 卸载同样处理 |
| P7 | 符合 | 下载 30 秒，SHA-256 通过；Ubuntu 自带 `xz`；xz 包 30 MB、gz 包 56 MB，解压都在 3 秒内；node-pty、koffi、ripgrep 都能用 | 02 第 5 步：有 `xz` 用 `.tar.xz`，否则用 `.tar.gz` |
| P8 | 符合 | `ssh 主机 命令` 打不开 `/dev/tty`；加 `-tt` 后能打开。2026-11-19 补测 Windows：`ssh 主机 powershell …` 里 `[Environment]::UserInteractive` 为 False | 无 |
| P9 | 符合 | Ubuntu 默认只在登录 shell 里加入 `~/.local/bin`；这台树莓派的非登录 SSH 也能用，是用户自己在 `~/.bashrc` 开头加了 PATH | 装完的提示里加一句说明 |
| P10 | 符合 | npm 安装 76 秒；runtime 205 MB（其中 `include/` 67 MB），release 202 MB | README 写"约 0.5 GB，Linux arm64 约 0.6 GB" |

另外两点不属于 P1–P10，但影响 02：

- 台式机开着系统代理 127.0.0.1:7897，在 SSH 会话里这个代理连不上 nodejs.org，`Invoke-WebRequest` 只报"基础连接已经关闭"。02 的写法要求因此加了"失败时打印地址并提示检查代理"。
- 树莓派上有 `npm --prefix ~/.local` 装出来的命令（`~/.local/bin/pi`），说明 npm 链接和启动脚本落在同一路径的配法真实存在。02 第 12 步因此加了卸载后再检查启动脚本，S8 加了对应场景。

## 4.5 真机验收（实施完成后）

与 00 第 6 节对应。macOS 在本机执行 R 系列。

**三个系统都要做**

| ID | 验收项 | 通过标准 |
|---|---|---|
| R1 | 在没装 Node 的环境下一条命令安装 | `ohbaby --version` 正常；新开终端仍然能用 |
| R2 | 原生依赖 | 能打开终端面板（node-pty）、能搜索（ripgrep）、koffi 相关功能正常 |
| R3 | `ohbaby update` | 升级到新版本；daemon 在跑或有其他 ohbaby 窗口开着时，按 CLI 升级议题的规则提示 |
| R4 | 升级中途失败 | 安装过程中断网：`current` 不变，旧版本照常可用，下次运行时清掉残留的 `.partial` |
| R5 | 两个安装同时运行 | 后启动的那个被锁挡住，提示清楚 |
| R6 | 从 npm 版切换 | 交互模式询问是否卸载 npm 版，同意后带 `--prefix` 卸载；拒绝时提示 PATH 上会先用到哪一个 |
| R7 | `ohbaby uninstall` | npm 版和脚本版都能卸干净，`~/.ohbaby` 下的配置和数据库保留；安装目录设成 `~/.ohbaby` 时拒绝删除 |
| R8 | 自定义安装目录 | 设置 `OHBABY_INSTALL_DIR` 后，安装、升级、卸载都使用这个目录 |

**树莓派额外**

| ID | 验收项 | 通过标准 |
|---|---|---|
| L1 | 下载的 Node | 是 linux-arm64 版本，SHA-256 校验通过 |
| L2 | 交互判断 | `ssh 主机 'curl … \| sh'` 自动按非交互处理；在交互式 SSH 会话里能从 `/dev/tty` 读到回答 |
| L3 | PATH 已包含 `~/.local/bin` | 不重复写配置文件，提示里说明已在 PATH 中 |
| L4 | nvm 装的 npm 版 | 切换时能正确反推前缀并卸载 |
| L5 | SD 卡 | 安装耗时和空间占用写进 README，约 0.5 GB |

**Windows 额外**

| ID | 验收项 | 通过标准 |
|---|---|---|
| W1 | 两种 PowerShell | Windows PowerShell 5.1 和 PowerShell 7 都能用 `irm … \| iex` 安装 |
| W2 | PATH | 写入后新窗口能用；当前窗口按提示操作后能用；`ohbaby.cmd` 在 cmd 和 PowerShell 里都能运行；用户 PATH 的注册表类型仍是 `REG_EXPAND_SZ`，原有的 `%变量%` 写法没变 |
| W3 | 旧版本运行中升级 | 开着一个 `ohbaby` 窗口时升级：新版本装好并切换，原窗口照常使用、退出码正确。再升级一次，删不干净的 `.trash-*` 留着，关掉窗口后下次清理时删掉 |
| W4 | BOM | ps1 写出的 `current`、`node-version` 没有 BOM；手工加上 BOM 后 CLI 仍能正确读取（`.cmd` 读不了 BOM，探针 P3 已确认，所以只检查写入端） |
| W5 | npm 版卸载 | `ohbaby uninstall` 能完成；最后多打印一句"找不到批处理文件"属于已知现象（00 的 5.4 节） |
| W6 | 杀毒软件 | Windows Defender 开启时安装和升级都能成功 |
| W7 | Ctrl+C | 在真实的 cmd 和 PowerShell 窗口里运行 `ohbaby`，按 Ctrl+C 退出：记录是否出现"终止批处理操作吗(Y/N)?"。出现了就写进 README 的已知现象，不改启动脚本（SSH 里测不到，探针没有覆盖） |

## 4.6 回归清单

- npm 安装路径不受影响：现有 `packaging-smoke` 集成测试照常通过。
- 没有运行安装脚本的用户，`ohbaby` 的行为完全不变，包括 `serve` 的共存提示（只是改为读 `OHBABY_HOME` 下的文件）。
- `npm pack` 的结果里，除了新增的 `install.sh` 和 `install.ps1`，其他文件不变。

## 4.7 验收标准（发布门）

| ID | 标准 | 怎么验证 |
|---|---|---|
| A1 | U1–U8 通过 | `pnpm test:unit` |
| A2 | S1–S11 在三个系统上通过 | CI 的安装脚本测试步骤 |
| A3 | 真机验收 R1–R8、L1–L5、W1–W7 通过 | 验收会话记录每项结果 |
| A4 | 回归清单通过 | `pnpm test:integration`、`pnpm typecheck`、`pnpm lint` |
| A5 | sh 和 ps1 行为一致 | 两份脚本按 02 Stage 2 的 13 步逐步对照；S 系列在三个系统上的断言相同 |
| A6 | 文档与发版 | README 写明两种安装命令、`update`、`uninstall`、支持的平台，以及 Windows PowerShell 里的传参限制和加引号的写法；发布后用 jsDelivr 上带版本号的地址实际装一次 |

## 4.8 对抗性审查要点

| 攻击面 | 可能出什么事 | 防御 | 残余风险 |
|---|---|---|---|
| 卸载删错目录 | 用户把 `OHBABY_INSTALL_DIR` 设成主目录或 `~/.ohbaby`，卸载删掉了用户数据 | 02 Stage 3 的安全检查；U6、S11 | 用户把安装目录设成别的重要目录，并且里面恰好有 `current` 和 `releases/`，可能性很低 |
| 下载内容被篡改 | 镜像或网络中间人替换 Node 安装包 | 按 SHASUMS256 校验（S6） | SHASUMS256 和安装包来自同一个来源；镜像本身被攻破时校验不住，本轮接受 |
| `curl \| sh` 下载到一半 | 网络中断，sh 执行了半截脚本 | 脚本主体包在函数里，最后一行才调用 | 无 |
| 启动脚本写坏 | 写到一半断电，或第二行格式不对 | 先写临时文件再改名；安装时读格式版本号，不认识就重写；Windows 的 `.cmd` 用同一行写法，运行中被改写也安全（P2） | 无 |
| 版本号被注入 | `current` 被改成 `../../x` 之类的值，启动脚本拼出意外的路径 | 安装脚本写入前检查版本号只含数字、字母、`.` 和 `-`；启动脚本不做检查，保持最小 | 能改 `current` 的人本来就能改启动脚本，不算新增风险 |
| sh 和 ps1 不一致 | 只修了一份 | S 系列在三个系统上跑同一组场景；A5 | 只在某个系统上出现的分支，靠真机验收发现 |
| PATH 被改坏 | Windows 上写回用户 PATH 时把原有的 `%变量%` 写法变成固定值 | 直接读写注册表，读时不展开、写回保留 `REG_EXPAND_SZ`（P6 的结论）；S7 检查写入前后其他项和注册表类型都不变 | 无 |
