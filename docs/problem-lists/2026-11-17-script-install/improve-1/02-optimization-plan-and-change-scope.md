# 02 方案与改动面

> 本文是交给实施会话的契约：实施者按本文改代码，按 [04](04-test-and-acceptance.md) 自测和验收。规划会话不写代码。决定的来源见 [00](00-discussion.md)，问题编号 P1–P4 见 [01](01-problem-analysis-and-current-state.md)。

## 2.1 方案总览

新增一条不需要事先装 Node 的安装路径。安装脚本先下载一份私有的官方 Node，再用它自带的 npm 把 `ohbaby-cli` 装进 ohbaby 自己的目录。每个版本一个目录，用一行文本 `current` 指明当前版本，用一个装好后不再改动的启动脚本启动程序。

```
~/.ohbaby/install/                    （OHBABY_INSTALL_DIR）
  install.lock/                       安装期间存在的锁目录，内有 pid 文件
  runtime/node-v24.22.3/              私有 Node（Unix 为 bin/node，Windows 为 node.exe）
  releases/0.1.19/                    npm --prefix 安装结果
    node_modules/ohbaby-cli/…
    node-version                      一行文本：24.22.3
  releases/0.1.20.partial/            装到一半的版本，装好并试跑通过后改名
  current                             一行文本：0.1.19
  bin/ohbaby.cmd                      仅 Windows：启动脚本
~/.local/bin/ohbaby                   仅 macOS、Linux：启动脚本

启动：ohbaby → 启动脚本 → 读 current → 读 releases/<v>/node-version
            → 设置 OHBABY_INSTALL_DIR，把私有 Node 目录追加到 PATH 末尾
            → <私有 node> releases/<v>/node_modules/ohbaby-cli/dist/bin.js
```

TypeScript 一侧只做两件事：判断自己是怎么装的（npm、脚本或其他），以及新增 `ohbaby uninstall` 命令。`ohbaby update` 在 [CLI 升级](../../2026-11-16-cli-upgrade/README.md) 议题实现，识别到脚本安装时，就重新运行目标版本的安装脚本。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 安装产物 | 私有 Node + npm 包（00 第 3 节） | 现有 npm 包原样复用，发版不用为各平台构建 | 单文件可执行文件；只发 JS 包、用系统 Node | 占用约 0.5 GB；依赖 npm registry 可用 |
| 版本切换 | 版本目录 + 文本指针 `current`（00 的 5.1 节） | Windows 上不覆盖正在运行的文件；两个平台一套机制 | 符号链接或 junction；原地覆盖 | 启动多读两个小文件 |
| 安装逻辑放哪 | 只写在 sh 和 ps1 里，update 重新运行脚本（00 的 5.2 节） | 首次安装没有 Node，本来就只能写在脚本里；不在 TypeScript 再写第三份 | 像 pi 那样在 TypeScript 里再实现一遍 | sh 和 ps1 要保持行为一致 |
| 启动脚本 | 最小、稳定，带格式版本号（00 的 5.10 节）。**不可逆**：发到用户机器后很难再改 | 改格式要兼顾所有已装用户；Windows `.cmd` 用"最后一行同时退出"的写法，运行中改写也安全（00 的 5.11 节） | 每次安装重写启动脚本 | 以后新增逻辑只能放进 `bin.js` 或它读取的文件 |
| 程序怎么知道装在哪 | 启动脚本设置 `OHBABY_INSTALL_DIR`，程序再确认自己位于 `<安装目录>/releases/` 下（00 的 5.10 节） | 不用从路径猜；防止子进程继承变量而误判 | 只看路径；另放标记文件 | 无 |
| 脚本分发 | 放进 `ohbaby-cli` 的 npm 包，经 jsDelivr 访问（00 的 5.5 节） | 发 npm 时脚本自动带上 | GitHub 原始文件；Release 附件 | 首次安装依赖 jsDelivr |
| Node 版本 | 脚本里写死 `NODE_VERSION`，发版时升到 24.x 最新补丁（00 的 5.6 节） | 大家用同一个 Node，好排查 | 自动追最新 | 发版清单多一条 |
| 卸载 | 新增 `ohbaby uninstall`，npm 和脚本安装都能卸（00 的 5.4 节） | 用户不用记命令；update 和 uninstall 对称 | 只在 README 写手动步骤 | Windows 最后一步交给用户执行 |

