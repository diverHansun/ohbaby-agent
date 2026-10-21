# 1. 问题基线与当前状态

> 时间口径：分析基于 `codex/workspaceless-settings` 分支 `7bc75168`，涉及的 sdk、server 文件在工作区中没有未提交改动。行号是这一时刻的快照，实施前需要重新核对。

## 1.1 问题陈述

1. **两个 rpc 目录名字相近、职责不同，容易误读。** `ohbaby-sdk/src/rpc/` 是进程内的“假 RPC”，用 JSON 克隆模拟进程边界；`ohbaby-server/src/protocols/jsonrpc/` 是走 HTTP 的真协议。只看目录名，读者会以为两者重复。
2. **sdk 有 26 个源文件平铺在 `src/` 根下**（不含 `index.ts`）。 纯类型、带逻辑的契约、有状态的前端同步器、通用小工具混在一起，看不出层次。
3. **`DaemonStartupIntent` 有三份相同的定义**，分别在 server、CLI、Web。改一处，另外两处不会报错，容易漂移。
4. **`create-app.ts` 有 3409 行**，一个文件里装了 OpenAPI 文档、请求解析、45 个路由、SSE 广播和静态资源服务。改一个路由要在三千多行里定位，代码审阅也难。

## 1.2 已确认的分界

见 [00 §2](00-discussion.md)。要点：JSON-RPC 协议和远程客户端留在 server；本轮只做结构调整，不改行为。

```
依赖方向（现状，本轮不变）

ohbaby-cli ──▶ ohbaby-server ──▶ ohbaby-agent ──▶ ohbaby-sdk
     │                                              ▲
     └──────────────────────────────────────────────┘
apps/ohbaby-web ─────────────────────────────────────▶ ohbaby-sdk（仅生产代码）
```

## 1.3 ohbaby-sdk 现状

### 1.3.1 职责（goals-duty）

`docs/ohbaby-sdk/goals-duty.md` §G2 规定：sdk 不依赖 agent 或 cli，只放类型、纯函数和与框架无关的辅助代码，不持有业务状态，不做 I/O。代码与之一致：`packages/ohbaby-sdk/package.json` 没有运行时依赖。

### 1.3.2 文件布局（architecture）

`src/` 根下有 27 个非测试 `.ts` 文件（含 `index.ts`），另有两个子目录 `rpc/`（2 个源文件）和 `slash-command/`（4 个源文件），共 33 个源文件、约 5200 行。按内容分类：

| 类别 | 文件 | 说明 |
|---|---|---|
| 契约：类型与针对这些类型的纯函数 | `client.ts`、`events.ts`、`snapshot.ts`、`prompt.ts`、`permission.ts`、`interaction.ts`、`subagent.ts`、`compact.ts`、`connect-model.ts`、`connect-search.ts`、`context-window.ts`、`prompt-cache-usage.ts`、`global-sessions.ts`、`error-code.ts`、`workspace-directory-header.ts`、`session-view.ts`、`execution.ts`、`run-inputs.ts`、`prompt-queue-order.ts` | 前后端共享的 DTO、事件联合类型、类型守卫和投影函数 |
| 有状态的前端同步器 | `session-sync.ts`（343 行）、`permission-sync.ts`（395）、`subagent-reader.ts`（169）、`subagent-conversation-reader.ts`（631） | 前端用来维护会话、权限、子代理视图的状态机 |
| 命令 | `slash-command/*` | 斜杠命令的类型、输入解析、补全匹配、Web 可执行命令白名单。解析和匹配函数只被 TUI 和 Web 使用，类型由 agent 产出、前端消费 |
| 命令执行记录 | `command-record.ts`（347） | `executeRecordedUiCommand`、`buildUiCommandDetails`、`summarizeUiCommandError` 和 9 个类型。函数只被 agent 的 `host/ui-command-gateway.ts` 使用；类型被 agent（`host/command-recorder.ts`、`host/core-api-factory.ts`）和 server（`app/create-app.ts:45-46`，即 `UiCommandCorrelation`、`UiCommandRecorder`）使用；CLI 和 Web 都不用。它属于后端执行侧的逻辑，放在 sdk 是位置错误（2026-10-21 实施中发现） |
| 进程内 RPC | `rpc/proxy.ts`（`createRPC`，L175）、`rpc/types.ts`（`CoreAPI`、`SDKAPI`） | 本地模式下模拟进程边界 |
| 通用工具 | `duration.ts`、`loopback-host.ts` | 时长格式化、回环地址判断 |

依赖关系：契约文件之间互相引用，还引用 `slash-command/types.ts`（如 `client.ts`、`events.ts`），而 `slash-command/types.ts` 又引用 `prompt.ts`。文件级只有一个环：`snapshot.ts` 与 `execution.ts` 互相引用，且只是类型引用，两者在分组后同属 `contract/`。同步器引用契约文件。没有契约文件引用同步器或工具文件。

