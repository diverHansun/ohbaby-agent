# scheduler 模块 test.md

本文档说明如何验证 `runtime/scheduler` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- MinHeap 的 job 入队、弹出（nextFireTime ≤ now）、tick 重新计算
- 三类 job 的触发后处理差异（ScheduledJob 重入堆、Reminder 等 disposition、FollowUp 直接丢弃）
- JobFired 事件的正确发布（字段：jobId、kind、priority、firedAt）
- disposition 协议：accepted/started → markCompleted；deferred/rejected → 不修改
- cancel()：堆移除 + SchedulerStore 状态更新
- start() 恢复：loadActive() 写入堆 + overdue job 在首次 tick 批量触发

**不覆盖**：
- heartbeat 对 JobFired 的处理逻辑（heartbeat 侧的职责）
- cron 表达式解析器的正确性（第三方库，不重复测试）
- SchedulerStore 的 SQL 语句实现细节（run-ledger 层的约定）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：Job 注册与 MinHeap

| 场景 | 预期结果 |
|------|---------|
| addReminder({ fireAt }) | jobId 返回；MinHeap 包含该 job；SchedulerStore.save() 被调用 |
| addFollowUp({ fireAt }) | jobId 返回；MinHeap 包含该 job；SchedulerStore 不被调用 |
| 注册多个 job，堆顶为最近的 nextFireTime | 堆顶 job 的 nextFireTime 最小 |

### 场景组 2：tick 触发

| 场景 | 预期结果 |
|------|---------|
| tick 时有 ScheduledJob 到期 | 发布 JobFired(kind='scheduled', priority=2)；重新计算 nextFireTime；重新入堆；SchedulerStore.update() 被调用 |
| tick 时有 Reminder 到期 | 发布 JobFired(kind='reminder', priority=3)；Reminder 从堆移除；SchedulerStore 不立即写 completed |
| tick 时有 FollowUp 到期 | 发布 JobFired(kind='follow-up', priority=1)；FollowUp 从堆移除；SchedulerStore 不被调用 |
| tick 时多个 job 同时到期 | 全部触发，均发布 JobFired；所有到期 job 从堆弹出 |
| tick 时无 job 到期 | 不发布 JobFired；等待下一个 nextFireTime |

### 场景组 3：disposition 协议

| 场景 | 预期结果 |
|------|---------|
| 收到 SignalDisposition { disposition: 'accepted' } | SchedulerStore.markCompleted(jobId) |
| 收到 SignalDisposition { disposition: 'started' } | SchedulerStore.markCompleted(jobId) |
| 收到 SignalDisposition { disposition: 'deferred' } | SchedulerStore 不修改；Reminder 保持 active |
| 收到 SignalDisposition { disposition: 'rejected' } | SchedulerStore 不修改；记录 warning |

### 场景组 4：cancel() 与 start() 恢复

| 场景 | 预期结果 |
|------|---------|
| cancel(jobId) | MinHeap 移除该 job；SchedulerStore.markCancelled(jobId)（若为 ScheduledJob/Reminder）|
| cancel() 不存在的 jobId | 幂等，无操作 |
| start() 时 DB 有 active Reminder（overdue）| 写入堆；首次 tick 立即触发 |
| start() 时 DB 无 active job | 堆为空；不设置 tick |

---

## 三、Integration Points（集成点测试）

### 集成点 1：scheduler + SchedulerStore（轻集成）

**验证重点**：addReminder 触发 SchedulerStore.save()；disposition=accepted 触发 markCompleted；cancel 触发 markCancelled；start() 调用 loadActive()

**方式**：使用真实 in-memory SQLite（scheduler_job 表），断言 DB 记录的 status 变化

**关注**：触发 JobFired 后 Reminder 的 status 不立即变为 completed（必须等 disposition）

### 集成点 2：scheduler + Bus（单元测试）

**验证重点**：tick 触发时正确发布 Scheduler.Event.JobFired；disposition 处理来自 Heartbeat.Event.SignalDisposition 订阅

**方式**：fake Bus；手动 emit SignalDisposition 事件，断言 SchedulerStore 调用

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试（unit）为主，disposition 协议做轻集成

**单元测试覆盖**（使用 fake timers）：
- MinHeap 操作（入队、弹出、重入堆）
- tick() 函数的三类 job 分支处理
- JobFired 字段正确性（kind、priority 映射）
- cancel() 幂等性

**Fake Timer 使用约定**：
- 用 fake timers（如 `@sinonjs/fake-timers`）替换 `setTimeout`，在测试中手动推进时间
- 不依赖真实时间流逝；测试执行速度不受 intervalMs 影响

**Mock 范围**（unit 层）：
- `SchedulerStore` → fake store（记录调用，可配置 loadActive 返回值）
- `Bus` → fake bus（记录发布事件，支持手动 emit）
- `Date.now()` → fake timer 控制的时间

**轻集成测试（Reminder disposition 协议）**：
- 使用真实 in-memory SQLite
- 不 mock SchedulerStore，断言 DB 中 scheduler_job.status 的变化时机
- 验证「触发时不写 completed，disposition=accepted 后才写」的时序不变量

### 关注点：时序不变量

disposition 协议测试的核心断言不是「markCompleted 被调用」，而是「在 JobFired 发布后、disposition 到达之前，DB 中 Reminder 的 status 仍为 active」。这是时序断言，单纯的调用次数测试不足以验证。
