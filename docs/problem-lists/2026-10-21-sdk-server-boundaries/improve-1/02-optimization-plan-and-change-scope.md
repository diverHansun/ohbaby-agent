# 2. 优化方案与改动面

> 本文是交给实施会话的契约。规划会话不据此写代码。实施前先确认 `codex/workspaceless-settings` 已合入 `main`，并按当时代码核对 §2.9 的行号。

## 2.1 方案总览

本轮调整文件组织，不改运行时行为。Stage 1b 按补充决定收窄 SDK 公开导出。实施顺序为 Stage 1 → Stage 2 → Stage 1b → Stage 3，各阶段单独提交、单独通过测试：

1. **Stage 1**：sdk 内部按职责分目录，`rpc/` 改名为 `in-process-rpc/`。
2. **Stage 2**：`DaemonStartupIntent` 收进 sdk，删除 CLI 和 Web 的副本。
3. **Stage 1b**：命令执行记录从 sdk 移到 agent。
4. **Stage 3**：`create-app.ts` 拆成几个文件，路由按业务分组。

Stage 1、2、1b 按顺序做；Stage 1b 与 Stage 3 都涉及 `create-app.ts`，本轮串行实施。

```
ohbaby-sdk/src/（Stage 1 之后）
├── index.ts               唯一公开入口，导出名不变
├── contract/              前后端共享的类型，以及针对这些类型的纯函数
├── sync/                  前端用的有状态同步器
├── slash-command/         斜杠命令（原有）；command-record.ts 在 Stage 1b 移到 agent
├── in-process-rpc/        原 rpc/，进程内模拟进程边界
└── util/                  时长格式化、回环地址判断

ohbaby-server/src/（Stage 3 之后）
├── app/
│   ├── create-app.ts      DaemonServerAppRuntime + createDaemonServerApp，唯一组装点
│   ├── openapi.ts         createOpenApiDocument
│   ├── sse-hub.ts         SSE 连接、事件重放与广播
│   └── static-assets.ts   Web 静态资源
└── protocols/
    ├── jsonrpc/rpc-route.ts   新增 registerRpcRoute，承接 POST /api/rpc
    └── web/
        ├── request-helpers.ts 请求体读取、解析、错误状态映射，以及 MAX_REQUEST_BODY_BYTES
        └── routes/            每个领域一个文件，文件内可以有多个 register 函数
            ├── context.ts     路由模块共用的依赖接口 DaemonRouteContext
            ├── system.ts      /doc、/api/health、/api/shutdown
            ├── events.ts      客户端注册、快照、SSE、prompt receipt
            ├── sessions.ts    会话读取、变更、中止
            ├── subagents.ts
            ├── prompts.ts
            ├── commands.ts
            ├── model.ts       模型、连接探测、搜索 API key
            └── permissions.ts 交互回应与权限
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| JSON-RPC 协议与客户端 | 留在 server | 没有使用者需要脱离 server 的客户端；与 server D5、N5 和 route-a §5 一致（01 §1.4.2） | 挪进 sdk | 无 |
| sdk `rpc/` 新名字 | `in-process-rpc/` | 直接说明“进程内”，与 server 的 `jsonrpc/` 区分开；sdk 架构文档也把它叫 In-process RPC seam | `boundary/`、`fake-rpc/` | 改几处 import 和文档 |
| sdk 分组依据 | 是否有状态 | 契约文件会互相引用；如果按“纯类型 / 有逻辑”分组，`snapshot.ts` 引用 `execution.ts` 这类边就会跨组。按“有没有状态”分组，依赖只朝一个方向：`sync/` → `contract/` | 按纯类型和带逻辑分组；按业务领域分组 | `contract/` 有约 20 个文件，略大 |
| sdk 公开入口 | 只保留 `index.ts` | 全仓库没有深层引用（01 §1.3.3），外部无感 | 增加子路径导出 | 无 |
| `DaemonStartupIntent` 放哪 | `contract/daemon-startup-intent.ts` | 三端共享、字段一致，属于契约 | 留在 server，CLI 用类型引入 | Web 不能依赖 server，这个方案去不掉 Web 的副本 |
| server 的 `DaemonStartupIntent` 导出 | `protocol.ts` 从 sdk 引入并 re-export | 保持 `ohbaby-server` 的导出不变 | 直接删除 server 导出 | 多一行 re-export |
| 路由模块形式 | 函数 `registerXxxRoutes(app, ctx)`；同一领域的路由在原文件中不连续时，拆成多个 register 函数（如 `registerSessionReadRoutes`、`registerSessionMutationRoutes`、`registerSessionAbortRoute`） | 简单，与 Hono 用法一致；`mountRoutes()` 按原顺序调用，注册顺序可以和拆分前完全一致 | 每个领域只有一个 register 函数；每个模块返回 Hono 子 app 再 `route()` 挂载 | 前者无法保持原注册顺序（01 §1.4.4）；后者会改变中间件和 `onError` 的作用范围 |
| 请求 helper 放哪 | `protocols/web/request-helpers.ts`，`MAX_REQUEST_BODY_BYTES` 也挪过去，`rpc-route.ts` 改为从这里引入 | 路由模块和 `rpc-route.ts` 都在 `protocols/` 下，helper 放在 `app/` 会让 `protocols/` 反过来依赖 `app/`；常量留在 `rpc-route.ts` 则会和 helper 互相引用 | `app/request-helpers.ts` | 无 |
| 路由访问共享状态 | 通过窄接口 `DaemonRouteContext`，由 `DaemonServerAppRuntime` 实现 | 路由模块不直接依赖运行时类；接口列出了路由真正需要什么 | 把运行时类实例直接传进去 | 需要写一个接口 |
| SSE 部分 | 提取为 `DaemonSseHub` 类，由运行时持有 | 这约 430 行有自己的状态（连接集合、重放缓冲、断线计时器），本身就是一个内聚的单元 | 留在运行时类里 | 运行时里的调用改为委托 |
| `POST /api/rpc` | 处理函数挪进 `rpc-route.ts` 的 `registerRpcRoute` | `rpc-route.ts` 已经有这个路由用到的全部 helper；与 hono-app/01 §5 一致 | 放进 `protocols/web/routes/` | 无 |
| 鉴权 | 保持每个路由内联调用 | 改成中间件会改变行为，不属于纯结构重构 | 本轮改中间件 | 登记为后续候选 |
| 测试 | Stage 3 不改现有测试；Stage 1b 仅改必要 import | 它们只通过公开 API 测试，是检验行为不变的安全网 | 按新文件拆测试 | `create-app.unit.test.ts` 仍有 5062 行，留给后续 |

## 2.3 分阶段实施

所有阶段都属于 improve-1。

### Stage 1：sdk 分目录与 `rpc/` 改名

**目标**：`src/` 下只剩 `index.ts` 和五个子目录，导出不变。

**文件归属**：

| 目录 | 文件 |
|---|---|
| `contract/` | `client.ts`、`events.ts`、`snapshot.ts`、`prompt.ts`、`permission.ts`、`interaction.ts`、`subagent.ts`、`compact.ts`、`connect-model.ts`、`connect-search.ts`、`context-window.ts`、`prompt-cache-usage.ts`、`global-sessions.ts`、`error-code.ts`、`workspace-directory-header.ts`、`session-view.ts`、`execution.ts`、`run-inputs.ts`、`prompt-queue-order.ts` |
| `sync/` | `session-sync.ts`、`permission-sync.ts`、`subagent-reader.ts`、`subagent-conversation-reader.ts` |
| `slash-command/` | 原有 4 个文件，加上 `command-record.ts` |
| `in-process-rpc/` | `rpc/proxy.ts`、`rpc/types.ts` |
| `util/` | `duration.ts`、`loopback-host.ts` |

**做法**：

- 用 `git mv` 移动，测试文件跟着源文件一起移。
- 更新相对 import。根目录下原来通过 `./index.js` 引入的测试改为 `../index.js`；slash-command 的测试已经用 `../index.js`，不用改。
- `index.ts` 只改路径。四个 `export *`（`session-view`、`session-sync`、`execution`、`duration`）保留原样。
- 移动后检查依赖方向：`contract/` 不能引用 `sync/`、`util/`、`in-process-rpc/`。`contract/` 可以引用 `slash-command/types.ts`，因为它也是契约；`slash-command/types.ts` 反过来引用 `contract/prompt.ts`，目录层面双向，文件级无环，保持现状。
- `in-process-rpc/proxy.ts` 里的 `NESTED_SIGNAL_ARGUMENTS`、`CALLBACK_KEYS` 等内容不动。

**完成定义**：

- `pnpm run typecheck`、`pnpm run lint`、`pnpm run test` 全部通过。
- 改动前后 `src/index.ts` 的导出名清单完全一致（方法见 04 S1-1；`index.ts` 有 `export *`，不能直接比对文本）。
- 旧路径无残留（命令见 04 S1-2）。

### Stage 2：`DaemonStartupIntent` 收进 sdk

**目标**：三端共用 sdk 的一份定义。

**做法**：

- 新建 `packages/ohbaby-sdk/src/contract/daemon-startup-intent.ts`，内容照搬 `protocol.ts:49-56`，从 `index.ts` 以 `export type` 导出。
- `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts`：删除本地定义，改为 `import type { DaemonStartupIntent } from "ohbaby-sdk"`，并 `export type { DaemonStartupIntent }`，保持 server 导出不变。
- `packages/ohbaby-cli/src/bin.ts`：删除 L106-113 的私有定义，改为从 `ohbaby-sdk` 类型引入。CLI 静态引入 sdk 不违反 `eslint.config.js` 的限制（限制只针对 agent 和 server）。
- `apps/ohbaby-web/src/api/daemon/wire.ts`：删除 `WebStartupIntent` 的定义，改为 `export type WebStartupIntent = DaemonStartupIntent`，Web 其他文件不用改。也可以全部替换成 sdk 的名字，由实施者决定。
- `parseDaemonStartupIntent`（`client-view.ts:85-118`）是 server 侧的解析逻辑，留在原处。

**完成定义**：

- 代码中只剩 sdk 一份定义（命令见 04 S2-1）。
- typecheck、lint、test 全部通过。Web 构建通过（命令见 04 S2-3）。

### Stage 1b：`command-record.ts` 移到 agent

> 2026-10-21 实施中补充。Stage 1、2 已经提交，Stage 1 按原计划把它放进了 `slash-command/`；本阶段再把它移出 sdk。它会改 `create-app.ts` 的 import，最好在 Stage 3 动 `create-app.ts` 之前完成；如果 Stage 3 已经开始，就在 Stage 3 的分支上一并处理。

**目标**：sdk 不再包含命令执行记录的逻辑，它回到唯一的使用方 agent。

**做法**：

- `git mv packages/ohbaby-sdk/src/slash-command/command-record.ts packages/ohbaby-agent/src/host/command-record.ts`，单测 `command-record.unit.test.ts` 一起移动。文件内容不变（它不引用 sdk 的其他文件）。
- `packages/ohbaby-sdk/src/index.ts`：删除 `command-record` 的两段导出（3 个函数、9 个类型）。
- agent 内部：`host/ui-command-gateway.ts`、`host/command-recorder.ts`、`host/core-api-factory.ts` 及相关测试（`ui-command-gateway.unit.test.ts`、`command-recorder.unit.test.ts`、`core-api-factory.unit.test.ts`、`adapters/ui-inprocess.contract.test.ts`）改为从 `./command-record.js` 或相对路径引入。
- `packages/ohbaby-agent/src/index.ts`：用 `export type` 导出 server 需要的类型，至少包括 `UiCommandCorrelation`、`UiCommandRecord`、`UiCommandRecorder`。3 个函数只在 agent 内部使用，不导出。
- server：`app/create-app.ts:45-46` 的 `UiCommandCorrelation`、`UiCommandRecorder` 和 `create-app.unit.test.ts` 的 `UiCommandRecord` 改为 `import type … from "ohbaby-agent"`。server 已经静态依赖 agent（同一文件就从 agent 引入了 `createUiCommandGateway`），不增加新的依赖方向。
- 类型名保持原样（仍带 `Ui` 前缀），本阶段不改名，减少改动面。

**完成定义**：

- sdk 中没有 `command-record` 的残留，CLI 和 Web 不受影响（命令见 04 S1b-1）。
- typecheck、lint、test 全部通过。
- sdk 导出名清单与 Stage 1 之前相比，只少了这 12 个名字，并多了 Stage 2 的 `DaemonStartupIntent`（04 S1-1）。

### Stage 3：拆分 `create-app.ts`

**目标**：`create-app.ts` 只保留运行时类的字段、生命周期、`mountRoutes()` 调度和鉴权 helper，行为零变化。

**做法**（每一步都可以单独跑测试）：

1. **挪出纯函数**。`createOpenApiDocument`（L571-1126）挪到 `app/openapi.ts`。模块级 helper（L136-569）挪到 `protocols/web/request-helpers.ts`，SSE 帧写入和静态资源 MIME 相关的除外；`MAX_REQUEST_BODY_BYTES` 从 `rpc-route.ts` 挪到同一文件，`rpc-route.ts` 改为引入它并保持原有的导出。函数体不改。
2. **提取 `DaemonSseHub`**。把 L2968-3394 的 SSE 连接、重放、广播逻辑和相关字段（`clients`、`replayEventsBySeqNum`、`disconnectCleanupTimers`、`expiredClientIds` 等）挪到 `app/sse-hub.ts`。运行时类持有一个实例，原方法改为委托。`writeSseFrame`、`parseLastEventId` 随之挪过去。
3. **提取静态资源**。`serveWebAsset`（L2885-2966）连同 `contentTypeForPath`、`escapeInlineScriptJson` 挪到 `app/static-assets.ts`。
4. **定义 `DaemonRouteContext`**，放在 `protocols/web/routes/context.ts`。成员按 01 §1.4.4 列出的“路由处理函数通过 `this` 用到的东西”逐项列出，以实际代码为准。可变的字符串（`permissionEpoch`）用 getter；可变的集合（`registeredWebClientIds`、`knownClientIds`）和 `waitControllers` 传同一个引用，或者包装成方法，不能复制。`DaemonServerAppRuntime` 实现这个接口。
5. **按段挪出路由**。以 `mountRoutes()` 里连续的一段为单位，写成 `registerXxxRoutes(app: Hono, ctx: DaemonRouteContext): void`，放进对应领域的文件；同一领域不连续的几段写成几个 register 函数。处理函数体原样搬过去，`this.` 改为 `ctx.`。`POST /api/rpc` 挪进 `rpc-route.ts` 的 `registerRpcRoute`。静态资源的两条路由留在 `create-app.ts`，直接调用 `app/static-assets.ts`。
6. **`mountRoutes()` 只做调度**：先注册中间件和 `onError`，再按原来的顺序依次调用各个 register 函数，静态资源兜底路由 `GET /*` 最后注册。拆分后的注册顺序与拆分前完全一致。

**约束**：

- `createDaemonServerApp` 的签名和返回值（`DaemonServerAppHandle`）不变，`src/index.ts` 的导出不变。
- 路由模块只做校验、调用 coordination、投影响应（hono-app/05 原则 C），不新增业务分支。
- 路由模块不引入 `InstanceStore`，只拿单工作区依赖（全局单 daemon 议题的约束）。
- 路由注册顺序与拆分前一致。两个循环注册（L1551-1575、L1576-1601）保持原来的路径和顺序。
- 新文件尽量不超过 600 行，`create-app.ts` 目标在 700 行以内。只做结构搬移，不顺手改逻辑。

**完成定义**：

- 相对 Stage 1b 完成后的基线，01 §1.4.5 的四个测试文件不改一行就全部通过，`packages/ohbaby-server` 的其他测试也通过。
- 拆分前后路由清单一致（验证方法见 04 S3-2）。
- `create-app.ts` 不超过 700 行，除静态资源的两条外不再直接注册路由；`protocols/` 不引用 `app/`（04 S3-5、S3-7）。

## 2.4 按包和目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-sdk/src/` | 4 个新子目录、`contract/daemon-startup-intent.ts` | `index.ts`，以及移动文件的相对 import | `rpc/` 目录（内容挪到 `in-process-rpc/`） | Stage 1、2 |
| `packages/ohbaby-server/src/app/` | `openapi.ts`、`sse-hub.ts`、`static-assets.ts` | `create-app.ts` | — | Stage 3 |
| `packages/ohbaby-server/src/protocols/web/` | `request-helpers.ts`；`routes/context.ts` 和 8 个路由模块 | — | — | Stage 3 |
| `packages/ohbaby-server/src/protocols/jsonrpc/` | — | `protocol.ts`（Stage 2）、`rpc-route.ts`（Stage 3） | — | |
| `packages/ohbaby-sdk/src/slash-command/` | — | — | `command-record.ts` 及其单测（移到 agent） | Stage 1b |
| `packages/ohbaby-agent/src/host/` | `command-record.ts` 及其单测 | 相关文件改 import；agent `index.ts` 导出类型 | — | Stage 1b |
| `packages/ohbaby-server/src/app/` | — | `create-app.ts` 及其单测改为从 agent 引入命令记录类型 | — | Stage 1b |
| `packages/ohbaby-cli/src/bin.ts` | — | 改为引入 sdk 类型 | 私有 `DaemonStartupIntent` | Stage 2 |
| `apps/ohbaby-web/src/api/daemon/wire.ts` | — | `WebStartupIntent` 改为别名 | 原定义 | Stage 2 |
| `docs/` | — | 见 §2.9 的 D 项 | — | 各阶段完成后同步 |

## 2.5 接口、迁移与兼容

- **npm 包接口**：`ohbaby-sdk` 多导出一个类型 `DaemonStartupIntent`，少导出 `command-record` 的 3 个函数和 9 个类型；`ohbaby-agent` 新增导出命令记录相关的类型；`ohbaby-server` 导出不变。仓库内只有 agent 和 server 用到被移走的名字。外部使用者可将 `UiCommandCorrelation`、`UiCommandRecord`、`UiCommandRecorder` 改为从 `ohbaby-agent` 类型引入；其余被移除的名字不再作为公开 API，3 个函数仅供 agent 内部使用。这个公开接口变化需写进下一次发布说明。不需要调整发布顺序。
- **HTTP 与 JSON-RPC 接口**：不变。
- **数据**：不涉及。
- **迁移**：不需要。每个 Stage 都可以单独 revert。

## 2.6 风险与回滚

| 风险 | 表现 | 防范 | 回滚 |
|---|---|---|---|
| 路由注册顺序变了 | `GET /*` 兜底路由先注册，吞掉后面的 API；或 `use /v1/*` 没覆盖到某些路由 | 按原顺序调度；04 S3-2 对比路由清单 | revert Stage 3 |
| `this` 绑定丢失 | 处理函数原来靠箭头函数捕获 `this`，搬出后访问不到状态 | 统一改成 `ctx.`；靠 typecheck 和现有测试发现 | 同上 |
| `permissionEpoch` 读到旧值 | 它是可变字段，按值传入就会过期 | 接口上用 getter | 同上 |
| SSE 重放或断线清理行为变了 | 断线重连后丢事件或重复事件 | `DaemonSseHub` 只做搬移；`runtime/daemon/server.integration.test.ts` 已有重放与断线清理用例；04 S3-4 手工验证 | 同上 |
| sdk 文件移动漏改测试的相对路径 | 测试导入失败 | typecheck 包含测试文件；跑全量测试 | revert Stage 1 |
| sdk 导出意外变化 | 下游编译失败 | 用 TypeScript compiler API 对比源码导出清单（04 S1-1） | 同上 |

## 2.7 与 00 边界对齐检查

| 00 结论 | 本文落点 |
|---|---|
| 两个 rpc 不合并，sdk `rpc/` 改名 `in-process-rpc/` | Stage 1、§2.2 |
| JSON-RPC 协议与客户端留在 server | §2.2；Stage 2 只挪 `DaemonStartupIntent` |
| `DaemonStartupIntent` 收进 sdk，删两份副本 | Stage 2 |
| sdk 分目录，`index.ts` 唯一入口 | Stage 1 |
| `command-record.ts` 移到 agent | Stage 1b |
| `create-app.ts` 纯结构拆分，唯一组装点不变 | Stage 3 |
| 路由放 `protocols/web/routes/` | Stage 3、§2.1 |
| 现有测试不改 | Stage 3 完成定义 |
| 鉴权中间件、CORS、`client-view.ts` 拆分、Web wire 层不在本轮 | §2.8 |

## 2.8 不在本轮

| 项 | 原因 | 后续 |
|---|---|---|
| 鉴权改为 Hono 中间件 | 会改变行为，需要单独验证 | 后续候选 |
| CORS | 目前没有需求 | 有跨域需求时再做 |
| 拆分 `coordination/client-view.ts`（1177 行） | 职责相对集中，收益不如 `create-app.ts` 明显 | 后续候选 |
| 拆分 `create-app.unit.test.ts`（5062 行） | 本轮要用它原样检验行为不变 | Stage 3 完成后可另做 |
| Web 的 `WebSseEvent` 与 server 的 `DaemonSseEvent` 去重 | 属于 wire 信封，按 route-a §5 和 server N5 留在各自一侧 | 不计划 |
| Web 改用 sdk 提供的 REST 客户端 | Web 保留自己的 wire 层（`docs/ohbaby-web/goals-duty.md` ND4） | 不计划 |
| sdk 增加子路径导出 | 没有按需加载的需求 | 有需求时再做 |
| JSON-RPC 协议或客户端挪进 sdk | 见 00 §3 | 不计划 |
| LLM 客户端抽包 | 另一个议题 | ohbaby-llm 抽包（后续独立分支） |

## 2.9 关键改动清单

> 行号是 `7bc75168` 时的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码 | `packages/ohbaby-sdk/src/index.ts` | 全部 re-export；`createRPC`、`CoreAPI`、`SDKAPI` | L235-236 等 | 只改路径，导出名不变；新增 `DaemonStartupIntent` | sdk 唯一的公开入口 |
| C2 | 代码 | `packages/ohbaby-sdk/src/rpc/proxy.ts`、`rpc/types.ts` | `createRPC`、`CoreAPI`、`SDKAPI` | L175；L1-7 | 移到 `in-process-rpc/`，内容不变 | 远程 TUI 议题要求签名不变 |
| C3 | 代码 | `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts` | `DaemonStartupIntent` | L49-56 | 删除定义，从 sdk 引入并 re-export | server 公开导出 |
| C4 | 代码 | `packages/ohbaby-cli/src/bin.ts` | 私有 `DaemonStartupIntent` | L106-113 | 删除，改为引入 sdk 类型 | 副本之一 |
| C5 | 代码 | `apps/ohbaby-web/src/api/daemon/wire.ts` | `WebStartupIntent` | L31-38 | 改为 sdk 类型的别名 | 副本之一 |
| C6 | 代码 | `packages/ohbaby-server/src/app/create-app.ts` | `DaemonServerAppRuntime.mountRoutes` | L1286-2842 | 改为按原顺序调用各 `registerXxxRoutes` | 路由注册顺序决定行为 |
| C7 | 代码 | 同上 | SSE 与广播方法（`createSseResponse`、`replayMissedEvents`、`notifyBinding`、`broadcast` 等） | L2968-3394 | 提取为 `app/sse-hub.ts` 的 `DaemonSseHub` | 有状态，搬错会丢事件 |
| C8 | 代码 | 同上 | `createOpenApiDocument` | L571-1126 | 挪到 `app/openapi.ts` | 体积最大的单块 |
| C9 | 代码 | 同上 | `POST /api/rpc` 处理函数 | L1353-1450 | 挪进 `rpc-route.ts` 的 `registerRpcRoute` | JSON-RPC 入口 |
| C10 | 代码 | `packages/ohbaby-server/src/protocols/web/routes/context.ts`（新） | `DaemonRouteContext` | — | 定义路由共享依赖接口，`permissionEpoch` 用 getter | 所有路由模块的依赖边界 |
| C11 | 代码 | `packages/ohbaby-sdk/src/slash-command/command-record.ts` | `executeRecordedUiCommand` 等 3 个函数、9 个类型 | 整个文件 | 移到 `packages/ohbaby-agent/src/host/command-record.ts`；sdk `index.ts` 删除对应导出；agent `index.ts` 导出 server 需要的类型 | 改变 sdk 和 agent 的公开导出 |
| C12 | 代码 | `packages/ohbaby-server/src/app/create-app.ts` | `UiCommandCorrelation`、`UiCommandRecorder` 的 import | L45-46 | 改为 `import type … from "ohbaby-agent"` | server 唯一用到这组类型的生产代码 |
| D1 | 文档 | `docs/ohbaby-sdk/architecture.md` | §1 组件表、§3 文件布局 | — | 更新为分目录后的结构和 `in-process-rpc/` | sdk 权威架构文档 |
| D2 | 文档 | `docs/ohbaby-server/architecture.md` | §3 文件树 | — | 加入 `app/` 新文件和 `protocols/web/routes/` | server 权威架构文档 |
| D3 | 文档 | `docs/ohbaby-server/hono-app/01-app-assembly-and-transport.md` | §1 目标布局、§2、当前实现注 | — | 标明路由部分已落地，`middleware/*` 仍是目标 | 防止目标态和现状混淆 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-sdk/src/` 下随文件移动的测试，相对 import 跟着改。
- `docs/ohbaby-sdk/test.md` 提到的测试路径。
- `docs/ohbaby-server/hono-app/02-web-api-surface.md` 中 `/doc` 由 `create-app.ts` 生成的说法，改为 `app/openapi.ts`。
- 其他提到 `create-app.ts` 内部结构的文档：`docs/ohbaby-server/hono-app/00`、`06`、`hono-app/README.md`、`docs/ohbaby-server/non-functional.md`；SSE 重放相关的 `hono-app/03-event-replay.md` 补上 `DaemonSseHub` 的位置。
- `docs/ohbaby-sdk/goals-duty.md` 不需要改：sdk 职责没有变化。
