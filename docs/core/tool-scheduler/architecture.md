# tool-scheduler 模块 architecture.md

## 2026-10 子代理准入与清理边界

内置 `agent` 使用按 action 解析的可信准入规则。`list/monitor` 是只读操作，`spawn/send/stop/close` 是子代理控制操作；它们不再通过 scheduler 的旧 subagent 容量队列限制实际执行。六个实际执行名额由 `SessionSubagentHost` 按主会话统一管理，前后台共用，满额直接拒绝。

工具向调用方返回 cancelled 不代表底层操作已退出。`getRunCleanup(runId)` 汇总真实操作、资源释放和可信 cleanup 报告；组合层用该证据决定子执行名额和关闭清理是否完成。`getRunCleanup()` 汇总整个 scheduler，服务退出不能忽略仍未确认的操作。`bash(run_in_background=true)` 的自然遗留进程由 ShellJobRegistry 独立管理，不继续占子执行名额；显式 stop/close 仍按实际 child run 或实例 scope 取消它。

本文档描述 `tool-scheduler` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

ToolScheduler 是 ohbaby-agent 的工具调度中心，位于 Agent 与 tools 模块之间，协调权限检查、并发控制和工具执行。

### 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        ToolScheduler                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │   ToolRegistry   │  │   StateManager   │                     │
│  │                  │  │                  │                     │
│  │  - tools         │  │  - toolCalls     │                     │
│  │  - categories    │  │  - transitions   │                     │
│  │  - source fields │  │  - notify()      │                     │
│  └──────────────────┘  └──────────────────┘                     │
│           │                     │                                │
│           └─────────┬───────────┘                                │
│                     │                                            │
│  ┌──────────────────┴───────────────────┐                       │
│  │        ConcurrencyController          │                       │
│  │                                       │                       │
│  │  - maxReadConcurrency: 5              │                       │
│  │  - currentReadCount                   │                       │
│  │  - writeInProgress                    │                       │
│  │  - subagentCount / maxSubagent: 3     │                       │
│  │  - pendingQueue                       │                       │
│  │  - canExecute()                       │                       │
│  │  - acquire() / release()              │                       │
│  └───────────────────────────────────────┘                       │
│                     │                                            │
│  ┌──────────────────┴───────────────────┐                       │
│  │          ExecutionEngine              │                       │
│  │                                       │                       │
│  │  - execute()                          │                       │
│  │  - cancel()                           │                       │
│  │  - processQueue()                     │                       │
│  └───────────────────────────────────────┘                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
           ▼                  ▼                  ▼
      ┌─────────┐       ┌──────────┐      ┌─────────┐
      │ Policy  │       │Permission│      │  tools  │
      └─────────┘       └──────────┘      └─────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 ToolRegistry

**职责**：管理工具注册和查询

**数据结构**：

```typescript
class ToolRegistry {
  private tools: Map<string, Tool>; // 所有来源的工具
  private categoryMap: Map<string, ToolCategory>; // 显式或推断类别映射
}
```

Registry 不按来源维护多个 map；来源由每个 `Tool.source` 字段表达。这样 `builtin`、`module`、`skill`、`mcp` 共享同一注册、查询和 agent 过滤路径。

> 网络工具（`web_search` / `web_fetch`）以 `source: "builtin"` 注册到统一 `tools` map；它们是 `tools` 入口，后端通过 `services/search-providers/registry` 调用具体厂商，对调度器是透明的。

**主要方法**：

- `register(tool)`: 注册工具
- `get(name)`: 获取工具
- `getCategory(name)`: 获取工具类别
- `getAvailableTools(mode)`: 根据模式获取可用工具

**类别映射表**：

```typescript
const BUILTIN_CATEGORIES: Record<string, ToolCategory> = {
  // readonly（只读，可并行 ≤5）
  read: "readonly",
  glob: "readonly",
  grep: "readonly",
  list: "readonly",
  todo_read: "readonly",

  // write（写入，串行）
  write: "write",
  edit: "write",
  todo_write: "write",

  // dangerous（危险，串行）
  bash: "dangerous",

  // network（网络，可并行 ≤5）
  web_fetch: "network",
  web_search: "network",

  // subagent（子代理，可并行 ≤3）
  task: "subagent",
};

// MCP 工具类别在注册时由 adaptMcpTool() 根据 annotations.readOnlyHint 推断：
//   readOnlyHint === true  → 'readonly'
//   readOnlyHint !== true  → 'write'（安全默认）
// Skill 工具来源为 source: 'skill'，默认类别为 'skill'，不再归入 module source。
```

### 1.3 显式确认边界

ToolScheduler 不消费 MCP 私有的 `isTrusted`。需要绕过普通类别自动放行的工具，应设置通用字段：

```typescript
interface Tool {
  requireExplicitApproval?: boolean;
}
```

当该字段为 `true` 时，scheduler 在 permission state 允许后仍会调用 `Permission.ask()`，使用 `reason: "explicit-approval-required"` 且 `rememberable: false`。MCP adapter 负责把 `trust: false` 映射为该字段；`isTrusted` 仅保留为 MCP-local metadata。

### 2.2 StateManager

**职责**：管理工具调用状态

**状态定义**：

```typescript
type ToolCallStatus =
  | "pending" // 等待处理
  | "checking_permission" // 检查权限状态
  | "awaiting_approval" // 等待用户确认
  | "queued" // 等待执行（并发控制）
  | "executing" // 正在执行
  | "success" // 执行成功
  | "error" // 执行失败
  | "rejected" // 被拒绝
  | "cancelled"; // 被取消
```

**状态转换规则**：

