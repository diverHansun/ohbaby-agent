# hooks 模块 goals-duty.md

本文档定义 `runtime/hooks` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供 runtime 层的能力组合机制，避免 lifecycle 成为所有逻辑的汇聚点

随着 ohbaby-agent 功能扩展，memory 注入、session 摘要、todo 同步、loop 检测、token 用量记录等横切关注点都需要在 Run 的执行前后插入逻辑。如果全部堆入 `core/lifecycle`，会导致 lifecycle 不断膨胀，难以测试和维护。hooks 模块提供一套轻量的 hook point 机制，使这些关注点以可独立测试的 hook 函数组合，而不是强行内嵌。

### 2. 只在 runtime 层插入，不侵入 core/lifecycle 的执行逻辑

hooks 在 Run worker 启动 / 结束时执行，属于 runtime 层的横切能力。`core/lifecycle` 本身不知道 hooks 的存在，lifecycle 的代码不调用 HookExecutor。这条边界保证 lifecycle 的测试不需要 mock hook 基础设施。

### 3. 保持简单：钩子是普通异步函数，不是插件系统

hooks 的设计目标是"可组合的 middleware"，而不是"可发布的插件市场"。钩子注册在代码中完成，不需要配置文件注册、动态加载、版本管理。YAGNI 原则：只提供已有明确需求的 hook point。

---

## 二、Duties（职责）

### 1. 定义 HookPoint 枚举

MVP 提供三个 hook point：

- `pre-run`：Run worker 启动后、lifecycle.run() 调用前
- `post-run`：lifecycle.run() 完成后（无论成功失败）
- `on-wake`：heartbeat 决定创建 Run 时（唤醒前的准备）

HookPoint 枚举定义在 `runtime/hooks` 内部，不进入 `ohbaby-sdk`。只有当 hooks 作为插件系统的公开扩展点时，才考虑迁入 plugin SDK 或 ohbaby-sdk。

### 2. 实现 HookExecutor

负责：
- 持有 hook point → hook function[] 的注册表
- 提供 `register(point, fn)` 接口
- 提供 `execute(point, context)` 接口：依次执行该 point 的所有 hook 函数，支持串行执行
- hook 函数抛出异常时：记录日志，继续执行后续 hook（不中断主流程）
- 提供 `executeWithAbort(point, context, abortSignal)` 变体：run 被取消时跳过剩余 hook

### 3. 提供内置 hook 的注册入口

负责：
- 提供标准 hook 的工厂函数，供 daemon 初始化时注册：
  - `createMemoryInjectHook()`：pre-run 时将 short-term memory 注入 context
  - `createSessionSummaryHook()`：post-run 时触发 session 摘要生成
  - `createTokenUsageHook()`：post-run 时记录 token 用量到 RunRecord
  - `createLoopDetectionHook()`：pre-run 时检查是否存在无限循环风险
- 以上 hook 是可选注册的，不强制启用

### 4. HookContext 类型定义

负责：
- 定义传入 hook 函数的 context 类型：
  - `pre-run` / `post-run`：`{ runId, sessionId, triggerSource, permissionProfile, runRecord }`
  - `on-wake`：`{ wakeReason, deferredCount, agentState }`

---

## 三、Non-Duties（非职责）

### 1. 不负责 hook 的动态加载或热更新

hook 注册在进程启动时完成，不支持运行时动态添加或卸载 hook。这类能力属于插件市场范畴，超出当前设计目标。

### 2. 不负责 hook 函数的具体业务实现

HookExecutor 只是执行容器。memory 注入的具体逻辑在 `core/memory`，session 摘要逻辑在 `services/session`，hook 函数只是这些模块能力的薄包装。

### 3. 不负责 UI 层的钩子

`ohbaby-tui` 中存在 React hooks（useState 等）和可能的 UI 事件钩子。它们与本模块命名相似但完全不同——runtime/hooks 专指 runtime 层的执行切面，与 UI 无关。

### 4. 不负责 claude-code 风格的用户自定义 hooks 配置

claude-code 支持用户在 `.claude/settings.json` 中配置 shell hooks（工具调用前后执行 bash 命令）。ohbaby 的用户自定义 hooks 若后续支持，应作为独立模块设计，不混入 runtime/hooks。

### 5. 不负责 hook 的并行执行

