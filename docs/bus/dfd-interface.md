# bus 模块 dfd-interface.md

> Legacy note: this document predates the Phase 2 cleanup. Examples that import or subscribe through a global `Bus` singleton are historical only; current production code should use `createBus()`/DI plus explicit app-event projectors.

本文档描述 `bus` 模块的数据流与对外接口。数据流优先，接口从属于数据流。

---

## 一、Context and Scope（上下文与范围）

### 模块位置

bus 模块位于 ohbaby-agent 架构的基础设施层，作为模块间通信的桥梁：

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI / UI 层（订阅者）                                            │
└────────────────────────────────────────────────────────────────┬┘
                                                                  │
┌────────────────────────────────────────────────────────────────┐│
│  业务模块层                                                     ││
│                                                                 ││
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐   ││
│  │ Permission│  │   Policy  │  │  Message  │  │  Session  │   ││
│  │ (发布)    │  │(发布/订阅)│  │  (发布)   │  │  (发布)   │   ││
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘   ││
│        │              │              │              │          ││
│        └──────────────┴──────────────┴──────────────┴──────────┘│
│                               │                                 │
│                               ▼                                 │
│                      ┌─────────────────┐                        │
│                      │       Bus       │◄───────────────────────┘
│                      │  (发布/订阅)    │
│                      └─────────────────┘
│
└─────────────────────────────────────────────────────────────────┘
```

### 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| Message | 输入（发布） | 发布消息更新事件 |
| Permission | 输入（发布） | 发布权限请求和响应事件 |
| Policy | 双向 | 发布模式变化事件，订阅 Permission 的切换请求 |
| CLI/UI | 输出（订阅） | 订阅事件以实时更新显示 |
| Session | 输入（发布） | 发布会话创建、切换事件（见 `docs/services/session/dfd-interface.md`） |
| Commands | 输入（发布） | 发布命令执行事件（见 `docs/commands/dfd-interface.md`） |

### 本文档范围

- 描述数据如何进入 Bus 模块（发布）
- 描述数据如何从 Bus 模块输出（分发给订阅者）
- 定义模块的对外接口
- 明确与各业务模块的协作关系

---

## 二、Data Flow Description（数据流描述）

### 主数据流 1：事件发布

```
1. [外部] 业务模块触发状态变化
   └── 例如：Permission 有新的权限请求

2. [业务模块] 构建事件 payload
   ├── 创建符合 Zod Schema 的 payload 对象
   └── 例如：{ info: permissionInfo }

3. [业务模块 -> Bus] 发布事件
   ├── 调用 Bus.publish(Permission.Event.Updated, payload)
   └── 传入事件定义和 payload

4. [Bus 内部] 查找订阅者
   ├── 根据事件类型字符串查找 subscriptions Map
   └── 获取该事件类型的所有回调函数

5. [Bus 内部] 分发事件
   ├── 遍历所有回调函数
   ├── 依次调用：callback(payload)
   ├── 捕获单个回调的异常，不中断其他回调
   └── 记录异常日志（如有）

6. [Bus] 返回
   └── publish() 返回 void，同步完成
```

### 主数据流 2：事件订阅

```
1. [外部] 模块需要监听某类事件
   └── 例如：UI 层需要监听权限请求

2. [外部 -> Bus] 注册订阅
   ├── 调用 Bus.subscribe(Permission.Event.Updated, callback)
   └── 传入事件定义和回调函数

3. [Bus 内部] 记录订阅
   ├── 获取事件类型字符串：event.type
   ├── 在 subscriptions Map 中添加回调
   └── subscriptions.get(type).add(callback)

4. [Bus] 返回取消函数
   └── 返回 () => { subscriptions.get(type).delete(callback) }
```

### 主数据流 3：取消订阅

```
1. [外部] 模块不再需要监听事件
   └── 例如：UI 组件卸载

2. [外部] 调用取消函数
   ├── 之前 subscribe() 返回的函数
   └── unsubscribe()

3. [Bus 内部] 移除订阅
   ├── 从 subscriptions Map 中删除回调
   └── subscriptions.get(type).delete(callback)
```

### 典型场景：权限请求流程

```
Permission                   Bus                      UI 层
    │                          │                         │
    │  1. 用户发起敏感操作      │                         │
    │                          │                         │
    │  2. publish(Updated, info)                         │
    │─────────────────────────>│                         │
    │                          │                         │
    │                    3. 查找订阅者                    │
    │                    4. 调用 UI 的 callback           │
    │                          │────────────────────────>│
    │                          │                         │
    │                          │  5. UI 显示确认框       │
    │                          │                         │
    │                          │  6. 用户响应            │
    │                          │                         │
    │                          │  7. 调用 Permission.respond()
    │<─────────────────────────────────────────────────────
    │                          │                         │
    │  8. publish(Replied, response)                     │
    │─────────────────────────>│                         │
    │                          │────────────────────────>│
    │                          │                         │
    │                          │  9. UI 关闭确认框       │
