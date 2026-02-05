# Tavily Config Loader - test.md

本文档定义 `config/tools/tavily` 配置加载器的测试策略与测试用例设计。

---

## 一、Test Strategy（测试策略）

### 1.1 测试层次

| 层次 | 范围 | 方法 | 工具 |
|------|------|------|------|
| 单元测试 | 各组件独立功能 | Mock 文件系统 | Vitest |
| 集成测试 | 配置加载完整流程 | 临时文件 | Vitest |

### 1.2 测试原则

- **隔离性**: 测试不依赖真实文件系统（单元测试）
- **覆盖率**: 核心逻辑覆盖率 > 90%
- **边界测试**: 覆盖配置值边界情况
- **错误场景**: 覆盖所有错误处理路径

### 1.3 Mock 策略

| 组件 | Mock 方式 | 说明 |
|------|-----------|------|
| fs | vi.mock | Mock 文件读取 |
| path | 部分 Mock | 保留路径解析逻辑 |
| os | vi.mock | Mock 用户目录 |
| process.env | vi.stubEnv | 环境变量 |

---

## 二、Unit Tests（单元测试）

### 2.1 loader.ts 测试

**文件**: `__tests__/loader.test.ts`

```typescript
describe('TavilyConfigLoader', () => {
  describe('load', () => {
    it('当配置文件不存在时应该返回默认配置', async () => {
      // Given
      mockFs.exists.mockResolvedValue(false)

      // When
      const loader = new TavilyConfigLoader('/project')
      const config = await loader.load()

      // Then
      expect(config.baseURL).toBe('https://api.tavily.com')
      expect(config.search.defaultMaxResults).toBe(5)
    })

    it('应该正确加载用户级配置', async () => {
      // Given
      mockFs.exists.mockImplementation(path =>
        Promise.resolve(path.includes('.config'))
      )
      mockFs.read.mockResolvedValue({
        tavily: {
          search: { default_max_results: 10 }
        }
      })

      // When
      const loader = new TavilyConfigLoader('/project')
      const config = await loader.load()

      // Then
      expect(config.search.defaultMaxResults).toBe(10)
    })

    it('应该正确加载项目级配置', async () => {
      // Given
      mockFs.exists.mockImplementation(path =>
        Promise.resolve(path.includes('.iris-code'))
      )
      mockFs.read.mockResolvedValue({
        tavily: {
          search: { default_search_depth: 'advanced' }
        }
      })

      // When
      const loader = new TavilyConfigLoader('/project')
      const config = await loader.load()

      // Then
      expect(config.search.defaultSearchDepth).toBe('advanced')
    })

    it('项目级配置应该覆盖用户级配置', async () => {
      // Given
      mockFs.exists.mockResolvedValue(true)
      mockFs.read
        .mockResolvedValueOnce({
          tavily: { search: { default_max_results: 10 } }  // 用户级
        })
        .mockResolvedValueOnce({
          tavily: { search: { default_max_results: 20 } }  // 项目级
        })

      // When
      const loader = new TavilyConfigLoader('/project')
      const config = await loader.load()

      // Then
      expect(config.search.defaultMaxResults).toBe(20)
    })

    it('当 YAML 解析失败时应该抛出 ConfigParseError', async () => {
      // Given
      mockFs.exists.mockResolvedValue(true)
      mockFs.read.mockRejectedValue(new Error('Invalid YAML'))

      // When & Then
      const loader = new TavilyConfigLoader('/project')
      await expect(loader.load()).rejects.toThrow('ConfigParseError')
    })
  })

  describe('validate', () => {
    it('应该验证有效配置', () => {
      // Given
      const loader = new TavilyConfigLoader('/project')
      const config = getDefaultTavilyConfig()

      // When
      const result = loader.validate(config)

      // Then
      expect(result.valid).toBe(true)
    })

    it('当 max_results 超出范围时应该返回错误', () => {
      // Given
      const loader = new TavilyConfigLoader('/project')
      const config = {
        tavily: {
          search: { default_max_results: 100 }  // 超出 1-20 范围
        }
      }

      // When
      const result = loader.validate(config)

      // Then
      expect(result.valid).toBe(false)
      expect(result.errors).toContain(expect.stringMatching(/max_results/))
    })

    it('当 search_depth 值无效时应该返回错误', () => {
      // Given
      const loader = new TavilyConfigLoader('/project')
      const config = {
        tavily: {
          search: { default_search_depth: 'invalid' }
        }
      }

      // When
      const result = loader.validate(config)

      // Then
      expect(result.valid).toBe(false)
    })
  })

  describe('reload', () => {
    it('应该重新加载配置', async () => {
      // Given
      mockFs.exists.mockResolvedValue(true)
      mockFs.read
        .mockResolvedValueOnce({
          tavily: { search: { default_max_results: 5 } }
        })
        .mockResolvedValueOnce({
          tavily: { search: { default_max_results: 10 } }
        })

      const loader = new TavilyConfigLoader('/project')
      const config1 = await loader.load()

      // When
      const config2 = await loader.reload()

      // Then
      expect(config1.search.defaultMaxResults).toBe(5)
      expect(config2.search.defaultMaxResults).toBe(10)
    })
  })

  describe('getPathInfo', () => {
    it('应该返回正确的路径信息', () => {
      // Given
      const loader = new TavilyConfigLoader('/project')

      // When
      const pathInfo = loader.getPathInfo()

      // Then
      expect(pathInfo.projectPath).toContain('.iris-code/tools/tavily.yaml')
      expect(pathInfo.userPath).toContain('iris-code/tools/tavily.yaml')
    })
  })
})
```

