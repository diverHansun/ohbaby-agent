# 01 现状与问题分析

> 时间口径：`main` 分支 `bc0d4cc1`（v0.1.18），2026-11-18 核查。本轮还没有任何实施，下文全是"议题启动时"的现状。已确认的决定见 [00](00-discussion.md)，方案见 02。

## 1.1 问题陈述

| 编号 | 用户看到的问题 | 技术原因 |
|---|---|---|
| P1 | 没装 Node.js 24 就装不了 ohbaby，很多人卡在第一步 | 唯一的安装方式是 `npm install -g ohbaby-cli`，`engines` 要求 Node `>=24.0.0`，系统 Node 版本由用户自己负责 |
| P2 | 升级和卸载都要自己记 npm 命令；升级后旧 daemon 还在跑会报版本不一致 | CLI 里没有 `update`、`uninstall` 命令，程序也不知道自己是怎么装的 |
| P3 | Windows 上升级时常因为文件被占用而失败 | npm 全局安装是原地覆盖同一个目录，正在运行的 `node.exe` 和已加载的 `.node` 文件不能覆盖 |
| P4 | 将来提供脚本安装后，用户可能同时有两个 `ohbaby`，搞不清运行的是哪一个 | 两种安装各自放一个可执行入口，谁先被用到取决于 PATH 顺序；目前没有任何检测和提示 |

P1 是本议题的主要动机。P2 由本议题和 [CLI 升级](../../2026-11-16-cli-upgrade/README.md) 议题分担：update 在那边，uninstall 和"判断安装方式"在这边。P3、P4 是做脚本安装时必须一起解决的问题。

## 1.2 已确认的分界

```
                   ┌──────────── 本议题 ────────────┐
用户机器上没有 Node ─→ install.sh / install.ps1 ─→ 私有 Node + releases/<版本> + 启动脚本
                   │                               │
用户已用 npm 安装  ─→ 安装脚本检测到 npm 版 ─→ 询问是否卸载
                   │                               │
                   │  ohbaby uninstall（两种安装都管）│
                   └───────────────────────────────┘
                   ┌────────── CLI 升级议题 ──────────┐
                   │ ohbaby update：查版本、停 daemon、 │
                   │ 按安装方式分支（共用判断代码）     │
                   └───────────────────────────────┘
```

不在本轮：brew、winget、scoop，单文件可执行文件（Node SEA），App 的安装与更新，依赖版本锁定（见 00 第 4 节和 5.8）。

## 1.3 发布物与安装现状

### 1.3.1 goals-duty：没有任何模块负责"安装"

仓库里没有安装相关的设计文档，也没有代码负责安装、升级或卸载。安装说明只写在 README 里：

| 位置 | 内容 |
|---|---|
| `README.md:39`、`README.zh.md:39` | `npm install -g ohbaby-cli`，前面注明需要 Node.js 24 |
| `packages/ohbaby-cli/README.md:39`、`packages/ohbaby-agent/README.md:25`、`packages/ohbaby-sdk/README.md:22` | 同上 |
| `docs/releases/v0.1.13.md` 到 `v0.1.18.md` | 每版发布说明写一句 `npm install -g ohbaby-cli@<版本>` |

程序运行时没有任何提示用户执行 `npm install` 的文案。

### 1.3.2 architecture：五个 npm 包，原生依赖拆成平台可选包

```
ohbaby-cli（bin: ohbaby → dist/bin.js，内含 dist/web 静态资源）
  ├─ ohbaby-server   ── @lydell/node-pty 1.2.0-beta.18
  ├─ ohbaby-agent    ── koffi 3.1.1、@vscode/ripgrep 1.18.0、web-tree-sitter 0.25.10
  ├─ ohbaby-sdk
  └─ ohbaby-llm
```

依据：`packages/ohbaby-cli/package.json`，`packages/ohbaby-agent/package.json:51-62`，`packages/ohbaby-server/package.json:43`。

