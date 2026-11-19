# 讨论记录与已确认要点

> 2026-11-19 与用户逐项讨论，每确认一项就更新本文。正式方案见 01–04。

## 1. 背景与动机

用户发现本机 `~/.ohbaby/server/` 下堆了 70 多个文件。2026-11-19 现场核对的结果：

| 文件 | 数量 | 说明 |
|---|---|---|
| `daemon-state.json` | 1 | 正常的状态文件，最后一次记录是 `stopped` |
| `daemon-state.json.shutdown-<token>.json` | 68 | 每次 daemon 停止时写的清理报告，约 136 字节，内容都是 `cleanup: confirmed` |
| `daemon-state.json.<pid>.tmp` | 3 | 0 字节，都是 2026 年 9 月留下的 |

`~/.ohbaby/logs/serve/` 里的 26 个日志中，有 2 个（11-10 和 11-12）最后一行是 `server.started`，没有 `server.stopped`，也找不到对应的 shutdown 报告。这两次 daemon 是被强杀或崩溃退出的，现在没有任何地方记录这件事。

接下来的 CLI 升级和脚本安装都要读 daemon 的状态文件、停 daemon、看清理结果。用户的判断是：daemon 的启停和诊断日志要先修好，再实施升级。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 议题定位 | 独立议题，作为 CLI 升级、脚本安装两个议题的前置，先实施 |
| 范围收紧 | 只修升级要依赖的部分，不借机重做 daemon |
| 文档落点 | `docs/problem-lists/2026-11-19-daemon-lifecycle-cleanup/`，和两个升级议题放在一起 |
| 轮次 | 一轮完成，实施分几步写进 02 的 Stage |
| 关键改动清单 | 02 里要写（2026-11-19 用户确认），和两个升级议题一致 |
| 设计文档 | 不用 plan-module-design，不建模块级改进文档。改动只涉及 `runtime/daemon/` 的现有函数，`docs/ohbaby-server/` 没有写到 shutdown 报告 |

## 3. 逐项讨论

全景里提出 A–D 四项，逐项确认后写入本节。

| 编号 | 议题 | 状态 |
|---|---|---|
| A | shutdown 报告改成固定文件名 | 已确认（3.1） |
| B | daemon 启动时清理残留；写状态失败时删掉自己的临时文件 | 已确认（3.2） |
| C | daemon 启动时发现上次没有正常退出，写一条日志 | 已确认（3.3） |
| D | `serve-awareness.ts` 的状态目录改用 `resolveOhbabyHome()`，从脚本安装议题提前到本议题 | 已确认（3.4） |

### 3.1 A：shutdown 报告改成固定文件名

| 决策项 | 结论 |
|---|---|
| 文件名 | 和状态文件同目录的 `daemon-shutdown.json`，不再带 token |
| 写入 | daemon 每次停止时覆盖写，沿用现在的直接写入，不加临时文件 |
| 读取 | `serve stop` 照旧核对报告里的 pid 和 token；对不上或解析失败，按"清理结果未确认"处理 |
| 与 improve-4 规则的关系 | 区分新旧报告靠文件内容里的 token，不靠文件名，规则继续成立 |
| 已知的极端情况 | 旧 daemon 退出后、stop 读报告前，新 daemon 恰好完成一整轮启停并覆盖了报告。这时 stop 显示"清理结果未确认"，退出码 1。只少了信息，不会误报成功，接受 |
| 兼容旧 daemon | `serve stop` 先读 `daemon-shutdown.json`；文件不存在或 token 对不上时，再按旧文件名 `daemon-state.json.shutdown-<token>.json` 读一次。这样升级时新 CLI 停旧版 daemon，也能拿到清理结果。等旧版本基本没人用了再删掉这段兜底 |
| 降级 | 旧 CLI 停新 daemon 时找不到报告，显示"清理结果未确认"。降级不在本议题范围内，接受 |
| 不采用 | 保留按 token 命名、读完删除再加启动清扫：代码更多，而且启动清扫可能删掉旧 stop 还没读的报告。并进 `daemon-state.json`：报告在释放 pid 锁之后才写，会覆盖新 daemon 的状态 |

### 3.2 B：清理残留

