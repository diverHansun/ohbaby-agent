# 讨论记录与已确认要点

> 2026-11-17 开始与用户逐项讨论，每确认一项就更新本文。推理过程见 01，实施方案见 02。
>
> 术语：本文的"脚本安装"指用 curl 或 PowerShell 脚本安装，Node 和 ohbaby 都装在 `~/.ohbaby/install/` 下、由 ohbaby 自己管理；"npm 安装"指 `npm install -g ohbaby-cli`。讨论中曾叫"托管安装"，2026-11-17 统一改名。

## 1. 背景与动机

现在安装 ohbaby 只有一种方式：`npm install -g ohbaby-cli`，前提是用户已经装好 Node.js 24 或更高版本。很多同类工具（codex、opencode、claude-code、kimi-code、pi）都提供一条 curl 或 PowerShell 命令，用户不用先装 Node 就能用。

这件事原本记在 CLI 升级议题的边界里，打算等 App 适配做出独立可执行文件（Node SEA）以后再做。2026-11-17 用户决定提前做，并拆成独立议题。

## 2. 现状要点

以下事实决定了安装方案怎么选：

| 项 | 现状 |
|---|---|
| npm 包 | 发布 5 个包：`ohbaby-cli`、`ohbaby-agent`、`ohbaby-server`、`ohbaby-sdk`、`ohbaby-llm`。cli 依赖其余 4 个，Web 静态资源打在 cli 包的 `dist/web` 里 |
| 原生依赖 | koffi、`@vscode/ripgrep`、`@lydell/node-pty` 都按平台拆成可选依赖（如 `@koromix/koffi-darwin-arm64`），npm 安装时自动挑选当前平台的那个；tree-sitter 用 wasm；SQLite 用 Node 内置的 `node:sqlite`。（2026-11-17 核实时更正：起初误记为 koffi 自带所有平台的预编译文件） |
| Node 版本 | 要求 Node.js 24 或更高 |
| 发布基础设施 | 没有自己的 CDN，CI 里没有发布流程，版本靠手动发到 npm |

## 3. 已确认：方案选择

| 决策项 | 结论 |
|---|---|
| 议题拆分 | curl 和 Windows 安装单独成一个议题，不跟 `ohbaby update` 放在一起（2026-11-17） |
| 安装产物 | 选"脚本安装"（参考 pi、minimax-code）：脚本先下载一份私有的官方 Node，再用它自带的 npm 把 `ohbaby-cli` 装进 ohbaby 自己的目录（2026-11-17） |
| 不选单文件可执行文件 | bun compile 或 Node SEA 每次发版都要给每个平台单独构建、上传；koffi、node-pty 的 `.node` 文件、ripgrep 和 Web 资源得在运行时解压出来，CI 也要从头搭。留到 App 适配做出 SEA 以后再评估 |
| 不选"只发 JS 包、用系统 Node" | 参考 ZCode。用户还是得先装 Node，跟直接用 npm 安装比没有多少好处 |

脚本安装的好处：

- 现有的 npm 包原样复用，每个平台的原生依赖照旧由 npm 挑选，发版时不用额外为各平台构建任何东西。
- 安装脚本（`install.sh` 和 `install.ps1`）放进 `ohbaby-cli` 的 npm 包，跟版本一起发布，不需要额外的发布步骤（见 5.5 节）。
- Node 有官方的 `SHASUMS256.txt` 可以校验，npm 自己会校验包的完整性，不用另外做一套校验文件。
- 以后换成 SEA，只要改脚本里"下载什么"那一步，安装目录布局和 `ohbaby update` 的入口都不用变。

## 4. 已确认：边界（2026-11-17）

| 项 | 处理 |
|---|---|
| Homebrew、winget、scoop 等包管理器 | 本轮不做 |
| 单文件可执行文件 | 本轮不做，等 App 适配 |
| App 的安装和更新 | 放到 App 适配议题 |
| 从脚本安装切回 npm 安装 | 不专门处理。需要时先用 `ohbaby uninstall` 卸掉脚本安装 |
| 卸载时一并删除数据 | 本轮不做，不提供 `--purge` 一类参数 |
| npm 版 update 后建议迁到脚本安装 | 不做（pi 有这个提示），不引导用户换安装方式 |
| 依赖版本锁定 | 本轮不做，记为已知风险，见 5.8 |

## 5. 逐项讨论中确认的决定

### 5.1 安装目录布局与 Windows 文件占用（2026-11-17 确认）

```
~/.ohbaby/install/                 所有平台统一，可用 OHBABY_INSTALL_DIR 改
  runtime/node-v<版本>/             私有 Node，按 Node 版本分目录，各 ohbaby 版本共用
  releases/<ohbaby 版本>/           每个版本一个目录，用 npm --prefix 安装
  current                          一行文本，写当前使用的 ohbaby 版本
  bin/ohbaby.cmd                   仅 Windows：启动脚本
启动脚本
  macOS、Linux：~/.local/bin/ohbaby
  Windows：~/.ohbaby/install/bin/ohbaby.cmd，加进用户 PATH
```

| 决策项 | 结论 | 理由 |
|---|---|---|
| 安装目录 | `~/.ohbaby/install`，不跟随 `OHBABY_HOME` | 用户找 ohbaby 的东西都在 `~/.ohbaby` 下；sh 和 ps1 脚本里路径最好写。`OHBABY_HOME` 是配置目录的覆盖开关，测试时常被改掉，程序位置不应该跟着变 |
| 版本切换 | 每个版本装进独立目录，最后改写 `current` 完成切换（先写临时文件再重命名） | Windows 不允许覆盖正在运行的 `node.exe` 和已加载的 `.node` 文件。新版本不碰旧文件，正在运行的旧进程不受影响 |
| 启动脚本 | 装好后不再改动，每次运行时读 `current`。Unix 启动脚本用 `exec` 启动 node | cmd 边执行边读 `.cmd` 文件。如果 `ohbaby update` 改写了正在执行的 `ohbaby.cmd`，node 退出后 cmd 会读到错位的内容并报错。Unix 上用 `exec` 后 shell 进程被 node 取代，不会再回头读启动脚本。2026-11-18 的探针证实了这个问题，Windows 改用"最后一行同时启动 node 和退出"的写法后，运行中改写也安全（见 5.11） |
| Node 运行时 | 按 Node 版本分目录，各 ohbaby 版本共用；每个 release 记录自己用哪个 Node | Node 不常升级，不必每个版本带一份（约 100 MB）。升级 Node 同样新建目录，不覆盖 |
| 旧版本清理 | 保留当前版本和上一个版本，更早的删除。Windows 上删除失败就跳过，下次再删 | macOS 和 Linux 能删掉正在运行的文件，但旧进程之后按需加载模块会失败，多留一个版本做缓冲。2026-11-18 的探针表明 Windows 也差不多：正在运行的版本目录能改名，只加载了 JS 时还能整个删掉，所以 Windows 同样靠多留的这个版本做缓冲（见 5.11） |
| 不用 junction 或符号链接做指针 | 用文本文件 | 两个平台同一套机制，Windows 上不用处理 junction |

