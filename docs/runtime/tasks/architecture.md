# tasks 模块 architecture.md

本文档描述 `runtime/tasks` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

tasks 模块采用 **Manager + Runner 两层结构**：TaskManager 是控制面（台账、生命周期、接口），TaskRunner 是执行面（subprocess / async 执行、workspace-bound task 的 SandboxLease 管理、输出写入）。

```
┌──────────────────────────────────────────────────────────────────┐
│ TaskManager（控制面，公共接口）                                    │
│                                                                  │
│ 职责：                                                           │
│ - 创建 TaskRecord（分配 taskId，记录 fileAccess 策略）            │
│ - 维护 taskId → TaskRecord 内存索引                              │
│ - 提供 get / list / waitForCompletion / stop 接口                │
│ - 路由到对应 Runner（ShellTaskRunner / AsyncTaskRunner）          │
└──────────────────────────────────────────────────────────────────┘
          │                               │
          ▼                               ▼
┌──────────────────────┐     ┌────────────────────────────┐
│ ShellTaskRunner      │     │ AsyncTaskRunner             │
│                      │     │                            │
│ 职责：               │     │ 职责：                     │
│ - workspace 时获取   │     │ - workspace 时获取          │
│   SandboxLease       │     │   SandboxLease              │
│ - 启动 subprocess    │     │ - 通过 AbortSignal 取消     │
│ - 写 stdout/stderr   │     │ - 捕获 Promise rejection   │
│   到 storage         │     │                            │
│ - 超时 SIGTERM/KILL  │     │                            │
│ - release lease      │     │                            │
└──────────────────────┘     └────────────────────────────┘
          │
          ▼
┌──────────────────────┐
│ OutputStore          │
│                      │
│ 职责：               │
│ - 管理 task 输出文件  │
│ - 提供行级读取接口    │
│ - 通过 services/     │
│   storage 写入       │
└──────────────────────┘
```

### 主要组件

| 组件 | 职责 |
|---|---|
| **TaskManager** | 控制面：台账、路由、对外接口 |
| **ShellTaskRunner** | subprocess 执行、按 fileAccess 获取/释放 SandboxLease、输出写入 |
| **AsyncTaskRunner** | 同进程 async 任务执行、AbortSignal 取消；workspace-bound async task 同样按 fileAccess 获取/释放 SandboxLease |
| **OutputStore** | task 输出文件的写入和行级读取，依赖 services/storage |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Manager + Runner 分层（类似 run-manager 的 Manager + Worker）

TaskManager 是控制面，Runner 是执行面。两者职责不同：Manager 管台账和接口，Runner 管执行细节。

**使用理由**：
- ShellTaskRunner 需要持有 subprocess 句柄、输出文件句柄，以及 workspace-bound task 的 SandboxLease，这些资源的生命周期与 task 绑定，不应混入 TaskManager
- AsyncTaskRunner 需要持有 AbortController；当执行 embedding indexing 等 workspace-ro async task 时，也需要通过同一套 execution context 规则获取 SandboxLease
- 分层后 TaskManager 可以独立测试（mock Runner），Runner 可以独立测试（mock SandboxManager 和 storage）

### 2. Strategy 模式（Runner 选择）

TaskManager 根据 task 类型（shell / async）路由到对应 Runner，Runner 实现相同的 `TaskRunner` 接口。

**使用理由**：
- shell task 和 async task 的执行机制完全不同，但对 TaskManager 的接口是一致的（`start(record)` / `stop(taskId)`）
- 未来新增 task 类型（如 remote task）只需新增 Runner 实现，不修改 TaskManager

### 3. fileAccess 策略作为 TaskRecord 的显式字段

`fileAccess: 'none' | 'workspace-ro' | 'workspace-rw'` 在 TaskRecord 创建时确定，不在运行时推断。