### 1.3.3 对外接口（dfd-interface）

- `package.json` 的 `exports` 只有 `"."`，`tsup.config.ts` 只有 `src/index.ts` 一个入口。
- `tsconfig.base.json:17`、`vitest.config.ts:68-69`、`vitest.e2e.config.ts:40-41` 的路径别名都指向 `src/index.ts`。
- 全仓库没有 `ohbaby-sdk/<子路径>` 形式的深层引用。唯一的源码相对路径引用是 `tests/integration/cli/daemon-terminal.integration.test.ts:9`，指向 `src/index.js`。

所以 `src/` 内部的文件可以自由移动，只要 `index.ts` 的导出不变，其他包不受影响。

### 1.3.4 `rpc/` 的实际用途

- `createRPC` 的唯一生产调用方是 `packages/ohbaby-cli/src/bin.ts:7`（用于 L194）。
- `CoreAPI` 被 CLI 的约 20 个 TUI 文件和 `packages/ohbaby-agent/src/host/core-api-factory.ts:2` 引用。`SDKAPI` 被 CLI、agent 的 `core-api-factory.ts:3` 和 server 的 `protocols/jsonrpc/client.ts:14` 引用。
- 所有调用方都从 `"ohbaby-sdk"` 包入口引入，不关心文件放在哪。

### 1.3.5 测试

每个带逻辑的文件都有同目录单测，契约文件有 `*.contract.test.ts`。部分根目录测试通过 `./index.js` 引入被测代码（client、context-window、duration、events、prompt-cache-usage），文件移动后要改成 `../index.js`。slash-command 的三个测试本来就用 `../index.js`，且不移动，不受影响。

## 1.4 ohbaby-server 现状

### 1.4.1 职责（goals-duty）

`docs/ohbaby-server/goals-duty.md`：D5 规定 server 提供远程 `UiBackendClient`；N5 规定领域事件契约归 sdk，server 只负责 wire 信封。代码与文档一致。

### 1.4.2 JSON-RPC 协议与客户端

| 文件 | 行数 | 内容 | 使用者 |
|---|---|---|---|
| `protocols/jsonrpc/protocol.ts` | 329 | `DAEMON_RPC_METHODS`、请求/响应/SSE 事件类型、`DaemonStartupIntent`（L49-56） | server 内部；`index.ts` 全量 re-export |
| `protocols/jsonrpc/client.ts` | 1006 | `createRemoteUiBackendClient`（L981）、`createRemoteCoreApiHost`（L987） | 只有 CLI `bin.ts:388`，通过动态 import |
| `protocols/jsonrpc/rpc-route.ts` | 783 | 请求体解析和调用 backend 的函数，不是 Hono 路由 | 只有 `create-app.ts:87-92` |

`client.ts` 依赖 `node:crypto`、server 的 `auth/token.ts`，以及 ohbaby-agent 的 `createShutdownOptions`、`withinShutdown`、`CoreApiHost`。它本来就运行在 Node 侧的 CLI 中，这些依赖不构成问题。

Web 端（`apps/ohbaby-web`）的生产代码不引用 server，走的是 REST `/v1/*`，有自己的 wire 层（`src/api/daemon/wire.ts`、`http.ts`、`events.ts`）。这是 `docs/ohbaby-web/goals-duty.md` ND4 的有意设计。所以“前端连 daemon 必须装 server”的问题并不存在。

### 1.4.3 `DaemonStartupIntent` 的三份副本

| 位置 | 名称 |
|---|---|
| `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts:49-56` | `DaemonStartupIntent`（导出） |
| `packages/ohbaby-cli/src/bin.ts:106-113` | `DaemonStartupIntent`（文件内私有） |
| `apps/ohbaby-web/src/api/daemon/wire.ts:31-38` | `WebStartupIntent`（导出） |

三份字段完全一致。CLI 不从 server 引入，是因为 `eslint.config.js` 的 CLI 规则块（L160-305，引入限制在 L165-206）禁止 CLI 生产代码静态加载 server 的值。类型引入是允许的，但 CLI 选择了复制。Web 不能依赖 server。server 端 `coordination/client-view.ts:11` 引用它，`parseDaemonStartupIntent`（L85-118）负责解析。

### 1.4.4 `create-app.ts` 结构

