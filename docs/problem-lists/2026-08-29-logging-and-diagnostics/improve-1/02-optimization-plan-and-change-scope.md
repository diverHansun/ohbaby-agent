# 02 - 优化方案与变更范围

## 1. 方案摘要

方案采用“受限 logger port + 进程级文件实现 + composition root 注入”的结构：

```text
业务模块
  └─ Logger（只接受 static event definition + typed input）
        ├─ No-op（未启用/测试默认）
        └─ Process logger
             ├─ level filter
             ├─ safeError / path / URL / name policy
             ├─ JSONL encoder
             └─ bounded serial file writer
                    ├─ per-process file
                    ├─ rotation / retention
                    └─ bounded flush

TUI / serve composition root
  ├─ 决定 role、目录、level 和 roots
  ├─ 注入 logger
  ├─ 接收一次性 unavailable 通知
  └─ 决定如何向用户显示，不由 logger 写终端
```

它刻意不做两件事：不把 logger 变成全局 `console` 替身，也不让调用者把任意对象交给 logger 后寄希望于“最后再脱敏”。

## 2. 设计原则

### 2.1 I/O 决策上移

agent/server 业务模块只描述事件；TUI 和 serve 组合根决定是否、在哪里写。这样同一业务能力在测试、TUI、serve 中可以分别使用 capture/no-op/file logger，而不改变业务逻辑。

### 2.2 安全 API，而非安全约定

Logger 只接受静态 event definition 和由其 schema 推导的 input。definition 内的 encoder 决定哪些字段存在以及如何转换；如果 API 接受 `unknown`、开放 `Record<string, unknown>`、自由 string 或 printf 参数，敏感边界最终会退化成 review 习惯。

### 2.3 默认 fail-open，显式坏配置 fail-fast

- 实际选择创建 process logger 的命令若明确设置非法 `OHBABY_LOG_LEVEL`/目录：启动报错；未使用日志能力的 library/reused serve 不解析该配置；
- 默认目录因环境不可用：关闭日志、业务继续、受控提示一次；
- 运行中 writer 失败：关闭日志、通知一次；
- `flush()`/`dispose()` 的 bounded drain 失败：不覆盖业务退出码。

这区分了“用户要求的配置没有被满足”和“附属诊断能力临时不可用”。

### 2.4 每个进程只管理自己的文件

不引入文件锁，也不让 TUI/serve 共享固定文件。唯一文件名和单持有者轮转减少竞态、KISS 且便于按运行实例排障。

## 3. TypeScript 合同草案

开放的 `logger.trace("event", { prompt: text })` 即使有文档约束也能通过类型检查，因此不作为最终方案。首版改用“静态事件定义 + 每字段 encoder”：level、event、component、字段名和转换策略在模块加载时一次定义，调用点只能提供该事件的输入。

精确命名可在实现时微调，但能力边界应保持：

```ts
type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

// package-internal and not exported
declare const diagnosticEventDefinitionBrand: unique symbol;

interface DiagnosticEventDefinition<Input> {
  // required nominal brand: callers cannot structurally forge `{}`
  readonly [diagnosticEventDefinitionBrand]: (input: Input) => Input;
}

interface Logger {
  emit<Input>(
    definition: DiagnosticEventDefinition<Input>,
    input: Input,
  ): void;
}

const providerRequestFailed = defineDiagnosticEvent({
  level: "error",
  event: "provider.request.failed",
  component: "llm",
  fields: {
    operationId: field.ohbabyId(),
    attempt: field.integer(),
    error: field.externalError(),
  },
});

logger.emit(providerRequestFailed, { operationId, attempt, error });
```

brand 负责 TypeScript nominality；builder 同时把创建出的对象登记到 package-internal `WeakSet`/identity registry，`emit()` 在运行时拒绝手写对象、spread clone 和其他伪造 definition。builder 的泛型签名拒绝 widened `string` event/component，运行时再检查静态格式。brand symbol、registry 和最终 record sink 都不导出。

约束：

