# 4. 测试与验收标准

> 本轮是纯结构重构，验收的核心是“行为不变”。主要依靠现有测试，不为搬移代码新写单测。下面的检查命令都在仓库根目录执行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| 类型检查 | 文件移动后所有 import 正确；三端 `DaemonStartupIntent` 类型兼容 |
| 现有单元与集成测试 | sdk 各模块行为、`createDaemonServerApp` 的 REST/RPC/SSE 行为 |
| 结构检查 | 用脚本或 `rg` 确认导出、目录、路由清单 |
| 手工冒烟 | 本地启动 daemon，用 TUI 和 Web 各走一遍主流程 |

## 4.2 关键场景与用例

### Stage 1

**S1-1 sdk 导出名不变。** `index.ts` 有 `export *`，不能直接比对文本。用一个临时脚本（不必入库）通过 TypeScript compiler API 解析 `packages/ohbaby-sdk/src/index.ts`，用 `checker.getExportsOfModule()` 列出全部导出名并排序，改动前后各跑一次，结果完全一致。

**S1-2 旧 `rpc/` 路径无残留。** 下面的命令没有输出：

```bash
rg -n '/rpc/proxy|/rpc/types|from "\./rpc/' packages/ohbaby-sdk/src
```

**S1-3 sdk 依赖方向。** `contract/` 不引用 `sync/`、`util/`、`in-process-rpc/`。下面的命令没有输出：

```bash
rg -n 'from "\.\./(sync|util|in-process-rpc)/' packages/ohbaby-sdk/src/contract
```

**S1-4 进程内 RPC 行为。** `in-process-rpc/proxy.unit.test.ts`（原 `rpc/proxy.unit.test.ts`）全部通过。

### Stage 2

**S2-1 代码里只剩一份 `DaemonStartupIntent`。** 下面的命令只命中 `packages/ohbaby-sdk/src/contract/daemon-startup-intent.ts`（`agent` 的 `ui-persistent.ts` 有一个同名字段但结构不同，不会被这个模式命中）：

```bash
rg -n 'startupSessionMode\?: \{ readonly type' packages apps --glob '!**/dist/**' --glob '!**/node_modules/**'
```

**S2-2 server 导出不变。** `import type { DaemonStartupIntent } from "ohbaby-server"` 仍能编译。

**S2-3 Web 构建。** 带上依赖一起构建，避免 vite 找不到 sdk 的 `dist`：

```bash
pnpm --filter "ohbaby-web..." build
```

**S2-4 启动意图端到端。** 现有 `tests/integration/cli/daemon-*.integration.test.ts` 通过；`client-view` 中启动意图解析的测试通过。

### Stage 3

**S3-1 `createDaemonServerApp` 行为不变。** 01 §1.4.5 的四个测试文件不做任何修改即全部通过，`git diff --stat` 中不出现这四个文件。

**S3-2 路由清单完全一致。** 拆分前后各构造一次 app，读取 Hono 的 `app.routes`，按注册顺序列出 `method + path`，两份清单逐行一致（包括中间件 `use /v1/*`）。可以写成临时脚本，不必入库。

**S3-3 兜底路由最后注册。** S3-2 清单的最后一条是 `GET /*`。

**S3-4 SSE 重放与断线清理。** `runtime/daemon/server.integration.test.ts` 中重放、重连过期、交互清理与重叠连接相关用例通过。手工：Web 连上后断网几秒再恢复，事件不丢、不重复。

**S3-5 `create-app.ts` 规模。** 不超过 700 行，且不再直接注册 API 路由（只剩静态资源的两条）：

```bash
wc -l packages/ohbaby-server/src/app/create-app.ts
rg -n 'app\.(get|post|put|patch|delete)\(' packages/ohbaby-server/src/app/create-app.ts
```

第二条命令只命中 `GET /` 和 `GET /*` 两处。

**S3-6 路由模块不引入跨工作区依赖。** 下面的命令没有输出：

```bash
rg -n 'InstanceStore' packages/ohbaby-server/src/protocols/web
```

**S3-7 没有反向依赖。** `protocols/` 不引用 `app/`。下面的命令没有输出：

```bash
rg -n 'from "(\.\./)+app/' packages/ohbaby-server/src/protocols
```

## 4.3 用例与 Stage 对照

| Stage | 用例 |
|---|---|
| Stage 1 | S1-1、S1-2、S1-3、S1-4 |
| Stage 2 | S2-1、S2-2、S2-3、S2-4 |
| Stage 3 | S3-1 至 S3-7 |

## 4.4 集成边界

- **sdk → 各包**：只通过 `index.ts`。S1-1 保证这个边界不变。
- **server → CLI**：CLI 动态加载 `ohbaby-server` 的导出（`bin.ts:360-388`）。S2-2 和 `daemon-*` 集成测试覆盖。
- **server → Web**：REST `/v1/*` 和 SSE。S3-1、S3-2 保证接口不变，S3-4 手工确认。
- **运行时类 → 路由模块**：通过 `DaemonRouteContext`。typecheck 保证接口完整。

## 4.5 回归清单

以下行为不能被破坏：

- 远程 TUI（`ohbaby --remote-port <端口>`）能连接、提交提示词、收到事件。
- Web 能打开、建会话、发消息、处理权限请求、看子代理对话。
- `/doc` 返回的 OpenAPI 文档与拆分前一致（对比两次响应的 JSON）。
- 未授权请求仍返回 401，没有因为搬移而漏掉某个路由的鉴权。
- `pnpm run build` 产出的 CLI 包能正常启动（`node packages/ohbaby-cli/dist/bin.js --version`）。

## 4.6 验收标准

| 项 | 标准 | 如何验证 |
|---|---|---|
| 全量检查 | `pnpm run preflight` 通过 | 命令 |
| 各 Stage | 4.3 中对应用例全部通过 | 见 4.2 |
| 回归 | 4.5 全部手工确认 | 实施会话记录在 05 |
| 文档 | 02 §2.9 的 D1-D3 及连带文档已同步 | 人工检查 |

## 4.7 对抗性审查要点

| 攻击面 | 可能出的问题 | 防御 | 残余风险 |
|---|---|---|---|
| 鉴权遗漏 | 搬移时漏掉某个路由开头的 `isAuthorized` 调用，导致未授权访问 | `create-app.unit.test.ts` 已有未授权用例；审阅时逐个路由模块检查 | 测试没有覆盖每一个路由的 401，审阅时需要专门过一遍 |
| 路由顺序 | 兜底路由或带参数的路由提前注册，覆盖了具体路由 | 按段拆 register 函数；S3-2、S3-3 | 低 |
| 可变状态 | `permissionEpoch` 按值传入后过期；集合被复制后两边不同步 | getter、传同一引用；审阅时确认 `DaemonRouteContext` 上没有按值保存的可变状态 | 如果测试没有覆盖 epoch 变化后的请求，可能漏网 |
| SSE 生命周期 | `DaemonSseHub` 的清理没被调用，计时器残留，测试进程挂起 | 运行时的 `dispose` 必须调用 hub 的清理；测试跑完能正常退出 | 低 |
| 依赖方向 | helper 放错位置，`protocols/` 反过来引用 `app/` | `request-helpers.ts` 放在 `protocols/web/`；S3-7 | 低 |
| sdk 循环引用 | 移动时新增文件级循环 | 现有唯一的环是 `snapshot.ts` 与 `execution.ts` 之间的类型引用，同属 `contract/`；`contract/` 与 `slash-command/types.ts` 互相引用但文件级无环 | 低 |
