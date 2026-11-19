# 02 方案与改动面

> 本文是交给实施会话的契约：实施者按本文改代码，按 [04](04-test-and-acceptance.md) 自测和验收。规划会话不写代码。决定的来源见 [00](00-discussion.md)，问题编号 P1–P6 见 [01](01-problem-analysis-and-current-state.md)。

## 2.1 方案总览

```
启动 TUI 或 serve
  └─ 读 <OHBABY_HOME>/update/check.json → 有更新的版本就提示（自动升级打开时见 Stage 3）
  └─ 缓存超过 24 小时 → 后台查 registry，写回缓存，不等结果

ohbaby update [版本]
  1. 判断安装方式（脚本安装议题的 detectInstallMethod）；其他方式 → 打印命令，结束
  2. 确定目标版本；和当前版本相同 → 提示已是最新，结束
  3. 升级前检查（共用模块，uninstall 也用）
       核对 daemon 身份。Windows 的 npm 安装同时检查其他 ohbaby 进程
       daemon 在跑 → 请求仅空闲时停止，忙则列出任务并终止升级
       确认本来没有待处理的 daemon，或目标进程已退出且清理已完成 → 继续
  4. 按安装方式升级
       npm → <前缀>/npm install -g --prefix <前缀> ohbaby-cli@<版本>
       脚本 → 下载 ohbaby-cli@<版本>/install.sh 或 install.ps1，以非交互方式运行
  5. 确认新版本能运行，打印结果；daemon 被停过的，提示重新运行 ohbaby serve

数据库：启动时发现 migration 表里有不认识的版本 → 拒绝启动，提示 ohbaby update
Web：收到"服务已重启" → 自动刷新整页（30 秒内只自动刷新一次）
```

## 2.2 设计决策表

前 7 行来自 00，后 6 行是撰写本文时按 KISS 补定的实施细节（标 ★），2026-11-19 已逐项确认，记录见 00 第 5 节。

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 升级入口 | 只有 `ohbaby update`（00 第 2 节、第 5 节） | TUI 在自己进程里跑，界面里升级要处理自我替换 | TUI、Web 里的升级按钮 | 用户要回到终端 |
| 按安装方式分支 | 依赖脚本安装议题的 `detectInstallMethod`（00 第 5 节） | update 和 uninstall 共用一份判断 | 只支持 npm | 本议题的脚本安装分支要等那边 Stage 1、2 |
| 新版本检查 | 启动读缓存，后台刷新（00 第 2 节） | 不拖慢启动 | 启动时同步查询 | 新版本发布后，最多晚一次启动才提示 |
| 升级与 daemon | 由 daemon 在同一次请求里确认空闲并停止 | 避免空闲查询与停机之间接收新任务 | 客户端分开查任务和停机 | 需要一个仅空闲时停止的入口 |
| 其他进程 | 只在 Windows 的 npm 安装上检查并阻止（00 第 2 节） | 只有这个组合会因为文件占用而失败。脚本安装的新版本装进新目录，不冲突 | 所有平台都检查 | macOS、Linux 上其他窗口继续跑旧版本，直到重开 |
| 数据库保护 | 发现不认识的迁移就拒绝启动（00 第 2 节）。**不可逆**：发布后迁移只能追加，不能改名或删除 | 防止旧程序写新结构的数据库 | 只警告不拒绝 | 降级的用户必须先升级回来 |
| Web 刷新 | 收到"服务已重启"就自动刷新（00 第 2 节，按 01 的 1.5 节调整了触发条件） | daemon 每次启动都换 token，旧页面无法在刷新前读到新版本号；服务重启后旧页面本来也只能刷新 | 加一个不需要 token 的版本接口 | 非升级的重启也会自动刷新，这和现在点"刷新"按钮的效果一样 |
| ★ 版本来源（2026-11-19 确认） | `GET <registry>/ohbaby-cli/latest`，registry 取环境变量 `npm_config_registry`，没有就用 `https://registry.npmjs.org`；3 秒超时，走 `initializeProxy` 装好的代理 | 不依赖本机 npm，脚本安装和 npm 安装都能用；`npm_config_registry` 是 npm 自己认的变量，测试也靠它指向本地 registry | 运行 `npm view`（慢，要找对 npm）；GitHub Releases；解析 `.npmrc` | 只在 `.npmrc` 里配了其他 registry 的用户，检查会去访问 npmjs.org，失败时不提示，不影响使用。脚本安装的 update 把查到的版本交给安装脚本，脚本按 `.npmrc` 的源安装；镜像还没同步时会安装失败，脚本提示稍后再试（脚本安装议题 02 第 6 步），不另做对齐 |
| ★ 缓存位置与间隔（2026-11-19 确认） | `<OHBABY_HOME>/update/check.json`，记录检查时间和最新版本，24 小时刷新一次 | 和 codex 的做法接近（20 小时） | 每次启动都查 | 无 |
| ★ 关闭检查（2026-11-19 确认） | 环境变量 `OHBABY_NO_UPDATE_CHECK=1`；`ohbaby run` 本来就不检查 | CI、离线环境、脚本调用不访问网络；参考项目都有类似开关 | 写进设置文件 | 多一个环境变量 |
| ★ 自动升级开关（2026-11-19 确认） | `<OHBABY_HOME>/update/settings.json` 里的 `autoUpdate`，默认 `false`；用 `ohbaby update --auto on` 或 `off` 修改 | 升级入口只有 `update` 命令，开关也放在这里；设置和缓存分两个文件，后台写缓存不会冲掉用户的设置 | 新建通用设置文件；放进数据库 `app_state` 表 | 用户要知道这个参数，在提示里告诉他 |
| ★ 自动升级的时机（2026-11-19 确认） | 只在启动 TUI 时，且缓存显示有新版本、升级前检查全部通过，才在界面加载前执行升级；成功后提示"已升级到 x，请重新运行 ohbaby"并退出。安装器没动过文件就退回只提示并进入 TUI；动过或无法确认就退出，规则见 Stage 3 | 界面加载后再替换文件，npm 安装下后加载的模块会混用新旧版本；Windows 上还会因文件占用失败。CLI 分不清 npm 失败时是否已开始替换，所以 npm 命令一运行就按"动过"处理 | 后台边用边升级；升级后自动重新启动自己 | 自动升级那一次需要用户再运行一次 |
| ★ 升级后的 daemon（2026-11-19 确认） | 不自动重启，只提示用户在原来的终端重新运行 `ohbaby serve` | daemon 一直是用户在某个终端前台启动的，没有后台模式；从 update 里拉起会改变它的运行方式 | 后台拉起新 daemon | 用户多一步操作 |

