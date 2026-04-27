# Exa Config Loader - test.md

本文档定义 `config/tools/exa` 配置加载器的测试策略与测试用例。

---

## 一、Test Strategy（测试策略）

### 1.1 测试层次

| 层次 | 类型 | 目的 | 覆盖 |
|------|------|------|------|
| L1 | 单元测试 | 测试单个函数 | Schema 验证、路径解析 |
| L2 | 集成测试 | 测试模块交互 | 配置加载、合并 |

### 1.2 测试工具

- **测试框架**：Vitest
- **文件系统 Mock**：memfs 或 vitest mock
- **环境变量**：vitest 环境设置

### 1.3 测试文件结构

```
src/config/tools/exa/
└── __tests__/
    ├── loader.test.ts        # 加载器测试
    ├── schema.test.ts        # Schema 验证测试
    ├── merge.test.ts         # 配置合并测试
    └── fixtures/
        ├── valid-config.yaml     # 有效配置
        ├── invalid-config.yaml   # 无效配置
        └── partial-config.yaml   # 部分配置
```

---

## 二、Unit Tests（单元测试）

### 2.1 schema.test.ts - Schema 验证测试

```typescript
import { describe, it, expect } from 'vitest'
import { ExaConfigFileSchema } from '../schema'

describe('ExaConfigFileSchema', () => {
  describe('base_url validation', () => {
    it('should accept valid URL', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {
          base_url: 'https://api.exa.ai',
        },
      })
      expect(result.success).toBe(true)
    })

    it('should reject invalid URL', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {
          base_url: 'not-a-url',
        },
      })
      expect(result.success).toBe(false)
    })

    it('should allow missing base_url', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {},
      })
      expect(result.success).toBe(true)
    })
  })

  describe('search config validation', () => {
    it('should accept valid search config', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {
          search: {
            default_mode: 'neural',
            default_num_results: 10,
            default_max_characters: 10000,
          },
        },
      })
      expect(result.success).toBe(true)
    })

    it('should accept all valid modes', () => {
      const modes = ['neural', 'keyword', 'auto', 'fast']
      modes.forEach(mode => {
        const result = ExaConfigFileSchema.safeParse({
          exa: {
            search: { default_mode: mode },
          },
        })
        expect(result.success).toBe(true)
      })
    })

    it('should reject invalid mode', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {
          search: { default_mode: 'invalid' },
        },
      })
      expect(result.success).toBe(false)
    })

    it('should reject num_results out of range', () => {
      const result1 = ExaConfigFileSchema.safeParse({
        exa: {
          search: { default_num_results: 0 },
        },
      })
      expect(result1.success).toBe(false)

      const result2 = ExaConfigFileSchema.safeParse({
        exa: {
          search: { default_num_results: 101 },
        },
      })
      expect(result2.success).toBe(false)
    })

    it('should reject max_characters out of range', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {
          search: { default_max_characters: 100001 },
        },
      })
      expect(result.success).toBe(false)
    })
  })

  describe('get_contents config validation', () => {
    it('should accept valid get_contents config', () => {
      const result = ExaConfigFileSchema.safeParse({
        exa: {
          get_contents: {
            default_max_characters: 5000,
            include_highlights: true,
            include_summary: true,
          },
        },
      })
      expect(result.success).toBe(true)
    })

    it('should use default values', () => {
      const result = ExaConfigFileSchema.parse({
        exa: {
          get_contents: {},
        },
      })
      expect(result.exa.get_contents?.include_highlights).toBe(false)
      expect(result.exa.get_contents?.include_summary).toBe(false)
    })
  })
})
```

### 2.2 path.test.ts - 路径解析测试

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveUserConfigDir, resolveProjectConfigPath } from '../path'