- definition 应当由模块级 `const` 复用，event/component 使用字面量和受限静态格式，不能来自请求数据；首版通过 TypeScript 字面量约束、opaque brand、运行时 identity/格式校验实现安全边界，不为“顶层声明”这一风格要求自研 AST lint；
- component 使用封闭的内置集合；用户定义实体只能进入始终 hash 的专用 field encoder，不能成为 component/event/key；
- 字段 encoder 首版只提供 integer/number、boolean、受限 enum、ohbaby ID、hashed external ID、normalized path/URL、始终 hash 的 user entity name 和 safe error；内置名称必须由静态 enum allowlist 表达，不提供可由调用者伪造 provenance 的联合输入，也不提供任意 text/object encoder；
- error encoder 接收原始 unknown 只是为了立即转换，不把 raw Error 放入最终 event，也不公开可构造的 `SafeLogError`；external encoder 不接受自由 summary 字符串，使用内部稳定类别/通用摘要；
- runtime encoder 仍检查字段、secret 形态和大小；类型系统用于防误用，不被宣称为安全沙箱；
- 生产 logger 不暴露 `sink.write(record)` 给普通业务代码；
- 测试 capture logger 留在测试辅助目录，不成为生产/public API。

跨包组合还需要一个窄生命周期句柄，概念上包含：

```ts
interface ProcessLoggerHandle {
  readonly logger: Logger;
  /** Exact active JSONL path; composition roots may expose it as product UI. */
  readonly logFilePath: string;
  /** Non-closing, bounded barrier for exceptional composition needs/tests. */
  flush(): Promise<void>;
  /** Idempotent: stop intake, bounded drain, close writer. */
  dispose(): Promise<void>;
}
```

factory 接收 `role`、level、目录、运行时 roots 和一次性的 `onUnavailable` 回调。具体 FileWriter/Rotator/Queue 保持 internal。

### 3.1 首批事件目录

Phase A 先固定能形成真实垂直切片的最小目录，只实现这些事件与 policy 必需的 encoder，不为假想事件提前建设字段体系：

| Event | Level | Component | 安全字段 |
| --- | --- | --- | --- |
| `diagnostics.started` | info | diagnostics | `role` |
| `logger.events_dropped` | warn | diagnostics | 各 level 丢弃计数 |
| `session.title_generation.failed` | warn | session | 安全错误类别 |
| `llm.usage.normalization` | debug | llm | code、protocol、token 数值 |
| `migration.config.completed` | info | migration | copied/conflicts/merged/skipped 计数 |
| `migration.data.completed` | info | migration | copied/conflicts/merged/skipped 计数 |
| `server.started` | info | server | 规范化 endpoint |
| `server.start.failed` | error | server | safe error |
| `server.stopped` | info | server | reason enum |
| `server.stop.failed` | error | server | reason enum、safe error |
| `ui.interaction.cleanup.failure` | warn | server | operation kind、安全错误 |

首批事件不包含 agent/MCP/skill 名称，因此 Phase A 只实现“用户名称始终 hash、内置名称静态 enum allowlist”的两个单向入口及合成输入测试，不改 registry。未来第一个确需实体名称的事件必须在同一阶段由配置来源选择正确入口；来源缺失时只能按用户名称 hash 或省略，不能按名称猜测。

### 3.2 开发者一次性调试流程

1. 单个局部值优先使用 debugger 或聚焦测试；
2. 偶发时序/竞态增加临时的模块级类型化 debug/trace definition，只使用已有 encoder；
3. 通过 `OHBABY_LOG_LEVEL=debug|trace` 复现并读取本次精确日志路径；
4. 修复后删除临时事件；若证明有持续价值，则加入首批/后续事件目录与测试。

不得以调试为由增加任意 context、raw object、正文 encoder 或临时终端输出。

`ohbaby-agent` 是已发布包。跨包唯一公开面明确为：`Logger`、`DiagnosticEventDefinition`、`defineDiagnosticEvent()`、受限 `field` encoders、process logger factory 及其 options/handle 类型。`SafeLogError`、encoded record、FileWriter、Rotator、Queue 和测试 capture 均不公开。这样 server 能定义自己的静态事件并安全转换 Error，又不依赖内部文件实现。

## 4. 配置解析

### 4.1 公开配置

