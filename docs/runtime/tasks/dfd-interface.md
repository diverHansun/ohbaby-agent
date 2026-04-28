# tasks 模块 dfd-interface.md

本文档描述 `runtime/tasks` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

tasks 模块提供 agent 在运行时启动和管理子任务的能力，与以下模块发生数据交换：

| 方向 | 外部模块 | 交互方式 |
|---|---|---|
| 被调用 | `core/lifecycle` / agent 工具 | 调用 TaskManager 接口创建和管理任务 |
| 调用 | `runtime/sandbox` | workspace-bound TaskRunner 获取/释放 SandboxLease |
| 调用 | `services/storage` | OutputStore 写入 task 输出文件 |
| 调用 | `services/database` | （可选）task 元数据持久化 |
| 被控制 | `runtime/daemon` | 调用 stopAll()（关闭时停止所有任务）|

**讨论范围**：本文档关注 TaskManager 的公共接口和主要数据流。不涉及 ShellTaskRunner 的进程管理实现细节。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：Shell 任务创建与执行

```
lifecycle / agent 工具
  → taskManager.create({
      type: 'shell',
      command, args?,
      sessionId,
      fileAccess: 'none' | 'workspace-ro' | 'workspace-rw'
    })
  ↓
TaskManager 分配 taskId，创建 TaskRecord（status: 'pending'）
  ↓
路由到 ShellTaskRunner.start(record)
  ↓
  [若 fileAccess = 'workspace-ro' 或 'workspace-rw']
    → sandboxManager.acquire(sessionId) → SandboxLease
  [若 fileAccess = 'none']
    → 跳过 sandbox 获取
  ↓
启动 subprocess（在 sandbox 限定的环境中执行）
  ↓
stdout/stderr 通过 OutputStore 写入 services/storage 文件
  （不通过 Bus 发布，不经过 StreamBridge）
  ↓
subprocess 结束（正常/失败/超时/signal）
  ↓
SandboxLease.release()（若已获取）
  ↓
TaskRecord.status 更新为 'succeeded' / 'failed' / 'cancelled' / 'timeout'
```

### 流程 2：Async 任务创建与执行

```
lifecycle / agent 工具
  → taskManager.create({
      type: 'async',
      fn: async (signal) => { ... },
      sessionId,
      fileAccess: 'none' | 'workspace-ro' | 'workspace-rw',
      // AsyncTask 默认值是 'none'；声明 workspace-ro/rw 时同样需要 SandboxLease
    })
  ↓
TaskManager 分配 taskId，创建 TaskRecord
  ↓
路由到 AsyncTaskRunner.start(record)
  ↓
  [若 fileAccess = 'workspace-ro' 或 'workspace-rw']
    → sandboxManager.acquire(sessionId) → SandboxLease
  [若 fileAccess = 'none']
    → 跳过 sandbox 获取
  ↓
AsyncTaskRunner 创建 AbortController，调用 fn(abortSignal)
  ↓
Promise 完成 / 被 abort
  ↓
TaskRecord.status 更新
  ↓
SandboxLease.release()（若已获取）
```

### 流程 3：任务输出读取

```
lifecycle / agent 工具
  → taskManager.readOutput(taskId, { fromLine?, maxLines? })
  ↓
OutputStore.readLines(taskId, fromLine, maxLines)
  ↓
从 services/storage 文件读取指定行范围
  ↓
返回 string[]（行列表）
```

agent 通过主动拉取获取输出，不推送。若需等待输出行，使用 `waitForLine(taskId, predicate)`。

### 流程 4：任务停止

```
lifecycle / agent 工具 或 daemon
  → taskManager.stop(taskId)
  ↓
路由到对应 Runner.stop(taskId)：
  ├── ShellTaskRunner → SIGTERM → 等待 → 超时则 SIGKILL
  └── AsyncTaskRunner → AbortController.abort()
  ↓
task 结束 → TaskRecord.status 更新为 'cancelled'
  ↓
SandboxLease.release()（若有）
```

---

## 三、Interface Definition（接口定义）

### 接口 1：create(options)

**语义**：创建并启动一个任务，立即返回 TaskRecord（任务在后台运行）。

- **输入**：`{ type: 'shell' | 'async', sessionId, fileAccess, command/args 或 fn }`
- **输出**：`TaskRecord`（含 taskId）
- **同步/异步**：异步（任务启动后立即返回，不等待完成）
- **关键约束**：`fileAccess: 'workspace-rw'` 必须显式声明；默认为 `'none'`

### 接口 2：stop(taskId)

**语义**：停止指定任务（优雅停止：SIGTERM → 超时 → SIGKILL）。

- **同步/异步**：异步（等待进程/Promise 完成）

### 接口 3：get(taskId)

**语义**：查询 TaskRecord，读取内存状态。

- **输出**：`TaskRecord | undefined`

### 接口 4：waitForCompletion(taskId)

**语义**：等待任务完成，返回最终状态。

- **输出**：`TaskStatus`（`'succeeded' | 'failed' | 'cancelled' | 'timeout'`）
- **同步/异步**：异步 Promise

### 接口 5：readOutput(taskId, options?)

**语义**：读取任务的 stdout/stderr 输出，按行返回。

- **输入**：`taskId`，可选 `{ fromLine?, maxLines? }`
- **输出**：`string[]`
- **说明**：`fromLine` 基于 0，支持增量读取

### 接口 6：waitForLine(taskId, predicate)

**语义**：阻塞等待直到某行输出满足条件（用于等待 subprocess 准备就绪）。

- **输入**：`taskId`，`predicate: (line: string) => boolean`
- **输出**：匹配的行内容
- **同步/异步**：异步

### 接口 7：stopAll()

**语义**：停止所有正在运行的任务（daemon 关闭时调用）。

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建 | 所有者 | 责任边界 |
|---|---|---|---|
| `TaskRecord`（内存）| TaskManager.create() | TaskManager | 内存索引，任务完成后保留一段时间供查询 |
| `SandboxLease` | sandboxManager.acquire() | 对应 TaskRunner（持有期间）| workspace-bound Runner 在任务生命周期内持有；结束时 release |
| task 输出文件 | OutputStore.write() | services/storage | 输出文件路径由 OutputStore 管理；TaskManager 不直接处理文件 |
| `fileAccess` 策略 | TaskRecord 创建时确定 | TaskRecord 字段 | 显式声明，不在运行时推断；ShellTaskRunner 按此决定是否获取 lease |
| `AbortController`（Async）| AsyncTaskRunner | AsyncTaskRunner | Runner 内部持有；stop(taskId) 触发 abort |
| subprocess 句柄 | ShellTaskRunner | ShellTaskRunner | 内部资源；TaskManager 不直接操作 subprocess |
