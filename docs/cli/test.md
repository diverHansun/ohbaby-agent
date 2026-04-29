# cli 模块 test.md

本文档描述 `cli` 模块的测试策略。

---

## 一、测试目标

1. 验证 argv 解析和 run mode 判断。
2. 验证 composition root 正确创建 client 并选择 surface。
3. 验证非交互模式通过 SDK events 输出 stdout。
4. 验证 CLI 不直接调用 backend lifecycle/commands 内部模块。
5. 验证退出码和信号处理。

---

## 二、测试策略

### 2.1 单元测试

| 文件 | 覆盖 |
|------|------|
| `args.test.ts` | `--help`、`--version`、`-p`、未知参数 |
| `stdin.test.ts` | 管道输入读取 |
| `exit-codes.test.ts` | 错误到退出码映射 |
| `stdout-renderer.test.ts` | SDK event 到 stdout/stderr |

### 2.2 集成测试

使用 fake `UiBackendClient`：
- 交互模式应调用 `renderTerminalUi({ client })`。
- 非交互模式应订阅 events 后调用 `submitPrompt()`。
- 非交互模式收到 `message.part.delta` 时输出文本。
- 收到 `command.failed` 或 run failed 时返回非零退出码。

---

## 三、关键测试用例

```typescript
it('runs non-interactive prompt through UiBackendClient', async () => {
  const client = createFakeClient()
  await runCli(['ohbaby', '-p', 'hello'], { client })
  expect(client.subscribeEvents).toHaveBeenCalled()
  expect(client.submitPrompt).toHaveBeenCalledWith('hello', expect.anything())
})

it('does not import backend lifecycle in cli surface tests', () => {
  // Enforced by dependency lint rule or import boundary test.
  expectCliImportsToExclude(['lifecycle', 'commands/service', 'message'])
})
```

---

## 四、测试边界

| 在范围内 | 不在范围内 |
|----------|------------|
| argv/stdin/surface 分流 | backend command 执行 |
| stdout event sink | Ink 组件渲染 |
| exit code 映射 | provider/model 业务校验 |

---

## 五、文档自检

- [x] 测试覆盖 composition root 的关键风险。
- [x] 非交互路径验证 SDK event flow。
- [x] 不再测试 `cli/commands` parser/renderer。