| 环境变量 | 默认 | 规则 |
| --- | --- | --- |
| `OHBABY_LOG_LEVEL` | `info` | 只接受五种 level，大小写不猜测 |
| `OHBABY_LOG_DIR` | `<ohbaby-home>/logs` | 必须为绝对路径；role 子目录由实现添加 |

`.env.example` 中当前孤立的 `LOG_LEVEL=info` 应替换为真实合同，避免同时存在两个名字。现有代码内部使用的 `OHBABY_DEBUG` 也在迁移 title/token 旁路时删除，不保留一个会重新打开 stderr 的兼容别名。changelog/迁移说明必须同时记录两项公开行为变化：`OHBABY_DEBUG` 被替代；migration helper 在未传 `onWarning` 时从默认 `process.emitWarning` 改为静默返回 report（`onWarning` API 本身保留）。首版公开配置仍只有上表两项。

只有当前命令实际选择创建 process logger 时才解析并验证这两项配置：TUI、fresh serve，以及未来显式 opt-in 的 one-shot CLI。direct library no-op 与 reused serve 不消费日志配置，因此不能因一个未使用的 `OHBABY_LOG_*` 值失败。

### 4.2 固定内部策略

- 8 MiB/段；
- 3 段/进程（活动段 + 2 个轮转段）；
- 清理 14 天前历史；
- POSIX 目录 `0700`、文件 `0600`；
- 1,024 条已编码事件队列；
- 2 秒 `flush()` barrier / `dispose()` drain；
- 16 个扩展字段、512-byte 普通字符串/error message、8-KiB stack、16-KiB JSONL 行上限。

首版不增加 `MAX_BYTES`、`MAX_FILES`、`RETENTION_DAYS` 等环境变量。以后若真实使用反馈需要调整，先改变内部常量；只有用户确实需要控制时才公开配置。

## 5. 模块放置与职责

建议在 `packages/ohbaby-agent/src/observability/` 下形成一个内聚模块。文件名可随实现收敛，但职责应保持：

| 职责 | 建议位置 | 公开性 |
| --- | --- | --- |
| `Logger` / event definition / field encoders | `logger.ts`、`event-definition.ts` | 跨包所需的窄类型与 builder 公开 |
| no-op logger | `noop-logger.ts` | 可由工厂/类型内部使用；不要求公开单例 |
| 进程 logger factory/handle | `process-logger.ts` | 仅组合所需入口公开 |
| JSONL 编码与字段上限 | `jsonl.ts` | internal |
| `safeError` 与 secret 清洗 | `safe-error.ts` | internal，由公开 error field encoder 调用 |
| path/URL/name 标准化 | `normalization.ts` | internal 或仅测试可见 |
| 有界串行文件 writer/轮转 | `file-writer.ts` | internal |
| 配置解析 | `config.ts` | factory 内部使用 |

不放在 `ohbaby-sdk`：sdk 是共享协议/领域边界，本地文件系统、process env 和 rotation 不属于它。不分别放在 agent/server：那会出现两套敏感策略。当前 server 和 cli 都已经依赖 agent，因此不会形成新的依赖环。

### 5.1 默认启用边界

“默认 `info`”只指用户通过 ohbaby CLI 启动的 TUI/serve 产品形态，不等于所有公开 library factory 都无条件写用户目录：

- CLI TUI 显式请求 role=`tui` 的 process diagnostics；
- CLI 的 serve options 显式传入 lazy diagnostics capability；
- 直接调用公开 `buildCoreAPIImpl()`、`createInProcessUiBackendClient()` 或 `startDaemonServer()` 而未传 capability 时默认 no-op，不产生本地文件副作用；
- `startDaemonServer()` 只有确认不是复用已有 server 后才调用 lazy capability，因此不会产生伪 server 日志。

该 capability 是跨包公开 options seam，因为 `startDaemonServer()` 本身是公开 API；具体 factory/handle 仍由 agent 提供。CLI 已声明依赖 agent，但当前 TypeScript 工程只直接 reference server/sdk。实现采用 agent 的 type-only import 保持单一合同，值仍沿用 `bin.ts` 现有动态 runtime loader；同时在 `packages/ohbaby-cli/tsconfig.json` 增加 agent reference，并在 `tsup.config.ts` 将 `ohbaby-agent` 设为 external，不能复制一份结构相似但漂移的 logger 接口。

