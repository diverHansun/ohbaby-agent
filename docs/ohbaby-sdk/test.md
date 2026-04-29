# ohbaby-sdk 模块 test.md

本文档描述 `ohbaby-sdk` 模块的测试策略。

---

## 一、测试目标

1. 验证 DTO 类型能覆盖 UI/backend 协议。
2. 验证 slash parser 对 raw、argv、多行输入的处理稳定。
3. 验证 resolver 只执行 exact catalog match，不做智能执行推断。
4. 验证 alias 只来自 catalog，且能解析为 canonical command。
5. 验证事件命名空间保持一致。

---

## 二、测试策略

### 2.1 Parser 单元测试

覆盖：
- 非 slash 输入返回 null。
- `/model` 解析为 path candidate。
- `/model switch anthropic claude-opus-4-7` 保留 rawArgs 并生成 argv。
- 多行命令只用首行解析命令，其余保留为 body。
- quote 参数正确切分。

### 2.2 Resolver 单元测试

覆盖：
- `/model switch ...` 匹配 `model.switch`。
- `/model xxx` 不推断为 `model.switch`。
- `/quit` 只有在 catalog 声明 alias 时解析为 `exit`。
- alias 歧义由 catalog 构建阶段阻止，resolver 不选择随机结果。
- partial input 只用于补全，不用于执行。

### 2.3 Event 类型测试

覆盖：
- `command.started`、`command.result.delivered`、`interaction.requested` 等事件 payload 类型。
- 每个事件都带有必要 correlation id。

---

## 三、关键测试用例

```typescript
it('does not infer model.switch from /model <model>', () => {
  const parsed = parseSlashInput('/model gpt-5.5')
  const result = resolveCommand(catalog, parsed)
  expect(result.ok).toBe(false)
  expect(result.error.code).toBe('COMMAND_NOT_FOUND')
})

it('resolves command aliases from catalog only', () => {
  const parsed = parseSlashInput('/quit')
  const result = resolveCommand(catalogWithQuitAlias, parsed)
  expect(result.command.id).toBe('exit')
  expect(result.usedAlias).toEqual(['quit'])
})
```

---

## 四、测试边界

| 在范围内 | 不在范围内 |
|----------|------------|
| parser/resolver 纯函数 | backend command 执行 |
| DTO/event 类型 | Ink UI 渲染 |
| catalog 匹配规则 | provider/model 业务校验 |

---

## 五、文档自检

- [x] 测试覆盖 SDK 的真实职责。
- [x] 不测试 backend 或 UI 行为。
- [x] 明确覆盖 exact match 与 alias 规则。