参考项目里，codex 和 pi 也用"版本目录 + 当前指针"，codex 的指针是符号链接或 junction。claude-code 和 Step-Code 把正在运行的 exe 改名成 `.old` 再放新文件，只适合单文件可执行文件，不适合一整棵 `node_modules`。

#### 调查结果（2026-11-17，代码核查与本机实测）

| 问题 | 结论 | 依据 |
|---|---|---|
| 会不会有代码扫到 `~/.ohbaby/install` | 不会。所有用到 `resolveOhbabyHome()` 的地方都是拼一个固定子路径（`skills/`、`logs/<角色>`、`sessions/<id>` 等），没有代码递归遍历、复制、删除或监听整个 `~/.ohbaby` | `migration/ohbaby-home.ts` 只递归读旧目录 `~/.ohbaby-agent`，复制和删除只发生在数据目录；日志清理只删 `logs/<角色>` 下匹配文件名的文件 |
| agent 能不能改到安装目录 | 安装目录在工作区之外，agent 要动它得先经过"访问外部目录"的权限确认。沙箱没有专门保护 `~/.ohbaby` | `sandbox/denylist.ts` 只拦 `.aws`、`.gnupg`、`.ssh` 等；`core/tool-scheduler/scheduler.ts` 的 `external_directory` 确认 |
| daemon 怎么启动 | `ohbaby serve` 在自己的进程里跑 daemon，没有自动拉起 daemon，也没有任何"用自己再启动一个自己"的代码。所以 daemon 一直用启动它的那个版本的文件 | `cli/commands/serve.ts:181`；全仓库没有用到 `process.execPath` |
| 启动脚本的调用方式行不行 | 行。`<私有 node> <release>/node_modules/ohbaby-cli/dist/bin.js` 能通过 `bin.ts` 里"是否被直接调用"的判断 | `bin.ts:46-62`、`bin.ts:754` |
| CLI 能不能知道自己装在哪 | 现在没有任何判断安装位置的代码，要新写。版本号本来就是用 `import.meta.url` 找 `package.json` 读的，用同一个起点判断自己是否位于 `releases/<版本>/node_modules/ohbaby-cli/` 下面即可 | `ohbaby-cli/src/package-version.ts:3` |
| 原生依赖在 `--prefix` 布局下能不能用 | 能。ripgrep、node-pty、koffi 都走 Node 的模块解析，tree-sitter 的 wasm 按 `import.meta.url` 找，跟装在哪里无关 | 本机实测 `npm install --prefix` 后 `ohbaby --version` 正常，`require("koffi")` 正常 |
| koffi 的安装脚本 | koffi 3.1.1 带一个 `install` 脚本，但不跑它也能加载，因为预编译文件由平台可选依赖 `@koromix/koffi-<平台>` 提供。新版 npm（11.19）默认就跳过了这个脚本 | 本机实测 |
| 子进程的 PATH | ohbaby 不改 PATH。bash 工具、终端面板、MCP 服务都继承启动时的环境。私有 Node 不在 PATH 上时，agent 执行 `node` 或用户配置的 `npx` 类 MCP 服务会找系统 Node，系统没装就失败 | `tools/bash.ts:77-101`、`terminal/shell-launch.ts:14-25`、`mcp/core/transport.ts:16-25` |
| 占用空间 | 一个 release 目录约 195 MB（217 个包），私有 Node 约 100 MB。保留两个版本时总共约 0.5 GB | 本机实测 |
| 现在有没有提示用户 `npm install -g` 的运行时文案 | 没有。只有文档里写了（README、各包 README、发版说明），这些在 02 里列入改动清单 | 代码检索 |

#### 本项衍生的两个小决定（2026-11-17 确认）

| 决策项 | 结论 | 理由 |
|---|---|---|
| 私有 Node 要不要放进 PATH | 启动脚本把私有 Node 的目录**追加到 PATH 末尾**，只对 ohbaby 及其子进程生效，不改用户的 shell 配置 | 放在末尾时，用户装了系统 Node 就优先用系统的；没装的话，`npx` 类 MCP 服务和 agent 执行的 `node` 命令也能跑。只改启动脚本，TypeScript 代码不用动 |
| npm 安装参数 | `npm install --prefix <release> --ignore-scripts --omit=dev ohbaby-cli@<版本>`，不能加 `--omit=optional` | 实测不跑安装脚本也能用，还能避免执行第三方脚本，也不用操心安装脚本找不到 `node`。ripgrep 和 node-pty 的各平台包都是可选依赖，省掉可选依赖会让搜索和终端失效 |

`OHBABY_HOME` 的现状：它是一个环境变量，用来改 ohbaby 的配置根目录，默认是 `~/.ohbaby`。目录里放模型配置 `model.json`、`tools/`、`skills/`、`mcp/`、`.env`、`sessions/`、默认工作区 `workspace/default`、daemon 的 `server/daemon.pid` 和状态文件、`logs/`、`backups/`。数据库不在这里，在平台数据目录（macOS 是 `~/Library/Application Support/ohbaby/ohbaby.db`），可以用 `OHBABY_DB_PATH` 单独改。README 没有介绍 `OHBABY_HOME`，目前主要用在测试和验收里隔离配置。

### 5.2 `ohbaby update` 按安装方式升级（2026-11-17 确认）