## 2.3 分阶段实施

全部 Stage 属于 improve-1。Stage 1 先做，Stage 2 和 Stage 3 可以并行；Stage 4 依赖 Stage 2。

与 CLI 升级议题的先后关系：

- 本议题 Stage 1 的"判断安装方式"被 `ohbaby update` 使用，要先于 CLI 升级议题里脚本安装那一支。
- 本议题 Stage 3 的 `ohbaby uninstall` 复用 CLI 升级议题的"升级前检查"（检查运行中的任务、停 daemon、检查其他进程）。如果那边还没做完，Stage 3 先只实现 npm 和脚本两支的删除逻辑，检查部分等那边合入后接上。

### Stage 1：判断安装方式（TypeScript）

**目标**：程序能说清自己是 npm 安装、脚本安装还是其他方式，并给出 npm 前缀或安装目录。

**改动**：

- 新增 `packages/ohbaby-cli/src/install/install-method.ts`，导出 `detectInstallMethod()`，是不读写全局状态的纯函数，输入是自身 `package.json` 所在目录、环境变量、平台，输出以下三种结果之一：
  - `{ kind: "script", installDir }`：`OHBABY_INSTALL_DIR` 存在，并且自身目录（取 realpath 后比较）位于 `<installDir>/releases/<版本>/node_modules/ohbaby-cli`。
  - `{ kind: "npm", prefix }`：Unix 上自身目录形如 `<前缀>/lib/node_modules/ohbaby-cli`，前缀从路径反推。Windows 上形如 `<前缀>\node_modules\ohbaby-cli`，但 pnpm、bun 的全局安装也是这个形态（opencode `updater.ts:178-180` 的注释），所以还要求 `<前缀>\npm.cmd` 和 `<前缀>\ohbaby.cmd` 都存在，才判为 npm。
  - `{ kind: "other" }`：以上都不是，例如 pnpm、bun、yarn、volta 或源码仓库直接运行。
- 自身目录用 `import.meta.url` 往上找 `package.json`，与 `src/package-version.ts:3` 用同一个起点。
- 新增 `packages/ohbaby-cli/src/install/text-file.ts`：读取 `current`、`node-version` 一类单行文本时，去掉开头的 BOM 和结尾的换行（00 的 5.10 节）。
- ~~`packages/ohbaby-cli/src/serve-awareness.ts:75-79` 的 daemon 目录改为 `resolveOhbabyHome()`~~：2026-11-19 移到前置议题[daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/improve-1/02-optimization-plan-and-change-scope.md)的 Stage 3，本议题不再实施。本议题实施前，那边应已完成。

**完成定义**：04 的 U1–U3 通过。

### Stage 2：安装脚本与启动脚本

**目标**：`curl -fsSL <地址>/install.sh | sh` 和 `irm <地址>/install.ps1 | iex` 能在没有 Node 的机器上装好 ohbaby，重复运行就是升级。

**改动**：新增 `packages/ohbaby-cli/install.sh`（POSIX sh）和 `packages/ohbaby-cli/install.ps1`（兼容 Windows PowerShell 5.1），加进 `packages/ohbaby-cli/package.json` 的 `files`。

两份脚本按同一流程实现：