```

### 典型场景：模式切换流程

```
Commands              Policy                  Bus                  UI
   │                    │                       │                   │
   │  1. 用户按 Shift+Tab                       │                   │
   │                    │                       │                   │
   │  2. cycleMode()    │                       │                   │
   │──────────────────>│                       │                   │
   │                    │                       │                   │
   │                    │  3. 更新内部状态       │                   │
   │                    │                       │                   │
   │                    │  4. publish(ModeChanged, {...})           │
   │                    │──────────────────────>│                   │
   │                    │                       │                   │
   │                    │                 5. 分发给订阅者            │
   │                    │                       │──────────────────>│
   │                    │                       │                   │
   │                    │                       │  6. 更新模式指示器 │
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外接口（公共 API）

#### BusEvent.define()

创建事件定义。

```
输入：
  - type: string - 事件类型字符串（如 "permission.updated"）
  - schema: z.ZodType - Zod Schema，定义 payload 结构

输出：
  - EventDefinition<type, schema>

说明：
  - 返回的对象包含 { type, schema }
  - 由业务模块调用，通常在模块顶层
  - 返回值应作为常量导出
```

**使用示例**：
```typescript
// permission/events.ts
export const PermissionUpdated = BusEvent.define(
  "permission.updated",
  z.object({
    info: PermissionInfoSchema
  })
)
```

---

#### Bus.publish()

发布事件。

```
输入：
  - event: EventDefinition - 事件定义
  - payload: z.infer<event.schema> - 事件数据

输出：
  - void

说明：
  - 同步调用所有匹配的订阅者
  - 单个订阅者异常不影响其他订阅者
  - payload 必须符合事件定义的 schema
```

**使用示例**：
```typescript
// permission/manager.ts
Bus.publish(Permission.Event.Updated, {
  info: permissionInfo
})
```

---

#### Bus.subscribe()

订阅事件。

```
输入：
  - event: EventDefinition - 事件定义
  - callback: (payload) => void - 回调函数

输出：
  - () => void - 取消订阅函数

说明：
  - 回调函数在事件发布时被调用
  - 返回的函数用于取消订阅
  - 同一事件可有多个订阅者
  - 同一回调可多次订阅（不推荐）
```

**使用示例**：
```typescript
// ui/permission-dialog.ts
const unsubscribe = Bus.subscribe(
  Permission.Event.Updated,
  (payload) => {
    showConfirmDialog(payload.info)
  }
)

// 组件卸载时
unsubscribe()
```

---

### 3.2 类型导出

```
BusEvent.Definition<T, S>
  - 事件定义的类型
  - T: 事件类型字符串
  - S: Zod Schema

BusEvent.PayloadOf<D>
  - 从事件定义提取 payload 类型
  - D: 事件定义
```

---

## 四、Data Ownership and Responsibility（数据归属与责任）

### 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| 事件定义 | 业务模块 | 使用 BusEvent.define() 创建 |
| 事件 payload | 业务模块 | 发布时构建 |
| 订阅记录 | Bus | subscribe() 调用时创建 |
| 取消函数 | Bus | subscribe() 返回值 |

### 数据更新责任

| 数据 | 更新者 | 说明 |
|------|--------|------|
| subscriptions Map | Bus | 订阅/取消时更新 |
| 事件 payload | 无 | 发布后不可变 |

### 数据销毁责任

| 数据 | 销毁者 | 时机 |
|------|--------|------|
| 订阅记录 | Bus | 取消订阅时移除 |
| 事件 payload | GC | 所有订阅者处理完成后 |

### 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 定义事件类型 | 业务模块 | Bus |
| 构建事件 payload | 业务模块 | Bus |
| 分发事件 | Bus | 业务模块 |
| 处理事件 | 订阅者模块 | Bus |
| 管理订阅生命周期 | 调用方 | Bus |

---

## 五、接口使用示例（概念说明）

### 业务模块定义和发布事件

```typescript
// permission/index.ts

import { BusEvent } from '@/bus/bus-event'
import { Bus } from '@/bus'
import z from 'zod'

// 1. 定义事件（模块顶层）
export namespace Permission {
  export const Info = z.object({
    id: z.string(),
    sessionId: z.string(),
    type: z.string(),
    title: z.string(),
  })

  export const Event = {
    Updated: BusEvent.define("permission.updated", z.object({
      info: Info
    })),
    Replied: BusEvent.define("permission.replied", z.object({
      sessionId: z.string(),
      permissionId: z.string(),
      response: z.enum(['once', 'always', 'reject', 'suggest'])
    }))
  }
}

// 2. 发布事件（业务逻辑中）
function notifyPermissionRequest(info: Permission.Info) {
  Bus.publish(Permission.Event.Updated, { info })
}
```

