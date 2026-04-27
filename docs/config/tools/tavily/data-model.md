# Tavily Config Loader - data-model.md

本文档定义 `config/tools/tavily` 配置加载器的数据模型与类型定义。

---

## 一、Configuration File Structure（配置文件结构）

### 1.1 tavily.yaml 文件格式

```yaml
# .ohbaby-code/tools/tavily.yaml 或 ~/.config/ohbaby-code/tools/tavily.yaml

tavily:
  # API 端点（可选，默认官方端点）
  base_url: https://api.tavily.com

  # 代理配置（可选）
  proxy:
    http: http://proxy.example.com:8080
    https: https://proxy.example.com:8080

  # 搜索默认配置
  search:
    # 默认搜索深度: basic | advanced
    default_search_depth: basic

    # 默认搜索主题: general | news | finance
    default_topic: general

    # 默认返回结果数量 (1-20)
    default_max_results: 5

    # 默认是否包含 AI 答案
    default_include_answer: false

    # 默认是否包含图片
    default_include_images: false

    # 默认原始内容格式: false | markdown | text
    default_include_raw_content: false

    # 默认超时时间（秒）
    default_timeout: 60

  # 提取默认配置
  extract:
    # 默认提取深度: basic | advanced
    default_extract_depth: basic

    # 默认输出格式: markdown | text
    default_format: markdown

    # 默认是否包含图片
    default_include_images: false

    # 默认超时时间（秒）
    default_timeout: 60

  # 爬取默认配置
  crawl:
    # 默认最大爬取深度 (1-10)
    default_max_depth: 2

    # 默认每层最大链接数 (1-100)
    default_max_breadth: 10

    # 默认最大返回页面数 (1-100)
    default_limit: 20

    # 默认提取深度: basic | advanced
    default_extract_depth: basic

    # 默认输出格式: markdown | text
    default_format: markdown

    # 默认是否允许爬取外部链接
    default_allow_external: false

    # 默认是否包含图片
    default_include_images: false

    # 默认超时时间（秒）
    default_timeout: 120

  # 映射默认配置
  map:
    # 默认最大映射深度 (1-10)
    default_max_depth: 2

    # 默认每层最大链接数 (1-100)
    default_max_breadth: 10

    # 默认最大返回 URL 数 (1-1000)
    default_limit: 100

    # 默认是否包含外部链接
    default_allow_external: false

    # 默认超时时间（秒）
    default_timeout: 60
```

---

## 二、Type Definitions（类型定义）

### 2.1 配置文件类型（YAML 结构）

```typescript
/**
 * tavily.yaml 文件结构
 */
interface TavilyConfigFile {
  tavily: {
    /** API 端点 */
    base_url?: string

    /** 代理配置 */
    proxy?: {
      http?: string
      https?: string
    }

    /** 搜索配置 */
    search?: {
      default_search_depth?: 'basic' | 'advanced'
      default_topic?: 'general' | 'news' | 'finance'
      default_max_results?: number
      default_include_answer?: boolean
      default_include_images?: boolean
      default_include_raw_content?: false | 'markdown' | 'text'
      default_timeout?: number
    }

    /** 提取配置 */
    extract?: {
      default_extract_depth?: 'basic' | 'advanced'
      default_format?: 'markdown' | 'text'
      default_include_images?: boolean
      default_timeout?: number
    }

    /** 爬取配置 */
    crawl?: {
      default_max_depth?: number
      default_max_breadth?: number
      default_limit?: number
      default_extract_depth?: 'basic' | 'advanced'
      default_format?: 'markdown' | 'text'
      default_allow_external?: boolean
      default_include_images?: boolean
      default_timeout?: number
    }

    /** 映射配置 */
    map?: {
      default_max_depth?: number
      default_max_breadth?: number
      default_limit?: number
      default_allow_external?: boolean
      default_timeout?: number
    }
  }
}
```

### 2.2 运行时配置类型

```typescript
/**
 * 运行时 Tavily 配置（合并后的完整配置）
 */
interface TavilyFileConfig {
  /** API 端点 */
  baseURL: string

  /** 代理配置 */
  proxy?: TavilyProxyConfig

  /** 搜索配置 */
  search: TavilySearchDefaults

  /** 提取配置 */
  extract: TavilyExtractDefaults

  /** 爬取配置 */
  crawl: TavilyCrawlDefaults

  /** 映射配置 */
  map: TavilyMapDefaults
}

/**
 * 代理配置
 */
interface TavilyProxyConfig {
  http?: string
  https?: string
}

/**
 * 搜索默认配置
 */
interface TavilySearchDefaults {
  defaultSearchDepth: 'basic' | 'advanced'
  defaultTopic: 'general' | 'news' | 'finance'
  defaultMaxResults: number
  defaultIncludeAnswer: boolean
  defaultIncludeImages: boolean
  defaultIncludeRawContent: false | 'markdown' | 'text'
  defaultTimeout: number
}

/**
 * 提取默认配置
 */
interface TavilyExtractDefaults {
  defaultExtractDepth: 'basic' | 'advanced'
  defaultFormat: 'markdown' | 'text'
  defaultIncludeImages: boolean
  defaultTimeout: number
}

/**
 * 爬取默认配置
 */
interface TavilyCrawlDefaults {
  defaultMaxDepth: number
  defaultMaxBreadth: number
  defaultLimit: number
  defaultExtractDepth: 'basic' | 'advanced'
  defaultFormat: 'markdown' | 'text'
  defaultAllowExternal: boolean
  defaultIncludeImages: boolean
  defaultTimeout: number
}

/**
 * 映射默认配置
 */
interface TavilyMapDefaults {
  defaultMaxDepth: number
  defaultMaxBreadth: number
  defaultLimit: number
  defaultAllowExternal: boolean
  defaultTimeout: number
}
```

