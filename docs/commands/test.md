# commands 模块 test.md

本文档描述 `commands` 模块的测试策略与测试用例设计。

---

## 一、测试目标

### 主要验证点

1. **命令执行正确性**：每个命令能正确调用功能模块并返回预期结果
2. **参数验证**：无效参数能被正确识别并返回错误
3. **错误处理**：功能模块错误能被正确捕获并转换为 CommandResult
4. **事件发布**：命令执行后正确发布 Command.Event.Executed 事件
5. **命令注册**：所有命令正确注册到注册表

### 测试范围

| 在范围内 | 不在范围内 |
|----------|------------|
| 命令逻辑正确性 | 功能模块内部实现 |
| 参数验证 | CLI 参数解析 |
| 错误处理 | UI 渲染 |
| 事件发布 | 功能模块的 Mock 实现正确性 |

---

## 二、测试策略

### 2.1 单元测试

每个命令文件配套一个测试文件：

```
src/commands/
├── model.ts
├── model.test.ts      # model 命令单元测试
├── session.ts
├── session.test.ts    # session 命令单元测试
├── ...
```

**Mock 策略**：
- Mock 所有依赖的功能模块（Provider、Session、MCP 等）
- Mock Bus 模块以验证事件发布
- 不 Mock commands 模块内部实现

### 2.2 集成测试

验证 commands 模块与 CLI Commands 模块的协作：

```
tests/integration/
└── commands-cli.test.ts
```

**测试场景**：
- CLI Commands 正确调用 Commands.execute()
- CommandResult 正确传递给 CLI Commands
- 端到端命令执行流程

---

## 三、单元测试用例

### 3.1 Model 命令测试

```typescript
// model.test.ts

describe('model.list', () => {
  it('应返回所有可用模型列表', async () => {
    // Arrange
    const mockModels = [
      { name: 'gemini-pro', provider: 'google' },
      { name: 'gpt-4', provider: 'openai' }
    ]
    vi.mocked(Provider.listModels).mockResolvedValue(mockModels)

    // Act
    const result = await Commands.execute('model.list', {})

    // Assert
    expect(result.success).toBe(true)
    expect(result.type).toBe('data')
    expect(result.data).toEqual(mockModels)
  })

  it('当 Provider 返回错误时应返回失败结果', async () => {
    vi.mocked(Provider.listModels).mockRejectedValue(new Error('API error'))

    const result = await Commands.execute('model.list', {})

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXECUTION_ERROR')
  })
})

describe('model.switch', () => {
  it('应切换到指定模型', async () => {
    vi.mocked(Provider.switchModel).mockResolvedValue(undefined)

    const result = await Commands.execute('model.switch', { name: 'gemini-pro' })

    expect(result.success).toBe(true)
    expect(Provider.switchModel).toHaveBeenCalledWith('gemini-pro')
  })

  it('当模型名为空时应返回参数错误', async () => {
    const result = await Commands.execute('model.switch', { name: '' })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_PARAMS')
  })
})
```

### 3.2 Session 命令测试

```typescript
// session.test.ts

describe('session.list', () => {
  it('应返回当前项目的会话列表', async () => {
    const mockSessions = [
      { id: 'sess_1', title: '会话1', createdAt: Date.now() },
      { id: 'sess_2', title: '会话2', createdAt: Date.now() }
    ]
    vi.mocked(Session.list).mockResolvedValue(mockSessions)

    const result = await Commands.execute('session.list', {})

    expect(result.success).toBe(true)
    expect(result.data).toEqual(mockSessions)
  })
})

describe('session.choose', () => {
  it('应切换到指定会话并发布事件', async () => {
    const mockSession = { id: 'sess_123', title: '测试会话' }
    const mockMessages = [{ id: 'msg_1', content: 'hello' }]
    vi.mocked(Session.get).mockResolvedValue(mockSession)
    vi.mocked(Message.getMessages).mockResolvedValue(mockMessages)
    const publishSpy = vi.spyOn(Bus, 'publish')

    const result = await Commands.execute('session.choose', { sessionId: 'sess_123' })

    expect(result.success).toBe(true)
    expect(result.action?.type).toBe('switch_session')
    expect(publishSpy).toHaveBeenCalledWith(
      Session.Event.Switched,
      expect.objectContaining({ sessionId: 'sess_123' })
    )
  })

  it('当会话不存在时应返回错误', async () => {
    vi.mocked(Session.get).mockResolvedValue(null)

    const result = await Commands.execute('session.choose', { sessionId: 'invalid' })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXECUTION_ERROR')
  })
})
```

### 3.3 Memory 命令测试

