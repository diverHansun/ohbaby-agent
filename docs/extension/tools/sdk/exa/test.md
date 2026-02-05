# Exa Tools Module - test.md

本文档定义 `exa` 工具模块的测试策略与测试用例。

---

## 一、Test Strategy（测试策略）

### 1.1 测试层次

| 层次 | 类型 | 目的 | 覆盖 |
|------|------|------|------|
| L1 | 单元测试 | 测试单个函数/方法 | 参数验证、格式转换 |
| L2 | 集成测试 | 测试模块间交互 | 客户端、配置加载 |
| L3 | E2E 测试 | 测试完整流程 | 工具执行端到端 |

### 1.2 测试工具

- **测试框架**：Vitest
- **Mock 工具**：Vitest mock
- **覆盖率**：vitest coverage

### 1.3 测试文件结构

```
src/extensions/tools/sdk/exa/
└── __tests__/
    ├── client.test.ts        # ExaClient 测试
    ├── config.test.ts        # ExaConfigManager 测试
    ├── exa-search.test.ts    # exa_search 工具测试
    ├── get-contents.test.ts  # exa_get_contents 工具测试
    ├── types.test.ts         # Zod Schema 测试
    └── fixtures/
        ├── mock-responses.ts # Mock 响应数据
        └── mock-config.ts    # Mock 配置数据
```

---

## 二、Unit Tests（单元测试）

### 2.1 types.test.ts - Schema 验证测试

```typescript
import { describe, it, expect } from 'vitest'
import { ExaSearchParamsSchema, ExaGetContentsParamsSchema } from '../types'

describe('ExaSearchParamsSchema', () => {
  describe('query validation', () => {
    it('should accept valid query string', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'artificial intelligence',
      })
      expect(result.success).toBe(true)
    })

    it('should reject empty query', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: '',
      })
      expect(result.success).toBe(false)
    })

    it('should require query field', () => {
      const result = ExaSearchParamsSchema.safeParse({})
      expect(result.success).toBe(false)
    })
  })

  describe('type validation', () => {
    it('should accept valid search types', () => {
      const types = ['neural', 'keyword', 'auto', 'fast']
      types.forEach(type => {
        const result = ExaSearchParamsSchema.safeParse({
          query: 'test',
          type,
        })
        expect(result.success).toBe(true)
      })
    })

    it('should reject invalid search type', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'test',
        type: 'invalid',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('num_results validation', () => {
    it('should accept valid num_results', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'test',
        num_results: 10,
      })
      expect(result.success).toBe(true)
    })

    it('should reject num_results < 1', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'test',
        num_results: 0,
      })
      expect(result.success).toBe(false)
    })

    it('should reject num_results > 100', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'test',
        num_results: 101,
      })
      expect(result.success).toBe(false)
    })

    it('should default to 10', () => {
      const result = ExaSearchParamsSchema.parse({
        query: 'test',
      })
      expect(result.num_results).toBe(10)
    })
  })

  describe('date validation', () => {
    it('should accept valid date format', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'test',
        start_published_date: '2024-01-01',
        end_published_date: '2024-12-31',
      })
      expect(result.success).toBe(true)
    })

    it('should reject invalid date format', () => {
      const result = ExaSearchParamsSchema.safeParse({
        query: 'test',
        start_published_date: '01-01-2024',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('category validation', () => {
    it('should accept valid categories', () => {
      const categories = [
        'company', 'research paper', 'news', 'pdf',
        'github', 'tweet', 'personal site', 'financial report', 'people'
      ]
      categories.forEach(category => {
        const result = ExaSearchParamsSchema.safeParse({
          query: 'test',
          category,
        })
        expect(result.success).toBe(true)
      })
    })
  })
})

describe('ExaGetContentsParamsSchema', () => {
  describe('urls validation', () => {
    it('should accept valid URLs', () => {
      const result = ExaGetContentsParamsSchema.safeParse({
        urls: ['https://example.com', 'https://test.com'],
      })
      expect(result.success).toBe(true)
    })

    it('should reject invalid URLs', () => {
      const result = ExaGetContentsParamsSchema.safeParse({
        urls: ['not-a-url'],
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty array', () => {
      const result = ExaGetContentsParamsSchema.safeParse({
        urls: [],
      })
      expect(result.success).toBe(false)
    })

    it('should reject more than 100 URLs', () => {
      const urls = Array(101).fill('https://example.com')
      const result = ExaGetContentsParamsSchema.safeParse({ urls })
      expect(result.success).toBe(false)
    })
  })

  describe('defaults', () => {
    it('should default text to true', () => {
      const result = ExaGetContentsParamsSchema.parse({
        urls: ['https://example.com'],
      })
      expect(result.text).toBe(true)
    })

    it('should default highlights to false', () => {
      const result = ExaGetContentsParamsSchema.parse({
        urls: ['https://example.com'],
      })
      expect(result.highlights).toBe(false)
    })

    it('should default max_characters to 10000', () => {
      const result = ExaGetContentsParamsSchema.parse({
        urls: ['https://example.com'],
      })
      expect(result.max_characters).toBe(10000)
    })
  })
})
```

