# 5. 实施验收文档

> 撰写时机：实施完成后，由 `plan-code-improvement` 验收模式独立检查后撰写。本文件只记录验收结论与偏差，不修改实现代码。

## 5.1 元信息

| 项 | 值 |
| --- | --- |
| 议题 / 批次 | `2026-08-28-command-record-stdout-pollution` · `improve-1` |
| 规划文档版本 | 本目录 00/01/02/04 当前工作区版本（含实施期第三轮收敛：不接 `OHBABY_DEBUG`、不加 SDK 共享 no-op、精确 lint） |
| 实施范围 | `main@e4d5061` 之后的工作区改动：16 个已跟踪文件 + 6 份新增 problem-list 文档 + 1 个新增进程测试 |
| 验收日期 | 2026-08-28 |
| 结论 | **通过，无未关闭的交付阻断项**。承重改动全部落地；收尾又补齐 Agent/Server 注入 recorder 不由 host flush 的反向断言、`false` 与三种 `NODE_ENV` 的组合用例、TDD 先红记录、TUI PTY/Web E2E 证据与两处文档锚点。 |

验收基线说明：本次实施期间规划文档被再次收敛（`00 §6` 最后一条），本验收一律以**当前**的 00/02/04 为契约，不以更早版本判定偏差。

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
| --- | --- | --- | --- |
| Phase A-1/2 `sink` 必填、factory 参数必填 | 完成 | `StructuredUiCommandRecorderOptions.sink` 去掉 `?`；factory 移除 `= {}` 默认值 | [command-recorder.ts:7](../../../../packages/ohbaby-agent/src/host/command-recorder.ts) `:103` |
| Phase A-3 构造期运行时校验 | 完成 | 新增 `assertExplicitSink()`，非函数 sink 抛 `TypeError: UI command recorder sink must be a function`；在 capacity 校验之前执行 | `command-recorder.ts:17-24, 35` |
| Phase A-4 删除 `defaultSink()` / `defaultDiagnostic()` | 完成 | 两个函数整体删除，模块内已无 `process.*` 引用 | diff：`-17` 行 |
| Phase A-5 `onDiagnostic` 可选且缺省 no-op | 完成 | `NOOP_DIAGNOSTIC` 常量替代原 stderr 实现 | `command-recorder.ts:15, 43` |
| Phase A-6 保留队列语义 | 完成 | capacity / FIFO / `flush()` / fail-open / 单队列 owner 代码未改动 | `command-recorder.ts:47-101` 无 diff |
| Phase A-7 单文件 ESLint 禁令 | 完成 | `no-restricted-properties` 精确匹配 `command-recorder.ts`，含说明性 message | [eslint.config.js:39-58](../../../../eslint.config.js) |
| Phase B Agent-1/2 undefined/false → 本地 no-op | 完成 | resolver 收敛为单个三元表达式 | [core-api-factory.ts:29-36](../../../../packages/ohbaby-agent/src/host/core-api-factory.ts) |
| Phase B Agent-3 删除 `NODE_ENV` 分支与自动 factory | 完成 | 分支与 `createStructuredUiCommandRecorder` import 一并删除 | diff：`-33` 行 |
| Phase B Agent-4 删除 terminal reporter，不传 `onDiagnostic` | 完成 | `reportCommandObservationFailure()` 删除；gateway 只收 `entryPoint` + `recorder` | `core-api-factory.ts:84-87` |
| Phase B Agent-5 删除默认 structured 句柄与 dispose flush | 完成 | `commandRecording.structured?.flush()` 删除，dispose 其余顺序不变 | `core-api-factory.ts:96-108` |
| Phase B Server-1/2 同形策略 + 保留私有 no-op | 完成 | 三分支 if/else 收敛为一个三元；`structuredCommandRecorder` 字段删除 | [create-app.ts:847-850](../../../../packages/ohbaby-server/src/app/create-app.ts) |
| Phase B Server-3 保留 `reportInteractionCleanupFailure()` | 完成 | 函数与调用点均在 | `create-app.ts:99-103, 2180` |
| Phase B Server-4 REST/RPC 行为不变 | 完成 | 87 个 Server app 单测全绿，含既有 record 合同 | 见 §5.5.1 |
| Phase C-1..5 进程级回归测试 | 完成 | 新增两条真实子进程用例，含 production env、清除 `OHBABY_DEBUG`、隔离 HOME/XDG/DB/storage/cwd/model 配置、等待 `close`、断言退出码与两个 stream | [command-record-terminal.integration.test.ts](../../../../tests/integration/cli/command-record-terminal.integration.test.ts) |
| Phase C-6 真实 TUI / Web E2E 运行验收 | 完成 | 真 PTY 中运行构建后 TUI `/status` 并检查 Ctrl+C 退出尾部；compiled Web 在真实浏览器中完成 UI、backend、reload 与 cleanup 证据 | 见 §5.5.2 |
| Phase C-7 同步权威文档 | 完成 | SDK 3 篇 + SDK test + UI 2 篇 + Server 3 篇共 9 个文件更新，均写入“默认 no-op、显式注入才记录、caller-owned 生命周期” | 见 §5.6 |
| Phase C-8 独立审查 | 完成 | Cursor 验收先记录缺口；主进程闭环后，独立子代理复验确认无 P0/P1/P2/P3 findings | §5.5.1 与收尾审查记录 |

