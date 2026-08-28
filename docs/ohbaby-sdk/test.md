# ohbaby-sdk 模块 test.md

本文档描述 `ohbaby-sdk` 模块的测试策略。

---

## 一、测试目标

1. 验证 DTO 类型能覆盖 UI/backend 协议。
2. 验证 slash parser 对 raw、argv、多行输入的处理稳定。
3. 验证 resolver 只执行 exact catalog match，不做智能执行推断。
4. 验证 alias 只来自 catalog，且能解析为 canonical command。
5. 验证事件命名空间保持一致。
6. 验证 Prompt completion 只有四种严格终态，scheduler close/fault/abort 不悬空 waiter。
7. 验证 client 能力拆分、accepted + wait 唯一组合和 fake-RPC signal 的 out-of-band 传递。
8. 验证 command record 的 operationId、phase、correlation、脱敏和 fail-open 语义。
9. 验证默认 Agent/Server composition 不把 command observation 写入 stdout/stderr，且该策略不依赖 `NODE_ENV`。

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

### 2.4 Prompt 合同与 driver 集成测试

按共享 mapper/scheduler 与各 driver 关键路径分层覆盖 in-process、persistent 和 remote：接单回执立即返回；四种业务终态在共享管线中 resolve，各 driver 验证其关键终态与传输路径；存储/传输/等待中止 reject；关闭或 fault 后既有和新增 waiter 都不会悬空。

### 2.5 Command record 对抗测试

覆盖 returned/threw、recorder 同步失败、慢 sink、clock/ID/details/diagnostic 自身抛错；断言正文、apiKey、token、env 值、stack 和响应正文不会进入 record。Agent host、Server REST、Server RPC 各记录一次，`submitPromptAndWait` 与 skill 内部接单不重复记录。structured recorder 缺 sink 必须在构造期失败，未注入 diagnostic 时 sink 失败保持静默；默认 composition 还需通过显式 `NODE_ENV=production` 的子进程捕获 stdout/stderr，并覆盖 dispose 后的 late output。

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
| command record 纯合同和脱敏 | 生产日志平台的持久化保证 |
| catalog 匹配规则 | provider/model 业务校验 |

---

## 五、文档自检

- [x] 测试覆盖 SDK 的真实职责。
- [x] 不测试 backend 或 UI 行为。
- [x] 明确覆盖 exact match 与 alias 规则。
