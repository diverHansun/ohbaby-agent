# 03 参考项目借鉴

> 本文只记录在本地源码里核实过的做法。路径相对于上级目录 `code-cli/`，行号是 2026-11-17 调研时的快照；3.2 节末尾三行是 2026-11-18 探针之后补的。

## 3.1 借鉴来源

| 项目 | 本地路径 | 调研范围 |
|---|---|---|
| pi | `pi/packages/coding-agent/` | 自管安装目录、版本切换、update 锁、清理旧版本、BOM 问题 |
| codex | `codex/scripts/install/install.sh`、`install.ps1` | 版本目录、`current` 链接、交互判断、Windows junction |
| Step-Code | `Step-Code/infra/release/install.sh`、`install.ps1` | 先写临时文件再改名、Windows 用户 PATH 写法、TLS 1.2 |
| opencode | `opencode/packages/cli/src/commands/handlers/` | 识别安装方式、npm 前缀、卸载提示 |
| claude-code | `claude-code/src/utils/nativeInstaller/installer.ts` | 版本目录保留数量 |
| npm 自带的 cmd-shim | Node 安装包里的 `npm/node_modules/cmd-shim/lib/index.js`（不在 `code-cli/` 下） | Windows `.cmd` 运行中被改写的处理 |

minimax-code 内置了一份 pi 的代码（`minimax-code/third_party/pi-mono`），不单独列出。kimi-code 走 Node SEA 单文件，ZCode 是 Electron 应用，两者的安装方式和本议题差别较大，没有展开。

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|---|---|---|---|
| pi | 自管安装根目录，版本号写在 `current-version` 文本文件里，先写 `current-version.tmp.<pid>-<时间>` 再改名（`package-manager-cli.ts:147-148`） | 和 ohbaby 一样是"私有 Node + npm 包"的路线 | **采纳**：`current` 用同样的写法（02 Stage 2 第 9 步） |
| pi | update 前加文件锁（`package-manager-cli.ts:200`、`:218`，用 proper-lockfile） | 防止两个 update 同时跑 | **改造采纳**：安装脚本里没有 Node 库可用，改用 `mkdir install.lock` 加 pid 文件 |
| pi | 新版本装进 staging，跑 `--version` 冒烟测试通过后才切换（`:131`） | 防止切到装坏的版本 | **采纳**：`.partial` 目录加试跑（00 的 5.10 节） |
| pi | 清理时保留当前版本和正在运行 update 的版本，注释说明手改 `current-version` 就能回滚（`:158-159`） | Windows 上正在运行的版本删不掉 | **采纳**：保留新旧两个 `current`（02 Stage 2 第 11 步） |
| pi | 修过一个 bug：Windows PowerShell 5.1 改写 `managed-install.json` 时加了 BOM，导致 update 读不出标记（`CHANGELOG.md:317`） | ohbaby 的 ps1 也要写 `current` | **采纳**：写入不带 BOM，读取时去掉 BOM（00 的 5.10 节） |
| pi | 用安装标记文件 `managed-install.json`（`:56`）和环境变量 `PI_MANAGED_INSTALL_ROOT` 识别自管安装 | 程序需要知道自己是怎么装的 | **改造采纳**：只用环境变量 `OHBABY_INSTALL_DIR`，再加路径确认，不另放标记文件（00 的 5.10 节） |
| codex | `releases/<版本>` 加 `current` 链接，切换时先建 `.current.<pid>` 临时链接再改名（`install.sh:25`、`:1209-1211`） | 版本目录布局几乎一样 | **改造采纳**：布局照搬，链接换成文本文件，因为 Windows junction 需要一大段 C# 代码（`install.ps1:523-692`） |
| codex | 能打开 `/dev/tty` 才算交互，提问和读回答都走 `/dev/tty`（`install.sh:1016-1018`） | `curl \| sh` 时标准输入是脚本本身，不能从它读回答 | **采纳**（00 的 5.7 节） |
| Step-Code | 写文件时先写 `<目标>.tmp.$$`，再 `mv -f`（`install.sh:310-313`）；工作目录用 `mktemp -d` | 中途失败不会留下半个文件 | **采纳**：启动脚本和 `current` 都这样写 |
| opencode | 从自身路径反推 npm 前缀，升级时加 `--prefix`（`services/updater.ts:178-193`） | 用户可能有多个 Node 版本，PATH 上的 npm 不一定是装 ohbaby 的那个 | **采纳**：update 和 uninstall 都用前缀（00 的 5.9 节）。opencode 在 Windows 上不反推前缀，因为 pnpm、bun 的全局目录也是 `<前缀>\node_modules`（`:178-180`）；ohbaby 改为要求前缀下同时有 `npm.cmd` 和 `ohbaby.cmd` |
| opencode | 卸载 curl 安装版时，只打印可执行文件路径，让用户手动删除（`uninstall.ts:39`、`:113`） | 程序不能删除正在运行的自己 | **改造采纳**：Unix 上 ohbaby 可以直接删；Windows 上打印两行完整的删除命令 |
| claude-code | native 安装只保留 2 个版本（`nativeInstaller/installer.ts:74`、`VERSION_RETENTION_COUNT`） | 占用空间和回滚之间的平衡 | **采纳**：与 pi 的结论一致，保留两个 |
| Step-Code | 用户 PATH 直接读写注册表：读取时 `DoNotExpandEnvironmentNames`，写回时 `ExpandString`，再用 `SendMessageTimeout` 广播 `WM_SETTINGCHANGE`（`install.ps1:435-500`）；注释写明这是同时保留 `%变量%` 写法和值类型的唯一办法 | 探针 P6 证实 `SetEnvironmentVariable` 会把 `REG_EXPAND_SZ` 改成 `REG_SZ` | **采纳**（00 的 5.7 节、02 第 10 步） |
| Step-Code | 脚本开头设置 TLS 1.2（`install.ps1:33`） | 旧版 Windows 上 PowerShell 5.1 默认可能不带 TLS 1.2 | **改造采纳**：Step-Code 直接赋值，ohbaby 在现有值上加上 TLS 1.2，不去掉系统已开的更新协议 |
| pi | Windows 上同时写 `pi.cmd` 和 `pi.ps1`，路径都从自身位置推出（`%~dp0`、`$PSScriptRoot`，`scripts/local-release.mjs:58-64`） | 探针 P1 发现 PowerShell 经 `.cmd` 传参会被 cmd 改写，`.ps1` 能绕开 | **部分采纳**：采纳 `%~dp0` 推出路径；不加装 `.ps1`，原因见 3.3 |

