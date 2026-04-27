# cli 模块 test.md

本文档描述 `cli` 模块的测试策略和关键验证场景。

---

## 一、Test Scope（测试范围）

### 覆盖范围

cli 模块测试覆盖以下职责：
- 命令行参数的解析和验证
- 初始化流程的顺序和完整性
- 运行模式的判断逻辑
- 全局异常的捕获和处理
- 退出码的正确映射
- 清理函数的执行

### 不覆盖范围

以下内容不在 cli 模块测试范围内：
- UI 模块的渲染逻辑（由 ui 模块测试）
- 命令的业务逻辑（由 commands 模块测试）
- 配置的加载和验证（由 config 模块测试）
- LLM 调用和工具执行（由 lifecycle 模块测试）

---

## 二、Critical Scenarios（关键场景）

### 2.1 参数解析场景

| 场景 | 输入 | 预期结果 |
|------|------|----------|
| 无参数启动 | `ohbaby-code` | `{ help: false, version: false, prompt: undefined }` |
| 帮助参数 | `ohbaby-code -h` | `{ help: true }` |
| 版本参数 | `ohbaby-code -v` | `{ version: true }` |
| prompt 参数 | `ohbaby-code -p "测试"` | `{ prompt: "测试" }` |
| 未知参数 | `ohbaby-code --unknown` | 抛出 CliArgumentError |

### 2.2 模式判断场景

| 场景 | 条件 | 预期模式 |
|------|------|----------|
| TTY 无参数 | `stdin.isTTY=true, prompt=undefined` | 交互模式 |
| TTY 有 prompt | `stdin.isTTY=true, prompt="测试"` | 非交互模式 |
| 非 TTY | `stdin.isTTY=false` | 非交互模式 |

### 2.3 初始化顺序场景

| 场景 | 预期行为 |
|------|----------|
| 正常启动 | 按顺序执行：args → log → handlers → config → core |
| 参数解析失败 | 在 args 阶段失败，不执行后续步骤 |
| 配置加载失败 | 在 config 阶段失败，已有日志和异常处理 |

### 2.4 异常处理场景

| 场景 | 触发条件 | 预期行为 |
|------|----------|----------|
| 参数错误 | 无效参数 | 输出帮助信息，退出码 2 |
| 配置错误 | 配置文件格式错误 | 输出错误信息，退出码 3 |
| 未捕获异常 | 代码抛出异常 | 记录日志，执行清理，退出 |
| Promise 拒绝 | 未处理的 Promise 拒绝 | 同上 |

### 2.5 信号处理场景

| 场景 | 信号 | 预期行为 |
|------|------|----------|
| 用户中断 | SIGINT | 执行同步清理，退出码 130 |
| 终止信号 | SIGTERM | 执行同步清理，退出码 0 |

### 2.6 退出码场景

| 场景 | 错误类型 | 预期退出码 |
|------|----------|------------|
| 正常完成 | 无 | 0 |
| 参数错误 | CliArgumentError | 2 |
| 配置错误 | CliConfigError | 3 |
| 认证错误 | AuthError | 4 |
| 网络错误 | NetworkError | 5 |
| 用户中断 | SIGINT | 130 |
| 未知错误 | Error | 1 |

---

## 三、Integration Points（集成点测试）

### 3.1 与 utils 模块集成

| 集成点 | 验证内容 |
|--------|----------|
| Log.init() | 日志系统正确初始化 |
| Log.create() | 能创建带标签的 logger 实例 |
| registerCleanup() | 清理函数被正确注册 |
| runSyncCleanup() | 同步清理函数按序执行 |
| runExitCleanup() | 异步清理函数被执行 |
| IrisError | 错误继承关系正确 |

### 3.2 与 config 模块集成

| 集成点 | 验证内容 |
|--------|----------|
| loadConfig() | 配置正确加载并返回 Config 对象 |
| 配置文件不存在 | 使用默认配置 |
| 配置文件格式错误 | 抛出 CliConfigError |