公开 seam 在设计上定稿为：

```ts
interface StartDaemonServerOptions {
  readonly diagnosticsFactory?: (
    context: ServeDiagnosticsContext,
  ) => Promise<ProcessLoggerHandle>;
  readonly onDataMigrationReport?: (
    report: OhbabyMigrationReport,
  ) => void;
}

interface CoreApiFactoryOptions {
  readonly logger?: Logger; // absent => no-op
}
```

`ServeDiagnosticsContext` 只包含 server 确认 fresh 后才知道的安全 composition 数据（role、初始 workspace root、ohbaby home）；factory 由 CLI 提供并持有 `onUnavailable` presenter。server 不直接读取 CLI stdout/stderr。`onDataMigrationReport` 是只观察 fresh server 数据迁移结果的公开 seam：未传时没有输出副作用，回调异常按诊断旁路 fail-open，不能改变迁移结果。TUI 则由 CLI 先创建 handle，再把 `logger` 传入 `buildCoreAPIImpl()`/in-process backend；这两个 library factory 未传时 no-op。

迁移不新增一套新的 `MigrationNotice` 数据模型。现有 `OhbabyMigrationReport` 不能区分“symlink 被跳过”和普通 skip，也不能可靠恢复 conflict 与 sibling 的对应文案，因此保留 `onWarning?: (message: string) => void` 作为**仅供用户 presenter 使用**的 seam；删除的只是无回调时 `process.emitWarning` 的 fallback。helper 同时返回现有 report，diagnostics projector 只读取 `copied/conflicts/merged/skipped` 的计数，绝不接收 warning 文案，也绝不把 report 数组中的字符串送进 logger。`LoadRuntimeEnvResult` 增加 `configMigrationReport`，`migrateOhbabyData()` 继续直接返回 report。

## 6. 组合方式

### 6.1 TUI in-process

TUI 的实际 composition root 横跨 `runOhbabyCli()`、terminal handler 与默认依赖中的 `createCoreHost()`，不能只在 Ink 已经 render 后才创建 logger。目标顺序是：

1. `loadRuntimeEnvIntoProcessEnv({ onWarning })` 在读取全局 env 和知道命令前完成 config migration：`onWarning` 只把用户文案放进当前启动过程的内存 buffer，不写终端；函数把 `configMigrationReport` 连同 project root 返回；
2. yargs 确定进入 TUI 后，CLI 解析已经加载的 `OHBABY_LOG_*`，显式创建 role=`tui` 的 process logger；
3. TUI 本地 composition 调用 `migrateOhbabyData()` 并保留返回的 data report；config warning buffer 由 CLI presenter 呈现，config/data 两份 report 由 diagnostics projector 只记录四类计数。data migration 当前没有 warning 文案；若它抛错，命令层显示受控失败，logger 只接收 `safeError` 投影；
4. 将 logger 注入 in-process backend 的顶层 options；直接调用 agent public factory 而不注入时仍为 no-op；
5. 由 agent runtime composition 向 title、provider、MCP/skill 等确有需要的服务继续传递；
6. TUI 新增一个 CLI 本地的 diagnostics notice source：render 前接收 migration warning startup buffer，render 后可订阅一次性 unavailable；它不进入 SDK/domain event bus；`/status` 在本地追加当前 `logFilePath`，正常输入区不自动打印路径；
7. `onUnavailable` 最多触发一次，其回调异常必须被 logger 吞掉，不能形成第二故障；
8. TUI handler 是 process handle 的唯一拥有者：先等待/停止 Ink 并 dispose backend，再调用一次幂等且内含 2 秒 drain 的 logger `dispose()`；顶层异常还要确保 Ink 先恢复终端再做最终错误呈现。`onUnavailable` presenter 显式跟踪 `buffering | tui-active | terminal-restored` 三个 phase：活跃期走 UI notice；Ink 恢复后才在 drain 中出现的首次失败，由 CLI 命令层向 stderr 写一条固定、安全、非 JSON 的警告，仍保持全生命周期最多一次。