### 2.2 client.test.ts - 客户端测试

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ExaClient } from '../client'
import { exaConfig } from '../config'

// Mock exa-js
vi.mock('exa-js', () => ({
  default: vi.fn().mockImplementation(() => ({
    search: vi.fn(),
    getContents: vi.fn(),
  })),
}))

// Mock config
vi.mock('../config', () => ({
  exaConfig: {
    getConfig: vi.fn().mockReturnValue({
      apiKey: 'test-api-key',
      baseURL: 'https://api.exa.ai',
    }),
  },
}))

describe('ExaClient', () => {
  beforeEach(() => {
    ExaClient.resetInstance()
  })

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ExaClient.getInstance()
      const instance2 = ExaClient.getInstance()
      expect(instance1).toBe(instance2)
    })

    it('should create client with config', () => {
      const instance = ExaClient.getInstance()
      expect(instance.getClient()).toBeDefined()
    })
  })

  describe('resetInstance', () => {
    it('should reset singleton instance', () => {
      const instance1 = ExaClient.getInstance()
      ExaClient.resetInstance()
      const instance2 = ExaClient.getInstance()
      expect(instance1).not.toBe(instance2)
    })
  })

  describe('getClient', () => {
    it('should return Exa client', () => {
      const instance = ExaClient.getInstance()
      const client = instance.getClient()
      expect(client).toBeDefined()
      expect(client.search).toBeDefined()
      expect(client.getContents).toBeDefined()
    })
  })
})
```

### 2.3 config.test.ts - 配置测试

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ExaConfigManager } from '../config'

describe('ExaConfigManager', () => {
  let configManager: ExaConfigManager

  beforeEach(() => {
    configManager = ExaConfigManager.getInstance()
    // Reset environment
    delete process.env.EXA_API_KEY
  })

  describe('loadFromEnv', () => {
    it('should load API key from environment', () => {
      process.env.EXA_API_KEY = 'test-key'
      const config = configManager.loadFromEnv()
      expect(config.apiKey).toBe('test-key')
    })

    it('should throw if API key is missing', () => {
      expect(() => configManager.loadFromEnv()).toThrow('EXA_API_KEY is not set')
    })

    it('should load base URL from environment', () => {
      process.env.EXA_API_KEY = 'test-key'
      process.env.EXA_BASE_URL = 'https://custom.api.com'
      const config = configManager.loadFromEnv()
      expect(config.baseURL).toBe('https://custom.api.com')
    })
  })

  describe('validate', () => {
    it('should return valid for complete config', () => {
      process.env.EXA_API_KEY = 'test-key'
      configManager.loadFromEnv()
      const result = configManager.validate()
      expect(result.valid).toBe(true)
    })

    it('should return invalid for missing API key', () => {
      const result = configManager.validate()
      expect(result.valid).toBe(false)
      expect(result.error).toContain('EXA_API_KEY')
    })
  })
})
```

---

## 三、Integration Tests（集成测试）

### 3.1 exa-search.test.ts

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExaSearchTool } from '../exa-search'
import { ExaClient } from '../client'

