# tool-scheduler 模块 data-model.md

本文档定义 `tool-scheduler` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 ToolCategory（工具类别）

工具根据其操作特性分为七类：

| 类别      | 说明                   | 并发特性                      | 示例工具                                                   |
| --------- | ---------------------- | ----------------------------- | ---------------------------------------------------------- |
| readonly  | 只读操作               | 可并行（最多5个）             | read, glob, grep, list；MCP工具（readOnlyHint=true）       |
| write     | 写入操作               | 串行执行                      | write, edit；MCP工具（readOnlyHint=false/未设置）          |
| dangerous | 危险操作               | 串行执行                      | bash                                                       |
| network   | 网络操作               | 可并行（最多5个）             | web_fetch, web_search（内置工具，背后走 search-providers） |
| memory    | 目标/内部状态操作      | 可并行（不受读写锁限制）      | goals 工具（显式声明 `category: "memory"`）                |
| skill     | 技能加载与技能资源读取 | 可并行（最多5个）             | skill, skill_resource                                      |
| subagent  | 子代理操作             | 由可信工具声明准入能力       | agent                                                      |

**MCP工具分类规则**：通过 `annotations.readOnlyHint` 在工具注册时推断，`true` → `readonly`，其余 → `write`。

### 1.2 ToolSource（工具来源）

工具根据其来源分为四类：

| 来源    | 代码位置     | 说明                                      | 注册时机                                               |
| ------- | ------------ | ----------------------------------------- | ------------------------------------------------------ |
| builtin | `src/tools/` | 内置工具（含 web_search / web_fetch）     | 启动时静态注册                                         |
| module  | 各模块内部   | 模块自带工具（当前无 memory LLM adapter） | 模块初始化时注册                                       |
| skill   | `src/skill/` | 技能系统工具（skill / skill_resource）    | runtime composition 注册并在 skill registry 变化时刷新 |
| mcp     | 运行时动态   | MCP 服务器提供的工具                      | 运行时发现注册                                         |

> `web_search` / `web_fetch` 属于 `builtin`；它们是 `tools` 入口，后端走 `services/search-providers/` 路由到具体厂商（Tavily / Exa），但对调度器仍是普通的 builtin 工具，不另立来源类型。

### 1.3 ToolCallStatus（调用状态）

工具调用的生命周期状态：

| 状态                | 说明                 | 可转换到                            |
| ------------------- | -------------------- | ----------------------------------- |
| pending             | 初始状态，等待处理   | checking_permission                 |
| checking_permission | 正在检查权限状态     | queued, awaiting_approval, rejected |
| awaiting_approval   | 等待用户确认         | queued, rejected, cancelled         |
| queued              | 已批准，等待并发资源 | executing                           |
| executing           | 正在执行             | success, error, cancelled           |
| success             | 执行成功（终态）     | -                                   |
| error               | 执行失败（终态）     | -                                   |
| rejected            | 被拒绝（终态）       | -                                   |
| cancelled           | 被取消（终态）       | -                                   |

### 1.4 ToolCall（工具调用）

表示一次工具调用的完整信息。

### 1.5 ToolCallRequest（调用请求）

来自 Agent/LLM 的工具调用请求。

### 1.6 ToolCallResult（调用结果）

工具执行完成后的结果。

---

## 二、Data Types（数据类型）

### 2.1 枚举类型

```typescript
// 工具类别
type ToolCategory =
  | "readonly"
  | "write"
  | "dangerous"
  | "network"
  | "memory"
  | "skill"
  | "subagent";

// 工具来源
type ToolSource = "builtin" | "module" | "skill" | "mcp";

// 调用状态
type ToolCallStatus =
  | "pending"
  | "checking_permission"
  | "awaiting_approval"
  | "queued"
  | "executing"
  | "success"
  | "error"
  | "rejected"
  | "cancelled";

// 终态状态
type FinalStatus = "success" | "error" | "rejected" | "cancelled";
```

### 2.2 请求类型

```typescript
// 工具调用请求（来自 Agent）
interface ToolCallRequest {
  callId: string; // 调用唯一标识
  toolName: string; // 工具名称
  params: Record<string, unknown>; // 工具参数
  sessionId: string; // 所属会话
  runId?: string; // 真实执行 run；交互审批必需，不能用 callId 代替
  messageId: string; // 关联消息
}

// 批量调用请求
interface BatchToolCallRequest {
  calls: ToolCallRequest[];
}
```

### 2.2.1 Tool 定义中的显式确认

```typescript
interface Tool {
  source: ToolSource;
  category?: ToolCategory;
  requireExplicitApproval?: boolean;
}
```

