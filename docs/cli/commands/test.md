# cli/commands 模块 test.md

本文档描述 `cli/commands` 模块的测试策略与测试用例设计。

---

## 一、测试目标

### 主要验证点

1. **命令解析正确性**：各种格式的 Slash Command 能被正确解析
2. **参数验证**：无效参数能被正确识别并返回友好错误
3. **Commands 调用**：正确调用 commands 模块并传递参数
4. **结果渲染**：各类型 CommandResult 能被正确渲染
5. **交互式流程**：交互式选择能正确工作
6. **自动补全**：补全建议正确生成

### 测试范围

| 在范围内 | 不在范围内 |
|----------|------------|
| 命令解析逻辑 | commands 模块的业务逻辑 |
| 参数验证 | UI Layer 的实现 |
| 渲染输出格式 | 终端颜色兼容性 |
| 交互式组件行为 | 真实用户交互 |

---

## 二、测试策略

### 2.1 单元测试

```
src/cli/commands/
├── parser.ts
├── parser.test.ts          # 解析器测试
├── executor.ts
├── executor.test.ts        # 执行器测试
├── renderer.ts
├── renderer.test.ts        # 渲染器测试
├── formatters/
│   ├── table.ts
│   ├── table.test.ts       # 表格格式化测试
│   └── ...
└── slash-commands/
    ├── model.ts
    ├── model.test.ts       # 模型命令配置测试
    └── ...
```

**Mock 策略**：
- Mock `commands` 模块以隔离业务逻辑
- Mock 交互式组件以实现自动化测试
- 不 Mock 内部模块（Parser、Renderer）

### 2.2 集成测试

验证 cli/commands 模块与 commands 模块的端到端协作：

```
tests/integration/
└── cli-commands-e2e.test.ts
```

### 2.3 快照测试

渲染输出使用快照测试确保一致性：

```typescript
it('应正确渲染模型列表', () => {
  const output = renderer.render(mockModelListResult)
  expect(output).toMatchSnapshot()
})
```

---

## 三、单元测试用例

### 3.1 Parser 测试

```typescript
// parser.test.ts

describe('Parser', () => {
  describe('基本解析', () => {
    it('应解析简单命令', () => {
      const result = parser.parse('/help')
      expect(result).toEqual({
        command: 'help',
        params: {},
        raw: '/help'
      })
    })

    it('应解析带子命令的命令', () => {
      const result = parser.parse('/model list')
      expect(result).toEqual({
        command: 'model.list',
        params: {},
        raw: '/model list'
      })
    })

    it('应解析带位置参数的命令', () => {
      const result = parser.parse('/model switch gemini-pro')
      expect(result).toEqual({
        command: 'model.switch',
        params: { name: 'gemini-pro' },
        raw: '/model switch gemini-pro'
      })
    })

    it('应解析带选项参数的命令', () => {
      const result = parser.parse('/memory add --global')
      expect(result).toEqual({
        command: 'memory.add',
        params: { scope: 'global' },
        raw: '/memory add --global'
      })
    })
  })

  describe('别名处理', () => {
    it('应将 /? 解析为 help', () => {
      const result = parser.parse('/?')
      expect(result.command).toBe('help')
    })

    it('应将 /quit 解析为 exit', () => {
      const result = parser.parse('/quit')
      expect(result.command).toBe('exit')
    })
  })

  describe('错误处理', () => {
    it('未知命令应返回解析错误', () => {
      const result = parser.parse('/unknown')
      expect(result.error).toBeDefined()
      expect(result.error.type).toBe('UNKNOWN_COMMAND')
    })

    it('非 slash 输入应返回 null', () => {
      const result = parser.parse('hello world')
      expect(result).toBeNull()
    })
  })

  describe('智能推断', () => {
    it('应将 /model gemini-pro 推断为 model.switch', () => {
      const result = parser.parse('/model gemini-pro')
      expect(result.command).toBe('model.switch')
      expect(result.params.name).toBe('gemini-pro')
    })
  })
})
```

### 3.2 Executor 测试