现有 migration helpers 的 `onWarning` 保留，但默认 `process.emitWarning` 删除：没有显式回调时只返回 report，不产生终端副作用。CLI 的启动装配在 env 加载前传入统一 `StartupNoticeBuffer.push()`；第一次 `takeAll()` 原子清空，重复调用返回空。TUI 在 Ink render 前消费，普通命令在 handler 入口消费；`runOhbabyCli()` 的 `finally` 对仍未消费的内容执行一次固定、安全的 stderr 兜底，覆盖 parse/usage/早期失败以及未来命令遗漏。直接调用 helper 的 library 调用者读取 report，或显式传 `onWarning` 自行呈现；调用 `startDaemonServer()` 的 library 调用者如需 fresh data report，显式传 `onDataMigrationReport`，否则安静忽略。warning 文案不得作为 logger message/field。

不采用全局 stdout patch，也不要求所有模块从全局 singleton 取 logger。若某个深层服务的注入成本过高，应优先在其已有 factory/options 边界加可选 `logger`，默认 no-op；不能用临时 console 绕过。

### 6.2 `ohbaby serve`

CLI serve 调用公开 `startDaemonServer()` 时传入 lazy diagnostics capability、`onDataMigrationReport`，并在命令层持有早期 config migration warning buffer/report。`startDaemonServer()` 先完成已有 server 的复用判定；只有确认当前进程将启动新 server 后，才在 data migration 之前调用 capability 创建 role=`serve` 的 process logger，并把 handle 传入 `startFreshDaemon`。若只是连接/复用已有 server，则不创建一份伪 server 日志，也不产生 data migration report；config warning 仍由当前命令层呈现：

- 传给 server app/backend；
- 调用 `migrateOhbabyData()`，将返回 report 交给 `onDataMigrationReport`；CLI 将 config warning buffer 投影为命令层提示，并只把 config/data report 的计数投影为安全事件；
- 以 adapter 或统一 port 替换 supervisor 的 `CONSOLE_LOGGER` 默认行为；
- 将 `reportInteractionCleanupFailure()` 改为安全事件；
- serve 命令仍拥有 `web ready` 等产品输出；
- fresh serve 在同一产品输出中显示 `diagnostics: <exact logFilePath>`；reused serve 不创建也不显示伪路径；
- 日志初始化/运行失败只由 serve 命令层提示一次；
- `SupervisorOptions` 增加明确的 `disposeDiagnostics` 生命周期回调。`stopInternal()` 先完成 runtime/state/pid 清理并记录最终 success/failure event，再 dispose，最后才 return/throw；signal/idle 调用方不得在 dispose 后再次用 logger 记录 catch；signal `exit()` 位于其后。2 秒 drain 由 handle 内部保证；start 失败时同一 handle 穿过 EADDRINUSE retry，只有最终失败才由外层 dispose；
- 业务 backend/supervisor 只接收 `Logger`，process handle 由实际 server composition 持有，不在多层重复 dispose。

虽然代码中类名包含 daemon，但当前同一 serve 进程使用同一个 logger handle；未来若真正拆成独立 OS 进程，自然会因 pid/instance 生成另一份独占文件，无需改变文件协议。

全局 serve 运行后可以动态打开其他 workspace。首版 normalization roots 以进程启动时的 scope 为准；额外 workspace 的绝对路径保守写为 `<external>/<hash>`，不在首版引入可变多 workspace root registry。若未来排障确实需要把它们显示为 `<workspace>`，再设计 scoped normalization context。

### 6.3 one-shot CLI

不作为首要接入面，但回归上必须保证 logger 不写其 stdout 协议。若实现顺手复用 process logger，role=`cli`；否则可先保持 no-op，后续按真实诊断需求接入。

## 7. 现有输出迁移映射

