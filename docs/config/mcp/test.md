# config/mcp 模块 test.md

本文档描述 `config/mcp` 模块的测试策略与测试用例。

---

## 一、Test Strategy（测试策略）

### 1.1 测试目标

验证config/mcp模块的核心职责：
- 正确加载和解析配置文件
- 正确合并全局和项目配置
- 正确验证配置Schema
- 正确处理各种错误情况

### 1.2 测试层次

| 测试类型 | 覆盖范围 | 工具 |
|---------|---------|------|
| 单元测试 | 单个函数（loadFromPath、mergeConfigs） | Jest |
| 集成测试 | 完整加载流程（loadMcpConfig） | Jest + 临时文件 |
| Schema测试 | Zod Schema验证逻辑 | Jest |

---

## 二、Unit Tests（单元测试）

### 2.1 loadFromPath 函数测试

#### 测试用例1：正常加载有效配置

```typescript
describe('loadFromPath', () => {
  it('should load valid config file', async () => {
    // 准备：创建临时配置文件
    const tempFile = await createTempFile({
      mcpServers: {
        test: {
          type: 'stdio',
          command: ['node', 'test.js']
        }
      }
    })

    // 执行
    const config = await loadFromPath(tempFile)

    // 断言
    expect(config.mcpServers.test).toEqual({
      type: 'stdio',
      command: ['node', 'test.js'],
      enabled: true,      // 默认值
      trust: false,       // 默认值
      timeout: 10000      // 默认值
    })
  })
})
```

#### 测试用例2：文件不存在返回空配置

```typescript
it('should return empty config when file not exists', async () => {
  const config = await loadFromPath('/non/existent/path.json')

  expect(config).toEqual({ mcpServers: {} })
})
```

#### 测试用例3：JSON格式错误抛出异常

```typescript
it('should throw ConfigError on invalid JSON', async () => {
  const tempFile = await createTempFile('{ invalid json }', false)

  await expect(loadFromPath(tempFile))
    .rejects
    .toThrow(ConfigError)

  await expect(loadFromPath(tempFile))
    .rejects
    .toMatchObject({
      code: 'INVALID_JSON',
      metadata: { path: tempFile }
    })
})
```

#### 测试用例4：Schema验证失败抛出ZodError

```typescript
it('should throw ZodError on schema validation failure', async () => {
  const tempFile = await createTempFile({
    mcpServers: {
      test: {
        type: 'http',
        // 缺少必需的url字段
      }
    }
  })

  await expect(loadFromPath(tempFile))
    .rejects
    .toThrow(z.ZodError)
})
```

---

### 2.2 mergeConfigs 函数测试

#### 测试用例1：项目配置覆盖全局配置

```typescript
describe('mergeConfigs', () => {
  it('should override global config with project config', () => {
    const global: McpServersConfig = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://global.com',
          trust: false
        }
      }
    }

    const project: McpServersConfig = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://project.com',
          trust: true
        }
      }
    }

    const merged = mergeConfigs(global, project)

    // github配置完全被项目配置覆盖
    expect(merged.mcpServers.github).toEqual({
      type: 'http',
      url: 'https://project.com',
      trust: true
    })
  })
})
```

#### 测试用例2：保留全局独有的服务器

```typescript
it('should keep global-only servers', () => {
  const global: McpServersConfig = {
    mcpServers: {
      global1: { type: 'stdio', command: ['test1'] },
      global2: { type: 'stdio', command: ['test2'] }
    }
  }

  const project: McpServersConfig = {
    mcpServers: {
      project1: { type: 'stdio', command: ['test3'] }
    }
  }

  const merged = mergeConfigs(global, project)

  expect(Object.keys(merged.mcpServers)).toEqual([
    'global1', 'global2', 'project1'
  ])
})
```

#### 测试用例3：空配置合并

```typescript
it('should handle empty configs', () => {
  const empty: McpServersConfig = { mcpServers: {} }
  const config: McpServersConfig = {
    mcpServers: {
      test: { type: 'stdio', command: ['test'] }
    }
  }

  expect(mergeConfigs(empty, config)).toEqual(config)
  expect(mergeConfigs(config, empty)).toEqual(config)
  expect(mergeConfigs(empty, empty)).toEqual(empty)
})
```

---

## 三、Integration Tests（集成测试）

### 3.1 loadMcpConfig 完整流程测试

#### 测试用例1：加载并合并全局和项目配置

```typescript
describe('loadMcpConfig', () => {
  it('should load and merge global and project configs', async () => {
    // 准备：创建全局和项目配置文件
    await createGlobalConfig({
      mcpServers: {
        global: { type: 'stdio', command: ['global'] },
        shared: { type: 'http', url: 'https://global.com' }
      }
    })

    await createProjectConfig({
      mcpServers: {
        project: { type: 'stdio', command: ['project'] },
        shared: { type: 'http', url: 'https://project.com', trust: true }
      }
    })

    // 执行
    const config = await loadMcpConfig()

    // 断言
    expect(config.mcpServers.global).toBeDefined()   // 全局配置保留
    expect(config.mcpServers.project).toBeDefined()  // 项目配置加入
    expect(config.mcpServers.shared.url).toBe('https://project.com')  // 项目覆盖
    expect(config.mcpServers.shared.trust).toBe(true)
  })
})
```

