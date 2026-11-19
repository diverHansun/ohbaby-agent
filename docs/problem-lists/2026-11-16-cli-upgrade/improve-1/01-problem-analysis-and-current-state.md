# 01 现状与问题分析

> 时间口径：`main` 分支 `bc0d4cc1`（v0.1.18），2026-11-18 核查。本轮还没有任何实施，下文全是"议题启动时"的现状。已确认的决定见 [00](00-discussion.md)，方案见 [02](02-optimization-plan-and-change-scope.md)。

## 1.1 问题陈述

| 编号 | 用户看到的问题 | 技术原因 |
|---|---|---|
| P1 | 不知道有新版本，升级要自己记 npm 命令 | 程序里没有任何检查新版本的代码，也没有 `update` 命令 |
| P2 | 升级后再运行 `ohbaby serve` 或连接 daemon，直接报"版本不一致"，要自己先 `serve stop` 再 `serve` | 运行中的旧 daemon 不会被停掉；新 CLI 发现版本不一致只报错（`main.ts:341-353`） |
| P3 | 停 daemon 时可能打断正在跑的任务，用户事先不知道 | `serve stop` 不检查有没有正在运行的任务，daemon 也没有对外提供"正在运行的任务"的接口 |
| P4 | Windows 上升级常因文件被占用失败 | npm 全局安装原地覆盖目录，其他 ohbaby 进程占着 `.node` 文件；目前不检查其他进程 |
| P5 | 新版本改过数据库后，再运行旧版本（降级、或者两种安装混用），旧程序会照常读写新结构的数据库 | 启动时只应用自己认识的迁移，不检查数据库里有没有自己不认识的、更新的迁移 |
| P6 | daemon 重启后，Web 页面停在"服务已重启，请刷新"，要手动点按钮 | daemon 每次启动都会生成新 token，旧页面的请求被拒绝，前端只显示提示 |

P1、P2 是本议题的主要动机。P3–P6 是"一条命令升级"真正可用必须一起解决的问题。

## 1.2 已确认的分界

```
                      ┌──────────────── 本议题 ────────────────┐
启动 TUI / serve ──→  │ 读缓存提示新版本；后台刷新缓存；可选自动升级 │
ohbaby update   ──→  │ 查版本 → 升级前检查（任务、daemon、其他进程）│
                      │      → 按安装方式升级 → 告诉用户结果       │
数据库               │ 发现不认识的更新迁移时拒绝启动               │
Web                  │ daemon 重启后自动刷新页面                    │
                      └──────────────────────────────────────────┘
                      ┌──────────── 脚本安装议题 ────────────┐
                      │ 判断安装方式、安装脚本、uninstall       │
                      └─────────────────────────────────────┘
```

不在本轮：App 的更新，远程强制最低版本，在 TUI 或 Web 里点按钮升级（见 00 第 2、3 节）。

## 1.3 现状（七个维度）

### 1.3.1 goals-duty：升级没有归属

CLI 的模块设计文档（`docs/cli/goals-duty.md`、`docs/cli/architecture.md`）只描述了 TUI、`run`、`serve` 三类命令，没有提到升级。仓库里也没有任何代码负责检查版本或升级。用户能得到的升级信息只有 README 的安装命令。

### 1.3.2 architecture：CLI 命令和 daemon 的关系

```
ohbaby（bin.ts）
  ├─ 默认命令 → cli/commands/terminal.ts → TUI，在本进程里运行 agent，不连 daemon
  ├─ run      → cli/commands/run.ts      → 非交互运行，在本进程里运行
  └─ serve    → cli/commands/serve.ts    → 在前台启动 daemon（main.ts:665 startDaemonServer），
                                            serve stop / status / ps 管理它
```

- 命令注册在 `packages/ohbaby-cli/src/bin.ts:712-726` 的 yargs 链上。
- 没有后台自动启动 daemon 的机制。daemon 总是用户自己在某个终端里运行 `ohbaby serve` 启动的。
- 版本号来自 `packages/ohbaby-cli/src/package-version.ts`，读自身的 `package.json`。

### 1.3.3 data-model：和升级相关的数据