## 5.3 规划 vs 实际差异（基础指标对账）

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
| --- | --- | --- | --- | --- |
| 数据结构（record/端口） | `UiCommandRecord`、`UiCommandRecorder.record()` 不变 | 与规划一致 | — | 无 |
| 数据结构（recorder options） | `sink` 必填，`capacity`/`onDiagnostic` 仍可选 | 与规划一致 | — | 公开 API breaking，已在 02 §2.5 声明 |
| 数据流 | gateway → 注入 recorder；默认落到本地 no-op；无 process I/O | 与规划一致 | — | 无 |
| 协议/接口 | REST/RPC/SSE/wire 不变；不新增 options 字段 | 与规划一致，`CoreApiFactoryOptions` / `DaemonServerAppOptions` 字段数未变 | — | 无 |
| 文件/包结构 | 3 个源文件 + eslint + 1 个新增 integration + 9 篇文档 | 与规划一致 | — | 无 |
| 错误处理/边界行为 | 缺 sink 构造期 `TypeError`；sink 失败 fail-open 且默认静默 | 与规划一致 | — | 无 |
| 依赖变更 | 无 | 无新增依赖；Agent host 与 Server 各减少一个对 `command-recorder` 的 import | — | 依赖方向更干净 |
| 附带改动 | 02 未提及 | `create-app.ts` `dispose()` 因删除唯一 `await` 而新增 `@typescript-eslint/require-await` 的 inline disable + 理由注释 | 保留 `async` 以维持“同步 throw 也变成 rejected Promise”的既有调用契约 | 可接受；替代方案（去掉 `async`）会改变调用方错误传播时序 |

结论：**没有实质性方案偏离**。唯一非规划改动是上表最后一行，属删除 `await` 后的必要副产物，且选择了对调用方零影响的方向。

## 5.4 实施理由与注意事项

### 关键取舍

1. **resolver 收敛为三元表达式而非多分支**：`undefined` 与 `false` 语义合并后，原来的 4 分支 resolver 只剩一个判断。Agent 侧甚至不再需要返回 `{ recorder, structured }` 复合对象，函数签名直接返回 `UiCommandRecorder`。这是本批复杂度净减少的主要来源。
2. **`assertExplicitSink` 放在构造函数最前**：先于 capacity 校验，保证“配置错误”在最早时刻以最具体的信息失败，而不是等到第一条 record 才发现无处投递。
3. **保留两份私有 no-op**：按 00 §3 决策，不为 6 行空实现扩大 SDK 公共 API。代价是两份副本必须保持行为一致——它们都只有一个空 `record()`，语义漂移的现实风险很低。
4. **lint 只锁根因文件**：`create-app.ts` 有语义不同的合法 stderr 输出（`reportInteractionCleanupFailure`），全目录禁令会迫使加入更多 inline disable，反而降低规则的信号强度。