#### 测试用例2：仅全局配置存在

```typescript
it('should work with only global config', async () => {
  await createGlobalConfig({
    mcpServers: {
      test: { type: 'stdio', command: ['test'] }
    }
  })

  const config = await loadMcpConfig()

  expect(config.mcpServers.test).toBeDefined()
})
```

#### 测试用例3：仅项目配置存在

```typescript
it('should work with only project config', async () => {
  await createProjectConfig({
    mcpServers: {
      test: { type: 'stdio', command: ['test'] }
    }
  })

  const config = await loadMcpConfig()

  expect(config.mcpServers.test).toBeDefined()
})
```

#### 测试用例4：两个配置都不存在

```typescript
it('should return empty config when no config files exist', async () => {
  const config = await loadMcpConfig()

  expect(config).toEqual({ mcpServers: {} })
})
```

---

## 四、Schema Validation Tests（Schema验证测试）

### 4.1 Stdio配置Schema测试

#### 测试用例1：最小有效配置

```typescript
describe('McpStdioConfigSchema', () => {
  it('should accept minimal valid stdio config', () => {
    const config = {
      type: 'stdio',
      command: ['node', 'server.js']
    }

    const result = McpStdioConfigSchema.parse(config)

    expect(result).toEqual({
      type: 'stdio',
      command: ['node', 'server.js'],
      enabled: true,      // 默认值
      trust: false,       // 默认值
      timeout: 10000      // 默认值
    })
  })
})
```

#### 测试用例2：完整配置

```typescript
it('should accept full stdio config', () => {
  const config = {
    type: 'stdio',
    command: ['npx', 'mcp-server'],
    env: { DEBUG: 'mcp:*' },
    cwd: '/path/to/dir',
    enabled: false,
    trust: true,
    timeout: 20000,
    includeTools: ['tool1'],
    excludeTools: ['tool2']
  }

  const result = McpStdioConfigSchema.parse(config)

  expect(result).toEqual(config)
})
```

#### 测试用例3：拒绝空command

```typescript
it('should reject empty command array', () => {
  const config = {
    type: 'stdio',
    command: []
  }

  expect(() => McpStdioConfigSchema.parse(config))
    .toThrow(z.ZodError)
})
```

#### 测试用例4：拒绝无效timeout

```typescript
it('should reject negative timeout', () => {
  const config = {
    type: 'stdio',
    command: ['test'],
    timeout: -100
  }

  expect(() => McpStdioConfigSchema.parse(config))
    .toThrow(z.ZodError)
})
```

---

### 4.2 HTTP配置Schema测试

#### 测试用例1：最小有效配置

```typescript
describe('McpHttpConfigSchema', () => {
  it('should accept minimal valid http config', () => {
    const config = {
      type: 'http',
      url: 'https://api.example.com/mcp'
    }

    const result = McpHttpConfigSchema.parse(config)

    expect(result.type).toBe('http')
    expect(result.url).toBe('https://api.example.com/mcp')
    expect(result.enabled).toBe(true)
    expect(result.trust).toBe(false)
  })
})
```

#### 测试用例2：拒绝无效URL

```typescript
it('should reject invalid URL', () => {
  const config = {
    type: 'http',
    url: 'not-a-valid-url'
  }

  expect(() => McpHttpConfigSchema.parse(config))
    .toThrow(z.ZodError)
})
```

#### 测试用例3：接受headers

```typescript
it('should accept headers', () => {
  const config = {
    type: 'http',
    url: 'https://api.example.com',
    headers: {
      'Authorization': 'Bearer token',
      'X-Custom': 'value'
    }
  }

  const result = McpHttpConfigSchema.parse(config)

  expect(result.headers).toEqual(config.headers)
})
```

---

### 4.3 SSE配置Schema测试

```typescript
describe('McpSseConfigSchema', () => {
  it('should accept valid sse config', () => {
    const config = {
      type: 'sse',
      url: 'https://sse.example.com'
    }

    const result = McpSseConfigSchema.parse(config)

    expect(result.type).toBe('sse')
  })
})
```

---

### 4.4 联合Schema测试

#### 测试用例1：discriminatedUnion正确分发

```typescript
describe('McpServerConfigSchema', () => {
  it('should correctly discriminate by type', () => {
    const stdioConfig = {
      type: 'stdio',
      command: ['test']
    }
    const httpConfig = {
      type: 'http',
      url: 'https://example.com'
    }
    const sseConfig = {
      type: 'sse',
      url: 'https://example.com'
    }

    expect(() => McpServerConfigSchema.parse(stdioConfig)).not.toThrow()
    expect(() => McpServerConfigSchema.parse(httpConfig)).not.toThrow()
    expect(() => McpServerConfigSchema.parse(sseConfig)).not.toThrow()
  })
})
```

#### 测试用例2：拒绝无效type