| 依赖 | 平台文件怎么来 | 对安装方式的影响 |
|---|---|---|
| node-pty | 平台可选依赖，只有 darwin、linux、win32 的 x64 和 arm64 六个包，没有 musl 包 | 省略可选依赖时终端面板失效；Alpine 等 musl 系统用不了 |
| ripgrep | 平台可选依赖 | 省略可选依赖时搜索失效 |
| koffi | 平台可选依赖 `@koromix/koffi-<平台>`，lock 文件里没有 musl 包。自带的 `install` 脚本不跑也能加载 | 可以用 `--ignore-scripts` 安装 |
| web-tree-sitter | wasm，按 `import.meta.url` 找文件 | 与安装位置无关 |
| SQLite | Node 内置的 `node:sqlite` | 要求 Node 24，这正是 P1 的来源 |

结论：只要按 npm 的模块解析规则装好、不省略可选依赖，装在哪个目录都能用。00 的 5.1 节已在本机用 `npm install --prefix` 实测通过。

### 1.3.3 data-model：磁盘上的几类位置

| 内容 | 位置 | 代码 |
|---|---|---|
| 配置根目录 | `OHBABY_HOME`，默认 `~/.ohbaby` | `packages/ohbaby-agent/src/paths/ohbaby-home.ts` 的 `resolveOhbabyHome()`（第 54–65 行，要求绝对路径） |
| 数据库 | 平台数据目录下的 `ohbaby/ohbaby.db`，可用 `OHBABY_DB_PATH` 覆盖 | `packages/ohbaby-agent/src/services/database/path.ts:12-13`，`ohbaby-home.ts` 的 `resolveOhbabyDataRoot()` |
| daemon 状态 | `<OHBABY_HOME>/server/daemon.pid`、`daemon-state.json`，另有按项目放的旧路径 | `packages/ohbaby-server/src/runtime/daemon/scope.ts:51-62` |
| 程序本身 | npm 全局目录 `<前缀>/lib/node_modules/ohbaby-cli`（Windows 为 `<前缀>\node_modules\ohbaby-cli`） | 由 npm 决定 |

脚本安装要新增的是第五类：安装目录 `~/.ohbaby/install`（00 的 5.1 节）。现在没有任何代码扫描或清理整个 `~/.ohbaby`，所以安装目录放在这下面不会被误动（00 的 5.1 节调查结果）。

`daemon-state.json` 里有 `packageVersion` 字段（`packages/ohbaby-cli/src/serve-awareness.ts` 的 `DaemonState`），安装脚本和 update 都可以用它判断 daemon 是哪个版本。

### 1.3.4 dfd-interface：现在的启动链路

```
用户敲 ohbaby
  → PATH 上的 npm 链接或 shim（Unix 是符号链接，Windows 是 npm 生成的 ohbaby.cmd）
  → PATH 上的 node
  → <npm 前缀>/…/ohbaby-cli/dist/bin.js
      ├─ 版本号：从 import.meta.url 往上找 package.json（src/package-version.ts:3）
      ├─ 是否被直接调用：比较 realpath（src/bin.ts:46-62）
      └─ yargs 注册 terminal、run、serve 三个命令（src/bin.ts:712-726）
```

几个和本议题直接相关的事实：

- 用哪个 Node 完全取决于 PATH，程序不检查也不控制。
- 程序不知道自己装在哪里，也就分不出 npm 安装、脚本安装还是源码运行。好在版本号已经是用 `import.meta.url` 读的，判断安装位置可以用同一个起点（00 的 5.1 节调查结果）。
- `isDirectCliInvocation` 用 realpath 比较，`<私有 node> <release>/…/dist/bin.js` 这种调用方式能通过（`src/bin.ts:46-62`、`bin.ts:754`）。
- bash 工具、终端面板、MCP 服务启动的子进程都继承启动时的环境，ohbaby 不改 PATH（`packages/ohbaby-agent/src/tools/bash.ts:77-101`、`terminal/shell-launch.ts:14-25`、`mcp/core/transport.ts:16-25`）。所以系统没装 Node 时，agent 执行 `node` 或 `npx` 类 MCP 服务都会失败。
- daemon 由 `ohbaby serve` 在自己的进程里运行（`packages/ohbaby-cli/src/cli/commands/serve.ts:181`），全仓库没有用 `process.execPath` 再启动自己。daemon 一直使用启动它的那个版本的文件。