```
 1. 读参数：OHBABY_INSTALL_VERSION、OHBABY_NON_INTERACTIVE、OHBABY_NO_MODIFY_PATH、
    OHBABY_HOME（默认 ~/.ohbaby，只用来找 daemon 状态和做卸载检查）、
    OHBABY_INSTALL_DIR（默认 ~/.ohbaby/install）、OHBABY_NODE_MIRROR（默认 nodejs.org/dist）
    交互判断：Unix 能打开 /dev/tty 才算交互；Windows 看 [Environment]::UserInteractive 且未设非交互
 2. 平台检查：只支持 6 个平台（00 的 5.6 节）；musl、32 位、其他架构直接停止并提示用 npm；
    Apple 芯片上的 Rosetta 终端改装 arm64
 3. 找现有的 ohbaby（00 的 5.3 节）：读 <OHBABY_HOME>/server/daemon-state.json，daemon 活着就中止安装，
    提示先运行 ohbaby serve stop（不管它是 npm 版还是脚本版启动的）；再记下 PATH 上有没有 npm 版，供第 12 步使用。
    "活着"的判断：status 是 running 或 stopping，并且 pid 对应的进程存在（Unix 用 kill -0，Windows 用 Get-Process -Id）。
    这一步还没有 Node，sh 用 sed 从这一行 JSON 里取 status 和 pid；文件不存在或取不出来就当作没有 daemon。
    这只是安装前的粗略检查：daemon 崩溃后 pid 恰好被别的进程复用时会误拦，而 ohbaby serve stop 核对不上
    pid 锁会拒绝处理。所以提示里同时写上：确认没有 daemon 在运行的话，删除这个 daemon-state.json 再重试。
    文件格式以前置议题 daemon 停止残留与诊断日志为准（那边确认格式不变）
 4. 加锁：mkdir <安装目录>/install.lock，写入 pid；目录已存在且 pid 已不在 → 视为过期锁，删除后重试；
    pid 还在 → 停止并提示"另一个安装正在进行"
 5. 准备 Node：runtime/node-v<NODE_VERSION> 不存在时，下载安装包和 SHASUMS256.txt，
    做 SHA-256 校验，解压到 runtime/.node-v<版本>.partial，跑 node --version，再改名。
    安装包格式：Unix 上有 xz 就用 .tar.xz，否则用 .tar.gz；Windows 用 .zip，
    优先用系统自带的 tar.exe 解压，找不到再用 Expand-Archive（实测 1 秒对 33 秒）
 6. 确定目标版本：用私有 npm 执行 npm view ohbaby-cli@<OHBABY_INSTALL_VERSION 或 latest> version
    （registry 跟随 ~/.npmrc）。查不到指定版本时停止并提示：当前 registry 上没有这个版本，
    用了镜像的话可能还没同步，稍后再试。ohbaby update 查版本用的是 npm_config_registry 或 npmjs.org，
    和这里可能不是同一个源，不另做对齐（CLI 升级议题 02 的 2.2 节"版本来源"）
 7. 装 release：删除残留的 releases/<版本>.partial；
    npm install --prefix releases/<版本>.partial --ignore-scripts --omit=dev --no-audit --no-fund ohbaby-cli@<版本>；
    写 node-version；试跑 <私有 node> …/dist/bin.js --version，输出必须等于目标版本；
    改名为 releases/<版本>。releases/<版本> 已存在且试跑通过时跳过安装（只认不带后缀的目录名）
 8. 写启动脚本：不存在、第二行的格式版本号不同，或（仅 Unix）脚本里写的安装目录和本次不同 → 写入
    （先写临时文件再改名）。Windows 的启动脚本放在安装目录里，内容不含安装目录，每台机器都一样
 9. 切换：先写 current.tmp 再改名为 current（文本不带 BOM）
10. 写 PATH：除非 OHBABY_NO_MODIFY_PATH=1（规则见 00 的 5.7 节）。Windows 直接读写注册表
    HKCU\Environment 的 Path：读取时用 DoNotExpandEnvironmentNames，写回时用 ExpandString，
    写完广播 WM_SETTINGCHANGE（做法同 Step-Code 的 install.ps1:435-500）
11. 清理：只有本次真的切换了版本才清理。保留新的 current 和切换前的 current，其余版本目录先改名为
    releases/.trash-<版本>-<pid>，再删除。改名是为了不留下删了一半、却仍叫 releases/<版本> 的目录；
    它不能判断目录还在不在用（探针 P5：Windows 上正在运行的版本目录也能改名），
    运行中的旧进程靠多保留的那个版本做缓冲。删除失败的 .trash-* 留着，每次清理时再删一遍；
    删除这两个版本都不用的 runtime/node-v*，同样先改名再删
12. 3 里发现 npm 版时：交互模式询问是否卸载，同意就用 npm 前缀下的 npm 执行
    npm uninstall -g --prefix <前缀> ohbaby-cli；卸载后（仅 Unix）再检查一次启动脚本，
    不存在或第二行不是 ohbaby-launcher 就重写（npm 前缀是 ~/.local 时两者是同一个路径）。
    拒绝或非交互时，说明 PATH 上会先用到哪一个
13. 释放锁，打印结果：版本、位置、需要重开终端或 source 哪个文件
```

