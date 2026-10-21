# 5. 实施验收文档

> 2026-10-21 由验收会话独立检查后撰写。实施会话原先在本文件里写过一份实施记录，其中的测试证据、手工操作和既有 E2E 失败调查都并入了本文，并标明哪些是验收会话复核过的，哪些是实施会话的自报结果。

## 5.1 元信息

| 项 | 值 |
|---|---|
| 议题 / 轮次 | ohbaby-sdk 与 ohbaby-server 结构整理 / improve-1 |
| 规划文档 | `3c6ed4cc` 提交的 00–04，加上 2026-10-21 实施中补充的 Stage 1b |
| 实施范围 | 分支 `codex/sdk-server-boundaries`，`7bc75168..d78fc65f`，共 4 个代码提交：Stage 1 `cc15cb73`、Stage 2 `f6bcfb5b`、Stage 1b `cb0e2ed9`、Stage 3 `d78fc65f` |
| 验收日期 | 2026-10-21 |
| 结论 | **通过**。四个阶段全部按 02 落地，行为没有变化，04 的结构检查和自动测试全部通过。原审查的 4 项事项已更新状态，见 §5.4.2。用户随后要求修复既有 E2E 并合入 main，补充验收见 §5.8 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---|---|---|---|
| Stage 1 sdk 分目录、`rpc/` 改名 | 完成 | `src/` 下只剩 `index.ts` 和 `contract/`、`sync/`、`slash-command/`、`in-process-rpc/`、`util/`。移动的文件只改了相对 import，`index.ts` 只改了路径，四个 `export *` 保留 | `cc15cb73`；C1、C2 |
| Stage 2 `DaemonStartupIntent` 收进 sdk | 完成 | 定义放在 `contract/daemon-startup-intent.ts`；server 的 `protocol.ts` 引入后用 `export type` 再导出；CLI 删除私有副本；Web 用了规划允许的别名方式（`WebStartupIntent = DaemonStartupIntent`） | `f6bcfb5b`；C3–C5 |
| Stage 1b `command-record.ts` 移到 agent | 完成 | 源文件和单测原样移到 `packages/ohbaby-agent/src/host/`（git 识别为 100% 重命名）；sdk 删除 12 个导出；agent 入口用 `export type` 导出 `UiCommandCorrelation`、`UiCommandRecord`、`UiCommandRecorder`；server 改为从 agent 引入这 3 个类型 | `cb0e2ed9`；C11、C12 |
| Stage 3 拆分 `create-app.ts` | 完成 | `create-app.ts` 从 3409 行降到 396 行。新增 `app/openapi.ts`、`app/sse-hub.ts`、`app/static-assets.ts`、`protocols/web/request-helpers.ts`、`protocols/web/routes/` 下的 `context.ts` 和 8 个路由模块；`rpc-route.ts` 新增 `registerRpcRoute` | `d78fc65f`；C6–C10 |
| D1 sdk 架构文档 | 完成 | `docs/ohbaby-sdk/architecture.md` 的文件树、依赖规则、命令记录归属已更新 | 文档 diff |
| D2 server 架构文档 | 完成 | `docs/ohbaby-server/architecture.md` 列出新文件 | 文档 diff |
| D3 hono-app/01 | 完成 | 写明路由拆分已落地，`middleware/*` 仍是目标 | 文档 diff |
| 连带文档 | 完成 | `hono-app/00`、`02`（`/doc` 改指 `app/openapi.ts`）、`03`（`DaemonSseHub`）、`06`、`README`、`non-functional.md`、`docs/ohbaby-sdk/test.md` 已同步 | 文档 diff |

## 5.3 规划与实际的差异

