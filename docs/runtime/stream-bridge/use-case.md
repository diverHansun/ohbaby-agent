# stream-bridge 模块 use-case.md

本文档描述 `runtime/stream-bridge` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Subscribe and Receive Events | SDK / TUI / Web client | 提供 AsyncIterable，推送实时事件 |
| UC2 | Reconnect and Resume（含 gap 处理）| client 断线重连 | 回放历史或发出 gap 信号，移交恢复责任 |

---

## 二、Main Flow Description（主流程描述）

### UC1：Subscribe and Receive Events

client 首次建立连接，接收实时事件流。

```
输入：subscribe(scope)  ← 无 lastEventId
  ↓
1. 为此 client 创建一个 AsyncIterable<StreamEvent>
  ↓
2. 从当前 latestId + 1 开始监听新事件（不回放历史）
  ↓
3. 发布方（RunWorker / app-events.ts / command-events.ts）每次 publish(scope, event, data)：
   → stream-bridge 分配单调递增 eventId
   → 写入 RingBuffer
   → 通知所有正在 subscribe 的 AsyncIterable 消费者
   → client 的 AsyncIterable 迭代到新事件
  ↓
4. 定期 yield HEARTBEAT_SENTINEL（保持连接活跃，不写入 RingBuffer）
  ↓
5. end(scope) 调用时：
   → 向所有订阅者发送 END_SENTINEL
   → AsyncIterable 完成（done: true）
  ↓
输出：client 持续收到事件，直到 scope 结束
```

---

### UC2：Reconnect and Resume（含 gap 处理）

client 断线后重连，尝试从上次位置恢复。这是 stream-bridge 的行为承诺：**bridge 保证告知 client 是否可以无缝续接，client 负责据此决定如何恢复状态。**

```
输入：subscribe(scope, lastEventId)  ← 断线重连
  ↓
1. getReplayPlan(scope, lastEventId)
   → 对比 lastEventId 与 buffer.oldestId：
  ↓
  [连续情况：lastEventId >= buffer.oldestId - 1]
    → 从 lastEventId + 1 开始回放 RingBuffer 中的历史事件
    → 回放完成后无缝切换为推送模式（继续推送新事件）
    → client 无感知，可以直接续接

  [断层情况：lastEventId < buffer.oldestId - 1（buffer 已覆写中间事件）]
    → 立即 yield stream.gap 事件：
        {
          id: buffer.latestId,  // 位置提示，非新 eventId
          event: 'stream.gap',
          data: { scope, requestedLastEventId, oldestRetainedEventId, latestEventId, reason: 'buffer-overflow' }
        }
      stream.gap 是合成控制事件，不写入 RingBuffer，不推进 eventId 计数器
    → yield stream.gap 后切换为推送模式（推送当前最新事件开始往后）
    → client 收到 stream.gap 后，须另行调用 getSnapshot() 重建状态后续接
  ↓
输出：连续情况下 client 无缝续接；断层情况下 client 收到 stream.gap 并知晓需要重建状态
```

**行为承诺**：
- bridge 保证：如果 buffer 连续，client 不会错过任何事件
- bridge 保证：如果 buffer 溢出，client 一定会收到 stream.gap，不会静默续接到错误位置
- bridge 不保证：快照的生成（getSnapshot() 由 interfaces/server 提供，不在 bridge 职责范围）

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| eventId 分配（单调递增）| stream-bridge | per-scope 唯一；发布方无法指定 eventId |
| RingBuffer 写入与管理 | stream-bridge（内部）| 容量、覆写策略、oldestId 边界均由 bridge 维护 |
| ReplayPlan 决策（连续/断层）| stream-bridge | getReplayPlan() 是 bridge 内部逻辑 |
| stream.gap 事件生成 | stream-bridge | 唯一生产者；gap 是 bridge 对 client 的信号，不存储 |
| getSnapshot() 快照生成 | interfaces/server | **不在 bridge 职责范围**；bridge 发出 gap 信号，server 提供快照 |
| 客户端状态重建 | client（SDK/TUI/Web）| 收到 stream.gap 后，client 负责调用 getSnapshot() 并重置本地状态 |
| scope 生命周期管理 | run-manager（run scope）/ daemon（app scope）| bridge 暴露 end()，调用时机由外部决定 |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：连续/断层的判定边界

**问题**：`lastEventId = buffer.oldestId - 1` 是临界点，属于连续还是断层？
**当前策略**：`lastEventId >= buffer.oldestId - 1` → 连续（可 replay）；严格小于 → 断层
**注意**：实现时边界条件需精确处理，差一个 id 会导致误发 gap 或漏发 gap

### 决策点 2：stream.gap 之后从哪个 eventId 开始推送

**问题**：发出 gap 后，client 通过 getSnapshot() 重建状态，然后续接 subscribe——此时应从哪个 eventId 开始？
**当前策略**：getSnapshot() 返回的 snapshot 中应携带一个 cursor（当前 latestEventId），client 用这个 cursor 再次调用 subscribe 做 replay 续接
**注意**：此协议需要 interfaces/server 的 getSnapshot() 与 stream-bridge 的 subscribe 接口共同遵守

### 失败点 1：RingBuffer 满时 publish 行为

**场景**：事件发布速率超过 client 消费速率，RingBuffer 被持续写满
**预期行为**：覆写最旧条目（非阻塞，不等待消费者）；后续重连时触发 gap 协议
**约束**：publish() 是同步操作，不允许因 buffer 满而阻塞发布方（RunWorker）

### 失败点 2：publish 时 data 不可 JSON 序列化

**场景**：发布方传入包含循环引用或不可序列化对象的 data
**预期行为**：stream-bridge 在 publish() 时立即抛出异常（Fail Fast）；不写入 buffer
**注意**：发布方有责任确保 data 可序列化；bridge 不静默降级（不 JSON.stringify fallback）