| 区段 | 行号 | 内容 |
|---|---|---|
| 常量与类型 | 99-153 | `DaemonServerAppOptions`、`DaemonServerAppHandle` 等 |
| 模块级 helper | 136-569（与部分类型定义交错） | `readJsonWithLimit`（L538，约 20 个路由使用）、各类错误状态映射、请求体解析、SSE 帧写入、静态资源 MIME |
| `createOpenApiDocument` | 571-1126 | 手写的 OpenAPI 文档，约 555 行，只有 `/doc` 使用 |
| `class DaemonServerAppRuntime` | 1128-3394 | 运行时类，持有全部共享状态 |
| ├ 字段 | 1129-1153 | `app`、`clientViews`、`clients`、`eventBus`、`permissionRouter`、`authToken`、`replayEventsBySeqNum`、`waitControllers`、`permissionEpoch` 等 |
| ├ `mountRoutes()` | 1286-2842 | 所有路由都注册在这一个方法里，约 1550 行 |
| ├ 鉴权 helper | 2844-2884 | `isAuthorized`、`authorizePromptMutation`、`clientIdFromRequest` |
| ├ `serveWebAsset` | 2885-2966 | 静态资源 |
| └ SSE、重放、广播 | 2968-3394 | `createSseResponse`、`replayMissedEvents`、`notifyBinding`（L3154）、`broadcast`（L3223）等，约 430 行 |
| `createDaemonServerApp` | 3396-3409 | 外层工厂 |

`mountRoutes()` 内的路由按路径可以分成这些组：

| 组 | 行号 | 路由 |
|---|---|---|
| 中间件与错误处理 | 1287-1327 | `use /v1/*` 刷新客户端活跃时间；`onError` 映射错误码 |
| 文档、健康检查、关闭 | 1329-1351 | `/doc`、`/api/health`、`/api/shutdown` |
| JSON-RPC | 1353-1450 | `POST /api/rpc`，处理函数内联写在这里 |
| 事件与客户端 | 1452-1512、1675-1737 | `/api/events`（旧版 SSE）、`POST /v1/clients`、`/v1/prompts/receipt`、`/v1/snapshot`、`/v1/events` |
| 会话读取与变更 | 1514-1575、1971-2180、2791-2838 | 会话索引、导出、view/history/control、reasoning、创建、选择、归档、上下文窗口、压缩、中止 |
| 子代理 | 1576-1673 | 子代理列表、详情、对话、watch |
| 命令 | 1739-1838 | `/v1/commands` |
| 模型与设置 | 1840-1969 | `/v1/model`、上下文窗口探测、搜索 API key |
| 提示词 | 2182-2648 | 提交、编辑、补全、重发、steer、取消、编辑租约 |
| 交互与权限 | 2650-2789 | 交互回应、权限设置与回应 |
| 静态资源 | 2840-2841 | `GET /`、`GET /*`（兜底路由，必须最后注册） |

几个关键事实：

- 鉴权不是中间件，每个路由自己调用 `this.isAuthorized` 或 `authorizePromptMutation`。
- 目前没有任何拆出去的路由模块，`protocols/web/` 和 `middleware/` 目录都不存在。
- 路由处理函数通过 `this` 用到的东西（拆分时都要经过路由上下文提供）：
  - 后端与协调：`options.backend`（约 29 处）、`commandBackend()`、`clientViews`、`permissionRouter`、`eventBus.publish`、`eventBus.latestSeqNum`、`createSessionId`。
  - 客户端身份与鉴权：`isAuthorized`、`authorizePromptMutation`、`clientIdFromRequest`（约 19 处）、`isRegisteredWebClient`（约 18 处）、`touchClientActivity`、`notifyBinding`。
  - 可变状态：`permissionEpoch`（字符串）、`registeredWebClientIds`、`knownClientIds`（集合）、`waitControllers`。
  - 其他：`waitForPrompt`、`createSseResponse`、`broadcast`、`serveWebAsset`、`options.packageVersion`、`options.onShutdown`、`options.webAssets`、`authToken`。
- 同一业务领域的路由在 `mountRoutes()` 里并不连续。例如会话路由分布在 L1514-1575、L1971-2180、L2791-2838 三段，事件相关路由分布在 L1452-1512、L1675-1737 两段。
- `rpc-route.ts` 导出 `MAX_REQUEST_BODY_BYTES`，`create-app.ts` 的 `readRequestTextWithLimit`（L497）引用它；反过来 `POST /api/rpc` 的处理函数又用到 `create-app.ts` 里的 `readRequestTextWithLimit`、`isRecord` 等 helper。
- 跨工作区的路由（`/v1/scopes`、`/v1/directory-picker/*`、`/v1/connections`、全局会话列表与搜索、`/v1/sessions/:id/project`）不在 `create-app.ts`，在 `runtime/daemon/server.ts:259-281`，本轮不涉及。

### 1.4.5 测试