**使用理由**：
- 显式声明使权限意图可审计（TaskRecord 中可查）
- Runner 通过共享的 execution-context helper 根据 fileAccess 决定是否获取 SandboxLease，不需要猜测；规则对 shell task 和 async task 一致

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/tasks/
├── index.ts                  # 公共接口：导出 TaskManager 和类型
├── manager.ts                # TaskManager 类：台账、路由、对外接口
├── runners/
│   ├── shell-runner.ts       # ShellTaskRunner：subprocess + SandboxLease + 输出写入
│   └── async-runner.ts       # AsyncTaskRunner：同进程 async + AbortSignal
├── execution-context.ts      # 根据 fileAccess 获取/释放 SandboxLease，生成 TaskExecutionContext
├── output-store.ts           # OutputStore：task 输出文件的写入和行级读取
├── types.ts                  # TaskRecord、TaskStatus、TaskFileAccess、TaskRunner 接口
└── __tests__/
    ├── manager.test.ts
    ├── runners/
    │   ├── shell-runner.test.ts
    │   └── async-runner.test.ts
    └── output-store.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 仅导出 TaskManager 和类型 |
| `manager.ts` | 控制面 | 台账管理、Runner 路由、对外 API |
| `runners/shell-runner.ts` | 执行面 | subprocess 生命周期、SandboxLease 获取/释放、超时处理 |
| `runners/async-runner.ts` | 执行面 | 同进程 async 任务、AbortController；通过 execution-context 支持 workspace-bound async task |
| `execution-context.ts` | 私有执行上下文 helper | 根据 `fileAccess` 获取 SandboxLease，提供 `TaskExecutionContext`，确保 release 在 finally 中发生 |
| `output-store.ts` | 输出管理 | 写入 services/storage；提供 `readLines(taskId, fromLine, maxLines)` |
| `types.ts` | 类型定义 | TaskRecord、TaskFileAccess、TaskRunner 接口 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`TaskManager` 的公共方法；`TaskRecord` 类型；`TaskFileAccess` 枚举
- **内部实现**：Runner 实现细节；OutputStore 的文件路径策略；SandboxLease 获取时机

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. SandboxLease 在 Runner 层持有，不在 TaskRecord 中

SandboxLease 是运行时资源，不序列化到 TaskRecord。TaskRecord 只记录 `fileAccess` 策略和 `sessionId`，Runner 通过 `execution-context.ts` 在启动时按需获取 lease，并在 task 结束、取消、失败或超时时释放。

**代价**：TaskManager 无法从 TaskRecord 直接知道 lease 是否已获取，需要通过 Runner 状态查询。这是可接受的：lease 是执行面资源，控制面不直接持有；统一 helper 可以避免 ShellTaskRunner 与 AsyncTaskRunner 各自实现一套获取/释放逻辑。

### 2. task 输出不走 Bus 事件

task 的 stdout/stderr 直接写入 services/storage 文件，不通过 Bus 发布每一行。agent 通过 `readOutput()` 分页拉取；如果需要等待新增输出，由 OutputStore 提供 `waitForLine()` 或 AsyncIterable 这类模块内输出通道，而不是把高频日志行推入 Bus。

**代价**：TUI/SDK 不能直接从 StreamBridge 收到 `task.output` 事件，需要调用 task output API 或使用 OutputStore 暴露的等待接口。这是有意的简化：task 输出量可能很大（build log），通过 Bus/StreamBridge 推送会给事件系统和 ring buffer 带来压力。

### 3. 放弃的方案：task 输出通过 StreamBridge 对外发布

可以让 ShellTaskRunner 将 stdout/stderr 实时发布到 StreamBridge（`task.output` 事件），使 TUI/SDK 可以实时订阅 task 输出。

**放弃理由**：task 输出量不可控（build log 可能几 MB），StreamBridge 的 ring buffer 不适合高频小事件流。当前阶段 agent 通过 `readOutput()` 拉取已足够，实时推送是未来需求，YAGNI。
