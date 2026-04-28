# run-ledger 模块 goals-duty.md

本文档定义 `runtime/run-ledger` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：run-ledger 是 Run 状态的最小持久化账本，记录每个 Run 的生命周期事件（创建、开始、完成、失败、取消、中断），为 run-manager 提供崩溃恢复所需的持久化支撑，而不试图完整持久化内存中的 RunRecord 状态。

**如果没有这个模块**：
- 进程崩溃后，run-manager 无法区分"正在运行"和"已完成"的 Run
- 崩溃恢复时只能依赖 message/part 数据做复杂推断（如查找有 StepStartPart 而无 StepFinishPart 的消息），效率低且易出错
- Run 的历史记录（触发源、持续时间、错误原因）无处查询
- 多 Run 并发场景下难以检测同一 session 下的活跃 Run 数量

**与 run-manager 的关系**：
- `runtime/run-manager` 负责 Run 的调度、内存状态、async worker、AbortController、多任务策略等复杂逻辑
- `runtime/run-ledger` 是 run-manager 的持久化子系统，只负责状态账本的读写
- RunRecord 主体（Worker 句柄、内存中间状态）仍由 run-manager 在内存中维护
- **两层权威来源明确区分**：
  - `run-manager 内存索引` = 当前进程的调度控制权威（热路径并发仲裁读此处）
  - `run-ledger DB` = 持久化审计与崩溃恢复权威（跨进程重启后读此处）
- **run-ledger 不参与热路径调度仲裁**：run-manager 在运行期的并发检测、策略决策、队列管理只读内存索引，不查询 DB。run-ledger 是写目标和恢复来源，不是运行期锁或调度队列。

---

## 二、Design Goals（设计目标）

### G1: 最小账本原则

只记录 Run 生命周期的关键事件，不试图完整序列化内存 RunRecord：
- 创建时记录 runId、sessionId、触发源、创建时间，并进入 `pending`
- worker 实际启动时标记为 `running` 并写入 startedAt
- 结束时记录 `succeeded` / `failed` / `cancelled` / `interrupted` 和 endedAt
- 崩溃场景下，`pending` / `running` 状态的 Run 被标记为 `interrupted`

### G2: 崩溃恢复友好

账本写入实时发生（Run 创建时即写入，不等到完成），确保进程意外退出后，重启时能识别未正常关闭的 Run，而不需要扫描 message/part 数据做推断。

### G3: 简单 SQL 查询

Run 状态、sessionId、触发源等字段作为关系型列，支持高效查询：
- 查找所有 `status IN ('pending', 'running')` 的 Run（崩溃恢复场景）
- 统计某个 session 下最近 N 条 Run 历史
- 按触发源过滤 Run 记录

### G4: 与 run-manager 解耦

run-ledger 不知道 async worker、MultitaskStrategy、PermissionProfile、AbortController 等 run-manager 内部概念。它只接收来自 run-manager 的账本写入调用，不反向影响调度逻辑。

---

## 三、Duties（职责）

### D1: Run 创建记录

当 run-manager 创建新 Run 时，立即写入账本：
- `runId`（主键）
- `sessionId`
- `triggerSource`（触发源：user / scheduler / heartbeat / channel / follow-up）
- `status = 'pending'`
- `createdAt`（时间戳）

### D2: Run 启动记录

当 pending Run 被 run-manager 调度并启动 worker 时，更新账本：
- `status = 'running'`
- `startedAt`（时间戳）

### D3: Run 结束记录

当 Run 正常完成或主动取消时，更新账本：
- `status`：`succeeded` / `failed` / `cancelled`
- `endedAt`：结束时间戳
- `error`：可选，错误信息（仅在 failed / cancelled 时）

### D4: 崩溃标记

进程重启时，run-manager 调用 run-ledger 将所有 `status IN ('pending', 'running')` 的记录批量更新为 `interrupted`：
- 这是唯一一种批量写入场景
- 不删除 `interrupted` 记录，保留审计历史

### D5: 账本查询接口

