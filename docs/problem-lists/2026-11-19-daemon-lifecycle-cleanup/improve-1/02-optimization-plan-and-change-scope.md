# 02 方案与改动面

> 本文是实施会话的依据，验收对照 [04](04-test-and-acceptance.md)。决定来源见 [00](00-discussion.md)，问题编号 P1–P4 见 [01](01-problem-analysis-and-current-state.md)。

## 2.1 方案总览

本议题先经用户审阅定稿，再实施并按 [04](04-test-and-acceptance.md) 验收，结果记入 05。验收通过后再实施 CLI 升级和脚本安装。保留 `ohbaby serve` 前台运行和现有显式 stop 行为。

daemon 的状态目录只由 daemon 自己清理，清理时机放在它持有 pid 锁、独占这个目录的时候。改完后，目录里正常情况下最多只有三个文件：

```
<OHBABY_HOME>/server/
├── daemon.pid            运行中才有
├── daemon-state.json     最后状态
└── daemon-shutdown.json  最近一次停止的清理报告（覆盖写）
```

改动后的启动和停止：

```
启动：拿到 pid 锁
        → 读旧 daemon-state.json，是 running/stopping 就记 server.previous_run.unclean   (C)
        → 删除旧格式报告和 .tmp，失败只记警告                                          (B1)
        → bootstrap → 写 running（照旧）

停止：写入最终状态 → 关闭日志 → 释放 pid 锁 → 覆盖写 daemon-shutdown.json                  (A)
      总时限到达时仍有状态写入未结束 → 保留锁，按停机失败收尾

serve stop：目标进程退出后
        → 读 daemon-shutdown.json，pid/token 对得上就采用
        → 否则读旧文件名 daemon-state.json.shutdown-<token>.json（兼容旧版 daemon）     (A)
        → 都没有 → cleanup unknown（照旧）
```

## 2.2 设计决策

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 报告文件名（P1） | 固定的 `daemon-shutdown.json`，覆盖写（00 第 3.1 节） | 区分新旧报告的 token 已在内容里；参考 codex 的固定 shutdown 标记 | 按 token 命名再加删除；并进 `daemon-state.json` | 极端情况下旧 stop 读到被覆盖的报告，显示"未确认" |
| 兼容旧版 daemon | stop 读不到匹配的新报告时，再读旧文件名一次 | 升级时新 CLI 要停旧版 daemon | 不兼容 | 多一次读取；以后要记得删这段 |
| 报告写入方式 | 照旧直接 `writeFile` | stop 只在目标进程退出后读；读到半截按"未确认"处理 | 临时文件加改名 | 无 |
| 清理时机（P1、P2） | daemon 拿到 pid 锁之后、bootstrap 之前（00 第 3.2 节） | 持有锁时只有自己会写这个目录 | stop 读完就删；安装脚本清理 | 清理要等下次启动 daemon |
| 清理失败 | 记 `warn`，不挡启动 | 残留文件不影响功能 | 启动失败 | 无 |
| 写状态失败（P2） | 删掉自己的 `.tmp` 再抛原错误 | 谁创建谁删 | 只靠启动清扫 | 无 |
| 异常退出记录（P3） | 读旧状态，`running`/`stopping` 记 `server.previous_run.unclean`（00 第 3.3 节） | 持有锁就说明旧进程已不在，不用再查存活 | 改 `FilePidFile` 让它报告删过过期锁 | 旧 daemon 最终状态写超时（停在 `stopping`）也会被记一次，这本来也是没停干净 |
| serve-awareness 目录（P4） | 改用 `resolveOhbabyHome()`（00 第 3.4 节） | 和 daemon 一致 | 合并解析代码 | 解析代码仍有两份，这是 C1 边界要求的 |

没有不可逆决策：文件名改动有兼容读取；新事件只是多一条日志。

## 2.3 分阶段实施

三个 Stage 都在本轮内。Stage 1 和 Stage 2 都改 `state-file.ts`，按顺序做；Stage 3 和前两个互不相干。

### Stage 1：固定报告文件名、安全写状态与停止（A、B2）