任何一步失败：释放锁，`current` 保持不变，旧版本照常可用；残留的 `.partial` 留给下次运行时清理。

写法要求：

- install.sh 的主体全部写在函数里，文件最后一行才调用。`curl | sh` 下载到一半断开时，sh 不会执行半截脚本。
- 第 6 步得到的版本号写入 `current` 和用作目录名之前，检查它只含数字、字母、`.` 和 `-`。
- 两份脚本和它们生成的启动脚本只含 ASCII 字符，提示文字用英文。Windows PowerShell 5.1 按系统代码页读取不带 BOM 的 `.ps1`，有中文就会乱码（00 的 5.11 节）。
- install.ps1 开头在 `[Net.ServicePointManager]::SecurityProtocol` 现有值上加上 TLS 1.2。下载用 `Invoke-WebRequest` 的默认代理行为（跟随系统代理）；失败时打印出错的地址，并提示检查代理或设置 `OHBABY_NODE_MIRROR`。

**启动脚本的内容**（格式版本 1，00 的 5.10 节）。安装时把安装目录的绝对路径写进去，之后不再改动。

macOS、Linux（`~/.local/bin/ohbaby`）：

```sh
#!/bin/sh
# ohbaby-launcher 1
OHBABY_INSTALL_DIR='/home/me/.ohbaby/install'
export OHBABY_INSTALL_DIR
v=$(cat "$OHBABY_INSTALL_DIR/current") || exit 1
r="$OHBABY_INSTALL_DIR/releases/$v"
n=$(cat "$r/node-version") || exit 1
d="$OHBABY_INSTALL_DIR/runtime/node-v$n"
PATH="$PATH:$d/bin"
export PATH
exec "$d/bin/node" "$r/node_modules/ohbaby-cli/dist/bin.js" "$@"
```

Windows（`<安装目录>\bin\ohbaby.cmd`）：

```bat
@echo off
rem ohbaby-launcher 1
setlocal
for %%I in ("%~dp0..") do set "OHBABY_INSTALL_DIR=%%~fI"
set /p V=<"%OHBABY_INSTALL_DIR%\current"
set "R=%OHBABY_INSTALL_DIR%\releases\%V%"
set /p N=<"%R%\node-version"
set "D=%OHBABY_INSTALL_DIR%\runtime\node-v%N%"
set "PATH=%PATH%;%D%"
"%D%\node.exe" "%R%\node_modules\ohbaby-cli\dist\bin.js" %* & call exit /b %%errorlevel%%
```

Windows 这份按探针 P1、P2 的结果写成（00 的 5.11 节），有三处不能改：

- 安装目录用 `%~dp0..` 推出，文件里不写路径。写死的中文路径在 936 代码页下会被读错。
- 最后一行把 node 和退出写在同一行。cmd 解析完整行才执行，node 退出后不再读文件，所以运行中被改写也安全。`call` 让 `%%errorlevel%%` 在 node 退出后才展开，退出码才对。
- 不用括号块包住最后两行：参数里有 `)` 时会解析失败。

实施时以这两份为基准，可以补充错误提示，但不要加入版本判断、下载、清理等逻辑。路径中有空格和中文用户名的情况由 04 的 S9 覆盖。

**完成定义**：04 的 U8 通过，S1–S9 在 CI 三个系统上通过；真机验收项 R1–R6、R8、L1–L5、W1–W4、W6、W7 通过。实施前探针 P1–P10 已于 2026-11-18 完成，结论已并入本文（00 的 5.11 节），实施时以本文为准。

### Stage 3：`ohbaby uninstall`

**目标**：一条命令卸掉 npm 安装或脚本安装，配置、会话和数据库保留。

**改动**：

