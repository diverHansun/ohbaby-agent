# 04 测试与验收

> 本文是实施会话自测和验收会话对照的依据。测试编号在 [02](02-optimization-plan-and-change-scope.md) 各 Stage 的完成定义里引用。

## 4.1 测试范围

| 层次 | 覆盖什么 | 放在哪里、怎么跑 |
|---|---|---|
| 单元测试（U） | 报告文件名、兼容读取、写失败清理、清扫的匹配规则、启动时的记录和清扫顺序、serve-awareness 的目录 | 和源码放在一起，`pnpm test:unit` |
| 集成测试（I） | 真实进程多次启停后目录里剩什么；强杀后再启动的日志 | `packages/ohbaby-server/src/runtime/daemon/` 下新的集成测试，参考 `stop.integration.test.ts` 起真实子进程的写法，`pnpm test:integration` |
| 真机验收（R） | 用户本机的存量残留、真实终端里的启停、新 CLI 停旧版 daemon | 实施完成后手工执行 |

所有测试都用临时目录和临时 `OHBABY_HOME`，不碰用户的 `~/.ohbaby`。

## 4.2 单元测试

| ID | 场景 | 验证点 | 对应 Stage |
|---|---|---|---|
| U1 | 报告覆盖写 | 用两个不同 token 各调一次 `writeShutdownReport`：目录里只有一个 `daemon-shutdown.json`，内容是第二次的；没有 `daemon-state.json.shutdown-*` 文件；权限是 `0o600`（POSIX） | 1 |
| U2 | stop 读报告 | ① 新文件里是目标 token → `cleanup` 取报告里的值；② 新文件里是别的 token，没有旧文件 → `unknown`（改写现有的"别的 token 的报告"用例）；③ 新文件里是别的 token，旧文件名里是目标 token → 取旧文件的值；④ 新文件不是合法 JSON，旧文件名里是目标 token → 取旧文件的值；⑤ 旧文件名里的报告 pid 不对 → `unknown` | 1 |
| U3 | 写状态失败不留 `.tmp` | 让 `rename` 失败（例如把目标路径先建成一个目录）：`write()` 抛出原来的错误，目录里没有 `daemon-state.json.*.tmp`。再并发调两次 `write()`、让其中一次失败：成功那次照常改名，两次的临时文件名不同 | 1 |
| U4 | 清扫的匹配规则 | 目录里放：`daemon-state.json`、`daemon-shutdown.json`、`daemon.pid`、两个 `daemon-state.json.shutdown-<uuid>.json`、两个 `daemon-state.json.<pid>.tmp`，以及干扰文件 `daemon-state.json.bak`、`other.tmp`、`daemon-state.json.shutdown-x.txt`。调用 `removeStaleFiles()` 后，只有旧报告和两个 `.tmp` 被删，其他文件都在。目录不存在时不抛错 | 2 |
| U5 | 记录上次异常退出 | 旧状态是 `running` 或 `stopping` → 写一次 `server.previous_run.unclean`，字段是旧 pid、旧状态、旧时间；旧状态是 `stopped`、`crashed`、文件不存在、内容不合法 → 不写；`read` 抛错 → `start()` 照常成功。另加一条：导入 `ohbaby-agent` 的 observability 模块不抛错（新枚举值已在白名单里） | 2 |
| U6 | 清扫的时机和失败处理 | 用假的 pid 文件记录调用顺序：`acquire` 在前，读旧状态和清扫在后，`bootstrap` 最后；`acquire` 抛 `DaemonAlreadyRunningError` 时，不读旧状态、不清扫；`removeStaleFiles` 抛错时 `start()` 照常成功，并写一次 `server.state_files.cleanup.failed` | 2 |
| U7 | serve-awareness 的目录 | 不传 `homeDirectory`，用 `environment: { OHBABY_HOME: <临时目录> }` 注入，`readServeCoexistenceNotice` 读的是 `<临时目录>/server/daemon-state.json`；传了 `homeDirectory` 时仍是 `<home>/.ohbaby/server/`，不看 `OHBABY_HOME`（原脚本安装议题的 U4）。测试不改 `process.env` | 3 |
| U8 | 停止时状态写入超时 | 在测试替身里分别卡住 `stopping` 和最终状态写入。验证先前写入未结束时不会抢写下一条状态。总时限到达时仍有写入未完成，按期限返回停机失败，锁保留，本实例未写停机报告。底层写入仍被卡住时，活锁阻止下一实例进入清扫。再模拟旧进程退出和接管，最后保持新实例的 `running` | 1 |

## 4.3 集成测试