| 维度 | 规划（02） | 实际 | 原因 | 影响 |
|---|---|---|---|---|
| 数据结构（字段、函数名、类型） | 类型名不变 | 与规划一致。只有 abort 的注册函数叫 `registerSessionAbortRoutes`，规划里举的例子是 `registerSessionAbortRoute` | 命名风格统一用复数 | 无 |
| 数据流 | 不变 | 与规划一致。`/doc` 改为调用 `ctx.createOpenApiDocument()`，运行时内部仍然调用 `createOpenApiDocument(this.options.packageVersion)`，结果等价 | 路由模块拿不到 `options.packageVersion` 以外的运行时细节 | 无 |
| 协议和接口 | HTTP、JSON-RPC 不变；sdk 导出 +1 −12；agent 新增 3 个类型导出 | 与规划一致。sdk 导出从 271 个变成 260 个，差异正好是新增 `DaemonStartupIntent`、移除 command-record 的 12 个名字 | — | 外部若使用了这 12 个名字，需要迁移；只有 `UiCommandCorrelation`、`UiCommandRecord`、`UiCommandRecorder` 可从 agent 根入口导入，其余 9 个不再公开，下次发布说明要写明 |
| 文件和包结构 | 见 02 §2.1 | 与规划一致。`request-helpers.ts` 还收了 `CLIENT_ID_HEADER` 和 `DEFAULT_WEB_STARTUP_INTENT`，被 `static-assets.ts` 引用（app 引用 protocols，方向允许） | 这两个常量原本就和 helper 放在一起 | 无 |
| 错误处理和边界行为 | 不变 | 与规划一致。鉴权调用、状态码、错误体、await 顺序都没变（见 §5.5.1 的比对） | — | 无 |
| 依赖变更 | 不改 package.json、tsconfig、eslint | 与规划一致，这些文件都没改 | — | 无 |
| 运行时类的可见性 | 规划没提 | `DaemonServerAppRuntime` 实现 `DaemonRouteContext` 后，原来的 `private` 字段（包括 `options`）变成了公开字段 | 路由通过接口访问这些字段 | 这个类不对外导出，影响限于 server 包内部，见 §5.5.2 |
| 文档范围 | 02 §2.9 写 `docs/ohbaby-sdk/goals-duty.md` 不需要改 | 改了：D6 从“写操作记录合同”改为“写操作记录边界”，概述里去掉了 command-record；`data-model.md`、`dfd-interface.md`、`packages/ohbaby-agent/README.md` 也同步了归属 | Stage 1b 是实施中补加的，规划写那句话时还没有这个阶段 | 修改内容与代码一致，属于合理偏离 |

## 5.4 实施理由与注意事项

### 5.4.1 关键取舍

- **Stage 1b 在 Stage 3 之前提交**，按 02 的建议避免和 `create-app.ts` 的拆分冲突。
- **`DaemonRouteContext` 直接由运行时类实现**，没有另写一个适配对象。可变的 `permissionEpoch` 通过 getter 读取，`registeredWebClientIds`、`knownClientIds`、`waitControllers` 都是同一个引用，没有按值复制的可变状态。
- **`DaemonSseHub` 延迟读取 context**：它在 `eventBus` 赋值之前就被构造，但只在调用时读取，所以构造顺序没有问题。
- **结构重构保留测试断言**：Stage 3 的提交不碰测试文件；Stage 1/1b 只搬移测试或调整导入。后续按用户要求单独修复既有 E2E，见 §5.8，不混入原结构重构提交。

### 5.4.2 待办（不阻塞合并）

| # | 事项 | 建议 |
|---|---|---|
| 1 | 三个 `.log` 证据在审查时尚未暂存 | 已在 `09a7446d` 提交，链接可用 |
| 2 | 02 §2.8 和议题 README 链接了尚未提交的 LLM 规划目录 | 已改为议题名称，不提前提交用户仍在编辑的 LLM 文档；后续在独立分支实施 |
| 3 | 既有 E2E 失败，在基线 `7bc75168` 上同样失败（§5.5.3） | 按用户追加要求修复，独立提交；见 §5.8 |
| 4 | 走 daemon 的 TUI 模式（`--remote-port`）用户反馈可能有问题，用户确认不在本轮范围 | 单独排查；排查前不要把实施会话的 TUI 冒烟结果当作这个模式没有问题的证明 |

### 5.4.3 给后续维护者

