# 05 - 实施与验收记录

> 日期：2026-08-29；最终收口更新：2026-08-30
>
> 分支：`codex/logging-diagnostics-docs`
>
> 状态：实现、问题修订与本地验收完成，等待修订后的独立子代理复审收尾；未 merge、未 push。

## 1. 结论

本轮改造已经关闭最初的用户问题：command recorder、server cleanup、migration warning、title/token diagnostics 和 daemon lifecycle 不再从 agent/server 底层直接写入 TUI 或 serve 终端。TUI 与 fresh `ohbaby serve` 默认创建各自的 `info` JSONL；公开 library factory 未注入 logger 时保持 no-op。

真实 TUI PTY 与 compiled Web/serve 流程均未再出现 `{ "record": ... }`、`ui.command.*` JSON、stack 或 logger 自身错误刷屏。日志只包含经过静态 definition 和受限 encoder 投影的元数据；实际 prompt、模型回复、tool result、API key 与 auth token 的 sentinel 扫描均未命中。

## 2. 分阶段交付

| Commit | 阶段 | 结果 |
| --- | --- | --- |
| `7d1f673` | 设计基线 | 建立讨论、现状、方案、参考、测试和 policy 文档 |
| `be8a2d2` | 文档对齐 | 吸收两轮审查，收紧输出所有权、可发现性和验收合同 |
| `e526a35` | 日志地基 | 静态事件、encoder、JSONL writer、轮转、保留、有界队列与 no-op |
| `e24b4fa` | TUI 接入 | in-process composition、迁移/title/token 旁路收口、startup notice |
| `f72a642` | serve 接入 | lazy fresh-serve logger、server/supervisor lifecycle、cleanup 事件 |
| `a191f4a` | 错误显示 | CLI/TUI 最终错误统一保留稳定 code |
| `e4ff7a4` | TUI 可发现性 | `/status` 显示真实日志路径，透传 active unavailable 订阅 |
| `11e8da7` | 真实进程测试 | in-process host 与真实 serve 子进程联合验证终端和 JSONL |
| `2fbf8ba` | 格式收口 | 格式化本轮触及且由本轮引入偏差的文件 |
| `3a10a58` | E2E 加固 | late teardown 提示合同与 compiled Web 日志联合验收 |
| `2d1fae0` / `39d6c46` | 首轮验收记录 | 写入实现证据和全量测试结果 |
| `67edc0b` | shutdown join | 并发 stop 在 diagnostics drain 结束前保持同一 promise |
| `9e8303b` | RPC 错误码 | 稳定、安全的 error code 跨 RPC 保留并由 TUI 格式化 |
| `404410c` | 安全与终结合同 | URL/path/error 收紧，dispose/drop/truncation/retention/并行实例回归测试 |
| `fe7ecff` | TUI 单次提示 | active UI 已呈现后不在退出时重复写 stderr |
| `37c77f6` / `e3c1910` | daemon outcome | success/failure 事件真实反映 stop 结果，注入 logger fail-open |
| `9311813` / `0003e54` / `6efb451` | 防回归门与 API 收口 | 建立 process output import/destructure 门、拒绝正文型日志字段，并把 sanitizer 留在包内 |
| `3dff0e5` | bounded dispose | 同一绝对 deadline 覆盖 drain、drop summary 与 close；增加 writer hang、原退出码和双子进程测试 |
| `7adf368` | teardown fail-open | diagnostics dispose rejection 不覆盖 daemon 启停结果或 signal 退出码 |
| `2a05833` / `7737c12` | 一致性收口 | 补常见 process/globalThis alias 门，并让 TUI command/runtime label 保留稳定 error code |

最终文档提交与审查修订会追加在本表之后，不改写上述阶段历史。

## 3. 实际架构结果

### 3.1 输出所有权

- `packages/ohbaby-agent` 与 `packages/ohbaby-server` 的生产源码由 ESLint 默认禁止 `process.stdout`、`process.stderr`、`process.emitWarning` 和 `console.*`；SQLite experimental warning interceptor 是注明原因的窄 allowlist。
- logger 只写文件，从不决定用户提示，也从不直接写终端。
- TUI 的用户提示由 Ink/CLI composition root 呈现；fresh serve 的 ready URL 与 diagnostics 路径仍是命令层产品输出。
- command recorder 保持独立协议能力；默认 sink/diagnostic reporter 已改为无 I/O，不再把 `ui.command.record` 打到终端。

### 3.2 默认运行行为

| 入口 | 默认行为 |
| --- | --- |
| CLI TUI | 创建 role=`tui`、level=`info` 的独占 JSONL；`/status` 按需显示路径 |
| fresh `ohbaby serve` | 复用判定后才创建 role=`serve` JSONL；ready 输出后显示准确路径 |
| reused serve / status / ps / stop | 不创建当前客户端的伪 serve 日志文件 |
| direct agent/server library factory | 未显式注入 logger/capability 时 no-op，不触碰用户目录 |
| 现有 one-shot 命令 | 不因 TUI 的默认策略隐式创建日志 |