### 给后续维护者的注意项

1. **`createStructuredUiCommandRecorder()` 目前零生产调用方**，只有单测使用它，同时仍从 `packages/ohbaby-agent/src/index.ts` 公开导出。这是 04 §4.10 第 10 条明确接受的状态（公开 API 不因“内部没人用”而删除）。若长期没有集成方出现，可另立议题讨论是否收为 internal——**但不得以“制造调用方”为理由重新引入隐式 I/O 或 debug 分支**。
2. **注入方的队列尾部记录不会被自动 drain**。`dispose()` 只操作自己创建的资源，不对注入对象做 duck typing。集成方必须自己持有 concrete 句柄并在合适时机 `flush()`。该合同已写入 `docs/ohbaby-sdk/dfd-interface.md` 与 `docs/ohbaby-server/architecture.md`。
3. **lint 保护范围有边界**。`core-api-factory.ts` 与 `create-app.ts` 若再次引入 `process.stdout/stderr` 写入，ESLint **不会**报错；兜底依赖单测的 stream spy 与两条子进程用例。修改这两个文件时应主动意识到这一点。
4. **`NOOP_DIAGNOSTIC` 与旧行为的一个隐含变化**：旧实现的默认 diagnostic 会把错误名收敛为 `"Error"` 以防泄漏调用方可控名称（原测试 `does not expose caller-controlled error names`）。现在 sink 失败的原始 error 对象**原样**交给显式 `onDiagnostic`。脱敏责任随之转移给注入方——这是端口所有权的正确划分，但集成时需要注意不要把原始 error 直接打到共享终端。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

#### Phase A

| ID | 结果 | 证据 |
| --- | --- | --- |
| T-A1 缺 sink | 通过 | `requires an explicit sink without writing to terminal streams`：断言 `TypeError` 且 stdout/stderr 两个 spy 均未被调用 |
| T-A2 显式 async sink FIFO | 通过 | `delivers accepted records to an async sink in order` |
| T-A3 capacity 满 | 通过 | `rejects synchronously when its bounded intake is full` |
| T-A4 sink reject 无 diagnostic | 通过 | `contains sink failures without default terminal diagnostics`：`flush()` resolve 且两个 stream 静默 |
| T-A5 / T-A6 显式 diagnostic 与其自身抛错 | 通过 | `contains sink and diagnostic failures` |
| T-A7 lint 门 | 通过（已实测生效） | 向 `command-recorder.ts` 注入一行 `process.stdout.write` 后 `eslint --stdin` 报 `no-restricted-properties`；同样内容注入 `core-api-factory.ts` 不报错，符合 02 §2.2 的精确范围决策 |

#### Phase B · Agent

| ID | 结果 | 证据 |
| --- | --- | --- |
| T-B1 recorder undefined | 通过 | 参数化用例在 production/test/development 三种环境分别执行 command + dispose，两个 stream 均不含 `ui.command.` |
| T-B2 recorder false | 通过 | 与 undefined 同一参数化矩阵，三种环境全部执行真实 gateway 路径 |
| T-B3 显式 recorder 合同 | 通过 | 既有 `builds CoreAPI and callback adapters...` 中的 record 断言全绿 |
| T-B4 显式 recorder reject | 通过 | `keeps Agent host business writes successful and terminal-silent when the recorder fails`：旧的“stderr 出现 observation JSON”断言已被替换为“两个 stream 均无 `ui.command.`” |
| T-B5 dispose 不调用非端口 flush | 通过 | `leaves an injected recorder lifecycle with its caller`：先确认 `record()` 收到 started/completed，再确认 host dispose 没有调用额外 `flush()` |
| T-B6 环境一致性 | 通过 | production/test/development × undefined/false 共 6 个组合全绿 |
| T-B7 进程默认静默 | 通过 | 子进程用例 `keeps production stdout and stderr clean through command execution and dispose`，退出码 0 |

