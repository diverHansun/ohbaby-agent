# 01 现状与问题分析

> 时间口径：2026-11-19，`main` 分支 `bc0d4cc1`（v0.1.18 之后）。现场数据来自用户本机 `~/.ohbaby/`。行号是这个版本的快照。

## 1.1 问题陈述

| 编号 | 用户看到的现象 | 技术原因 |
|---|---|---|
| P1 | `~/.ohbaby/server/` 下的 `daemon-state.json.shutdown-<token>.json` 越积越多，本机已有 68 个 | 报告文件名里带着每次启动生成的 token，每次停止都写一个新文件，没有代码删除它们 |
| P2 | 同一目录下有 3 个 0 字节的 `daemon-state.json.<pid>.tmp` | 写状态文件用的是"写临时文件再改名"。中途出错或进程被杀，临时文件留下；文件名里的 pid 以后不会再出现，所以不会被覆盖 |
| P3 | 2 次 daemon 异常退出没有留下任何记录 | 进程被强杀时自己来不及写东西；下次启动时代码悄悄删掉过期的 pid 锁，不记日志 |
| P4 | 设置了 `OHBABY_HOME` 时，TUI 启动提示找不到正在运行的 daemon | `serve-awareness.ts` 把目录写死成 `~/.ohbaby/server`，daemon 按 `OHBABY_HOME` 放文件 |

这四个问题都落在 daemon 的状态目录上。CLI 升级、脚本安装两个议题都要读这个目录、停 daemon、看清理结果（见 1.5 节），所以要先修。

## 1.2 已确认的分界

范围和取舍见 [00 讨论](00-discussion.md) 第 2–4 节。要点：只修 P1–P4，不重做 daemon；TUI 退出日志和诊断报告命令不在本轮。

## 1.3 现场数据

2026-11-19 对用户本机的核对：

| 位置 | 观察 |
|---|---|
| `~/.ohbaby/server/` | 72 个文件：`daemon-state.json` 1 个，内容是 `status: stopped`；shutdown 报告 68 个，最早 9 月 29 日，最新 11 月 18 日，抽查内容都是 `cleanup: {status: confirmed, errors: []}`；`.tmp` 3 个，0 字节，日期是 9 月 19 日和 9 月 28 日 |
| `~/.ohbaby/server/daemon.pid` | 不存在。最近一次是正常停止，锁已释放 |
| `~/.ohbaby/logs/serve/` | 26 个日志，最早 11 月 4 日（日志保留 14 天）。24 个以 `server.stopped`、`reason: signal` 结尾；`2026-11-10T13-47-41-235Z-53656-*.jsonl` 和 `2026-11-12T06-33-50-876Z-64370-*.jsonl` 以 `server.started` 结尾，也没有 pid 为 53656 或 64370 的 shutdown 报告 |

可以看出：

- 日志有保留期和轮转，shutdown 报告没有，两者对"留多久"的处理不一致。
- 24 次正常停止都是 `reason: signal`，也就是在终端里按 Ctrl+C。这种停法没有 `serve stop` 来读报告，报告写出来就没人用。
- pid 53656 和 64370 这两次，进程没走到停止流程。

## 1.4 ohbaby-server：daemon 状态目录现状

### 1.4.1 goals-duty

`runtime/daemon/` 负责 daemon 的单实例、状态发布和停止确认。状态目录里的三类文件各有用处：

| 文件 | 谁写 | 谁读 | 用途 |
|---|---|---|---|
| `daemon.pid` | daemon 启动时独占创建（`acquire()` 在 `pid-file.ts:103`，`open(..., "wx")` 在 L127） | 新 daemon 判断是否已有实例；`serve stop` 核对身份 | 单实例锁 |
| `daemon-state.json` | daemon（`supervisor.ts:298` `writeState`） | `serve stop`、`serve status`、TUI 启动提示、以后的安装脚本和 `ohbaby update` | 发布连接信息、版本和最后状态 |
| `daemon-state.json.shutdown-<token>.json` | daemon 停止的最后一步（`supervisor.ts:252-267`） | 只有 `serve stop`（`stop.ts:131-148`） | 告诉 stop 命令清理是否完成 |

现在没有任何代码负责"清理这个目录"。

### 1.4.2 architecture：停止流程的顺序

`Supervisor.stopInternal`（`supervisor.ts:180-273`）的顺序：

```
关闭准入
  → 写状态 stopping
  → 停 runtime
  → 写最终状态 stopped / crashed      ← 最后一次写 daemon-state.json
  → 写 server.stopped / server.stop.failed 日志
  → 关闭日志
  → 释放 pid 锁                        ← 从这里起，新 daemon 可以启动
  → 写 shutdown 报告                   ← 在锁外
```

