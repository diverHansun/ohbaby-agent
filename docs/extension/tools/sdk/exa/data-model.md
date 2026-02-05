# Exa Tools Module - data-model.md

本文档定义 `exa` 工具模块的数据模型与类型定义。

---

## 一、Type Definitions（类型定义）

### 1.1 配置类型

```typescript
/**
 * Exa 配置
 */
interface ExaConfig {
  /** API 密钥（来自 .env） */
  apiKey: string

  /** API 端点（来自 exa.yaml） */
  baseURL?: string

  /** 搜索配置 */
  search: ExaSearchConfig

  /** 内容获取配置 */
  getContents: ExaGetContentsConfig
}

/**
 * 搜索配置
 */
interface ExaSearchConfig {
  /** 默认搜索模式 */
  defaultMode: 'neural' | 'keyword' | 'auto' | 'fast'

  /** 默认结果数量 */
  defaultNumResults: number

  /** 默认文本最大字符数 */
  defaultMaxCharacters: number
}

/**
 * 内容获取配置
 */
interface ExaGetContentsConfig {
  /** 默认文本最大字符数 */
  defaultMaxCharacters: number

  /** 默认是否包含高亮 */
  includeHighlights: boolean

  /** 默认是否包含摘要 */
  includeSummary: boolean
}
```

---

## 二、Zod Schemas（参数 Schema）

### 2.1 exa_search 参数

```typescript
import { z } from 'zod'

export const ExaSearchParamsSchema = z.object({
  /**
   * 搜索查询
   */
  query: z.string()
    .min(1)
    .describe('Search query string'),

  /**
   * 搜索类型
   */
  type: z.enum(['neural', 'keyword', 'auto', 'fast'])
    .optional()
    .describe('Search type: neural=semantic, keyword=exact, auto=automatic, fast=quick'),

  /**
   * 结果数量
   */
  num_results: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of results to return (1-100)'),

  /**
   * 包含的域名
   */
  include_domains: z.array(z.string())
    .optional()
    .describe('List of domains to include in search'),

  /**
   * 排除的域名
   */
  exclude_domains: z.array(z.string())
    .optional()
    .describe('List of domains to exclude from search'),

  /**
   * 发布起始日期
   */
  start_published_date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Start date for published content (YYYY-MM-DD)'),

  /**
   * 发布结束日期
   */
  end_published_date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('End date for published content (YYYY-MM-DD)'),

  /**
   * 内容分类
   */
  category: z.enum([
    'company',
    'research paper',
    'news',
    'pdf',
    'github',
    'tweet',
    'personal site',
    'financial report',
    'people'
  ])
    .optional()
    .describe('Content category filter'),

  /**
   * 是否包含文本内容
   */
  include_text: z.boolean()
    .optional()
    .default(true)
    .describe('Whether to include text content in results'),

  /**
   * 文本最大字符数
   */
  max_characters: z.number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .default(10000)
    .describe('Maximum characters for text content'),
})

export type ExaSearchParams = z.infer<typeof ExaSearchParamsSchema>
```

### 2.2 exa_get_contents 参数

```typescript
export const ExaGetContentsParamsSchema = z.object({
  /**
   * URL 列表
   */
  urls: z.array(z.string().url())
    .min(1)
    .max(100)
    .describe('List of URLs to retrieve content from'),

  /**
   * 是否获取文本
   */
  text: z.boolean()
    .optional()
    .default(true)
    .describe('Whether to retrieve text content'),

  /**
   * 文本最大字符数
   */
  max_characters: z.number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .default(10000)
    .describe('Maximum characters for text content'),

  /**
   * 是否获取高亮
   */
  highlights: z.boolean()
    .optional()
    .default(false)
    .describe('Whether to retrieve highlights'),

  /**
   * 是否获取摘要
   */
  summary: z.boolean()
    .optional()
    .default(false)
    .describe('Whether to retrieve summary'),
})

export type ExaGetContentsParams = z.infer<typeof ExaGetContentsParamsSchema>
```

---

## 三、Output Types（输出类型）

### 3.1 搜索输出

```typescript
/**
 * exa_search 工具输出
 */
interface ExaSearchOutput {
  /** 搜索结果列表 */
  results: ExaSearchResult[]

  /** 上下文信息 */
  context?: string

  /** 请求 ID */
  request_id: string

  /** 费用信息 */
  cost_dollars?: ExaCostInfo
}

/**
 * 单个搜索结果
 */
interface ExaSearchResult {
  /** 标题 */
  title: string | null

  /** URL */
  url: string

  /** 发布日期 */
  published_date?: string

  /** 作者 */
  author?: string

  /** 相关性分数 */
  score?: number

  /** 文本内容 */
  text?: string

  /** 高亮片段 */
  highlights?: string[]

  /** 摘要 */
  summary?: string
}
```

