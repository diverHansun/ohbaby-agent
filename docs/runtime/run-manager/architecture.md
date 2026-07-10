# run-manager 模块 architecture.md

本文档描述 `runtime/run-manager` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

run-manager 采用 **Manager（控制面）+ Worker（执行面）** 两层结构，两者同属一个模块目录，Worker 是 Manager 的私有执行单元。

```
┌──────────────────────────────────────────────────────────────────┐
│ RunManager（控制面，公共接口）                                     │
│                                                                  │
│ 职责：                                                           │
│ - 维护 sessionId → active RunRecord[] 内存索引                   │
│ - create()：并发仲裁 → ledger pending → 内存索引 → startRun()    │
│ - startRun()：组装 RunContext → 创建并启动 RunWorker             │
│ - cancel(runId)：通过 AbortController 取消 worker               │
│ - init()：调用 runLedger.markInterrupted() 完成崩溃恢复          │
│ - 持有所有 RunRecord 和 AbortController                          │
└──────────────────────────────────────────────────────────────────┘
                          │ 创建并启动
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ RunWorker（执行面，私有）                                          │
│                                                                  │
│ 职责：                                                           │
│ - 接收已解析的 RunContext，不做依赖解析                            │
│ - 调用 hookExecutor.execute('pre-run', ctx)                      │
│ - 调用 lifecycle.run(session, abortSignal)                       │
│ - 调用 hookExecutor.execute('post-run', ctx)                     │
│ - 订阅 Bus 事件，翻译为 run.* 并发布到 StreamBridge              │
│ - 结束时释放 Bus 订阅，回写 RunRecord 状态                        │
└──────────────────────────────────────────────────────────────────┘
```

### RunContext 的组装时机

RunContext 由 RunManager 在 `startRun()` 阶段组装，不在 `create()` 时组装：

```
create()
  ├─ merge RunDefaultsPolicy（policy.ts）
  ├─ 内存索引并发仲裁（读内存，不查 DB）
  ├─ runLedger.createPending()（账本先行）
  ├─ 写入内存索引
  └─ 如可立即运行 → startRun(record)

startRun(record)
  ├─ sandboxManager.acquire({ sessionId, contextScopeId?, workdir }) → scoped SandboxLease
  ├─ profileRegistry.getProfile(record.permissionProfileId) → PermissionProfile
  ├─ new AbortController()（保存在 RunRecord 中）
  ├─ 构造 RunContext { runId, sessionId, sandboxLease, permissionProfile, abortSignal, ... }
  └─ new RunWorker(context, { bus, bridge, hookExecutor, lifecycle }) → worker.start()
```

RunWorker 不知道 policy、sandbox、profile registry、run-ledger。它只接收已解析的 RunContext 并执行。

### 主要组件

| 组件 | 职责 |
|---|---|
| **RunManager** | 控制面：内存索引、并发仲裁、RunContext 组装、AbortController 持有 |
| **RunWorker** | 执行面：lifecycle 调用、hook 执行、run.* 事件翻译（私有） |
| **policy.ts** | RunDefaultsPolicy 的 merge 逻辑（纯函数） |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Command 模式（RunWorker）

RunWorker 是一个执行命令对象：它封装了"执行一次 Run"所需的全部上下文（RunContext），并提供 `start()` 方法。RunManager 创建 RunWorker 并调用 `start()`，不关心执行细节。

**使用理由**：
- RunWorker 持有 lifecycle 调用、hook 执行、事件翻译等执行细节，与 RunManager 的调度逻辑解耦
- RunWorker 可以独立测试（mock lifecycle、bus、bridge）

### 2. Strategy 模式（RunDefaultsPolicy）

RunDefaultsPolicy 是可注入的策略对象，由装配层（daemon/bootstrap）构建并注入 RunManager。`policy.ts` 提供 merge 逻辑（defaults + explicit overrides）。

**使用理由**：
- 策略与机制分离：RunManager 负责执行 merge，不拥有默认值
- 不同部署模式（daemon / CLI in-process / test）可以注入不同的 policy，不修改 RunManager

### 3. 内存索引作为热路径仲裁器

运行期并发检测读取内存索引（`sessionId → active RunRecord[]`），不查询 run-ledger DB。

**使用理由**：
- 并发仲裁需要的不只是"有没有 active run"，还需要 AbortController、等待队列等内存对象，这些 run-ledger 永远不应该知道
- 内存查询比 DB 查询快，且避免 run-ledger 成为调度瓶颈

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/run-manager/
├── index.ts          # 公共接口：导出 RunManager 类和 RunRecord 类型
├── manager.ts        # RunManager 类：控制面实现
├── worker.ts         # RunWorker 类：执行面实现（私有，不从 index.ts 导出）
├── policy.ts         # mergeRunDefaults() 纯函数：RunDefaultsPolicy merge 逻辑
├── types.ts          # RunRecord、RunStatus、RunContext、RunDefaultsPolicy 类型
└── __tests__/
    ├── manager.test.ts
    ├── worker.test.ts
    └── policy.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 仅导出 RunManager 和类型；RunWorker 不对外暴露 |
| `manager.ts` | 控制面 | 内存索引、并发仲裁、RunContext 组装、AbortController 持有、ledger 写入 |
| `worker.ts` | 执行面（私有） | lifecycle 调用、hook 执行、Bus 订阅与 run.* 事件翻译 |
| `policy.ts` | 策略工具 | `mergeRunDefaults(policy, explicit)` 纯函数，无副作用 |
| `types.ts` | 类型定义 | RunRecord、RunContext、RunDefaultsPolicy；TriggerSource 等窄类型从 ohbaby-sdk 导入 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`RunManager` 的 `create` / `cancel` / `get` / `list` / `waitForCompletion` / `init` / `cancelAll` 方法；`RunRecord` 类型
- **内部实现**：RunWorker 的执行细节；内存索引数据结构；RunContext 的组装逻辑

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. RunWorker 不写 run-ledger pending

`runLedger.createPending()` 在 `create()` 阶段由 RunManager 调用，不在 RunWorker 内部。RunWorker 只在 start / end 时通过回调通知 RunManager 更新 ledger。

**代价**：RunManager 需要在 `startRun()` 和 worker 结束回调中分别调用 ledger 更新，逻辑分散在两处。但这是正确的职责划分：ledger 写入是控制面关切，不是执行面关切。

### 2. AbortController 由 RunManager 持有

`cancel(runId)` 是 RunManager 的控制面职责，因此 AbortController 保存在 RunRecord 中，由 RunManager 持有。RunWorker 只消费 `abortSignal`，不持有 controller。

**代价**：RunWorker 无法自行取消，必须通过 RunManager。这是有意的约束：取消是外部控制行为，不应由执行单元自行决定。

### 3. 放弃的方案：RunWorker 作为独立 runtime 子模块

可以将 RunWorker 提升为 `runtime/run-worker` 独立模块，与 RunManager 平级。

**放弃理由**：RunWorker 是 RunManager 的私有执行单元，不对外暴露接口，不被其他模块直接依赖。独立模块会引入不必要的模块边界，且 RunWorker 的接口设计与 RunManager 的内部状态强耦合（RunContext 的组装、AbortController 的传递）。同目录私有文件是更合适的组织方式。