## 2.3 分阶段实施

全部 Stage 属于 improve-1。开工前先完成前置议题 [daemon 停止残留与诊断日志](../../2026-11-19-daemon-lifecycle-cleanup/README.md)（2026-11-19 确认），Stage 2 的停 daemon 和读状态文件都依赖它。Stage 1、2 互不依赖，可以并行；Stage 3 依赖 Stage 1；Stage 4 依赖 Stage 1、2 和脚本安装议题的 Stage 1；Stage 5、6 独立。

与脚本安装议题的先后：

- Stage 4 的 npm 分支只需要脚本安装议题的 Stage 1（判断安装方式）。
- Stage 4 的脚本安装分支要等那边 Stage 2（安装脚本）发布后才能端到端测试。实现时可以先写好，用本地文件代替下载来测。
- 那边的 `ohbaby uninstall` 复用本议题 Stage 2 的升级前检查。

### Stage 1：新版本检查与提示

**目标**：启动 TUI 或 `serve` 时，有新版本就提示"运行 ohbaby update 升级"，不拖慢启动。

**改动**：

- 新增 `packages/ohbaby-cli/src/update/version-check.ts`：
  - `readUpdateNotice(options)`：读 `check.json`，最新版本比当前版本新（按 semver 比较，预发布版本只和预发布版本比较）就返回提示文字。文件不存在或内容损坏都当作没有更新。
  - `fetchLatestVersion(options)`：请求 `<registry>/ohbaby-cli/latest`，registry 的取法见 2.2 的版本来源，只接受合法的 semver。Stage 4 也用它。
  - `refreshVersionCacheInBackground(options)`：缓存超过 24 小时才发请求，3 秒超时，成功后先写 `check.json.tmp.<pid>` 再改名写回（`ohbaby-agent` 的 `writeFileAtomically` 没有从包导出，CLI 里写一个几行的本地函数，`settings.json` 也用它）。任何错误都吞掉，不打印。不阻止进程退出（用 `unref` 的定时器和可中止的请求）。
  - 设置了 `OHBABY_NO_UPDATE_CHECK=1` 时两个函数都直接返回。
