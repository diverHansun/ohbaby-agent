# run-manager 模块 goals-duty.md

本文档定义 `runtime/run-manager` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 将"一次运行"提升为系统的一等概念

`core/lifecycle` 负责 agent loop 的执行逻辑，但它只是一个可被调用的函数，不知道"这次调用是谁发起的、有没有在跑、能不能取消"。run-manager 的存在是为了给每一次 lifecycle.run 赋予身份（runId）、归属（sessionId）、来源（trigger）和状态（status），使其成为可查询、可取消、可追溯的运行单元。

### 2. 统一所有触发来源的调度入口

无论是用户在 CLI 键入请求、scheduler 定时触发、channel 入站消息、还是 heartbeat 唤醒，所有"启动 agent loop"的动作都必须经由 run-manager。这使得权限画像绑定、并发冲突检测、断连行为决策等横切关注点有一个统一的执行位置。

### 3. 在不引入持久化负担的前提下支持崩溃可见性

RunRecord 存储在进程内存中，崩溃后不自动恢复。但系统重启后，run-manager 可从 session storage 重建"上次有哪些 in-flight run"的信息，将其标记为 `interrupted` 状态，供用户或 scheduler 决定下一步。

### 4. 通过触发源联动表实现后台运行的安全默认值

后台触发的 run（scheduler / channel / heartbeat）没有 UI 可弹窗，必须在创建时就绑定权限画像和多任务策略。run-manager 维护触发源联动表，为每种触发源提供安全默认值，防止未授权写操作静默执行。

### 5. 在 Run 启动前绑定正确的执行上下文

一次 Run 不仅需要 `permissionProfile` 和并发策略，还需要明确它在哪个工作目录里执行。run-manager 负责在 worker 启动前拿到 session 对应的 sandbox context，让 lifecycle、tool-scheduler、tasks 看到一致的执行环境；但 sandbox 的具体实现和清理由 sandbox 模块负责。

---

## 二、Duties（职责）

### 1. 管理 RunRecord 的生命周期

负责：
- 创建 RunRecord（分配 runId，记录 trigger / sessionId / permissionProfile / multitaskStrategy / disconnectMode）
- 维护 RunRecord 的状态转换（pending → running → succeeded / failed / cancelled / interrupted）
- 提供 `get(runId)` / `list(sessionId)` / `waitForCompletion(runId)` 接口
- 进程退出时清理所有 running 状态的 RunRecord

### 2. 并发冲突检测与处理

负责：
- 在 `create()` 时检查同一 session 上是否已有 running run
- 根据 `multitaskStrategy` 执行对应策略：
  - `reject`：直接返回错误，不创建新 run
  - `queue`：创建 run 但进入 pending 状态，等待前一个完成
  - `interrupt-current`：取消正在运行的 run，再启动新的

### 3. 维护触发源的运行默认值

负责：
- 维护 `TriggerSource -> { permissionProfile, multitaskStrategy, disconnectMode }` 的默认联动表
- 在 `create()` 时根据 trigger 补齐未显式声明的运行参数
- 允许调用方显式覆盖默认值，但覆盖必须体现在 RunRecord 中，便于审计
- 只保存 permissionProfile 的标识，不实现具体权限画像逻辑

### 4. 绑定 Sandbox 执行上下文

负责：
- 在 Run 进入 `running` 前，调用 sandbox 模块为该 session 解析或获取 `SandboxContext`
- 将 `adapterId`、`workdir` 或等价的上下文引用附加到 Run 的执行上下文中，供 lifecycle / tools / tasks 使用
- 当 sandbox context 准备失败时，阻止 Run 进入 `running` 状态，并以启动失败的方式记录原因

### 5. 启动与管理 Run Worker

负责：
- 为每个 run 启动独立的 async worker（Node.js 异步任务，非 worker thread）
- worker 内部调用 `core/lifecycle.run()`，将 lifecycle 执行结果回写 RunRecord 状态
- 将 sandbox context 一并传给 lifecycle，使整个 Run 在统一的执行目录中工作
- worker 持有 AbortController，供 cancel() 调用

### 6. Run 的取消

负责：
- 提供 `cancel(runId)` 接口，取消整个 Run worker
- 通过 AbortSignal 将取消请求传递给 `core/lifecycle`
- 当前 LLM 调用如何中止由 lifecycle / llm-client 处理
- 取消单个 Run 不影响同一 session 的其他 run，也不影响后台 Task

### 7. 崩溃恢复标记

负责：
- 进程启动时，扫描 session storage 判断上次是否有 in-flight run
- 将这些 run 以 `interrupted` 状态写入 RunRecord（只读记录，不重新执行）

### 8. 事件翻译（Bus → StreamBridge）

负责：
- Run Worker 订阅 `core/lifecycle` 发出的 Bus 事件
- 将 Bus 事件附上 `runId` 后通过 `runtime/stream-bridge` 对外发布
- 作为 Bus 与 StreamBridge 之间唯一的翻译层