**目标**：每次停止不再新增文件；写状态出错不留 `.tmp`；`serve stop` 能停新旧两种 daemon 并拿到清理结果。

**改动**：

- `packages/ohbaby-server/src/runtime/daemon/state-file.ts`
  - `shutdownReportPath(statePath)` 改为返回 `join(dirname(statePath), "daemon-shutdown.json")`，去掉 `token` 参数。
  - 新增 `legacyShutdownReportPath(statePath, token)`，返回原来的 `${statePath}.shutdown-${encodeURIComponent(token)}.json`，只给 stop 兼容读取用。
  - `writeShutdownReport` 改写固定路径，写法不变（直接 `writeFile`，`0o600`）。
  - `write()`：临时文件名改为 `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`，每次写都唯一。`writeFile` 或 `rename` 抛错时，`unlink(tempPath)`（忽略 `ENOENT` 和删除本身的错误），再抛出原来的错误。
  - 为什么要唯一：停止时 `stopping` 写入超时后，底层写入还在跑，随后又写最终状态（`supervisor.ts:199-218`）。两次写如果共用一个临时文件，一次失败去删，可能删掉另一次刚写好的。改名后清扫规则不变。
- `Supervisor.stopInternal()` 按顺序发布 `stopping` 和最终状态。运行时清理仍可和写 `stopping` 并行。如果先前的状态写入错过截止时间，必须等底层操作结束后才能开始下一次状态写入。总时限到达时如果还有可能落盘的状态写入，跳过后续状态发布和锁释放，按停机失败收尾。该分支不发布停机报告，观察方在进程退出后返回清理未知。显式停机路径以失败退出，下一次启动确认旧进程已退出后再接管锁。
- `packages/ohbaby-server/src/runtime/daemon/stop.ts`
  - `confirmed()` 先读 `shutdownReportPath(statePath)`；文件不存在、解析失败，或 `pid`/`pidToken` 和目标对不上，再读 `legacyShutdownReportPath(statePath, target.token)`。两次用同一套校验。都不行时 `cleanup` 为 `unknown`，和现在一样。
  - 抽一个小函数做"读文件 + 校验"，两次调用复用。
- 测试：`stop.unit.test.ts` 改写现有"别的 token 的报告"用例，并加上 04 的 U2；`state-file.unit.test.ts` 加 U1、U3。

**完成定义**：04 的 U1–U3、U8 通过。improve-4 的 T16、T42 相关测试照常通过。

### Stage 2：安全接管过期锁、启动清扫与异常退出记录（B1、C）

**目标**：daemon 启动时自动清掉旧残留；上次没有正常退出时，本次日志里有记录。

**改动**：

- `FilePidFile` 保留首次启动时的独占创建。自动接管只用于字段完整、PID 为正整数且平台确认进程不存在的锁。权限不足或探测失败时保留锁。用一个短时接管锁将恢复串行化，在其中重读记录并确认仍然过期，再删除并尝试独占创建。普通启动若先创建成功，接管方退出。独占创建到写完 PID 记录之间可能短暂读到空文件或半截 JSON。普通抢锁和过期接管都只作一次短暂等待后重读，读到有效活锁时按已有实例处理。仍无法解析、无法读取、身份不明或接管锁被占用时，报错并提示锁路径。若接管锁被遗留，由用户先确认相关进程已退出且没有并发启动，再移除该接管锁。
- `packages/ohbaby-server/src/runtime/daemon/types.ts`：`DaemonStateFile` 加可选方法 `removeStaleFiles?(): Promise<void>`。可选是为了不影响测试里注入的假实现，和 `read?`、`writeShutdownReport?` 的写法一致。
- `packages/ohbaby-server/src/runtime/daemon/state-file.ts`：`JsonDaemonStateFile.removeStaleFiles()`
  - `readdir(dirname(this.path))`，目录不存在直接返回。
  - 只删两类文件名（`base` 是状态文件名，即 `daemon-state.json`）：以 `${base}.shutdown-` 开头、以 `.json` 结尾的；以 `${base}.` 开头、以 `.tmp` 结尾的。其他文件一律不碰，包括 `daemon-state.json`、`daemon-shutdown.json`、`daemon.pid`。
  - 每个文件单独删，`ENOENT` 忽略；其他错误先收集，全部删完后合成一个错误抛出。