报告写在锁外是有意的：这样报告能包含"释放锁是否成功"。代价是写报告时新 daemon 可能已经在运行，所以报告不能和新 daemon 共用会被它写的文件。这是 00 第 3.1 节不把报告并进 `daemon-state.json` 的原因。

正常情况下，释放锁之后旧 daemon 只写报告，不再写 `daemon-state.json`。有一个例外：停止时 `stopping` 那次写入如果超时，`withinShutdown`（`packages/ohbaby-agent/src/runtime/shutdown.ts:39-48`）只是用 `Promise.race` 先返回，底层写入还会继续。这次写入和随后写最终状态（`supervisor.ts:199-218`）用的是同一个临时文件名。

### 1.4.3 data-model

`DaemonShutdownReport`（`types.ts:23-28`）：`{ pid, pidToken, recordedAt, cleanup: { status, errors } }`。报告内容本身就带着 pid 和 token。

文件名由 `shutdownReportPath`（`state-file.ts:66-68`）拼出：`${statePath}.shutdown-${encodeURIComponent(token)}.json`。token 是 `randomUUID()`（`pid-file.ts:111`），每次启动都不同。

临时文件名：`${statePath}.${process.pid}.tmp`（`state-file.ts:94`）。同一进程的两次写会用同一个临时文件，见上文。

### 1.4.4 dfd-interface

**写报告**：`JsonDaemonStateFile.writeShutdownReport`（`state-file.ts:73-80`）直接 `writeFile`，没有临时文件。

**读报告**：`observeDaemonStop` 里的 `confirmed()`（`stop.ts:129-156`）在确认目标进程已经退出后，按目标 token 拼文件名读取，再核对 `pid`、`pidToken`、`cleanup` 字段。文件不存在或解析失败，`cleanup` 是 `unknown`。读完不删。

**写状态**：`JsonDaemonStateFile.write`（`state-file.ts:92-100`）：

```ts
const tempPath = `${this.path}.${String(process.pid)}.tmp`;
await writeFile(tempPath, ...);
await rename(tempPath, this.path);
```

`writeFile` 或 `rename` 抛错时，没有删除 `tempPath`。

**启动时处理过期锁**：`FilePidFile.openExclusive`（`pid-file.ts:124-143`）遇到 `EEXIST`，如果记录里的进程已经不在，就删掉旧锁重试，不通知调用方。`Supervisor.start`（`supervisor.ts:105-142`）拿到锁后直接 bootstrap，再写 `running`，不看旧的 `daemon-state.json`。

**日志**：`Supervisor` 有 `logger`（`supervisor.ts:64`）。`runtime/daemon/main.ts:531` 从诊断句柄取出 logger，L614-617 传给 `Supervisor`；没有诊断句柄时是空 logger，什么都不写。现有生命周期事件定义在 `packages/ohbaby-agent/src/observability/events.ts`：`server.started`（L119）、`server.start.failed`（L128）、`server.stopped`（L137，带 `reason`）、`server.stop.failed`（L151）。没有"上次异常退出"这一类事件。

### 1.4.5 use-case

| 场景 | 现在的结果 |
|---|---|
| 终端里 Ctrl+C 停 daemon | 正常停止，多一个没人读的报告文件 |
| `ohbaby serve stop` | 正常停止，stop 读到报告并显示结果，报告文件留下 |
| daemon 被 kill -9 或崩溃 | 状态停在 `running`，pid 锁留下；下次启动悄悄删锁，日志里看不出发生过什么 |
| 写状态时磁盘满或权限错误 | `.tmp` 留下 |
| 新 CLI 停旧版 daemon（升级场景） | 现在两边格式相同，没有问题；改成固定文件名后需要兼容（00 第 3.1 节） |

### 1.4.6 non-functional

- **可观测性**：异常退出完全不可见（P3）。升级出了问题时，这是第一个要查的信息。
- **资源**：每个报告约 136 字节，本身不占空间。问题是目录越来越乱，以后 `ohbaby uninstall` 要清楚这个目录里有哪些文件。
- **安全**：状态文件和报告都是 `0o600`，本议题不改。

### 1.4.7 test

| 现有测试 | 覆盖 | 缺口 |
|---|---|---|
| `stop.unit.test.ts` L65-87 | 只有别的 token 的报告时，`cleanup` 是 `unknown`（对应 improve-4 的 T16） | 测试用 `shutdownReportPath` 拼文件名，改成固定文件名后要改写 |
| `supervisor.unit.test.ts` L573 附近 | 注入的 `writeShutdownReport` 被调用 | 没有验证磁盘上留下几个文件 |
| `state-file.unit.test.ts` | 状态读写、权限 | 没有写失败后 `.tmp` 是否残留的用例 |
| `pid-file.unit.test.ts` L58 | 替换过期锁 | 没有"上次异常退出"的记录 |
| — | — | 没有"多次启停后目录里还剩什么"的测试 |