---

## 三、Non-Duties（非职责）

### 1. 不负责 agent loop 的执行逻辑

agent loop（turn 处理、工具调用、LLM 调用）由 `core/lifecycle` 负责，run-manager 只负责调用它并管理其运行台账。

### 2. 不负责 Session 的创建和管理

session 的创建、查询、历史消息存储由 `services/session` 负责。run-manager 使用 sessionId 作为引用，不持有 session 对象。

### 3. 不负责权限画像的具体实现

具体的权限画像（如 `notify-only` 如何将写操作转为通知）由 `runtime/permission-profiles` 模块实现。run-manager 只负责在创建 run 时将 permissionProfile 字段绑定到 RunRecord。

### 4. 不负责 Task 的管理

`runtime/tasks` 管理后台长期任务（非 agent loop）。Task 和 Run 是不同概念，run-manager 不感知 Task 的存在。

### 5. 不负责 Sandbox 的具体实现

sandbox 是否使用原始目录、git worktree 还是容器，由 `sandbox` 模块和对应 adapter 决定。run-manager 只在 Run 启动前获取上下文引用，不创建也不销毁隔离环境。

### 6. 不负责 Scheduler 触发逻辑

run-manager 只提供 `create()` 接口，不主动发起定时触发。scheduler 在到达触发时间后调用 run-manager.create()。

### 7. 不负责 StreamBridge 的对外传输实现

StreamBridge 的 SSE / WebSocket / 内存缓冲实现由 `runtime/stream-bridge` 负责。run-manager/worker 只调用 bridge.publish()。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `core/lifecycle` | 依赖 | 调用 lifecycle.run() 执行 agent loop |
| `sandbox` | 依赖 | 在 Run 启动前解析 session 对应的 SandboxContext，并将其传给 lifecycle |
| `runtime/stream-bridge` | 依赖 | worker 将 Bus 事件翻译后发布到 bridge |
| `runtime/permission-profiles` | 依赖 | 创建 run 时解析 permissionProfile 标识对应的权限画像实例 |
| `runtime/scheduler` | 被调用 | scheduler 在触发时机调用 run-manager.create() |
| `runtime/heartbeat` | 被调用 | heartbeat 判断可运行后调用 run-manager.create() |
| `runtime/daemon` | 被持有 | daemon 持有 run-manager 实例，负责其初始化与关闭 |
| `services/session` | 依赖（读） | 崩溃恢复时读取 session storage 重建 in-flight 信息 |
| `bus` | 订阅 | worker 订阅 Bus 事件进行翻译 |
| `docs/ohbaby-sdk` / `ohbaby-sdk` | 类型依赖 | StreamBridge 事件类型定义在 ohbaby-sdk，run-manager 通过 sdk 导入 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：run-manager 创建 run 并绑定权限画像
```typescript
// run-manager 负责
const run = await runManager.create({
  sessionId,
  trigger: 'scheduler',
  permissionProfile: 'notify-only',
  multitaskStrategy: 'queue',
  disconnectMode: 'continue',
})
```

正确：run-manager 在 worker 启动前确保 sandbox context 就绪
```typescript
const sandboxContext = await sandboxManager.acquire(sessionId)

await runWorker.start({
  runId,
  sessionId,
  sandboxContext,
})
```

正确：worker 翻译事件
```typescript
// run-manager/worker 负责
bus.on(Lifecycle.Event.StepStarted, (payload) => {
  bridge.publish(runId, 'run.step.started', { ...payload })
})
```

### 5.2 职责外的示例

错误：run-manager 不应实现权限画像的具体逻辑
```typescript
// 错误：不应该在 run-manager 中
if (trigger === 'channel' && operation === 'write') {
  notifyUser(operation)  // 这是 notify-only profile 的逻辑
}

// 正确：由 runtime/permission-profiles 的 profile 实例处理
```

错误：run-manager 不应管理 Session 内容
```typescript
// 错误：不应该在 run-manager 中
await sessionStorage.appendMessage(sessionId, message)

// 正确：由 core/lifecycle 通过 services/session 写入
```

错误：run-manager 不应直接创建 worktree 或容器
```typescript
// 错误：不应该在 run-manager 中
const workdir = await gitWorktree.create(sessionId)

// 正确：由 sandbox 模块负责提供执行上下文
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：run-manager 将每次 lifecycle.run() 封装为可查询、可取消、可追溯的运行台账，并在启动前绑定本次 Run 使用的执行上下文
- 能清楚回答"这个模块不该做什么"：不做 agent loop 执行、不做 session 管理、不做权限画像实现、不做 task 管理、不做 sandbox 实现、不做定时触发、不做传输层实现
- 职责与其他模块无明显重叠：lifecycle（执行）、sandbox（执行环境）、session（持久化）、permission-profiles（权限）、stream-bridge（传输）边界清晰
