# agent 模块 test.md

本文档定义 `agent` 模块的测试策略与测试用例。

---

## 一、测试策略

### 1.1 测试层次

| 层次 | 范围 | 工具 |
|------|------|------|
| 单元测试 | 单个函数/类 | Vitest |
| 集成测试 | 模块间交互 | Vitest + Mock |
| E2E 测试 | 完整流程 | Vitest + 真实依赖 |

### 1.2 测试优先级

| 优先级 | 测试内容 | 原因 |
|--------|----------|------|
| P0 | 配置加载与合并 | 核心功能，影响所有代理行为 |
| P0 | 子代理并发控制 | 资源保护，防止系统过载 |
| P1 | 系统提示词组装 | 影响 LLM 行为 |
| P1 | 子代理执行流程 | 核心功能 |
| P2 | 事件发布 | 辅助功能 |
| P2 | 配置验证 | 边界保护 |

---

## 二、单元测试

### 2.1 AgentRegistry 测试

#### 2.1.1 内置代理加载

```typescript
describe('AgentRegistry', () => {
  describe('initialize', () => {
    it('should load all builtin agents', async () => {
      const registry = new AgentRegistry()
      await registry.initialize()

      expect(registry.get('build')).toBeDefined()
      expect(registry.get('plan')).toBeDefined()
      expect(registry.get('explore')).toBeDefined()
      expect(registry.get('research')).toBeDefined()
    })

    it('should set build as default agent', async () => {
      const registry = new AgentRegistry()
      await registry.initialize()

      const build = registry.get('build')
      expect(build?.default).toBe(true)
    })
  })
})
```

#### 2.1.2 配置合并

```typescript
describe('config merge', () => {
  it('should merge project config over builtin', async () => {
    // 准备：项目配置覆盖 build 的 maxSteps
    mockProjectConfig({
      'build.json': { maxSteps: 100 }
    })

    const registry = new AgentRegistry()
    await registry.initialize()

    const build = registry.get('build')
    expect(build?.maxSteps).toBe(100)
    // 其他字段保持内置值
    expect(build?.mode).toBe('primary')
  })

  it('should deep merge tools config', async () => {
    mockProjectConfig({
      'build.json': { tools: { newTool: true } }
    })

    const registry = new AgentRegistry()
    await registry.initialize()

    const build = registry.get('build')
    expect(build?.tools['*']).toBe(true)  // 保留内置
    expect(build?.tools.newTool).toBe(true)  // 新增
  })
})
```

#### 2.1.3 配置验证

```typescript
describe('validation', () => {
  it('should reject subagent without description', async () => {
    const invalid: Partial<AgentConfig> = {
      name: 'test',
      mode: 'subagent',
      // 缺少 description
    }

    expect(() => registry.validate(invalid)).toThrow()
  })

  it('should reject invalid mode', async () => {
    const invalid = {
      name: 'test',
      mode: 'invalid' as any,
    }

    expect(() => registry.validate(invalid)).toThrow()
  })

  it('should reject subagent with task tool enabled', async () => {
    const invalid: AgentConfig = {
      name: 'test',
      mode: 'subagent',
      description: 'test',
      tools: { task: true },  // 不允许
      permission: { edit: 'deny', bash: {} }
    }

    expect(() => registry.validate(invalid)).toThrow()
  })
})
```

### 2.2 SubagentExecutor 测试

#### 2.2.1 并发控制

```typescript
describe('SubagentExecutor', () => {
  describe('concurrency control', () => {
    it('should allow up to 3 concurrent subagents', async () => {
      const executor = new SubagentExecutor(mockDeps)

      // 启动 3 个子代理（不等待完成）
      const p1 = executor.execute({ agentName: 'explore', ... })
      const p2 = executor.execute({ agentName: 'explore', ... })
      const p3 = executor.execute({ agentName: 'explore', ... })

      expect(executor.getConcurrentCount()).toBe(3)

      // 第 4 个应该失败
      await expect(
        executor.execute({ agentName: 'explore', ... })
      ).rejects.toThrow('Maximum concurrent subagents')
    })

    it('should decrement count after completion', async () => {
      const executor = new SubagentExecutor(mockDeps)

      await executor.execute({ agentName: 'explore', ... })

      expect(executor.getConcurrentCount()).toBe(0)
    })

    it('should decrement count on error', async () => {
      const executor = new SubagentExecutor(mockDeps)
      mockLifecycleError()

      await expect(
        executor.execute({ agentName: 'explore', ... })
      ).rejects.toThrow()

      expect(executor.getConcurrentCount()).toBe(0)
    })
  })
})
```