- `bin.ts`：`initializeProxy` 是 `runOhbabyCli` 里的局部闭包（`bin.ts:617`），不能直接导入。在 `bin.ts:635` 构造的 `CliCommandRuntime` 上加一个 `initializeProxy` 字段，传入同一个闭包，Stage 4 的 update 命令通过它调用。在 `initializeProxy()` 之后、命令执行之前，对默认命令（TUI）和 `serve` 调用上面两个函数。提示放进 `StartupNoticeBuffer`（`bin.ts:571`），TUI 里显示在启动提示中，`serve` 打印到 stderr。`run` 和 `update` 不调用。
- 提示文字示例：`ohbaby 0.1.20 已发布（当前 0.1.19），运行 ohbaby update 升级。`

**完成定义**：04 的 U1–U3、I1 通过；真机项 R5 通过。

### Stage 2：升级前检查（共用模块）与 daemon 接口

**目标**：一个函数回答"现在能不能升级或卸载"，能就停掉 daemon，不能就说清楚为什么。

**改动**：

- `ohbaby-server` 在 `protocols/web/routes/system.ts` 新增认证接口 `POST /api/shutdown/idle`，升级和卸载复用。现有 `POST /api/shutdown` 继续用于显式 `serve stop`。
  - 请求带上预检锁定的实例 `pidToken`，daemon 在动任务入口前核对自己的 token，不匹配就拒绝。身份最终观察也绑定原实例，避免复用端口和认证 token 时停到刚启动的新实例。
  - daemon 在 REST 和 RPC 的任务入口暂时拒绝新任务和 PTY 创建，等已经接收的提交和创建请求完成，再检查活跃工作。这个入口可以恢复。等待已提交任务状态的长轮询无需排空。服务器范围内只允许一次仅空闲停机检查。复用 `getActivityReasons()`，检查所有已加载 workspace，把仍在创建后端的 workspace 纳入同一次检查。任何工作区的活跃运行、后台作业、清理或已接收且待执行的持久提交都算忙。已打开的 Web PTY 也算忙，提示用户先关闭终端，避免停机结束用户在终端中运行的命令。按原计划补查可见的、存活 owner 的共享账本回合。有活跃工作就恢复任务接收，返回 409 和忙碌原因，有可用标识时带上会话或任务标识。检查失败、超时或取消且尚未启动停机时，也要恢复任务接收。
  - 空闲时保持任务入口关闭，返回停机已接收，随后走现有停止流程。使用现有任务入口和注册表。最终确认空闲后才调用会取消工具的 `closeAdmission()`。独立 TUI 仍按现有平台策略运行，这个入口只控制 daemon 的任务接收。
- `packages/ohbaby-cli/src/update/preflight.ts` 提供 `runUpgradePreflight({ installMethod, platform })`，返回 `{ ok: true, stoppedDaemon: boolean }` 或 `{ ok: false, reasons: [...] }`：
  1. 按 daemon 的路径规则核对 `daemon.pid`、状态文件和目标身份并保留目标 PID 和 token。活锁但状态尚未发布、读失败、身份不符或无法确认进程存活时，中止并给出原因。
  2. Windows 且为 npm 安装时检查其他 ohbaby 进程，保留原有父进程链排除规则，只排除已核实身份的待停 daemon。其他 ohbaby 进程可能占用安装目录时，中止并列出进程。
  3. 有可验证的运行实例时，通过 `stopDaemonFromState` 复用目标身份核对、退出等待和报告读取，停机请求改用仅空闲入口。任何阶段发现拿到的是另一实例就中止。409 提示等任务结束后重试。旧版返回 404 时，提示用户确认空闲后手动 `ohbaby serve stop`，本次中止。以上两种明确拒绝直接返回，传输结果不明时仍按现有规则观察目标进程。
  4. 确认当前没有待处理实例才放行。目标进程必须确实退出，且需要确认本次停止结果时，报告的 PID 和 token 必须匹配、清理必须是 confirmed。CLI 升级阶段扩展现有报告读取，复用同一匹配规则处理调用前已经退出的已知实例。立即重试也适用，`not-running` 本身无法证明清理完成。真正没有锁和状态的初始环境可继续。遗留异常状态或报告缺失时，提示现有 serve 日志目录或可定位的日志路径。可以启动时，提示用户重新启动并正常停止一次，建立可验证的停机记录后再试。
  5. 真正调用安装器或开始卸载前，按相同路径再看一次锁和身份。发现新锁、换代或读取不明时中止。最后一查后用户仍可能手动启动服务，升级时需保持 daemon 停止。
  6. 只有本次确实发起停止且退出和清理均已确认时，`stoppedDaemon` 才为 true。其余中止分支均不得调用安装器或卸载删除步骤。