### 2.2 schema.ts 测试

**文件**: `__tests__/schema.test.ts`

```typescript
describe('TavilyConfigFileSchema', () => {
  describe('search config', () => {
    it('应该接受有效的搜索配置', () => {
      // Given
      const config = {
        tavily: {
          search: {
            default_search_depth: 'advanced',
            default_topic: 'news',
            default_max_results: 10
          }
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(true)
    })

    it('应该拒绝无效的 search_depth', () => {
      // Given
      const config = {
        tavily: {
          search: { default_search_depth: 'invalid' }
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(false)
    })

    it('应该拒绝超出范围的 max_results', () => {
      // Given
      const config = {
        tavily: {
          search: { default_max_results: 50 }  // 超出 1-20
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(false)
    })
  })

  describe('crawl config', () => {
    it('应该接受有效的爬取配置', () => {
      // Given
      const config = {
        tavily: {
          crawl: {
            default_max_depth: 3,
            default_max_breadth: 20,
            default_limit: 50
          }
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(true)
    })

    it('应该拒绝超出范围的 max_depth', () => {
      // Given
      const config = {
        tavily: {
          crawl: { default_max_depth: 20 }  // 超出 1-10
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(false)
    })
  })

  describe('proxy config', () => {
    it('应该接受有效的代理配置', () => {
      // Given
      const config = {
        tavily: {
          proxy: {
            http: 'http://proxy:8080',
            https: 'https://proxy:8080'
          }
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(true)
    })

    it('应该拒绝无效的代理 URL', () => {
      // Given
      const config = {
        tavily: {
          proxy: { http: 'not-a-url' }
        }
      }

      // When
      const result = TavilyConfigFileSchema.safeParse(config)

      // Then
      expect(result.success).toBe(false)
    })
  })
})
```

### 2.3 defaults.ts 测试

**文件**: `__tests__/defaults.test.ts`

```typescript
describe('Default Config', () => {
  it('defaultTavilyConfig 应该有完整的结构', () => {
    // When
    const config = getDefaultTavilyConfig()

    // Then
    expect(config.baseURL).toBeDefined()
    expect(config.search).toBeDefined()
    expect(config.extract).toBeDefined()
    expect(config.crawl).toBeDefined()
    expect(config.map).toBeDefined()
  })

  it('默认搜索配置应该合理', () => {
    // When
    const config = getDefaultTavilyConfig()

    // Then
    expect(config.search.defaultSearchDepth).toBe('basic')
    expect(config.search.defaultMaxResults).toBe(5)
    expect(config.search.defaultTimeout).toBe(60)
  })

  it('默认爬取配置应该合理', () => {
    // When
    const config = getDefaultTavilyConfig()

    // Then
    expect(config.crawl.defaultMaxDepth).toBe(2)
    expect(config.crawl.defaultLimit).toBe(20)
    expect(config.crawl.defaultTimeout).toBe(120)
  })
})
```

### 2.4 路径解析测试

**文件**: `__tests__/path.test.ts`

```typescript
describe('Path Resolution', () => {
  describe('resolveUserConfigDir', () => {
    it('在 Windows 上应该使用 APPDATA', () => {
      // Given
      vi.stubGlobal('process', { platform: 'win32' })
      vi.stubEnv('APPDATA', 'C:\\Users\\Test\\AppData\\Roaming')

      // When
      const result = resolveUserConfigDir()

      // Then
      expect(result).toContain('AppData')
      expect(result).toContain('iris-code')
    })

    it('在 Linux 上应该使用 XDG_CONFIG_HOME', () => {
      // Given
      vi.stubGlobal('process', { platform: 'linux' })
      vi.stubEnv('XDG_CONFIG_HOME', '/custom/config')

      // When
      const result = resolveUserConfigDir()

      // Then
      expect(result).toBe('/custom/config/iris-code/tools')
    })

    it('当 XDG_CONFIG_HOME 未设置时应该使用 ~/.config', () => {
      // Given
      vi.stubGlobal('process', { platform: 'linux' })
      delete process.env.XDG_CONFIG_HOME
      mockOs.homedir.mockReturnValue('/home/user')

      // When
      const result = resolveUserConfigDir()

      // Then
      expect(result).toBe('/home/user/.config/iris-code/tools')
    })
  })

  describe('resolveProjectConfigPath', () => {
    it('应该返回正确的项目配置路径', () => {
      // When
      const result = resolveProjectConfigPath('/my/project')

      // Then
      expect(result).toBe('/my/project/.iris-code/tools/tavily.yaml')
    })
  })
})
```