提供以下查询接口，**仅用于启动诊断、管理命令、debug UI、崩溃恢复前检查，不用于热路径调度仲裁**：
- `getActiveRuns(sessionId?)`: 查询所有 `status IN ('pending', 'running')` 的 Run——崩溃恢复前使用，运行期并发检测不调用此接口
- `getRunHistory(sessionId, limit)`: 查询某 session 最近 N 条 Run 历史（供 UI/debug 用）
- `getRun(runId)`: 获取单条 Run 账本记录

### D6: 账本清理

提供可选的清理接口，用于释放历史存储空间：
- 支持按时间窗口删除旧的 `succeeded` / `failed` / `cancelled` / `interrupted` 记录
- 不清理 `pending` / `running` 状态记录（这些是异常信号，应由 run-manager 先处理）
- 默认保留策略：保留最近 30 天或最近 1000 条（可配置）

---

## 四、Non-Duties（非职责）

### N1: 不负责 Run 的调度决策，不参与热路径并发仲裁

是否允许新 Run、多 Run 策略（queue/reject/interrupt）、权限画像应用，这些由 run-manager 决定。run-ledger 只被动记录 run-manager 的决策结果。run-manager 在运行期的并发检测读取内存索引，不查询 run-ledger；run-ledger 不是运行期锁、不是调度队列、不是并发仲裁器。

### N2: 不持有 Worker 句柄或内存状态

Worker 的 AbortController、进度状态、流式输出等运行时状态留在 run-manager 内存中。run-ledger 不尝试序列化这些对象。

### N3: 不负责崩溃检测

判断进程是否异常退出，由 run-manager 在初始化时主动调用 run-ledger 的崩溃标记接口完成。run-ledger 不自行检测或触发这个流程。

### N4: 不关联消息内容

Run 账本不引用 message/part 数据，也不依赖 message 表做状态推断。两者通过 sessionId 在业务层松散关联，而非外键强约束。

### N5: 不管理 Turn 级粒度

Turn 是 lifecycle/run-worker 内部概念。run-ledger 的粒度是 Run（一次完整的 trigger→response 序列），不细分到单个 Turn。

---

## 五、设计约束与假设

### 约束

1. **依赖 Database 模块**：通过 `services/database`（SQLite/Drizzle）读写 `run_ledger` 表
2. **账本写入同步**：Run 创建时 pending 记录必须在 worker 启动前完成，确保崩溃时账本状态先行
3. **run_ledger 表 Schema**：由 `services/database` 统一定义和迁移管理

### 假设

1. `runId` 全局唯一，由 run-manager 生成并传入
2. 进程崩溃后重启时，run-manager 保证在启动任何新 Run 之前先调用崩溃标记
3. `sessionId` 不用外键约束关联 session 表（避免 session 删除时级联复杂性）

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/run-manager` | 被依赖 | run-manager 调用 run-ledger 的写入接口记录 Run 状态变化 |
| `services/database` | 依赖 | 通过 database 模块读写 run_ledger 表 |
| `services/session` | 松散关联 | 通过 sessionId 在业务层关联，无直接依赖 |
| `core/message` | 无直接依赖 | 崩溃恢复不依赖 message/part 数据 |
| `runtime/daemon` | 间接依赖 | daemon 触发 run-manager 初始化，run-manager 调用 run-ledger 的崩溃标记接口 |

---

## 七、数据结构

```typescript
type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

type TriggerSource = 'user' | 'scheduler' | 'heartbeat' | 'channel' | 'follow-up'

interface RunLedgerRecord {
  runId: string
  sessionId: string
  triggerSource: TriggerSource
  status: RunStatus
  createdAt: number       // Unix timestamp ms
  startedAt?: number      // Unix timestamp ms
  endedAt?: number        // Unix timestamp ms
  error?: string          // 仅在 failed/cancelled/interrupted 时可能存在
}
```

---

## 八、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 与 run-manager 的职责边界清晰（调度 vs 账本）
- [x] 崩溃恢复流程明确（写入时机 + 标记接口）
- [x] 最小账本原则：不序列化内存状态
- [x] 所有职责可被测试或验证