#### 2.2.2 模式验证

```typescript
describe('mode validation', () => {
  it('should reject primary agent as subagent', async () => {
    const executor = new SubagentExecutor(mockDeps)

    await expect(
      executor.execute({ agentName: 'build', ... })
    ).rejects.toThrow('cannot be used as subagent')
  })

  it('should allow "all" mode agent as subagent', async () => {
    // 配置一个 mode: 'all' 的代理
    mockRegistry.set('custom', { mode: 'all', ... })

    const executor = new SubagentExecutor(mockDeps)

    await expect(
      executor.execute({ agentName: 'custom', ... })
    ).resolves.toBeDefined()
  })
})
```

#### 2.2.3 Session 创建

```typescript
describe('session creation', () => {
  it('should create child session with parent ID', async () => {
    const executor = new SubagentExecutor(mockDeps)

    await executor.execute({
      agentName: 'explore',
      parentSessionId: 'parent-123',
      prompt: 'search files',
      description: 'File search'
    })

    expect(mockSession.create).toHaveBeenCalledWith({
      parentId: 'parent-123',
      title: expect.stringContaining('File search')
    })
  })

  it('should resume existing session if provided', async () => {
    const executor = new SubagentExecutor(mockDeps)

    await executor.execute({
      agentName: 'explore',
      parentSessionId: 'parent-123',
      prompt: 'continue search',
      resumeSessionId: 'existing-456'
    })

    expect(mockSession.create).not.toHaveBeenCalled()
    expect(mockSession.get).toHaveBeenCalledWith('existing-456')
  })
})
```

### 2.3 AgentManager 测试

#### 2.3.1 系统提示词组装

```typescript
describe('AgentManager', () => {
  describe('getSystemPrompt', () => {
    it('should not include agentPrompt for primary agent', async () => {
      const result = await AgentManager.getSystemPrompt('build')

      expect(mockSystemPrompt.assemble).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPrompt: undefined
        })
      )
    })

    it('should include agentPrompt for subagent', async () => {
      const result = await AgentManager.getSystemPrompt('explore')

      expect(mockSystemPrompt.assemble).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPrompt: expect.any(String)
        })
      )
    })

    it('should include customInstructions only for primary agent', async () => {
      // 主代理
      await AgentManager.getSystemPrompt('build')
      expect(mockSystemPrompt.assemble).toHaveBeenCalledWith(
        expect.objectContaining({
          customInstructions: expect.any(Array)
        })
      )

      // 子代理
      await AgentManager.getSystemPrompt('explore')
      expect(mockSystemPrompt.assemble).toHaveBeenCalledWith(
        expect.objectContaining({
          customInstructions: undefined
        })
      )
    })
  })
})
```

---

## 三、集成测试

### 3.1 配置加载集成测试

```typescript
describe('Config Loading Integration', () => {
  beforeEach(() => {
    // 准备测试文件系统
    setupTestFs({
      '~/.iris-code/agents/custom-global.json': {
        name: 'custom-global',
        mode: 'subagent',
        description: 'Global custom agent'
      },
      '.iris-code/agents/custom-project.json': {
        name: 'custom-project',
        mode: 'subagent',
        description: 'Project custom agent'
      }
    })
  })

  it('should load agents from all sources', async () => {
    await AgentManager.initialize()

    const agents = await AgentManager.list()
    const names = agents.map(a => a.name)

    // 内置
    expect(names).toContain('build')
    expect(names).toContain('explore')
    // 全局
    expect(names).toContain('custom-global')
    // 项目
    expect(names).toContain('custom-project')
  })
})
```

### 3.2 子代理执行集成测试

```typescript
describe('Subagent Execution Integration', () => {
  it('should execute subagent and return result', async () => {
    // 使用真实的 Lifecycle（但 mock LLM）
    mockLLM.setResponse('Found 5 files matching pattern')

    const result = await SubagentExecutor.execute({
      agentName: 'explore',
      parentSessionId: 'parent-123',
      prompt: 'Find all TypeScript files',
      description: 'TS file search'
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Found 5 files')
    expect(result.sessionId).toBeDefined()
  })

  it('should publish events during execution', async () => {
    const events: string[] = []
    Bus.subscribe('agent.subagent.*', (e) => events.push(e.type))

    await SubagentExecutor.execute({
      agentName: 'explore',
      parentSessionId: 'parent-123',
      prompt: 'search'
    })

    expect(events).toContain('agent.subagent.started')
    expect(events).toContain('agent.subagent.completed')
  })
})
```

### 3.3 Policy 协作集成测试