```typescript
// memory.test.ts

describe('memory.show', () => {
  it('应返回当前记忆内容', async () => {
    const mockMemory = {
      global: '全局记忆内容',
      project: '项目记忆内容'
    }
    vi.mocked(Memory.get).mockResolvedValue(mockMemory)

    const result = await Commands.execute('memory.show', {})

    expect(result.success).toBe(true)
    expect(result.data).toEqual(mockMemory)
  })
})

describe('memory.add', () => {
  it('应添加项目级记忆', async () => {
    vi.mocked(Memory.add).mockResolvedValue(undefined)

    const result = await Commands.execute('memory.add', {
      content: '新的记忆',
      scope: 'project'
    })

    expect(result.success).toBe(true)
    expect(Memory.add).toHaveBeenCalledWith('新的记忆', 'project')
  })

  it('应添加全局级记忆', async () => {
    vi.mocked(Memory.add).mockResolvedValue(undefined)

    const result = await Commands.execute('memory.add', {
      content: '全局记忆',
      scope: 'global'
    })

    expect(Memory.add).toHaveBeenCalledWith('全局记忆', 'global')
  })
})
```

### 3.4 事件发布测试

```typescript
// events.test.ts

describe('命令事件发布', () => {
  it('成功执行后应发布 Executed 事件', async () => {
    vi.mocked(Provider.listModels).mockResolvedValue([])
    const publishSpy = vi.spyOn(Bus, 'publish')

    await Commands.execute('model.list', {})

    expect(publishSpy).toHaveBeenCalledWith(
      Command.Event.Executed,
      expect.objectContaining({
        name: 'model.list',
        success: true
      })
    )
  })

  it('失败执行后也应发布 Executed 事件', async () => {
    vi.mocked(Provider.listModels).mockRejectedValue(new Error('fail'))
    const publishSpy = vi.spyOn(Bus, 'publish')

    await Commands.execute('model.list', {})

    expect(publishSpy).toHaveBeenCalledWith(
      Command.Event.Executed,
      expect.objectContaining({
        name: 'model.list',
        success: false
      })
    )
  })
})
```

### 3.5 命令注册表测试

```typescript
// registry.test.ts

describe('命令注册表', () => {
  it('应包含所有 V1 命令', () => {
    const commands = Commands.list()
    const names = commands.map(c => c.name)

    expect(names).toContain('model.list')
    expect(names).toContain('model.switch')
    expect(names).toContain('session.list')
    expect(names).toContain('mcp.list')
    expect(names).toContain('memory.show')
    expect(names).toContain('init')
    expect(names).toContain('help')
    expect(names).toContain('status')
  })

  it('应能通过别名查找命令', () => {
    const command = Commands.get('exit')
    const aliasCommand = Commands.get('quit')

    expect(command).toBeDefined()
    expect(aliasCommand).toBeDefined()
    expect(command?.name).toBe(aliasCommand?.name)
  })

  it('不存在的命令应返回 undefined', () => {
    const command = Commands.get('nonexistent')
    expect(command).toBeUndefined()
  })
})
```

---

## 四、集成测试用例

```typescript
// commands-cli.test.ts

describe('Commands 与 CLI Commands 集成', () => {
  it('CLI 应正确调用 Commands 并处理结果', async () => {
    // 模拟用户输入 /model list
    const mockModels = [{ name: 'gemini-pro' }]
    vi.mocked(Provider.listModels).mockResolvedValue(mockModels)

    // 通过 CLI 接口执行
    const output = await CliCommands.execute('/model list')

    // 验证输出包含模型信息
    expect(output).toContain('gemini-pro')
  })

  it('命令错误应正确传递到 CLI', async () => {
    vi.mocked(Provider.listModels).mockRejectedValue(new Error('连接失败'))

    const output = await CliCommands.execute('/model list')

    expect(output).toContain('错误')
    expect(output).toContain('连接失败')
  })
})
```

---

## 五、测试数据准备

### Mock 数据示例

```typescript
// __mocks__/testData.ts

export const mockModels = [
  { name: 'gemini-pro', provider: 'google', version: '1.0' },
  { name: 'gemini-flash', provider: 'google', version: '1.0' },
]

export const mockSessions = [
  { id: 'sess_1', title: '代码审查', projectId: 'proj_1', createdAt: 1704067200000 },
  { id: 'sess_2', title: '文档编写', projectId: 'proj_1', createdAt: 1704153600000 },
]

export const mockMcpServers = [
  { name: 'github', status: 'connected', tools: ['search', 'pr'] },
  { name: 'filesystem', status: 'connected', tools: ['read', 'write'] },
]
```

---

## 六、测试覆盖目标

| 类型 | 目标覆盖率 |
|------|------------|
| 语句覆盖 | >= 85% |
| 分支覆盖 | >= 75% |
| 函数覆盖 | 100% |

### 关键路径优先覆盖

1. 所有命令的正常执行路径
2. 参数验证失败路径
3. 功能模块错误处理路径
4. 事件发布路径

---

## 七、测试执行

```bash
# 运行 commands 模块测试
npm run test -- src/commands/

# 运行测试并生成覆盖率报告
npm run test:coverage -- src/commands/

# 运行集成测试
npm run test -- tests/integration/commands-cli.test.ts
```

---

## 八、文档自检

- [x] 测试用例覆盖 goals-duty.md 中的所有职责
- [x] 测试策略符合项目 Vitest 测试规范
- [x] Mock 策略明确，不过度 Mock
- [x] 包含正常路径和异常路径测试
- [x] 测试数据准备充分