| ID | 场景 | 验证点 | 对应 Stage |
|---|---|---|---|
| I1 | 多次启停后的目录 | 先在临时 `server/` 目录里放 5 个旧格式报告和 2 个 `.tmp`；然后用真实子进程启停 daemon 三次，交替用 `SIGTERM` 和 `stopDaemonFromState` 停止（Windows 上 `SIGTERM` 等于强制结束，拿不到报告，只用 `stopDaemonFromState`；实施前先看现有 `stop.integration.test.ts` 在 Windows CI 上的实际结果）。结束后目录里只有 `daemon-state.json` 和 `daemon-shutdown.json`；`stopDaemonFromState` 那几次返回 `processExit: confirmed`、`cleanup: confirmed` | 2 |
| I2 | 强杀后再启动 | 子进程要从真实入口 `startDaemonServer` 启动，并带上诊断句柄，日志目录放在临时 `OHBABY_HOME` 下。现有 `stop.integration.test.ts` 直接 new `Supervisor`、不传 logger，不会写日志，不能照抄。起一个 daemon 子进程，等它写出 `running`，用 `SIGKILL` 杀掉；再启动一次：新日志文件里有一条 `server.previous_run.unclean`，`previousPid` 等于被杀的 pid，`previousStatus` 是 `running`；新 daemon 正常启动。Windows 上用 `process.kill(pid)` 强制结束，验证点相同 | 2 |
| I3 | 两个进程同时接管过期 PID 锁 | 使用同一临时 `OHBABY_HOME` 和同一条过期记录。控制两个真实子进程读到旧记录的时机，让其中一个先完成发布，再放行另一个。断言只有胜出方拿到锁进入清扫和启动，最终 PID 锁仍属于胜出方。另覆盖新锁已创建但还没写完的短窗口，重读后识别活锁。记录持续无效、探测不明或接管锁遗留时明确报错，状态和报告文件原样保留 | 2 |

## 4.4 回归清单

- improve-4 的 `serve stop` 退出码矩阵（T16、T42）对应的测试照常通过：已退出且清理完成 → 0；清理失败或未知 → 1；确实没有服务 → 0；身份不明、仍活着、观察超时 → 1。
- `daemon-state.json` 的位置、字段和 `0o600` 权限不变；`readServeCoexistenceNotice` 的其他判断不变。
- 正常停止的顺序为最终状态 → 日志 → 关闭日志 → 释放锁 → 报告。`supervisor.unit.test.ts` 里现有的顺序断言（`order.push("report")` 那组）照常通过。
- daemon 启动失败时仍写 `crashed` 并释放锁。

## 4.5 真机验收

| ID | 步骤 | 通过标准 |
|---|---|---|
| R1 | 在用户本机（现有 68 个旧报告、3 个 `.tmp`）用新版本运行一次 `ohbaby serve`，再 Ctrl+C | 运行中 `server/` 只有 `daemon.pid`、`daemon-state.json`；停止后只有 `daemon-state.json`、`daemon-shutdown.json` |
| R2 | 再启停 3 次，其中一次用 `ohbaby serve stop` | 文件数不增加；`serve stop` 输出"daemon stopped"，退出码 0 |
| R3 | 运行 `ohbaby serve`，在另一个终端 `kill -9` 它（Windows 上用 `taskkill /F /PID <pid>`），再运行 `ohbaby serve` | 新的 `logs/serve/*.jsonl` 里有 `server.previous_run.unclean`，pid 和被杀的进程一致 |
| R4 | 用已发布的 v0.1.18 启动 daemon，再用新版本的 CLI 运行 `ohbaby serve stop` | 退出码 0，输出"daemon stopped"（兼容读取生效），没有"cleanup unknown" |
| R5 | 设置 `OHBABY_HOME` 到一个临时目录，在其中运行 `ohbaby serve`，再在另一个终端用同样的 `OHBABY_HOME` 打开 TUI | TUI 启动时显示已有 serve 在运行的提示 |

## 4.6 发布门

| 项 | 标准 | 如何验证 |
|---|---|---|
| 自动化测试 | U1–U8、I1–I3 通过，`pnpm test:unit`、`pnpm test:integration` 全部通过 | CI 三个系统 |
| 真机 | R1–R5 通过 | macOS 本机；R1–R3 另在 Windows 台式机跑一次 |
| 前置关系 | 本议题先经用户审阅定稿，实施后将验收结果记录在 05，验收通过后才开始实施 CLI 升级和脚本安装 | 对照两个下游议题的 02 和 04 |

## 4.7 对抗性审查要点

| 攻击面 | 可能出的错 | 防御 | 残余风险 |
|---|---|---|---|
| 清扫的时机 | 没拿到锁就清扫，删掉正在运行的 daemon 的 `.tmp`，让它改名失败 | 只在 `acquire()` 成功后清扫；U6 | 无 |
| 匹配规则 | 用 glob 或正则写宽了，删掉 `daemon-state.json` 或用户的文件 | 只用前缀和后缀做字符串比较；U4 的干扰文件 | 用户自己在 `server/` 里放了同名格式的文件，会被删。这个目录是 ohbaby 私有的，接受 |
| 兼容读取 | 旧文件名的报告没校验 token，采用了别的实例的结果 | 两次读取共用校验函数；U2 的 ⑤ | 无 |
| 异常退出的误报 | 正常停止也被记成异常 | 只认 `running`/`stopping`；U5 | 状态已写成 `stopped` 但后续收尾未完成时可能没有此事件，最终清理以报告为准 |
| 新事件破坏日志 | 字段类型不对导致 `emit` 抛错，影响启动 | 用 `emitDiagnosticSafely`；`recordPreviousRun` 自己也不抛错；U5 的 `read` 抛错用例 | 无 |
| Windows | `unlink` 遇到被占用的文件报 `EBUSY` 或 `EPERM` | 清扫失败只记警告，不挡启动；U6 | 残留文件留到下次启动再删 |