- 本模块不打开数据库，也不导入会打开数据库的代码，这样数据库比程序新时 update 和 uninstall 仍然能用。
- 注意 `runOhbabyCli` 在 yargs 分派前会动态导入整个 agent 运行时（`bin.ts:309-313` 的 `loadDefaultDependencies`）。导入本身不加载原生模块（node-pty、koffi 都是用到时才加载，探针 P2 已在 Windows 上证实），可以保留；但 update 和 uninstall 的执行路径不得调用 `buildCoreAPIImpl`，也不得调用 `initDatabase`。

**完成定义**：04 的 U4–U6、U12、I2、I3、I11 通过。

### Stage 3：自动升级开关

**目标**：用户打开开关后，启动 TUI 时自动完成升级。

**改动**：

- 新增 `packages/ohbaby-cli/src/update/settings.ts`：读写 `<OHBABY_HOME>/update/settings.json`，只有 `autoUpdate` 一个字段，默认 `false`。
- `ohbaby update --auto on|off`：只改设置，不升级。
- `bin.ts` 启动 TUI 前：`autoUpdate` 为 `true`、`readUpdateNotice` 有结果、并且没设 `OHBABY_NO_UPDATE_CHECK` 时，调用 Stage 4 的升级流程（跳过确认）。成功 → 打印"已自动升级到 x，请重新运行 ohbaby"，退出码 0。失败时按安装器有没有动过文件分两种处理：
  - 照常启动 TUI（打印原因）：升级前检查未通过；脚本安装的 `install.sh` / `install.ps1` 没下载下来；脚本安装失败，但 `current` 读出来仍等于正在运行的版本（脚本先装进 `.partial`，最后才切换指针，指针没变说明旧版完好）。
  - 打印当前状态后以非零码退出，不加载 TUI：npm 安装命令已经运行后失败（非零退出，或 `--version` 不等于目标版本），因为 CLI 分不清 npm 是否已开始替换文件；脚本的 `current` 已切换，或读不到、读不准。提示重新运行或按 Stage 4 恢复，并写明可以先运行 `ohbaby update --auto off` 关闭自动升级，避免每次启动都重试失败。不为此另存失败记录。
- Stage 1 的提示里加一句：`运行 ohbaby update --auto on 可以开启自动升级。`只在 `autoUpdate` 为 `false` 时加。
- `serve` 启动时不自动升级，开关打开也只提示（00 第 5 节）。

**完成定义**：04 的 U7、I6 通过。

### Stage 4：`ohbaby update` 命令

**目标**：一条命令完成升级。

**前提**：04 的实施前探针 P1、P2 已于 2026-11-18 完成，两项都符合预期，本 Stage 方案不变（结果见 04 的 4.4 节）。有两点要在实现里守住：

- update 的执行路径不能加载原生模块。P1 里加载了 koffi 和 node-pty 的进程照样能升级成功，但 npm 删不掉旧的 `koffi.node`，在 `<前缀>\node_modules` 下留下一个 `.ohbaby-cli-XXXX` 残留目录。I10 守住这一点。
- 其他 ohbaby 进程同样会占着原生模块，所以 Windows npm 安装仍要先停 daemon、检查其他进程（Stage 2），不能因为"升级能成功"就去掉。

**改动**：

