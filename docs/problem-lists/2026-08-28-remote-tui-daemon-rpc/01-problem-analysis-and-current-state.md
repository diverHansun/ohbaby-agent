# 1. 问题分析与当前状态

> 时间口径：2026-08-28，基线 `8484474`（`main`）。分析只读；生产代码未修改。

## 1.1 问题陈述

这不是“daemon 的 rpc 字段没初始化”，而是 JavaScript 方法 receiver 被调用层丢掉：

```text
CLI terminal
  → createRemoteCoreApiHost()
  → host.core = RemoteDaemonClient instance
  → createRpcCoreHost()
  → createRPC.connectImpl(host.core)
  → proxy.getSnapshot()
  → const method = impl["getSnapshot"]
  → method(...args)                  // receiver 丢失
  → RemoteDaemonClient.getSnapshot()
  → this.rpc(...)                    // this === undefined，立即失败
```

期望链路是：

```text
proxy.getSnapshot()
  → invoke method with impl as receiver
  → RemoteDaemonClient.rpc("getSnapshot")
  → initializeClient（首次）
  → HTTP /api/rpc
  → daemon backend
```

## 1.2 可执行证据

### 1.2.1 稳定复现

把真实 `RemoteDaemonClient` 接到真实 `createRPC`，proxy 第一次调用产生：

```text
TypeError: Cannot read properties of undefined (reading 'rpc')
    at getSnapshot (.../packages/ohbaby-server/src/protocols/jsonrpc/client.ts:176:17)
    at .../packages/ohbaby-sdk/src/rpc/proxy.ts:180:18
```

fake fetch 被刻意设置为“若到达就抛另一条错误”，实际未到达，证明失败点在运输前。

### 1.2.2 对照实验

从同一 client 取出同一 `getSnapshot` 后，以 client 为 receiver 调用，正常得到 snapshot；fake fetch 记录两次请求：首次 `initializeClient`，随后 `getSnapshot`。唯一变量就是 receiver。

### 1.2.3 现有测试基线

以下四个文件当前共 34 项测试全部通过：

- `packages/ohbaby-sdk/src/rpc/proxy.unit.test.ts`
- `packages/ohbaby-cli/src/bin.unit.test.ts`
- `packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`
- `tests/integration/cli/daemon-terminal.integration.test.ts`

绿灯与真实故障并不矛盾：四层分别测了 fake-RPC、CLI 参数装配、remote client、daemon，但没有测它们在生产入口的关键组合。

## 1.3 goals-duty：职责放错在哪里

| 文档职责 | 代码现状 | Gap |
|---|---|---|
| `docs/ohbaby-sdk/goals-duty.md`：SDK 是稳定通信合同和框架无关 helper | `createRPC` 是这条合同的 in-process 调用边界 | 它只支持 receiver-free function object，却没有声明这种限制；class 合法实现被破坏 |
| `docs/cli/goals-duty.md`：CLI 是组合根，local/remote 都经同一 seam | `bin.ts:createRpcCoreHost` 对两类 host 一视同仁包装 | 组合方向正确，问题不应通过新增 remote 特判绕开 |
| `docs/ohbaby-server/goals-duty.md` D5：提供 remote `UiBackendClient` | `RemoteDaemonClient` 以 class 封装连接状态、SSE 和初始化 | class 内聚合理，不应为上游错误把二十多个方法改成特殊形状 |

问题的责任点属于 SDK fake-RPC 的调用语义，不属于 daemon wire 层，也不是 TUI UI 组件问题。

## 1.4 architecture：两个都合理的部件组合后失效

### CLI 组合根

`packages/ohbaby-cli/src/bin.ts:108-115` 的 `createRpcCoreHost()` 建立 JSON clone、异步、错误和 AbortSignal 边界；`bin.ts:354-357` 让所有 CLI host 经过这条 seam。这个统一结构本身符合 `docs/cli/architecture.md` 的“Agent in-process 与 Server remote host 共享 CoreApiHost”约束。

### Server remote adapter

`packages/ohbaby-server/src/protocols/jsonrpc/client.ts:149-173` 以 class 持有 `baseUrl/authToken/clientId/fetchImpl/SSE` 等连接状态；`getSnapshot`、`listCommands` 等方法都通过 `this.rpc(...)` 复用唯一 wire 实现。这是高内聚，不是坏味道。

### SDK fake-RPC

`packages/ohbaby-sdk/src/rpc/proxy.ts:158-183` 的实现分两步：

1. `const method = impl[methodName]`
2. `method(...clonedArgs)`

第一步把 function value 从对象中抽离；第二步没有 receiver。这里把“接口方法”错误地当成“天然无状态的独立函数”，是一处抽象泄漏。

## 1.5 data-model：无 DTO 或 wire schema 问题

`CoreAPI` 由 `Omit<UiBackendClient, "subscribeEvents">` 派生（`packages/ohbaby-sdk/src/rpc/types.ts`），方法名和参数没有漂移；daemon request/response 也未参与失败。因此：

- 不新增字段；
- 不改 JSON-RPC method union；
- 不做版本迁移；
- 不改变 snapshot/event 数据模型。

## 1.6 dfd-interface：失败发生在第一个本地截面