| 数据 | 位置 | 现状 |
|---|---|---|
| daemon 状态 | `<OHBABY_HOME>/server/daemon-state.json` | 含 pid、端口、`authToken`、`packageVersion`。CLI 用它找到并停止 daemon |
| 数据库迁移记录 | SQLite 的 `migration` 表（version 主键、applied_at），建表在 `services/database/index.ts:130-136` | 迁移定义在 `services/database/migrations.ts:3` 的 `INITIAL_MIGRATIONS`，从 `001_initial` 到 `033_shell_job_promoted_at`。git 历史里没有删除或改名过任何迁移 |
| 用户设置 | 无通用设置文件 | 现有配置分散在 `model.json`、技能/agent/MCP 各自的 `settings.json`、数据库 `app_state` 表。原子写文件的工具函数是 `config/secrets/atomic-file.ts:4` 的 `writeFileAtomically` |
| 版本检查缓存 | 无 | `<OHBABY_HOME>` 下没有 `cache/` 或类似目录 |

### 1.3.4 dfd-interface：启动提示、daemon 停止、Web 重连

**启动提示**：`bin.ts:571` 的 `StartupNoticeBuffer` 收集启动时的提示。子命令把它们打印到 stderr；TUI 通过 `takeStartupNotices`（`bin.ts:697`、`terminal.ts:115`）在界面里显示为 "Startup warning"。新版本提示可以走同一条路。

**网络代理**：`bin.ts:617-633` 的 `initializeProxy()` 在进程里装一次全局代理（`utils/network-proxy/index.ts:73`）。检查新版本和 update 下载前都要先调用它，否则代理用户连不上 registry。

**停止 daemon**：

```
serve stop（serve.ts:149-168）
  → stopDaemonFromState（ohbaby-server/src/runtime/daemon/stop.ts:225）
      → 读 daemon-state.json，核对 pid 和 token（160-176）
      → POST /api/shutdown，带 Bearer token（64-82；路由在 protocols/web/routes/system.ts:24-30）
      → 轮询直到进程退出，最多 12 秒
```

停止前不检查任何东西，不区分平台。

**正在运行的任务**：`RunLedger.getActiveRuns`（`runtime/run-ledger/types.ts:106`，数据库实现在 `database.ts:572`）能列出活动中的运行记录，记录里有 owner 进程号。daemon 没有对外暴露这个信息的 HTTP 接口。

**版本不一致**：`assertPackageVersionMatches`（`main.ts:341-353`）在复用已运行的 daemon（约 `main.ts:438`）和列出连接（`main.ts:836`）时调用，只报错，提示用户手动 `serve stop` 再 `serve`。

**Web 重连**：

```
daemon 停止 → 页面 SSE 断开 → client-sync.ts:205-230 约 10 秒后标为"连接丢失"，继续重连
daemon 重新启动 → main.ts:668 生成新的 authToken → 旧页面带旧 token 请求被拒（401）
  → DaemonEventsRejectedError（wire.ts）→ 状态设为 "restarted"（client-sync.ts:221-224）
  → ConnectionOverlay.tsx:71-81 显示"服务已重启，请刷新"，用户点按钮才 location.reload()
```

`GET /api/health`（`system.ts:12-22`）会返回 `packageVersion`，但需要 token，旧页面拿不到；Web 目前也没有读它。

### 1.3.5 use-case：现在升级要几步

| 用例 | 现在怎么做 |
|---|---|
| 知道有新版本 | 自己去 npm 或 GitHub 看 |
| npm 版升级 | 记住 `npm i -g ohbaby-cli`；如果用 nvm 或多个 Node，还得确认用的是哪个 npm |
| 升级时 daemon 在跑 | 升级后启动报错，再手动 `serve stop`、`serve` |
| Web 页面开着 | 升级并重启 daemon 后，在页面上手动点"刷新" |
| Windows 有其他 ohbaby 窗口开着 | npm 报文件占用，用户要自己猜是哪个进程 |

### 1.3.6 non-functional

- **启动速度**：版本检查不能阻塞 TUI 启动，网络慢或断网时也不能。
- **可关闭**：CI、离线环境、脚本里调用 `ohbaby run` 时不应该去访问网络。参考项目都提供了关闭检查的环境变量（见 03）。
- **数据安全**：停 daemon 会中断正在运行的任务；降级后旧程序写新数据库可能损坏数据。

### 1.3.7 test：可复用的测试基础