## 3.3 明确不借鉴

| 做法 | 来源 | 不借鉴的原因 |
|---|---|---|
| 符号链接或 junction 做版本切换 | codex | Windows 上要额外维护一段 C# 代码；ohbaby 的启动脚本反正要读文件，文本指针更简单 |
| 安装器专用 `package-lock.json` 加 `npm ci` | pi（`package-manager-cli.ts:249-252`） | 发版流程要多产出一个锁文件，本轮不做，方向记在 00 的 5.8 节 |
| 在 TypeScript 里再写一遍安装逻辑 | pi 的 `runManagedSelfUpdate` | 首次安装没有 Node，脚本里必须有一份；update 重新运行脚本即可，不再维护第二份 |
| 单文件可执行文件 | kimi-code（SEA）、Step-Code、codex（Rust 二进制） | ohbaby 依赖 node-pty、koffi 等原生模块，打成单文件要另外处理，留给 App 议题 |
| Windows 上把已加载的原生模块挪到隔离目录 | pi（`utils/windows-self-update.ts`） | ohbaby 每个版本有独立目录，新版本装进新目录，不需要挪动旧版本的文件 |
| Windows 上再放一个 `ohbaby.ps1` | pi、npm | 执行策略为 Restricted 时，PowerShell 先找到 `.ps1` 并直接报错，不会退回 `.cmd`，等于在这类机器上运行不了。只装 `.cmd` 的代价是 PowerShell 里少数特殊参数会被 cmd 改写，README 写明（00 的 5.11 节，2026-11-19 确认） |
| `.cmd` 最后用 `endLocal & goto #_undefined_#` 结束批处理 | npm 的 cmd-shim（`lib/index.js:115`） | 能防住运行中被改写，但会提前结束 `setlocal`，ohbaby 启动脚本设的 `OHBABY_INSTALL_DIR` 传不到 node（探针 P2）。改用"node 和 `call exit /b` 写在同一行" |

## 3.4 对 02 方案的影响

- 版本目录加文本指针、先装到临时目录再试跑、清理时保留两个版本：直接来自 pi 和 codex，两家结论一致。
- 不放标记文件、不用符号链接：是在参考做法的基础上做的简化，理由是启动脚本本来就要读文件。
- `/dev/tty` 交互判断、npm `--prefix`：分别来自 codex 和 opencode，属于各家踩过的坑。
- 依赖锁定没有跟进 pi，原因见 3.3。
- 探针之后补的三处（注册表写 PATH、TLS 1.2、`%~dp0` 推路径）都来自参考项目；Windows 启动脚本的最后一行是 ohbaby 自己的写法，因为 npm 的做法和 ohbaby 要设环境变量的需求冲突。