`ohbaby update` 本身在 [CLI 升级](../../2026-11-16-cli-upgrade/README.md) 议题里实现。它先按自己的 `package.json` 所在位置判断安装方式，再分支：

| 识别结果 | 判断方法 | `update` 的动作 |
|---|---|---|
| 脚本安装 | 启动脚本设置了 `OHBABY_INSTALL_DIR`，并且自己位于 `<安装目录>/releases/<版本>/node_modules/ohbaby-cli` 下（见 5.10） | 下载目标版本对应的 `install.sh` 或 `install.ps1`（地址见 5.5），用 `OHBABY_INSTALL_VERSION` 传目标版本、`OHBABY_NON_INTERACTIVE=1` 运行（见 5.7） |
| npm 全局安装 | 位于 `<前缀>/lib/node_modules/ohbaby-cli`（Windows 为 `<前缀>\node_modules\ohbaby-cli`）下，前缀从这个路径反推 | 执行 `npm install -g --prefix <前缀> ohbaby-cli@<版本>`，优先用前缀下自带的 npm，找不到再用 PATH 上的（见 5.9） |
| 其他（pnpm、bun、yarn、volta、源码仓库直接运行等） | 以上都不是 | 不替用户执行，只提示该用什么命令升级 |

理由：

- 脚本安装的安装逻辑（下载 Node、校验、npm 安装、切换 `current`、清理旧版本）只在 sh 和 ps1 两份脚本里各写一次，TypeScript 不再写第三份。codex、opencode、Step-Code 都是重新运行自己的安装脚本。脚本修了 bug，下次 update 直接生效。
- pnpm、bun 等全局目录结构各不相同，猜错会弄坏用户环境。opencode 和 pi 对 volta、mise 也只给提示。
- 查新版本（npm registry）、升级前检查运行中的任务、停 daemon、检查其他 ohbaby 进程，两种安装方式共用，已在 CLI 升级议题里确定。
- 脚本安装的 update 要联网下载脚本。脚本放在哪里，见 5.5。

### 5.3 从 npm 安装切换到脚本安装（2026-11-17 确认）

安装脚本的流程：

```
1. 找现有的 ohbaby
   Unix：command -v ohbaby；Windows：Get-Command ohbaby -All
     ├─ 没有，或者就是脚本安装自己的启动脚本 → 正常安装或升级
     └─ 是 npm 装的（链接或 shim 指向 .../node_modules/ohbaby-cli/）→ 继续往下
2. 检查 daemon：读 <OHBABY_HOME>/server/daemon-state.json（默认 ~/.ohbaby），看 pid 是否还活着
   活着 → 停止安装，提示先运行 ohbaby serve stop，再重新执行安装命令
3. 装好脚本安装的版本（Node、release、current、启动脚本、PATH）
4. 交互模式下询问是否卸载 npm 版
   同意 → npm uninstall -g --prefix <前缀> ohbaby-cli
   拒绝或非交互 → 不卸载，说明 PATH 上会先用到哪一个
```

| 决策项 | 结论 | 理由 |
|---|---|---|
| 数据迁移 | 不需要 | 两种安装共用 `~/.ohbaby` 和同一个数据库。新版本第一次启动时照常跑数据库迁移 |
| daemon 在跑 | 安装脚本只检查、不代停，提示用户运行 `ohbaby serve stop` | sh 和 ps1 看不到 daemon 上有没有运行中的任务，代停可能打断用户的任务。`ohbaby update` 调用脚本前已经停过 daemon，不会卡在这一步 |
| 卸载 npm 版时带 `--prefix` | 前缀从找到的 `ohbaby` 路径反推，例如 `/opt/homebrew` | nvm 或多套 Node 并存时，PATH 上的 `npm` 不一定是当初安装 ohbaby 的那个。opencode 同样带 `--prefix` |
| 顺序 | 先装新版本，再卸旧版本 | 新版本装失败时，旧版本还能用 |
| 交互输入 | `curl \| sh` 时从 `/dev/tty` 读用户回答，读不到就按非交互处理 | 这种方式下脚本的标准输入是脚本内容本身。codex 也这样做 |
| Windows 卸载失败 | 不重试，提示关闭所有 ohbaby 窗口后手动运行 `npm uninstall -g ohbaby-cli` | 文件被占用时卸载会失败 |
| 用户拒绝卸载 | 明确告诉用户 PATH 上谁先被用到 | 例如 `/opt/homebrew/bin` 排在 `~/.local/bin` 前面时，敲 `ohbaby` 仍然运行 npm 版 |

为什么建议卸掉 npm 版：两个 `ohbaby` 并存时，运行哪个取决于 PATH 顺序。`ohbaby update` 升级了一个，实际运行的可能是另一个；两边版本差距拉大后，旧的那个会被 CLI 升级议题定下的数据库版本保护拒绝启动。

### 5.4 `ohbaby uninstall`（2026-11-17 确认）

讨论中曾建议只在 README 写手动卸载步骤，用户提出做成 CLI 命令。对照 opencode 的 `uninstall`（`packages/cli/src/commands/handlers/uninstall.ts`）后确认做命令。

```
1. 判断安装方式（与 update 共用同一段代码）
2. 列出要删除的内容，询问"确定卸载吗？[y/N]"，默认否；-y 跳过确认
3. 检查运行中的任务、停 daemon、提示关闭其他 ohbaby 窗口（复用 update 的逻辑）
4. 按安装方式分支
   npm 安装：npm uninstall -g --prefix <前缀> ohbaby-cli
   脚本安装：去掉 PATH 设置
             macOS、Linux：删除 ~/.local/bin/ohbaby 和整个安装目录
             Windows：不删启动脚本（它在安装目录的 bin 下，正在被 cmd 执行），
                      最后打印两行命令（PowerShell 一行、cmd 一行），让用户在同一窗口执行其中一行
                      Remove-Item -Recurse -Force "$HOME\.ohbaby\install"
                      rmdir /s /q "%USERPROFILE%\.ohbaby\install"
   其他方式：只提示该用什么命令卸载
5. 告诉用户配置、会话、数据库在哪里，想彻底清除可以自己删
```

