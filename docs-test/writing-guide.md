# writing-guide.md

**测试代码编写规范**

本文档定义 ohbaby-agent 的 TypeScript/Vitest 测试编写规则，重点解决 mock/fake 边界、测试数据、断言和异步流测试。

---

## 一、Mock / Fake 边界

Mock 的目的不是“让测试容易写”，而是隔离不可控依赖。优先使用 typed fake/stub 表达真实接口行为，少用无约束的深层 mock。

| 测试类型 | 替换范围 | 真实部分 |
|----------|----------|----------|
| unit | 替换被测对象的直接依赖 | 被测函数/类/模块自身 |
| contract | 替换接口之下的业务层 | adapter / SDK / 协议层本身 |
| integration | 只替换外部 API、网络、计费服务等不可控依赖 | 被集成的真实组件 |
| smoke | 尽量不替换 | 真实启动/构建环境 |

### unit 测试

示例：测试 `Lifecycle` 时：

- fake `llmClient`，返回可控 AsyncIterable。
- fake `messageManager`，记录写入顺序。
- fake `toolScheduler`，返回可控工具结果。
- 不调用真实 LLM API。

### contract 测试

示例：测试 `ui-inprocess` adapter 时：

- fake backend/lifecycle。
- 真实执行 `UiBackendClient` 方法。
- 断言 SDK 消费者会收到的 `UiEvent` 结构和顺序。

### integration 测试

示例：Core Walking Skeleton：

- 真实使用 in-memory session/message store、Lifecycle、adapter。
- fake provider stream 代替真实 LLM API。
- 断言 `submitPrompt()` 后产生 session、message、status、assistant delta 等事件。

---

## 二、异步与流式测试

ohbaby-agent 大量使用 `AsyncIterable` 和 `AsyncGenerator`。测试中应显式收集事件并断言顺序。

```typescript
async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}
```

流式测试要优先断言：

- 第一条事件是否表示开始或初始状态。
- delta 是否按顺序累积。
- complete/final 事件是否只出现一次。
- abort/error 是否产生可恢复的最终状态。

---

## 三、测试数据与工厂

使用工厂函数创建领域对象，避免复制粘贴。

```typescript
function makeUiSession(overrides: Partial<UiSession> = {}): UiSession {
  return {
    id: 'session_test',
    title: 'Test Session',
    messages: [],
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    ...overrides,
  }
}
```

规则：

- 工厂默认值应接近真实结构，但值可以简化。
- 每个测试自包含，不依赖其他测试运行后的状态。
- 不使用真实生产数据。
- fake provider 的事件要尽量贴近 `ProviderStreamEvent` 真实结构。

---

## 四、断言规范

断言行为，不断言无关实现细节。

```typescript
expect(events.map((event) => event.type)).toEqual([
  'status.updated',
  'message.appended',
])
```

优先具体断言：

```typescript
expect(snapshot.activeSessionId).toBe('session_1')
expect(message.parts[0]).toEqual({ type: 'text', text: 'hello' })
```

避免模糊断言：

```typescript
expect(snapshot).toBeTruthy()
expect(events.length).toBeGreaterThan(0)
```

验证 mock 调用要克制。适合验证调用的场景：

- 验证副作用顺序，例如“先写 message，再发布 event”。
- 验证不可从返回值观察到的边界调用，例如 `abortController.abort()`。

不适合验证的场景：

- 内部私有方法调用次数。
- 可以通过最终状态验证的中间实现细节。

---

## 五、错误与取消测试

错误测试应验证结构化错误，而不是只验证抛错。

```typescript
await expect(run()).rejects.toMatchObject({
  name: 'SessionBusyError',
})
```

取消测试应覆盖：

- abort signal 传递到下游。
- 当前流式输出被保留或标记 interrupted。
- status/event 最终进入可恢复状态。

---

## 六、测试用例组织

每个 `it` 验证一个行为。测试名称应描述场景和结果：

```typescript
it('rejects a second run for the same session when strategy is reject', async () => {
  ...
})
```

多个相关行为可用 `describe` 分组：

```typescript
describe('InMemoryStreamBridge.subscribe', () => {
  it('replays retained events after lastEventId', async () => {
    ...
  })

  it('emits stream.gap when requested event is no longer retained', async () => {
    ...
  })
})
```

---

## 七、TDD 要求

生产代码变更应先写失败测试：

1. 写最小测试，表达期望行为。
2. 运行该测试，确认它因功能缺失而失败。
3. 写最小实现。
4. 重新运行测试，确认通过。
5. 再运行相关 suite，确认没有破坏邻近行为。

文档、注释、纯格式调整不要求 TDD，但涉及行为、接口、状态机、事件流的代码必须遵守。

---

## 八、禁止事项

- unit 测试调用真实 LLM API。
- 为了方便测试而给生产类增加 test-only 方法。
- mock 被测对象自己的方法。
- 使用没有类型约束的万能 `any` mock 掩盖接口错误。
- 把跨模块 integration 测试堆在一个根目录文件里，不按 domain 拆分。
- 只断言“没有抛错”，却不验证实际状态或事件。