### 3.3 与 ui 模块集成

| 集成点 | 验证内容 |
|--------|----------|
| UI.render() | 交互模式下 UI 正确启动 |
| 上下文传递 | sessionId 正确传递给 UI |

### 3.4 与 lifecycle 模块集成

| 集成点 | 验证内容 |
|--------|----------|
| Lifecycle.run() | 非交互模式下 prompt 正确执行 |
| 执行完成 | 执行完成后正常退出 |
| 执行出错 | 错误被正确处理，退出码正确 |

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**测试对象**：args.ts、error.ts、exit-codes.ts

**方法**：
- 使用 Vitest 框架
- Mock 外部依赖（process.argv、process.stdin）
- 直接调用函数验证返回值

```typescript
// args.test.ts
describe('parseArgs', () => {
  it('should parse help flag', () => {
    const args = parseArgs(['node', 'ohbaby-code', '-h'])
    expect(args.help).toBe(true)
  })

  it('should parse prompt option', () => {
    const args = parseArgs(['node', 'ohbaby-code', '-p', '测试'])
    expect(args.prompt).toBe('测试')
  })

  it('should throw on invalid option', () => {
    expect(() => parseArgs(['node', 'ohbaby-code', '--invalid']))
      .toThrow(CliArgumentError)
  })
})
```

### 4.2 集成测试

**测试对象**：bootstrap.ts、handlers.ts

**方法**：
- Mock 下层模块（config、ui、lifecycle）
- 验证调用顺序和参数传递
- 验证异常处理流程

```typescript
// bootstrap.test.ts
describe('bootstrap', () => {
  it('should initialize in correct order', async () => {
    const logInit = vi.spyOn(Log, 'init')
    const loadConfig = vi.spyOn(config, 'loadConfig')

    await bootstrap(['node', 'ohbaby-code', '-p', 'test'])

    expect(logInit).toHaveBeenCalledBefore(loadConfig)
  })

  it('should call UI.render in interactive mode', async () => {
    vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(true)
    const renderSpy = vi.spyOn(UI, 'render')

    await bootstrap(['node', 'ohbaby-code'])

    expect(renderSpy).toHaveBeenCalled()
  })
})
```

### 4.3 异常处理测试

**方法**：
- 使用 vi.spyOn 监听 process.exit
- 模拟各种异常场景
- 验证退出码正确

```typescript
// handlers.test.ts
describe('exception handlers', () => {
  it('should exit with code 2 on argument error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit')
    })

    try {
      await bootstrap(['node', 'ohbaby-code', '--invalid'])
    } catch {}

    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})
```

### 4.4 Mock 策略

| 模块 | Mock 方式 | 说明 |
|------|-----------|------|
| process.argv | vi.mock | 模拟命令行参数 |
| process.stdin.isTTY | vi.spyOn | 模拟 TTY 状态 |
| process.exit | vi.spyOn | 捕获退出调用 |
| Log | vi.mock | 避免真实日志输出 |
| config | vi.mock | 返回模拟配置 |
| ui | vi.mock | 避免真实 UI 渲染 |
| lifecycle | vi.mock | 避免真实 LLM 调用 |

---

## 五、测试文件组织

```
src/cli/
├── index.ts
├── bootstrap.ts
├── bootstrap.test.ts         # bootstrap 集成测试
├── handlers.ts
├── handlers.test.ts          # 异常处理测试
├── args.ts
├── args.test.ts              # 参数解析测试
├── error.ts
├── error.test.ts             # 错误类型测试
├── exit-codes.ts
├── exit-codes.test.ts        # 退出码映射测试
└── commands/
    └── ...                   # 见 cli/commands 模块测试
```

**测试文件命名规则**：每个 `.ts` 文件对应一个 `.test.ts` 文件，放在同一目录下。

---

## 六、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试范围与模块职责一致
- [x] Mock 策略清晰，便于实现
