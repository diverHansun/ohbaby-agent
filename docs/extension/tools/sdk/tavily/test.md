# Tavily Tools Module - test.md

本文档定义 `tavily` 工具模块的测试策略与测试用例设计。

---

## 一、Test Strategy（测试策略）

### 1.1 测试层次

| 层次 | 范围 | 方法 | 工具 |
|------|------|------|------|
| 单元测试 | 各组件独立功能 | Mock SDK | Vitest |
| 集成测试 | 组件协作 | Mock SDK | Vitest |
| E2E 测试 | 完整工具调用 | 真实 API | 手动/CI |

### 1.2 测试原则

- **隔离性**: 单元测试不依赖外部服务
- **覆盖率**: 核心逻辑覆盖率 > 80%
- **可重复**: 测试结果稳定可重复
- **快速反馈**: 单元测试快速执行

### 1.3 Mock 策略

| 组件 | Mock 方式 | 说明 |
|------|-----------|------|
| @tavily/core | vi.mock | 完全 Mock SDK |
| config/tools/tavily | vi.mock | Mock 配置加载 |
| process.env | vi.stubEnv | 环境变量 |

---

## 二、Unit Tests（单元测试）

### 2.1 client.ts 测试

**文件**: `__tests__/client.test.ts`

```typescript
describe('TavilyClientManager', () => {
  describe('getClient', () => {
    it('应该返回 TavilyClient 实例', async () => {
      // Given
      mockGetConfig.mockResolvedValue(mockConfig)

      // When
      const client = await getClient()

      // Then
      expect(client).toBeDefined()
      expect(client.search).toBeDefined()
    })

    it('应该使用单例模式', async () => {
      // Given
      mockGetConfig.mockResolvedValue(mockConfig)

      // When
      const client1 = await getClient()
      const client2 = await getClient()

      // Then
      expect(client1).toBe(client2)
    })

    it('当 API Key 为空时应该抛出错误', async () => {
      // Given
      mockGetConfig.mockResolvedValue({ ...mockConfig, apiKey: '' })

      // When & Then
      await expect(getClient()).rejects.toThrow('TAVILY_API_KEY')
    })
  })

  describe('resetInstance', () => {
    it('应该重置客户端实例', async () => {
      // Given
      const client1 = await getClient()
      resetInstance()

      // When
      const client2 = await getClient()

      // Then
      expect(client1).not.toBe(client2)
    })
  })
})
```

### 2.2 参数转换测试

**文件**: `__tests__/transform.test.ts`

```typescript
describe('transformSearchParams', () => {
  const defaults: TavilySearchDefaults = {
    defaultSearchDepth: 'basic',
    defaultTopic: 'general',
    defaultMaxResults: 5,
    defaultIncludeAnswer: false,
    defaultIncludeImages: false,
    defaultIncludeRawContent: false,
    defaultTimeout: 60
  }

  it('应该转换 snake_case 为 camelCase', () => {
    // Given
    const params = {
      query: 'test',
      search_depth: 'advanced',
      max_results: 10
    }

    // When
    const result = transformSearchParams(params, defaults)

    // Then
    expect(result.searchDepth).toBe('advanced')
    expect(result.maxResults).toBe(10)
  })

  it('应该使用默认值填充缺失参数', () => {
    // Given
    const params = { query: 'test' }

    // When
    const result = transformSearchParams(params, defaults)

    // Then
    expect(result.searchDepth).toBe('basic')
    expect(result.maxResults).toBe(5)
    expect(result.topic).toBe('general')
  })

  it('用户参数应该覆盖默认值', () => {
    // Given
    const params = {
      query: 'test',
      max_results: 20
    }

    // When
    const result = transformSearchParams(params, defaults)

    // Then
    expect(result.maxResults).toBe(20)
  })
})
```

### 2.3 结果格式化测试

**文件**: `__tests__/formatter.test.ts`

```typescript
describe('formatSearchResult', () => {
  it('应该格式化搜索结果为 Markdown', () => {
    // Given
    const response: TavilySearchResponse = {
      query: 'test query',
      responseTime: 1000,
      images: [],
      results: [
        {
          title: 'Test Title',
          url: 'https://example.com',
          content: 'Test content',
          score: 0.95,
          publishedDate: '2024-01-01'
        }
      ],
      requestId: 'req-123'
    }

    // When
    const result = formatSearchResult(response)

    // Then
    expect(result).toContain('## 搜索结果: test query')
    expect(result).toContain('Test Title')
    expect(result).toContain('https://example.com')
    expect(result).toContain('0.95')
  })

  it('当有 AI 答案时应该包含答案部分', () => {
    // Given
    const response = {
      ...mockResponse,
      answer: 'AI generated answer'
    }

    // When
    const result = formatSearchResult(response)

    // Then
    expect(result).toContain('### AI 回答')
    expect(result).toContain('AI generated answer')
  })

  it('当没有结果时应该显示提示', () => {
    // Given
    const response = {
      ...mockResponse,
      results: []
    }

    // When
    const result = formatSearchResult(response)

    // Then
    expect(result).toContain('未找到相关结果')
  })
})

describe('formatExtractResult', () => {
  it('应该包含成功和失败的 URL', () => {
    // Given
    const response: TavilyExtractResponse = {
      results: [
        { url: 'https://success.com', rawContent: 'content' }
      ],
      failedResults: [
        { url: 'https://failed.com', error: 'Not found' }
      ],
      responseTime: 1000,
      requestId: 'req-123'
    }

    // When
    const result = formatExtractResult(response)

    // Then
    expect(result).toContain('### 成功提取')
    expect(result).toContain('https://success.com')
    expect(result).toContain('### 提取失败')
    expect(result).toContain('https://failed.com')
    expect(result).toContain('Not found')
  })
})
```