describe('Path Resolution', () => {
  const originalPlatform = process.platform
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = originalEnv
  })

  describe('resolveUserConfigDir', () => {
    it('should use APPDATA on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming'

      const path = resolveUserConfigDir()
      expect(path).toContain('ohbaby-code')
      expect(path).toContain('tools')
    })

    it('should use XDG_CONFIG_HOME on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.XDG_CONFIG_HOME = '/home/test/.config'

      const path = resolveUserConfigDir()
      expect(path).toBe('/home/test/.config/ohbaby-code/tools')
    })

    it('should fallback to ~/.config on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = '/home/test'

      const path = resolveUserConfigDir()
      expect(path).toContain('.config/ohbaby-code/tools')
    })
  })

  describe('resolveProjectConfigPath', () => {
    it('should return correct project config path', () => {
      const path = resolveProjectConfigPath('/project/root')
      expect(path).toBe('/project/root/.ohbaby-code/tools/exa.yaml')
    })
  })
})
```

---

## 三、Integration Tests（集成测试）

### 3.1 loader.test.ts - 配置加载器测试

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExaConfigLoader } from '../loader'
import * as fs from 'fs/promises'
import * as path from 'path'

// Mock fs
vi.mock('fs/promises')

describe('ExaConfigLoader', () => {
  const projectRoot = '/test/project'
  let loader: ExaConfigLoader

  beforeEach(() => {
    loader = new ExaConfigLoader(projectRoot)
    vi.clearAllMocks()
    delete process.env.EXA_API_KEY
  })

  describe('load', () => {
    it('should return default config when no files exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))
      process.env.EXA_API_KEY = 'test-key'

      const config = await loader.load()

      expect(config.baseURL).toBe('https://api.exa.ai')
      expect(config.search.defaultMode).toBe('neural')
      expect(config.search.defaultNumResults).toBe(10)
      expect(config.apiKey).toBe('test-key')
    })

    it('should load and merge project config', async () => {
      const projectConfig = `
exa:
  search:
    default_mode: fast
    default_num_results: 5
`
      vi.mocked(fs.access).mockImplementation(async (p) => {
        if (String(p).includes('.ohbaby-code')) return
        throw new Error('ENOENT')
      })
      vi.mocked(fs.readFile).mockResolvedValue(projectConfig)
      process.env.EXA_API_KEY = 'test-key'

      const config = await loader.load()

      expect(config.search.defaultMode).toBe('fast')
      expect(config.search.defaultNumResults).toBe(5)
    })

    it('should prioritize project config over user config', async () => {
      const userConfig = `
exa:
  search:
    default_mode: keyword
`
      const projectConfig = `
exa:
  search:
    default_mode: neural
`
      vi.mocked(fs.access).mockResolvedValue(undefined)
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        if (String(p).includes('.ohbaby-code')) return projectConfig
        return userConfig
      })
      process.env.EXA_API_KEY = 'test-key'

      const config = await loader.load()

      expect(config.search.defaultMode).toBe('neural')  // 项目级优先
    })

    it('should throw error when API key is missing', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))
      // 不设置 EXA_API_KEY

      await expect(loader.load()).rejects.toThrow('EXA_API_KEY')
    })

    it('should throw ConfigParseError for invalid YAML', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined)
      vi.mocked(fs.readFile).mockResolvedValue('invalid: yaml: content:')
      process.env.EXA_API_KEY = 'test-key'

      await expect(loader.load()).rejects.toThrow('ConfigParseError')
    })
  })

  describe('validate', () => {
    it('should return valid for complete config', () => {
      const config = {
        apiKey: 'test-key',
        baseURL: 'https://api.exa.ai',
        search: {
          defaultMode: 'neural' as const,
          defaultNumResults: 10,
          defaultMaxCharacters: 10000,
        },
        getContents: {
          defaultMaxCharacters: 10000,
          includeHighlights: false,
          includeSummary: false,
        },
      }

      const result = loader.validate(config)

      expect(result.valid).toBe(true)
      expect(result.errors).toBeUndefined()
    })

    it('should return invalid when API key is empty', () => {
      const config = {
        apiKey: '',
        baseURL: 'https://api.exa.ai',
        search: {
          defaultMode: 'neural' as const,
          defaultNumResults: 10,
          defaultMaxCharacters: 10000,
        },
        getContents: {
          defaultMaxCharacters: 10000,
          includeHighlights: false,
          includeSummary: false,
        },
      }

      const result = loader.validate(config)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('EXA_API_KEY is required')
    })
  })

  describe('reload', () => {
    it('should reload configuration', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))
      process.env.EXA_API_KEY = 'test-key'

      const config1 = await loader.load()

      process.env.EXA_API_KEY = 'new-key'
      const config2 = await loader.reload()

      expect(config2.apiKey).toBe('new-key')
    })
  })

  describe('getPathInfo', () => {
    it('should return correct path info', async () => {
      vi.mocked(fs.access).mockImplementation(async (p) => {
        if (String(p).includes('.ohbaby-code')) return
        throw new Error('ENOENT')
      })

      const info = await loader.getPathInfo()

      expect(info.projectPath).toContain('.ohbaby-code/tools/exa.yaml')
      expect(info.projectExists).toBe(true)
      expect(info.userExists).toBe(false)
    })
  })
})
```