| 决策项 | 结论 |
|---|---|
| B1 启动清扫时机 | daemon 拿到 pid 锁之后、启动服务之前。持有锁说明没有别的 daemon 在跑 |
| B1 清扫范围 | 状态文件所在目录下的旧格式报告 `daemon-state.json.shutdown-*.json`，以及所有 `daemon-state.json.*.tmp`。不动 `daemon-shutdown.json` |
| B1 为什么删 `.tmp` 安全 | 停止流程先写最终状态，再释放 pid 锁，最后写报告。正常情况下，释放锁之后旧 daemon 不再写状态文件。例外是停止时写 `stopping` 超时：`withinShutdown` 只是不再等它，底层写入可能还没结束。这次写入如果正好被新 daemon 清扫掉，只会让旧进程的这次写失败，旧进程反正正在退出，不影响新 daemon |
| B1 失败处理 | 不挡启动，往日志写一条警告。成功时不写日志 |
| B2 写状态失败 | 写 `.tmp` 或改名出错时，删掉自己的 `.tmp`，再抛出原来的错误。进程被强杀的情况由 B1 下次启动时兜底 |
| B2 临时文件名（2026-11-19 审查后确认） | 改为每次写都唯一：`daemon-state.json.<pid>.<uuid>.tmp`。原因是停止流程里 `stopping` 写入超时后，底层写入还在跑，紧接着又写最终状态，两次写会用同一个临时文件。名字唯一后，一次写失败去删临时文件时，不会删到另一次写的。清扫规则 `daemon-state.json.*.tmp` 照样能匹配 |
| 已有的残留 | 升级后第一次启动 daemon 时由 B1 自动清掉，不另写迁移脚本 |
| 不做 | 不清扫旧的按项目存放的目录 `<项目>/.ohbaby/server/`。daemon 已经不往那里写了 |

### 3.3 C：记录上次没有正常退出

| 决策项 | 结论 |
|---|---|
| 检查时机 | daemon 拿到 pid 锁之后、把状态写成 `running` 之前，读旧的 `daemon-state.json` |
| 判断条件 | 旧状态是 `running` 或 `stopping`。已经拿到锁，说明旧进程一定不在了，不再查进程是否存活 |
| 不算异常的状态 | `stopped`（正常停止）；`crashed`（停止时清理失败，或启动失败。那次日志里已有 `server.stop.failed` 或 `server.start.failed`） |
| 日志事件 | 在本次日志写一条 `warn` 级的 `server.previous_run.unclean`，字段：旧 pid、旧状态、旧的启动时间和最后更新时间。只放整数和固定枚举，不放错误文本 |
| 怎么关联旧日志 | 日志文件名里带 pid，用旧 pid 找到只写到一半的旧日志 |
| 不做 | 不在 `serve status` 里显示；不推测退出原因；停止流程不加新事件（已有带 `reason` 的 `server.stopped`，ohbaby 也没有强杀这一步） |

### 3.4 D：serve-awareness 的状态目录

| 决策项 | 结论 |
|---|---|
| 改法 | `readServeCoexistenceNotice` 的目录改用 `resolveOhbabyHome()`，和 daemon 的 `scope.ts` 一致 |
| 归属 | 从脚本安装议题 Stage 1 提前到本议题 |
| 保留的重复 | 它自己解析 pid 文件和状态文件的代码不合并到 `ohbaby-server`。默认 TUI 启动路径不加载 `ohbaby-server`，这是 server 拆包时 C1 阶段（默认 CLI 回 in-process）定下的边界 |
| 文档同步 | 脚本安装 02 的 Stage 1 和改动清单 C5、04 的 U4 改为"由本议题完成"并加链接；CLI 升级、脚本安装的 README 在"相关议题"里加上本议题 |

## 4. 已确认：边界（不做的事）

| 项 | 处理 |
|---|---|
| TUI 退出时写日志 | 本轮不做。TUI 不经过 daemon，和升级关系不大 |
| `ohbaby doctor` 等诊断报告命令 | 本轮不做。属于新功能，目前没有明确的使用场景 |
| 升级、安装、卸载本身 | 在各自议题里做 |

## 5. 与关联议题的关系

- [CLI 升级](../../2026-11-16-cli-upgrade/README.md)、[脚本安装](../../2026-11-17-script-install/README.md)：后续议题，依赖本议题的结果。
- [执行可靠性 improve-4 §2.5](../../2026-09-19-execution-reliability/improve-4/02-optimization-plan-and-change-scope.md)：shutdown 报告的来源。那里的规则继续有效：`serve stop` 只采用与目标 token 匹配的报告；报告缺失时显示"清理结果未确认"；新 daemon 启动不能让旧的 stop 命令读错报告。