```typescript
describe('Policy Collaboration Integration', () => {
  it('should switch agent when policy mode changes', async () => {
    // 初始：Agent 模式，build Agent
    expect(AgentManager.current()).toBe('build')

    // 切换到 Plan 模式
    Policy.setMode('plan')

    // 应该自动切换到 plan Agent
    await waitFor(() => {
      expect(AgentManager.current()).toBe('plan')
    })
  })

  it('should provide permission config to policy', async () => {
    const agent = await AgentManager.get('plan')

    // Policy 应该能读取 permission
    expect(agent?.permission.edit).toBe('deny')
    expect(agent?.permission.bash['git diff*']).toBe('allow')
  })
})
```

---

## 四、边界条件测试

### 4.1 空配置

```typescript
describe('Edge Cases', () => {
  it('should work with no custom config files', async () => {
    // 没有任何自定义配置文件
    mockFs.empty()

    await AgentManager.initialize()

    // 内置代理应该正常工作
    const build = await AgentManager.get('build')
    expect(build).toBeDefined()
  })
})
```

### 4.2 配置文件错误

```typescript
describe('Config File Errors', () => {
  it('should skip invalid JSON files', async () => {
    mockFs.write('.iris-code/agents/invalid.json', 'not json')

    await AgentManager.initialize()

    // 不应该崩溃，无效配置被跳过
    const agents = await AgentManager.list()
    expect(agents.find(a => a.name === 'invalid')).toBeUndefined()
  })

  it('should log warning for invalid config', async () => {
    mockFs.write('.iris-code/agents/bad.json', '{"mode": "invalid"}')

    await AgentManager.initialize()

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid agent config')
    )
  })
})
```

### 4.3 并发边界

```typescript
describe('Concurrency Edge Cases', () => {
  it('should handle rapid sequential executions', async () => {
    const executor = new SubagentExecutor(mockDeps)

    // 快速顺序执行
    for (let i = 0; i < 10; i++) {
      await executor.execute({ agentName: 'explore', ... })
    }

    expect(executor.getConcurrentCount()).toBe(0)
  })

  it('should handle execution cancellation', async () => {
    const executor = new SubagentExecutor(mockDeps)
    const controller = new AbortController()

    const promise = executor.execute({
      agentName: 'explore',
      signal: controller.signal,
      ...
    })

    controller.abort()

    await expect(promise).rejects.toThrow('aborted')
    expect(executor.getConcurrentCount()).toBe(0)
  })
})
```

---

## 五、性能测试

### 5.1 配置加载性能

```typescript
describe('Performance', () => {
  it('should load 100 config files within 1 second', async () => {
    // 创建 100 个配置文件
    for (let i = 0; i < 100; i++) {
      mockFs.write(`.iris-code/agents/agent-${i}.json`, {
        name: `agent-${i}`,
        mode: 'subagent',
        description: `Agent ${i}`
      })
    }

    const start = Date.now()
    await AgentManager.initialize()
    const duration = Date.now() - start

    expect(duration).toBeLessThan(1000)
  })
})
```

---

## 六、Mock 策略

### 6.1 需要 Mock 的依赖

| 依赖 | Mock 方式 | 原因 |
|------|-----------|------|
| Session | 完全 Mock | 避免真实存储 |
| Lifecycle | 部分 Mock | 避免真实 LLM 调用 |
| SystemPrompt | Spy | 验证调用参数 |
| Bus | Spy | 验证事件发布 |
| Config | Mock | 控制配置路径 |
| 文件系统 | memfs | 控制测试文件 |

### 6.2 Mock 示例

```typescript
// Session Mock
const mockSession = {
  create: vi.fn().mockResolvedValue({ id: 'session-123' }),
  get: vi.fn().mockResolvedValue({ id: 'session-123' }),
}

// Lifecycle Mock
const mockLifecycle = {
  run: vi.fn().mockResolvedValue({
    success: true,
    finalResponse: 'Task completed'
  })
}

// SystemPrompt Spy
vi.spyOn(SystemPrompt, 'assemble').mockReturnValue(['prompt'])
```

---

## 七、测试覆盖率目标

| 组件 | 行覆盖率 | 分支覆盖率 |
|------|----------|------------|
| AgentRegistry | ≥ 90% | ≥ 85% |
| SubagentExecutor | ≥ 95% | ≥ 90% |
| AgentManager | ≥ 85% | ≥ 80% |
| 整体 | ≥ 85% | ≥ 80% |

---

## 八、文档自检

- [x] 测试策略覆盖所有关键功能
- [x] 测试用例可执行且有明确预期
- [x] 边界条件已考虑
- [x] Mock 策略明确
- [x] 覆盖率目标合理