| 决策项 | 结论 | 理由 |
|---|---|---|
| Windows 上删不掉自己 | 先去掉 PATH 设置，安装目录（含启动脚本 `bin\ohbaby.cmd`）整体交给最后打印的命令删除 | 运行 `ohbaby uninstall` 的 `node.exe` 就在安装目录里，运行期间被占用，这是主要原因。启动脚本改成"最后一行同时退出"的写法后（5.11），提前删掉它不一定再报错，但没有实测，也没有必要冒险。命令退出后两者都释放。opencode 对 curl 安装只列出可执行文件路径，让用户手动删除（所有平台一样） |
| 不做退出后自动删除 | 不在后台另起进程延迟删除 | cmd 边执行边读 `ohbaby.cmd`，删除时机难把握，容易报"找不到批处理文件" |
| 数据 | 默认保留配置、会话和数据库，只告诉用户位置 | 误删会话代价太大。opencode 也只删缓存，不删数据和配置 |
| PATH 设置 | 在 5.7 列出的 shell 配置文件里删除 `# >>> ohbaby installer >>>` 到 `# <<< ohbaby installer <<<` 之间的内容，删除 fish 的 `~/.config/fish/conf.d/ohbaby.fish`；Windows 从用户 PATH 去掉 `~\.ohbaby\install\bin` | 与安装时的写入方式一一对应 |
| 归属 | 放在本议题，npm 那一支也写在这里；与 CLI 升级议题共用"判断安装方式"的代码 | "装"和"卸"放在一起讲。update 和 uninstall 对称，每种安装方式各有升级和卸载两个动作 |
| 待 Windows 实测 | npm 版执行 `ohbaby uninstall` 时，npm 会删掉正在执行的 `ohbaby.cmd`，结束时可能多打印一句"找不到批处理文件" | 不影响功能，写进 04 的验收项 |

### 5.5 脚本放在哪、下载来源与校验（2026-11-17 确认）

2026-11-17 用户补充：不必为国内网络做过多兼容。能稳定访问本仓库和 npm 的用户，一般用不到 npm 国内镜像。因此本节只保留一个通用的 Node 下载地址变量，不再为国内网络专门设计。

核实结果（2026-11-17 实际请求）：

| 检查项 | 结果 |
|---|---|
| GitHub Release | v0.1.16 到 v0.1.18 都发了 Release，没有附件 |
| jsDelivr、unpkg 取 npm 包内文件 | 可以，`cdn.jsdelivr.net/npm/ohbaby-cli@latest/package.json` 返回 200 |
| npmmirror 取 npm 包内文件 | 返回 403，包要先加入白名单 `cnpm/unpkg-white-list` |
| npmmirror 的 Node 镜像 | `registry.npmmirror.com/-/binary/node/` 可用；旧地址 `npmmirror.com/mirrors/node` 请求超时 |
| npmmirror 的 npm 包镜像 | `registry.npmmirror.com/ohbaby-cli/latest` 可用 |

| 决策项 | 结论 | 理由 |
|---|---|---|
| 脚本放在哪 | 放进 `ohbaby-cli` 的 npm 包，README 给出 jsDelivr 地址，例如 `https://cdn.jsdelivr.net/npm/ohbaby-cli/install.sh` | npm 是唯一的发布渠道，发 npm 时脚本自动带上，不会"发了版忘了传脚本"。没选 GitHub main 原始文件（未发版的改动会立刻生效）和 Release 附件（每次发版多传两个文件），两者在国内访问也不稳定 |
| CDN 缓存 | 首次安装用不带版本号的地址，缓存晚几个小时没关系 | 脚本装哪个版本，是自己去 npm registry 查 `latest` 决定的，与脚本是哪一版无关 |
| `ohbaby update` 取脚本 | 用带版本号的地址，例如 `ohbaby-cli@0.1.19/install.sh` | 内容不会变，没有缓存问题，脚本和目标版本严格对应 |
| Node 下载地址 | 默认 `nodejs.org/dist`，可用 `OHBABY_NODE_MIRROR` 改（例如公司内网镜像）。下载失败时，报错里提示这个变量 | 一个变量的成本很低，显式配置最可预期，不按 IP 或测速自动判断 |
| npm registry | 跟随用户 `~/.npmrc`，不另设变量 | npm 本来就读这个文件，用户原来怎么配 npm，脚本安装照样生效 |
| 取脚本的备用地址 | 不做。jsDelivr 取不到时，用户可以改用 npm 安装 | 用户确认不为国内网络做过多兼容。不提 npmmirror 白名单 PR |
| Node 校验 | 用同一来源的 `SHASUMS256.txt` 做 SHA-256 校验 | 能发现下载损坏或不完整，与 codex 同等强度 |
| npm 包校验 | 交给 npm，按 registry 给出的 integrity 校验 | npm 自带 |
| 脚本签名 | 不做 | 参考项目里只有 minimax-code 做了 ed25519 签名，项目没有签名基础设施 |

### 5.6 Node 版本与支持的平台（2026-11-17 确认）

核实结果（2026-11-17，nodejs.org 版本列表与各原生依赖的可选依赖清单）：

| Node 版本线 | 最新版本 | 状态 |
|---|---|---|
| 26 | 26.13.1 | Active LTS |
| 24 | 24.22.3 | LTS，2026 年 10 月进入维护期，安全修复到 2028 年 4 月 |
| 22 | 22.23.5 | 旧 LTS |

| 平台 | Node 官方包 | ripgrep | node-pty | koffi | 结论 |
|---|---|---|---|---|---|
| macOS arm64、x64 | 有 | 有 | 有 | 有 | 支持 |
| Linux x64、arm64（glibc） | 有 | 有 | 有 | 有 | 支持 |
| Windows x64、arm64 | 有 | 有 | 有 | 有 | 支持 |
| Linux musl（Alpine） | 仅 x64 | 有 | 没有 | 没有单独的 musl 包 | 不支持 |
| 32 位及其他架构 | 没有或不全 | 部分 | 没有 | 部分 | 不支持 |