- 新增 REST 路由时，在对应领域的 `routes/*.ts` 里加，并在 `mountRoutes()` 里按想要的注册顺序调用；`GET /*` 必须保持最后一条。
- 路由模块只通过 `DaemonRouteContext` 访问运行时。不要在路由里直接 import `app/` 下的文件，04 的 S3-7 可以检查这一点。
- `rpc-route.ts` 现在 889 行（本轮前 783 行，多出的是挪进来的 `/api/rpc` 处理函数），超过规划给新文件定的 600 行软目标。它不是新文件，本轮不处理，可以作为后续拆分候选。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

“复核”表示验收会话亲自跑过或读过代码，“自报”表示采用实施会话的记录、验收会话没有重跑。

| 验收 ID | 结果 | 证据 | 来源 |
|---|---|---|---|
| S1-1 sdk 导出 | 通过 | 用 TypeScript compiler API 分别解析 `7bc75168` 和当前的 `src/index.ts`：271 → 260，`diff` 只有 +`DaemonStartupIntent` 和 −12 个 command-record 名字 | 复核 |
| S1-2 旧 `rpc/` 路径 | 通过 | 命令无输出；`src/` 下没有 `rpc/` 目录 | 复核 |
| S1-3 sdk 依赖方向 | 通过 | 命令无输出 | 复核 |
| S1-4 进程内 RPC | 通过 | 包含在全量测试中 | 复核 |
| S1b-1 sdk 无残留 | 通过 | 第一条命令无输出；第二条只命中 agent 和 server（外加 `packages/ohbaby-agent/README.md`），不命中 cli、web、sdk | 复核 |
| S1b-2 server 从 agent 取类型 | 通过 | 多行匹配命令无输出 | 复核 |
| S1b-3 命令记录行为 | 通过 | 包含在全量测试中 | 复核 |
| S2-1 只剩一份定义 | 通过 | 只命中 `contract/daemon-startup-intent.ts:2` | 复核 |
| S2-2 server 导出 | 通过 | typecheck 通过；`protocol.ts` 用 `export type` 再导出 | 复核 |
| S2-3 Web 构建 | 通过 | `pnpm --filter "ohbaby-web..." build` 退出码 0 | 复核 |
| S2-4 启动意图端到端 | 通过 | 包含在全量测试中（含 `tests/integration/cli/daemon-*`） | 复核 |
| S3-1 现有测试不改即通过 | 通过 | `d78fc65f` 不改任何测试文件；全量测试通过 | 复核 |
| S3-2 路由清单一致 | 通过 | 静态比对：两个子代理分别把原 `mountRoutes`（L1329-2841）与 17 个注册函数按调用顺序拼接后的函数体比对，去掉空白和尾逗号、把 `this.` 换成 `ctx.` 后，只有 `/doc` 一处等价差异。运行时比对：实施会话构造 Hono app，比对 49 条有序路由完全一致 | 静态比对为复核，运行时比对为自报 |
| S3-3 兜底路由最后 | 通过 | `create-app.ts:311-316`，在所有注册函数之后 | 复核 |
| S3-4 SSE 重放与断线清理 | 通过，有保留 | `DaemonSseHub` 的方法体与原 L2968-3394 一致，`dispose()` 保持原来的清理顺序（复核）。实施会话在 Web 空闲时断网约 2.5 秒后恢复，内容不丢不重（自报）。**没有验证正在生成回复时断网的场景** | 部分复核 |
| S3-5 `create-app.ts` 规模 | 通过 | 396 行；只直接注册 `GET /`、`GET /*` | 复核 |
| S3-6 无跨工作区依赖 | 通过 | 命令无输出 | 复核 |
| S3-7 无反向依赖 | 通过 | 命令无输出 | 复核 |

**全量检查（复核）：**

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 0 个错误，122 个警告；本轮改动的文件里只有 4 个警告，都在 `ui-inprocess.contract.test.ts` 远离改动的旧代码处，本轮没有新增警告 |
| `pnpm run format:check` | 通过 |
| `pnpm exec vitest run --passWithNoTests --no-file-parallelism` | 576 个文件通过、1 个失败、6 个跳过；6830 项通过、1 项失败、17 项跳过。失败的是 `tests/integration/cli/packaging-smoke.integration.test.ts`：原因是验收会话在全量测试运行期间另外执行了一次 Web 构建，两边同时清空并重建 server 的 `dist`，导致 Web 的 `tsc` 找不到 `ohbaby-server` 的类型声明。之后单独重跑这个文件，通过。实施会话的全量运行中它也通过 |