```typescript
// executor.test.ts

describe('Executor', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('命令执行', () => {
    it('应正确调用 Commands.execute', async () => {
      vi.mocked(Commands.execute).mockResolvedValue({
        success: true,
        type: 'message',
        message: '成功'
      })

      await executor.execute({
        command: 'model.list',
        params: {},
        raw: '/model list'
      }, mockContext)

      expect(Commands.execute).toHaveBeenCalledWith(
        'model.list',
        {},
        expect.any(Object)
      )
    })

    it('应传递解析后的参数', async () => {
      vi.mocked(Commands.execute).mockResolvedValue({
        success: true,
        type: 'message',
        message: '已切换'
      })

      await executor.execute({
        command: 'model.switch',
        params: { name: 'gemini-pro' },
        raw: '/model switch gemini-pro'
      }, mockContext)

      expect(Commands.execute).toHaveBeenCalledWith(
        'model.switch',
        { name: 'gemini-pro' },
        expect.any(Object)
      )
    })
  })

  describe('交互模式', () => {
    it('无参数时应进入交互模式', async () => {
      const mockModels = [{ name: 'gemini-pro' }]
      vi.mocked(Commands.execute).mockResolvedValueOnce({
        success: true,
        type: 'data',
        data: mockModels
      })
      vi.mocked(interactive.showSelectList).mockResolvedValue('gemini-pro')
      vi.mocked(Commands.execute).mockResolvedValueOnce({
        success: true,
        type: 'message',
        message: '已切换'
      })

      await executor.execute({
        command: 'model.switch',
        params: {},
        raw: '/model switch'
      }, mockContext)

      expect(interactive.showSelectList).toHaveBeenCalled()
    })
  })

  describe('错误处理', () => {
    it('Commands 错误应被正确传递', async () => {
      vi.mocked(Commands.execute).mockResolvedValue({
        success: false,
        type: 'message',
        error: { code: 'EXECUTION_ERROR', message: '失败' }
      })

      const result = await executor.execute({
        command: 'model.switch',
        params: { name: 'invalid' },
        raw: '/model switch invalid'
      }, mockContext)

      expect(result.success).toBe(false)
    })
  })
})
```

### 3.3 Renderer 测试

```typescript
// renderer.test.ts

describe('Renderer', () => {
  describe('data 类型渲染', () => {
    it('应将数组渲染为表格', () => {
      const result = {
        success: true,
        type: 'data' as const,
        data: [
          { name: 'gemini-pro', provider: 'google' },
          { name: 'gpt-4', provider: 'openai' }
        ]
      }

      const output = renderer.render(result, mockContext)

      expect(output).toContain('gemini-pro')
      expect(output).toContain('google')
      expect(output).toContain('gpt-4')
    })

    it('应将对象渲染为键值列表', () => {
      const result = {
        success: true,
        type: 'data' as const,
        data: { model: 'gemini-pro', status: 'connected' }
      }

      const output = renderer.render(result, mockContext)

      expect(output).toContain('model')
      expect(output).toContain('gemini-pro')
    })
  })

  describe('message 类型渲染', () => {
    it('成功消息应包含内容', () => {
      const result = {
        success: true,
        type: 'message' as const,
        message: '模型已切换到 gemini-pro'
      }

      const output = renderer.render(result, mockContext)

      expect(output).toContain('模型已切换到 gemini-pro')
    })
  })

  describe('error 渲染', () => {
    it('错误应以红色样式显示', () => {
      const result = {
        success: false,
        type: 'message' as const,
        error: { code: 'ERROR', message: '连接失败' }
      }

      const output = renderer.render(result, mockContext)

      expect(output).toContain('连接失败')
      // 验证包含 ANSI 红色代码（如果启用颜色）
    })
  })

  describe('快照测试', () => {
    it('模型列表渲染', () => {
      const output = renderer.render(mockModelListResult, mockContext)
      expect(output).toMatchSnapshot()
    })

    it('MCP 服务器列表渲染', () => {
      const output = renderer.render(mockMcpListResult, mockContext)
      expect(output).toMatchSnapshot()
    })

    it('帮助信息渲染', () => {
      const output = renderer.render(mockHelpResult, mockContext)
      expect(output).toMatchSnapshot()
    })
  })
})
```

### 3.4 Table 格式化测试

```typescript
// formatters/table.test.ts

describe('Table Formatter', () => {
  it('应正确对齐列', () => {
    const data = [
      { name: 'a', value: '123' },
      { name: 'abc', value: '1' }
    ]
    const columns = [
      { key: 'name', header: 'Name' },
      { key: 'value', header: 'Value' }
    ]

    const output = formatTable(data, columns)

    // 验证所有行的列对齐
    const lines = output.split('\n')
    const pipe1Positions = lines.map(line => line.indexOf('|', 1))
    expect(new Set(pipe1Positions).size).toBe(1) // 所有行的第一个分隔符在同一位置
  })

  it('应正确处理空数据', () => {
    const output = formatTable([], [])
    expect(output).toContain('无数据')
  })

  it('应截断过长的值', () => {
    const data = [{ name: 'a'.repeat(100) }]
    const columns = [{ key: 'name', header: 'Name', width: 20 }]

    const output = formatTable(data, columns)

    expect(output).toContain('...')
  })
})
```

