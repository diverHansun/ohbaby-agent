# run-manager 模块 data-model.md

本文档定义 `runtime/run-manager` 模块的核心概念与数据模型，统一认知语言，不冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1：Run（运行实例）

一次由触发源（用户、scheduler、channel、heartbeat、follow-up）激活的 agent 执行过程。Run 是 runtime 的最小可观测执行单元：有唯一标识（runId）、所属会话（sessionId）、生命周期状态（pending → running → succeeded/failed/cancelled/interrupted）。

### 概念 2：RunRecord（运行记录）

Run 在控制面的内存表示，由 RunManager 持有。RunRecord 比 run-ledger 中的账本记录多出进程内资源引用：AbortController、SandboxLease。账本记录是 RunRecord 的持久化投影，不包含内存对象。

### 概念 3：RunContext（运行上下文）

RunManager 在 `startRun()` 阶段组装的已解析上下文，传递给 RunWorker。RunContext 是 RunRecord + 已获取资源（SandboxLease、PermissionProfile、abortSignal）的合并结果。RunWorker 接收 RunContext 后不再做任何依赖解析。

### 概念 4：RunDefaultsPolicy（运行默认策略）

`TriggerSource → { permissionProfileId, multitaskStrategy, disconnectMode }` 的映射表，由 daemon/bootstrap 装配层构建并注入 RunManager。RunManager 消费策略，不拥有触发源映射。这是 run-manager 与 permission-profiles 职责解耦的关键。

### 概念 5：TriggerSource（触发来源）

标识 Run 的触发渠道：`'user' | 'scheduler' | 'heartbeat' | 'channel' | 'follow-up'`。触发来源决定 RunDefaultsPolicy 选取哪套默认值，并写入账本供审计使用。注意：scheduler 内部的 `scheduled/reminder` 是 Job kind，不直接作为 Run 的 triggerSource。

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|---|---|---|
| RunRecord | Entity | 有唯一 runId，有完整生命周期（pending→running→terminated） |
| RunContext | Value Object | 组装后不可变，随 Run 结束销毁，无独立身份 |
| RunDefaultsPolicy | Value Object | 纯数据映射，由装配层注入，RunManager 只读取 |
| TriggerSource | Value Object | 仅作为枚举标识符，无行为 |

---

## 三、Key Data Fields（关键数据字段）

### RunRecord 字段说明

| 字段 | 含义 |
|---|---|
| `runId` | Run 的全局唯一标识，格式 `run_<timestamp>_<random>` |
| `sessionId` | 所属会话，决定并发仲裁的范围 |
| `status` | 当前生命周期状态（见下方状态说明） |
| `triggerSource` | 触发来源，决定默认策略查找 key |
| `permissionProfileId` | 已解析的权限画像 ID |
| `multitaskStrategy` | 并发策略：`queue`（排队）/ `reject`（拒绝）/ `interrupt`（中断现有） |
| `disconnectMode` | 用户断开连接时的行为：`continue`（继续）/ `pause`（暂停） |
| `abortController` | 内存对象，用于取消 Run；不序列化到账本 |
| `sandboxLease` | 内存对象，startRun 时获取的沙箱租约；不序列化到账本 |
| `createdAt` | Run 创建时间戳（毫秒） |
| `startedAt` | Run 实际开始执行时间戳 |
| `endedAt` | Run 结束时间戳 |

### RunStatus 状态说明

| 状态 | 含义 |
|---|---|
| `pending` | 已创建账本记录，等待启动（排队或等资源）|
| `running` | 正在执行，lifecycle.run() 进行中 |
| `succeeded` | 正常结束 |
| `failed` | 异常退出（未被 abort） |
| `cancelled` | 被用户或系统主动取消 |
| `interrupted` | 进程崩溃导致未正常关闭 |

### RunContext 字段说明

| 字段 | 含义 |
|---|---|
| `runId` | 与 RunRecord.runId 相同 |
| `sessionId` | 所属会话 |
| `sandboxLease` | 已获取的沙箱租约，RunWorker 用于限制文件访问范围 |
| `permissionProfile` | 已解析的完整权限画像对象 |
| `abortSignal` | 来自 AbortController.signal，RunWorker 监听取消信号 |
| `triggerSource` | 传递给 lifecycle，供工具/hook 判断触发场景 |

### RunDefaultsPolicy 结构说明

```
{
  defaults: {
    [triggerSource]: {
      permissionProfileId: string    // 该触发源的默认权限画像
      multitaskStrategy: string      // 该触发源的默认并发策略
      disconnectMode: string         // 该触发源的默认断开模式
    }
  }
}
```

---

## 四、Lifecycle & Ownership（生命周期与归属）

### RunRecord 生命周期

```
create() 调用
  ├── 内存索引并发仲裁
  ├── runLedger.createPending()  ← DB 账本先行
  └── 写内存索引（status: 'pending'）
       ↓
  startRun()
  ├── 获取 SandboxLease
  ├── 解析 PermissionProfile
  ├── 创建 AbortController
  └── RunWorker.start()
       ↓
  [执行期间]  status: 'running'（由 ledger.markRunning 写 DB）
       ↓
  worker 结束（正常/异常/abort）
  ├── 从内存索引移除
  ├── release SandboxLease
  ├── streamBridge.end(scope)
  └── runLedger.markSucceeded / markFailed / markCancelled / markInterrupted
```

### 数据归属

| 数据 | 创建 | 管理 | 销毁 |
|---|---|---|---|
| RunRecord（内存） | RunManager.create() | RunManager（内存索引） | run 结束时从索引移除 |
| RunRecord（DB） | run-ledger.createPending() | run-ledger | 账本记录永久保留（审计用途） |
| AbortController | RunManager.startRun() | RunManager（存于 RunRecord） | run 结束后随 RunRecord 销毁 |
| SandboxLease | sandboxManager.acquire() | RunManager（存于 RunRecord） | run 结束时显式 release |
| RunContext | RunManager.startRun() 组装 | RunWorker 持有 | RunWorker.start() 完成后销毁 |

### 两层权威说明

- **内存索引**：当前进程的控制权威，用于热路径并发仲裁、AbortController 查找
- **run-ledger DB**：跨进程的持久化权威，用于崩溃恢复和历史审计
- 两层在正常运行时保持一致；进程重启后由 `init()` 通过 DB 修正遗留 interrupted runs

---

## 五、文档自检

- [x] 每个概念都能用自然语言解释
- [x] RunRecord / RunContext / RunDefaultsPolicy 三个核心概念的职责边界清晰
- [x] 内存对象（AbortController、SandboxLease）与可序列化字段明确区分
- [x] 两层权威（内存索引 vs run-ledger）的定位明确