| 截面 | 当前结果 | 证据 |
|---|---|---|
| TUI → CoreAPI proxy | 能解析 `getSnapshot` property | proxy 进入 `call()` |
| CoreAPI proxy → connected impl | **失败**：receiver 丢失 | stack 指向 `proxy.ts:180` 与 client `getSnapshot` |
| Remote client → fetch | 未到达 | fake fetch 未被调用 |
| HTTP → daemon | 未到达 | 与 auth/port/wire 无关 |
| SSE callback | 可开始订阅 | Server host 用 closure 调 `client.subscribeEvents(handler)`，不会丢 receiver |

fresh TUI 在 `packages/ohbaby-cli/src/tui/app.tsx:534-559` mount 后调用 `client.getSnapshot()` 并把错误投到 UI；`--resume/--continue` 则会更早在 `packages/ohbaby-cli/src/cli/commands/terminal.ts:103-105` preflight 直接失败。

## 1.7 use-case：受影响面

| 用例 | 当前行为 |
|---|---|
| fresh remote TUI | UI 能启动，但首次 snapshot 进入 recoverable error，后续任何 CoreAPI 调用同样不可靠 |
| `--resume` / `--continue` remote TUI | preflight `getSnapshot()` reject，TUI 可能无法进入正常交互 |
| 默认 in-process TUI | 当前 core 多为 closure/object method，不依赖 receiver，因此不受影响 |
| direct remote client API | 正常；`client.method()` 自带 receiver |
| Web REST/SSE | 不经过 CLI fake-RPC，不受影响 |

受影响的不只是 `getSnapshot`：RemoteDaemonClient 的查询、写入、初始化、SSE 辅助路径普遍依赖实例状态。`getSnapshot` 只是最先撞到的 method。

## 1.8 non-functional：可靠性与诊断

- **可靠性**：显式 remote TUI 是文档承诺的入口，但核心调用面实际不可用，严重性高。
- **可诊断性**：错误文本看起来像“remote client 内部没有 rpc”，容易误查 daemon、构造器或 cache；真正问题是上游 unbound invocation。
- **性能**：修复不需要引入缓存、绑定表或新网络往返；receiver 传递成本可忽略。
- **兼容性**：正确 receiver 对现有 arrow/bound/closure method 无破坏；它们会忽略或已固定 receiver。
- **安全**：不改 auth、workspace header、payload 或错误脱敏。

## 1.9 test：为什么绿灯没有保护生产入口

### SDK unit

`packages/ohbaby-sdk/src/rpc/proxy.unit.test.ts` 的 implementations 全是 object literal method，且方法只闭包引用外部变量，不读 `this`。它验证了 clone/error/abort，却没验证方法调用契约。

### CLI unit

`packages/ohbaby-cli/src/bin.unit.test.ts:createCore()` 返回 `vi.fn` 集合；remote tests 主要断言参数映射、loader 和 dispose。即使调用 `getSnapshot`，`vi.fn` 也不需要 receiver。

### Server unit/integration

remote client 测试都直接用 `client.getSnapshot()`，所以 class receiver 天然正确。

### 名称过度承诺

`tests/integration/cli/daemon-terminal.integration.test.ts` 虽名为 terminal flow，实际直接构建 `createRemoteUiBackendClient`；它没有经过 `runOhbabyCli`、`createRemoteCoreApiHost` 或 `createRpcCoreHost`，因此不能证明 remote TUI 入口可用。

## 1.10 跨模块一致性

旧参考文档 `docs/cli/improve-1/03-reference-patterns.md:35-45` 已明确记录 Kimi Code 用 `bindAllFunctions` 保证 class `this` 正确。当前 ohbaby 采纳了 JSON clone、错误与 AbortSignal，却漏掉 receiver 语义，属于“参考结论已知、实现契约未被测试锁住”的漂移。

`docs/cli/architecture.md` 又写明 Agent/Server host 直接复用真实 client 对象、不维护逐方法清单。这进一步说明修复应该落在共享调用边界，而不是退回手抄 facade。

## 1.11 SWE 原则审视

| 发现 | 严重性 | SWE 依据 | 判断 |
|---|---|---|---|
| fake-RPC 丢 receiver | 设计级 / 高影响 | 正确性优先；抽象不可破坏实现合同 | 必修 |
| 给 remote client 逐方法 bind | 设计级债务 | DRY、信息隐藏；方法表会随 UiBackendClient 漂移 | 不采用 |
| remote 路径绕过 fake-RPC | 架构分叉 | 低耦合、一致 seam；会把复杂度转移到 CLI | 不采用 |
| 在 SDK 单点显式 receiver | 低垂果实 | KISS、高内聚、最小惊讶 | 推荐 |
| callback receiver 一并泛化 | 未观察风险 | YAGNI；当前 callback 已由 closure 保证 | 本批不做 |

核心判断：这是一个“一行语义错误 + 一处组合测试缺口”，不应被包装成 RPC 框架重写。

## 1.12 与既有文档关系

| 文档 | 关系 |
|---|---|
| `docs/cli/goals-duty.md` / `architecture.md` | 权威职责与组合约束；本批保持 local/remote 同 seam |
| `docs/ohbaby-sdk/goals-duty.md` / `architecture.md` | 权威 SDK helper 边界；实施时补 receiver 语义 |
| `docs/ohbaby-server/goals-duty.md` / `architecture.md` / `test.md` | remote adapter 与测试职责；不改 wire，补跨边界验证说明 |
| `docs/cli/improve-1/03-reference-patterns.md` | 历史参考，已正确指出 class binding，但不是当前实施契约 |
| `docs/problem-lists/terminal-daemon/` | 历史规划；remote TUI 可用是既有承诺，本目录专门修复其当前回归 |