- `tests/integration/cli/packaging-smoke.integration.test.ts` 已经会打包、启动本地 registry、用 `npm install -g --prefix` 安装（约 L740-760）。升级测试可以在本地 registry 上发布两个版本，再从旧版本升到新版本。
- daemon 相关的集成测试在 `packages/ohbaby-server/src/runtime/daemon/` 和 `tests/integration/cli/daemon-*.integration.test.ts`。
- Web 的连接状态测试在 `apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts`、`apps/ohbaby-web/src/ui/App.unit.test.tsx`。
- 数据库迁移有单元测试，但没有"数据库比程序新"的用例。

## 1.4 数据库版本保护的现状

`initDatabase`（`services/database/index.ts:265-290`）调用 `runMigrations`（`index.ts:249-262`）：

1. 建 `migration` 表。
2. `prepareOfflineMigration`：有需要离线执行的迁移时，检查其他写入进程是否存活，存活就抛 `DatabaseUpgradeBlockedError`（`index.ts:173-247`），否则先用 `VACUUM INTO` 做备份。
3. 逐个应用还没应用的迁移。

缺的是反方向的检查：`migration` 表里有自己不认识的版本时，程序照常启动。数据库开了 WAL，`busy_timeout` 先设 5000 毫秒、迁移后改为 25 毫秒（`index.ts:125-127`、`279`）。同版本多进程共用数据库的规则在[多进程会话占用](../../2026-11-10-multi-process-session-ownership/README.md)议题，还在讨论中，本议题不碰。

## 1.5 跨模块一致性

| 跨模块的点 | 现状 | 风险 |
|---|---|---|
| CLI 和 daemon 的版本 | daemon-state 里记录 `packageVersion`，新 CLI 发现不同就报错 | 升级流程必须先停 daemon，否则用户一定会撞上这个报错 |
| CLI 和脚本安装议题 | update 依赖"判断安装方式"（脚本安装议题 Stage 1）；uninstall 依赖本议题的"升级前检查" | 两边要约定一个共用的模块，不能各写一份 |
| daemon 和 Web | token 每次启动都变 | Web 无法在刷新前问新 daemon 的版本，"发现版本变了就刷新"只能落实为"服务重启就刷新" |
| 新旧程序和数据库 | 只有正向迁移，没有反向检查 | 见 P5 |
| `serve-awareness.ts` 的路径 | `serve-awareness.ts:75-79` 写死 `homedir()/.ohbaby/server`，和 `resolveOhbabyHome()` 不一致 | 设置了 `OHBABY_HOME` 时读错文件。2026-11-19 改由前置议题[daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/README.md)的 Stage 3 修复 |

## 1.6 改动影响面（现状视角）

| 包 | 会动到什么 |
|---|---|
| `ohbaby-cli` | 新增 update 命令、版本检查、升级前检查模块；启动时接入新版本提示 |
| `ohbaby-server` | 新增"正在运行的任务"接口；停止 daemon 的函数被 CLI 复用 |
| `ohbaby-agent` | `runMigrations` 加反向检查和对应的错误类型 |
| `ohbaby-web` | 收到"服务已重启"时自动刷新 |
| `ohbaby-sdk`、`ohbaby-llm` | 不动 |

## 1.7 SWE 原则审视摘要

- **单一职责**：升级前检查（任务、daemon、其他进程）会被 update 和 uninstall 共用，应该独立成一个模块，不写进某个命令里。
- **信息隐藏**：CLI 不应该直接读 run_ledger 表来判断有没有任务在跑，应该问 daemon，由 daemon 用它自己的 `RunLedger` 回答。
- **YAGNI**：没有下发策略的后端，不做远程最低版本；daemon 没有后台模式，升级后不自动重启 daemon。
- **可逆性**：数据库反向检查一旦发布，就约束了以后所有迁移只能追加、不能改名或删除。这一点要写进迁移的开发约定。

## 1.8 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `docs/cli/architecture.md`、`docs/cli/goals-duty.md` | CLI 模块的权威设计文档，实施后要补上 `update` 命令和版本检查（02 的 D2） |
| 本议题 README 提到的 `docs/cli/upgrade/` | 目前不存在。升级功能的代码量不大，建议不单独建模块设计文档，改为更新 `docs/cli/` 的现有文档（2026-11-19 用户确认） |
| [脚本安装议题](../../2026-11-17-script-install/README.md) | 判断安装方式、安装脚本、uninstall 都在那边 |
| [多进程会话占用议题](../../2026-11-10-multi-process-session-ownership/README.md) | 同版本多进程规则在那边，本议题只管跨版本 |