`requireExplicitApproval: true` 在默认权限档位下要求 scheduler 调用 `Permission.ask()`，使用 `reason: "explicit-approval-required"` 与 `rememberable: false`。`full-access` 跳过包括此项在内的人工 ask，但明确 deny、禁止路径/命令和参数/资源检查仍执行；切换档位不自动回答已有待办。FullAccess 自动放行外部写入或 shell preflight 时不新增目录信任，切回 default 后重新按常规边界判断；显式 always/session allow 的信任语义保留。该字段是通用工具语义；MCP 的 `trust`/`isTrusted` 只在 MCP adapter 内映射，不由 scheduler 直接消费。

### 2.3 调用状态类型

```typescript
// 工具调用完整状态
interface ToolCall {
  // 基础信息
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  sessionId: string;
  runId?: string;
  messageId: string;

  // 状态信息
  status: ToolCallStatus;
  category: ToolCategory;

  // 时间信息
  createdAt: number;
  startedAt?: number; // 进入 executing 状态的时间
  completedAt?: number; // 进入终态的时间
  durationMs?: number; // completedAt - startedAt，执行耗时

  // 进度信息（executing 状态下由工具回报）
  progress?: {
    message?: string; // 人类可读进度描述（如 "Reading file..."）
    percent?: number; // 0-100 完成百分比
    current?: number; // 当前项数
    total?: number; // 总项数
  };

  // 结果信息（执行完成后）
  result?: ToolCallResult;
  error?: ToolCallError;
}

// 等待中的调用（在队列中）
interface QueuedCall {
  call: ToolCall;
  resolve: (result: ToolCallResult) => void;
  reject: (error: Error) => void;
}
```

### 2.4 结果类型

```typescript
// 调用结果
interface ToolCallResult {
  callId: string;
  status: "success" | "error" | "rejected" | "cancelled";
  output?: string; // 工具输出
  metadata?: Record<string, unknown>; // 元数据
  error?: ToolCallError; // 错误信息
  duration?: number; // 执行时长（毫秒）
}

// 错误信息
interface ToolCallError {
  type: ToolCallErrorType;
  message: string;
  details?: unknown;
}

// 错误类型
type ToolCallErrorType =
  | "ToolNotFoundError"
  | "PolicyDeniedError"
  | "PermissionRejectedError"
  | "ExecutionError"
  | "TimeoutError"
  | "CancelledError"
  | "ValidationError";
```

### 2.5 事件类型

```typescript
// 状态变化事件
interface StatusChangedEvent {
  callId: string;
  toolName: string;
  previousStatus: ToolCallStatus;
  currentStatus: ToolCallStatus;
  timestamp: number;
}

// 执行开始事件
interface ExecutionStartedEvent {
  callId: string;
  toolName: string;
  params: Record<string, unknown>;
  timestamp: number;
}

// 执行完成事件
interface ExecutionCompletedEvent {
  callId: string;
  toolName: string;
  result: ToolCallResult;
  timestamp: number;
}
```

### 2.6 配置类型

```typescript
// 并发配置
interface ConcurrencyConfig {
  maxConcurrency?: number; // 每个 session 的普通调用上限，默认 10
  maxReadConcurrency?: number; // 兼容旧名称
}

// 超时配置
interface TimeoutConfig {
  defaultTimeout: number; // 默认 120000 (2分钟)
}

// ToolScheduler 配置
interface ToolSchedulerConfig {
  concurrency: ConcurrencyConfig;
  timeout: TimeoutConfig;
}
```

---

## 三、Category Mapping（类别映射）

### 3.1 Core Tools 类别映射

Core Tools 来自 `src/tools/`，启动时静态注册：

```typescript
const CORE_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // readonly
  read: "readonly",
  glob: "readonly",
  grep: "readonly",
  list: "readonly",
  todo_read: "readonly",

  // write
  write: "write",
  edit: "write",
  todo_write: "write",

  // dangerous
  bash: "dangerous",
};
```

### 3.2 Module-Owned Tools 类别映射

模块内置工具在模块初始化时注册：

```typescript
// memory 是通用调度类别；由 goals 等真实工具显式声明，
// 不再通过 ghost memory_* 名称推断。
```

### 3.3 Network Tools 类别映射（内置工具的子集）

`web_search` / `web_fetch` 属于内置工具，类别为 `network`。它们在 `BUILTIN_CATEGORIES` 中已经包含；本节单独列出仅为强调它们的运行时依赖：

```typescript
// 网络工具类别（已在 BUILTIN_CATEGORIES 中）
const NETWORK_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  web_fetch: "network",
  web_search: "network",
};
```