## 1.5 ohbaby-cli：serve-awareness 现状

`readServeCoexistenceNotice`（`packages/ohbaby-cli/src/serve-awareness.ts:71`）在 TUI 启动时由 `bin.ts:605-609` 调用，读 `daemon.pid` 和 `daemon-state.json`，核对后请求 `/api/health`，版本相同就提示"已有 serve 在运行"。

目录在 L75-79 写死：

```ts
const serverDirectory = join(options.homeDirectory ?? homedir(), ".ohbaby", "server");
```

daemon 用的是 `resolveOhbabyHome()`（`packages/ohbaby-server/src/runtime/daemon/scope.ts:51-56`），会看 `OHBABY_HOME`。

这个文件自己定义了 `DaemonPidRecord`、`DaemonState` 并自己解析，没有从 `ohbaby-server` 导入。这是有意的：`bin.ts:42` 把 `ohbaby-server` 作为按需动态加载的模块，默认 TUI 启动不加载它（server 拆包 C1 阶段定下的边界，见 [docs/ohbaby-server/README.md](../../../ohbaby-server/README.md)）。本议题只改目录，不合并解析代码。

## 1.6 跨模块一致性

| 关系 | 现状 | 对本议题的要求 |
|---|---|---|
| daemon 与 `serve stop` 的报告格式 | 两边都用 `shutdownReportPath` | 改成固定文件名后，stop 要兼容旧版 daemon 写的旧文件名 |
| daemon 与 serve-awareness 的目录 | 不一致（P4） | 统一用 `resolveOhbabyHome()` |
| 与 [CLI 升级](../../2026-11-16-cli-upgrade/README.md) | 升级前检查读 `daemon-state.json` 并调用 `stopDaemonFromState`（那边 02 的 Stage 2） | `stopDaemonFromState` 的接口和返回值不变；升级时它会去停旧版 daemon |
| 与 [脚本安装](../../2026-11-17-script-install/README.md) | 安装脚本按 `OHBABY_HOME` 规则读 `daemon-state.json`；那边 Stage 1 原计划修 P4 | `daemon-state.json` 的位置和格式不变；P4 移到本议题 |
| 与 [执行可靠性 improve-4 §2.5](../../2026-09-19-execution-reliability/improve-4/02-optimization-plan-and-change-scope.md) | 定了"只采用匹配 token 的报告""报告缺失显示未确认""新 daemon 不能让旧 stop 读错报告" | 三条规则继续成立 |

## 1.7 改动影响面

| 包 | 会动到 |
|---|---|
| `packages/ohbaby-server/src/runtime/daemon/` | `state-file.ts`、`stop.ts`、`supervisor.ts`、`types.ts` 及对应测试 |
| `packages/ohbaby-agent/src/observability/` | `events.ts`、`index.ts` 加一个事件 |
| `packages/ohbaby-cli/src/` | `serve-awareness.ts` 及测试 |
| 文档 | 脚本安装议题的 02、04；两个升级议题的 README |

不动：`daemon-state.json` 的位置和格式、`daemon.pid`、`stopDaemonFromState` 的接口、日志目录和保留规则。

## 1.8 SWE 原则审视

- **信息隐藏放错了位置**：区分新旧报告的信息是 token，它已经在报告内容里，又被放进了文件名。文件名带 token 只解决了一个本来就解决了的问题，却制造了"谁来删"的新问题。这是偶然复杂度。
- **谁创建谁负责**：状态目录里的文件都由 daemon 创建，清理也应由 daemon 在它独占目录的时刻（持有 pid 锁时）完成，不要分散到 stop 命令、安装脚本等各处。
- **写入顺序是行为**：停止流程的顺序（最后写状态 → 释放锁 → 写报告）决定了哪些文件能在什么时候安全删除。本议题不改这个顺序。
- **YAGNI**：不做"按时间清理旧报告"、不做诊断报告命令、不在 `serve status` 里显示异常退出。

## 1.9 与既有文档的关系

- `docs/ohbaby-server/` 的模块设计文档没有写到 shutdown 报告和临时文件，本议题不需要同步它们。
- [执行可靠性 improve-4](../../2026-09-19-execution-reliability/improve-4/02-optimization-plan-and-change-scope.md) 是 shutdown 报告的来源，本议题改的是报告的文件名，不改它的规则。
- 脚本安装议题 02 的 Stage 1（`serve-awareness` 那一条）、改动清单 C5、04 的 U4 移到本议题。