### 2.4 参数验证测试

**文件**: `__tests__/schema.test.ts`

```typescript
describe('TavilySearchParamsSchema', () => {
  it('应该验证有效参数', () => {
    // Given
    const params = {
      query: 'test query',
      max_results: 10
    }

    // When
    const result = TavilySearchParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(true)
  })

  it('当 query 为空时应该失败', () => {
    // Given
    const params = { query: '' }

    // When
    const result = TavilySearchParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(false)
  })

  it('当 max_results 超出范围时应该失败', () => {
    // Given
    const params = { query: 'test', max_results: 100 }

    // When
    const result = TavilySearchParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(false)
  })

  it('当 search_depth 值无效时应该失败', () => {
    // Given
    const params = { query: 'test', search_depth: 'invalid' }

    // When
    const result = TavilySearchParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(false)
  })
})

describe('TavilyExtractParamsSchema', () => {
  it('应该验证有效的 URL 数组', () => {
    // Given
    const params = {
      urls: ['https://example.com', 'https://test.com']
    }

    // When
    const result = TavilyExtractParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(true)
  })

  it('当 urls 为空数组时应该失败', () => {
    // Given
    const params = { urls: [] }

    // When
    const result = TavilyExtractParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(false)
  })

  it('当 urls 超过 20 个时应该失败', () => {
    // Given
    const urls = Array(21).fill('https://example.com')
    const params = { urls }

    // When
    const result = TavilyExtractParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(false)
  })

  it('当 URL 格式无效时应该失败', () => {
    // Given
    const params = { urls: ['not-a-url'] }

    // When
    const result = TavilyExtractParamsSchema.safeParse(params)

    // Then
    expect(result.success).toBe(false)
  })
})
```

---

## 三、Integration Tests（集成测试）

### 3.1 工具执行集成测试

**文件**: `__tests__/integration/tavily-search.test.ts`

```typescript
describe('TavilySearchTool Integration', () => {
  beforeEach(() => {
    vi.mock('@tavily/core', () => ({
      tavily: vi.fn(() => mockClient)
    }))
    vi.mock('@/config/tools/tavily', () => ({
      TavilyConfigLoader: vi.fn(() => mockLoader)
    }))
    resetInstance()
  })

  it('应该完成完整的搜索流程', async () => {
    // Given
    mockClient.search.mockResolvedValue(mockSearchResponse)
    const params = { query: 'test query' }

    // When
    const result = await TavilySearchTool.execute(params, mockContext)

    // Then
    expect(mockClient.search).toHaveBeenCalledWith(
      'test query',
      expect.objectContaining({
        searchDepth: 'basic',
        maxResults: 5
      })
    )
    expect(result).toContain('## 搜索结果')
  })

  it('当 SDK 调用失败时应该返回错误信息', async () => {
    // Given
    mockClient.search.mockRejectedValue(new Error('API Error'))
    const params = { query: 'test' }

    // When
    const result = await TavilySearchTool.execute(params, mockContext)

    // Then
    expect(result).toContain('执行失败')
    expect(result).toContain('API Error')
  })
})
```

### 3.2 配置整合测试

**文件**: `__tests__/integration/config.test.ts`

```typescript
describe('Config Integration', () => {
  it('应该正确合并 .env 和 yaml 配置', async () => {
    // Given
    vi.stubEnv('TAVILY_API_KEY', 'test-api-key')
    mockLoader.load.mockResolvedValue({
      baseURL: 'https://custom.api.com',
      search: { defaultMaxResults: 10 }
    })

    // When
    const config = await getConfig()

    // Then
    expect(config.apiKey).toBe('test-api-key')
    expect(config.baseURL).toBe('https://custom.api.com')
    expect(config.search.defaultMaxResults).toBe(10)
  })
})
```

---

## 四、Error Handling Tests（错误处理测试）

### 4.1 错误类型测试

