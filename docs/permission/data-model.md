# permission 模块 data-model.md

本文档定义 `permission` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: PermissionInfo（权限信息）

**定义**：PermissionInfo 是一个权限确认请求的完整描述，包含请求的上下文信息和元数据。

**边界**：
- 创建：工具调用 Permission.ask() 时创建
- 销毁：用户响应后或会话清理时销毁

**特点**：
- 每个 PermissionInfo 有唯一 ID
- 包含足够信息供 UI 显示确认框
- 不包含 resolve/reject 回调（内部管理）

### 概念 2: PermissionResponse（权限响应）

**定义**：PermissionResponse 表示用户对权限请求的响应。

**分类**：
- `once`：本次允许，不记录批准
- `always`：永久允许（会话级、Pattern 级），记录批准并启用 auto-approval
- `reject`：拒绝操作
- `suggest`：拒绝并提供替代建议

### 概念 3: Pattern（批准模式）

**定义**：Pattern 是用于匹配和记录批准的字符串模式，支持通配符。

**格式**：`<type>:<name>[:<path_pattern>]`

**示例**：
- `tool:edit` - 工具级
- `tool:edit:src/**` - 路径级
- `bash:git:push` - 命令级
- `skill:code-review` - 技能级
- `skill:*` - 所有技能

### 概念 4: PendingRequest（待处理请求）

**定义**：PendingRequest 是队列中等待处理的权限请求，包含 PermissionInfo 和 Promise 回调。

**特点**：
- 内部概念，不对外暴露
- 包含 resolve/reject 函数
- 处理完成后从队列移除

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| PermissionInfo | Entity（实体） | 有唯一标识（id），有生命周期 |
| PermissionResponse | Value Object（值对象） | 不可变，无独立身份 |
| Pattern | Value Object（值对象） | 不可变字符串，用于匹配 |
| PendingRequest | Entity（内部） | 有生命周期，但不对外暴露 |

---

## 三、Key Data Fields（关键数据字段）

### 3.1 PermissionInfo（权限信息）

```typescript
interface PermissionInfo {
  // ======== 标识 ========
  id: string                    // 格式: permission_<timestamp>_<random>
  sessionId: string             // 所属会话 ID
  messageId: string             // 关联的消息 ID
  callId: string                // 工具调用 ID

  // ======== 请求类型 ========
  type: PermissionType          // 'tool' | 'bash' | 'skill' | 'external_directory'
  name: string                  // 工具名或命令名或技能名

  // ======== 显示信息 ========
  title: string                 // 确认框标题
  metadata: Record<string, unknown>  // 额外元数据（如命令内容、文件路径）

  // ======== Pattern ========
  pattern: string               // 自动生成的批准 Pattern

  // ======== 时间 ========
  time: {
    created: number             // 创建时间戳（毫秒）
  }
}

type PermissionType = 'tool' | 'bash' | 'skill' | 'external_directory'
```

### 3.2 PermissionResponse（权限响应）

```typescript
// 用户直接响应
type UserPermissionResponse =
  | { type: 'once' }
  | { type: 'always' }
  | { type: 'reject' }
  | { type: 'suggest'; suggestion: string }

// 系统自动响应（用于 auto-approval 机制）
type SystemPermissionResponse =
  | { type: 'auto_approved'; pattern: string }

// 完整响应类型
type PermissionResponse = UserPermissionResponse | SystemPermissionResponse
```

**说明**：
- `once`：本次允许，不记录批准
- `always`：永久允许（会话级），触发 auto-approval 机制
- `reject`：拒绝操作
- `suggest`：拒绝并提供替代建议
- `auto_approved`：系统自动批准（由 always 触发），携带匹配的 pattern

### 3.3 PendingRequest（待处理请求，内部）

```typescript
interface PendingRequest {
  info: PermissionInfo
  resolve: () => void
  reject: (error: Error) => void
}
```

### 3.4 ApprovalRecord（批准记录，内部）

```typescript
// 会话级批准存储
type ApprovalStore = Map<string, Set<string>>
// Map<sessionId, Set<pattern>>

// 示例：
// {
//   'session_123': Set(['tool:edit:src/**', 'bash:git:*'])
// }
```

---

## 四、Event 类型定义