| 文件 | 类型 | 规模 |
|---|---|---|
| `src/app/create-app.unit.test.ts` | unit | 5062 行，约 75 个用例 |
| `src/app/session-export.integration.test.ts` | integration | 1 个用例 |
| `src/coordination/permission-lifecycle.integration.test.ts` | integration | 约 11 个用例 |
| `src/coordination/prompt-admission.integration.test.ts` | integration | 约 3 个用例 |

四个文件都只调用公开的 `createDaemonServerApp`，不引用内部 helper。纯结构拆分时它们可以不改，直接检验行为是否变化。

## 1.5 跨模块一致性

- `DaemonStartupIntent` 三份副本是唯一发现的跨包契约重复。Web 的 `WebSseEvent`（`wire.ts:266`）在结构上也和 server 的 `DaemonSseEvent`（`protocol.ts:90`）重复，但它属于 wire 信封，按 route-a §5 和 server N5 留在各自一侧，本轮不处理。
- CLI 和 Web 引入 sdk 都走包入口，sdk 内部调整对它们透明。

## 1.6 改动影响面

| 包 | 影响 |
|---|---|
| `ohbaby-sdk` | 文件移动、`rpc/` 改名、新增 `DaemonStartupIntent`；`index.ts` 改内部路径；移出 `command-record.ts` 后少导出 3 个函数和 9 个类型，其余导出名不变 |
| `ohbaby-agent` | 接收 `command-record.ts`，并从包入口导出 server 需要的类型 |
| `ohbaby-server` | `create-app.ts` 拆分；`protocol.ts` 改为从 sdk 引入并 re-export `DaemonStartupIntent`；`rpc-route.ts` 承接 `/api/rpc` 路由 |
| `ohbaby-cli` | `bin.ts` 删除私有 `DaemonStartupIntent`，改为从 sdk 类型引入 |
| `apps/ohbaby-web` | `wire.ts` 的 `WebStartupIntent` 改为 sdk 类型的别名或直接替换 |
| 文档 | `docs/ohbaby-sdk/architecture.md` §1、§3，`docs/ohbaby-sdk/test.md`，`docs/ohbaby-server/architecture.md` §3，`docs/ohbaby-server/hono-app/01` §1、§2，`docs/ohbaby-server/hono-app/02`（`/doc` 的出处） |

全部是可逆改动，不涉及数据、协议或发布顺序。

## 1.7 SWE 原则审视摘要

| 发现 | 依据 | 判断 |
|---|---|---|
| `create-app.ts` 是“大文件”：一个方法 1550 行，一个类 2260 行 | 代码异味：过长函数、过大的类；内聚度低 | 真实问题，影响定位和审阅 |
| 两个 `rpc` 目录同名不同义 | 命名与可读性：名字应当说明意图 | 改名即可，不需要合并 |
| `DaemonStartupIntent` 三份副本 | DRY：同一个契约知识出现三次，且必须保持一致 | 真实重复，收进共享契约包 |
| sdk 平铺 | 内聚：按职责分组能让读者一眼看出层次 | 轻度问题；分组即可，不要拆太细 |
| JSON-RPC 客户端留在 server | 稳定依赖与 YAGNI：没有使用者需要脱离 server 的客户端 | 合理，不改 |
| `command-record.ts` 放在 sdk | 内聚与职责边界：sdk 只放前后端共享的契约，执行侧逻辑应跟着唯一的使用方 | 位置错误，移到 agent |
| 鉴权内联在每个路由里 | 横切关注点适合放中间件 | 值得改，但会改变行为，不放进本轮的纯结构重构 |

## 1.8 与既有文档的关系

| 文档 | 说法 | 代码 | 本轮处理 |
|---|---|---|---|
| `docs/ohbaby-sdk/architecture.md` §3 | 建议的平铺文件树，含 `rpc/{types,proxy}.ts` | 一致 | 实施后更新文件树 |
| `docs/ohbaby-server/hono-app/01` §1 | 目标布局中有 `protocols/web/routes.ts`、`middleware/*`，`rpc-route` 挂 Hono 路由 | 都不存在，路由全在 `create-app.ts` | 本轮实现路由部分，`middleware/*` 不做 |
| `docs/ohbaby-server/hono-app/01` 当前实现注 | `createDaemonServerApp` 是高内聚的组合根，不为目录形状重构 | 一致 | 保持唯一组装点；拆分理由是文件过大 |
| `docs/ohbaby-server/hono-app/05` 原则 C | 路由只做校验、调用 coordination、投影响应 | 大体一致 | 拆出的路由模块保持这个约束 |
| `docs/ohbaby-server/goals-duty.md` D5、N5 | 远程客户端和 wire 信封归 server | 一致 | 不改 |
| `docs/problem-lists/server/04-route-a-new-package.md` §5 | SDK 不收 wire 格式；`DaemonStartupIntent` 可选进 SDK | — | 采纳可选项 |
