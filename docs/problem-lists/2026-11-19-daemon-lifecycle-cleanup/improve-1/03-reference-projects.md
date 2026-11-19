# 03 参考项目

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|---|---|---|
| codex | `../codex/codex-rs/app-server-daemon/src/` | 后台服务的 pid 文件、停止标记、生命周期诊断事件 |
| Kimi Code | `../kimi-code/`（`f082f04a0`） | 并发接管过期安装锁 |
| ZCode | `../ZCode/`（`fec97590`） | 服务数据目录锁 |
| dsh | `../deepseek-harness/`（`39163dd30f7`） | 启动失败的终端提示和日志位置 |

下表的源码路径以各自项目为根，Codex 项以表中调研目录为根。

## 3.2 可借鉴点

| 做法 | 出处 | 和本议题的关系 | 取舍 |
|---|---|---|---|
| 停止标记用固定文件名，由 pid 文件路径推出来：`pid_file.with_extension("shutdown")` | `backend/pid.rs:215`、`backend/pid_start.rs:197` | 和 P1 是同一类文件 | **采纳**：`daemon-shutdown.json` |
| 启动前先删掉旧的停止标记，`NotFound` 当作正常 | `backend/pid_start.rs:197-204` | 启动时清理旧文件 | **改造采纳**：ohbaby 的报告要留给 `serve stop` 读，所以启动时不删新格式报告，只删旧格式报告和 `.tmp` |
| 测试断言停止后不留 pid 文件和停止标记 | `backend/pid_tests.rs:822-823` | 目录里会剩什么，要有测试 | **采纳**：04 的 U1、I1 |
| 停止过程写诊断事件 `shutdown_requested`、`shutdown_forced` | `backend/pid.rs:185`、`diagnostics.rs` | 停止和异常要在日志里看得到 | **改造采纳**：ohbaby 已有带 `reason` 的 `server.stopped`，只补"上次没停干净"这一条 |
| 诊断记录只放固定事件和类型化的系统错误，不打印原始错误文本 | `diagnostics.rs:1-2` | 新事件的字段 | **采纳**：ohbaby 的 `defineDiagnosticEvent` 本来就是这个约束 |
| 串行接管过期锁，在接管区内重读持有者 | Kimi Code `apps/kimi-code/src/cli/update/install-lock.ts:170` 和 `apps/kimi-code/test/cli/update/install-lock.test.ts:81`，ZCode `packages/zcode-server-cli/src/runtime/lock.ts:57` | 旧观察可能让失败方删掉胜出方的新锁 | **采纳**：接管串行化和双进程验收。ohbaby 的接管锁遗留时提示人工确认 |
| 终端简短提示并给出实际日志路径 | dsh `apps/cli/src/startup-diagnostics.ts:26` | 用户需要知道失败后去哪里看 | **采纳**：沿用现有 JSONL 和 CLI 日志路径提示，增加能定位旧实例的事件 |

## 3.3 明确不借鉴

| 做法 | 理由 |
|---|---|
| 宽限期过后强杀（`force_terminate_process`） | ohbaby 的 `serve stop` 只走认证过的 HTTP 关闭请求，不按 pid 发信号，这是 improve-4 §2.5 定的身份防护 |
| 跨启停及安装的通用 operation lock | ohbaby 保留前台启动。额外互斥只覆盖 PID 过期锁接管这个已经复现的问题 |

## 3.4 对 02 的影响

- 2.2 节"报告文件名"直接来自 3.2 节第一行。
- Stage 2 的清扫时机参考了 codex 的"启动前清理"，范围按 ohbaby 的 stop 读取方式收窄。
- 04 的 U1、I1 参考了 codex 对"停止后不留文件"的断言。