另外，实施会话记录中写的 `pnpm test --no-file-parallelism` 在当前 pnpm 版本下会报 `Unknown option: 'file-parallelism'`。要跑这条命令，请用 `pnpm exec vitest run --no-file-parallelism` 或 `pnpm test -- --no-file-parallelism`。

**手工操作（自报）：**

- 编译后的 Web 实际操作：发送读取 `fixture.txt` 的请求、展开工具面板、追加消息、刷新后会话不变且两轮回复各出现一次、空闲断网后恢复。退出后进程和端口都已释放。
- 编译后的 TUI，在真实 PTY 中连接 HTTP daemon（模型由本地 fixture 提供）：提交提示词、收到回复、退出后用 `--continue` 恢复历史，两次退出码都是 0。
- `pnpm run build` 通过，打包后的 CLI `--version` 输出 `0.1.16`。

### 5.5.2 回归与对抗性复查

| 04 回归项或攻击面 | 结果 |
|---|---|
| 远程 TUI 连接、提交、收事件 | 实施会话的 PTY 冒烟通过；用户反馈这个模式可能还有问题，不在本轮范围（§5.4.2 第 4 项） |
| Web 建会话、发消息 | 实施会话手工通过 |
| Web 处理权限请求、看子代理对话 | **没有手工执行**，只有自动测试和代码比对覆盖 |
| `/doc` 与拆分前一致 | 实施会话比对了 26 个 OpenAPI 路径和完整 JSON，一致；代码比对确认 `openapi.ts` 与原函数一致 |
| 鉴权遗漏 | 已关闭。两个子代理的函数体比对都确认，每个 `isAuthorized`、`authorizePromptMutation` 调用都还在原位置，且在任何副作用之前 |
| 路由顺序 | 已关闭（S3-2、S3-3） |
| 可变状态按值复制 | 已关闭（§5.4.1） |
| SSE 清理遗漏 | 已关闭。运行时 `dispose()` 依次中止并清空 `waitControllers`、取消订阅、调用 `sseHub.dispose()` |
| `protocols/` 反向依赖 `app/` | 已关闭（S3-7） |

**残余风险**：正在生成回复时断网再恢复的 SSE 行为，以及 Web 上权限对话框和子代理对话的手工操作，都没有人工验证。代码比对显示相关逻辑原样搬移，风险低。

### 5.5.3 既有 E2E 失败调查（修复前记录）

```bash
OHBABY_RUN_GOAL_REAL_E2E=0 OHBABY_RUN_IDLE_REAL_E2E=0 pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts --no-file-parallelism
```

`goal-execution.e2e.test.ts:322` 期望最后一条 user 消息包含 `<untrusted_objective>`，实际取到的是后面另一条带 `<system-reminder>` 的 user 消息。实施会话在一个独立 worktree 里用基线 `7bc75168` 跑了同一条命令，同一个用例、同一个断言失败。原因是测试里的 `lastUserText()` 直接取最后一条 user 消息，而现在的 serializer 会把环境提示拆成单独一条消息。这属于测试维护问题，结构重构阶段没有修改运行时或测试来消除失败。（自报，验收会话没有重跑。）后续修复会话重新复现并完成修复，见 §5.8。

### 5.5.4 SWE 层面评估

**结论**：这是一次干净的结构重构。复杂度被真正减少了，不是挪到了别处：一个 3409 行的文件变成了十几个职责单一的文件，最大的 587 行。依赖方向变得更清楚，行为保持不变。整轮没有引入新的抽象层、框架或配置。下面几条是可以改进的地方，都不需要在本轮处理。