### 1.3.5 use-case：四个用例现在都靠手动

| 用例 | 现在怎么做 | 问题 |
|---|---|---|
| 首次安装 | 先装 Node 24，再 `npm install -g ohbaby-cli` | P1 |
| 升级 | 手动 `npm install -g ohbaby-cli@<版本>`；daemon 在跑时要先 `ohbaby serve stop` | P2、P3 |
| 卸载 | 手动 `npm uninstall -g ohbaby-cli`；nvm 等多套 Node 并存时，PATH 上的 npm 不一定是当初装 ohbaby 的那个 | P2 |
| 换安装方式 | 没有这条路 | P4 在脚本安装上线后才会出现 |

### 1.3.6 non-functional

| 方面 | 现状 | 风险 |
|---|---|---|
| 可靠性 | npm 原地覆盖安装，Windows 上文件被占用就失败，没有回滚 | P3 |
| 安全 | npm 默认运行依赖的安装脚本；koffi 带 `install` 脚本 | 脚本安装可以用 `--ignore-scripts` 避免执行第三方脚本（00 的 5.1 节） |
| 可重复性 | 第三方依赖有 25 处写的是版本范围，同一个版本不同时间装出来的间接依赖可能不同 | 已知风险，本轮不做（00 的 5.8 节） |
| 空间 | 一个 release 目录约 195 MB，私有 Node 约 100 MB | 脚本安装保留两个版本时约 0.5 GB（00 的 5.1 节） |
| 平台 | 实际可用的平台由 node-pty 决定：macOS、Linux glibc、Windows 的 x64 和 arm64 | musl 和 32 位不支持（00 的 5.6 节） |

### 1.3.7 test：打包冒烟测试可以复用，安装脚本没有测试

| 已有测试 | 覆盖什么 | 对本议题的价值 |
|---|---|---|
| `tests/integration/cli/packaging-smoke.integration.test.ts` | 把五个包 `pnpm pack` 成 tarball，起一个本地 registry，用 `npm install -g --prefix <临时目录> --ignore-scripts` 安装，检查 `ohbaby --help`、`--version` | 安装脚本的测试可以直接用这个本地 registry：脚本内部的 `npm install` 读 `npm_config_registry`，不用碰真实 npm |
| `.github/workflows/ci.yml` | ubuntu、windows、macos 三个系统跑类型检查、lint、测试、构建 | 安装脚本的测试能在三个系统上自动跑 |

缺口：

- 没有任何 sh 或 ps1 脚本的测试。
- 没有"判断安装方式"的代码，自然也没有测试。
- Windows 文件占用、`.cmd` 边执行边读这类问题，CI 和单元测试都很难模拟，要靠真机验证（00 第 6 节）。

## 1.4 CLI 程序侧现状

| 方面 | 现状 | 代码 |
|---|---|---|
| 命令注册 | yargs 在 `bin.ts` 里集中注册，每个命令一个文件，放在 `src/cli/commands/`（`run.ts`、`serve.ts`、`terminal.ts`） | `packages/ohbaby-cli/src/bin.ts:712-726` |
| daemon 检查 | `serve-awareness.ts` 读 `daemon.pid` 和 `daemon-state.json`，检查 pid 是否活着，再请求 `/api/health` | `packages/ohbaby-cli/src/serve-awareness.ts:71-110` |
| 安装位置 | 没有相关代码 | — |

`serve-awareness.ts:75-79` 把 daemon 目录写死成 `homedir()/.ohbaby/server`，没有用 `resolveOhbabyHome()`。而 daemon 自己是按 `OHBABY_HOME` 放状态文件的（`scope.ts:51-62`）。设置了 `OHBABY_HOME` 时，两边读写的不是同一个文件。这是现有的不一致，update 和 uninstall 都要检查 daemon，需要先统一。

## 1.5 跨模块一致性