// Mock fixtures
const mockSearchResponse = {
  results: [
    {
      title: 'Test Article',
      url: 'https://example.com/article',
      publishedDate: '2024-01-15',
      author: 'Test Author',
      score: 0.95,
      text: 'Article content here...',
    },
  ],
  requestId: 'req_123',
  costDollars: { total: 0.001 },
}

describe('ExaSearchTool', () => {
  let mockExa: any

  beforeEach(() => {
    ExaClient.resetInstance()
    mockExa = {
      search: vi.fn().mockResolvedValue(mockSearchResponse),
      findSimilar: vi.fn().mockResolvedValue(mockSearchResponse),
    }
    vi.spyOn(ExaClient, 'getInstance').mockReturnValue({
      getClient: () => mockExa,
    } as any)
  })

  describe('execute', () => {
    it('should execute search with valid params', async () => {
      const result = await ExaSearchTool.execute(
        { query: 'AI news', num_results: 5 },
        {} as any
      )

      expect(result).toHaveProperty('content')
      expect(result.content).toContain('Test Article')
      expect(mockExa.search).toHaveBeenCalledWith('AI news', expect.any(Object))
    })

    it('should convert snake_case to camelCase', async () => {
      await ExaSearchTool.execute(
        {
          query: 'test',
          num_results: 5,
          include_domains: ['example.com'],
          start_published_date: '2024-01-01',
        },
        {} as any
      )

      expect(mockExa.search).toHaveBeenCalledWith('test', expect.objectContaining({
        numResults: 5,
        includeDomains: ['example.com'],
        startPublishedDate: '2024-01-01',
      }))
    })

    it('should handle search type parameter', async () => {
      await ExaSearchTool.execute(
        { query: 'test', type: 'keyword' },
        {} as any
      )

      expect(mockExa.search).toHaveBeenCalledWith('test', expect.objectContaining({
        type: 'keyword',
      }))
    })

    it('should include text content by default', async () => {
      await ExaSearchTool.execute(
        { query: 'test' },
        {} as any
      )

      expect(mockExa.search).toHaveBeenCalledWith('test', expect.objectContaining({
        contents: expect.objectContaining({
          text: expect.any(Object),
        }),
      }))
    })

    it('should handle API errors', async () => {
      mockExa.search.mockRejectedValue(new Error('Unauthorized'))

      const result = await ExaSearchTool.execute(
        { query: 'test' },
        {} as any
      )

      expect(result).toHaveProperty('error')
      expect(result.error.type).toBe('ExaSearchError')
    })
  })

  describe('output format', () => {
    it('should return markdown formatted content', async () => {
      const result = await ExaSearchTool.execute(
        { query: 'test' },
        {} as any
      )

      expect(result.content).toContain('# Exa Search Results')
      expect(result.content).toContain('**Title:**')
      expect(result.content).toContain('**URL:**')
    })

    it('should include metadata', async () => {
      const result = await ExaSearchTool.execute(
        { query: 'test' },
        {} as any
      )

      expect(result.metadata).toHaveProperty('num_results')
      expect(result.metadata).toHaveProperty('request_id')
    })
  })
})
```

### 3.2 get-contents.test.ts

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExaGetContentsTool } from '../get-contents'
import { ExaClient } from '../client'

const mockContentsResponse = {
  results: [
    {
      url: 'https://example.com',
      title: 'Test Page',
      text: 'Page content here...',
      highlights: ['Important highlight'],
      summary: 'Page summary',
    },
  ],
  requestId: 'req_456',
  costDollars: { total: 0.0005 },
}

describe('ExaGetContentsTool', () => {
  let mockExa: any

  beforeEach(() => {
    ExaClient.resetInstance()
    mockExa = {
      getContents: vi.fn().mockResolvedValue(mockContentsResponse),
    }
    vi.spyOn(ExaClient, 'getInstance').mockReturnValue({
      getClient: () => mockExa,
    } as any)
  })

  describe('execute', () => {
    it('should execute getContents with valid URLs', async () => {
      const result = await ExaGetContentsTool.execute(
        { urls: ['https://example.com'] },
        {} as any
      )

      expect(result).toHaveProperty('content')
      expect(result.content).toContain('Test Page')
      expect(mockExa.getContents).toHaveBeenCalled()
    })

    it('should handle multiple URLs', async () => {
      await ExaGetContentsTool.execute(
        { urls: ['https://example1.com', 'https://example2.com'] },
        {} as any
      )

      expect(mockExa.getContents).toHaveBeenCalledWith(
        ['https://example1.com', 'https://example2.com'],
        expect.any(Object)
      )
    })

    it('should include highlights when requested', async () => {
      await ExaGetContentsTool.execute(
        { urls: ['https://example.com'], highlights: true },
        {} as any
      )

      expect(mockExa.getContents).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ highlights: true })
      )
    })

    it('should include summary when requested', async () => {
      await ExaGetContentsTool.execute(
        { urls: ['https://example.com'], summary: true },
        {} as any
      )

      expect(mockExa.getContents).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ summary: true })
      )
    })

    it('should handle max_characters parameter', async () => {
      await ExaGetContentsTool.execute(
        { urls: ['https://example.com'], max_characters: 5000 },
        {} as any
      )

      expect(mockExa.getContents).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          text: { maxCharacters: 5000 },
        })
      )
    })
  })

  describe('error handling', () => {
    it('should handle API errors gracefully', async () => {
      mockExa.getContents.mockRejectedValue(new Error('Rate limit exceeded'))

      const result = await ExaGetContentsTool.execute(
        { urls: ['https://example.com'] },
        {} as any
      )

      expect(result).toHaveProperty('error')
      expect(result.error.type).toBe('ExaGetContentsError')
      expect(result.error.suggestion).toBeDefined()
    })
  })
})
```

