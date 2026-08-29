# 03 - 参考项目对比与借鉴

## 1. 调研方法

本次在 2026-08-29 直接阅读了以下六个本地项目的实现，而不是只看 README：

- `claude-code-best`
- `codex`
- `deepseek-harness`
- `kimi-code`
- `opencode`
- `pi`

为避免未来源码变化让结论失去锚点，本次核对的本地 commit 为：

| 项目 | Commit |
| --- | --- |
| Claude Code Best | `77a7934e15d6` |
| Codex | `ec9620c23139` |
| DeepSeek Harness | `cd5ef8148158` |
| Kimi Code | `15f3d93613ec` |
| OpenCode | `15537a41d2a0` |
| Pi | `4e494929998d` |

比较维度统一为：

1. 交互终端与诊断输出如何分权；
2. logger facade、sink/exporter 和 composition root 如何分层；
3. 文件命名、权限、缓冲、轮转与 flush；
4. level 与启用方式；
5. 错误和敏感信息如何处理；
6. 哪些设计适合 ohbaby 当前规模，哪些会带来不必要复杂度。

“借鉴”不等于复制。每节都列出采用、适配与不照搬项；ohbaby 的最终规范仍以 [logging-policy.md](./logging-policy.md) 为准。

## 2. 总体对照

| 项目 | 主要观察 | ohbaby 借鉴 | 明确不照搬 |
| --- | --- | --- | --- |
| Claude Code Best | session debug 文件、latest 入口、早期错误队列、JSONL error/MCP sink | 启动期事件不静默丢失、文件可发现、写失败 fail-open | response body/MCP debug 原文、过宽错误 enrich |
| Codex | TUI 与 exec 使用不同输出 layer；TUI 文件权限；composition root 组装 | 交互形态决定 sink、TUI 不挂 stderr logger、私有权限 | 直接引入 tracing/OTel/日志数据库复杂度 |
| Kimi Code | 自研 logger、串行队列、轮转、sync flush、集中 redaction/cap；server 另有 Pino | 有界队列、轮转、字段/stack/entry 限制、明确 flush | writer 自行 stderr、任意 context 后置脱敏、双 logger 生态 |
| OpenCode | 默认 file-only，显式变量才增加 stderr；Effect structured formatter | 交互默认文件、不污染终端、默认 info | 任意对象递归 flatten、单固定文件、TUI stderr 开关复用 |
| DeepSeek Harness | named logger facade、exporter、有限 ring buffer 及其 level 陷阱 | component 语义与输出 adapter 分离 | `any[]` printf API、把 ring buffer 当可靠错误出口 |
| Pi | stdout 协议所有权、TUI 独占写入日志、唯一实例文件、crash 先恢复终端 | 输出所有权、每进程唯一文件、终端恢复顺序、真实 TUI 测试思路 | 在普通交互模式全局 monkey-patch stdout、原始屏幕内容长期保存 |

## 3. Claude Code Best

### 3.1 阅读位置

- `src/utils/debug.ts`
- `src/utils/log.ts`
- `src/utils/errorLogSink.ts`

### 3.2 值得借鉴

`debug.ts` 把 debug 是否启用、level、文件路径、writer 生命周期集中管理，并提供当前 session 日志和 `debug/latest` 的可发现入口。`log.ts` 在正式 sink 尚未挂载时缓存少量 error/MCP 事件，随后补投，避免启动早期故障直接消失；错误记录自身也采用 fail-open，不能反过来打崩 UI。`errorLogSink.ts` 使用按行结构化文件与 buffered writer，说明交互应用可以把排障输出移出终端，同时保留机器可读性。

ohbaby 采用：

- 初始化早期不应因 logger 尚未完成而抛异常；
- 文件需要按运行实例容易定位；
- writer 失败不能破坏交互进程；
- JSONL 一行一个事件，便于流式 tail 和局部分享。

ohbaby 的 KISS 适配是：进程 factory 在 backend 启动前完成，首版不建设通用“所有早期事件队列”；只有 writer 自己使用小型有界队列。独占文件名负责避免争用，发现性由 process handle 的精确路径解决：TUI `/status` 和 fresh serve ready 输出按需呈现。先不增加 `latest` symlink 的跨平台与竞态处理。

### 3.3 不照搬

`errorLogSink.ts` 会为 Axios 错误补充 URL/status/server message，也允许 MCP debug message 进入日志。这些内容可能含 query、响应正文或用户定义 server 名。ohbaby 不复制这种“先收集丰富上下文，再期待脱敏”的模型：外部错误默认只保留安全类别/状态元数据，MCP 用户名 hash，body 永远禁止。

