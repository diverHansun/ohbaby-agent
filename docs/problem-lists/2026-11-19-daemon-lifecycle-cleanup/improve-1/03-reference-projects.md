# 03 参考项目

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|---|---|---|
| codex | `../codex/codex-rs/app-server-daemon/src/` | 后台服务的 pid 文件、停止标记、生命周期诊断事件 |

本议题只调研了 codex。它有一个独立的后台服务（app-server-daemon），停止流程和 ohbaby 的 daemon 最接近。CLI 升级议题的 [03](../../2026-11-16-cli-upgrade/improve-1/03-reference-projects.md) 已经调研过各家的升级做法，这里不再重复。

## 3.2 可借鉴点

| 做法 | 出处 | 和本议题的关系 | 取舍 |
|---|---|---|---|
| 停止标记用固定文件名，由 pid 文件路径推出来：`pid_file.with_extension("shutdown")` | `backend/pid.rs:215`、`backend/pid_start.rs:197` | 和 P1 是同一类文件 | **采纳**：`daemon-shutdown.json` |
| 启动前先删掉旧的停止标记，`NotFound` 当作正常 | `backend/pid_start.rs:197-204` | 启动时清理旧文件 | **改造采纳**：ohbaby 的报告要留给 `serve stop` 读，所以启动时不删新格式报告，只删旧格式报告和 `.tmp` |
| 测试断言停止后不留 pid 文件和停止标记 | `backend/pid_tests.rs:822-823` | 目录里会剩什么，要有测试 | **采纳**：04 的 U1、I1 |
| 停止过程写诊断事件 `shutdown_requested`、`shutdown_forced` | `backend/pid.rs:185`、`diagnostics.rs` | 停止和异常要在日志里看得到 | **改造采纳**：ohbaby 已有带 `reason` 的 `server.stopped`，只补"上次没停干净"这一条 |
| 诊断记录只放固定事件和类型化的系统错误，不打印原始错误文本 | `diagnostics.rs:1-2` | 新事件的字段 | **采纳**：ohbaby 的 `defineDiagnosticEvent` 本来就是这个约束 |

## 3.3 明确不借鉴

| 做法 | 理由 |
|---|---|
| 宽限期过后强杀（`force_terminate_process`） | ohbaby 的 `serve stop` 只走认证过的 HTTP 关闭请求，不按 pid 发信号，这是 improve-4 §2.5 定的身份防护 |
| 单独的 operation lock、install lock | codex 的 daemon 会被自动更新程序拉起和替换，ohbaby 的 daemon 一直是用户在前台启动的，现有 pid 锁够用 |

## 3.4 对 02 的影响

- 2.2 节"报告文件名"直接来自 3.2 节第一行。
- Stage 2 的清扫时机参考了 codex 的"启动前清理"，范围按 ohbaby 的 stop 读取方式收窄。
- 04 的 U1、I1 参考了 codex 对"停止后不留文件"的断言。
