# 03 · 事件分发与 SSE replay（event-bus）

> 修 S1：当前 SSE 断线即丢事件，浏览器刷新/弱网会让前后端状态发散——这是**正确性** bug，不是体验问题。本文定义 event-bus：单调序号 + 环形缓冲 + 断线补发，以及 sdk 侧的 `ConnectionState`。
>
> 前置：[`01`](./01-app-assembly-and-transport.md)、父目录 [`../data-model.md`](../data-model.md)、[`../dfd-interface.md`](../dfd-interface.md) 流 B。

---

## 1. 问题回顾（S1）

现状 `server.ts`：
- `handleEvents()` 只读 `clientId`，**不解析 `Last-Event-ID`**；事件无序号、无缓冲。
- `broadcast()` 实时遍历当前连接 `writeSse`，过期即丢。
- remote client SSE 读循环 `done → return`，**无重连、无补发**。

CLI 在本机稳定长连接下无感；但浏览器刷新、移动端切后台/弱网必然断开，**断开到重订阅之间的事件永久丢失**。web/app 的硬伤。

---

## 2. 核心机制

```
backend.subscribeEvents ─► event-bus.publish(UiEvent)
                              │ 1. 打单调 seqNum → EventEnvelope
                              │ 2. 存入 EventRingBuffer（有界）
                              │ 3. 广播给匹配的 ClientConnection（经 client-view 投影/过滤）
                              ▼
       SSE 连接（GET /v1/events 或 /api/events）
         ├─ 带 Last-Event-ID=N → 先补发 (N, 当前] 区间，再转实时
         ├─ N < 缓冲最小 seqNum → 发「需全量重同步」信号（不静默丢）
         └─ 无 Last-Event-ID → 从当前实时开始（首连）
```

| 概念（沿用 [`../data-model.md`](../data-model.md)） | 本文落点 |
|------|------|
| **EventEnvelope** = `{ seqNum, payload: UiEvent }` | `coordination/event-bus.ts` 打号 |
| **EventRingBuffer** 有界、按序保存近期 envelope | event-bus owns，server 启动建、停止清 |
| **ClientConnection.cursor** = 已确认最大 seqNum | transport 维护，断连清理 |

> `seqNum` 即 SSE 的 `id:` 字段；浏览器 `EventSource` 断线重连会自动带 `Last-Event-ID` header——event-bus 据此补发。这是「用平台原生能力，不自造重连协议」。

---

## 3. 关键决策点：缓冲窗口外怎么办

`Last-Event-ID` 早于缓冲最小 seqNum（事件已被淘汰）时**绝不静默丢**（父目录 non-functional §1）。二选一，本阶段选**显式重同步信号**：

- event-bus 发一条 `resync-required` 控制事件（带当前最小/最大 seqNum）。
- 前端收到后丢弃本地状态，重新 `GET /v1/snapshot` 拉全量，再从最新 seqNum 续 SSE。

理由：补发任意久远历史需要无界缓冲（违反 non-functional §2 内存有界）。有界缓冲 + 显式重同步，是「正确性 + 内存可控」的平衡。

---

## 4. 与 per-client 投影的关系

event-bus 负责**投递可靠性**（序号、缓冲、补发）；**投递给谁、投影成什么视图**是 `coordination/client-view` 的事（见 [`05`](./05-consumption-path-unification.md)）。次序：

```
publish → 打号入缓冲 → 对每个连接：client-view 投影/过滤 → 命中则 writeSse(id=seqNum)
```

> seqNum 在**投影前**就打定（全局单调，对所有连接一致）。补发时按连接 cursor 取区间，再逐条过投影。这样不同连接看到的内容可不同，但 seqNum 轴一致，replay 才可靠。

---

## 5. sdk 侧：`ConnectionState`（远程重连可感知）

给 `ohbaby-sdk` 增补（最小新增，对齐 dfd-interface §3 建议）：

- `ConnectionState = "connected" | "reconnecting" | "closed"`。
- `UiBackendClient.subscribeConnection?(cb)`（可选）：远程 client 据 SSE/传输状态推送。

用途：
- 前端区分「在连 / 断开重连中 / 已关」，据此提示「连接中断，请重新提交」（N3：不自动重放 prompt）。
- **仅远程 client 实现**；in-process 直连 backend 无连接状态（恒 connected），保持契约一致但不强制实现。

---

## 6. 顺手处理的协调缺陷

| 缺陷 | 现状 | 本阶段 |
|------|------|------|
| S8 | prompt-queue 把所有无 sessionId 的 prompt 归入同一 `__fresh__` lane，跨客户端过度串行 | 见 [`04`](./04-multi-project-runtime.md)（按 client/scope 分 lane） |
| S9 | `disconnectClient` 是空 stub，断连客户端已排队未启动的 prompt 仍执行 | 见 [`04`](./04-multi-project-runtime.md)（断连清待决队列，已启动的不取消——N3） |

> 这两项属 coordination，与 event-bus 同目录，迁移时一并处理；细节落在 04，本文只标关联。

---

## 7. 约束与权衡

| 决策 | 放弃的方案 | 代价 |
|------|-----------|------|
| 有界环形缓冲 + 显式重同步 | 无界缓冲全量补发 | 久断线要全量重拉一次；换来内存有界（non-functional §2） |
| seqNum 全局单调、投影后置 | per-client 各自序号 | 投影逻辑要在补发路径也跑一遍；换来 replay 锚点一致、实现简单 |
| 复用浏览器 `Last-Event-ID` | 自造重连握手协议 | 受限于 SSE 语义；换来零自造协议、app 也能照搬 |

---

## 自检

- replay 锚点（seqNum/Last-Event-ID）定义清楚？✅ §2。
- 窗口外不静默丢？✅ §3 显式 resync。
- 投递可靠性与视图投影职责分离？✅ §4。
- 重连可被前端感知？✅ §5 ConnectionState。
