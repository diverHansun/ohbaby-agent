# permission 模块 architecture.md

本文档描述 `permission` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

permission 模块采用**事件驱动 + 队列管理**架构，将职责分为三个层次：

```
+---------------------------------------------------------------------+
| PermissionManager（对外接口层）                                      |
|                                                                     |
| 职责：                                                               |
| - 提供统一的权限确认 API（ask, respond, clearSession）               |
| - 协调队列管理和批准列表管理                                         |
| - 通过 Bus 发布权限事件                                              |
|                                                                     |
|   +-----------------------------------------------------------+     |
|   | RequestQueue（请求队列）                                   |     |
|   |                                                           |     |
|   | 职责：                                                    |     |
|   | - 维护待批准请求队列                                       |     |
|   | - 确保串行处理（一次一个确认框）                            |     |
|   | - 管理 Promise 的 resolve/reject                          |     |
|   +-----------------------------------------------------------+     |
|                                                                     |
|   +-----------------------------------------------------------+     |
|   | ApprovalRegistry（批准注册表）                             |     |
|   |                                                           |     |
|   | 职责：                                                    |     |
|   | - 维护已批准的权限列表                                     |     |
|   | - Pattern 生成与匹配                                       |     |
|   | - 会话级存储                                               |     |
|   +-----------------------------------------------------------+     |
|                                                                     |
+---------------------------------------------------------------------+
                              |
                              v
                     +------------------+
                     | Bus 模块         |
                     | (事件发布)        |
                     +------------------+
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **PermissionManager** | 对外 API 入口，协调各组件，发布事件 |
| **RequestQueue** | 管理待批准请求队列，确保串行处理 |
| **ApprovalRegistry** | 管理已批准列表，Pattern 生成与匹配 |
| **PatternMatcher** | Pattern 匹配逻辑，支持通配符 |

### 组件间依赖关系

```
PermissionManager
    +-- RequestQueue（调用）
    +-- ApprovalRegistry（调用）
    +-- Bus（依赖）

RequestQueue
    +-- 无外部依赖

ApprovalRegistry
    +-- PatternMatcher（调用）

PatternMatcher
    +-- 无外部依赖（纯函数）
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 事件驱动模式

**使用理由**：
- 与 UI 层解耦，permission 模块不直接操作 UI
- 支持多种 UI 实现（CLI、IDE 扩展、Web）
- 符合 OpenCode 的设计风格

**实现方式**：
```typescript
// 发布权限请求事件
Bus.publish(Permission.Event.Updated, info)

// UI 层订阅事件
Bus.subscribe(Permission.Event.Updated, (event) => {
  showConfirmationDialog(event.info)
})
```

**不采用回调函数的理由**：
- 回调函数会导致 permission 模块与 UI 层耦合
- 不利于多 UI 实现

### 2. Promise 模式

**使用理由**：
- ask() 返回 Promise，调用方可以 await 等待结果
- 自然支持异步流程
- 便于错误处理（reject 表示拒绝）

**实现方式**：
```typescript
async function ask(input: AskInput): Promise<void> {
  return new Promise((resolve, reject) => {
    queue.add({
      info: createPermissionInfo(input),
      resolve,
      reject
    })
  })
}
```

### 3. 队列模式

**使用理由**：
- 确保一次只显示一个确认框
- 避免用户混淆
- 按顺序处理请求

**实现方式**：
```typescript
class RequestQueue {
  private queue: PendingRequest[] = []
  private current: PendingRequest | null = null

  add(request: PendingRequest): void {
    this.queue.push(request)
    this.processNext()
  }

  private processNext(): void {
    if (this.current || this.queue.length === 0) return
    this.current = this.queue.shift()
    Bus.publish(Event.Updated, this.current.info)
  }
}
```

### 3.1 Auto-Approval 机制