| 决策项 | 结论 | 理由 |
|---|---|---|
| Node 版本 | 脚本里写死一个测过的版本，如 `NODE_VERSION=24.22.3`，不自动追最新 | 大家装到同一个 Node，方便排查；不会因为 Node 发补丁就让每次 update 多下载几十 MB。脚本跟 npm 包一起发版，升 Node 就是发版时改一行。发版检查清单加一条：把它升到 24.x 最新补丁 |
| 版本线 | 先用 24 | `engines` 是 `>=24`，开发和测试都在 24 上。换 26 要先让 CI 在 26 上跑通，另行决定 |
| musl 系统 | 脚本开头用 `ldd --version` 检测，是 musl 就停止，提示自装 Node 24 后用 npm 安装 | node-pty 没有 musl 包。opencode 也检测 musl |
| 不支持的架构 | 直接停止，给出同样的提示 | 只支持上表 6 个平台 |
| 兜底检查 | Node 解压后先运行 `node --version`，失败就停止并提示 | Node 官方 Linux 包要求 glibc 2.28 以上。用冒烟测试兜底，不逐个列举老系统 |
| Rosetta | Apple 芯片上 x64 模式的终端用 `sysctl -n sysctl.proc_translated` 识别，改装 arm64 版 | 此时 `uname -m` 报 x86_64。opencode 也这样处理 |
| 安装包格式 | macOS、Linux 用 `.tar.gz`；Windows 用 `.zip`，PowerShell 自带 `Expand-Archive` 解压 | 有些精简系统没有 xz |

### 5.7 脚本参数与 PATH 写入（2026-11-17 确认）

**参数一律用环境变量。** Windows 的 `irm ... | iex` 无法给脚本传命令行参数；Unix 能传，但要写成 `curl ... | sh -s -- --version 0.1.19`，很绕。环境变量两个平台写法一致。

| 环境变量 | 作用 | 说明 |
|---|---|---|
| `OHBABY_INSTALL_VERSION` | 安装指定版本，不设则装 `latest` | `ohbaby update` 用它传目标版本 |
| `OHBABY_NON_INTERACTIVE=1` | 不提任何问题，需要询问的一律按"不动"处理（例如不卸载 npm 版） | `ohbaby update` 调用时设置；读不到 `/dev/tty` 时自动进入此模式 |
| `OHBABY_NO_MODIFY_PATH=1` | 不改 shell 配置文件和用户 PATH | Step-Code、minimax-code、opencode 有类似开关 |
| `OHBABY_INSTALL_DIR` | 改安装目录 | 见 5.1。启动脚本运行时也会设置它，告诉程序装在哪（见 5.10） |
| `OHBABY_NODE_MIRROR` | 改 Node 的下载地址 | 见 5.5。npm registry 跟随 `~/.npmrc`，不设变量 |

已核对代码中现有的环境变量（`OHBABY_HOME`、`OHBABY_DB_PATH`、`OHBABY_TUI_*`、`OHBABY__` 前缀等），新增的名字不冲突。

**macOS、Linux 的 PATH 写入：**

```
~/.local/bin 已在 PATH 中 → 不改配置文件
否则按 $SHELL 写入：
  zsh  → ~/.zshrc（不存在就新建）
  bash → ~/.bashrc；macOS 上再写 ~/.bash_profile
  fish → 新建 ~/.config/fish/conf.d/ohbaby.fish
  其他 → 不改，打印手动设置的方法
```

写入内容用标记包起来：

```bash
# >>> ohbaby installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< ohbaby installer <<<
```

| 决策项 | 结论 | 理由 |
|---|---|---|
| macOS 的 bash 多写 `~/.bash_profile` | 是 | macOS 终端打开的是登录 shell，只读 `~/.bash_profile` |
| fish 单独建文件 | 是 | fish 语法与 bash 不同，`conf.d/` 下的文件自动加载；卸载时删掉这个文件即可 |
| 重复运行 | 写入前检查标记，已存在就不再写 | `ohbaby update` 每次都会重新运行脚本 |
| 装完提示 | 提示重新打开终端，或执行 `source` 对应的配置文件 | 当前终端不会自动读取新配置 |

**Windows 的 PATH 写入：**

| 决策项 | 结论 | 理由 |
|---|---|---|
| 位置 | 把 `~\.ohbaby\install\bin` 加到用户 PATH 最前面 | npm 版的 `%APPDATA%\npm` 也在用户 PATH 中，用户拒绝卸载 npm 版时，刚装的版本仍然优先。Unix 上如果 `~/.local/bin` 已在 PATH 里就不改配置，它可能排在 npm 目录后面，这种情况按 5.3 的冲突提示处理 |
| 写入方式 | 直接读写注册表 `HKCU\Environment` 的 `Path`：读取时不展开变量，写回时保持 `REG_EXPAND_SZ` 类型，写完广播 `WM_SETTINGCHANGE`。不用 `setx`，也不用 `[Environment]::SetEnvironmentVariable`（2026-11-18 按探针 P6 修改，见 5.11） | `setx` 会把超过 1024 个字符的 PATH 截断。`SetEnvironmentVariable` 读到的是展开后的值，写回时类型变成 `REG_SZ`，用户 PATH 里的 `%USERPROFILE%` 之类的写法会被写死 |
| 当前窗口 | 同时更新当前 PowerShell 的 `$env:Path` | 装完不用重开窗口 |
| 启动脚本格式 | `.cmd`，不用 `.ps1` | `.ps1` 受 PowerShell 执行策略限制，很多机器默认禁止；`.cmd` 在 PowerShell 和 cmd 中都能用。`irm \| iex` 在内存中执行，不受执行策略影响。在 PowerShell 里经 `.cmd` 传参有已知限制，见 5.11 |

本轮不做：在 CI 里写 `$GITHUB_PATH`（opencode 有）。CI 中安装 ohbaby 直接用 npm 更合适。

### 5.8 依赖版本锁定（2026-11-17 确认：本轮不做）

问题：`npm install ohbaby-cli@<版本>` 只固定 ohbaby 自己的 5 个包。它们的第三方依赖有 25 处写的是版本范围（如 `^1.29.0`），每次安装按范围取最新版本，同一个 ohbaby 版本在不同时间装出来的间接依赖可能不同。今天的 `npm install -g` 也是这样，不是脚本安装带来的新问题。

pi 先后试过两种做法：