- 新增 `packages/ohbaby-cli/src/cli/commands/update.ts`，在 `bin.ts:712-726` 的 yargs 链上注册：`ohbaby update [version]`，参数 `-y`（跳过确认）、`--auto on|off`。
- 流程：
  1. 调用 `runtime.initializeProxy()`（见 Stage 1）。
  2. `detectInstallMethod()`。`other` → 打印"无法识别安装方式，请用你安装时的包管理器升级"，附 npm 命令作参考，退出码 1。
  3. 目标版本：参数给了就用它，否则查 registry 的 `latest`（复用 Stage 1 的请求函数，并顺便更新缓存）。和当前版本相同 → "已是最新版本"，退出码 0。
  4. 确认：打印"将从 a 升级到 b，安装方式 x"，非 `-y` 时等待回车确认（非 TTY 时视为需要 `-y`，直接退出并提示）。
  5. `runUpgradePreflight()`；不通过就打印原因，退出码 1。
  6. 执行：
     - npm：优先用 `<前缀>/bin/npm`（Windows `<前缀>\npm.cmd`），找不到再用 PATH 上的 npm，执行 `npm install -g --prefix <前缀> ohbaby-cli@<版本>`，输出直接给用户看。
     - 脚本安装：下载 `https://cdn.jsdelivr.net/npm/ohbaby-cli@<版本>/install.sh`（Windows 为 `install.ps1`）到临时文件，带上 `OHBABY_INSTALL_VERSION=<版本>`、`OHBABY_INSTALL_DIR=<当前安装目录>`、`OHBABY_NON_INTERACTIVE=1` 运行：Unix 用 `sh <临时文件>`，Windows 用 `powershell -NoProfile -ExecutionPolicy Bypass -File <临时文件>`。
  7. 确认结果：npm 安装运行 `<前缀>/bin/ohbaby --version`（Windows `<前缀>\ohbaby.cmd`），输出必须等于目标版本；脚本安装不论退出码都读 `current`，区分未切换、已切换但有后续失败、状态无法确认。
  8. 打印"已升级到 b"；`stoppedDaemon` 为真时加一句"daemon 已停止，需要时重新运行 ohbaby serve"；Windows npm 安装加一句"如果看到'找不到批处理文件'，可以忽略"（同脚本安装议题 00 的 5.4 节）。
- 失败时打印退出码和失败步骤。脚本已切换但有后续失败时，用非零退出，明确版本已切换，提示重开终端。PATH 等后续步骤失败时，提示用户用同一目标版本的安装脚本重跑，`ohbaby update` 遇到同版本会直接退出。npm 替换可能留下一半的安装，提示用原安装方式修复。

**完成定义**：04 的 U8、I4、I5、I7、I10 通过；真机项 R1–R4 通过。

### Stage 5：数据库版本保护

**目标**：旧程序遇到新数据库时拒绝启动，并告诉用户怎么办。

**改动**：

- `packages/ohbaby-agent/src/services/database/index.ts` 的 `runMigrations`：`ensureMigrationTable` 之后、`prepareOfflineMigration` 之前，查出 `migration` 表的全部版本，减去本程序 `migrations` 里的版本；结果不为空 → 抛新的 `DatabaseNewerThanProgramError`（`code = "DATABASE_NEWER_THAN_PROGRAM"`），消息里带不认识的版本号，并提示"这个数据库被更新版本的 ohbaby 用过，请运行 ohbaby update"。
- 在 `packages/ohbaby-agent/src/index.ts` 里从 `./services/database/index.js` 导出它（和 `DatabaseShutdownError` 放在一起）。注意现在的 `DatabaseUpgradeBlockedError` 并没有从包导出，不能照抄。
- CLI 的顶层错误处理按 `code === "DATABASE_NEWER_THAN_PROGRAM"` 判断，不用 `instanceof`，避免跨包的类不是同一个；只打印消息，不打印堆栈，退出码 1。
- 在数据库模块的设计文档里写明迁移的开发约定：迁移只能追加，已发布的迁移不能改名、不能删除（02 的 D3）。

**完成定义**：04 的 U9、U10、I8 通过。

### Stage 6：Web 自动刷新

**目标**：daemon 重启后，开着的 Web 页面自动刷新。

**改动**：

- `apps/ohbaby-web/src/api/daemon/client-sync.ts:221-224`：收到 `DaemonEventsRejectedError`、把状态设为 `"restarted"` 时，检查 `sessionStorage` 里上次自动刷新的时间；超过 30 秒（或没有记录）就记下当前时间并调用 `location.reload()`；否则保持现在的提示和手动"刷新"按钮。
- `sessionStorage` 读写放在 try/catch 里，读写失败时不自动刷新，退回手动按钮。
- 输入框草稿已经存在本地（`ui/composer/draft-storage.ts`），刷新不会丢。