### 3.3 文件合同

- 默认根目录：运行时解析的 `<ohbaby-home>/logs/<role>/`；`OHBABY_LOG_DIR` 可覆盖且必须是绝对路径。
- 文件名：UTC 时间、pid 和随机短 ID；每进程独占。
- POSIX 权限：目录 `0700`、文件 `0600`。
- 固定策略：8 MiB/段、每进程 3 段、14 天保留、1,024 条有界队列、16 KiB 单行、2 秒 drain。
- 默认目录不可用时 fail-open 并只通知一次；用户显式配置非法/不可用目录时启动阶段 fail-fast，避免“看似启用、实际没日志”。

### 3.4 首批事件

实际事件目录为：

- `diagnostics.started`
- `logger.events_dropped`
- `session.title_generation.failed`
- `llm.usage.normalization`
- `migration.config.completed`
- `migration.data.completed`
- `server.started`
- `server.start.failed`
- `server.stopped`
- `server.stop.failed`
- `ui.interaction.cleanup.failure`

没有开放 `logger.info(message, object)`、任意 context、正文 encoder 或开发环境终端 escape hatch。`debug`/`trace` 只改变静态事件的 level 过滤，不改变字段许可。

## 4. 用户可见实测

### 4.1 真实 TUI PTY

使用真实 `packages/ohbaby-cli/dist/bin.js`、真实 raw mode/Ink、隔离 HOME/OHBABY_HOME/OHBABY_LOG_DIR 和本地不可达 fake provider 执行：

1. `/skills` 正常打开面板并显示 `No skills`；没有 command-record JSON；
2. `/status` 显示 `Runtime`、`Model`、`Project` 与 `Log`，长日志路径在面板内换行，不插入输入框；
3. 输入 `HELLO_TUI_DIAGNOSTICS_SENTINEL` 后消息进入正常 transcript，光标/输入区恢复；
4. provider/title 失败后 TUI 未被底层 stderr/JSON 打断；对应日志只得到安全的 `session.title_generation.failed`；
5. Ctrl-C 正常恢复终端并返回退出码 0。

该次日志共 4 行：diagnostics start、两类 migration count、一次安全 title failure。日志不含 prompt sentinel、`test-only-key` 或 `ui.command.`。

### 4.2 fresh serve 与真实子进程

真实 child process 验证：

- stdout 只含 ready/diagnostics 等命令层产品输出；stderr 为空；
- diagnostics 路径指向真实存在的 serve JSONL；
- stop 后文件包含 `diagnostics.started`、两类 migration、`server.started`、`server.stopped`；
- 日志不含 API key、daemon auth token 或 `ui.command.*`。

### 4.3 compiled Web E2E

在 Codex in-app Browser 中由 agent 实际操作页面，并使用真实 compiled assets、真实 daemon、真实 HTTP/SSE、scripted OpenAI-compatible provider 完成：

1. 页面 title=`ohbaby`，workspace/fake-model/idle 首屏正常，控制台无 warning/error；
2. 用户 prompt 触发真实 `read fixture.txt`，tool panel 从运行到 `completed`；
3. `OHBABY_COMPILED_WEB_TOOL_OK` 与 follow-up 各只出现一次；
4. 刷新后 URL/session identity 不变，消息与 tool panel 恢复；
5. `<environment_context>` 与 fixture runtime marker 不进入产品 UI/title；
6. stop 后 pid、pid lock 和端口全部释放；
7. 同一次 E2E 读取 serve JSONL，得到 5 个预期 lifecycle 事件，且不含 prompt、模型回复、tool result、API key 或 auth sentinel。

其中 backend/cleanup/diagnostics 是脚本自动断言；UI 输入、工具卡与刷新恢复由 in-app Browser 操作后向 harness 回传固定 schema，属于 **operator-assisted E2E 见证**，不是无人值守浏览器自动化。最终证据：

```text
E2E_UI_EVIDENCE_PASS activeSessionStable=true toolPanelCompleted=true runtimeMarkersVisible=false
E2E_BACKEND_PASS requestCount=3 runtimePartCounts=[1,1,2] titleRequests=1 toolResultConsumed=true
E2E_CLEANUP_PASS finalStatus=stopped pidReleased=true portReleased=true
E2E_DIAGNOSTICS_PASS eventCount=5
```

## 5. 自动化测试结果

| 门 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，含 SDK/agent/server/CLI/Web production build |
| `pnpm test` | 最终 HEAD 全量：307 files passed、5 skipped；2,852 tests passed、16 skipped |
| `logger.unit.test.ts` | 最终正文字段/名称补强后 23/23 |
| `output-ownership.contract.test.ts` | 11/11；覆盖 import/destructure 与常见 `process`/`globalThis.process` alias |
| `process-logger.integration.test.ts` | 13/13；真实文件、轮转、drop summary、并发 dispose、截断、runtime failure、retention、双真实子进程与 close hang |
| `main.unit.test.ts` + `supervisor.unit.test.ts` | 33/33；真实 stop outcome、并发 stop、teardown fail-open 与 mock boundary |
| `command-record-terminal.integration.test.ts` | 2/2；真实 in-process host 与真实 serve process |
| 最终相关测试集 | 9 files、245/245；覆盖 logger、输出所有权、process logger、CLI、RPC、server 与真实子进程 |
| compiled Web harness + in-app Browser | operator-assisted UI 与自动 backend/cleanup/diagnostics 全通过 |
| 需要真实云凭据的测试 | 按设计 skipped；未向外部发送测试数据 |