#### Phase B · Server

| ID | 结果 | 证据 |
| --- | --- | --- |
| T-C1 recorder undefined/false | 通过 | production/test/development × undefined/false 参数化矩阵覆盖完整 |
| T-C2 显式 recorder 合同 | 通过 | `records one JSON-RPC primitive with transport correlation`、`records a REST prompt exactly once at the server boundary with a raw Agent backend` |
| T-C3 显式 recorder reject | 通过 | `keeps REST and RPC writes successful and terminal-silent when the recorder fails` |
| T-C4 app dispose 不 flush 外部 recorder | 通过 | `leaves an injected recorder lifecycle with its caller`：RPC command 先产生两条 record，app dispose 后额外 `flush()` 仍为 0 次 |
| T-C5 多 scope 默认无 record I/O | **部分** | 既有 scope/session 隔离测试全绿；未新增“多 scope 默认无 record I/O”的专门断言 |
| T-C6 环境一致性 | 通过 | production/test/development × undefined/false 共 6 个组合全绿 |
| T-C7 cleanup reporter 未被误删 | 通过（静态） | 函数与调用点均保留；该行为历史上也无专门测试，本批未新增 |
| T-C8 真实 serve 进程静默 | 通过 | 子进程用例 `keeps the actual serve process terminal clean through RPC command and shutdown`，shutdown 后退出码 0 |

#### 全量回归（04 §4.8）

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| 目标单测（recorder / gateway / Agent host / Server app / SDK command-record） | 通过，5 文件 118 用例 |
| 新增 process integration | 通过，2 用例（含真实构建产物） |
| `pnpm test` | 通过：**303 文件通过 / 5 skipped，2794 用例通过 / 16 skipped，0 失败**（最终全量复跑耗时 325.26s）。前一轮仅 `auto-saves /connect without API key env or value` 因等待 Ink frame 超时失败；该用例随即单独复跑通过，并在最终全量复跑中再次通过，未发现产品断言或本批回归失败。`project.integration`、`packaging-smoke`、`global-single-serve` 与新增 command-record 子进程测试均通过 |
| `pnpm build` | 通过（integration 用例的 `beforeAll` 以 `status===0` 断言构建 sdk/agent/server/cli，其中 cli build 链含 `ohbaby-web`） |

#### 收尾跟踪

| ID | 原验收发现 | 最终状态 | 闭环证据 |
| --- | --- | --- | --- |
| G-1 | T-B2 / T-C1 的 `commandRecorder: false` 无断言 | 已关闭 | Agent/Server 均增加 undefined/false 参数化用例 |
| G-2 | T-B6 / T-C6 未覆盖 development | 已关闭 | 两组参数化用例均覆盖 production/test/development |
| G-3 | 无“不调用注入对象 flush”的断言 | 已关闭 | Agent/Server 各新增 `leaves an injected recorder lifecycle with its caller`，先证明 record 真实到达，再断言 flush 为 0 次 |
| G-4 | T-C5 多 scope 默认无 record I/O 无专门断言 | 接受为低风险存量缺口 | 既有多 scope 合同全绿；默认 I/O 由 Server composition 单测和真 serve 子进程独立覆盖，本批不复制第三条重叠用例 |
| G-5 | T-C7 cleanup reporter 无专门自动化回归 | 接受为低风险存量缺口 | 源码函数与唯一调用点均保留；该行为与 command record 边界不同，不为本 Bug 扩围 |
| G-6 | “旧实现先红”过程无记录 | 已关闭 | 实施前目标 unit 实跑产生 6 个预期失败；进程回归在旧实现上 1 例失败，stdout 捕获到两条 `ui.command.record` |
| G-7 | TUI / serve surface 验收无记录 | 已关闭 | 真 PTY TUI、compiled Web 浏览器 E2E 与真 serve 进程 stream 证据记入 §5.5.2 |
| G-8 | 01 §1.3 的 SDK gateway 路径不存在 | 已关闭 | 已改为 SDK `command-record.ts` + Agent `host/ui-command-gateway.ts` |
| G-9 | 02 §2.4 的 TUI package 路径不存在 | 已关闭 | 已改为 `packages/ohbaby-cli/src/tui/**` |