### 3.5 自动补全测试

```typescript
// completions.test.ts

describe('命令自动补全', () => {
  it('应返回匹配的命令', () => {
    const completions = getSlashCommandCompletions('/mo')

    expect(completions).toContainEqual(
      expect.objectContaining({ text: '/model' })
    )
    expect(completions).toContainEqual(
      expect.objectContaining({ text: '/memory' })
    )
  })

  it('应返回子命令补全', () => {
    const completions = getSlashCommandCompletions('/model ')

    expect(completions).toContainEqual(
      expect.objectContaining({ text: '/model list' })
    )
    expect(completions).toContainEqual(
      expect.objectContaining({ text: '/model switch' })
    )
  })

  it('空输入应返回所有命令', () => {
    const completions = getSlashCommandCompletions('/')

    expect(completions.length).toBeGreaterThan(10)
  })
})
```

---

## 四、集成测试用例

```typescript
// cli-commands-e2e.test.ts

describe('CLI Commands 端到端测试', () => {
  it('完整执行 /model list', async () => {
    // 设置真实的 Provider mock
    vi.mocked(Provider.listModels).mockResolvedValue([
      { name: 'gemini-pro', provider: 'google' }
    ])

    const result = await executeSlashCommand('/model list', mockContext)

    expect(result.handled).toBe(true)
    expect(result.output).toContain('gemini-pro')
  })

  it('完整执行 /help', async () => {
    const result = await executeSlashCommand('/help', mockContext)

    expect(result.handled).toBe(true)
    expect(result.output).toContain('/model')
    expect(result.output).toContain('/session')
    expect(result.output).toContain('/mcp')
  })

  it('完整执行 /exit', async () => {
    const result = await executeSlashCommand('/exit', mockContext)

    expect(result.handled).toBe(true)
    expect(result.action?.type).toBe('exit')
  })

  it('未知命令应返回错误', async () => {
    const result = await executeSlashCommand('/unknown', mockContext)

    expect(result.handled).toBe(true)
    expect(result.output).toContain('未知命令')
  })
})
```

---

## 五、测试数据准备

```typescript
// __mocks__/testData.ts

export const mockContext: CliContext = {
  sessionId: 'sess_test',
  projectId: 'proj_test',
  terminal: {
    width: 80,
    height: 24,
    supportsColor: true
  }
}

export const mockModelListResult: CommandResult = {
  success: true,
  type: 'data',
  data: [
    { name: 'gemini-pro', provider: 'google', version: '1.0' },
    { name: 'gemini-flash', provider: 'google', version: '1.0' }
  ]
}

export const mockMcpListResult: CommandResult = {
  success: true,
  type: 'data',
  data: [
    { name: 'github', status: 'connected', tools: 5 },
    { name: 'filesystem', status: 'disconnected', tools: 0 }
  ]
}

export const mockHelpResult: CommandResult = {
  success: true,
  type: 'data',
  data: [
    { name: '/model', description: '模型管理' },
    { name: '/session', description: '会话管理' }
  ]
}
```

---

## 六、测试覆盖目标

| 类型 | 目标覆盖率 |
|------|------------|
| 语句覆盖 | >= 85% |
| 分支覆盖 | >= 80% |
| 函数覆盖 | 100% |

### 关键路径优先覆盖

1. 所有命令的解析路径
2. 各类型 CommandResult 的渲染路径
3. 错误处理路径
4. 交互式流程

---

## 七、测试执行

```bash
# 运行 cli/commands 模块测试
npm run test -- src/cli/commands/

# 运行测试并生成覆盖率报告
npm run test:coverage -- src/cli/commands/

# 更新快照
npm run test -- src/cli/commands/ --update

# 运行集成测试
npm run test -- tests/integration/cli-commands-e2e.test.ts
```

---

## 八、文档自检

- [x] 测试用例覆盖 goals-duty.md 中的所有职责
- [x] 测试策略符合项目 Vitest 测试规范
- [x] Mock 策略明确，不过度 Mock
- [x] 包含正常路径和异常路径测试
- [x] 快照测试用于渲染一致性验证
- [x] 测试数据准备充分
