# ui 模块 test.md

本文档描述 `ui` 模块的测试策略。

---

## 一、测试目标

1. 验证 TUI 只依赖 `UiBackendClient`。
2. 验证 snapshot/events 能正确更新本地 store。
3. 验证 slash command hints、Tab 补全和 exact execution。
4. 验证 model/session interaction 能打开对应 selector 并回填 response。
5. 验证 command result/error 渲染。
6. 验证 in-process slash command 操作中及退出后不出现 `ui.command.*` raw JSON，Ink 保持终端输出所有权。

---

## 二、测试策略

### 2.1 Store reducer 测试

使用 SDK event fixtures：
- `snapshot.replaced`
- `runtime.updated`
- `message.part.delta`
- `command.result.delivered`
- `interaction.requested`

验证本地 store 更新。

### 2.2 Command runtime 测试

覆盖：
- `/model` 输入时显示 hints。
- `/model` Enter 提交 `model` command。
- `/model switch anthropic claude-opus-4-7` exact match 后提交。
- `/model gpt-5.5` 不推断执行。
- Tab 补全下一 segment。

### 2.3 DialogManager 测试

覆盖：
- `interaction.requested select-one:model` 打开模型选择器。
- 选择后调用 `respondInteraction()`。
- `interaction.requested select-one:session` 打开会话选择器。
- permission dialog 优先级高于普通 interaction。

### 2.4 In-process 终端集成测试

以真实 Agent composition 执行不依赖外部模型的 slash command，捕获完整 stdout/stderr 直到 dispose 和进程退出。测试必须显式使用 production 环境和隔离 HOME/cwd，断言两个 stream 都不含 `ui.command.*`；不得通过 TUI JSON 过滤器或 `NODE_ENV=test` no-op 分支获得假绿。

---

## 三、关键测试用例

```typescript
it('does not execute inferred model switch', () => {
  const runtime = createCommandRuntime(catalog)
  const result = runtime.submit('/model gpt-5.5')
  expect(result.ok).toBe(false)
  expect(client.executeCommand).not.toHaveBeenCalled()
})

it('responds to model selection interaction', async () => {
  renderTuiWithFakeClient()
  emit({ type: 'interaction.requested', interaction: modelSelectRequest })
  await chooseModel('anthropic', 'claude-opus-4-7')
  expect(client.respondInteraction).toHaveBeenCalledWith(
    modelSelectRequest.interactionId,
    expect.objectContaining({ kind: 'accepted', choiceId: expect.any(String) }),
  )
})
```

---

## 四、测试边界

| 在范围内 | 不在范围内 |
|----------|------------|
| Ink component behavior | backend command execution |
| SDK event reducer | provider/model API validation |
| Dialog response calls | stdout renderer |
| command UX | SDK parser internals |

---

## 五、文档自检

- [x] 测试聚焦 UI surface。
- [x] 不 mock backend internals，只 fake SDK client。
- [x] 覆盖 `/model` 和 `/session` 默认 selector。
