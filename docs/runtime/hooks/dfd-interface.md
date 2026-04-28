# hooks 模块 dfd-interface.md

本文档描述 `runtime/hooks` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

hooks 模块是 runtime 的横切关注点执行容器，在 Run 生命周期的关键节点执行注册的 hook 函数。

| 方向 | 外部模块 | 交互方式 |
|---|---|---|
| 被调用（执行）| `runtime/run-manager` RunWorker | `hookExecutor.execute('pre-run', ctx)` / `execute('post-run', ctx)` |
| 被调用（执行）| `runtime/heartbeat` HeartbeatMachine | `hookExecutor.execute('on-wake', ctx)` |
| 被调用（注册）| `runtime/daemon/bootstrap` | `hookExecutor.register(point, fn)` 注册内置 hook |
| 依赖（内置 hook）| memory 模块 / session 模块 / token 计数模块 等 | 各内置 hook 工厂函数的依赖，在注册时通过闭包注入 |

**特点**：hooks 模块本身不依赖任何业务模块；内置 hook 通过工厂函数（factory function）接收依赖，注册逻辑在 daemon/bootstrap 完成。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：hook 注册（启动时，一次性）

```
daemon/bootstrap 初始化阶段
  → hookExecutor.register('pre-run', createMemoryInjectHook(memoryModule))
  → hookExecutor.register('pre-run', createLoopDetectionHook(sessionModule))
  → hookExecutor.register('post-run', createSessionSummaryHook(sessionModule))
  → hookExecutor.register('post-run', createTokenUsageHook(tokenCountModule))
  ↓
HookExecutor 内部 Map 存储：HookPoint → HookFn[]
```

### 流程 2：pre-run hook 执行

```
RunWorker.start() 开始
  → hookExecutor.execute('pre-run', { runId, sessionId, triggerSource, ... })
  ↓
串行执行 'pre-run' hook 链：
  1. createMemoryInjectHook: 读取相关记忆 → 注入到 session context
  2. createLoopDetectionHook: 检测是否存在循环触发 → 若检测到则标记
  ↓
每个 hook 若抛出异常：
  ├── 非 critical hook → 记录日志，继续执行下一个 hook
  └── critical hook（未来扩展）→ 向上传播，中断 Run 启动
  ↓
hook 链执行完毕 → lifecycle.run() 开始
```

### 流程 3：on-wake hook 执行

```
HeartbeatMachine 决定接受 WakeSignal
  → hookExecutor.execute('on-wake', { wakeReason, deferredCount, agentState })
  ↓
串行执行 'on-wake' hook 链：
  1. createWakeAuditHook: 记录唤醒来源和队列状态
  2. createPersonalizationRefreshHook: 轻量刷新长期偏好索引（可选）
  ↓
hook 链执行完毕 → heartbeat 调用 runManager.create()
```

`on-wake` 是 runtime 层的唤醒切面，只能做轻量副作用或观测记录，不负责决定是否创建 Run。能不能创建 Run 仍由 heartbeat 状态机和 run-manager 并发策略决定。

### 流程 4：post-run hook 执行

```
lifecycle.run() 返回（正常 / abort）
  → hookExecutor.execute('post-run', { runId, sessionId, result, ... })
  ↓
串行执行 'post-run' hook 链：
  1. createSessionSummaryHook: 生成/更新 session 摘要
  2. createTokenUsageHook: 记录本次 Run 的 token 使用量
  ↓
hook 链执行完毕 → RunWorker 继续结束流程
```

---

## 三、Interface Definition（接口定义）

### 接口 1：register(point, fn)

**语义**：在指定 hook point 注册一个 hook 函数。

- **输入**：`HookPoint`（`'pre-run' | 'post-run' | 'on-wake'`）、`HookFn`（`async (ctx) => void`）
- **调用时机**：daemon/bootstrap 启动阶段，一次性调用，不在运行时动态注册

### 接口 2：execute(point, context)

**语义**：串行执行指定 hook point 的所有注册 hook。

- **输入**：`HookPoint`、`HookContext`（包含 runId、sessionId 等上下文）
- **输出**：void（hook 不返回值；副作用通过内部依赖实现）
- **同步/异步**：异步（hook 函数可以是 async）
- **错误处理**：单个 hook 失败不中断链，记录日志继续

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 归属 | 责任边界 |
|---|---|---|
| hook 注册表（HookPoint → HookFn[]）| HookExecutor（内部）| 外部不直接访问；只通过 register/execute 操作 |
| HookContext | RunWorker 构造，传入 execute | hooks 模块只读，不修改 context 对象 |
| hook 副作用（记忆注入、摘要写入等）| 各内置 hook 通过依赖模块完成 | hooks 模块不知道副作用细节；每个 hook 自行管理其副作用 |
| hook 异常 | HookExecutor 捕获并记录 | 不向 RunWorker 传播（除非 critical 标记，当前 MVP 未实现）|
