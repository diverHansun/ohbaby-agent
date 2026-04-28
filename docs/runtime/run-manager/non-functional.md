# run-manager 模块 non-functional.md

本文档定义 `runtime/run-manager` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，当约束冲突时以此为准：

1. **并发仲裁的正确性**（首要）：同一 session 不能同时存在两个 active Run（status='pending' 或 status='running'）。这是 run-manager 最核心的不变量，实现中不允许存在竞态条件（如 check-then-act 窗口）。

2. **崩溃恢复的完整性**：进程重启后，所有遗留的 pending/running Run 必须被标记为 interrupted，不允许任何 Run 永久停留在终态之外的状态。

3. **RunWorker 隔离性**：单个 RunWorker 的 panic 或未捕获异常不得影响 run-manager 本身的可用性，也不得影响其他 session 的 Run 创建。

---

## 二、Operational Constraints（运行约束）

### 并发仲裁

- 并发仲裁必须是原子的（check + create 不可拆分为两步，否则两个并发请求可能同时通过检查）
- 当前阶段：run-manager 是单进程单实例，通过内存锁或 async 串行化保证原子性，不依赖 DB 事务做仲裁
- 若未来需要多进程支持，仲裁逻辑需要迁移到 DB 层（悲观锁或 unique 约束），但这是暂缓项

### RunWorker 数量

- 同一时刻活跃的 RunWorker 数量 = 活跃 session 数量（每 session 最多一个）
- 当前阶段不对全局 RunWorker 数量设上限；session 数量的控制由 daemon/session 层负责
- 每个 RunWorker 持有的资源（stream scope、lifecycle 句柄）必须在 Run 终止后释放，不允许泄漏

### create() 响应时间

- create() 的主路径（并发仲裁 + RunContext 组装 + runLedger.createPending + RunWorker 启动）应为低延迟操作
- RunWorker.start() 是异步的，不等待 lifecycle.run() 完成；create() 在 RunWorker 启动后即返回
- runLedger.createPending() 的 DB 写入延迟是当前路径中唯一的 I/O 操作，应在正常范围内（不超过 SQLite 的典型写入延迟）

### 崩溃恢复

- markInterrupted({ statuses: ['pending', 'running'] }) 必须在 run-manager 开始接受新请求之前完成
- 崩溃恢复是一次性同步操作，不应因 DB 查询慢而使 daemon 启动显著延迟

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- 同 session 双 Run 并发存在：违反核心不变量，不可接受
- RunRecord 永久停留在 'pending' 或 'running' 状态：崩溃恢复未执行或执行失败，不可接受
- RunWorker 的 panic 传播到 run-manager 主循环：导致新 Run 无法创建，不可接受

### 可接受的失败

- 单次 pre-run hook 失败：非 critical hook 失败记录日志后继续，不中断 Run
- runLedger 的非关键写入失败（如 post-run hook 后的状态更新失败）：Run 功能完成，持久化状态略有延迟或异常，可降级处理

### 可观测性

- 每次 create() 调用应记录结构化日志（runId、sessionId、triggerSource、并发检查结果）
- RunWorker 生命周期事件（start、succeed、fail、cancel）应记录日志，包含耗时
- 并发冲突（ConcurrencyConflict）应记录日志，便于分析 heartbeat 是否存在信号过快问题
- markInterrupted 执行时应记录被标记的 Run 数量（若数量异常多，说明上次进程非正常退出）

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：Run 排队机制

当 session 已有 active Run 时，新请求直接拒绝（ConcurrencyConflict），不进入等待队列。排队逻辑由 heartbeat 的 DeferredQueue 处理，run-manager 不二次缓冲。这简化了 run-manager 的状态管理，代价是 heartbeat 侧需要承担信号缓冲责任。

### 当前不追求：跨 session 全局资源限制

run-manager 不对全局同时运行的 Run 总数设上限。全局资源控制（如 CPU、内存、token 预算）是更上层的关注点，当前阶段 session 数量可控，不需要额外限流。

### 当前不追求：Run 的暂停与恢复

cancel() 是不可逆的终止操作，没有暂停（pause）后恢复的能力。agent 的睡眠/唤醒语义由 heartbeat 的 sleeping 状态 + scheduler FollowUp 实现，而不是通过 Run 的暂停恢复。

### 当前不追求：RunWorker 超时兜底

lifecycle.run() 没有全局超时限制——agent 主循环可以无限运行，只能由 cancel() 中止。未来若需要防止 Run 无限运行，需要在 RunWorker 层引入超时 AbortController，当前阶段不实现。