### UI 层订阅事件

```typescript
// ui/permission-dialog.ts

import { Bus } from '@/bus'
import { Permission } from '@/permission'

// 初始化时订阅
const unsubUpdated = Bus.subscribe(Permission.Event.Updated, (payload) => {
  // 显示确认对话框
  showDialog({
    title: payload.info.title,
    onConfirm: () => Permission.respond(payload.info.id, 'once'),
    onReject: () => Permission.respond(payload.info.id, 'reject')
  })
})

const unsubReplied = Bus.subscribe(Permission.Event.Replied, (payload) => {
  // 关闭对话框
  closeDialog(payload.permissionId)
})

// 清理时取消订阅
function cleanup() {
  unsubUpdated()
  unsubReplied()
}
```

### Policy 模块订阅和发布

```typescript
// policy/index.ts

import { BusEvent } from '@/bus/bus-event'
import { Bus } from '@/bus'
import { Permission } from '@/permission'

// 定义自己的事件
export namespace Policy {
  export const Event = {
    ModeChanged: BusEvent.define("policy.mode-changed", z.object({
      previousMode: z.enum(['ask', 'plan', 'agent']),
      currentMode: z.enum(['ask', 'plan', 'agent'])
    }))
  }
}

// 订阅 Permission 的模式切换请求
Bus.subscribe(Permission.Event.SwitchModeRequested, (payload) => {
  if (payload.targetMode === 'edit-automatically') {
    setAgentState('edit-automatically')
  }
})

// 发布模式变化事件
function setMode(newMode: Mode) {
  const previousMode = currentMode
  currentMode = newMode
  
  Bus.publish(Policy.Event.ModeChanged, {
    previousMode,
    currentMode: newMode
  })
}
```

### 异步处理最佳实践

由于 Bus 采用同步分发，订阅者的执行时间会阻塞发布者和其他订阅者。对于长时间操作，应使用异步化策略：

#### 不推荐：同步执行长时间操作

```typescript
// 错误示例：同步执行异步操作
Bus.subscribe(Message.Event.Updated, async (payload) => {
  // 这个 await 会阻塞发布者和其他订阅者
  await longRunningTask(payload)
  await updateDatabase(payload)
})
```

**问题**：
- 发布者需要等待所有订阅者完成才能继续
- 后续订阅者被前面的异步操作阻塞
- 违反了"订阅者执行应尽可能短"的原则

#### 推荐方式 1：使用 queueMicrotask

```typescript
// 正确示例：使用 queueMicrotask 异步化
Bus.subscribe(Message.Event.Updated, (payload) => {
  queueMicrotask(async () => {
    try {
      await longRunningTask(payload)
      await updateDatabase(payload)
    } catch (error) {
      Log.error('async task failed', { error })
    }
  })
  // 立即返回，不阻塞
})
```

**优点**：
- 发布者立即返回，不被阻塞
- 使用微任务队列，在当前事件循环后执行
- 保持事件处理的异步性

#### 推荐方式 2：使用 setTimeout

```typescript
// 正确示例：使用 setTimeout 异步化
Bus.subscribe(Message.Event.Updated, (payload) => {
  setTimeout(async () => {
    try {
      await longRunningTask(payload)
    } catch (error) {
      Log.error('async task failed', { error })
    }
  }, 0)
  // 立即返回
})
```

**优点**：
- 完全不阻塞发布者
- 适合非紧急的后台任务

#### 推荐方式 3：立即触发，异步等待

```typescript
// 正确示例：触发异步任务但不等待
Bus.subscribe(Message.Event.Updated, (payload) => {
  // 触发异步任务但不等待（fire-and-forget）
  void processMessageAsync(payload)
  // 立即返回
})

async function processMessageAsync(payload: MessagePayload) {
  try {
    await longRunningTask(payload)
  } catch (error) {
    Log.error('async processing failed', { error })
  }
}
```

**优点**：
- 代码清晰，职责分离
- 使用 `void` 明确表示不等待结果
- 错误处理在异步函数内部

#### 何时可以使用同步操作

仅当满足以下所有条件时，可以直接在订阅者中执行同步操作：

1. **执行时间短**：操作耗时少于 10ms
2. **无 I/O 操作**：不涉及文件、网络、数据库
3. **无复杂计算**：不包含循环、递归等
4. **不抛异常**：或已正确处理异常

**同步操作示例**：

```typescript
// 可接受的同步订阅者
Bus.subscribe(Policy.Event.ModeChanged, (payload) => {
  // 简单的状态更新
  currentModeIndicator = payload.currentMode

  // 简单的日志记录
  Log.info('mode changed', { mode: payload.currentMode })
})
```

---

## 六、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义关注语义，未绑定具体实现
- [x] 典型场景示例涵盖主要使用方式
- [x] 与业务模块的协作方式明确