- `packages/ohbaby-agent/src/observability/logger.ts`：`DIAGNOSTIC_ENUM_VALUES`（L147-178）加入 `"running"`、`"stopping"`。`diagnosticField.stringEnum` 会在模块加载时检查每个取值是否在这个白名单里，不在就抛 `diagnostic enum values must be static labels`（L486-497）。不加的话，`ohbaby-agent` 一加载就会崩。
- `packages/ohbaby-agent/src/observability/events.ts` 新增两个事件，并在 `index.ts` 导出：
  - `serverPreviousRunUnclean`：`component: "server"`，`event: "server.previous_run.unclean"`，`level: "warn"`，字段 `previousPid: integer()`、`previousStatus: stringEnum(["running", "stopping"])`、`previousStartedAt: optional(integer())`、`previousUpdatedAt: integer()`。
  - `serverStateFilesCleanupFailed`：`component: "server"`，`event: "server.state_files.cleanup.failed"`，`level: "warn"`，字段 `error: externalError()`，写法参考 `sessionFilesCleanupFailed`。
- `packages/ohbaby-server/src/runtime/daemon/supervisor.ts` 的 `start()`：在 `this.pidLock = await this.pidFile.acquire()` 之后、`this.startedAt = this.now()` 之前，依次调用两个私有方法：
  1. `recordPreviousRun()`：`stateFile.read?.()`；读到的状态是 `running` 或 `stopping`，并且有 `pid`，就用 `emitDiagnosticSafely` 写 `serverPreviousRunUnclean`。读取抛错时什么也不做。这个方法不抛错。该事件只说明旧记录停在 `running` 或 `stopping`。旧记录如果已经写成 `stopped`，日志、锁释放或停机报告仍可能未完成。是否清理成功由匹配报告判定。
  2. `removeStaleStateFiles()`：调用 `stateFile.removeStaleFiles?.()`；抛错时写 `serverStateFilesCleanupFailed`。这个方法不抛错。
  - 两步都在 `acquire()` 成功之后。`acquire()` 抛 `DaemonAlreadyRunningError` 时一步都不执行。
  - 正常停止保留原有收尾顺序。Stage 1 的超时约束保护启动清扫后的状态。
- 测试：`state-file.unit.test.ts` 加 U4；`supervisor.unit.test.ts` 加 U5、U6；集成测试 I1、I2。

**完成定义**：04 的 U4–U6、I1–I3 通过。

### Stage 3：serve-awareness 目录与文档同步（D）

**目标**：设置 `OHBABY_HOME` 时，TUI 启动提示读的是 daemon 实际使用的状态文件；两个升级议题的文档指向本议题。

**改动**：

- `packages/ohbaby-cli/src/serve-awareness.ts` L75-79：`serverDirectory` 改为 `join(resolveOhbabyHome({ homeDirectory: options.homeDirectory, environment: options.environment }), "server")`，`resolveOhbabyHome` 从 `ohbaby-agent` 导入。去掉不再用的 `homedir` 导入。解析代码不动。
- `ReadServeCoexistenceNoticeOptions` 加可选的 `environment`，默认 `process.env`，方便测试注入 `OHBABY_HOME`。注意 `resolveOhbabyHome` 的规则：传了 `homeDirectory` 就不再看 `OHBABY_HOME`（`packages/ohbaby-agent/src/paths/ohbaby-home.ts:52-54`）。生产调用方不传 `homeDirectory`，所以会跟随 `OHBABY_HOME`。
- 测试：`serve-awareness.unit.test.ts` 加 U7。
- 文档：规划期（2026-11-19）已同步，实施时不用再改：
  - [脚本安装 02](../../2026-11-17-script-install/improve-1/02-optimization-plan-and-change-scope.md)：Stage 1 里 `serve-awareness` 那一条、完成定义里的 U4、改动清单 C5，已标为"移到本议题"。
  - [脚本安装 04](../../2026-11-17-script-install/improve-1/04-test-and-acceptance.md)：U4 同样处理。
  - [CLI 升级 README](../../2026-11-16-cli-upgrade/README.md)、[脚本安装 README](../../2026-11-17-script-install/README.md)："相关议题"里已加上本议题，写明是前置议题。

