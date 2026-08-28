# 2. 优化方案与改动面

## 2.1 方案总览

采用“保留 observation 合同、取消隐式 I/O、显式集成才记录”的最小方案：

```text
默认 TUI / serve
  command gateway
    → local NOOP_COMMAND_RECORDER
    → 无 stdout / stderr
    → dispose 无 recorder flush

显式集成
  integration owner
    → 创建 sink-backed recorder
    → 注入 Agent 或 Server
    → integration owner 负责 flush / dispose
```

`UiCommandRecord` 仍由 gateway 生成；默认产品只是不再为它选择用户终端这个隐式目的地。

## 2.2 设计决策表

| 议题 | 决策 | 原因 | 不采用 |
| --- | --- | --- | --- |
| structured sink | `sink` 类型必填，运行时缺失立即 `TypeError` | 目的地是构造 recorder 的必要依赖 | 默认 stdout、逐条静默丢弃 |
| diagnostic | 可选；缺失时内部 no-op | sink 失败仍 fail-open，但不隐式写 stderr | 默认 stderr、增加 composition option |
| 默认 Agent/Server policy | `undefined` 与 `false` 均返回本地 no-op | 环境无关、符合默认静默 | `NODE_ENV` 分叉、自动 structured recorder |
| no-op 归属 | Agent/Server 保留各自私有常量 | 数行私有实现不值得扩大 SDK API | SDK 共享 singleton |
| gateway diagnostic | composition 不传 `onDiagnostic` | SDK seam 已存在；没有真实终端消费者 | 硬编码 stderr、新 options |
| debug | 本批没有 command record debug 分支 | 用户已明确先修 Bug，不建日志系统 | 复用 `OHBABY_DEBUG`、新增 flag/env |
| lifecycle | 显式注入者拥有 drain/flush/dispose | composition 不能安全假定外部对象的生命周期 | host/app 替注入者 flush |
| lint | 只对 `command-recorder.ts` 禁止 `process.stdout/stderr` | 精确守住根因且不误伤别的产品输出 | 全 host/app 禁令、人工 review |
| production regression | 真实子进程显式 `NODE_ENV=production`、清除 debug env、隔离 HOME/cwd | 覆盖真实默认路径和 late flush | 仅 Vitest spy |

## 2.3 分阶段实施

### Phase A — 收紧 recorder 的隐式 I/O 合同

文件：`packages/ohbaby-agent/src/host/command-recorder.ts`

1. `StructuredUiCommandRecorderOptions.sink` 从可选改为必填。
2. factory 参数从默认 `{}` 改为必填。
3. 构造阶段运行时校验 sink；JavaScript 或错误类型绕过 TS 时也给出清晰 `TypeError`。
4. 删除 `defaultSink()` 与 `defaultDiagnostic()` 的 process stream 写入。
5. `onDiagnostic` 保持可选；未提供时 no-op。
6. 保留 capacity、FIFO、单队列 owner、fail-open、`flush()` 与显式 diagnostic 语义。
7. 在 `eslint.config.js` 增加只匹配本文件的 `no-restricted-properties`，禁止 `process.stdout` 与 `process.stderr`。

这一阶段的 TDD 证据：旧实现下“缺 sink 应失败”和“sink reject 默认不写 stderr”必须先红。

### Phase B — Agent host 与 Server 默认 no-op

Agent：`packages/ohbaby-agent/src/host/core-api-factory.ts`

1. `commandRecorder === undefined || commandRecorder === false` → 本地 `NOOP_COMMAND_RECORDER`。
2. 显式 recorder → 原样注入。
3. 删除 `NODE_ENV === "test"` 分支和自动 structured factory。
4. 删除 command observation terminal reporter，不给 gateway 传 `onDiagnostic`。
5. 删除默认 structured recorder 句柄与 dispose flush。
6. 其他 dispose 顺序保持不变。

Server：`packages/ohbaby-server/src/app/create-app.ts`

1. 使用与 Agent 同形的 undefined/false/explicit 策略，但保留自己的私有 no-op。
2. 删除环境分支、自动 structured recorder、command observation reporter 与 app-owned recorder flush。
3. 保留无关的 `reportInteractionCleanupFailure()`；不扩大本批范围。
4. REST/RPC、scope 隔离、session 与 Web 行为保持不变。

这一阶段的 TDD 证据：Agent/Server 在显式 production env 下默认 stream 静默；显式 recorder 合同继续通过。

### Phase C — 真实 surface、文档与回归门

1. 新增 `tests/integration/cli/command-record-terminal.integration.test.ts`。
2. 第一个子进程从构建产物加载 `buildCoreAPIImpl()`，执行一次 `executeCommand()`，随后 `dispose()`。
3. 第二个子进程启动真实 `ohbaby serve`，通过 HTTP/RPC 执行 `/status`，调用正常 shutdown，并等待 daemon 退出。
4. 两个子进程都显式设置 `NODE_ENV=production`，删除 `OHBABY_DEBUG`，并将 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG 目录、`OHBABY_HOME`、`OHBABY_DB_PATH`、`OHBABY_STORAGE_ROOT`与 cwd 完全指向临时根。
5. 父进程捕获完整 stdout/stderr 并等待 close，断言退出成功且两个 stream 都不含 `ui.command.`。
6. 运行真实 TUI slash command、compiled Web E2E 与项目回归；检查操作中和退出后都无 record JSON。
7. 同步 SDK、UI、Server 权威文档。
8. 独立子代理执行代码审查与验收，主进程处理有效发现。