### 3.2 merge.test.ts - 配置合并测试

```typescript
import { describe, it, expect } from 'vitest'
import { mergeConfig } from '../merge'
import { defaultExaConfig } from '../defaults'

describe('Config Merge', () => {
  describe('mergeConfig', () => {
    it('should merge search config', () => {
      const override = {
        exa: {
          search: {
            default_mode: 'fast' as const,
          },
        },
      }

      const result = mergeConfig(defaultExaConfig, override)

      expect(result.search.defaultMode).toBe('fast')
      expect(result.search.defaultNumResults).toBe(10)  // 保持默认
    })

    it('should merge get_contents config', () => {
      const override = {
        exa: {
          get_contents: {
            include_highlights: true,
          },
        },
      }

      const result = mergeConfig(defaultExaConfig, override)

      expect(result.getContents.includeHighlights).toBe(true)
      expect(result.getContents.includeSummary).toBe(false)  // 保持默认
    })

    it('should override base_url', () => {
      const override = {
        exa: {
          base_url: 'https://custom.api.com',
        },
      }

      const result = mergeConfig(defaultExaConfig, override)

      expect(result.baseURL).toBe('https://custom.api.com')
    })

    it('should handle empty override', () => {
      const result = mergeConfig(defaultExaConfig, { exa: {} })

      expect(result).toEqual({
        ...defaultExaConfig,
        apiKey: result.apiKey,
      })
    })

    it('should deeply merge nested objects', () => {
      const base = {
        ...defaultExaConfig,
        search: {
          defaultMode: 'neural' as const,
          defaultNumResults: 10,
          defaultMaxCharacters: 10000,
        },
      }

      const override = {
        exa: {
          search: {
            default_num_results: 5,
          },
        },
      }

      const result = mergeConfig(base, override)

      expect(result.search.defaultMode).toBe('neural')  // 保持
      expect(result.search.defaultNumResults).toBe(5)    // 覆盖
      expect(result.search.defaultMaxCharacters).toBe(10000)  // 保持
    })
  })
})
```

---

## 四、Test Fixtures（测试数据）

### 4.1 fixtures/valid-config.yaml

```yaml
exa:
  base_url: https://api.exa.ai

  search:
    default_mode: neural
    default_num_results: 10
    default_max_characters: 10000

  get_contents:
    default_max_characters: 10000
    include_highlights: false
    include_summary: false
```

### 4.2 fixtures/partial-config.yaml

```yaml
exa:
  search:
    default_mode: fast
```

### 4.3 fixtures/invalid-config.yaml

```yaml
exa:
  search:
    default_mode: invalid_mode
    default_num_results: 999
```

---

## 五、Test Coverage Requirements（覆盖率要求）

| 模块 | 行覆盖率 | 分支覆盖率 | 函数覆盖率 |
|------|----------|------------|------------|
| loader.ts | ≥90% | ≥85% | 100% |
| schema.ts | ≥95% | ≥90% | 100% |
| merge.ts | ≥90% | ≥85% | 100% |
| defaults.ts | 100% | 100% | 100% |

---

## 六、Test Commands（测试命令）

```bash
# 运行所有测试
pnpm test

# 运行配置加载器测试
pnpm test src/config/tools/exa

# 运行覆盖率报告
pnpm test:coverage

# 监视模式
pnpm test:watch
```

---

## 七、Edge Cases（边界情况）

### 7.1 需要测试的边界情况

| 场景 | 预期行为 |
|------|----------|
| 两个配置文件都不存在 | 使用默认配置 |
| 只有用户级配置 | 合并用户配置 |
| 只有项目级配置 | 合并项目配置 |
| 配置文件为空 | 使用默认配置 |
| 配置文件只有部分字段 | 部分覆盖 |
| YAML 语法错误 | 抛出 ConfigParseError |
| 无效配置值 | 抛出 ConfigValidationError |
| 环境变量未设置 | 抛出 MissingApiKeyError |
| 配置目录不存在 | 不报错，使用默认值 |

---

## 八、文档自检

- [x] 测试策略明确
- [x] 单元测试覆盖 Schema 验证
- [x] 集成测试覆盖加载流程
- [x] 边界情况列举完整
- [x] 测试数据文件定义
- [x] 覆盖率要求明确