**完成定义**：04 的 U7 通过。

## 2.4 按包和目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-server/src/runtime/daemon/` | `legacyShutdownReportPath`、`removeStaleFiles` | `state-file.ts`、`stop.ts`、`supervisor.ts`、`pid-file.ts`、`types.ts` 和对应测试 | 无 | 主体 |
| `packages/ohbaby-agent/src/observability/` | 两个事件 | `index.ts` 导出；`logger.ts` 枚举白名单 | 无 | |
| `packages/ohbaby-cli/src/` | 无 | `serve-awareness.ts` 和测试 | 无 | |
| `docs/problem-lists/` | 无 | 脚本安装 02、04；两个 README | 无 | 规划期已同步 |

## 2.5 接口、迁移与兼容

**文件格式**：`daemon-state.json` 的位置和字段不变，安装脚本和 `ohbaby update` 不受影响。`DaemonShutdownReport` 的字段不变，只换文件名。

**导出函数**：`shutdownReportPath` 去掉 `token` 参数。仓库里只有 `state-file.ts` 自己（L74）、`stop.ts` 和 `stop.unit.test.ts` 用它，一起改。`stopDaemonFromState` 的参数和返回值不变，CLI 升级议题照常调用。

**新旧版本搭配**：

| CLI | daemon | `serve stop` 的清理结果 |
|---|---|---|
| 新 | 新 | 读 `daemon-shutdown.json`，正常 |
| 新 | 旧 | 读旧文件名，正常 |
| 旧 | 新 | 找不到旧文件名，显示"清理结果未确认"，退出码 1。降级不在本议题范围 |

**已有残留**：不另写迁移。升级后第一次启动 daemon 时，`removeStaleFiles` 会把旧报告和 `.tmp` 一次清掉。

**何时删兼容读取**：等旧版 daemon 基本没人用了再删 `legacyShutdownReportPath`，到时另开议题。本轮不定具体版本。

## 2.6 风险与回滚

| 风险 | 触发条件 | 应对 |
|---|---|---|
| 两次启动同时接管过期锁 | 两者都读到同一条过期记录 | 串行接管并重读。I3 验证只有一个实例启动，U6 验证失败方跳过清扫 |
| 迟到写入覆盖新状态 | 等待超时但底层写入继续 | U8 验证超时仍在写时保留锁，旧实例交出锁后无法再发布状态 |
| 匹配规则太宽，删了不该删的文件 | 前后缀写错 | 只认两种固定前后缀；U4 放入 `daemon-state.json.bak` 等干扰文件 |
| 兼容读取采用了错误的报告 | 旧文件名的报告属于别的 token | 两次读取用同一套 pid/token 校验；U2 覆盖 |
| 启动变慢 | 目录里文件很多 | 只 `readdir` 一个小目录；本机最多一次删 70 个文件 |
| 旧 stop 读到被覆盖的报告 | 旧 daemon 退出后、stop 读报告前，新 daemon 完成一整轮启停，或旧实例释放锁后迟到的报告覆盖新报告 | 显示"未确认"，不误报成功；00 第 3.1 节已接受 |
| 新 daemon 启动清扫删掉旧 stop 还没读的旧格式报告 | 新 CLI 停旧 daemon 的同时，又有新 daemon 拿到锁 | 返回清理未知，升级按前置检查处理 |
| 新增的事件枚举值不在白名单里 | 忘了改 `logger.ts` 的 `DIAGNOSTIC_ENUM_VALUES` | `ohbaby-agent` 加载时就抛错，所有进程起不来。Stage 2 先改白名单；U5 断言事件定义能正常加载 |

