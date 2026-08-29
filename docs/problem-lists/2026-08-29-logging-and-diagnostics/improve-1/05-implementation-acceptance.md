# 05 - 实施与验收记录

> 日期：2026-08-29
>
> 分支：`codex/logging-diagnostics-docs`
>
> 状态：实现与本地验收完成，等待独立子代理审查收尾；未 merge、未 push。

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

在 Codex in-app Browser 中使用真实 compiled assets、真实 daemon、真实 HTTP/SSE、scripted OpenAI-compatible provider 完成：

1. 页面 title=`ohbaby`，workspace/fake-model/idle 首屏正常，控制台无 warning/error；
2. 用户 prompt 触发真实 `read fixture.txt`，tool panel 从运行到 `completed`；
3. `OHBABY_COMPILED_WEB_TOOL_OK` 与 follow-up 各只出现一次；
4. 刷新后 URL/session identity 不变，消息与 tool panel 恢复；
5. `<environment_context>` 与 fixture runtime marker 不进入产品 UI/title；
6. stop 后 pid、pid lock 和端口全部释放；
7. 同一次 E2E 读取 serve JSONL，得到 5 个预期 lifecycle 事件，且不含 prompt、模型回复、tool result、API key 或 auth sentinel。

E2E 最终证据：

```text
E2E_UI_EVIDENCE_PASS
E2E_BACKEND_PASS requestCount=3 titleRequests=1 toolResultConsumed=true
E2E_CLEANUP_PASS finalStatus=stopped pidReleased=true portReleased=true
E2E_DIAGNOSTICS_PASS eventCount=5
```

## 5. 自动化测试结果

| 门 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，含 SDK/agent/server/CLI/Web production build |
| `pnpm test` | 307 files passed、5 skipped；2,817 tests passed、16 skipped |
| `pnpm test:unit` | 229 files；2,139 passed；2 skipped |
| `pnpm test:contract` | 16 files；257 passed |
| `OHBABY_TEST_SKIP_PACKAGE_BUILD=1 pnpm test:integration` | 51 files；328 passed；真实 packaging smoke 也在该轮通过 |
| `command-record-terminal.integration.test.ts` | 2/2；真实 in-process host 与真实 serve process |
| `pnpm test:e2e:compiled-web` 的 build 后脚本 | UI/backend/cleanup/diagnostics 全通过 |
| `pnpm test:smoke` | 12 项按设计 skipped：需要真实 provider/MCP 凭据 |
| snapshot API E2E | 1 项按设计 skipped：未配置真实模型 key |

第一次把 unit 与 contract 两套含 Ink 时序的测试并行执行时，`/connect` 键入测试出现一次字段串扰；相同 contract suite 串行复跑 257/257 全绿。本项目的最终门仍按脚本串行执行，因此不把并行资源竞争当成产品失败。

## 6. 敏感信息与失败退化证据

- `trace` 测试覆盖 prompt/completion/reasoning/tool/shell/MCP/HTTP/credential sentinel；level 不放宽正文。
- path encoder 按运行时 roots 选择最长边界，输出 `<home>`、`<workspace>`、`<ohbaby-home>`、`<tmp>` 或 external hash。
- 内置实体名称可直记；用户定义实体由 provenance-aware encoder 生成稳定短 hash。
- URL 删除 credential/query/fragment；外部 host 使用 hash。
- `safeError` 对外部错误使用静态 message，不复制 provider body；stack 路径标准化且 cause 限深。
- 默认 writer 初始化/运行/flush 失败均 fail-open、once notify；显式坏配置 fail-fast。
- TUI active phase 在 Ink 内提示 unavailable；若首次失败发生在 UI 退出后的 dispose，只输出一条固定、非 JSON 警告，且不改变原退出码。
- process logger 的真实文件 integration 验证权限、轮转、保留、并行实例和尾记录 drain。

## 7. 与计划相比的收敛

- `migration.*.completed` 实际统一为 `info`；是否存在 conflict 由计数字段表达，不动态改变 definition level。
- `server.started` 不保存冗余 `reused=false`：logger 只在 fresh serve 创建，reused 客户端根本没有该 process logger。
- 首版没有 `latest` symlink 或 `ohbaby logs`；可发现性由 TUI `/status` 和 fresh serve 输出准确路径解决。
- 没有新增 `onCommandObservationDiagnostic` 等当前无调用方 option；SDK 既有 seam 保持不变。

## 8. 已知仓库基线与非阻断项

- `pnpm format:check` 仍会报告 38 个历史文件；本轮引入或修改的诊断关键文件已单独通过 Prettier check。没有为本功能机械改写无关文件，因此仓库 `pnpm preflight` 仍会在第一步被既有 format baseline 阻断。
- 需要真实云凭据的 smoke/snapshot 测试保持 skipped；本轮安全与 E2E 使用本地 scripted provider，不向外部发送用户数据。
- TUI PTY 是本机 agent 实跑证据；CI 自动门由 Ink contract、真实 child-process integration 与 compiled Web harness 共同承担，首版未为 PTY 新增重量依赖。

这些项目不改变本轮功能结论，但在未来把 `pnpm preflight` 提升为无条件合并门之前，需要单独清理 format baseline，并在有受控凭据的发布环境补跑真实 provider smoke。

## 9. 独立审查

本节在实现完成后的两路子代理审查后填写：

- 文档/契约一致性审查：待完成；
- 代码/可实施性与测试充分性审查：待完成；
- 审查发现与修订：待完成。

## 10. 当前交付边界

- 当前分支包含分阶段 commits；
- 尚未 merge 到 `main`；
- 尚未 push 远程；
- 子代理审查和必要修订完成前，不进行 merge/push。