| 做法 | 原理 | pi 的经历 |
|---|---|---|
| `npm-shrinkwrap.json` | 锁文件放进 npm 包，npm 安装和脚本安装都按它装 | 2026-05 加入，配有约 340 行的生成脚本；2026-10 删除（pi 提交 `581e7ba78`，issue #5653），原因是把 pi 当库依赖的使用者无法覆盖被锁死的依赖 |
| 安装器专用锁文件 | 只给脚本安装一份锁文件，脚本用 `npm ci` 安装；npm 安装不锁 | pi 现在的做法，锁文件放在 pi.dev 服务器上 |

| 决策项 | 结论 | 理由 |
|---|---|---|
| 本轮是否做 | 不做，记为已知风险 | 不是新问题，目前没有因间接依赖漂移出过故障；原生和核心依赖已经锁定精确版本（koffi 3.1.1、`@vscode/ripgrep` 1.18.0、`@lydell/node-pty` 1.2.0-beta.18、web-tree-sitter 0.25.10、react、ink）；项目用 pnpm，生成 npm 格式锁文件要在 5 个包发布后另做转换，发版流程成本高 |
| 以后要做时的方向 | 用安装器专用锁文件：锁文件与安装脚本放在 npm 包的同一目录、随版本发布，脚本改用 `npm ci` | 不需要自己的服务器；npm 安装不锁，避开 pi 遇到的库使用者无法覆盖依赖的问题 |

### 5.9 审查后补充的决定（2026-11-17 确认）

文档审查发现几处设计漏洞，用户确认按以下建议处理。

| 决策项 | 结论 | 理由 |
|---|---|---|
| npm 版 update 带 `--prefix` | 从 ohbaby-cli 自己的路径反推前缀，执行 `npm install -g --prefix <前缀> ohbaby-cli@<版本>`。优先用前缀下自带的 npm（Unix 为 `<前缀>/bin/npm`，Windows 为 `<前缀>\npm.cmd`），找不到再用 PATH 上的 | 与 5.3 卸载时带 `--prefix` 的理由相同：nvm 或多套 Node 并存时，PATH 上的 npm 不一定是当初安装 ohbaby 的那个。opencode 的 `updater.ts` 也这样做 |
| 自定义安装目录 | update 调用脚本时，把启动脚本设置的 `OHBABY_INSTALL_DIR` 原样传过去（见 5.10）；Unix 启动脚本在安装时写入安装目录的绝对路径；uninstall 的删除命令和 PATH 清理都按实际目录生成 | 不传的话，自定义目录的用户升级后会装到默认目录 |
| 卸载前的安全检查 | 只有目录里同时有 `current` 和 `releases/`，并且这个目录不是 `OHBABY_HOME` 时才删除，否则拒绝并提示手动处理 | 防止用户把安装目录设成 `~/.ohbaby` 时，卸载连配置和会话一起删掉 |
| 镜像设置不记住 | update 不保存、不读取安装时用过的 `OHBABY_NODE_MIRROR`，用户需要时自己再设 | 用户确认不为国内网络做过多兼容（见 5.5），不新增 `install.env` 之类的记录文件 |
| 并发与装到一半 | 用 `<安装目录>/install.lock` 目录当锁（mkdir 是原子操作），锁里记下 pid，pid 已经不在就当作过期锁处理。新版本先装到 `releases/<版本>.partial`，装完再改名；发现残留的 `.partial` 先删掉再装 | 两个安装或升级同时跑会互相覆盖；中途失败留下的残缺目录不能被当成可用版本 |
| 私有 Node 的记录与清理 | 每个 release 目录放一个 `node-version` 文件，启动脚本按 `current` → release → `node-version` 找到 Node。清理旧版本时，只保留当前版本和上一个版本要用的 Node | 原文没写"每个版本用哪个 Node"记在哪里，旧 Node 也一直不清理，每份约 100 MB |

### 5.10 启动脚本保持最小、稳定（2026-11-18 确认）

| 决策项 | 结论 | 理由 |
|---|---|---|
| 启动脚本的内容 | 只做四件事：设置 `OHBABY_INSTALL_DIR`、读 `current` 和 `node-version`、把私有 Node 追加到 PATH 末尾、启动 `bin.js`。以后要改的逻辑放进它读取的文件或 `bin.js` 里，不改启动脚本本身 | 启动脚本已经发到每个用户的机器上，改格式要兼顾所有旧版本。启动脚本越短，以后需要改它的可能越小。Windows 的 `.cmd` 运行中改写的问题已经用新写法解决（见 5.11），但这条原则不变 |
| 告诉程序装在哪 | 启动脚本把自己的安装目录写进环境变量 `OHBABY_INSTALL_DIR` 再启动程序。程序只有在这个变量存在、并且自己的 `package.json` 确实在 `<安装目录>/releases/` 下时，才认定是脚本安装 | 不用从路径猜安装目录。第二个条件防止子进程继承了这个变量而误判，例如在 ohbaby 里用 npm 版或源码运行另一个 ohbaby。pi 用 `PI_MANAGED_INSTALL_ROOT` 做同样的事 |
| 切换前试跑 | 新版本装好后，先用私有 Node 跑一次 `bin.js --version`，输出的版本号和目标版本一致，才改写 `current`；不一致就删掉这个版本目录并报错 | 开销很小，能拦住装坏了的版本。pi 切换前也这样检查 |
| 文本文件不带 BOM | ps1 写 `current`、`node-version` 时明确用不带 BOM 的 UTF-8（例如 `[IO.File]::WriteAllText` 配 `UTF8Encoding($false)`）；CLI 读取时去掉开头可能存在的 BOM | Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，`.cmd` 读到后会把它当成版本号的一部分，路径直接错掉。pi 出过同类 bug。探针 P3 已证实（见 5.11） |
| 不加安装标记文件 | 不像 pi 那样另放 `managed-install.json` | 卸载前的安全检查已经用"同时有 `current` 和 `releases/`"（见 5.9），启动脚本也带了版本号，再加一个文件是重复的 |
| 格式版本号 | 启动脚本第二行写一行注释，例如 `# ohbaby-launcher 1`（`.cmd` 里写成 `rem ohbaby-launcher 1`）。安装脚本靠它认出"这是自己写的启动脚本"，版本号不同时才重写 | 5.3 第 1 步要区分"脚本安装的启动脚本"和 npm 的链接；格式确实要变时，安装脚本能知道旧脚本是哪一版 |

参考项目的做法（2026-11-18 查看源码）：

