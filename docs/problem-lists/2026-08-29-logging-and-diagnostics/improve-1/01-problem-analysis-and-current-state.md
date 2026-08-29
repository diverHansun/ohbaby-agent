# 01 - 问题分析与当前状态

## 1. 结论先行

当前项目不是“完全没有日志”，而是存在多套彼此不知道对方的输出机制：

- 产品输出直接写终端；
- `OHBABY_DEBUG` 分支直接写 stderr；
- migration 使用 Node warning；
- server supervisor 自带 console logger；
- server cleanup failure 直接写 JSON 到 stderr；
- command recorder 是另一套结构化观测 sink；
- 各层 Error 既可能被转换，也可能被原样抛出。

这些机制分别看都很小，但它们共同绕过了“谁拥有终端、哪些字段安全、退出前如何 flush、写失败怎么办”的统一决策点。此前 command record 污染只是最明显的症状，根因是**观测副作用没有被收口到 composition root**。

## 2. 当前运行模型

### 2.1 TUI in-process

`packages/ohbaby-cli/src/cli/commands/terminal.ts` 在没有 remote port 时创建 in-process backend，并由 Ink 管理交互界面。前端和模型/backend 位于同一个 Node.js 进程，因此 backend 内任何直接 stdout/stderr 写入都会与 Ink 争夺终端。

### 2.2 `ohbaby serve`

`packages/ohbaby-cli/src/cli/commands/serve.ts` 启动 server runtime，`packages/ohbaby-server/src/runtime/daemon/main.ts` 组合 `Supervisor` 与 HTTP/Web backend。当前所谓 daemon 是 server 生命周期组件，不应在设计文档中假设它一定是一个与 serve 命令分离的 OS 子进程。日志 role 因而以 `serve` 为主，不人为制造 `web`、`daemon` 多套文件。

### 2.3 one-shot CLI

仓库当前存在 `run` 命令及 stdout renderer。它不是本需求的主要运行方式，但其机器可读/正常输出合同不能被 logger 破坏，因此保留为回归范围。

## 3. 代码中的真实输出路径

### 3.1 已修复的 command recorder

`packages/ohbaby-agent/src/host/command-recorder.ts` 现在要求显式 sink；`core-api-factory.ts` 与 server `create-app.ts` 默认使用 no-op recorder。这个设计应保留：command record 是专门的 UI 命令观测协议，不自动等价为普通日志事件。

它提供了两条直接经验：

1. 底层默认 stdout/stderr 是危险默认值；
2. “没有消费者”应得到 no-op，而不是退化为终端打印。

### 3.2 Agent debug 旁路

- `packages/ohbaby-agent/src/services/session/title-generator.ts`：以 `OHBABY_DEBUG` 为门控，失败时直接写 stderr；
- `packages/ohbaby-agent/src/services/interface-providers/token-usage.ts`：以相同门控写 JSON stderr。

优点是默认安静，问题是：门控、格式、脱敏、目标位置、生命周期都由业务文件自己决定。`OHBABY_DEBUG` 与 `.env.example` 中 `LOG_LEVEL=info` 也没有形成统一可验证的配置合同。

### 3.3 Migration warning

`packages/ohbaby-agent/src/migration/ohbaby-home.ts` 通过 `process.emitWarning(..., { code: "OHBABY_MIGRATION" })` 输出配置迁移冲突。对非 TUI CLI 来说这是可见告警，但在 in-process TUI 中会走 stderr 并可能破坏画面。它同时具有“用户需要知道”和“开发者需要诊断”两种含义，不能只把它机械改成 logger 事件：

- 用户可行动部分应由 composition/UI 呈现；
- 安全元数据可另记一个 `warn` 事件。

这里还有两个不同启动时序：`utils/project-env.ts` 在 `runOhbabyCli()` 尚未解析命令、也尚未加载 global env 时执行 config migration；TUI 的 `createCoreHost()` 和 server 的 `startDaemonServer()` 之后还会执行 data migration。前者甚至早于 logger 配置可用，因此 CLI 必须先缓存 warning、解析出具体命令后再由对应命令层呈现；不能只在 backend factory 内替换一次调用，也不能让未创建 logger 的 reused serve/管理命令静默丢失提示。

`packages/ohbaby-agent/src/services/database/connection.ts` 临时代理 `process.emitWarning` 以抑制已知 SQLite 实验告警，属于第三方运行时兼容逻辑，不应被 logger 改造顺手扩大；只需保证新增方案不依赖全局 warning patch。

### 3.4 Server supervisor console logger

`packages/ohbaby-server/src/runtime/daemon/supervisor.ts` 的默认 `CONSOLE_LOGGER`：

- `info()` 写 stdout；
- `error()` 写 stderr；
- metadata 类型为 `Record<string, unknown>`；
- 默认存在，未注入时自动生效。

这与 TUI/serve 输出所有权冲突，也允许任意对象进入 JSON.stringify。好消息是 `SupervisorOptions.logger` 已经提供了注入缝，只需收紧默认值与 adapter，而不必重写 supervisor 生命周期。

### 3.5 Server cleanup stderr

`packages/ohbaby-server/src/app/create-app.ts` 的 `reportInteractionCleanupFailure()` 直接把 `ui.interaction.cleanup.failed` JSON 写 stderr。这是当前 serve 路径中独立于 supervisor 的第二个硬编码输出点，也说明只替换 supervisor logger 并不能完成收口。

### 3.6 CLI 合法产品输出