| 发现 | 严重性 | SWE 依据 | 建议 |
|---|---|---|---|
| `DaemonRouteContext` 有约 20 个成员，基本把运行时整个暴露给了每个路由模块 | 低 | 接口隔离：每个模块应该只依赖它用到的部分。不过本轮是纯搬移，先用一个接口把依赖显式列出来，已经比原来隐式的 `this` 好 | 以后某个领域的路由要大改时，再给它定义更窄的 context，不要为了形式现在就拆 |
| 运行时类的字段从 `private` 变成公开 | 低 | 信息隐藏。这个类不导出，影响限于 server 包内部 | 可以接受；如果以后要导出这个类，再收紧 |
| `request-helpers.ts` 里混了两个和请求解析无关的常量（`CLIENT_ID_HEADER`、`DEFAULT_WEB_STARTUP_INTENT`） | 很低 | 内聚 | 下次动这个文件时顺手挪到更合适的地方 |
| `rpc-route.ts` 889 行 | 低（存量） | 文件过大，本轮前就有 783 行 | 列为后续拆分候选 |
| command-record 回到唯一使用方 agent，sdk 只剩前后端共享的契约 | 正向 | 内聚，职责边界 | — |
| 已有测试不改、只靠公开接口验证行为 | 正向 | 用行为测试作为重构的安全网 | — |

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|---|---|---|
| [packages/ohbaby-sdk/src/index.ts](../../../../packages/ohbaby-sdk/src/index.ts) | 路径改写；+`DaemonStartupIntent`；−12 个 command-record 名字 | 修改 |
| [packages/ohbaby-sdk/src/contract/](../../../../packages/ohbaby-sdk/src/contract/) | 契约文件移入；新增 `daemon-startup-intent.ts` | 新增/移动 |
| [packages/ohbaby-sdk/src/in-process-rpc/](../../../../packages/ohbaby-sdk/src/in-process-rpc/) | 原 `rpc/` | 移动 |
| [packages/ohbaby-sdk/src/sync/](../../../../packages/ohbaby-sdk/src/sync/)、[util/](../../../../packages/ohbaby-sdk/src/util/) | 同步器与工具移入 | 移动 |
| [packages/ohbaby-agent/src/host/command-record.ts](../../../../packages/ohbaby-agent/src/host/command-record.ts) | 从 sdk 原样移入 | 移动 |
| [packages/ohbaby-agent/src/index.ts](../../../../packages/ohbaby-agent/src/index.ts) | 新增 3 个类型导出 | 修改 |
| [packages/ohbaby-server/src/app/create-app.ts](../../../../packages/ohbaby-server/src/app/create-app.ts) | 3409 → 396 行，只保留状态、生命周期、调度和鉴权 helper | 修改 |
| [packages/ohbaby-server/src/app/openapi.ts](../../../../packages/ohbaby-server/src/app/openapi.ts)、[sse-hub.ts](../../../../packages/ohbaby-server/src/app/sse-hub.ts)、[static-assets.ts](../../../../packages/ohbaby-server/src/app/static-assets.ts) | 从 `create-app.ts` 拆出 | 新增 |
| [packages/ohbaby-server/src/protocols/web/request-helpers.ts](../../../../packages/ohbaby-server/src/protocols/web/request-helpers.ts) | 请求 helper 和 `MAX_REQUEST_BODY_BYTES` | 新增 |
| [packages/ohbaby-server/src/protocols/web/routes/](../../../../packages/ohbaby-server/src/protocols/web/routes/) | `context.ts` 和 8 个路由模块 | 新增 |
| [packages/ohbaby-server/src/protocols/jsonrpc/rpc-route.ts](../../../../packages/ohbaby-server/src/protocols/jsonrpc/rpc-route.ts) | 新增 `registerRpcRoute`；常量改为再导出 | 修改 |
| [packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts](../../../../packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts) | `DaemonStartupIntent` 改为从 sdk 再导出 | 修改 |
| [packages/ohbaby-cli/src/bin.ts](../../../../packages/ohbaby-cli/src/bin.ts) | 删除私有 `DaemonStartupIntent` | 修改 |
| [apps/ohbaby-web/src/api/daemon/wire.ts](../../../../apps/ohbaby-web/src/api/daemon/wire.ts) | `WebStartupIntent` 改为 sdk 类型别名 | 修改 |

## 5.7 证据

