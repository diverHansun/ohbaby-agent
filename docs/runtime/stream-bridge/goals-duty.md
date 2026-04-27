# stream-bridge 模块 goals-duty.md

本文档定义 `runtime/stream-bridge` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供跨进程事件流的统一接口抽象

进程内的模块通信已由 `bus` 模块承担。stream-bridge 解决的是另一个问题：如何将 runtime 内部的事件可靠地投递给外部消费者（TUI、SDK 客户端、未来的 SSE/WebSocket 客户端），并支持断连重连。接口一旦稳定，内部实现（内存版 → SSE 版 → WebSocket 版）可以替换而不影响调用方。

### 2. 从第一天起就满足跨进程传输的约束

即使 MVP 阶段只做内存版，也必须强制 payload JSON 序列化约束、实现单调递增 eventId、支持滚动 buffer。这样当后续切换到 SSE/WebSocket 时，调用方代码无需修改。

### 3. 支持客户端断连后的事件补偿

客户端（TUI / SDK）因网络或重启断连后，可以携带上次收到的 `Last-Event-ID` 重新订阅，bridge 从 buffer 中重放丢失的事件。这是 SSE 协议的标准语义，内存版也必须实现。

### 4. 区分 run 级事件与 app 级事件

`run.*` 事件按 runId 路由，只有订阅了对应 runId 的客户端才会收到。`app.*` 事件是进程级别的全局事件（如 policy 模式切换、scheduler 触发日志），所有客户端默认订阅。两种命名空间通过同一个 bridge 实例管理。

---

## 二、Duties（职责）

### 1. 定义 StreamBridge 接口

负责：
- 定义 `StreamBridge` 抽象接口（`publish` / `subscribe` / `end`）
- 定义 `StreamEvent` 数据结构（`id` / `event` / `data` / `runId?`）
- 定义 `HEARTBEAT_SENTINEL` 和 `END_SENTINEL` 常量
- 接口定义发布到 `ohbaby-sdk`，作为 runtime 与外部消费者的契约

### 2. 实现 InMemoryStreamBridge

负责：
- 维护每个 runId 的事件 buffer（滚动窗口，默认保留最近 200 条）
- 维护 app 级别的全局事件 buffer
- 分配单调递增 eventId（per-runId 范围内单调）
- 实现 `subscribe(runId?, lastEventId?)` 返回 AsyncIterable\<StreamEvent\>
- 从 buffer 重放 lastEventId 之后的事件
- 定时发送 `HEARTBEAT_SENTINEL`（长时间无事件时）
- run 结束时发送 `END_SENTINEL` 并清理订阅

### 3. 强制 payload 序列化约束

负责：
- 在 `publish()` 内部强制执行 `JSON.stringify` + `JSON.parse` 一次
- 拒绝含有函数、类实例、循环引用的 payload（开发期抛出错误）
- 确保 payload 类型与 `ohbaby-sdk` 中的事件类型定义一致

### 4. 处理 runId 不存在时的边界情况

负责：
- 当 subscribe 的 runId 不存在时，立即返回 END_SENTINEL
- 当 lastEventId 早于 buffer 最早 eventId 时，返回 `replay-gap` / `snapshot-required` 事件，要求客户端重新获取快照

### 5. app 级全局事件的广播

负责：
- `publish(null, 'app.*', payload)` 广播给所有活跃订阅者
- app 级事件同样维护 buffer 和 eventId

---

## 三、Non-Duties（非职责）

### 1. 不负责事件的产生与决策

bridge 是被动的发布/订阅中介。决定"哪些 Bus 事件需要对外发布"是 runtime 事件翻译层的职责：`runtime/run-manager/worker` 负责 `run.*`，daemon 持有的 app-event adapter 负责 `app.*`。bridge 只做传输。

### 2. 不负责 SSE / WebSocket 服务器

stream-bridge 模块只定义接口和内存实现。HTTP 服务器层（接受 SSE 连接，将 subscribe 的 AsyncIterable 写入 HTTP Response）由 `interfaces/server` 模块负责。

### 3. 不负责认证与授权

订阅 stream 的权限检查（哪个客户端可以订阅哪个 runId）由 `interfaces/server` 或基于 `ohbaby-sdk` 的客户端适配层处理，bridge 不感知身份信息。

### 4. 不负责事件持久化

bridge 只维护内存滚动 buffer，不写入数据库或文件。需要长期保存的消息和 part 由 `services/session` 负责。

### 5. 不负责 Bus 事件的订阅

bridge 不直接订阅 bus。`runtime/run-manager/worker` 负责订阅 bus 并调用 bridge.publish()，bridge 本身不与 bus 产生依赖。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/run-manager` | 被调用 | worker 调用 bridge.publish() 发布翻译后的事件 |
| `docs/ohbaby-sdk` / `ohbaby-sdk` | 契约来源 | 事件类型、StreamBridge 接口、订阅参数和快照语义定义在 SDK；bridge 从 SDK 导入类型 |
| `interfaces/server` | 被依赖 | server 层调用 bridge.subscribe() 将事件流转为 SSE/HTTP 响应 |
| `bus` | 无直接依赖 | bridge 不订阅 bus，run.* 翻译由 run-manager/worker 承担，app.* 翻译由 daemon app-event adapter 承担 |
| `runtime/daemon` | 被持有 | daemon 持有 bridge 实例，负责其初始化与关闭 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：bridge 只做传输，不决策
```typescript
// stream-bridge 负责
bridge.publish(runId, 'run.step.started', {
  stepIndex: 3,
  timestamp: Date.now(),   // number，不是 Date 对象
})
```

正确：订阅时支持 lastEventId 重放
```typescript
// 消费方（interfaces/server）负责传入 lastEventId
for await (const event of bridge.subscribe(runId, lastEventId)) {
  // 从断连位置续读
}
```

### 5.2 职责外的示例

错误：bridge 不应决定哪些 Bus 事件对外发布
```typescript
// 错误：不应该在 bridge 内部
bus.on(Lifecycle.Event.StepStarted, (payload) => {
  this.publish(runId, 'run.step.started', payload)
})

// 正确：run.* 逻辑在 runtime/run-manager/worker 中，app.* 逻辑在 daemon app-event adapter 中
```

错误：bridge 不应处理 HTTP 连接
```typescript
// 错误：不应该在 bridge 内部
app.get('/events/:runId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  // ...
})

// 正确：由 interfaces/server 负责
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：stream-bridge 提供跨进程事件流的接口抽象和内存实现，使 runtime 内部事件可被外部客户端订阅，并支持断连重放
- 能清楚回答"这个模块不该做什么"：不做事件产生与决策、不做 HTTP 服务器、不做认证授权、不做事件持久化、不订阅 bus
- 职责与其他模块无明显重叠：run-manager/worker（事件翻译）、interfaces/server（HTTP 传输）、bus（进程内通信）边界清晰