- 新增 `packages/ohbaby-cli/src/cli/commands/uninstall.ts`，在 `bin.ts:712-726` 的 yargs 链上注册。参数只有 `-y`（跳过确认）。
- 流程按 00 的 5.4 节：判断安装方式 → 列出要删除的内容并确认 → 升级前检查（复用 CLI 升级议题的模块）→ 按安装方式分支 → 告诉用户数据在哪里。
- npm 安装：用前缀下自带的 npm（Unix 为 `<前缀>/bin/npm`，Windows 为 `<前缀>\npm.cmd`），找不到再用 PATH 上的，执行 `npm uninstall -g --prefix <前缀> ohbaby-cli`。
- 脚本安装：
  - 先做安全检查：安装目录里同时有 `current` 和 `releases/`，并且安装目录不等于 `OHBABY_HOME`、不等于用户主目录，否则拒绝删除（00 的 5.9 节）。
  - 去掉 PATH 设置：删除 00 的 5.7 节列出的配置文件中的标记块，删除 fish 的 `conf.d/ohbaby.fish`；Windows 按 Stage 2 第 10 步的注册表写法，从用户 PATH 去掉 `<安装目录>\bin`（可以调用 `powershell -NoProfile` 执行同一段代码），不要用 `SetEnvironmentVariable`。
  - macOS、Linux：确认 `~/.local/bin/ohbaby` 第二行是 `# ohbaby-launcher`，是才删除；再删除整个安装目录。
  - Windows：不删任何安装文件，最后打印两行命令，PowerShell 用 `Remove-Item -Recurse -Force "<安装目录>"`，cmd 用 `rmdir /s /q "<安装目录>"`。
- 其他安装方式：只打印该用什么命令卸载。
- "要删除哪些东西"写成纯函数（输入安装方式、平台、环境变量，输出动作列表），执行和展示共用它，便于单元测试。

**完成定义**：04 的 U5–U7、S10、S11 通过；真机验收项 R7、W5 通过。

### Stage 4：文档与发版清单

**改动**：

- `README.md`、`README.zh.md`、`packages/ohbaby-cli/README.md` 的安装部分：先写脚本安装两条命令，再写 npm 安装；补充 `ohbaby update`、`ohbaby uninstall`；列出支持的平台，以及 musl 系统改用 npm 的提示。
- `packages/ohbaby-agent/README.md`、`packages/ohbaby-sdk/README.md` 只保留 npm 命令并链接到根 README，不重复写脚本安装。
- 发版检查清单（写在下一版的 `docs/releases/v<版本>.md` 里，并沉淀到发版流程说明）：
  - 把 `NODE_VERSION` 升到 24.x 最新补丁。
  - 确认 `npm pack` 的结果包含 `install.sh` 和 `install.ps1`。
  - 发布后用 `ohbaby-cli@<新版本>/install.sh` 的 jsDelivr 地址实际装一次。

**完成定义**：04 的 A6 通过。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-cli/` | `install.sh`、`install.ps1` | `package.json` 的 `files` | — | 脚本随 npm 包发布 |
| `packages/ohbaby-cli/src/install/` | `install-method.ts`、`text-file.ts`、uninstall 的动作计划 | — | — | 新目录，只放与安装方式相关的代码 |
| `packages/ohbaby-cli/src/cli/commands/` | `uninstall.ts` | — | — | |
| `packages/ohbaby-cli/src/` | — | `bin.ts`（注册命令）；~~`serve-awareness.ts`（daemon 路径）~~ 移到前置议题[daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/README.md) | — | |
| `tests/integration/cli/` | 安装脚本集成测试 | 把打包冒烟测试里的打包和本地 registry 抽成共用辅助函数 | — | |
| `.github/workflows/ci.yml` | 安装脚本测试步骤 | — | — | 三个系统都跑 |
| 根目录和各包 README | — | 安装说明 | — | Stage 4 |

`ohbaby-agent`、`ohbaby-server`、`ohbaby-sdk`、`ohbaby-llm` 的运行逻辑不改。

## 2.5 接口、协议与兼容

**跨语言契约**（sh、ps1、cmd、TypeScript 四方共用，变更视同不兼容改动）：

| 契约 | 格式 | 谁写 | 谁读 |
|---|---|---|---|
| `current` | 一行版本号，UTF-8 无 BOM，可有结尾换行 | 安装脚本 | 启动脚本、安装脚本、uninstall |
| `releases/<版本>/node-version` | 一行 Node 版本号，格式同上 | 安装脚本 | 启动脚本、安装脚本清理步骤 |
| `OHBABY_INSTALL_DIR` | 安装目录的绝对路径（Windows 启动脚本从自身位置推出，Unix 启动脚本里写死） | 启动脚本（运行时）、用户（安装时） | 程序、安装脚本 |
| 启动脚本第二行 | `# ohbaby-launcher <整数>`，`.cmd` 为 `rem ohbaby-launcher <整数>` | 安装脚本 | 安装脚本、uninstall |
| PATH 标记块 | `# >>> ohbaby installer >>>` 到 `# <<< ohbaby installer <<<` | 安装脚本 | uninstall |
| `install.lock/pid` | 一行进程号 | 安装脚本 | 安装脚本 |