---

## 三、Integration Tests（集成测试）

### 3.1 完整加载流程测试

**文件**: `__tests__/integration/loader.test.ts`

```typescript
describe('TavilyConfigLoader Integration', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tavily-config-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true })
  })

  it('应该从真实文件加载配置', async () => {
    // Given
    const configDir = path.join(tempDir, '.iris-code', 'tools')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, 'tavily.yaml'),
      `tavily:
  search:
    default_max_results: 15`
    )

    // When
    const loader = new TavilyConfigLoader(tempDir)
    const config = await loader.load()

    // Then
    expect(config.search.defaultMaxResults).toBe(15)
  })

  it('应该正确合并多级配置', async () => {
    // Given - 创建项目级配置
    const projectConfigDir = path.join(tempDir, '.iris-code', 'tools')
    await fs.mkdir(projectConfigDir, { recursive: true })
    await fs.writeFile(
      path.join(projectConfigDir, 'tavily.yaml'),
      `tavily:
  search:
    default_max_results: 20`
    )

    // When
    const loader = new TavilyConfigLoader(tempDir)
    const config = await loader.load()

    // Then
    expect(config.search.defaultMaxResults).toBe(20)
    expect(config.search.defaultSearchDepth).toBe('basic')  // 默认值
  })
})
```

---

## 四、Test Fixtures（测试数据）

### 4.1 有效配置示例

```typescript
// __tests__/fixtures/valid-configs.ts
export const minimalConfig = {
  tavily: {}
}

export const searchOnlyConfig = {
  tavily: {
    search: {
      default_max_results: 10,
      default_search_depth: 'advanced'
    }
  }
}

export const fullConfig = {
  tavily: {
    base_url: 'https://api.tavily.com',
    proxy: {
      http: 'http://proxy:8080'
    },
    search: {
      default_search_depth: 'basic',
      default_topic: 'general',
      default_max_results: 5,
      default_include_answer: false,
      default_include_images: false,
      default_include_raw_content: false,
      default_timeout: 60
    },
    extract: {
      default_extract_depth: 'basic',
      default_format: 'markdown',
      default_include_images: false,
      default_timeout: 60
    },
    crawl: {
      default_max_depth: 2,
      default_max_breadth: 10,
      default_limit: 20,
      default_extract_depth: 'basic',
      default_format: 'markdown',
      default_allow_external: false,
      default_include_images: false,
      default_timeout: 120
    },
    map: {
      default_max_depth: 2,
      default_max_breadth: 10,
      default_limit: 100,
      default_allow_external: false,
      default_timeout: 60
    }
  }
}
```

### 4.2 无效配置示例

```typescript
// __tests__/fixtures/invalid-configs.ts
export const invalidSearchDepth = {
  tavily: {
    search: { default_search_depth: 'invalid' }
  }
}

export const outOfRangeMaxResults = {
  tavily: {
    search: { default_max_results: 100 }
  }
}

export const invalidProxyUrl = {
  tavily: {
    proxy: { http: 'not-a-url' }
  }
}

export const invalidTimeout = {
  tavily: {
    search: { default_timeout: -1 }
  }
}
```

---

## 五、Test Coverage Requirements（覆盖率要求）

| 模块 | 语句覆盖 | 分支覆盖 | 函数覆盖 |
|------|----------|----------|----------|
| loader.ts | > 95% | > 90% | 100% |
| schema.ts | > 90% | > 85% | 100% |
| defaults.ts | 100% | 100% | 100% |

---

## 六、Edge Cases（边界情况）

### 6.1 需要测试的边界情况

| 场景 | 预期行为 |
|------|----------|
| 配置文件为空 | 使用默认配置 |
| 配置文件只有部分字段 | 其余使用默认值 |
| max_results = 1 | 有效（边界最小值） |
| max_results = 20 | 有效（边界最大值） |
| max_depth = 10 | 有效（边界最大值） |
| timeout = 1 | 有效（边界最小值） |
| 代理 URL 为空字符串 | 无效 |
| base_url 非 URL 格式 | 无效 |

---

## 七、文档自检

- [x] 测试策略清晰
- [x] 单元测试覆盖核心功能
- [x] 集成测试覆盖完整流程
- [x] 边界情况已列出
- [x] 测试数据充分
- [x] 覆盖率要求明确