```typescript
describe('Error Handling', () => {
  describe('formatError', () => {
    it('应该格式化 ZodError', () => {
      // Given
      const error = new ZodError([
        { path: ['query'], message: 'Required', code: 'invalid_type' }
      ])

      // When
      const result = formatError(error)

      // Then
      expect(result).toContain('参数验证失败')
      expect(result).toContain('query')
    })

    it('应该格式化 ConfigError', () => {
      // Given
      const error = new ConfigError('API Key missing')

      // When
      const result = formatError(error)

      // Then
      expect(result).toContain('配置错误')
      expect(result).toContain('.env')
    })

    it('应该格式化未知错误', () => {
      // Given
      const error = new Error('Unknown error')

      // When
      const result = formatError(error)

      // Then
      expect(result).toContain('执行失败')
    })
  })
})
```

---

## 五、Test Fixtures（测试数据）

### 5.1 Mock 配置

```typescript
// __tests__/fixtures/config.ts
export const mockConfig: TavilyToolConfig = {
  apiKey: 'test-api-key',
  baseURL: 'https://api.tavily.com',
  search: {
    defaultSearchDepth: 'basic',
    defaultTopic: 'general',
    defaultMaxResults: 5,
    defaultIncludeAnswer: false,
    defaultIncludeImages: false,
    defaultIncludeRawContent: false,
    defaultTimeout: 60
  },
  extract: {
    defaultExtractDepth: 'basic',
    defaultFormat: 'markdown',
    defaultIncludeImages: false,
    defaultTimeout: 60
  },
  crawl: {
    defaultMaxDepth: 2,
    defaultMaxBreadth: 10,
    defaultLimit: 20,
    defaultExtractDepth: 'basic',
    defaultFormat: 'markdown',
    defaultAllowExternal: false,
    defaultIncludeImages: false,
    defaultTimeout: 120
  },
  map: {
    defaultMaxDepth: 2,
    defaultMaxBreadth: 10,
    defaultLimit: 100,
    defaultAllowExternal: false,
    defaultTimeout: 60
  }
}
```

### 5.2 Mock 响应

```typescript
// __tests__/fixtures/responses.ts
export const mockSearchResponse: TavilySearchResponse = {
  query: 'test query',
  responseTime: 1000,
  images: [],
  results: [
    {
      title: 'Test Result 1',
      url: 'https://example.com/1',
      content: 'Test content 1',
      score: 0.95,
      publishedDate: '2024-01-01'
    },
    {
      title: 'Test Result 2',
      url: 'https://example.com/2',
      content: 'Test content 2',
      score: 0.85,
      publishedDate: '2024-01-02'
    }
  ],
  requestId: 'req-123'
}

export const mockExtractResponse: TavilyExtractResponse = {
  results: [
    {
      url: 'https://example.com',
      rawContent: '# Page Content\n\nThis is the extracted content.'
    }
  ],
  failedResults: [],
  responseTime: 2000,
  requestId: 'req-456'
}

export const mockCrawlResponse: TavilyCrawlResponse = {
  baseUrl: 'https://example.com',
  responseTime: 5000,
  results: [
    {
      url: 'https://example.com/page1',
      rawContent: 'Page 1 content',
      images: []
    }
  ],
  requestId: 'req-789'
}

export const mockMapResponse: TavilyMapResponse = {
  baseUrl: 'https://example.com',
  responseTime: 3000,
  results: [
    'https://example.com/',
    'https://example.com/about',
    'https://example.com/docs'
  ],
  requestId: 'req-abc'
}
```

---

## 六、Test Coverage Requirements（覆盖率要求）

| 模块 | 语句覆盖 | 分支覆盖 | 函数覆盖 |
|------|----------|----------|----------|
| client.ts | > 90% | > 80% | 100% |
| config.ts | > 90% | > 80% | 100% |
| types.ts (Schema) | > 80% | > 70% | 100% |
| tavily-search.ts | > 85% | > 75% | 100% |
| tavily-extract.ts | > 85% | > 75% | 100% |
| tavily-crawl.ts | > 85% | > 75% | 100% |
| tavily-map.ts | > 85% | > 75% | 100% |
| formatter.ts | > 90% | > 80% | 100% |

---

## 七、E2E Test Considerations（E2E 测试考虑）

### 7.1 E2E 测试条件

- 需要有效的 TAVILY_API_KEY
- 需要网络访问
- 会产生 API 调用费用

### 7.2 E2E 测试场景

| 场景 | 验证点 |
|------|--------|
| 基本搜索 | 返回有效结果 |
| 带选项搜索 | 选项生效 |
| 内容提取 | 正确提取内容 |
| 批量提取 | 处理部分失败 |
| 网站爬取 | 遵循深度限制 |
| 结构映射 | 返回 URL 列表 |

### 7.3 E2E 测试执行

```bash
# 设置环境变量
export TAVILY_API_KEY=tvly-xxx

# 运行 E2E 测试
pnpm test:e2e -- --grep "tavily"
```

---

## 八、文档自检

- [x] 测试策略清晰
- [x] 单元测试覆盖核心功能
- [x] 集成测试覆盖组件协作
- [x] 错误处理测试完整
- [x] Mock 数据充分
- [x] 覆盖率要求明确