**环境变量**：安装脚本读的环境变量见 00 的 5.7 节，本轮只有这五个，不新增。CLI 升级议题另有一个 `OHBABY_NO_UPDATE_CHECK`，与安装脚本无关。

**兼容**：

- 现有 npm 用户不受影响：不运行安装脚本，就什么都不变。
- 两种安装共用 `~/.ohbaby` 和同一个数据库，切换时不需要迁移数据（00 的 5.3 节）。
- 首次安装的命令用不带版本号的 jsDelivr 地址，可能拿到缓存了几个小时的旧 install.sh。所以 install.sh 和 install.ps1 必须向后兼容：旧脚本也能正确安装新版本，新脚本也能接管旧脚本装出来的目录。
- 启动脚本格式以后真要变：新安装脚本写入格式版本 2，两个平台都直接替换（Windows 的格式 1 运行中被改写也安全，探针 P2）。只有确实无法兼容时才这样做。

## 2.6 风险与回滚

| 风险 | 触发场景 | 应对 |
|---|---|---|
| 装坏的版本被启用 | 网络中断、npm 部分失败、包本身有问题 | 先装到 `.partial`，试跑 `--version` 通过才改名并切换 `current` |
| 新版本有 bug | 发布后才发现 | 用户手动把 `current` 改回上一个版本号即可回滚（上一个版本始终保留）；或 `OHBABY_INSTALL_VERSION=<旧版本>` 重新运行安装脚本 |
| 两个安装同时运行 | 两个终端同时 update | `install.lock` 目录锁 |
| sh 和 ps1 行为不一致 | 只改了其中一份 | 04 的 S 系列在三个系统上跑同一组场景；评审时两份脚本必须一起改 |
| 卸载删错目录 | `OHBABY_INSTALL_DIR` 被设成 `~/.ohbaby` 或主目录 | Stage 3 的安全检查 |
| BOM 导致路径错 | Windows PowerShell 5.1 写文件 | ps1 用无 BOM 写法；TypeScript 读取时去掉 BOM；`.cmd` 读不了 BOM（探针 P3），所以写入端必须无 BOM；W4 真机验证 |
| PowerShell 里参数被改 | 在 PowerShell 里运行 `ohbaby`，参数不带空格却含 `&` 等符号，或含 `%变量%`、双引号 | 带空格的参数不受影响；README 写明限制和加引号的写法；不加装 `.ps1`（00 的 5.11 节，2026-11-19 确认） |
| 系统代理不通 | Windows 开着系统代理但代理连不上 nodejs.org | ps1 跟随系统代理，失败时打印地址并提示检查代理或设置 `OHBABY_NODE_MIRROR` |
| 清理删到正在运行的旧版本 | 某个窗口一直开着，期间升级了两次以上 | 保留两个版本做缓冲；删不干净的 `.trash-*` 下次再删（第 11 步）。连续两次升级都没重开的窗口，之后按需加载模块时可能出错，本轮接受 |
| jsDelivr 访问不了 | 网络限制 | 改用 npm 安装（00 的 5.5 节）；不另做备用地址 |
| 私有 Node 有安全漏洞 | Node 发布安全补丁 | 发版清单升级 `NODE_VERSION`，用户 update 后自动换上新 Node |

整体回滚：这套功能是新增的。出现严重问题时，在 README 里撤下脚本安装命令即可，npm 安装路径不受影响。

## 2.7 与 00 的对齐检查