第一次把 unit 与 contract 两套含 Ink 时序的测试并行执行时，`/connect` 键入测试出现一次字段串扰；相同 contract suite 串行复跑 257/257 全绿。本项目的最终门仍按脚本串行执行，因此不把并行资源竞争当成产品失败。

## 6. 敏感信息与失败退化证据

- definition builder 在 error 到 trace 的每个 level 都拒绝 prompt/completion/reasoning/body/command/input/output/request/response/config/context/authorization/token 等正文槽位；E2E 另扫描真实 prompt/tool/body/credential sentinel。
- path encoder 按运行时 roots 选择最长边界，输出 `<home>`、`<workspace>`、`<ohbaby-home>`、`<tmp>` 或 external hash。
- 内置实体名称只能来自静态 enum allowlist；用户定义实体走始终 hash 的单向 encoder，即使同名也不会被调用点伪装成内置。
- URL 不保留 userinfo、hostname/IP、path、query 或 fragment，只记录 origin hash；绝对路径 root 替换后的 suffix 仍执行 credential 清洗和 512-byte 上限。
- `safeError` 对外部错误使用静态 message 和 name/code allowlist，不复制 provider body，也不公开最终 `SafeLogError` 或 normalization helper。
- 默认 writer 初始化/运行失败均 fail-open、once notify；显式坏配置 fail-fast；并发 dispose 加入同一个 drain，满队列退出仍写一次 drop summary。
- TUI active phase 在 Ink 内提示 unavailable；若首次失败发生在 UI 退出后的 dispose，只输出一条固定、非 JSON 警告，且不改变原退出码。
- 16 KiB 路径只先删 stack/可选字段，必填字段不删除；无法满足上限时拒绝事件并 fail-open。
- process logger 的真实文件 integration 验证权限、轮转、保留、双真实子进程并行实例、runtime write failure、drop summary、尾记录 drain 与受控 writer close hang；hang 子进程在 deadline 后按原 exit code `23` 退出。

## 7. 与计划相比的收敛

- `migration.*.completed` 实际统一为 `info`；是否存在 conflict 由计数字段表达，不动态改变 definition level。
- `server.started` 不保存冗余 `reused=false`：logger 只在 fresh serve 创建，reused 客户端根本没有该 process logger。
- 首版没有 `latest` symlink 或 `ohbaby logs`；可发现性由 TUI `/status` 和 fresh serve 输出准确路径解决。
- 没有新增 `onCommandObservationDiagnostic` 等当前无调用方 option；SDK 既有 seam 保持不变。

## 8. 已知仓库基线与非阻断项

- `pnpm format:check` 仍会报告 38 个历史文件；本轮触及文件单独通过 Prettier，`git diff --check` 通过。没有为本功能机械改写无关文件，因此不能宣称 `pnpm preflight` 通过；`04` 已把它明确归为仓库级历史 baseline 例外。
- 需要真实云凭据的 smoke/snapshot 测试保持 skipped；本轮安全与 E2E 使用本地 scripted provider，不向外部发送用户数据。
- TUI PTY 与 Web 页面操作是本机 agent 的 operator-assisted 见证；无人值守自动门由 Ink contract、真实 child-process integration，以及 compiled Web harness 的 backend/cleanup/diagnostics 部分承担。首版未为 PTY 或浏览器控制新增重量依赖。

这些项目不改变本轮功能结论，但在未来把 `pnpm preflight` 提升为无条件合并门之前，需要单独清理 format baseline，并在有受控凭据的发布环境补跑真实 provider smoke。

## 9. 独立审查

首轮两路子代理均给出“不通过、无 P0、有 P1”的结论，主要发现：URL/path/error 边界可泄露、process logger 并发 dispose/drop summary/截断合同不完整、TUI unavailable 重复提示、RPC error code 丢失、daemon stop 成功事件失真，以及本文把 operator-assisted Web UI 与若干未存在的测试写成自动化闭环。

首轮问题修订后，两位代理的第二轮复审仍一致指出两个 P1：完整 dispose deadline 未覆盖 writer close，以及注入的 diagnostics dispose rejection 会覆盖 daemon 原业务结果；另指出 process alias 与 TUI error code 两个低成本 P2。`3dff0e5`、`7adf368`、`2a05833`、`7737c12` 已逐项修复并增加回归测试。最终 verdict 仍待两位原审查代理基于最新 HEAD 再次复核后填写。

## 10. 当前交付边界

- 当前分支包含分阶段 commits；
- 尚未 merge 到 `main`；
- 尚未 push 远程；
- 子代理审查和必要修订完成前，不进行 merge/push。