#### 对抗性复查（对照 04 §4.10）

| # | 攻击面 | 结论 |
| --- | --- | --- |
| 1 | 只是把 stdout 换成 stderr | 已关闭：单测与子进程用例同时断言两个 stream |
| 2 | 仍在 `NODE_ENV=test` 假绿 | 已关闭：`NODE_ENV` 分支删除；单测显式 stub production；子进程强制 production |
| 3 | 宿主 `OHBABY_DEBUG` 污染测试 | 已关闭：`createIsolatedEnvironment()` 显式 `delete environment.OHBABY_DEBUG` |
| 4 | 只等一轮微任务漏 late flush | 已关闭：父进程等待子进程 `close`，子进程执行完整 `dispose()`/shutdown |
| 5 | 从 TUI 层过滤表象 | 已关闭：TUI 目录无改动 |
| 6 | 为测试新增无收益公共 API | 已关闭：SDK 源码零改动 |
| 7 | 新增无调用方配置 | 已关闭：两个 options 接口字段数未变 |
| 8 | 误删 Server 其他 stderr | 已关闭：`reportInteractionCleanupFailure` 保留 |
| 9 | 破坏显式 recorder 合同 | 已关闭：既有 REST/RPC record 合同测试全绿 |
| 10 | 把“无内部调用方”当作可删公开 API | 已关闭：factory 保持导出，仅 sink 必填 |
| — | **残余风险** | lint 不覆盖两个 composition root（02 §2.2 的显式取舍）；多 scope 默认 I/O 与 cleanup reporter 没有各自专用的重复用例，但对应子合同和跨进程主路已被覆盖，不阻断本批交付 |

### 5.5.2 TUI / Web / E2E 验收记录

| Surface | 实际操作 | 结果 |
| --- | --- | --- |
| in-process TUI 真 PTY | 使用构建后 CLI，在隔离 HOME/cwd/model 配置、`NODE_ENV=production`、无 `OHBABY_DEBUG` 的真实 PTY 中启动 TUI，输入 `/status`，观察 Status overlay 后 Ctrl+C 退出 | overlay 正常显示 Runtime/Model/Project 等信息；操作中及退出尾部均无 `ui.command.*` / raw `{"record":...}`，Ink 输入框与光标未被旁路输出打乱 |
| compiled Web 浏览器 E2E | 启动构建后 `ohbaby serve`，在真浏览器中完成 fixture tool 调用、follow-up、reload 与 session 保持，再提交 UI 证据并执行 cleanup | `E2E_UI_EVIDENCE_PASS`、`E2E_BACKEND_PASS`、`E2E_CLEANUP_PASS` 全部产生；backend 请求、tool result 消费、PID 与端口释放均符合合同 |
| 真 `ohbaby serve` terminal stream | 自动子进程启动构建后 CLI，带 auth/workspace 走 HTTP/RPC `/status`，调用 shutdown endpoint 并等待 `close` | 业务响应和退出码均成功；完整 stdout/stderr 均不含 `ui.command.` |

### 5.5.3 SWE 层面评估（聚焦改动面）

大白话结论：**这是一次质量明显高于平均水平的 Bug 修复**。它没有在表层打补丁，而是把“记录写到哪里”这个决策从低层队列模块彻底移走，顺带让两个 composition root 的代码变短、分支变少。三个源文件净减少 54 行（`+27 / −81`），删掉的全是隐式副作用和环境分叉，没有引入新抽象、新配置或新依赖——修 Bug 同时降低了复杂度，这在棕场改造里是理想结果。

