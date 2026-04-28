# tasks 模块 data-model.md

本文档定义 `runtime/tasks` 模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

### 概念 1：Task（子任务）

agent 在运行时启动的一个独立执行单元，与主 Run 并发执行。Task 有唯一 taskId、明确的文件访问策略（`fileAccess`）、输出存储和生命周期状态。Task 不是 Run 的子集，而是 Run 运行期间产生的副作用执行单元。

### 概念 2：TaskFileAccess（文件访问策略）

Task 对工作区文件的访问级别，在创建时显式声明，不在运行时推断：

| 值 | 含义 |
|---|---|
| `'none'` | 不访问工作区（默认值，系统工具、网络请求等）|
| `'workspace-ro'` | 只读访问工作区（需要 SandboxLease，检查但不修改文件）|
| `'workspace-rw'` | 读写工作区（需要 SandboxLease，可以创建/修改/删除文件）|

设计意图：`workspace-rw` 必须显式声明，不允许隐式获得写权限。

### 概念 3：SandboxLease（沙箱租约）

workspace-ro 和 workspace-rw 任务在执行期间持有的沙箱访问凭证。SandboxLease 的存在防止 sandbox 清理（如工作区删除）在任务运行期间触发。Task 结束时必须释放。

### 概念 4：TaskRecord（任务记录）

Task 在内存中的状态表示，由 TaskManager 持有。包含任务的配置、状态、关联的 Runner 引用。

### 概念 5：OutputStore（输出存储）

管理 task 的 stdout/stderr 输出文件，通过 services/storage 写入，提供行级读取接口。task 输出不走 Bus 事件推送，而是写文件 + 拉取。

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|---|---|---|
| TaskRecord | Entity | 有唯一 taskId，有生命周期（pending → running → terminated）|
| TaskFileAccess | Value Object（枚举）| 三个固定值，无行为，创建时确定后不变 |
| SandboxLease | Entity（外部）| 由 sandbox 模块管理身份，TaskRunner 只持有引用 |
| 输出文件路径 | Value Object | OutputStore 确定的文件路径，随 taskId 绑定 |

---

## 三、Key Data Fields（关键数据字段）

### TaskRecord 字段说明

| 字段 | 含义 |
|---|---|
| `taskId` | 任务唯一标识，格式 `task_<timestamp>_<random>` |
| `type` | 任务类型：`'shell'`（subprocess）或 `'async'`（同进程 Promise）|
| `sessionId` | 所属 session，用于 SandboxLease 获取时的工作区归属 |
| `fileAccess` | 文件访问策略，创建时确定，不可变 |
| `status` | 当前状态：`'pending' \| 'running' \| 'succeeded' \| 'failed' \| 'cancelled' \| 'timeout'` |
| `createdAt` | 创建时间戳 |
| `startedAt` | 实际开始执行时间 |
| `endedAt` | 任务结束时间 |
| `exitCode` | subprocess 的退出码（仅 shell 任务有效）|
| `error` | 失败原因（若 status = failed）|

### TaskStatus 状态说明

| 状态 | 含义 |
|---|---|
| `pending` | 已创建，等待 Runner 分配资源 |
| `running` | subprocess 运行中 或 async fn 执行中 |
| `succeeded` | 正常结束（exitCode = 0 或 Promise resolved）|
| `failed` | 异常结束（exitCode != 0 或 Promise rejected）|
| `cancelled` | 被 stop() 主动停止 |
| `timeout` | 超时后被 TaskManager 终止 |

### TaskFileAccess 策略对应的 SandboxLease 行为

| fileAccess | SandboxLease | 说明 |
|---|---|---|
| `'none'` | 不获取 | 命令在默认环境中执行，无沙箱约束 |
| `'workspace-ro'` | 获取，读取模式 | 防止 sandbox 在任务执行期间被清理 |
| `'workspace-rw'` | 获取，写入模式 | 同上，且允许修改工作区文件 |

---

## 四、Lifecycle & Ownership（生命周期与归属）

### TaskRecord 生命周期

```
taskManager.create(options)
  → 分配 taskId，TaskRecord.status = 'pending'
  → 路由到 Runner
  ↓
Runner.start(record)
  → [若 workspace-ro/rw] sandboxManager.acquire()
  → 启动 subprocess / async fn
  → TaskRecord.status = 'running'
  ↓
[执行期间]
  → stdout/stderr → OutputStore → services/storage 文件
  ↓
任务结束（正常/失败/被停止/超时）
  → [若有] sandboxLease.release()
  → TaskRecord.status = 'succeeded' / 'failed' / 'cancelled' / 'timeout'
  → endedAt 记录
```

### SandboxLease 的持有归属

- **持有方**：对应 TaskRunner（ShellTaskRunner 或 workspace-bound AsyncTaskRunner，在 start 到结束的整个执行期间）
- **不在 TaskRecord 中**：SandboxLease 是执行面资源，不序列化到 TaskRecord
- **release 时机**：task 结束时（正常、失败、超时、被停止），无论哪种结束原因，lease 必须 release

### 输出文件归属

- **路径规则**：`{storageBase}/tasks/{taskId}/stdout` 和 `.../stderr`（由 OutputStore 确定）
- **写入方**：ShellTaskRunner 通过 OutputStore 写入
- **读取方**：TaskManager 的 `readOutput()` 接口封装 OutputStore
- **清理策略**：输出文件的保留/清理由 services/storage 的清理策略决定，不在 tasks 模块内

---

## 五、文档自检

- [x] TaskFileAccess 三个级别的含义和 SandboxLease 关系清晰
- [x] 输出走文件而非 Bus 的设计意图有说明（输出量不可控，不适合 ring buffer）
- [x] SandboxLease 由 Runner 持有（不在 TaskRecord）的理由说明
- [x] `workspace-rw` 必须显式声明的约束明确