**设计背景**：
用户选择 "always"（Yes and don't ask again）后，系统需要：
1. 将当前请求的 Pattern 添加到批准列表
2. 自动批准队列中所有匹配该 Pattern 的待处理请求
3. 通知 Policy 模块切换到 edit-automatically 模式

**实现方式**：
```typescript
// 在 respond() 处理 'always' 响应时
function handleAlwaysResponse(sessionId: string, pattern: string): void {
  // 1. 添加到批准列表
  approvalRegistry.add(sessionId, pattern)

  // 2. 自动批准队列中匹配的请求
  const autoApproved = requestQueue.approveMatching(sessionId, pattern)

  // 3. 对每个自动批准的请求，发布 Replied 事件
  for (const request of autoApproved) {
    request.resolve()
    Bus.publish(Event.Replied, {
      sessionId,
      permissionId: request.info.id,
      response: { type: 'auto_approved', pattern }
    })
  }

  // 4. 通知 Policy 切换模式
  Bus.publish(Event.SwitchModeRequested, {
    sessionId,
    targetMode: 'edit-automatically',
    trigger: { permissionId: current.info.id, pattern }
  })
}
```

**RequestQueue.approveMatching() 方法**：
```typescript
class RequestQueue {
  // 批准队列中所有匹配 pattern 的请求
  approveMatching(sessionId: string, pattern: string): PendingRequest[] {
    const approved: PendingRequest[] = []

    this.queue = this.queue.filter(request => {
      if (request.info.sessionId !== sessionId) return true

      if (patternMatcher.match(request.info.pattern, new Set([pattern]))) {
        approved.push(request)
        return false  // 从队列移除
      }
      return true
    })

    return approved
  }
}
```

**设计原则**：
- 仅批准同一会话的请求
- 使用 PatternMatcher 进行精确匹配
- 自动批准的请求也会发布 Replied 事件，便于追踪

### 4. 策略模式（Pattern 匹配）

**使用理由**：
- Pattern 匹配逻辑可能需要扩展
- 不同工具类型可能有不同的匹配规则
- 便于测试

**实现方式**：
```typescript
interface PatternMatcher {
  match(pattern: string, approved: Set<string>): boolean
  generate(type: string, name: string, args: unknown): string
}
```

### 5. 未使用的模式

**未使用观察者模式（内部）**：
- 事件发布通过外部 Bus 模块完成
- 模块内部不维护订阅者列表

**未使用单例模式**：
- PermissionManager 可由调用方管理实例生命周期
- 便于测试时创建多个独立实例

**未使用超时模式**：
- 根据设计决策，permission 模块不实现超时
- 超时由 Agent 运行时层面处理

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/permission/
+-- index.ts                  # 模块入口，导出公共 API
+-- manager.ts                # PermissionManager 实现
+-- queue.ts                  # RequestQueue 实现
+-- registry.ts               # ApprovalRegistry 实现
+-- matcher.ts                # PatternMatcher 实现
+-- types.ts                  # 类型定义
+-- events.ts                 # 事件类型定义
+-- errors.ts                 # 自定义错误类型
+-- __tests__/
    +-- manager.test.ts
    +-- queue.test.ts
    +-- registry.test.ts
    +-- matcher.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 导出 PermissionManager、类型和错误 |
| `manager.ts` | 核心逻辑 | 实现所有对外 API，协调各组件 |
| `queue.ts` | 队列管理 | 管理待批准请求队列 |
| `registry.ts` | 批准管理 | 管理已批准列表 |
| `matcher.ts` | 匹配逻辑 | Pattern 生成与匹配 |
| `types.ts` | 类型定义 | PermissionInfo、Response 等类型 |
| `events.ts` | 事件定义 | 权限相关事件类型 |
| `errors.ts` | 错误定义 | RejectedError 等自定义错误 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `Permission.ask()` 方法
- `Permission.respond()` 方法
- `Permission.clearSession()` 方法
- `PermissionInfo` 类型
- `PermissionResponse` 类型
- `Permission.Event` 事件定义
- `PermissionRejectedError` 错误类型