| 项目 | 入口形式 | 怎么切换版本 |
|---|---|---|
| codex | 单个可执行文件，没有启动脚本。Unix 上 `~/.local/bin/codex` 是指向 `current/bin/codex` 的符号链接；Windows 上 `current` 和对外的 bin 目录都是 junction | 先建临时链接再改名，替换 `current` 链接（`scripts/install/install.sh` 的 `update_current_link`）|
| Step-Code | 单个可执行文件，直接复制到安装目录 | 先复制成 `.tmp.<pid>` 再 `mv -f` 覆盖（`infra/release/install.sh`）|
| pi | Node 程序，和我们最接近：`releases/<版本>/` + 文本文件 `current-version` + 私有 Node + 启动脚本。启动脚本由 pi.dev 提供，不在仓库里 | 先在 `staging/` 用 `npm ci` 装好，跑一次 `--version` 检查版本号对得上，再写临时文件、改名替换 `current-version`（`packages/coding-agent/src/package-manager-cli.ts`）|

pi 还有三个细节值得注意（前两点和 BOM 的处理已在上表采纳，标记文件不采纳）：

- 启动脚本通过环境变量 `PI_MANAGED_INSTALL_ROOT` 把安装目录告诉程序。程序还会检查自己的 `package.json` 确实在 `<安装目录>/releases/` 下，防止子进程继承了这个变量而误判。
- 安装目录里放一个 `managed-install.json` 作为标记，写明 `schemaVersion` 和目录布局 `releases-v1`。
- Windows PowerShell 5.1 改写文本文件时会加 UTF-8 BOM，pi 因此出过 bug（CHANGELOG 记录了"标记文件以 BOM 开头导致 `pi update` 失败"）。

### 5.11 实施前探针的结果与据此调整的决定（2026-11-18）

2026-11-18 通过 SSH 在两台机器上跑了 04 的探针 P1–P10：

- Windows 台式机：Windows 11，PowerShell 5.1.26100 和 PowerShell 7，Defender 实时保护开启。系统区域设置开了 UTF-8，代码页 65001，所以 936 代码页的情况用 `chcp 936` 模拟。
- 树莓派：Ubuntu 24.04.5 arm64，系统装在 SD 卡上。

数据和测法见 04 的 4.4 节。下表中的调整都属于 04 事先写好的"不符时怎么办"，只有标 ★ 的一项由用户拍板（2026-11-19 已确认）。

| 决策项 | 结论 | 依据 |
|---|---|---|
| Windows 启动脚本的写法 | 安装目录用 `%~dp0..` 推出来，文件里不写死路径；最后一行把启动 node 和 `call exit /b %%errorlevel%%` 写在同一行。这样每台机器上的 `.cmd` 内容都一样，而且只含 ASCII | 写死了中文路径的 `.cmd` 在 936 代码页下报"找不到路径"（P1）。原写法运行中被改写后，cmd 会接着执行错位的新内容（P2）；同一行写法是整行解析完再执行的，node 退出后不再读文件。另外试过的两种都不行：括号块写法遇到参数里的 `)` 会解析失败；npm 那种跳转到不存在标签的写法，会把 `setlocal` 里设的变量清掉，node 拿不到 `OHBABY_INSTALL_DIR` |
| Windows 启动脚本能不能改写 | 能。以后要升级格式时直接重写，不需要"替换失败就等下次" | P2：新写法在运行中被改写，原进程照常结束，退出码正确。文件也没有被锁，原来以为的"替换会失败"本来就不会发生 |
| ★ PowerShell 里的传参限制 | 只装 `.cmd`，不加装 `.ps1`（2026-11-19 用户确认）。README 写明限制：在 PowerShell 里，不带空格却含 `&`、`\|`、`<`、`>`、`^` 的参数，成对的 `%变量%`，以及参数里的双引号，会被 cmd 改掉。带空格的提示词不受影响 | P1：PowerShell 5.1 和 7 把 `'x&y'` 不加引号传给 `.cmd`，cmd 把它拆成两条命令，后面的参数和退出码都丢了。npm 和 pi（`scripts/local-release.mjs:58-64`）的办法是再放一个 `.ps1`，PowerShell 会优先用它，实测参数和退出码都正确。但在默认执行策略 Restricted 下，`.ps1` 直接报错，不会退回 `.cmd`。加装 `.ps1` 会让执行策略禁止脚本的机器连 `ohbaby` 都运行不了，比传参限制影响更大，所以不加 |
| 用户 PATH 的写法 | 改为直接读写注册表，见 5.7 | P6：`SetEnvironmentVariable` 把测试变量从 `REG_EXPAND_SZ` 改成了 `REG_SZ`，`%USERPROFILE%` 被写死。台式机真实的用户 PATH 正是 `REG_EXPAND_SZ`，并且含有 `%` 写法。Step-Code 的 `install.ps1:435-500` 用同样的办法并广播 `WM_SETTINGCHANGE` |
| 文本文件不带 BOM | 维持 5.10 | P3：`Set-Content -Encoding UTF8` 带 BOM，936 代码页下 `.cmd` 读出来是 `�?.1.18`；`Out-File` 默认写成 UTF-16，读出来是乱码；`WriteAllText` 加 `UTF8Encoding($false)` 正常 |
| 脚本只用 ASCII | `install.sh`、`install.ps1` 和它们生成的启动脚本只含 ASCII 字符，提示文字用英文（与 CLI 现有提示一致） | Windows PowerShell 5.1 按系统 ANSI 代码页读取不带 BOM 的 `.ps1`，探针脚本里的中文因此乱码；`ohbaby update` 用 `-File` 运行下载的 `install.ps1` 时也是这样 |
| Windows 解压 Node | 优先用系统自带的 `tar.exe`，找不到时用 `Expand-Archive` | P4：同一个 zip，`tar.exe` 1 秒，`Expand-Archive` 33 秒 |
| Linux 和 macOS 的压缩格式 | 有 `xz` 就下 `.tar.xz`，否则下 `.tar.gz` | P7：xz 包 30 MB、gz 包 56 MB，解压都在 3 秒内；Ubuntu 自带 `xz` |
| 清理旧版本 | Windows 和 Unix 同一个思路：靠保留两个版本做缓冲。先改名为 `.trash-*` 再删，作用只剩"不留下删了一半却仍叫 `releases/<版本>` 的目录"；删不干净的 `.trash-*` 下次再删 | P5：正在运行的版本目录能改名，加载了原生模块也能，连正在运行的 `node.exe` 所在的 runtime 目录也能；只加载了 JS 时能整个删掉；加载了原生模块时删到一半失败（18971 个文件删掉了 2267 个）。原来"改名失败说明还在用、整个保留"的依据不成立 |
| `.partial` 改名要不要重试 | 不加重试 | P5：Defender 开着，刚装好的目录立即改名，10 次都成功 |
| `--ignore-scripts` | 维持 | P4、P7：node-pty、koffi、ripgrep 在 win-x64 和 linux-arm64 上都能用 |
| 下载走不走系统代理 | ps1 维持 `Invoke-WebRequest` 的默认行为（跟随系统代理，和浏览器一致）。下载失败时打印出错的地址，并提示检查代理设置或改用 `OHBABY_NODE_MIRROR` | 台式机开着系统代理 127.0.0.1:7897，这个代理在 SSH 会话里连不上 nodejs.org，`Invoke-WebRequest` 只报"基础连接已经关闭"，看不出原因；绕开代理后正常。npm 不读系统代理，所以会出现 Node 下不来但 npm 能装（或者反过来）的情况 |
| ps1 开启 TLS 1.2 | 脚本开头在 `[Net.ServicePointManager]::SecurityProtocol` 现有值上加上 TLS 1.2 | 旧版 Windows 上 PowerShell 5.1 默认可能不带 TLS 1.2，Step-Code `install.ps1:33` 也这样处理。台式机较新，没有单独验证这一点 |
| 交互判断 | 维持 5.7 | P8：`ssh 主机 命令` 打不开 `/dev/tty`，加 `-tt` 后能打开。Windows 在 2026-11-19 补测：`ssh 主机 powershell …` 里 `[Environment]::UserInteractive` 为 False，会按非交互处理，不会卡在提问上 |
| 非登录 SSH 的 PATH | 方案不改；装完的提示里加一句："`ssh 主机 命令` 这种方式不读 `~/.profile`" | P9：Ubuntu 默认只在登录 shell 里通过 `~/.profile` 加入 `~/.local/bin`。这台树莓派的非登录 SSH 也能用，是因为用户自己在 `~/.bashrc` 第 2 行（在"非交互就返回"的判断之前）加了 PATH |
| npm 前缀就是 `~/.local` 的情况 | 第 12 步卸载 npm 版之后，再检查一次 `~/.local/bin/ohbaby`：不存在，或第二行不是 `ohbaby-launcher`，就重新写入 | 这种配置下 npm 的链接和启动脚本是同一个路径，卸载 npm 版可能把刚写好的启动脚本一起删掉。树莓派上的 `~/.local/bin/pi` 就是这种 `--prefix ~/.local` 的链接，说明这种配法真实存在（这台的 npm 前缀是 `/usr`，ohbaby 没有冲突） |
| 占用空间 | README 写"约 0.5 GB，Linux arm64 约 0.6 GB" | P10：linux-arm64 的 runtime 205 MB（其中 C 头文件 `include/` 占 67 MB，暂不裁剪），release 202 MB；Windows 上两者合计 256 MB。SD 卡上 npm 安装 76 秒，下载 30 秒 |