```typescript
namespace Permission.Event {
  // 权限请求更新事件（新请求或状态变化）
  interface Updated {
    type: 'permission.updated'
    info: PermissionInfo
  }

  // 权限响应事件
  interface Replied {
    type: 'permission.replied'
    sessionId: string
    permissionId: string
    callId: string
    response: PermissionResponse
  }

  // always 授权审计/协调事件
  interface SwitchModeRequested {
    type: 'permission.switch-mode-requested'
    sessionId: string
    targetMode: string          // 'edit-automatically'，供上层协调参考
    trigger: {
      callId: string
      permissionId: string
      pattern: string
    }
  }
}
```

---

## 五、Error 类型定义

```typescript
// 权限被拒绝错误
class PermissionRejectedError extends Error {
  name = 'PermissionRejectedError'

  constructor(
    public permissionId: string,
    public reason: 'user_rejected'
  ) {
    super(`Permission rejected: ${reason}`)
  }
}

// 权限被拒绝并附带建议
class PermissionRejectedWithSuggestionError extends Error {
  name = 'PermissionRejectedWithSuggestionError'

  constructor(
    public permissionId: string,
    public suggestion: string
  ) {
    super(`Permission rejected with suggestion: ${suggestion}`)
  }
}
```

---

## 六、ID 生成规则

### permissionId 生成

```typescript
function generatePermissionId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `permission_${timestamp}_${random}`
}

// 示例: permission_1703577600000_a1b2c3
```

**特点**：
- 包含时间戳，天然有序
- 包含随机部分，避免冲突
- 可读性好，便于调试

---

## 七、Lifecycle & Ownership（生命周期与归属）

### PermissionInfo 生命周期

```
创建（ask()）
    |
    +-- 生成 permissionId
    +-- 生成 pattern
    +-- 设置 time.created
    |
    v
等待中（pending）
    |
    +-- 加入队列
    +-- 等待成为当前处理项
    +-- 发布 Event.Updated
    |
    v
处理中（current）
    |
    +-- UI 显示确认框
    +-- 等待用户响应
    |
    v
完成（respond()）
    |
    +-- 发布 Event.Replied
    +-- 如果 always: 添加到批准列表 + 发布 SwitchModeRequested（审计/协调）
    +-- 如果 reject/suggest: 抛出错误
    +-- 从队列移除
    +-- 处理下一个请求
```

### 批准记录生命周期

```
创建（respond with 'always'）
    |
    +-- 添加 pattern 到 approved[sessionId]
    |
    v
使用中
    |
    +-- 新请求检查 approved 列表
    +-- 如果匹配则跳过确认
    |
    v
清理（clearSession）
    |
    +-- 会话结束时清除所有批准记录
```

### 数据归属

| 数据 | 创建者 | 管理者 | 说明 |
|------|--------|--------|------|
| PermissionInfo | PermissionManager | PermissionManager | 由 ask() 创建 |
| permissionId | PermissionManager | PermissionManager | 由 ID 生成器生成 |
| pattern | PatternMatcher | ApprovalRegistry | 由匹配器生成，注册表存储 |
| PendingRequest | RequestQueue | RequestQueue | 内部管理 |

---

## 八、数据不变性约束

| 字段 | 可变性 | 说明 |
|------|--------|------|
| PermissionInfo.id | 不可变 | 创建后永不改变 |
| PermissionInfo.sessionId | 不可变 | 创建后永不改变 |
| PermissionInfo.type | 不可变 | 创建后永不改变 |
| PermissionInfo.pattern | 不可变 | 创建后永不改变 |
| PermissionInfo.time.created | 不可变 | 记录创建时间 |
| PermissionResponse | 不可变 | 值对象 |
| approved[sessionId] | 可变 | 可添加新 pattern |

---

## 九、与其他模块的数据边界

| 数据 | permission 职责 | 其他模块职责 |
|------|-----------------|--------------|
| PermissionInfo | 创建、管理、销毁 | 工具模块提供输入参数 |
| Pattern | 生成、匹配 | 工具模块不感知 Pattern 细节 |
| 批准记录 | 存储、查询 | Session 模块触发清理 |
| 事件 | 发布 | UI 层订阅并处理 |
| 响应 | 接收并处理 | UI 层收集用户输入 |

---

## 十、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在后续接口和数据流中都有使用场景
- [x] ID 生成规则清晰且稳定
- [x] 数据生命周期和归属明确
