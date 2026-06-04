# bus 模块 test.md

> Legacy note: this document predates the Phase 2 cleanup. Examples that import or mock a global `Bus` singleton are historical only; current code should use `createBus()` and pass a `BusInstance` explicitly.

本文档描述 `bus` 模块的测试策略与验证重点。测试围绕职责，而不是代码结构。

---

## 一、Test Scope（测试范围）

### 覆盖的职责

| 职责 | 对应测试 |
|------|----------|
| D1: 事件定义工厂 | BusEvent.define() 返回正确结构 |
| D2: 订阅者注册 | subscribe() 正确注册回调 |
| D3: 事件分发 | publish() 正确调用所有订阅者 |
| D4: 取消订阅 | 返回的函数能正确移除订阅 |
| D5: 错误隔离 | 单个订阅者异常不影响其他 |

### 不在测试范围

| 项目 | 说明 |
|------|------|
| 业务事件定义 | 由各业务模块自测 |
| 订阅者业务逻辑 | 由订阅方模块自测 |
| 事件 payload 内容 | 运行时由 Zod 验证（如启用） |
| 性能测试 | 事件量小，无性能需求 |

---

## 二、Critical Scenarios（关键场景）

### 2.1 基本发布/订阅

**场景描述**：单个订阅者接收单个事件

**前置条件**：
- 已定义事件类型
- 已注册一个订阅者

**操作**：
- 发布事件

**预期结果**：
- 订阅者回调被调用
- 回调收到正确的 payload

**验证方式**：单元测试，mock 回调函数

---

### 2.2 多订阅者场景

**场景描述**：多个订阅者接收同一事件

**前置条件**：
- 已定义事件类型
- 已注册多个订阅者（2-3 个）

**操作**：
- 发布事件

**预期结果**：
- 所有订阅者回调都被调用
- 每个回调收到相同的 payload

**验证方式**：单元测试，验证所有 mock 被调用

---

### 2.3 取消订阅

**场景描述**：订阅者取消后不再接收事件

**前置条件**：
- 已注册订阅者
- 已获得取消函数

**操作**：
1. 发布事件 A（应收到）
2. 调用取消函数
3. 发布事件 B（不应收到）

**预期结果**：
- 事件 A 被接收
- 事件 B 不被接收

**验证方式**：单元测试，验证回调调用次数

---

### 2.4 错误隔离

**场景描述**：一个订阅者抛出异常，其他订阅者仍正常执行

**前置条件**：
- 已注册多个订阅者
- 其中一个订阅者会抛出异常

**操作**：
- 发布事件

**预期结果**：
- 抛出异常的订阅者异常被捕获
- 其他订阅者正常接收事件
- 发布者不受影响，publish() 正常返回

**验证方式**：单元测试，验证非异常订阅者被调用

---

### 2.5 无订阅者场景

**场景描述**：没有订阅者时发布事件

**前置条件**：
- 事件类型已定义
- 无订阅者

**操作**：
- 发布事件

**预期结果**：
- publish() 正常返回，无异常
- 无副作用

**验证方式**：单元测试

---

### 2.6 事件定义类型安全

**场景描述**：类型系统正确推断 payload 类型

**验证内容**：
- `Bus.publish(Event, payload)` 的 payload 类型与 Event.schema 匹配
- `Bus.subscribe(Event, callback)` 的 callback 参数类型正确

**验证方式**：TypeScript 编译检查（类型测试文件），无需运行时测试

---

## 三、Integration Points（集成点测试）

Bus 模块作为基础设施，需要与多个业务模块集成。

### 3.1 与 Message 模块集成

**集成场景**：Message 更新后发布事件

**验证重点**：
- Message.updateMessage() 调用后，事件被发布
- 订阅者能收到正确的消息信息

**验证方式**：
- Message 模块集成测试
- 或 Bus 侧验证接收到的事件格式

---

### 3.2 与 Permission 模块集成

**集成场景**：权限请求流程的事件通信

**验证重点**：
- Permission.ask() 发布 Updated 事件
- 订阅者调用 Permission.respond() 后，Replied 事件发布

**验证方式**：
- Permission 模块集成测试
- 验证完整的请求-响应流程

---

### 3.3 与 Policy 模块集成

**集成场景**：Policy 订阅 Permission 的模式切换请求

**验证重点**：
- Permission 发布 SwitchModeRequested 事件
- Policy 的订阅者被调用
- Policy 状态正确更新

**验证方式**：
- Policy 模块集成测试
- 验证跨模块事件传递

---

### 3.4 与 UI 层集成

**集成场景**：UI 订阅事件并更新显示

**验证重点**：
- UI 组件能正确订阅和取消订阅
- 事件触发后 UI 正确更新

**验证方式**：
- UI 组件测试（如使用 ink-testing-library）
- 验证订阅生命周期管理

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**测试文件**：`src/bus/__tests__/bus.test.ts`

**测试框架**：Vitest

**测试内容**：
```typescript
describe('BusEvent', () => {
  describe('define()', () => {
    it('should return event definition with type and schema')
    it('should preserve schema for type inference')
  })
})

describe('Bus', () => {
  describe('subscribe()', () => {
    it('should register callback for event type')
    it('should return unsubscribe function')
    it('should support multiple subscribers for same event')
  })

  describe('publish()', () => {
    it('should call all registered callbacks')
    it('should pass payload to callbacks')
    it('should not throw when no subscribers exist')
    it('should isolate errors from individual subscribers')
  })

  describe('unsubscribe', () => {
    it('should remove callback from subscribers')
    it('should not call removed callback on subsequent publish')
    it('should handle unsubscribe called multiple times')
  })
})
```