## 6. 待真机验证（2026-11-18 整理，实施后执行）

用户提供树莓派（Ubuntu，Linux arm64）和台式机（Windows）两台机器，可以通过 SSH 验证。macOS 在本机验证。以下是要点，细节写进 04。

**两台都要验证**

1. 没装 Node 的情况下，一条命令装好，`ohbaby --version` 正常；新开终端仍然能用。
2. 原生依赖：终端面板（node-pty）、搜索（ripgrep）、koffi 都能加载。
3. `ohbaby update` 能升级到新版本；daemon 在跑或有其他 ohbaby 窗口开着时，会按规则提示。
4. 升级失败（例如中途断网）后，`current` 不变，旧版本照常可用，残留的 `.partial` 下次会被清掉。
5. 两个安装同时运行时，后来的那个被锁挡住。
6. 从 npm 安装切换过来：询问是否卸载 npm 版，带 `--prefix` 卸载；拒绝卸载时提示 PATH 上先用哪一个。
7. `ohbaby uninstall`：npm 版和脚本版都能卸干净，配置和数据库保留；安装目录设成 `~/.ohbaby` 时拒绝删除。
8. 自定义 `OHBABY_INSTALL_DIR` 后，安装、升级、卸载都用这个目录。

**树莓派（Ubuntu arm64）额外验证**

- 下载的是 linux-arm64 的 Node，SHA-256 校验通过。
- `ssh 主机 'curl ... | sh'` 没有终端，脚本应自动按非交互处理；在交互式 SSH 会话里执行时，能从 `/dev/tty` 读到用户回答。
- Ubuntu 的 `~/.profile` 会在 `~/.local/bin` 存在时自动把它加进 PATH，验证"已在 PATH 里就不改配置"这一支。
- 用 nvm 装过 npm 版 ohbaby 时，前缀能正确反推。
- SD 卡上的安装耗时和空间占用（预计约 0.5 GB）。

**Windows 额外验证**

- Windows PowerShell 5.1 和 PowerShell 7 都能用 `irm ... | iex` 安装。
- 用户 PATH 写入后，当前窗口和新窗口都能用；`ohbaby.cmd` 在 cmd 和 PowerShell 里都能运行。
- 旧版本正在运行时升级：新版本装好并切换，正在运行的旧进程不受影响；删不干净的 `.trash-*` 下次升级再删。
- ps1 写出的 `current`、`node-version` 没有 BOM（带 BOM 时 `.cmd` 读不出来，已由探针 P3 证实，只有 CLI 会去掉 BOM）。
- npm 版 `ohbaby uninstall` 结束时可能多打印一句"找不到批处理文件"（见 5.4）。
- 在 `ohbaby serve` 前台运行时按 Ctrl+C，记录 cmd 会不会多问一句"终止批处理操作吗(Y/N)?"。这一项 SSH 下测不了。

括号块写法的问题已在实施前探针中回答（见 5.11）。