**完成定义**：04 的 U11、I9 通过。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-cli/src/update/` | `version-check.ts`、`preflight.ts`、`settings.ts` | — | — | 新目录 |
| `packages/ohbaby-cli/src/cli/commands/` | `update.ts` | — | — | |
| `packages/ohbaby-cli/src/bin.ts` | — | 注册命令；启动时接入检查和自动升级；新错误码的处理 | — | |
| `packages/ohbaby-server/src/protocols/web/routes/` 与 daemon 运行时 | 仅空闲时停止 | `system.ts`、`stop.ts` 和任务接收与停机前检查 | — | 复用任务入口、回合账本和后台作业注册表 |
| `packages/ohbaby-agent/src/services/database/` | — | `index.ts` 加反向检查和错误类型 | — | |
| `apps/ohbaby-web/src/api/daemon/` | — | `client-sync.ts` 自动刷新 | — | |
| `tests/integration/cli/` | 升级集成测试 | — | — | 复用打包冒烟测试的本地 registry |
| `docs/cli/` | — | `architecture.md`、`goals-duty.md` 补 update 和版本检查 | — | 见 D2 |

`ohbaby-sdk`、`ohbaby-llm` 不改。

## 2.5 接口、协议与兼容

**新增 HTTP 接口**为认证的 `POST /api/shutdown/idle`。200 表示已接收停机请求，409 表示有活跃工作或另一停机检查正在进行，并附带可展示的原因，旧版 daemon 返回 404。CLI 仍独立观察退出与清理结果。

**新增文件**：

| 文件 | 格式 | 谁写 | 谁读 |
|---|---|---|---|
| `<OHBABY_HOME>/update/check.json` | `{ "checkedAt": <毫秒时间戳>, "latestVersion": "<版本>" }` | 后台检查、`ohbaby update` | 启动时的提示 |
| `<OHBABY_HOME>/update/settings.json` | `{ "autoUpdate": <布尔> }` | `ohbaby update --auto` | 启动 TUI 时 |

**新增环境变量**：`OHBABY_NO_UPDATE_CHECK=1`。

**新增错误码**：`DATABASE_NEWER_THAN_PROGRAM`。

**兼容**：

- 新程序遇到旧数据库：照常迁移，和现在一样。
- 旧程序（不含 Stage 5 的版本）遇到新数据库：仍然不会拒绝。保护只对包含 Stage 5 的版本之后的降级有效。
- 旧 daemon 不支持仅空闲停机入口时，提示用户手动确认空闲并停止。再次执行升级时，读取前置议题支持的旧格式停机报告。
- 旧 Web 页面遇到新 daemon：旧页面没有自动刷新逻辑，仍是手动按钮；刷新一次之后就是新逻辑。

**App 预留约束**（00 第 2 节，只写在文档里）：升级只停止 `daemon-state.json` 里记录的、由 npm 版 CLI 启动的 daemon，不能停止 App 自己的后端。App 适配时要保证两者的状态文件不混用。

## 2.6 风险与回滚

| 风险 | 触发场景 | 应对 |
|---|---|---|
| 版本检查拖慢启动或导致不能退出 | 网络慢、DNS 卡住 | 后台执行、3 秒超时、`unref`；I1 验证断网时启动时间不变 |
| 停 daemon 打断任务 | 空闲检查时刚好有新提交，或活跃回合已经结束但后台作业还在运行 | daemon 在同一次请求中保护任务入口并作最终判断，拒绝时恢复接收。I2、I11 覆盖 |
| npm 安装升级到一半失败 | 网络中断、文件占用 | 打印原因，提示重试；Windows 先检查其他进程 |
| npm 留下 `.ohbaby-cli-XXXX` 残留目录 | Windows 上升级时还有进程加载着旧版本的原生模块（探针 P1） | 升级本身成功，残留只占空间；Stage 2 的进程检查让这种情况很少出现。本轮不自动清理 |
| 数据库保护误拦 | 有人改名或删除了已发布的迁移 | 写进迁移约定（D3）；U10 检查历史迁移全部保留 |
| 自动刷新死循环 | daemon 反复重启 | 30 秒内只自动刷新一次 |
| 自动升级让用户意外多等 | 开关打开后启动时升级 | 默认关闭；升级前打印"正在自动升级到 x" |

**回滚**：

- 版本检查和自动升级可以用 `OHBABY_NO_UPDATE_CHECK=1` 关掉。
- `update` 命令是新增的，有问题时发补丁版本即可。
- 数据库保护如果误拦，用户可以升级到最新版本解决；发补丁时不能删除保护本身，只能修正判断条件。
- Web 自动刷新有问题时，发补丁去掉自动刷新，恢复手动按钮。

## 2.7 与 00 的对齐检查

| 00 中的决定 | 本文位置 |
|---|---|
| 先 npm 版 CLI 升级，后 App | 2.8 |
| 升级入口只有 `ohbaby update` | Stage 4 |
| 自动升级可选、默认关闭、默认只提示 | Stage 1、Stage 3 |
| 启动读缓存、后台刷新 | Stage 1 |
| 升级前检查任务、再停 daemon | Stage 2 |
| 数据库版本保护 | Stage 5 |
| Windows 检查其他 ohbaby 进程 | Stage 2 第 2 步 |
| daemon 重启后 Web 自动刷新 | Stage 6（触发条件按 01 的 1.5 节调整） |
| App 只写约束 | 2.5 |
| 命令名 `update`，不加 `upgrade` 别名 | Stage 4 |
| 按安装方式分支 | Stage 4 第 6 步 |

## 2.8 不在本轮

- App 的更新（App 适配议题）。
- 远程强制最低版本、灰度。
- TUI、Web 里的升级按钮。
- 升级后自动重启 daemon、自动重新启动 TUI。
- 跳过某个版本、更新日志展示。
- 同版本多进程共用数据库的规则（多进程会话占用议题）。

## 2.9 关键改动清单

> 行号是 `bc0d4cc1` 时的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码（新增） | `packages/ohbaby-cli/src/cli/commands/update.ts` | `createUpdateCommand` | — | Stage 4 | 升级主流程 |
| C2 | 代码（新增） | `packages/ohbaby-cli/src/update/preflight.ts` | `runUpgradePreflight` | — | Stage 2 | update 和 uninstall 共用，决定会不会打断任务 |
| C3 | 代码（新增） | `packages/ohbaby-cli/src/update/version-check.ts` | `readUpdateNotice`、`refreshVersionCacheInBackground` | — | Stage 1 | 每次启动都会运行 |
| C4 | 代码 | `packages/ohbaby-cli/src/bin.ts` | yargs 链；`initializeProxy` 之后的启动流程 | L571、L617–633、L712–726 | 注册 update；接入检查、提示和自动升级 | 启动路径 |
| C5 | 代码 | `packages/ohbaby-server/src/protocols/web/routes/system.ts` 与 daemon 运行时 | `registerSystemRoutes`、`stopDaemonFromState` | L7–31 | 增加仅空闲时停止的入口，复用统一的停止观察 | 任务检查和停止在同一请求内完成 |
| C6 | 代码 | `packages/ohbaby-agent/src/services/database/index.ts`、`packages/ohbaby-agent/src/index.ts` | `runMigrations`；包导出 | L249–262；index.ts L217 附近 | 反向检查，新错误类型并从包导出 | 不可逆的约束 |
| C7 | 代码 | `apps/ohbaby-web/src/api/daemon/client-sync.ts` | `onError` 里的 `DaemonEventsRejectedError` 分支 | L221–224 | 自动刷新 | Web 体验 |
| D1 | 文档 | `README.md`、`README.zh.md`、`packages/ohbaby-cli/README.md` | Install 一节 | 约 L35–41 | 写 `ohbaby update`、`--auto`、`OHBABY_NO_UPDATE_CHECK` | 用户唯一的说明 |
| D2 | 文档 | `docs/cli/architecture.md`、`docs/cli/goals-duty.md` | 命令列表 | — | 补上 update 和版本检查 | CLI 模块的权威设计文档 |
| D3 | 文档 | `docs/services/database/architecture.md` | 迁移约定 | — | 迁移只能追加，不能改名或删除 | Stage 5 的前提 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-cli/src/cli/commands/types.ts`：命令运行时需要的依赖（版本、代理初始化）可能要加字段。
- `packages/ohbaby-server/src/protocols/web/routes/context.ts`：路由上下文加上 RunLedger。
- `apps/ohbaby-web/src/ui/shell/ConnectionOverlay.tsx`：手动刷新按钮保留，文字不变。
- `docs/releases/`：下一版发布说明写 update 命令。