### 4.2 类型测试

**测试内容**：验证 TypeScript 类型推断正确

**验证方式**：
- 创建 `bus.test-types.ts` 文件
- 使用 `@ts-expect-error` 注释验证类型错误被捕获

```typescript
// bus.test-types.ts
import { Bus, BusEvent } from './index'

const TestEvent = BusEvent.define('test', z.object({ value: z.number() }))

// 正确用法 - 应编译通过
Bus.publish(TestEvent, { value: 42 })
Bus.subscribe(TestEvent, (payload) => {
  const v: number = payload.value // 类型正确推断
})

// 错误用法 - 应编译失败
// @ts-expect-error - payload 类型错误
Bus.publish(TestEvent, { value: 'string' })

// @ts-expect-error - 缺少必要字段
Bus.publish(TestEvent, {})
```

### 4.3 Mock 策略

**模拟外部依赖**：
- Bus 模块无外部依赖，无需 mock

**被测试模块 mock Bus**：
- 其他模块测试时可 mock `Bus.publish` 验证事件发布
- 可 mock `Bus.subscribe` 返回固定的取消函数

```typescript
// 其他模块测试中 mock Bus
vi.mock('@/bus', () => ({
  Bus: {
    publish: vi.fn(),
    subscribe: vi.fn(() => vi.fn()), // 返回 mock 取消函数
  }
}))
```

### 4.4 测试隔离

**每个测试前**：
- 清空所有订阅者（如提供 reset 方法）
- 或使用工厂函数创建独立的 Bus 实例

**建议**：
- 考虑提供内部的 `_reset()` 方法用于测试
- 或在测试中手动取消所有订阅

---

## 五、Edge Cases（边界情况）

### 5.1 功能边界

| 边界情况 | 预期行为 |
|----------|----------|
| 同一回调注册多次 | 每次发布时被调用多次 |
| 取消函数调用多次 | 第二次调用无副作用 |
| 发布时 payload 为 null/undefined | 如果 schema 允许则通过 |
| 订阅者中再次发布同一事件 | 正常发布，注意避免无限递归 |
| 订阅者中再次订阅 | 正常订阅，但可能错过当前事件 |
| 订阅者中取消自己的订阅 | 正常取消，当前事件处理完成后生效 |

### 5.2 性能边界

虽然假设事件量小，但应验证在极端场景下的行为：

| 边界情况 | 预期行为 | 验证方式 |
|----------|----------|----------|
| 1000 个订阅者同时订阅同一事件 | 正常工作，无性能问题 | 单元测试，验证执行时间 < 100ms |
| 快速连续发布 10000 个事件 | 正常工作，无内存泄漏 | 单元测试，监控内存使用 |
| 订阅者中递归发布同一事件 | 防止堆栈溢出（最多递归 100 层） | 单元测试，验证深度限制 |
| 100 个不同事件类型，各 10 个订阅者 | 正常工作，查找性能良好 | 压力测试，验证分发延迟 |

**递归深度限制实现建议**：

```typescript
// 在 publish 中增加递归深度检查
const publishDepth = new Map<string, number>()

export function publish<T extends BusEvent.Definition>(
  event: T,
  payload: BusEvent.PayloadOf<T>
): void {
  const depth = (publishDepth.get(event.type) ?? 0) + 1

  if (depth > 100) {
    Log.error('Bus: maximum recursion depth exceeded', {
      eventType: event.type,
      depth
    })
    return  // 防止堆栈溢出
  }

  publishDepth.set(event.type, depth)
  try {
    // 正常分发逻辑
  } finally {
    publishDepth.set(event.type, depth - 1)
  }
}
```

**性能测试示例**：

```typescript
describe('Bus performance', () => {
  it('should handle 1000 subscribers without performance degradation', () => {
    const event = BusEvent.define('perf.test', z.object({ value: z.number() }))
    const callbacks = Array.from({ length: 1000 }, () => vi.fn())

    callbacks.forEach(cb => Bus.subscribe(event, cb))

    const start = performance.now()
    Bus.publish(event, { value: 42 })
    const duration = performance.now() - start

    expect(duration).toBeLessThan(100)  // 应少于 100ms
    callbacks.forEach(cb => expect(cb).toHaveBeenCalledOnce())
  })

  it('should not leak memory with 10000 events', () => {
    const event = BusEvent.define('mem.test', z.object({ data: z.string() }))
    Bus.subscribe(event, () => {})

    const initialMem = process.memoryUsage().heapUsed

    for (let i = 0; i < 10000; i++) {
      Bus.publish(event, { data: `event-${i}` })
    }

    global.gc?.()  // 手动 GC（需要 --expose-gc）
    const finalMem = process.memoryUsage().heapUsed
    const memIncrease = finalMem - initialMem

    expect(memIncrease).toBeLessThan(5 * 1024 * 1024)  // 增长应小于 5MB
  })
})

---

## 六、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 集成点覆盖了主要的业务模块
- [x] 验证策略可操作，包含具体的测试框架和方法
- [x] 性能边界测试覆盖极端场景（大量订阅者、递归深度）
- [x] 包含内存泄漏验证策略
