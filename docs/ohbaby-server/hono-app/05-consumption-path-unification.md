# 05 · 消费路径统一（本阶段新增步骤）

> ADR-001 选了「默认 CLI 直连、web/serve 走 Hono app」，代价是**两条消费路径**可能行为漂移。本文是为消化这个代价而**显式新增的一步**：在**契约层**把两条路径钉到同一行为，而不是把所有路径都逼上 HTTP。
>
> 前置：[`00-scope-and-deltas.md`](./00-scope-and-deltas.md) §3（ADR-001）、Δ8。

---

## 1. 两条路径长什么样（先看清差异）

```
路径 P1（默认 CLI，直连）:
  TUI ──► UiBackendClient（in-process 直连）
         看到完整 snapshot/事件，TUI 自己管视图

路径 P2（web / serve / attach，经 Hono app）:
  client ──► Hono 路由(adapter) ──► coordination(per-client 视图 + 队列 + 审批 + event-bus) ──► UiBackendClient
            REST/SSE             snapshotForClient/routeEventForClient...        同一个 backend
```

差异的本质：**P2 比 P1 多了一层「多客户端协调」**——per-client `activeSessionId` 视图、prompt 排队、审批归属、事件按连接过滤/补发。P1 是单客户端（TUI 本身就是唯一客户端），不需要这层。

**这层差异是合理的、必要的**——不是要消灭它。要消灭的是**不受控的漂移**：同一个 backend 行为，经 P1 和经 P2 看到的语义不一致（除了「多客户端」这个本就该有的区别之外）。

---

## 2. 统一原则（三条）

### 原则 A：唯一事实源是 `CoreApiHost` / `UiBackendClient`

两条路径**消费同一个契约**。领域行为（session、run、tool、持久化）只在 backend 发生一次（单写者）。P1 和 P2 都不得各自实现领域逻辑——它们只是这个契约的两个**消费者**。

### 原则 B：per-client 视图逻辑提取为共享 coordination 单元

现状问题：`server.ts` 里的 `snapshotForClient`、`routeEventForClient`、`activeSessionId` 跟踪、command/permission 归属——这些 per-client 视图投影**埋在 jsonrpc server 内部**。一旦 web adapter 自己再写一套，必然漂移。

做法（Δ8）：抽到 `coordination/client-view.ts`，成为**具名、可单测、被两条 adapter 共用**的纯函数集合：

```
client-view.ts（纯投影，无 IO）
  projectSnapshot(snapshot, clientView) -> snapshot      // 原 snapshotForClient
  routeEvent(event, clientView, ownership) -> event | undefined  // 原 routeEventForClient
  // activeSessionId 推进、command/permission 归属推进……
```

- jsonrpc `rpc-route` 与 web `routes` **都调它**，不各写一份。
- **P1（直连）天然不调它**：单客户端＝唯一视图＝投影是恒等。换言之 P1 是 P2 在「client 数=1 且 view=全量」时的退化情形——这正是契约测试要锚定的等价关系（§3）。

### 原则 C：web 路由是纯 adapter（零业务逻辑）

web `routes.ts` 每个 handler 只做：schema 校验 → 调 coordination/backend → 投影响应。**任何 `if` 业务分支都不该出现在路由里**——出现了就说明逻辑漏到了 adapter，会和 jsonrpc/直连漂移。Review 红线。

---

## 3. 用契约测试钉住等价关系（核心机制）

这是「在契约层解决漂移」的可执行落点，也是 `app.fetch` 的正当用武之地——**用在测试里，不在运行时热路径**。

### 3.1 跨 transport 参数化契约测试

对同一组 backend 操作序列，参数化跑两种 transport，断言**可观察行为一致**：

```
transports = [
  direct:   调 UiBackendClient（P1 形态）
  inproc:   调 app.fetch / app.request（P2 形态，不开端口）
]
for each transport:
  initializeClient(fresh) ; submitPrompt("hi") ; collect events ; getSnapshot
assert: 两 transport 下，单客户端可观察序列等价
  （消息、run 状态机、审批往返、最终 snapshot 一致；
    seqNum 单调；无 P2 独有的领域差异）
```

- 这正是 opencode 用 `Server.Default().app.fetch` 在测试里验证 HTTP 面的做法——ohbaby 用它验证 **P2 与 P1 等价**。
- 「单客户端」是关键约束：多客户端的差异（视图过滤、排队）是设计内的，不纳入等价断言；等价只断言**单客户端下两路一致**。

### 3.2 client-view 纯函数单测

`projectSnapshot` / `routeEvent` 脱离 transport 单测：给定 snapshot/event + clientView，断言投影结果。保证「这层逻辑只有一份且正确」。

### 3.3 多客户端协调测试（P2 专属）

排队 FIFO、审批只回发起方、事件按连接过滤、SSE replay——这些是 P2 独有能力，单独测（不要求 P1 具备）。

---

## 4. 这一步在迁移里的位置

不是写完所有代码再来统一，而是**迁移 `server.ts` 时同步做**（见 [`06`](./06-migration-and-tests.md)）：

1. 抽 `coordination/client-view.ts`（从 `server.ts` 平移，行为不变）→ 补 §3.2 单测。
2. jsonrpc `rpc-route` 改调 client-view（行为不变，跑通现有集成测试）。
3. 加 web `routes` 时**复用同一 client-view**（原则 C）。
4. 建 §3.1 跨 transport 契约测试，作为**漂移回归门**——以后任何一路改动都要过它。

---

## 5. 约束与权衡

| 决策 | 放弃的方案 | 代价 |
|------|-----------|------|
| 契约层统一（共享 coordination + 契约测试） | 逼默认 CLI 也走 `app.fetch`（单面） | 要维护一套跨 transport 测试 + 保持 adapter 纯净；换来默认路径零序列化税、强隔离（ADR-001） |
| client-view 抽为共享纯函数 | jsonrpc/web 各写视图逻辑 | 多一个具名单元；换来「只有一份、可测、不漂移」 |
| 等价只断言单客户端 | 强求两路全等 | 多客户端差异另测；换来等价关系定义清晰、不自相矛盾 |

---

## 6. 后续维护者须知（漂移的预防）

- **新增一个 backend 能力**：必须同时给 jsonrpc 与 web 加 adapter，并跑契约测试——不能只加 web。
- **改 per-client 视图**：改 `coordination/client-view.ts` 一处，两路自动一致；不要在路由里就地改。
- **契约测试红了**：先怀疑「某一路漏了 client-view / 路由里混进了业务逻辑」，而不是改断言迁就。

---

## 自检

- 两条路径的差异是否被「合理差异 vs 不受控漂移」区分清楚？✅ §1。
- 统一是否落在契约层而非逼上 HTTP？✅ §2 + §3。
- `app.fetch` 是否只用于测试而非运行时热路径？✅ §3.1。
- 是否有可执行的漂移回归门？✅ §3.1 跨 transport 契约测试。