- 实施会话保存的证据：[当前分支 server E2E 日志](evidence/2026-10-21/server-e2e-current.log)、[基线日志](evidence/2026-10-21/server-e2e-baseline.log)、[编译产物 Web 验收日志](evidence/2026-10-21/compiled-web.log)、[浏览器观察记录](evidence/2026-10-21/browser-observations.json)、[真实 PTY TUI 观察记录](evidence/2026-10-21/tui-observations.json)。验收会话检查过，这些文件中没有令牌或 API key；原始日志包含本机仓库及临时目录路径。
- 实施会话的完整阶段日志、导出清单和路由快照保存在本机 `/tmp/ohbaby-sdk-server-boundaries-20261021/`，不保证长期留存。
- 验收会话的复核由三部分组成：本会话直接执行的结构命令、全量检查和导出比对；两个只读子代理分别做的改动面核对和越界扫描。原始输出不入库。


## 5.8 既有 E2E 修复与合并前复核

2026-10-21，用户追加要求：修复既有 server E2E，不放宽断言，单独提交后本地合并到 `main`。本节是修复会话的直接执行记录，不覆盖前面的独立验收记录。

### 修复范围

只修改 `goal-execution.e2e.test.ts` 和相关验收文档，生产逻辑不变。`lastUserText()` 按 `source: "system-reminder"` 排除独立提示；目标原文、两轮进度、显示正文、标题、SSE 实时/回放、重连及计数断言继续保留。普通输入由前缀匹配加强为完整相等。

环境信息改在它实际所在的独立提示消息中验证：模型请求恰好有一条提示，包含当前工作目录和 `auto` 模式。SQLite 中不再要求目标正文附带旧的 `model-context` part，而是验证环境/模式快照只存一份、关联首轮助手及对应 run，目标正文不混入提示。第二轮继续携带未变化的提示，符合现有 reminder 去重规则。

为确认没有把测试改松，临时让 serializer 不输出 reminder。该用例在 `expectRuntimeReminder()` 的精确比较处失败；随后逐字节恢复生产文件。这个负向验证没有入库任何生产改动。

独立子代理只读对照了 serializer、origin、reminder collector/provider、context manager 和既有 goal-context 集成测试，结论 PASS，未发现放宽断言或新增生产耦合。

### 验证结果

- 修复前重新复现：两份 server E2E 共 1 项失败、5 项通过、4 项跳过。
- 修复后相同命令：**6 项通过、4 项跳过，0 失败**。四项跳过均为需显式开启的真实模型用例。
- `pnpm typecheck` 通过。初次全量运行的打包测试曾暴露新增断言的类型收窄错误，已停止该次运行、修正并通过类型检查；随后串行重跑全量测试：**577 个文件通过、6 个跳过；6831 项通过、17 项跳过，0 失败**，耗时 560.36 秒。CLI 打包安装测试通过。命令为 `pnpm exec vitest run --passWithNoTests --no-file-parallelism`，测试期间没有并发构建。
- `pnpm run format:check` 通过，验收文档链接检查通过。最终按 lint 整理测试的类型收窄和匹配器声明后，单文件 eslint 为 0 错误、0 警告，typecheck 和两份 server E2E 再次通过；断言内容不变。
- 独立复审及类型收窄修改的补充复审均 PASS。

[修复后的 E2E 日志](evidence/2026-10-21/server-e2e-fixed.log)和[缺失 reminder 的负向验证日志](evidence/2026-10-21/server-e2e-missing-reminder-red.log)随文保存。负向验证日志中的失败是预期结果，生产文件已恢复。

### 分支范围

合并前已用 `git merge-base --is-ancestor codex/workspaceless-settings main` 确认：原工作区分支的全部提交已在 `main`，两者当时都指向 `7bc75168`。本次在其基础上合并 SDK/server 重构和 E2E 修复，不需要重复合并或 cherry-pick。

`workspaceless-settings` 是分支名，不代表设置模块已完成：此前验收记录明确设置尚未实施，SDK 全局客户端方法和 Web 接入也仍有待办。本次只合并现有提交。后续 ohbaby-llm 抽包另建分支；前端重构方案尚未确定，待后端工作完成后再讨论。保留现有分支，不推送远端。
