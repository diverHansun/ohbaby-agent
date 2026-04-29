# commands 模块 test.md

本文档描述 `commands` 模块的测试策略。

---

## 一、测试目标

1. 验证 catalog 构建、分类和 surface 过滤。
2. 验证 alias 唯一性和 canonical command path。
3. 验证 command execution 通过后端内部事件回流，并可由 daemon 投递为 SDK 协议事件。
4. 验证 interaction round-trip 能暂停并恢复命令。
5. 验证参数校验由 backend command 完成。

---

## 二、测试策略

### 2.1 Catalog 测试

覆盖：
- V1 内置命令全部注册。
- `/clear` 作为 `session.clear` 的 alias。
- `/quit` 可作为 `exit` alias，前提是 catalog 声明。
- alias 冲突会使 catalog 构建失败。
- `listCommands(surface)` 只返回该 surface 可见命令。

### 2.2 执行测试

使用 fake backend service、fake command event sink 和 fake InteractionBroker：
- `model.list` 调用 provider registry 并发布 data result。
- `model.switch` 校验 provider/model-id 后切换。
- `model.switch` 无参数在 TUI surface 发布 model selection interaction。
- `model.switch` 无参数在 headless surface 发布 `INVALID_ARGS`。
- `/model xxx` 不会推断执行 `model.switch`。
- handler 不直接调用 stream-bridge 或 SDK client。

### 2.3 Interaction 测试

覆盖：
- `/model` Enter 创建 `select-one:model` interaction。
- `/session` Enter 创建 `select-one:session` interaction。
- response 后 command resume 并发布最终 result。
- cancel response 后 command 失败或取消事件明确。

---

## 三、关键测试用例

```typescript
it('requires exact catalog command for execution', async () => {
  const invocation = makeInvocation({ path: ['model'], rawArgs: 'gpt-5.5' })
  await service.invoke(invocation, makeCommandContext())
  expect(events).toContainEqual(expect.objectContaining({
    type: 'command.failed',
    error: expect.objectContaining({ code: 'INVALID_ARGS' }),
  }))
})

it('opens model selection for /model on tui surface', async () => {
  const invocation = makeInvocation({ commandId: 'model', surface: 'tui' })
  await service.invoke(invocation, makeCommandContext())
  expect(interactionBroker.requests).toContainEqual(expect.objectContaining({
    kind: 'select-one',
    subject: 'model',
  }))
})
```

---

## 四、测试边界

| 在范围内 | 不在范围内 |
|----------|------------|
| catalog/version/alias | SDK parser 词法实现 |
| backend 参数校验 | TUI picker 渲染 |
| Commands.Event.* 发布 | provider API 真实请求 |
| interaction resume | UI keyboard 行为 |
| daemon command-events 投递映射 | stream-bridge ring buffer 细节 |

---

## 五、文档自检

- [x] 测试覆盖事件流而非同步 CommandResult。
- [x] 明确覆盖 `/model`、`/session` 默认 interaction。
- [x] 删除旧的智能推断测试要求。