| 当前位置 | 当前行为 | 目标行为 |
| --- | --- | --- |
| title generator | `OHBABY_DEBUG` + stderr | `warn` 安全降级事件；用户界面不新增噪音 |
| token usage | `OHBABY_DEBUG` + JSON stderr | `debug`/`trace` token 数值元数据，无正文 |
| ohbaby-home migration | `process.emitWarning` | 显式 `onWarning` 进入组合根用户提示；helper report 只生成计数型 `warn` 诊断元数据 |
| supervisor default logger | stdout/stderr + unknown metadata | 注入 logger + 静态 supervisor event definitions；无终端默认副作用 |
| interaction cleanup | 硬编码 stderr JSON | `warn`/`error` 安全事件，按最终影响定级 |
| top-level errors | 命令层 stderr | 保留受控产品错误；同时可有 `safeError` 日志投影 |
| command recorder | 显式结构化 sink | 保持独立，不自动接入 logger |

迁移时不要求“一条现有输出机械对应一条日志”。如果事件对排障没有价值，可以删除；如果同时具有用户可行动含义，则拆成 UI 提示与日志事件两条经过各自策略的投影。

## 8. 分阶段实施与 commit 边界

### Phase A - 核心合同与文件实现

范围：

- `logging-policy` 对应的类型、level filter、JSONL encoder；
- path/URL/name normalization、`safeError`；
- 进程独占文件、有界队列、轮转、权限、保留、flush/dispose；
- config parser 与无 I/O/no-op；
- lint 防回归规则：默认禁止 agent/server 生产源码新增 stdout/stderr/console/emitWarning，现有旁路使用逐文件临时 allowlist；`services/database/connection.ts` 对 Node SQLite warning 的窄拦截保留为永久说明性 allowlist；测试文件单独 override；
- `diagnostics.started` 真实写入，证明 Phase A 已形成可读取的垂直切片；
- 完整 unit/contract tests。

完成门：不接 TUI/serve 也能证明安全合同、writer 生命周期、失败退化，并能从真实文件读取 `diagnostics.started`。单独 commit。

### Phase B - TUI in-process 接入

范围：

- terminal composition 创建/持有 logger；
- agent backend 顶层 logger 注入；
- title/token/migration 等旁路迁移；
- early config migration warning buffer/report、data migration report、local notice source、unavailable 的 phase-aware UI/CLI 通知与退出 dispose；
- 删除 title/token/migration 对应的临时 lint allowlist；
- TUI 真实子进程/PTY 回归。

完成门：slash command、prompt、退出、日志失败时均无原始 JSON 插入 Ink 画面，JSONL 可见安全事件。单独 commit。

### Phase C - serve 与 Web backend 接入

范围：

- serve composition 创建 logger；
- supervisor 和 create-app cleanup 旁路迁移；
- 删除 supervisor/create-app 对应的临时 lint allowlist，此时 agent/server 生产源码的完整门生效；
- start/stop/signal/failed startup 的日志与一次性用户提示；
- 真实构建产物启动、HTTP/Web e2e 与日志检查。

完成门：serve 启动终端只有产品输出/受控警告，后台诊断进入独占 JSONL。单独 commit。

### Phase D - 进程退出与崩溃恢复加固

范围：

- TUI unmount、uncaught failure、signal 的先恢复终端后呈现错误；
- TUI root 与实际 server composition 各自持有 process handle；supervisor 通过显式强类型 dispose seam 协调 signal 退出；
- dispose 内部限时 drain、非关闭 `flush()` barrier、尾记录和 writer mid-run failure 测试。

完成门：真实子进程证明不挂死、不改变原退出码、尾事件按合同 best-effort。单独 commit。

### Phase E - 用户错误展示标准化（先过设计检查点）

范围：

- 将有限的高频错误映射为清晰 title/summary/action；
- 优先复用现有 operation/run/request ID 关联 UI 与日志；只有确无安全关联 ID 且 UI 有明确需求时才另行设计 diagnostic ID；
- TUI/serve 按交互上下文显示；
- 重试性由运行时策略决定，不写进静态 error registry。

当前直接编码范围只包括已经确认的两处一致性修复：stdout renderer 的 runtime failure 保留 `IrisError.code`，TUI 两个本地 `formatError()` 复用共享格式。其余错误产品化仍需先补一个小型错误清单（建议 2–3 个真实高频错误）、代码入口、UI action、动态 retry 条件和验收场景，经用户确认后再编码。

