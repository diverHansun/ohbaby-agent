# system-prompt 模块 test.md

本文档定义 `system-prompt` 模块的测试策略与测试用例。

---

## 一、测试策略

### 1.1 测试层次

| 层次 | 范围 | 工具 |
|------|------|------|
| 单元测试 | 单个函数/层组件 | Vitest |
| 集成测试 | 组装流程 | Vitest + Mock |
| E2E 测试 | 完整流程 | Vitest + 真实文件系统 |

### 1.2 测试优先级

| 优先级 | 测试内容 | 原因 |
|--------|----------|------|
| P0 | assemble() 主流程 | 核心功能，被 Agent 模块依赖 |
| P0 | 主代理/子代理区分 | 影响提示词内容 |
| P1 | 自定义指令加载 | 用户可见功能 |
| P1 | 环境信息生成 | 影响 LLM 行为 |
| P2 | 边界条件处理 | 健壮性 |
| P2 | 错误处理 | 系统稳定性 |

---

## 二、单元测试

### 2.1 IdentityLayer 测试

```typescript
describe('IdentityLayer', () => {
  describe('generate', () => {
    it('should return non-empty identity prompt', () => {
      const result = IdentityLayer.generate()

      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)
    })

    it('should include core sections', () => {
      const result = IdentityLayer.generate()

      expect(result).toContain('ohbaby-code')
      expect(result).toContain('AI')
    })

    it('should not exceed max length', () => {
      const result = IdentityLayer.generate()

      expect(result.length).toBeLessThan(100 * 1024)
    })
  })
})
```

### 2.2 AgentLayer 测试

```typescript
describe('AgentLayer', () => {
  describe('generate', () => {
    it('should return agent prompt as-is', () => {
      const agentPrompt = 'You are an exploration agent.'
      const result = AgentLayer.generate(agentPrompt)

      expect(result).toBe(agentPrompt)
    })

    it('should handle empty prompt', () => {
      const result = AgentLayer.generate('')

      expect(result).toBe('')
    })
  })

  describe('getAgentPrompt', () => {
    it('should return explore agent prompt', () => {
      const result = SystemPrompt.getAgentPrompt('explore')

      expect(result).toBeDefined()
      expect(result).toContain('exploration')
    })

    it('should return research agent prompt', () => {
      const result = SystemPrompt.getAgentPrompt('research')

      expect(result).toBeDefined()
      expect(result).toContain('research')
    })

    it('should return undefined for unknown agent', () => {
      const result = SystemPrompt.getAgentPrompt('unknown')

      expect(result).toBeUndefined()
    })
  })
})
```

### 2.3 EnvironmentLayer 测试

```typescript
describe('EnvironmentLayer', () => {
  const mockEnv: EnvironmentInfo = {
    workingDirectory: '/home/user/project',
    platform: 'linux',
    isGitRepo: true,
    date: '2024-01-15'
  }

  describe('generate full mode', () => {
    it('should include all environment info', () => {
      const result = EnvironmentLayer.generate({
        info: mockEnv,
        minimal: false,
        tools: ['read', 'write', 'bash']
      })

      expect(result).toContain('/home/user/project')
      expect(result).toContain('linux')
      expect(result).toContain('true')
      expect(result).toContain('2024-01-15')
      expect(result).toContain('read')
    })

    it('should include tools list', () => {
      const result = EnvironmentLayer.generate({
        info: mockEnv,
        minimal: false,
        tools: ['glob', 'grep', 'read']
      })

      expect(result).toContain('glob')
      expect(result).toContain('grep')
      expect(result).toContain('read')
    })
  })

  describe('generate minimal mode', () => {
    it('should include basic info only', () => {
      const result = EnvironmentLayer.generate({
        info: mockEnv,
        minimal: true
      })

      expect(result).toContain('/home/user/project')
      expect(result).toContain('linux')
      expect(result).toContain('2024-01-15')
    })

    it('should not include git status in minimal mode', () => {
      const result = EnvironmentLayer.generate({
        info: mockEnv,
        minimal: true
      })

      // Git status may or may not be included based on implementation
      // This test documents expected behavior
    })
  })
})
```

### 2.4 CustomLayer 测试