### 3.2 内容获取输出

```typescript
/**
 * exa_get_contents 工具输出
 */
interface ExaGetContentsOutput {
  /** 内容结果列表 */
  results: ExaContentResult[]

  /** 请求 ID */
  request_id: string

  /** 费用信息 */
  cost_dollars?: ExaCostInfo
}

/**
 * 单个内容结果
 */
interface ExaContentResult {
  /** URL */
  url: string

  /** 标题 */
  title: string | null

  /** 文本内容 */
  text?: string

  /** 高亮片段 */
  highlights?: string[]

  /** 摘要 */
  summary?: string
}
```

### 3.3 费用信息

```typescript
/**
 * API 调用费用
 */
interface ExaCostInfo {
  /** 总费用（美元） */
  total: number

  /** 搜索费用 */
  search?: {
    neural?: number
    keyword?: number
  }

  /** 内容费用 */
  contents?: {
    text?: number
    highlights?: number
    summary?: number
  }
}
```

---

## 四、Error Types（错误类型）

```typescript
/**
 * Exa 工具错误
 */
interface ExaToolError {
  /** 错误类型 */
  type: 'ExaAPIError' | 'ExaConfigError' | 'ExaValidationError'

  /** HTTP 状态码 */
  code?: number

  /** 错误信息 */
  message: string

  /** 用户建议 */
  suggestion: string
}

/**
 * 工具返回结果（成功或失败）
 */
type ExaToolResult<T> =
  | { content: string; metadata: T }
  | { error: ExaToolError }
```

---

## 五、SDK Type Mappings（SDK 类型映射）

### 5.1 参数映射（snake_case → camelCase）

| 工具参数 | SDK 参数 |
|----------|----------|
| `query` | `query` |
| `type` | `type` |
| `num_results` | `numResults` |
| `include_domains` | `includeDomains` |
| `exclude_domains` | `excludeDomains` |
| `start_published_date` | `startPublishedDate` |
| `end_published_date` | `endPublishedDate` |
| `category` | `category` |
| `include_text` | `contents.text` |
| `max_characters` | `contents.text.maxCharacters` |
| `highlights` | `contents.highlights` |
| `summary` | `contents.summary` |

### 5.2 响应映射（camelCase → snake_case）

| SDK 响应 | 工具输出 |
|----------|----------|
| `results` | `results` |
| `requestId` | `request_id` |
| `costDollars` | `cost_dollars` |
| `publishedDate` | `published_date` |

---

## 六、Configuration File Schema（配置文件结构）

### 6.1 exa.yaml 结构

```yaml
# .iris-code/tools/exa.yaml

exa:
  # API 配置
  base_url: https://api.exa.ai  # 可选，默认官方端点

  # 搜索默认配置
  search:
    default_mode: neural        # neural | keyword | auto | fast
    default_num_results: 10     # 1-100
    default_max_characters: 10000

  # 内容获取默认配置
  get_contents:
    default_max_characters: 10000
    include_highlights: false
    include_summary: false
```

### 6.2 配置 Schema

```typescript
const ExaConfigFileSchema = z.object({
  exa: z.object({
    base_url: z.string().url().optional(),

    search: z.object({
      default_mode: z.enum(['neural', 'keyword', 'auto', 'fast']).default('neural'),
      default_num_results: z.number().int().min(1).max(100).default(10),
      default_max_characters: z.number().int().min(1).max(100000).default(10000),
    }).optional(),

    get_contents: z.object({
      default_max_characters: z.number().int().min(1).max(100000).default(10000),
      include_highlights: z.boolean().default(false),
      include_summary: z.boolean().default(false),
    }).optional(),
  }),
})
```

---

## 七、Enumerations（枚举）

### 7.1 搜索类型

```typescript
enum ExaSearchType {
  /** 语义搜索 */
  NEURAL = 'neural',

  /** 关键词搜索 */
  KEYWORD = 'keyword',

  /** 自动选择 */
  AUTO = 'auto',

  /** 快速搜索 */
  FAST = 'fast',
}
```

### 7.2 内容分类

```typescript
enum ExaCategory {
  COMPANY = 'company',
  RESEARCH_PAPER = 'research paper',
  NEWS = 'news',
  PDF = 'pdf',
  GITHUB = 'github',
  TWEET = 'tweet',
  PERSONAL_SITE = 'personal site',
  FINANCIAL_REPORT = 'financial report',
  PEOPLE = 'people',
}
```

---

## 八、文档自检

- [x] 所有类型定义完整
- [x] Zod Schema 与 TypeScript 类型对应
- [x] SDK 类型映射清晰
- [x] 配置文件结构定义完整
- [x] 枚举值与 SDK 一致