| 关系 | 现状 | 本议题要注意的 |
|---|---|---|
| 与 CLI 升级议题 | `ohbaby update` 还不存在 | update 和 uninstall 共用"判断安装方式"和"检查 daemon、其他进程"的代码，这些代码只写一份 |
| 安装脚本与 TypeScript 的路径约定 | 安装脚本是 sh 和 ps1，调用不到 `resolveOhbabyHome()` | 脚本里要按同样的规则算出 daemon 状态文件的位置：先认 `OHBABY_HOME`，没有就用 `~/.ohbaby`（00 的 5.3 节） |
| 启动脚本与程序之间 | 不存在 | `OHBABY_INSTALL_DIR`、`current`、`node-version` 三者组成新的跨语言契约（sh、ps1、cmd、TypeScript 四方都读写），格式要固定并有版本号（00 的 5.10 节） |
| 配置目录与安装目录 | 只有配置目录 | 安装目录不跟随 `OHBABY_HOME`；uninstall 删除前必须确认它不是 `OHBABY_HOME`（00 的 5.9 节） |

## 1.6 改动影响面（现状视角）

| 位置 | 会动到什么 |
|---|---|
| `packages/ohbaby-cli/`（新增文件） | `install.sh`、`install.ps1`，并加进 `package.json` 的 `files` |
| `packages/ohbaby-cli/src/` | 新增"判断安装方式"、`uninstall` 命令；`bin.ts` 注册新命令；`serve-awareness.ts` 的 daemon 路径改用 `resolveOhbabyHome()`（2026-11-19 移到前置议题[daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/README.md)） |
| `tests/` | 安装脚本的集成测试，复用打包冒烟测试的本地 registry |
| `.github/workflows/ci.yml` | 三个系统上跑安装脚本测试 |
| 文档 | 根目录和各包 README 的安装说明；发布说明模板 |

不需要改的：`ohbaby-agent`、`ohbaby-server`、`ohbaby-sdk`、`ohbaby-llm` 的运行逻辑。原生依赖在 `--prefix` 布局下已验证可用，私有 Node 由启动脚本放进 PATH 末尾，子进程逻辑不用改（00 的 5.1 节）。

本议题没有超出一轮的承载，不需要切割。实施可以在 02 里分成几个 Stage。

## 1.7 SWE 原则审视摘要

- **复杂度放在哪里**：安装逻辑只在 sh 和 ps1 里各写一份，TypeScript 只负责判断安装方式和调用脚本（00 的 5.2 节）。这是有意的取舍：两份脚本必须保持行为一致，代价是重复；换来的好处是不用在 TypeScript 里再写第三份，并且首次安装时还没有 Node 可用，本来就只能写在脚本里。
- **跨语言契约是最容易出错的地方**：`current`、`node-version`、`OHBABY_INSTALL_DIR` 由四种语言读写，要像对外 API 一样对待：格式最简单（一行文本）、不带 BOM、写时先写临时文件再改名、启动脚本带格式版本号。
- **不可逆的部分**：启动脚本一旦发到用户机器上就很难改，所以它要最小（00 的 5.10 节）。安装目录布局也是长期约定，`releases/` 加文本指针这套结构与 codex、pi 一致。
- **已有的坏味道**：`serve-awareness.ts` 绕过 `resolveOhbabyHome()` 自己拼路径，属于重复且不一致的逻辑。2026-11-19 起改由前置议题[daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/README.md)修复。
- **没有过度设计的地方**：不做包管理器分发、不做签名、不做自动选镜像，这些都在 00 里有明确理由。

## 1.8 与既有文档的关系

| 文档 | 关系 |
|---|---|
| [00 讨论与已确认要点](00-discussion.md) | 本文的依据。00 第 6 节的真机验证清单在 04 展开 |
| [CLI 升级议题](../../2026-11-16-cli-upgrade/README.md) | `ohbaby update` 在那边实现；"判断安装方式"的代码在本议题实现，两边共用 |
| `docs/cli/`、`docs/ohbaby-cli/` | 现有 CLI 文档不涉及安装，没有冲突。本议题不另建模块级改进文档：新增内容自成一块，不改变现有模块的设计 |
| `docs/releases/` | 以后的发布说明要同时写 npm 和脚本两种安装命令（02 列入改动） |
