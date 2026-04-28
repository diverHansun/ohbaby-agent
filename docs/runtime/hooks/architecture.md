# hooks 模块 architecture.md

本文档描述 `runtime/hooks` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

hooks 模块是一个**执行容器**，内部结构扁平：HookExecutor 持有注册表，按 hook point 串行执行 hook 函数。

```
┌──────────────────────────────────────────────────────────┐
│ HookExecutor（公共接口）                                   │
│                                                          │
│ 职责：                                                   │
│ - 维护 HookPoint → HookFn[] 注册表                       │
│ - 提供 register(point, fn) 接口                          │
│ - 提供 execute(point, context) 串行执行接口               │
│ - hook 异常隔离：单个 hook 失败不中断后续 hook             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Hook Registry（内部注册表）                         │  │
│  │ Map<HookPoint, HookFn[]>                           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   pre-run hooks    post-run hooks   on-wake hooks
  （由 daemon 注册）（由 daemon 注册）（由 daemon 注册）
```

### 主要组件

| 组件 | 职责 |
|---|---|
| **HookExecutor** | 唯一公共类，持有注册表，执行 hook 链 |
| **Hook Registry** | HookExecutor 内部的 Map，不对外暴露 |
| **内置 Hook 工厂函数** | `createMemoryInjectHook` 等，由 daemon 调用注册，不是 HookExecutor 的一部分 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Chain of Responsibility（责任链）

每个 hook point 对应一条 hook 函数链，按注册顺序串行执行。

**使用理由**：
- 横切关注点（memory 注入、session 摘要、token 记录）天然适合责任链：每个 hook 独立处理自己的关切，不需要知道其他 hook 的存在
- 串行执行保证顺序可预期，避免并行执行的错误隔离复杂度

**不使用并行执行的理由**：
- pre-run hook 可能有顺序依赖（memory 注入应在 loop 检测之前）
- 并行执行的错误隔离和取消语义更复杂，当前阶段 YAGNI

### 2. Factory Function 模式（内置 hook）

内置 hook 以工厂函数形式提供（`createMemoryInjectHook(memoryModule)`），而不是类或单例。

**使用理由**：
- 工厂函数接收依赖作为参数，返回闭包，天然支持依赖注入
- 比类更轻量，hook 函数本身就是 `async (ctx) => void`，不需要额外的类包装
- daemon 在初始化时调用工厂函数并注册，测试时可以传入 mock 依赖

### 3. 未使用插件系统

hook 注册在代码中完成，不支持配置文件注册或动态加载。

**理由**：当前 hook 数量少（4 个内置），动态加载机制的复杂度远超收益。YAGNI。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/hooks/
├── index.ts              # 公共接口：导出 HookExecutor、HookPoint、HookContext 类型
├── executor.ts           # HookExecutor 类实现
├── built-in/
│   ├── memory-inject.ts  # createMemoryInjectHook 工厂函数
│   ├── session-summary.ts # createSessionSummaryHook 工厂函数
│   ├── token-usage.ts    # createTokenUsageHook 工厂函数
│   └── loop-detection.ts # createLoopDetectionHook 工厂函数
├── types.ts              # HookPoint 枚举、HookFn、HookContext 类型
└── __tests__/
    ├── executor.test.ts
    └── built-in/
        └── *.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 导出 HookExecutor 和类型；内置 hook 工厂函数也从此导出供 daemon 使用 |
| `executor.ts` | 核心实现 | HookExecutor 类，不依赖任何业务模块 |
| `built-in/` | 可选注册 | 每个文件是一个工厂函数，依赖各自的业务模块；daemon 按需注册 |
| `types.ts` | 类型定义 | HookPoint 枚举（pre-run / post-run / on-wake）、HookContext 联合类型 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`HookExecutor` 的 `register` / `execute` / `executeWithAbort` 方法签名；`HookPoint` 枚举；`HookContext` 类型
- **内部实现**：注册表数据结构、串行执行循环、异常捕获逻辑

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. hook 异常不中断主流程

单个 hook 抛出异常时，HookExecutor 记录日志并继续执行后续 hook，不向调用方（run-manager/worker）抛出。

**代价**：hook 失败可能被忽略，调用方无法感知单个 hook 的失败状态。这是有意的取舍：hook 是横切关注点，不应因为 memory 注入失败就阻止整个 Run 启动。当前 MVP 不提供阻断型 hook；如果未来出现必须阻止 Run 的场景，应显式引入 `critical: true` 或独立的 preflight 机制，而不是让普通 hook 的异常语义变得暧昧。

### 2. 内置 hook 与 HookExecutor 解耦

`built-in/` 目录的工厂函数不被 HookExecutor 直接引用，HookExecutor 不知道任何内置 hook 的存在。注册由 daemon 在初始化时完成。

**代价**：如果 daemon 忘记注册某个 hook，系统不会报错，只是该 hook 不生效。这是依赖注入的固有代价，通过 daemon 的初始化测试覆盖。

### 3. 放弃的方案：Middleware 管道（Koa/Express 风格）

可以让 hook 函数接收 `(ctx, next)` 并主动调用 `next()` 控制链的继续，类似 Koa middleware。这样每个 hook 可以在 `next()` 前后都插入逻辑。

**放弃理由**：当前 hook 只需要在 lifecycle.run() 的前后各执行一次，不需要"包裹"语义。`next()` 模式引入了调用链的控制权转移，增加了理解成本，且容易因忘记调用 `next()` 而静默中断链。简单的 `pre-run / post-run` 分离已足够。
