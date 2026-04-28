# stream-bridge 模块 non-functional.md

本文档定义 `runtime/stream-bridge` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，当约束冲突时以此为准：

1. **发布不阻塞发布方**（首要）：publish() 是同步操作，RingBuffer 满时覆写最旧条目，不等待消费者。RunWorker 的主循环不能因订阅者消费慢而挂起。

2. **重连语义的正确性**：连续时不漏事件，断层时必须发出 stream.gap，不允许客户端无感知地接到错误位置——宁可多发 gap，不可漏发。

3. **序列化的 Fail Fast**：data 不可序列化时立即抛出异常，不静默降级。错误应在发布时暴露，而不是在消费时爆炸。

---

## 二、Operational Constraints（运行约束）

### buffer 容量

- 每个 scope 的 RingBuffer 容量应在配置中显式声明（不使用默认隐含值）
- 容量选择依据：`run/<runId>` scope 的 buffer 应足以覆盖正常 Run 的事件量 + 短暂断线重连窗口；`app` scope 的 buffer 要求更宽松
- 当前阶段不要求动态调整容量；固定配置可接受

### publish 性能

- publish() 内部操作（eventId 分配、写 buffer、通知订阅者）为纯内存操作，应在微秒级完成
- 不允许在 publish() 中做网络 I/O、DB 写入或阻塞等待

### 订阅者数量

- 单个 scope 支持多个并发订阅者（SDK / TUI / Web 可同时订阅同一个 run scope）
- 订阅者的消费速度差异不影响发布方；buffer 覆写策略对所有订阅者一视同仁（即最慢的订阅者可能触发更多 gap）

### scope 生命周期

- `run/<runId>` scope 在 RunWorker 完成回调中调用 `end()`；bridge 不自行推断 scope 结束
- scope 结束后，对应 RingBuffer 内存应被释放（不无限累积已结束 scope 的数据）

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- stream.gap 漏发：断层情况下不发出 gap 而直接续推新事件，会导致客户端状态错误，不可接受
- publish() 静默丢弃不可序列化的 data：应抛出异常，让发布方立即感知
- eventId 不单调递增（同一 scope 内）：违反订阅者的基本假设，不可接受

### 可接受的失败

- 订阅者来不及消费导致 RingBuffer 覆写：这是已知设计，通过 gap 协议处理
- HEARTBEAT_SENTINEL 延迟：定时保活不要求精确，允许事件驱动的延迟

### 可观测性

- publish() 发生覆写（RingBuffer overflow）时应记录结构化日志（scope、被覆写的 eventId 范围）
- stream.gap 事件发出时应记录日志（包含 requestedLastEventId 和 oldestRetainedEventId，便于分析 buffer 是否过小）
- scope 的 end() 调用应记录日志（scope、最终 latestEventId）

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：持久化事件流

RingBuffer 是纯内存结构，进程重启后所有历史事件丢失。这是刻意取舍——持久化事件流需要额外的存储基础设施（如 WAL 日志），当前阶段复杂度不合算。客户端通过快照机制（getSnapshot）处理重启后的状态恢复。

### 当前不追求：exactly-once 投递

stream-bridge 提供 at-most-once 的内存推送（RingBuffer 覆写）和 at-least-once 的回放（replay 路径）的组合。客户端在断线重连后可能收到重复事件，当前阶段不做幂等去重。

### 当前不追求：跨进程多实例订阅

bridge 是单进程内的内存组件，不支持多个进程实例共享同一 scope 的事件流。这是有意限制——横向扩展场景需要引入消息队列，超出当前架构范围。