| 发现 | 严重性 | SWE 依据 | 建议 |
| --- | --- | --- | --- |
| 隐式全局 I/O 被彻底移除，目的地改为显式依赖 | 亮点 | 依赖倒置 / 信息隐藏：低层模块不再反向控制全局终端资源 | 保持；不要以任何理由恢复默认 sink |
| 环境分叉删除，测试与生产走同一条 resolver | 亮点 | 最小惊讶原则；测试真实性（原设计让测试系统性掩盖生产 Bug） | 保持；三环境 × undefined/false 矩阵已成为回归门 |
| resolver 由 4 分支复合返回值收敛为单表达式 | 亮点 | KISS；圈复杂度与返回类型同时简化 | 无 |
| 回归防护从人工 review 升级为 lint + 行为测试 + 真实子进程三层 | 亮点 | 可验证性：否定命题（“没有输出”）需要多层独立证据 | 保持；三层缺一不可，勿降级子进程用例为可选 |
| `assertExplicitSink` 用 `asserts options is T` 断言签名，但调用点参数已是该类型 | 极低（工艺） | 该断言对 TS 无净收益，实际只服务 JS 调用方；一个普通 `if + throw` 更直白 | 可选简化；当前写法无正确性问题 |
| 两份私有 `NOOP_COMMAND_RECORDER` 副本 | 低（已决策） | DRY 与公共 API 面的权衡，00 §3 已明确取舍 | 保持；两者都只有空 `record()`，漂移风险可接受 |
| lint 只保护 1 个文件，两个 composition root 无静态防护 | 中（残余风险） | 防御纵深：最容易再次引入 terminal 写入的恰是 composition root | 若未来该处再出问题，可加“允许清单式”规则（禁止 `process.stdout`，对已知合法 stderr 点加带理由的 disable） |
| caller-owned lifecycle 合同被反向断言锁定 | 亮点 | 测试是活文档；防止未来重新加入端口外 duck typing | 保持 Agent/Server 两个 lifecycle 用例 |
| 显式 diagnostic 现在收到原始 error 对象（旧实现会收敛错误名） | 低（需知会） | 端口所有权正确转移，但脱敏责任随之转移 | 已记入 §5.4 注意项 4；未来集成方文档需强调 |

