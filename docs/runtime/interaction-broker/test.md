# interaction-broker 模块 test.md

本文档描述 `runtime/interaction-broker` 模块的测试策略。

---

## 一、测试目标

1. 验证 request 会创建 pending interaction 并发布 requested 事件。
2. 验证 respond 会 resolve 对应 Promise、删除 pending entry 并发布 resolved 事件。
3. 验证 unknown/duplicate/invalid response 的错误处理。
4. 验证 command abort 和 abortAll 会清理 pending interactions。
5. 验证 broker 不依赖 TUI、stream-bridge 或 permission 模块。

---

## 二、测试策略

### 2.1 单元测试

覆盖：
- `request()` 生成唯一 interactionId。
- pending map 写入和删除。
- `respond()` 正确 resolve。
- `abortByCommandRun()` 只影响指定 commandRunId。
- `abortAll()` 清理全部 pending。
- `response.kind` 与 request kind 不匹配时报错。

### 2.2 集成边界测试

使用 fake event bus：
- Broker 发布 `Interaction.Event.Requested`。
- Broker 发布 `Interaction.Event.Resolved`。
- 不测试 stream-bridge ring buffer；那属于 `runtime/stream-bridge`。
- 不测试 TUI dialog；那属于 `ohbaby-cli`。

---

## 三、关键测试用例

```typescript
it('resolves pending interaction response', async () => {
  const broker = createBroker()
  const promise = broker.request(
    { kind: 'select-one', subject: 'model', options: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] },
    { commandRunId: 'cmd_1', clientInvocationId: 'inv_1' }
  )

  const pending = broker.listPending()[0]
  await broker.respond(pending.interactionId, { kind: 'accepted', choiceId: 'gpt-5.5' })

  await expect(promise).resolves.toEqual(expect.objectContaining({
    kind: 'accepted',
    choiceId: 'gpt-5.5',
  }))
})

it('aborts pending interactions by command run', async () => {
  const broker = createBroker()
  const promise = broker.request(
    { kind: 'confirm', subject: 'abort-test', prompt: 'Continue?' },
    { commandRunId: 'cmd_1', clientInvocationId: 'inv_1' }
  )

  broker.abortByCommandRun('cmd_1', 'aborted')

  await expect(promise).resolves.toEqual(expect.objectContaining({
    kind: 'cancelled',
    reason: 'aborted',
  }))
})
```

---

## 四、测试边界

| 在范围内 | 不在范围内 |
|----------|------------|
| pending registry 状态机 | TUI dialog 渲染 |
| request/respond/abort | SDK parser/resolver |
| internal Interaction.Event.* | stream-bridge replay/gap |
| response shape 校验 | permission 策略 |

---

## 五、文档自检

- [x] 覆盖 pending interaction 的核心状态迁移。
- [x] 明确 fake event bus 只用于验证内部事件。
- [x] 没有把 UI 行为纳入 broker 测试范围。