后续设计检查点至少要审计三类现有 surface：daemon state 的 `error` 字段、server HTTP/RPC error response、TUI 的最终失败提示；还要把 supervisor `retire(reason)` 等自由 reason 改成内部 enum code 或经过批准的安全字段，不能通过另一种状态文件/response 重新引入 raw message。

### Phase F - 全量验收与文档收尾

范围：

- lint、typecheck、unit、integration、build、compiled Web e2e；
- 真实 TUI/serve 画面与 JSONL 样例；
- 回写实际变更、偏差、命令和结果到 `05-implementation-acceptance.md`。

文档与测试收尾可单独 commit。完成后仍等待用户决定是否 merge/push。

## 9. 文件级变更面

预计触及但不锁死行号：

- `packages/ohbaby-agent/src/observability/**`：新增核心；
- `packages/ohbaby-agent/src/index.ts`：只导出跨包必要 API；
- `packages/ohbaby-agent/src/utils/project-env.ts`、migration：report 返回值、显式 presenter callback 与默认无终端副作用；
- `packages/ohbaby-agent/src/agents/registry.ts` 及相关 provenance：只有首批事件确实需要 agent 名称时才保留来源信息；否则事件省略该名称；
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`、runtime composition 与相关 service options：注入；
- title generator、token usage、migration：迁移现有旁路；
- `packages/ohbaby-server/src/runtime/daemon/{main,supervisor,types}.ts`：serve 生命周期组合；
- `packages/ohbaby-server/src/app/create-app.ts`：logger option 与 cleanup 事件；
- `packages/ohbaby-cli/src/cli/commands/{terminal,serve}.ts`、`src/bin.ts`、CLI runtime types/TUI options：lazy capability、root 生命周期、本地 notice source；
- `packages/ohbaby-cli/tsconfig.json`、`tsup.config.ts`：若采用 agent 静态导入，增加直接 reference/external；
- `.env.example`：真实配置名；
- `eslint.config.js`：禁止内部层直接终端写入；
- 各模块共置测试和 `tests/integration/cli/**`：合同与真实进程覆盖；
- Web compiled e2e 测试：用户行为与 serve 日志联合验收。

Web 前端本身不是首版 logger 的代码落点，但通过 `ohbaby serve` 使用的 backend 和用户可见 Web 行为属于验收范围。

## 10. 错误展示与 logger 的边界

“日志地基”先解决可观测性与隐私；“错误产品化”后解决用户能否理解和行动。二者共享关联 ID 和错误分类，但不共享原始字符串。

不采用一个全局静态表宣称 `retryable: true/false`，原因是同一错误在读取、创建、流式中断、非幂等提交等不同阶段可能有不同重试安全性。正确做法是：

- domain/adapter 提供稳定错误类别；
- 当前 operation policy 计算是否允许重试；
- UI 根据当前状态展示动作；
- logger 记录实际 `retryScheduled`、attempt、outcome 等元数据。

## 11. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 自研 logger 逐渐膨胀 | 固定首版能力，非目标清单，公开 API 最小 |
| 过度 DI 导致改动扩散 | 从现有 top-level factory/options 传递，可选 logger 默认 no-op |
| 任意字段泄露内容 | 安全字段类型、单一 safeError、禁止 raw object、负向测试 |
| 文件轮转竞态 | 每进程独占文件，不跨进程共享轮转 |
| logger 失败再次污染 TUI | writer 不碰终端，一次性回调由组合根显示 |
| 异步写丢尾记录 | 有界串行队列 + 单一拥有者幂等 dispose + 真实子进程测试 |
| lint 把合法产品输出也禁掉 | 默认限制 agent/server 全部源码，对 CLI 产品入口和确有协议所有权的极窄位置做 allowlist |
| error 展示阶段拖大首批 | 日志地基先交付，错误产品化独立 Phase E |

## 12. 回滚策略

每一阶段独立 commit：

- Phase A 尚未接入业务，可直接回滚模块；
- B/C 接入失败可把组合根恢复为 no-op，而不恢复底层 stdout/stderr；
- writer 出现环境兼容问题可临时禁用文件实现，但保留 logger port 与输出所有权；
- 不以“回滚”为理由重新启用正文、共享日志文件或 writer 直写终端。