---

## 四、Test Coverage Requirements（覆盖率要求）

| 模块 | 行覆盖率 | 分支覆盖率 | 函数覆盖率 |
|------|----------|------------|------------|
| types.ts | ≥90% | ≥85% | 100% |
| client.ts | ≥95% | ≥90% | 100% |
| config.ts | ≥90% | ≥85% | 100% |
| exa-search.ts | ≥85% | ≥80% | 100% |
| get-contents.ts | ≥85% | ≥80% | 100% |

---

## 五、Test Commands（测试命令）

```bash
# 运行所有测试
pnpm test

# 运行 exa 模块测试
pnpm test src/extensions/tools/sdk/exa

# 运行覆盖率报告
pnpm test:coverage

# 监视模式
pnpm test:watch
```

---

## 六、Mock Data（Mock 数据）

### 6.1 fixtures/mock-responses.ts

```typescript
export const mockSearchResponse = {
  results: [
    {
      title: 'Test Article',
      url: 'https://example.com/article',
      publishedDate: '2024-01-15',
      author: 'Test Author',
      score: 0.95,
      text: 'Article content here...',
    },
  ],
  requestId: 'req_123',
  costDollars: { total: 0.001 },
}

export const mockContentsResponse = {
  results: [
    {
      url: 'https://example.com',
      title: 'Test Page',
      text: 'Page content here...',
      highlights: ['Important highlight'],
      summary: 'Page summary',
    },
  ],
  requestId: 'req_456',
  costDollars: { total: 0.0005 },
}

export const mockErrorResponse = {
  statusCode: 401,
  message: 'Invalid API key',
}
```

### 6.2 fixtures/mock-config.ts

```typescript
export const mockExaConfig = {
  apiKey: 'test-api-key',
  baseURL: 'https://api.exa.ai',
  search: {
    defaultMode: 'neural',
    defaultNumResults: 10,
    defaultMaxCharacters: 10000,
  },
  getContents: {
    defaultMaxCharacters: 10000,
    includeHighlights: false,
    includeSummary: false,
  },
}
```

---

## 七、文档自检

- [x] 测试策略覆盖所有层次
- [x] 单元测试覆盖核心逻辑
- [x] 集成测试覆盖工具执行
- [x] 覆盖率要求明确
- [x] Mock 数据完整
- [x] 测试命令清晰
