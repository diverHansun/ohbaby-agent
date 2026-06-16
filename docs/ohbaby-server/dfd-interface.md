# ohbaby-server · dfd-interface（数据流与接口）

> 数据流优先、接口从属。前置：[`goals-duty.md`](./goals-duty.md)、[`architecture.md`](./architecture.md)、[`data-model.md`](./data-model.md)。
> 本文只讲数据**如何进出本包**，不画全系统拓扑。

---

## 1. Context & Scope（上下文与范围）

```
       入                         本包                          出
 CLI(attach) ─RPC/SSE─┐                              ┌─► agent backend
 browser(web) ─REST/SSE┼─► ohbaby-server ────────────┤   (createPersistent
 (未来 app/ACP/A2A) ───┘   transport/protocols/        │    UiBackendClient)
                           coordination/auth           └─► (回流) UiEvent
```

- **上游（输入来源）**：前端发起的 RPC 调用、事件订阅请求、attach 连接、审批应答。
- **下游（输出去向）**：本包驱动 `ohbaby-agent` 暴露的 backend；backend 回流的 `UiEvent` 经 coordination 分发回各前端。
- **范围**：本文覆盖 transport ↔ protocols ↔ coordination ↔ backend 之间的数据流；不覆盖 agent 内部如何执行 agent run。

---

## 2. Data Flow Description（数据流描述）

### 流 A：RPC 调用（CLI/web → backend）
1. 前端发出 RPC 请求（jsonrpc 信封 / web REST），进入 transport（Hono）。
2. auth 中间件校验 AuthToken；失败即拒（fail-closed），流终止。
3. CORS 中间件按 origin 白名单放行（web 跨 origin）。
4. protocols 适配器解析信封 → 调用 `CoreApiHost` 对应方法。
5. 若是 prompt run，先经 coordination/prompt-queue 入对应 PromptLane（FIFO）。
6. backend 执行，结果沿原路返回前端。

### 流 B：事件订阅 + replay（backend → 前端，含断线补发）
1. 前端建立 SSE 连接，可携带 `Last-Event-ID`（= 上次 cursor）。
2. coordination/event-bus 检查该 id：
   - 在缓冲窗内 → 先补发 `(Last-Event-ID, 当前]` 区间的 EventEnvelope，再转入实时。
   - 早于窗口最小 seqNum → 返回"需全量重同步"信号（不静默丢，关键决策点）。
3. backend 产生 `UiEvent` → event-bus 打 `seqNum` 成 EventEnvelope → 存入 RingBuffer → 广播给匹配的 ClientConnection。
4. 前端每收一条更新本地 cursor。

### 流 C：审批往返（permission round-trip）
1. backend 在某 session 内发起审批请求事件。
2. coordination/permission-router 按 PermissionRouting（sessionId→clientId）只投递给**发起方**那个 ClientConnection。
3. 该前端的审批应答经流 A 回到 backend。

### 流 D：生命周期（启动/停止）
1. `ohbaby serve` → lifecycle/foreground → 装配 transport + 注入 backend → 监听 → 返回 ServerHandle。
2. ServerHandle 打印 address + authToken + 停止方式（显式，G4）。
3. Ctrl+C → 优雅关闭连接、停 backend、释放端口。

---

## 3. Interface Definition（接口定义，语义层）

| 接口（逻辑） | 输入含义 | 输出含义 | 同步性 |
|-------------|---------|---------|--------|
| `startServer(deps)` | backend 工厂 + 监听选项（host/port/token/cors origins） | ServerHandle（address/token/stop） | 同步返回 handle |
| RPC 端点（jsonrpc/web） | 经鉴权的 RPC 信封 | RPC 结果 / 错误信封 | 异步请求-响应 |
| 事件订阅端点（SSE） | 可选 `Last-Event-ID` | EventEnvelope 流（先补发后实时） | 异步事件流 |
| remote `UiBackendClient` | 与 in-process 同一 `UiBackendClient` 契约 | 同契约结果 + 连接状态 | 异步 |
| 消费 `CoreApiHost` | —（本包是调用方） | 调用 agent backend | 异步 |

- 接口都能在 §2 数据流中找到落点（无悬空接口）。
- remote client 与 in-process 共享 `ohbaby-sdk` 的 `UiBackendClient` 契约——这是"协议中性"（G3）与 attach 复用（D5）的关键。
- 建议给 sdk 增补 `ConnectionState`（connected/reconnecting/closed），让前端能感知重连（流 B 配套，记入跨模块检查）。

---

## 4. Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 更新/销毁者 | 本包是否负责状态 |
|------|--------|-----------|----------------|
| `UiEvent`（领域事件内容） | agent backend | agent backend | ❌ 只透传 + 打号 |
| EventEnvelope / RingBuffer | 本包 event-bus | 本包（淘汰/清空） | ✅ |
| ClientConnection / cursor | 本包 transport | 本包（断连清理） | ✅ |
| PromptLane 顺序 | 本包 prompt-queue | 本包 | ✅ |
| PermissionRouting | 本包 permission-router | 本包 | ✅ |
| session / message / 持久化 | agent backend | agent backend | ❌（N1） |

边界要点：**领域数据的真相在 agent backend（单写者）**；本包只对"投递可靠性"负责（序号、缓冲、路由、顺序），不对领域数据正确性负责。

---

## 自检

- 每条数据来去清楚？✅ 流 A–D。
- 所有接口都服务于某条数据流？✅。
- 数据责任是否清晰、无重复处理？✅ 领域真相归 backend，投递可靠性归本包，界线明确。