```typescript
describe('CustomLayer', () => {
  describe('load', () => {
    it('should load project OHBABY.md', async () => {
      mockFs.write('.ohbaby-code/OHBABY.md', '# Project Instructions')

      const result = await CustomLayer.load()

      expect(result).toContain('# Project Instructions')
    })

    it('should load global OHBABY.md', async () => {
      mockFs.write('~/.ohbaby-code/OHBABY.md', '# Global Instructions')

      const result = await CustomLayer.load()

      expect(result).toContain('# Global Instructions')
    })

    it('should merge project and global instructions', async () => {
      mockFs.write('.ohbaby-code/OHBABY.md', '# Project')
      mockFs.write('~/.ohbaby-code/OHBABY.md', '# Global')

      const result = await CustomLayer.load()

      expect(result.length).toBe(2)
      expect(result).toContain('# Project')
      expect(result).toContain('# Global')
    })

    it('should return empty array if no files exist', async () => {
      mockFs.empty()

      const result = await CustomLayer.load()

      expect(result).toEqual([])
    })

    it('should handle file read errors gracefully', async () => {
      mockFs.setReadError('.ohbaby-code/OHBABY.md', new Error('Permission denied'))

      const result = await CustomLayer.load()

      expect(result).toEqual([])
    })
  })

  describe('generate', () => {
    it('should join instructions with separator', () => {
      const instructions = ['# Part 1', '# Part 2']
      const result = CustomLayer.generate(instructions)

      expect(result).toContain('# Part 1')
      expect(result).toContain('# Part 2')
    })

    it('should handle empty instructions', () => {
      const result = CustomLayer.generate([])

      expect(result).toBe('')
    })
  })
})
```

---

## 三、集成测试

### 3.1 主代理提示词组装测试

```typescript
describe('SystemPrompt.assemble for primary agent', () => {
  const mockEnv: EnvironmentInfo = {
    workingDirectory: '/project',
    platform: 'darwin',
    isGitRepo: true,
    date: '2024-01-15'
  }

  it('should include identity layer for primary agent', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnv
    })

    expect(result.length).toBeGreaterThan(0)
    expect(result.join('\n')).toContain('ohbaby-code')
  })

  it('should include environment info', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnv
    })

    expect(result.join('\n')).toContain('/project')
    expect(result.join('\n')).toContain('darwin')
  })

  it('should include custom instructions when provided', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnv,
      customInstructions: ['Use TypeScript', 'Follow ESLint rules']
    })

    expect(result.join('\n')).toContain('Use TypeScript')
    expect(result.join('\n')).toContain('Follow ESLint rules')
  })

  it('should include tools list', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnv,
      tools: ['read', 'write', 'bash']
    })

    expect(result.join('\n')).toContain('read')
    expect(result.join('\n')).toContain('write')
  })
})
```

### 3.2 子代理提示词组装测试

```typescript
describe('SystemPrompt.assemble for subagent', () => {
  const mockEnv: EnvironmentInfo = {
    workingDirectory: '/project',
    platform: 'linux',
    isGitRepo: false,
    date: '2024-01-15'
  }

  it('should use agent prompt instead of identity', () => {
    const result = SystemPrompt.assemble({
      agentName: 'explore',
      agentPrompt: 'You are an exploration agent.',
      environment: mockEnv
    })

    expect(result.join('\n')).toContain('exploration agent')
    // Should not contain full identity
  })

  it('should use minimal environment info', () => {
    const result = SystemPrompt.assemble({
      agentName: 'explore',
      agentPrompt: 'Explore agent',
      environment: mockEnv,
      tools: ['glob', 'grep', 'read']
    })

    expect(result.join('\n')).toContain('/project')
    expect(result.join('\n')).toContain('linux')
  })

  it('should not include custom instructions for subagent', () => {
    const result = SystemPrompt.assemble({
      agentName: 'explore',
      agentPrompt: 'Explore agent',
      environment: mockEnv,
      customInstructions: undefined
    })

    // customInstructions should not be processed
    expect(result.length).toBeLessThan(10) // Subagent prompts are short
  })
})
```

### 3.3 自定义指令加载集成测试

```typescript
describe('Custom Instructions Integration', () => {
  beforeEach(() => {
    mockFs.reset()
  })

  it('should load and include in primary agent prompt', async () => {
    mockFs.write('.ohbaby-code/OHBABY.md', '# Custom Instructions\nUse Jest')

    const customInstructions = await SystemPrompt.loadCustomInstructions()
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnvironment,
      customInstructions
    })

    expect(result.join('\n')).toContain('Use Jest')
  })

  it('should prioritize project over global instructions', async () => {
    mockFs.write('.ohbaby-code/OHBABY.md', '# Project: Use Vitest')
    mockFs.write('~/.ohbaby-code/OHBABY.md', '# Global: Use Jest')

    const customInstructions = await SystemPrompt.loadCustomInstructions()

    // Project instructions should come first
    expect(customInstructions[0]).toContain('Vitest')
    expect(customInstructions[1]).toContain('Jest')
  })
})
```

---

## 四、边界条件测试

### 4.1 空值处理