**注意**：`web_search` / `web_fetch` 工具需要 `services/search-providers/` 后端配置（如 `TAVILY_API_KEY`）才能正常执行。配置由 `config/tools/{provider}` 负责，调度器对此透明。

### 3.4 模式与类别的映射

```typescript
// 各模式允许的工具类别
const MODE_ALLOWED_CATEGORIES: Record<Mode, ToolCategory[]> = {
  ask: ["readonly", "network", "memory"],
  plan: ["readonly", "network", "memory"],
  agent: ["readonly", "write", "dangerous", "network", "memory"],
};
```

---

## 四、State Machine（状态机定义）

### 4.1 状态转换表

| 当前状态            | 事件               | 目标状态            | 条件           |
| ------------------- | ------------------ | ------------------- | -------------- |
| pending             | start              | checking_permission | -              |
| checking_permission | permission_allow   | queued              | 并发检查通过   |
| checking_permission | permission_allow   | queued              | 并发检查需等待 |
| checking_permission | permission_deny    | rejected            | -              |
| checking_permission | permission_ask     | awaiting_approval   | -              |
| awaiting_approval   | user_approve       | queued              | -              |
| awaiting_approval   | user_reject        | rejected            | -              |
| awaiting_approval   | cancel             | cancelled           | -              |
| queued              | resource_available | executing           | -              |
| queued              | cancel             | cancelled           | -              |
| executing           | complete           | success             | 执行成功       |
| executing           | fail               | error               | 执行失败       |
| executing           | cancel             | cancelled           | -              |
| executing           | timeout            | error               | 超时           |

### 4.2 状态转换函数

```typescript
function transition(
  current: ToolCallStatus,
  event: TransitionEvent,
): ToolCallStatus | null {
  const transitions: Record<
    ToolCallStatus,
    Partial<Record<TransitionEvent, ToolCallStatus>>
  > = {
    pending: {
      start: "checking_permission",
    },
    checking_permission: {
      permission_allow: "queued",
      permission_deny: "rejected",
      permission_ask: "awaiting_approval",
    },
    awaiting_approval: {
      user_approve: "queued",
      user_reject: "rejected",
      cancel: "cancelled",
    },
    queued: {
      resource_available: "executing",
      cancel: "cancelled",
    },
    executing: {
      complete: "success",
      fail: "error",
      cancel: "cancelled",
      timeout: "error",
    },
    // 终态无转换
    success: {},
    error: {},
    rejected: {},
    cancelled: {},
  };

  return transitions[current]?.[event] ?? null;
}
```

---

## 五、Concurrency State（并发状态）

### 5.1 准入与容量

调度器按 session 维护普通调用的容量计数，默认上限为 10；不同 session 的容量互不影响。可信控制操作不占普通容量，以便在容量满时仍能执行停止等操作。工具的具体资源访问另由准入计划和资源租约协调。`subagent` 是工具分类，不单独占用派发名额；并发限制以实际声明的准入能力为准。

等待容量的调用按队列处理；租约释放是幂等的，避免重复释放影响其他调用。`maxReadConcurrency` 是普通容量的旧配置名，`maxConcurrency` 存在时优先使用后者。

---

## 六、Constants（常量定义）

### 6.1 默认配置

```typescript
const DEFAULT_CONFIG: ToolSchedulerConfig = {
  concurrency: {
    maxReadConcurrency: 10, // 普通调用上限
  },
  timeout: {
    defaultTimeout: 120000, // 2 分钟
  },
};
```

### 6.2 终态集合

```typescript
const FINAL_STATUSES: ToolCallStatus[] = [
  "success",
  "error",
  "rejected",
  "cancelled",
];

function isFinalStatus(status: ToolCallStatus): boolean {
  return FINAL_STATUSES.includes(status);
}
```

---

## 七、Validation Rules（验证规则）

### 7.1 请求验证

- callId: 必须非空且唯一
- toolName: 必须是已注册的工具
- params: 必须符合工具的参数 Schema
- sessionId: 必须非空
- messageId: 必须非空

### 7.2 状态转换验证

- 只允许定义的状态转换
- 终态不可再转换
- 转换前检查前置条件

---

## 八、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 状态机定义完整
- [x] 并发控制逻辑清晰
- [x] 类型定义符合 TypeScript 规范

交互审批以独立 permissionId 标识每一次 ask；同一 callId 可连续产生外部目录与工具执行审批。scheduler 传入真实 runId、sessionId、callId 和该调用的 AbortSignal。runId 缺失的独立工具调用不得伪造身份进入人工审批；信号已终止时也不得通过已有规则快路径执行。