| 00 中的决定 | 本文位置 |
|---|---|
| 3 方案选择 | 2.1、2.2 |
| 4 边界 | 2.8 |
| 5.1 目录布局、Windows 文件占用 | 2.1、Stage 2 第 7–11 步 |
| 5.2 update 按安装方式分支 | Stage 1；update 本身在 CLI 升级议题 |
| 5.3 从 npm 切换 | Stage 2 第 3、12 步 |
| 5.4 uninstall | Stage 3 |
| 5.5 脚本托管、下载来源与校验 | Stage 2 第 5、6 步；Stage 4 |
| 5.6 Node 版本与平台 | Stage 2 第 2、5 步 |
| 5.7 参数与 PATH | Stage 2 第 1、10 步；2.5 |
| 5.8 依赖锁定不做 | 2.8 |
| 5.9 审查补充的决定 | Stage 1、Stage 2 第 4、7、11 步；Stage 3 安全检查 |
| 5.10 启动脚本 | Stage 2 启动脚本内容；2.5 |
| 5.11 探针结果 | Stage 2 第 5、8、10、11、12 步，写法要求，Windows 启动脚本；Stage 3 的 PATH 删除；2.5；2.6 |
| 第 6 节真机验证 | 04 的 4.5 节（R、L、W 系列） |

## 2.8 不在本轮

- Homebrew、winget、scoop 等包管理器分发。
- 单文件可执行文件（Node SEA），等 App 适配议题。
- 依赖版本锁定（安装器专用锁文件 + `npm ci`），方向见 00 的 5.8 节。
- 卸载时删除数据（`--purge`）。
- 安装脚本签名。
- CI 里写 `$GITHUB_PATH`。
- 记住安装时的镜像设置。

以上都不构成新一轮的触发事件，以后需要时另开议题或轮次。

## 2.9 关键改动清单

> 行号是 `bc0d4cc1` 时的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码（新增） | `packages/ohbaby-cli/install.sh`、`install.ps1` | 整个文件 | — | Stage 2 的 13 步流程 | 全部安装逻辑都在这里 |
| C2 | 代码（新增） | `packages/ohbaby-cli/src/install/install-method.ts` | `detectInstallMethod` | — | 三种安装方式的识别 | update 和 uninstall 共用 |
| C3 | 代码（新增） | `packages/ohbaby-cli/src/cli/commands/uninstall.ts` | `createUninstallCommand` | — | Stage 3 | 唯一会删除用户文件的代码 |
| C4 | 代码 | `packages/ohbaby-cli/src/bin.ts` | `runOhbabyCli` 的 yargs 链 | L712–726 | 注册 uninstall | 命令入口 |
| C5 | 代码 | `packages/ohbaby-cli/src/serve-awareness.ts` | `readServeCoexistenceNotice` | L75–79 | 2026-11-19 移到前置议题 [daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/improve-1/02-optimization-plan-and-change-scope.md)（那边的 C7），本议题不再实施 | update 和 uninstall 检查 daemon 依赖它读对文件 |
| C6 | 配置 | `packages/ohbaby-cli/package.json` | `files` | L23–38 | 加入 `install.sh`、`install.ps1` | 不加就不会发布到 npm，jsDelivr 地址失效 |
| C7 | 测试 | `tests/integration/cli/packaging-smoke.integration.test.ts` | `runPackedCliSmoke` 及本地 registry | L654 起 | 抽出打包和 registry 辅助函数，供安装脚本测试复用 | 安装脚本测试的基础 |
| D1 | 文档 | `README.md`、`README.zh.md`、`packages/ohbaby-cli/README.md` | Install 一节 | 约 L35–41 | 加入脚本安装、update、uninstall、平台说明 | 用户看到的唯一安装说明 |

### 连带影响面（不逐行列出）

- `.github/workflows/ci.yml`：三个系统上增加安装脚本测试。
- `packages/ohbaby-agent/README.md`、`packages/ohbaby-sdk/README.md`：安装命令链接到根 README。
- `docs/releases/`：下一版发布说明写两种安装命令和发版检查项。
- `docs/cli/architecture.md`：命令列表补上 `uninstall`（与 CLI 升级议题的 D2 一起改）。
