# stream-bridge 模块 test.md

本文档说明如何验证 `runtime/stream-bridge` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- eventId 的单调递增（per scope，不跨 scope 共享）
- RingBuffer 的写入、覆写（满时覆写最旧）、oldestId/latestId 边界维护
- ReplayPlan 决策：连续（lastEventId >= oldestId - 1）→ replay；断层 → stream.gap
- subscribe() 的三种路径：全新订阅、连续重连、断层重连
- stream.gap 事件字段正确性（不写入 RingBuffer，不推进 eventId）
- end(scope) 发送 END_SENTINEL，AsyncIterable 正确完成
- publish() 对不可序列化 data 的 Fail Fast

**不覆盖**：
- 客户端如何处理 stream.gap（client / interfaces/server 侧）
- getSnapshot() 快照生成（interfaces/server 侧）
- HEARTBEAT_SENTINEL 的精确发送间隔（保活，不影响业务正确性）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：publish 与 RingBuffer

| 场景 | 预期结果 |
|------|---------|
| publish(scope, event, data) | 分配递增 eventId；写入 RingBuffer；通知订阅者 |
| publish 不可序列化 data | 立即抛出异常；不写入 buffer；eventId 不推进 |
| RingBuffer 满时 publish | 覆写最旧条目；oldestId 推进；latestId 推进 |
| 不同 scope 的 eventId 独立 | scope A 和 scope B 各自从 0 开始，互不干扰 |

### 场景组 2：subscribe — 全新订阅

| 场景 | 预期结果 |
|------|---------|
| subscribe(scope)，无 lastEventId | 只推送新事件（不回放历史）|
| 订阅后 publish 新事件 | AsyncIterable yield 该事件 |
| end(scope) 调用 | AsyncIterable 完成（done: true）|

### 场景组 3：subscribe — 断线重连（连续）

| 场景 | 预期结果 |
|------|---------|
| lastEventId = buffer.latestId（刚断线）| replay 为空；切换为推送模式 |
| lastEventId = buffer.oldestId - 1（临界点）| replay 全部 buffer 内容；切换推送 |
| lastEventId 在 buffer 范围内（中间断点）| 从 lastEventId + 1 开始 replay；之后推送 |

### 场景组 4：subscribe — 断线重连（断层）

| 场景 | 预期结果 |
|------|---------|
| lastEventId < buffer.oldestId - 1 | yield stream.gap 事件（id=latestId，不进 buffer，不推进 eventId）；之后推送新事件 |
| stream.gap 后继续推送 | gap 之后的 yield 是最新事件（不是 gap 前的历史）|

---

## 三、Integration Points（集成点测试）

stream-bridge 是纯内存组件，无外部 I/O 依赖，所有测试均为单元测试。

**唯一的"集成"场景**：验证 publish → subscribe 的完整推送链路（发布方写入 buffer，订阅方的 AsyncIterable 收到事件）。这是内部的端到端路径，仍属于 unit 测试范围（无外部依赖）。

---

## 四、Verification Strategy（验证策略）

### 主策略：纯单元测试（unit）

**测试对象**：StreamBridge（publish/subscribe/end）、RingBuffer（容量、覆写、边界）、ReplayPlan 决策函数

**Mock 范围**：无需 mock（stream-bridge 无外部依赖）

**关注点：AsyncIterable 的测试方式**

消费 AsyncIterable 需要在测试中 await for-of 循环或手动调用 next()。推荐模式：
```
const iter = bridge.subscribe(scope)
// publish some events
const first = await iter.next()  // 取第一个事件
assert first.value.event === 'run.output'
```
对于 end() 测试：publish 后调用 end(scope)，再 await iter.next() 应返回 `{ done: true }`

**关注点：stream.gap 的 eventId 不变量**

验证 stream.gap 前后的 eventId：发出 gap 之前的 latestId 和发出 gap 之后再次 publish 的新 eventId 之间不存在 gap 事件本身占用的 id 值。具体断言：stream.gap.id === latestId（位置提示，非新分配的 id）；下一条 publish 的 eventId = latestId + 1（连续，未被 gap 占用）。

**关注点：RingBuffer 覆写后的边界**

测试 buffer 容量为 N 的场景：publish N+1 个事件后，oldestId 应为 2，latestId 为 N+1；subscribe(scope, 0)（断层）应得到 stream.gap（0 < oldestId - 1 = 1）。