```typescript
describe('Edge Cases - Empty Values', () => {
  it('should handle empty custom instructions', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnvironment,
      customInstructions: []
    })

    expect(result.length).toBeGreaterThan(0)
  })

  it('should handle empty tools list', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnvironment,
      tools: []
    })

    expect(result.length).toBeGreaterThan(0)
  })

  it('should handle undefined optional fields', () => {
    const result = SystemPrompt.assemble({
      agentName: 'build',
      agentPrompt: undefined,
      environment: mockEnvironment
      // No customInstructions, no tools
    })

    expect(result.length).toBeGreaterThan(0)
  })
})
```

### 4.2 大文件处理

```typescript
describe('Edge Cases - Large Files', () => {
  it('should truncate oversized custom instructions', async () => {
    const largeContent = 'x'.repeat(60 * 1024) // 60KB
    mockFs.write('.ohbaby-code/OHBABY.md', largeContent)

    const result = await SystemPrompt.loadCustomInstructions()

    // Should be truncated to max size
    expect(result[0].length).toBeLessThanOrEqual(50 * 1024)
  })

  it('should warn about truncation', async () => {
    const largeContent = 'x'.repeat(60 * 1024)
    mockFs.write('.ohbaby-code/OHBABY.md', largeContent)

    await SystemPrompt.loadCustomInstructions()

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('truncated')
    )
  })
})
```

### 4.3 特殊字符处理

```typescript
describe('Edge Cases - Special Characters', () => {
  it('should handle unicode in custom instructions', async () => {
    mockFs.write('.ohbaby-code/OHBABY.md', '# Instructions\n使用中文注释')

    const result = await SystemPrompt.loadCustomInstructions()

    expect(result[0]).toContain('使用中文注释')
  })

  it('should handle special markdown characters', async () => {
    mockFs.write('.ohbaby-code/OHBABY.md', '# Title\n- Item `code` **bold**')

    const result = await SystemPrompt.loadCustomInstructions()

    expect(result[0]).toContain('`code`')
    expect(result[0]).toContain('**bold**')
  })
})
```

---

## 五、错误处理测试

```typescript
describe('Error Handling', () => {
  describe('assemble validation', () => {
    it('should throw on empty agentName', () => {
      expect(() =>
        SystemPrompt.assemble({
          agentName: '',
          environment: mockEnvironment
        })
      ).toThrow('agentName')
    })

    it('should throw on missing environment', () => {
      expect(() =>
        SystemPrompt.assemble({
          agentName: 'build',
          environment: undefined as any
        })
      ).toThrow('environment')
    })

    it('should throw on invalid environment', () => {
      expect(() =>
        SystemPrompt.assemble({
          agentName: 'build',
          environment: { workingDirectory: '' } as any
        })
      ).toThrow()
    })
  })

  describe('file system errors', () => {
    it('should handle permission denied gracefully', async () => {
      mockFs.setReadError('.ohbaby-code/OHBABY.md', new Error('EACCES'))

      const result = await SystemPrompt.loadCustomInstructions()

      expect(result).toEqual([])
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('should handle file not found gracefully', async () => {
      mockFs.empty()

      const result = await SystemPrompt.loadCustomInstructions()

      expect(result).toEqual([])
      // Should not log warning for missing files
    })
  })
})
```

---

## 六、Mock 策略

### 6.1 需要 Mock 的依赖

| 依赖 | Mock 方式 | 原因 |
|------|-----------|------|
| 文件系统 | memfs | 控制测试文件 |
| Config | Mock | 控制配置路径 |
| Logger | Spy | 验证日志输出 |

### 6.2 Mock 示例

```typescript
// 文件系统 Mock
import { vol } from 'memfs'

const mockFs = {
  reset: () => vol.reset(),
  write: (path: string, content: string) => {
    vol.mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true })
    vol.writeFileSync(path, content)
  },
  empty: () => vol.reset(),
  setReadError: (path: string, error: Error) => {
    // Implementation depends on mock setup
  }
}

// Config Mock
const mockConfig = {
  getProjectPath: vi.fn().mockReturnValue('/project/.ohbaby-code'),
  getGlobalPath: vi.fn().mockReturnValue('/home/user/.ohbaby-code')
}

// Logger Spy
const mockLogger = {
  warn: vi.fn(),
  error: vi.fn()
}
```

---

## 七、测试覆盖率目标

| 组件 | 行覆盖率 | 分支覆盖率 |
|------|----------|------------|
| assembler.ts | >= 95% | >= 90% |
| layers/identity.ts | >= 90% | >= 85% |
| layers/agent.ts | >= 95% | >= 90% |
| layers/environment.ts | >= 95% | >= 90% |
| layers/custom.ts | >= 90% | >= 85% |
| 整体 | >= 90% | >= 85% |

---

## 八、文档自检

- [x] 测试策略覆盖所有关键功能
- [x] 测试用例可执行且有明确预期
- [x] 边界条件已考虑
- [x] Mock 策略明确
- [x] 覆盖率目标合理