`serve stop` 在观察到目标进程退出后才读报告。调度和文件读取都可能延迟，报告缺失或实例不匹配时统一返回清理未知。[CLI 升级前检查](../../2026-11-16-cli-upgrade/improve-1/02-optimization-plan-and-change-scope.md#stage-2升级前检查共用模块与-daemon-接口)明确如何处理这一结果。

**回滚**：三个 Stage 都可以单独回退。回退 Stage 1 后，新 daemon 写的 `daemon-shutdown.json` 会留一个文件，不影响旧代码。回退 Stage 2 只是不再清扫、不再记日志。

## 2.7 与 00 的对齐

| 00 的决定 | 落在 |
|---|---|
| 3.1 固定文件名、覆盖写、内容核对、兼容旧版 daemon | Stage 1 |
| 3.2 B1 启动清扫、失败只记警告；B2 写失败删 `.tmp`；不清扫旧的按项目存放的目录 | Stage 2（B1）、Stage 1（B2） |
| 3.3 记录上次异常退出 | Stage 2 |
| 3.4 serve-awareness 目录、文档同步 | Stage 3 |
| 第 4 节 不做的事 | 2.8 节 |

## 2.8 不在本轮

| 项 | 说明 |
|---|---|
| TUI 退出日志 | 00 第 4 节 |
| `ohbaby doctor` 等诊断报告命令 | 00 第 4 节 |
| `serve status` 显示上次异常退出 | 00 第 3.3 节 |
| 清扫旧的按项目存放的目录 `<项目>/.ohbaby/server/` | 00 第 3.2 节 |
| 删除旧文件名的兼容读取 | 以后另开议题，见 2.5 节 |

## 2.9 关键改动清单

> 行号是 2026-11-19 `bc0d4cc1` 的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码 | `packages/ohbaby-server/src/runtime/daemon/state-file.ts` | `shutdownReportPath`、`writeShutdownReport` | L66-80 | 固定文件名；新增 `legacyShutdownReportPath` | P1 的根因 |
| C2 | 代码 | 同上 | `JsonDaemonStateFile.write` | L92-100 | 临时文件名每次唯一；失败时删 `.tmp` | P2 |
| C3 | 代码 | 同上 | 新增 `removeStaleFiles` | 类在 L70-101 | 启动清扫的实现，匹配规则决定会不会误删 | P1、P2 的存量 |
| C4 | 代码 | `packages/ohbaby-server/src/runtime/daemon/stop.ts` | `observeDaemonStop` 里的 `confirmed` | L129-156 | 先读新文件名，再兼容读旧文件名 | 升级时新 CLI 停旧 daemon |
| C5 | 代码 | `packages/ohbaby-server/src/runtime/daemon/supervisor.ts` | `start` | L105-142（`acquire` 在 L112） | 拿到锁后记录上次异常退出、清扫 | P3；清扫必须在锁内 |
| C6 | 代码 | `packages/ohbaby-agent/src/observability/events.ts` | 在 `serverStopFailed` 之后 | L151-163 | 新增两个事件 | P3 的日志格式 |
| C6a | 代码 | `packages/ohbaby-agent/src/observability/logger.ts` | `DIAGNOSTIC_ENUM_VALUES` | L147-178 | 加入 `running`、`stopping` | 不加则 `ohbaby-agent` 加载即崩 |
| C7 | 代码 | `packages/ohbaby-cli/src/serve-awareness.ts` | `readServeCoexistenceNotice` | L75-79 | 改用 `resolveOhbabyHome()` | P4 |
| C8 | 代码 | `packages/ohbaby-server/src/runtime/daemon/pid-file.ts` | `FilePidFile.openExclusive` | L124–143 | 串行接管过期锁并重读持有者 | 清扫前必须确实独占目录 |
| C9 | 代码 | `packages/ohbaby-server/src/runtime/daemon/supervisor.ts` | `stopInternal` | L199–246 | 顺序写状态，超时仍在写时保留锁 | 保护下一次启动的状态 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-server/src/runtime/daemon/types.ts`：`DaemonStateFile` 加可选方法。
- `packages/ohbaby-agent/src/observability/index.ts`：导出新事件。
- 脚本安装的 02、04 和两个升级议题的 README：规划期已同步，见 Stage 3。
- 测试：`stop.unit.test.ts`、`state-file.unit.test.ts`、`supervisor.unit.test.ts`、`serve-awareness.unit.test.ts`，以及 `runtime/daemon/` 下新的集成测试。