架构层面（`swe-architecture-design` 框架 4 视角）：本批不涉及超时、幂等、限流或鉴权变更；`fail-open` 降级语义保持不变且有测试；无持久化或 wire 协议改动，因此没有不可逆的单向门。唯一对外契约变更是 `createStructuredUiCommandRecorder()` 的 sink 必填，属编译期可发现、运行期 fail-fast 的良性 breaking，已有迁移说明要求。

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
| --- | --- | --- |
| [packages/ohbaby-agent/src/host/command-recorder.ts](../../../../packages/ohbaby-agent/src/host/command-recorder.ts) | `sink` 改必填；删除 `defaultSink()`/`defaultDiagnostic()` 的 process 写入；新增构造期 `assertExplicitSink()` 与 `NOOP_DIAGNOSTIC` | 修改（+13 / −17） |
| [packages/ohbaby-agent/src/host/core-api-factory.ts](../../../../packages/ohbaby-agent/src/host/core-api-factory.ts) | resolver 收敛为 undefined/false → 本地 no-op；删除 `NODE_ENV` 分支、自动 structured recorder、terminal reporter 与 dispose flush | 修改（+8 / −33） |
| [packages/ohbaby-server/src/app/create-app.ts](../../../../packages/ohbaby-server/src/app/create-app.ts) | 同形 resolver；删除 `structuredCommandRecorder` 字段、环境分支、observation reporter 与 flush；保留 cleanup reporter；`dispose()` 增加 require-await 的理由性 disable | 修改（+6 / −31） |
| [eslint.config.js](../../../../eslint.config.js) | 新增仅匹配 `command-recorder.ts` 的 `no-restricted-properties`，禁止 `process.stdout` / `process.stderr` | 修改（+20） |
| [tests/integration/cli/command-record-terminal.integration.test.ts](../../../../tests/integration/cli/command-record-terminal.integration.test.ts) | 新增两条 production 子进程用例：in-process host command+dispose、真实 `ohbaby serve` RPC+shutdown；完全隔离 env 与数据路径 | 新增 |
| [packages/ohbaby-agent/src/host/command-recorder.unit.test.ts](../../../../packages/ohbaby-agent/src/host/command-recorder.unit.test.ts) | 新增缺 sink fail-fast 用例；把“默认 diagnostic 收敛错误名”改为“默认无 terminal diagnostic” | 修改 |
| [packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts](../../../../packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts) | 增加三环境 × undefined/false 默认静默矩阵、显式 recorder fail-open 双 stream 断言，以及注入 recorder 不由 host flush 的 lifecycle 反向断言 | 修改 |
| [packages/ohbaby-server/src/app/create-app.unit.test.ts](../../../../packages/ohbaby-server/src/app/create-app.unit.test.ts) | 增加三环境 × undefined/false 默认静默矩阵、显式 recorder fail-open 双 stream 断言，以及注入 recorder 不由 app flush 的 lifecycle 反向断言 | 修改 |
| [docs/ohbaby-sdk/goals-duty.md](../../../ohbaby-sdk/goals-duty.md) | D6 补“SDK 不提供默认 recorder 目的地；默认 composition 本地 no-op；集成者拥有 flush/dispose” | 修改 |
| [docs/ohbaby-sdk/architecture.md](../../../ohbaby-sdk/architecture.md) | 明确 observation contract 不决定写到哪里，低层不得隐式选择 stdout/stderr | 修改 |
| [docs/ohbaby-sdk/dfd-interface.md](../../../ohbaby-sdk/dfd-interface.md) | 记录默认提交给本地 no-op；显式 recorder 是借入端口，不做端口外方法探测 | 修改 |
| [docs/ohbaby-sdk/test.md](../../../ohbaby-sdk/test.md) | 新增默认终端静默且不依赖 `NODE_ENV` 的测试要求与子进程捕获要求 | 修改 |
| [docs/ui/goals-duty.md](../../../ui/goals-duty.md) | 明确 in-process backend 不得旁路写 stdout/stderr，约束落在 recorder/composition 而非 TUI 过滤 | 修改 |
| [docs/ui/test.md](../../../ui/test.md) | 新增 §2.4 in-process 终端集成测试要求（production env、隔离环境、禁止用 test 分支假绿） | 修改 |
| [docs/ohbaby-server/architecture.md](../../../ohbaby-server/architecture.md) | 明确 Server 默认注入本地 no-op、不按环境自动创建 sink、不替外部 recorder drain | 修改 |
| [docs/ohbaby-server/dfd-interface.md](../../../ohbaby-server/dfd-interface.md) | 写操作流程补默认 no-op；ServerHandle 生命周期不含注入 recorder | 修改 |
| [docs/ohbaby-server/test.md](../../../ohbaby-server/test.md) | 新增“默认 command terminal policy”矩阵项与不回退清单条目 | 修改 |

## 5.7 后续维护备忘（不阻断本批交付）

1. 若未来修改多 scope composition，可将“默认无 record I/O”直接合并到该次多 scope 行为用例，而不是在本批复制一条只为填矩阵的测试。
2. `reportInteractionCleanupFailure()` 属于另一个 observation 边界；若其行为未来改动，应在那个议题中补专门回归，不应与 command record 终端污染混为一批。
3. `createStructuredUiCommandRecorder()` 仍是公开 API；若长期无生产集成方，可另立议题讨论收为 internal，但不得以“制造调用方”为理由恢复隐式 I/O。