```typescript
it('should reject invalid type', () => {
  const config = {
    type: 'invalid',
    command: ['test']
  }

  expect(() => McpServerConfigSchema.parse(config))
    .toThrow(z.ZodError)
})
```

---

## 五、Error Handling Tests（错误处理测试）

### 5.1 ConfigError测试

```typescript
describe('ConfigError handling', () => {
  it('should throw ConfigError with correct code on JSON parse error', async () => {
    const tempFile = await createTempFile('{ invalid }', false)

    try {
      await loadFromPath(tempFile)
      fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).code).toBe('INVALID_JSON')
      expect((error as ConfigError).metadata.path).toBe(tempFile)
    }
  })

  it('should throw ConfigError on file read error', async () => {
    // 创建一个无权限读取的文件
    const tempFile = await createUnreadableFile()

    await expect(loadFromPath(tempFile))
      .rejects
      .toMatchObject({
        code: 'LOAD_FAILED'
      })
  })
})
```

### 5.2 ZodError测试

```typescript
describe('ZodError handling', () => {
  it('should provide detailed validation errors', async () => {
    const tempFile = await createTempFile({
      mcpServers: {
        test: {
          type: 'http',
          url: 'invalid-url',
          timeout: 'not-a-number'
        }
      }
    })

    try {
      await loadFromPath(tempFile)
      fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError)
      const zodError = error as z.ZodError

      // 应该有多个验证错误
      expect(zodError.errors.length).toBeGreaterThan(0)

      // 错误应该包含路径信息
      const paths = zodError.errors.map(e => e.path.join('.'))
      expect(paths).toContain('mcpServers.test.url')
      expect(paths).toContain('mcpServers.test.timeout')
    }
  })
})
```

---

## 六、Edge Cases Tests（边界情况测试）

### 6.1 特殊字符处理

```typescript
describe('Special characters', () => {
  it('should handle server names with special characters', async () => {
    const config = {
      mcpServers: {
        'server-with-dash': { type: 'stdio', command: ['test'] },
        'server_with_underscore': { type: 'stdio', command: ['test'] },
        'server.with.dot': { type: 'stdio', command: ['test'] }
      }
    }

    const tempFile = await createTempFile(config)
    const result = await loadFromPath(tempFile)

    expect(Object.keys(result.mcpServers)).toHaveLength(3)
  })
})
```

### 6.2 大配置文件

```typescript
it('should handle large config files', async () => {
  const servers: Record<string, any> = {}

  // 创建100个MCP服务器配置
  for (let i = 0; i < 100; i++) {
    servers[`server${i}`] = {
      type: 'stdio',
      command: ['test', i.toString()]
    }
  }

  const tempFile = await createTempFile({ mcpServers: servers })
  const result = await loadFromPath(tempFile)

  expect(Object.keys(result.mcpServers)).toHaveLength(100)
})
```

### 6.3 Unicode字符

```typescript
it('should handle unicode in config values', () => {
  const config = {
    type: 'stdio',
    command: ['测试', '工具'],
    env: { '变量名': '值' }
  }

  const result = McpStdioConfigSchema.parse(config)

  expect(result.command).toEqual(['测试', '工具'])
  expect(result.env?.['变量名']).toBe('值')
})
```

---

## 七、Test Utilities（测试工具函数）

### 7.1 临时文件创建

```typescript
/**
 * 创建临时配置文件
 */
async function createTempFile(
  content: object | string,
  asJson = true
): Promise<string> {
  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, `test-${Date.now()}.json`)

  const data = asJson ? JSON.stringify(content, null, 2) : content
  await fs.writeFile(tmpFile, data, 'utf-8')

  return tmpFile
}

/**
 * 清理临时文件（afterEach中调用）
 */
async function cleanupTempFiles(files: string[]): Promise<void> {
  await Promise.all(
    files.map(file => fs.unlink(file).catch(() => {}))
  )
}
```

### 7.2 配置文件Mock

```typescript
/**
 * Mock全局配置文件路径
 */
function mockGlobalConfigPath(path: string): void {
  jest.spyOn(os, 'homedir').mockReturnValue(path)
}

/**
 * Mock项目配置文件路径
 */
function mockProjectConfigPath(path: string): void {
  jest.spyOn(process, 'cwd').mockReturnValue(path)
}
```

---

## 八、Coverage Requirements（覆盖率要求）

### 8.1 目标覆盖率

| 指标 | 目标 |
|------|------|
| 语句覆盖率 | >= 90% |
| 分支覆盖率 | >= 85% |
| 函数覆盖率 | 100% |
| 行覆盖率 | >= 90% |

### 8.2 必须覆盖的场景

- 所有正常路径（happy path）
- 所有错误路径（error path）
- 所有边界条件（edge case）
- Schema的所有验证规则

---

## 九、文档自检

- 测试策略清晰，覆盖单元测试、集成测试、Schema测试
- 测试用例完整，包含正常情况、错误情况、边界情况
- 测试工具函数可复用
- 覆盖率要求明确
- 测试用例可独立运行
