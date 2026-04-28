# heartbeat 模块 use-case.md

本文档描述 `runtime/heartbeat` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Process WakeSignal | Bus 事件（JobFired / WakeRequested） | 状态感知信号处理，决策 Run 创建或信号缓冲 |
| UC2 | Restore from Paused（DeferredQueue drain） | daemon/supervisor 调用 setState('active') | 恢复后补偿执行被缓冲信号 |
| UC3 | Enter Sleeping with Follow-Up Registration | run-manager 通知 agent 主动挂起 | 注册唤醒计划，转入 sleeping 状态 |

---

## 二、Main Flow Description（主流程描述）

### UC1：Process WakeSignal

heartbeat 的核心职责。所有信号（scheduler 触发或 channel 触发）均经过此路径决策。

```
输入：WakeSignal（来自 Bus 的 JobFired 或 WakeRequested 事件）
  ↓
1. 读取当前 AgentState（active / paused / sleeping / blocked）
  ↓
2. 根据状态路由决策：

  [active]
    → mapSignalToTrigger(kind) 得到 triggerSource
    → 调用 runManager.create({ triggerSource, sessionId })
    → 发布 SignalDisposition { disposition: 'accepted' }（仅 scheduler 信号需要）

  [paused]
    → 尝试 DeferredQueue.enqueue(signal)
      ├── 入队成功 → SignalDisposition { disposition: 'deferred' }
      └── 队列已满且无法驱逐 → SignalDisposition { disposition: 'rejected' }

  [sleeping]
    → 判断信号优先级 / kind 是否满足提前唤醒条件
      ├── 满足（priority 足够 或 kind='reminder'）
      │   → setState('active')
      │   → runManager.create(...)
      │   → SignalDisposition { disposition: 'accepted' }
      └── 不满足
          → SignalDisposition { disposition: 'rejected' }

  [blocked]
    → 不创建 Run
    → SignalDisposition { disposition: 'rejected' }（scheduler 信号）
  ↓
3. 输出：一次 runManager.create() 调用，或一条 SignalDisposition 事件（两者之一或同时）
```

**注意**：channel 信号（WakeRequested）不进入 scheduler Reminder 的 disposition 协议，无需发布 SignalDisposition；其结果可通过 app.* 事件或日志表达。

---

### UC2：Restore from Paused（DeferredQueue drain）

daemon/supervisor 恢复 agent 运行时触发。

```
输入：setState('active') 调用（外部）
  ↓
1. HeartbeatMachine 完成状态转换：paused → active
  ↓
2. DeferredQueue.drain()
   → 按优先级顺序取出所有缓冲信号（Reminder=3 > ScheduledJob=2 > FollowUp=1）
  ↓
3. 对每条缓冲信号重新走 UC1 的 active 分支：
   → mapSignalToTrigger(kind) → runManager.create({ triggerSource, sessionId })
   → 若信号带 jobId，发布 SignalDisposition { disposition: 'accepted' }
  ↓
输出：每条信号对应一次 runManager.create() 调用
```

**注意**：drain 过程中 heartbeat 不再缓冲新信号，因为状态已经是 active。若 drain 中途创建 Run 失败，当条信号跳过，不中断后续 drain。

---

### UC3：Enter Sleeping with Follow-Up Registration

agent 主动完成一次 Run 后请求挂起，等待指定时间后自动续跑。

```
输入：run-manager 通知 heartbeat { durationMs, sessionId }（agent 请求 sleeping N 秒）
  ↓
1. HeartbeatMachine.onAgentSleepRequest() 被调用
  ↓
2. 调用 scheduler.addFollowUp({ fireAt: now + durationMs, sessionId })
   → 得到 jobId（纯内存 FollowUp，不持久化）
  ↓
3. setState('sleeping')，记录预期唤醒时间
  ↓
（N 秒后，scheduler 发出 JobFired { kind: 'follow-up' }）
  ↓
4. UC1 sleeping 分支处理：follow-up 信号满足唤醒条件
   → setState('active')
   → runManager.create({ triggerSource: 'follow-up', sessionId })
  ↓
输出：agent 在 N 秒后自动恢复执行
```

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| 维护 AgentState | heartbeat（HeartbeatMachine 私有）| 外部只能触发转换，不能直接写入 |
| mapSignalToTrigger() | heartbeat | kind → triggerSource 的映射逻辑归 heartbeat 所有 |
| 决策是否创建 Run | heartbeat | 基于状态和优先级判断；run-manager 不参与这一决策 |
| 调用 runManager.create() | heartbeat | 仅在决策通过后调用，不传入 permissionProfileId |
| DeferredQueue 的入队/出队策略 | heartbeat（私有）| 外部不可见；queue 容量上限由 heartbeat 内部策略决定 |
| 发布 SignalDisposition | heartbeat | 结果通知给 scheduler，驱动 Reminder 状态写入 |
| addFollowUp() | scheduler | heartbeat 调用接口，不自己管理 timer |
| 决定是否接受信号（run-manager 侧）| run-manager | 并发仲裁（同 session 是否已有 active Run）是 run-manager 职责 |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：sleeping 状态的提前唤醒门槛

**问题**：sleeping 状态下低优先级信号到达，是否唤醒？
**当前策略**：`priority < threshold 或 kind 不为 'reminder'` → 拒绝，发布 `rejected`
**风险**：threshold 定义需要在实现阶段明确数值，否则 scheduled（priority=2）可能被错误拒绝

### 决策点 2：DeferredQueue 满时的驱逐策略

**问题**：paused 状态下信号持续入队，队列满时如何处理？
**当前策略**：无法驱逐时发布 `rejected`，Reminder 保持 active 状态（不丢失，等待下次触发）
**风险**：队列长期不 drain（agent 长时间 paused）会导致大量信号被 rejected；scheduler 的 Reminder 不会重复触发

### 失败点 1：runManager.create() 调用失败

**场景**：active 状态下 runManager.create() 抛出异常（如并发冲突）
**预期行为**：heartbeat 记录日志，不向 Bus 传播异常；SignalDisposition 仍发布 `rejected`
**注意**：此时 Reminder 会保持 active，后续可由 scheduler 重新触发

### 失败点 2：进程重启期间 sleeping 状态丢失

**场景**：agent 处于 sleeping 状态时进程崩溃，FollowUp 不持久化
**预期行为**：重启后 heartbeat 进入 active 状态（默认初始态）；FollowUp 不恢复
**注意**：此为已知边界，run-manager 的崩溃恢复（markInterrupted）会处理未完成的 Run，但 sleeping 的续跑计划不恢复