Claude Code Best 还保留内存中的最近错误以支持反馈/监控。ohbaby 当前没有反馈上传流程，不为假想需求增加生产 ring buffer。

## 4. Codex

### 4.1 阅读位置

- `codex-rs/tui/src/startup_orchestration.rs`
- `codex-rs/exec/src/lib.rs`

### 4.2 值得借鉴

Codex 最关键的启发不是 Rust `tracing` API，而是**不同运行形态拥有不同 layer**：TUI 的 startup orchestration 不把普通 fmt logger 挂到 stderr；只有显式配置 log dir 时增加文件 layer，并在 Unix 创建私有模式文件。`codex exec` 则因为 stdout 有协议/结果职责，把诊断 layer 明确放到 stderr，并设置自己的 filter。

ohbaby 采用：

- logger 的 I/O 目标由 TUI/serve composition root 决定；
- TUI 不能复用非交互命令的 stderr 默认值；
- 日志文件采用私有权限；
- 产品 stdout、受控 CLI stderr 与本地诊断文件是不同通道。

### 4.3 适配与不照搬

Codex TUI 当前对文件 layer 更偏显式 opt-in，同时源码中还存在 feedback/log DB/OTel 等其他观测设施。源码能证明这些能力共存，不能证明它们是 opt-in 默认值的因果理由。ohbaby 基于自身“首版没有其他持久诊断面”的现状做适配判断：借鉴“输出分权”，但采用已确认的默认 `info` 本地文件。

Codex 的 tracing subscriber、OTel layer、日志数据库和 telemetry 规模远超本项目当前需要。ohbaby 不因参考它而引入 span runtime、remote exporter 或全局 subscriber。

## 5. Kimi Code

### 5.1 阅读位置

- `packages/agent-core/src/logging/logger.ts`
- `packages/agent-core-v2/src/_base/log/fileLog.ts`
- `packages/agent-core-v2/src/_base/log/logConfig.ts`
- `packages/agent-core-v2/src/_base/log/formatter.ts`
- `packages/kap-server/src/services/pinoLoggerService.ts`

### 5.2 值得借鉴

Kimi 的 agent-core 日志实现与 ohbaby 需求最接近：root/session sink 分层，file logger 使用串行异步队列，设置 pending 上限和轮转，退出时提供同步/显式 flush。formatter 对 message、context value、stack 和整条 entry 都设置大小上限，并集中处理常见敏感字段与字符串。

ohbaby 采用：

- 有界串行写，避免并发追加乱序和内存无限增长；
- 文件大小轮转与限时 flush；
- error stack、字段和整行都必须限长；
- 安全化/编码集中，而不是散落在调用点；
- 默认 `info`，更细 level 需要显式设置。

### 5.3 适配与不照搬

Kimi formatter 接受较宽的 context，再递归 redact 和 serialize。ohbaby 选择更严格的前置 API：普通调用者根本不能传嵌套任意对象，redaction 是第二道防线而不是第一道门。但严格性只落实到类型、builder、运行时 identity/格式检查和受限 encoder；首版不额外自研 AST lint 来约束 definition 必须写在顶层。

Kimi file logger 写失败时会自行向 stderr 报告（带节流）。这在普通 CLI 可接受，但对 Ink TUI 仍会破坏画面；ohbaby 改为一次性 `onUnavailable` 信号，由组合根决定 UI/serve 呈现。

Kimi 的 `kap-server` 使用 Pino 9.5，而 agent-core 另有自研 logger。这说明“优秀项目都不用通用 logger”并不成立。双日志生态可能带来策略漂移和额外维护面，这是 ohbaby 针对自身规模做出的风险判断，不是对 Kimi 维护成本的事实断言；ohbaby 当前依赖方向允许一套自研窄合同覆盖 TUI/serve，因此不复制 Pino + custom logger 并存。

## 6. OpenCode

### 6.1 阅读位置

- `packages/core/src/observability/logging.ts`

### 6.2 值得借鉴

OpenCode 基于 Effect Logger，默认 `loggers()` 只返回 file logger；只有 `OPENCODE_PRINT_LOGS=1` 才额外加入 stderr logger。默认 level 是 info。这个默认值直接体现了交互程序的一条好原则：开发诊断应可用，但不能默认占用终端。

ohbaby 采用：

- 默认 file-only；
- 默认 `info`；
- terminal 输出若未来需要，必须是组合根的显式产品决策，不能成为底层 logger 默认。

### 6.3 适配与不照搬