当前设计为串行执行同一 hook point 的所有 hook 函数。并行执行会引入复杂的错误隔离问题，当前阶段 YAGNI。

### 6. 不负责工具级拦截（pre-tool / post-tool）

`pre-tool` / `post-tool` **不是** runtime/hooks 的 MVP 职责，原因是：
- runtime/hooks 只能在 Run worker 层包住 `lifecycle.run()` 的边界
- `core/tool-scheduler` 在 lifecycle 内部执行，没有合法路径让 runtime 层在工具调用前后插入代码，除非破坏"lifecycle 不知道 hooks 存在"的原则

**工具级能力的分类**：
- **只需观察**（tool audit log、UI 展示、统计）：用 Bus 事件订阅即可，tool-scheduler 可发布类似 `ToolCall.Event.BeforeExecution` / `AfterExecution` 的观察事件
- **需要拦截或修改执行**（cost guard、sandbox path guard、policy preflight）：在 `core/tool-scheduler` 定义最小 `ToolExecutionInterceptor` / `ToolExecutionObserver` 抽象，由 runtime/run-worker 注入实现；core 只依赖自己定义的抽象，runtime 实现它——这是正确的依赖方向（DIP）

当有具体工具级拦截需求时，先在 `core/tool-scheduler` 定义最小接口，再由 runtime/hooks 提供适配实现。当前 MVP 不提供此路径。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/run-manager` | 被调用 | run worker 在 lifecycle.run() 前后调用 executor.execute(pre-run / post-run) |
| `runtime/heartbeat` | 被调用 | heartbeat 接受 WakeSignal 前调用 executor.execute(on-wake) 做轻量横切处理 |
| `core/lifecycle` | 无直接依赖 | lifecycle 不知道 hooks 存在；hooks 在 run worker 层插入 |
| `core/memory` | 依赖（hook 内部） | pre-run hook 调用 memory 模块注入上下文 |
| `services/session` | 依赖（hook 内部） | post-run hook 触发 session 摘要 |
| `runtime/daemon` | 被持有 | daemon 初始化时创建 HookExecutor 并注册内置 hook |
| `docs/ohbaby-sdk` / `ohbaby-sdk` | 暂无依赖 | 当前 hooks 是 runtime 内部切面，不作为外部 SDK 契约暴露 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：run worker 调用 executor 执行 hook
```typescript
// run-manager/worker.ts 中
await hookExecutor.execute('pre-run', { runId, sessionId, triggerSource, runRecord })
const result = await lifecycle.run(session, abortSignal)
await hookExecutor.execute('post-run', { runId, sessionId, triggerSource, runRecord })
```

正确：daemon 初始化时注册 hook
```typescript
// daemon/supervisor.ts 中
executor.register('pre-run', createMemoryInjectHook(memoryModule))
executor.register('post-run', createSessionSummaryHook(sessionService))
executor.register('post-run', createTokenUsageHook(runManager))
```

### 5.2 职责外的示例

错误：lifecycle 不应知道 hooks 存在
```typescript
// 错误：不应该在 core/lifecycle 中
await hookExecutor.execute('pre-run', context)
// lifecycle 应该是纯粹的 agent loop 引擎，不与 runtime 层交互
```

错误：hooks 不应包含复杂业务逻辑
```typescript
// 错误：不应该在 hook 函数内部直接实现业务
executor.register('post-run', async (ctx) => {
  // 直接写几百行 session 摘要逻辑
})

// 正确：hook 函数只是薄包装
executor.register('post-run', async (ctx) => {
  await sessionService.generateSummaryIfNeeded(ctx.sessionId)
})
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：runtime/hooks 提供 Run 级 hook point（pre-run / post-run / on-wake），使 memory 注入、session 摘要、token 记录等横切关注点以可测试的 hook 函数组合，而不是堆入 lifecycle
- 能清楚回答"这个模块不该做什么"：不做动态加载、不实现业务逻辑、不处理 UI 钩子、不支持用户自定义 shell hooks、不做并行执行、不提供工具级拦截（pre-tool / post-tool 不是 MVP 职责）
- 职责与其他模块无明显重叠：core/lifecycle（agent loop 引擎）、core/tool-scheduler（工具执行，工具级拦截接口归它定义）、runtime/run-manager（Run 管理）边界清晰
- pre-tool / post-tool 的缺失是有意为之，文档中已明确未来扩展路径（core 定义抽象，runtime 注入实现）
