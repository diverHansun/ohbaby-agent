# ohbaby-server · data-model（核心概念）

> 可选文档。本包确有长期存在的协调状态（连接、事件缓冲、队列、审批映射），值得统一"用什么概念思考"。
> 本文是**概念词典**，不是类定义、不是数据库表。前置：[`architecture.md`](./architecture.md)。

---

## 1. Core Concepts（核心概念）

| 概念 | 一句话解释 | 类型 |
|------|-----------|------|
| **ClientConnection** | 一个已连接的前端（CLI / browser / attach），是事件订阅与审批归属的主体 | Entity（有身份、有生命周期） |
| **EventEnvelope** | 把一条 `UiEvent` 包上单调序号后的投递单元，是 SSE replay 的最小单位 | Value Object（不可变） |
| **EventRingBuffer** | 一段有界的、按序号保存近期 EventEnvelope 的缓冲，断线重连时据此补发 | Entity（owns 状态） |
| **PromptLane** | 队列中的一条串行通道；同一 session 的 prompt 在同一 lane 内 FIFO | Entity |
| **PermissionRouting** | session → 发起 ClientConnection 的归属映射，决定审批事件回到谁 | Entity（映射状态） |
| **AuthToken** | 访问 server 的 bearer 凭证，校验为 fail-closed + 常量时间比较 | Value Object |
| **ServerHandle** | 一个正在运行的 server 实例的对外把手：监听地址、token、停止方式 | Entity（生命周期 = 进程） |

> 领域对象（session、message、tool run、agent backend）**不属于本包**——它们是 `ohbaby-agent` 的概念，本包只透传（N1）。

---

## 2. Entity / Value Object 区分

- **Entity（有身份/状态）**：ClientConnection、EventRingBuffer、PromptLane、PermissionRouting、ServerHandle——它们的身份与生命周期会被追踪。
- **Value Object（不可变）**：EventEnvelope、AuthToken——按值传递，不单独管理生命周期。

此区分仅为帮助理解，不强制 DDD 实现。

---

## 3. Key Data Fields（关键数据要素）

只描述含义，不列类型：

- **EventEnvelope**
  - `seqNum`：单调递增序号，是 replay 的锚点（对应 SSE 的 `Last-Event-ID`）。
  - `payload`：被包裹的 `UiEvent`（本期直发，不做领域投影，见 N5）。
- **EventRingBuffer**
  - 容量上界：缓冲是**有界**的，超窗的旧事件会被淘汰。
  - 淘汰边界：客户端请求的 `Last-Event-ID` 若早于当前最小 seqNum，则**无法补发**，需触发全量重同步（关键失败点，见 use-case / non-functional）。
- **ClientConnection**
  - `clientId`：连接身份。
  - `cursor`：该连接已确认收到的最大 seqNum（重连补发的起点）。
- **PermissionRouting**
  - `sessionId → clientId`：审批归属，保证权限问题回到发起方。
- **ServerHandle**
  - `address`、`authToken`、`stop()` 语义：`ohbaby serve` 必须把前两者打印给用户（显式生命周期，G4）。

---

## 4. Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建时机 | 失效/销毁 | 归属组件 |
|------|---------|----------|---------|
| ClientConnection | 前端建立 SSE/RPC 连接 | 断连 | transport + coordination |
| EventEnvelope | backend 产生 UiEvent 时打号 | 随 RingBuffer 淘汰 | coordination/event-bus |
| EventRingBuffer | server 启动 | server 停止 | coordination/event-bus |
| PromptLane | 首个该 session 的 prompt 入队 | 该 lane 排空（生命周期细节待 S8 修） | coordination/prompt-queue |
| PermissionRouting | session 由某 client 发起 | session 结束或 client 断连 | coordination/permission-router |
| AuthToken | server 启动时生成 | server 停止 | auth |
| ServerHandle | `startServer` 返回 | `stop()` / 进程退出 | lifecycle |

---

## 自检

- 所有概念都能用自然语言解释？✅
- 是否有"为设计而设计"的抽象？无——每个概念在 dfd/use-case 中都有使用场景。
- 是否有概念在架构中未出现？无——均对应 `coordination/` `auth/` `transport/` `lifecycle/`。
- 演进提醒：若 EventEnvelope 将来需要领域投影（A1），需同步 dfd-interface 与 test。