OpenCode formatter 会递归 flatten 普通对象，并允许 message/cause/annotations 进入自由格式文本。这对 Effect 生态很灵活，但与 ohbaby 的最小敏感边界冲突。ohbaby 只接受静态 event definition 与受限 field encoders，不提供任意对象 flatten。

OpenCode 默认固定 `opencode.log` 追加文件。ohbaby 同时有 TUI/serve 运行实例，采用每进程唯一文件和单持有者轮转，不共享固定日志文件。

## 7. DeepSeek Harness

### 7.1 阅读位置

- `vendor/cordis/src/logger.ts`
- `packages/experimental/webworker-runtime/src/worker-host.ts`

### 7.2 值得借鉴

Cordis logger 提供 named logger facade 和 exporter：组件只生成结构化 `Message`，到底进入 ring buffer、console 或其他目标由 exporter 决定。默认 ring exporter 有 1,000 条上限，但 Cordis 的等级排序是 error=0、info=1、warn=2、debug=3，而默认 INFO threshold 会收 error/info、过滤 warn/debug。worker-host 因而显式安装 warn/error console exporter，避免 warning 根本没有可见出口。这个例子说明“有默认 buffer”仍不等于关键故障可观察，level 语义和实际 exporter 都必须测试。

ohbaby 采用：

- named component 的低基数语义；ohbaby 通过静态 event definition 声明 component，不开放动态 `child(userInput)`；
- 业务产生事件，composition root 选择输出 adapter；
- 所有 buffer 必须有界；
- 没有真实消费者时要明确 no-op/disabled，而不是误以为“已经记录”。

### 7.3 不照搬

Cordis 的 logger 是 printf 风格 `any[]` 参数，并支持 `%o` JSON.stringify 任意对象。这对通用框架有价值，但会扩大 ohbaby 的泄露面，不采用。

默认 ring buffer 也不是 ohbaby 的唯一 sink：它在进程崩溃后不可持久读取，而且没有当前 feedback exporter 消费者。首版直接使用本地文件，不建设额外常驻内存历史。

## 8. Pi

### 8.1 阅读位置

- `packages/coding-agent/src/core/output-guard.ts`
- `packages/tui/src/terminal.ts`
- `packages/tui/src/tui-main-screen.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

### 8.2 值得借鉴

Pi 对“谁拥有 stdout”处理得很明确：RPC 模式接管 stdout 作为协议通道，其他意外写入会被重定向；TUI terminal 的 `PI_TUI_WRITE_LOG` 在目录模式生成带时间和 pid 的唯一文件；隐藏 debug 能力写独立 `pi-debug.log`；交互模式的 uncaught crash 会先 `ui.stop()` 恢复 cooked mode、光标和终端协议，再输出最终错误。

ohbaby 采用：

- stdout 是协议/UI 资源，不是随手可用的日志目标；
- 文件名包含时间、pid 和实例信息；
- crash 路径先恢复 TUI，再呈现错误并 best-effort flush；
- 真实 PTY/E2E 必须观察光标、输入节奏和屏幕，而不只 spy write 函数。

### 8.3 适配与不照搬

Pi 的 stdout monkey patch 是 RPC 协议防线，不应被照搬为普通 TUI 的长期全局补丁。ohbaby 从源头用 lint、注入和 composition root 取消旁路，测试中可以用 guard 发现违规，但生产 TUI 不依赖 monkey patch 才保持正确。

`PI_TUI_WRITE_LOG` 更接近记录终端写入本身；ohbaby 的 JSONL logger 记录诊断事件，不保存 TUI 屏幕、prompt 或模型正文。若未来需要 terminal capture，应作为独立、短期、显式同意的调试工具重新设计。

## 9. 综合取舍

最终方案不是六者功能并集，而是选出适合当前项目的最小交集：

```text
Codex / OpenCode       → 交互终端与诊断 sink 分权
Kimi                   → 有界队列、轮转、flush、集中限制
DeepSeek Harness       → named facade 与 exporter/composition 思想
Pi                     → 每进程唯一文件、输出协议、崩溃恢复顺序
Claude Code Best       → 启动期/文件可发现性与 fail-open 经验
ohbaby 自身 record 修复 → 默认 no-op、显式注入、禁止隐式 I/O
```

同时统一拒绝以下“看起来方便”的做法：

- logger 默认写 stderr；
- 任意对象/printf 参数；
- `trace` 记录正文；
- 多进程共享固定文件；
- writer 自己向终端报告失败；
- 为未来遥测、反馈或 exporter 预建当前没有消费者的架构。

这使方案保持 KISS：一套安全事件合同、一套进程文件实现、两个主要 composition root、一个规范文档和真实运行级验收。