### 内部实现

以下内容为内部实现，可自由重构：
- `RequestQueue` 类
- `ApprovalRegistry` 类
- `PatternMatcher` 类
- Pattern 生成算法
- 队列处理逻辑

---

## 四、Pattern 设计（批准模式）

### Pattern 格式

```
<type>:<name>[:<path_pattern>]

示例：
- tool:edit                    # 工具级批准
- tool:edit:src/**             # 路径级批准
- tool:write:src/components/** # 路径级批准
- bash:git                     # 命令级批准
- bash:git:push                # 子命令级批准
- bash:rm:*                    # 通配符批准
- skill:code-review            # 技能级批准
- skill:*                      # 所有技能批准
```

### Pattern 生成规则

```typescript
function generatePattern(type: string, name: string, args: unknown): string {
  // 工具类型
  if (type === 'tool') {
    if (name === 'edit' || name === 'write') {
      const filePath = args.file_path
      const dir = extractDirectory(filePath)  // src/components/Button.tsx -> src/components
      return `tool:${name}:${dir}/**`
    }
    return `tool:${name}`
  }

  // bash 命令
  if (type === 'bash') {
    const command = parseCommand(args.command)
    const head = command[0]  // git, rm, npm 等
    if (command.length > 1) {
      return `bash:${head}:${command[1]}`  // bash:git:push
    }
    return `bash:${head}`
  }

  // skill 技能
  if (type === 'skill') {
    return `skill:${name}`  // skill:code-review
  }

  return `${type}:${name}`
}
```

### Pattern 匹配规则

```typescript
function matchPattern(pattern: string, approved: Set<string>): boolean {
  // 精确匹配
  if (approved.has(pattern)) return true

  // 通配符匹配
  for (const approvedPattern of approved) {
    if (wildcardMatch(pattern, approvedPattern)) return true
  }

  // 父级匹配
  // tool:edit:src/components/Button.tsx 匹配 tool:edit:src/**
  const parts = pattern.split(':')
  for (let i = parts.length - 1; i >= 2; i--) {
    const parentPattern = parts.slice(0, i).join(':') + ':**'
    if (approved.has(parentPattern)) return true
  }

  return false
}
```

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: 会话级存储 vs 持久化

**当前选择**：批准列表只存储在内存中（会话级）

**代价**：
- 会话结束后批准记录丢失
- 用户需要重新批准

**理由**：
- 简化实现，YAGNI 原则
- 更安全（每次会话重新确认）
- 未来如需持久化，可扩展 ApprovalRegistry

### 约束 2: 串行处理 vs 并行处理

**当前选择**：同一会话的权限请求串行处理

**代价**：
- 多个工具同时需要确认时，处理较慢
- 用户需要逐个确认

**理由**：
- 避免多个确认框同时显示导致混淆
- 简化 UI 实现
- 更符合用户习惯

### 约束 3: 无超时 vs 有超时

**当前选择**：permission 模块不实现超时

**代价**：
- 用户不响应时会一直等待
- 可能导致进程挂起

**理由**：
- 超时控制应由上层（Agent 运行时）处理
- 不同场景可能需要不同超时策略
- 简化 permission 模块职责

### 约束 4: 事件驱动 vs 直接回调

**当前选择**：通过 Bus 发布事件

**代价**：
- 引入 Bus 依赖
- 事件流程略复杂

**理由**：
- 与 UI 层解耦
- 支持多种 UI 实现
- 符合 OpenCode 设计风格

---

## 六、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| 持久化批准 | ApprovalRegistry 可扩展存储后端 |
| 批准撤销 | 可添加 revoke() 方法 |
| 批准过期 | 可在批准记录中添加时间戳 |
| 自定义匹配规则 | PatternMatcher 可替换实现 |
| 批量批准 | 可扩展 respond() 支持批量操作 |

---

## 七、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构支持 KISS 和 YAGNI 原则