---

## 三、Default Values（默认值）

### 3.1 默认值表

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `base_url` | `https://api.tavily.com` | Tavily 官方 API |
| `proxy.http` | 无 | HTTP 代理 |
| `proxy.https` | 无 | HTTPS 代理 |
| `search.default_search_depth` | `basic` | 基础搜索 |
| `search.default_topic` | `general` | 通用主题 |
| `search.default_max_results` | `5` | 返回 5 条结果 |
| `search.default_include_answer` | `false` | 不包含 AI 答案 |
| `search.default_include_images` | `false` | 不包含图片 |
| `search.default_include_raw_content` | `false` | 不包含原始内容 |
| `search.default_timeout` | `60` | 60 秒超时 |
| `extract.default_extract_depth` | `basic` | 基础提取 |
| `extract.default_format` | `markdown` | Markdown 格式 |
| `extract.default_include_images` | `false` | 不包含图片 |
| `extract.default_timeout` | `60` | 60 秒超时 |
| `crawl.default_max_depth` | `2` | 爬取 2 层 |
| `crawl.default_max_breadth` | `10` | 每层 10 个链接 |
| `crawl.default_limit` | `20` | 最多 20 个页面 |
| `crawl.default_extract_depth` | `basic` | 基础提取 |
| `crawl.default_format` | `markdown` | Markdown 格式 |
| `crawl.default_allow_external` | `false` | 不爬取外部链接 |
| `crawl.default_include_images` | `false` | 不包含图片 |
| `crawl.default_timeout` | `120` | 120 秒超时 |
| `map.default_max_depth` | `2` | 映射 2 层 |
| `map.default_max_breadth` | `10` | 每层 10 个链接 |
| `map.default_limit` | `100` | 最多 100 个 URL |
| `map.default_allow_external` | `false` | 不包含外部链接 |
| `map.default_timeout` | `60` | 60 秒超时 |

---

## 四、Config Path Types（配置路径类型）

### 4.1 路径解析结果

```typescript
/**
 * 配置文件路径信息
 */
interface ConfigPathInfo {
  /** 项目级配置路径 */
  projectPath: string | null

  /** 用户级配置路径 */
  userPath: string | null

  /** 项目级配置是否存在 */
  projectExists: boolean

  /** 用户级配置是否存在 */
  userExists: boolean
}
```

### 4.2 路径常量

```typescript
/**
 * 配置文件名
 */
export const CONFIG_FILE_NAME = 'tavily.yaml'

/**
 * 项目配置相对路径
 */
export const PROJECT_CONFIG_PATH = '.ohbaby-code/tools/tavily.yaml'

/**
 * 用户配置目录名
 */
export const USER_CONFIG_DIR = 'ohbaby-code/tools'
```

---

## 五、Validation Types（验证类型）

### 5.1 验证结果

```typescript
/**
 * 配置验证结果
 */
interface ConfigValidationResult {
  /** 是否有效 */
  valid: boolean

  /** 错误列表 */
  errors?: string[]

  /** 警告列表 */
  warnings?: string[]
}
```

### 5.2 验证错误类型

```typescript
/**
 * 配置错误类型
 */
enum ConfigErrorType {
  /** 文件解析错误 */
  PARSE_ERROR = 'PARSE_ERROR',

  /** Schema 验证错误 */
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  /** 值超出范围 */
  OUT_OF_RANGE = 'OUT_OF_RANGE',
}

/**
 * 配置错误
 */
interface ConfigError {
  type: ConfigErrorType
  field: string
  message: string
}
```

---

## 六、Field Name Mapping（字段名映射）

### 6.1 YAML 到 TypeScript 映射

| YAML 字段 (snake_case) | TypeScript 字段 (camelCase) |
|------------------------|----------------------------|
| `base_url` | `baseURL` |
| `default_search_depth` | `defaultSearchDepth` |
| `default_topic` | `defaultTopic` |
| `default_max_results` | `defaultMaxResults` |
| `default_include_answer` | `defaultIncludeAnswer` |
| `default_include_images` | `defaultIncludeImages` |
| `default_include_raw_content` | `defaultIncludeRawContent` |
| `default_timeout` | `defaultTimeout` |
| `default_extract_depth` | `defaultExtractDepth` |
| `default_format` | `defaultFormat` |
| `default_max_depth` | `defaultMaxDepth` |
| `default_max_breadth` | `defaultMaxBreadth` |
| `default_limit` | `defaultLimit` |
| `default_allow_external` | `defaultAllowExternal` |

### 6.2 转换函数类型

```typescript
/**
 * 配置转换函数
 */
type ConfigTransformer = (fileConfig: TavilyConfigFile) => TavilyFileConfig
```

---

## 七、文档自检

- [x] 配置文件结构定义完整
- [x] TypeScript 类型定义完整
- [x] 默认值明确定义
- [x] 字段名映射清晰
- [x] 验证类型完整