`packages/ohbaby-cli/src/bin.ts`、`cli/stdout-renderer.ts` 等位置的 stdout/stderr 具有显式命令语义：帮助、结果、受控错误、serve ready 等。它们不是一律要删的“坏日志”。改造应区分：

- 命令层可见产品输出：保留并测试；
- backend/host/server 内部诊断输出：迁移到 logger；
- 顶层 fatal catch：先恢复终端/限时 flush，再由命令层决定最后一次错误输出。

## 4. 架构与依赖约束

当前包依赖方向是：

```text
ohbaby-sdk
   ↑       ↑
agent ← server
   ↑       ↑
   └── cli ┘
```

- `ohbaby-agent` 是已发布包，并被 server/cli 使用；
- `ohbaby-server` 已依赖 agent；
- `ohbaby-cli` 同时依赖 agent、server、sdk；
- `ohbaby-sdk` 不应为了本地文件日志反向依赖运行时细节。

因此最小可行位置是：logger 合同与进程 logger factory 位于 agent 的 observability 模块，server/cli 只依赖其窄公开端口；文件 writer、轮转器、sanitizer 细节保持 internal。把 logger 放进 sdk 会污染协议/领域包，把每个包各写一份又会分裂安全策略。

这会新增少量公开 API，因此必须控制出口：只公开跨包组合所需的 `Logger`、opaque event definition/builder、受限 field encoders 和进程 logger 创建/生命周期合同；不公开最终 SafeLogError、encoded record、FileSink、Queue、Rotator 或测试 capture 实现。

## 5. 问题清单

### P1 - 终端输出所有权分散（高）

多个 backend/server 模块可以直接写 stdout/stderr。对 Ink 来说，哪怕内容正确也会破坏光标、重绘和输入节奏；对 serve 来说会把机器不需要看的内部事件持续喷到启动终端。

### P2 - 数据安全边界取决于调用者自觉（高）

当前 `Record<string, unknown>`、字符串拼接和原始 Error message 缺少统一入口。未来只要某个调用者传 request/config/tool result，JSON.stringify 就会完整落盘或输出。

### P3 - Level 含义不统一（中）

`OHBABY_DEBUG` 只是布尔门，migration warning、supervisor info/error 与 command record phase 不是同一套严重度语言。重试尝试、降级和最终失败无法稳定区分。

### P4 - 文件生命周期不存在统一合同（中）

没有统一的目录、权限、进程独占、大小、段数、保留、队列上限和 flush 时限。贸然加入文件 sink 容易产生无限增长、跨进程争用或退出丢尾记录。

### P5 - Logger 自身失败可能形成第二故障（高）

若 writer 在 TUI 中自行 stderr 报错，会重现原 Bug；若递归调用 logger，又可能循环失败；若 flush 无限等待，会把原本能正常退出的进程卡死。

### P6 - 用户错误与开发诊断混用（中）

原始 exception 既不一定适合用户，也不一定适合落盘。缺少“双投影”边界后，常见结果是用户看到 stack，或为了界面简洁把所有排障信息都吞掉。

### P7 - 缺少防回归自动门（高）

只人工 review `process.stdout` / `stderr` 容易漏掉新增旁路；只 spy 当前进程的 write 又证明不了真实构建产物、退出 flush 和 PTY 画面不被污染。

### P8 - 日志之外的错误投影也可能携带原始 message（中）

`Supervisor` 会把 `errorToMessage()` 写入 daemon state，HTTP server 也有多处把 Error message 投影为 response。它们不是 JSONL logger，因此不能靠“接入 logger”自动变安全；但它们会被 status/Web/CLI 读取，属于 Phase E 必须单独盘点的用户错误 surface。首批日志地基不顺手重写所有 HTTP 错误，但也不能宣称完成 logger 后整个项目的错误展示就已经统一。

## 6. 根因

```text
业务/基础设施事件
    ├─ 各模块自行判断 debug / warning / error
    ├─ 各模块自行选择 stdout / stderr / JSON
    ├─ 各模块自行决定写哪些对象
    └─ 无统一生命周期与失败回调
                     ↓
              终端污染 + 信息不一致 + 隐私风险
```

根因不是缺一个 `console.log` 包装函数，而是缺少：

1. 一个受限事件合同；
2. 一个唯一安全化/编码边界；
3. 由运行形态 composition root 决定的 I/O 目标；
4. 可在真实进程层验证的输出所有权。

## 7. 必须保留的正确设计

- command recorder 的显式 sink、默认 no-op 与 bounded queue；
- Agent/Server 已有的依赖注入缝，而不是引入全局无边界 console replacement；
- TUI 由 Ink 拥有 stdout；
- CLI renderer/命令层对产品输出的显式控制；
- server supervisor 的生命周期状态机、pid/state file 与 timeout 语义；
- 第三方 warning 的窄范围兼容处理；
- 现有测试中对构建产物、server 和 command record 终端行为的回归资产。

## 8. 成功后的状态

- 用户默认看不到内部 JSON、stack 或 logger 生命周期噪音；
- TUI 与 serve 都产生各自独占、权限受限的 JSONL 文件；
- `info` 足以排查生命周期，`debug/trace` 提供更细元数据但没有正文；
- 迁移 warning、title failure、token usage、supervisor lifecycle、server cleanup 都通过同一政策；
- logger 不可用时业务按合同退化，并且只提示一次；
- 真实 TUI/Web E2E 同时验证用户界面和本地文件，而不是只证明 unit test 中某个 spy 没被调用。