## 2.4 按包/目录的改动面

| 文件/目录 | 修改 | 不修改 |
| --- | --- | --- |
| `packages/ohbaby-sdk/src/**` | 权威说明按需同步 | record 类型、gateway、公共 no-op、options |
| `packages/ohbaby-agent/src/host/command-recorder.ts` | sink 必填、默认 diagnostic 静默、无 process I/O | 队列、capacity、flush、显式 diagnostic |
| `packages/ohbaby-agent/src/host/core-api-factory.ts` | 本地默认 no-op、删 env/auto recorder/reporter/flush | 显式 recorder、其他 host composition |
| `packages/ohbaby-cli/src/tui/**` | 测试/文档验证 | 不加过滤器，不 patch stream |
| `packages/ohbaby-server/src/app/create-app.ts` | 本地默认 no-op、删 env/auto recorder/reporter/flush | cleanup reporter、REST/RPC/session 行为 |
| `eslint.config.js` | recorder 单文件精确 I/O 禁令 | 不限制整个 host/app |
| `tests/integration/cli/**` | production 子进程 stream 回归 | 不访问外部模型 API |
| `docs/ohbaby-sdk/**`、`docs/ui/**`、`docs/ohbaby-server/**` | 同步默认 policy 与生命周期 | 不扩展日志产品设计 |

## 2.5 API、协议与兼容

### 保持不变

- `UiCommandRecord` schema、phase、operationId、correlation、details、outcome；
- `UiCommandRecorder.record()` 端口；
- Agent/Server 的 `commandRecorder?: UiCommandRecorder | false` 注入能力；
- gateway 的 fail-open、脱敏和命令执行语义；
- wire/REST/RPC 协议。

### 有意收紧

公开工厂 `createStructuredUiCommandRecorder()` 不再允许缺省 sink：

```ts
createStructuredUiCommandRecorder({ sink });
```

这是公开 API 的 breaking change。TypeScript 调用方在编译期得到提示；JavaScript/`any` 调用方在构造期得到清晰 `TypeError`。发布说明需要同时写明默认终端污染修复与显式 sink 迁移方式。

### 显式注入方的生命周期合同

Agent/Server 只借用注入的 `UiCommandRecorder`，不会探测或调用非端口方法。若集成者注入具有队列的 structured recorder：

- 创建者负责保存 concrete 句柄；
- 创建者负责在合适时机 `flush()`；
- 创建者决定失败诊断的去向；
- host/server 的 `dispose()` 不替它 drain。

这样避免 composition 对端口外能力做 duck typing，也避免错误关闭一个被多方共享的 recorder。

## 2.6 风险与回滚

| 风险 | 防御 | 回滚边界 |
| --- | --- | --- |
| 外部调用方依赖默认 sink | 类型收紧 + runtime guard + 发布迁移说明 | 恢复签名前必须仍要求显式目的地，不能恢复 stdout |
| 默认静默导致以为 audit 丢失 | 文档明确“显式注入才记录”；现有 explicit recorder 测试保留 | 通过上层明确集成 sink，不改低层默认 |
| recorder 失败影响业务 | 保留 gateway 与队列 fail-open 测试 | 可回滚局部异常处理，不恢复 terminal reporter |
| dispose 丢显式注入者尾记录 | 写清调用方生命周期合同并做 contract test | 由集成层持有/flush concrete recorder |
| lint 误伤合法 stderr | 规则仅匹配 recorder 单文件 | 缩窄 AST 规则，不删除行为测试 |
| 测试仍走 test 分支假绿 | 子进程显式 production 且清理 env | 该进程用例是必需发布门，不得降级为可选 |
| 相邻 migration warning 仍出现 | 文档明确不在本批，验收只匹配 `ui.command.` | 后续独立问题处理 |

## 2.7 与讨论边界对齐

| 边界 | 方案对应 |
| --- | --- |
| 不建 log/debug 系统 | 没有 command record env/flag/sink 产品路径 |
| 默认终端干净 | Agent/Server 在所有 env 的 undefined/false 都 no-op |
| 不破坏 observation | gateway、record schema、显式 injection 不变 |
| 不加无调用方 seam | 不加 Agent/Server diagnostic option |
| 不扩大 SDK 公共面 | 两个本地 no-op 保留 |
| 不在 UI 掩盖根因 | TUI 无过滤/stream patch |
| 验收真实生产路径 | production 子进程 + TUI/Web/E2E |
| 不误伤其他输出 | lint 仅保护 recorder 根因文件 |

## 2.8 不在本批

- command record 的持久化、远端上传、日志级别、采样、轮转与 UI viewer；
- `OHBABY_DEBUG` 的统一治理；
- migration warning 的终端策略；
- wire schema 或数据库迁移；
- merge、push、发布。