```
pending
   │
   ▼
checking_permission
   │
   ├── DENY ──────────────────────────────→ rejected
   │
   ├── ALLOW ─────→ [并发检查] ─── 可执行 ──→ executing ──→ success
   │                    │                        │
   │                    └── 需等待 ──→ queued ───┘       └──→ error
   │
   └── ASK ───────→ awaiting_approval
                        │
                        ├── once/always ──→ [并发检查] ──→ ...
                        ├── reject ───────────────────────→ rejected
                        └── cancel ───────────────────────→ cancelled
```

### 2.3 容量与资源租约

调度器按 session 限制普通调用的并发数，默认上限为 10。工具通过准入计划声明需要访问的资源。四个 goal 工具显式声明 `internal-state` 类别，使用普通容量，资源计划为空。

### 2.4 批量调用

`executeBatch()` 按请求顺序检查批内资源冲突。有冲突的后续调用等待前面的调用结束，独立调用可以并发。调度器按请求的原始顺序返回结果。容量细节见[调度数据模型](./data-model.md)。

### 2.5 ExecutionEngine

**职责**：执行工具调用

**执行流程**：

1. 检查工具是否存在
2. 创建 ToolCall 对象，状态设为 pending
3. 调用 Policy.check() 获取决策
4. 根据决策处理
5. 通过 ConcurrencyController 检查是否可执行
6. 执行工具或加入队列
7. 返回结果

---

## 三、Design Patterns（设计模式）

### 3.1 状态机模式（State Machine）

**应用场景**：工具调用状态管理

**实现方式**：

- 明确的状态枚举
- 显式的状态转换规则
- 每次转换通过 transition() 方法

**选择理由**：

- 工具调用有明确的生命周期
- 状态转换需要可追踪
- 便于调试和监控

### 3.2 队列模式（Queue Pattern）

**应用场景**：并发控制和任务排队

**实现方式**：

- pendingQueue 存储等待执行的调用
- processQueue() 在资源释放时处理队列

**选择理由**：

- 写操作需要等待读操作完成
- 保证公平调度

### 3.3 观察者模式（Observer Pattern）

**应用场景**：状态变化通知

**实现方式**：

- 通过 Bus 发布状态变化事件
- UI 和其他模块订阅事件

**选择理由**：

- 解耦状态管理和 UI 更新
- 支持多个订阅者

---

## 四、Integration Points（集成点）

### 4.1 与 Policy 集成

```typescript
// 获取当前模式
const mode = Policy.getMode();

// 检查工具执行决策
const decision = Policy.check(category);
// decision: 'allow' | 'deny' | 'ask'
```

### 4.2 与 Permission 集成

```typescript
// 当 Policy 返回 'ask' 时
try {
  await Permission.ask({
    sessionId,
    messageId,
    type: "tool",
    name: toolName,
    title: `Execute ${toolName}`,
    metadata: { params },
  });
  // 用户批准，继续执行
} catch (error) {
  if (error instanceof Permission.RejectedError) {
    // 用户拒绝
  }
}
```

### 4.3 与 tools 模块集成

```typescript
// 执行工具
const result = await tool.execute(params, {
  sessionId,
  messageId,
  callId,
  signal,
});
```

---

## 五、Event Design（事件设计）

### 5.1 发布的事件

| 事件名称                               | 触发时机   | 携带数据                                        |
| -------------------------------------- | ---------- | ----------------------------------------------- |
| ToolScheduler.Event.StatusChanged      | 状态变化时 | callId, previousStatus, currentStatus, toolName |
| ToolScheduler.Event.ExecutionStarted   | 开始执行时 | callId, toolName, params                        |
| ToolScheduler.Event.ExecutionCompleted | 执行完成时 | callId, toolName, result                        |

### 5.2 订阅的事件

| 事件名称                 | 来源       | 处理逻辑         |
| ------------------------ | ---------- | ---------------- |
| Permission.Event.Replied | Permission | 处理用户确认响应 |

---

## 六、Error Handling（错误处理）

### 6.1 错误类型

| 错误类型                | 场景             | 处理方式                 |
| ----------------------- | ---------------- | ------------------------ |
| ToolNotFoundError       | 工具不存在       | 返回错误，状态设为 error |
| PolicyDeniedError       | Policy 返回 deny | 状态设为 rejected        |
| PermissionRejectedError | 用户拒绝         | 状态设为 rejected        |
| ExecutionError          | 工具执行失败     | 状态设为 error           |
| TimeoutError            | 执行超时         | 终止执行，状态设为 error |
| CancelledError          | 被取消           | 状态设为 cancelled       |

### 6.2 错误恢复

- 单个工具失败不影响其他工具
- 释放并发锁，处理队列中下一个
- 通过事件通知状态变化

---

## 七、Timeout Management（超时管理）

### 7.1 默认超时

- 工具执行：2 分钟
- Permission 等待：无超时（由 Agent 控制）

### 7.2 超时处理

```typescript
// 创建带超时的 AbortController
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120000);

try {
  await tool.execute(params, { ...context, signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

---

## 八、Dependencies（依赖关系）

### 8.1 外部依赖

| 依赖模块   | 依赖方式   | 用途           |
| ---------- | ---------- | -------------- |
| Policy     | 运行时依赖 | 获取模式和决策 |
| Permission | 运行时依赖 | 用户确认       |
| Bus        | 运行时依赖 | 事件发布/订阅  |
| tools      | 运行时依赖 | 工具实现       |

### 8.2 被依赖

| 依赖方 | 调用接口                       | 用途               |
| ------ | ------------------------------ | ------------------ |
| Agent  | execute(), getAvailableTools() | 工具调用和工具列表 |

---

## 九、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 组件职责单一，边界清晰
- [x] 设计模式选择有明确理由
- [x] 并发控制策略清晰
- [x] 状态机转换规则完整
- [x] 错误处理策略明确
