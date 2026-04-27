# Exa Config Loader - data-model.md

本文档定义 `config/tools/exa` 配置加载器的数据模型与类型定义。

---

## 一、Configuration File Structure（配置文件结构）

### 1.1 exa.yaml 文件格式

```yaml
# .ohbaby-code/tools/exa.yaml 或 ~/.config/ohbaby-code/tools/exa.yaml

exa:
  # API 端点（可选，默认官方端点）
  base_url: https://api.exa.ai

  # 搜索默认配置
  search:
    # 默认搜索类型: neural | keyword | auto | fast
    default_mode: neural

    # 默认返回结果数量 (1-100)
    default_num_results: 10

    # 默认文本最大字符数 (1-100000)
    default_max_characters: 10000

  # 内容获取默认配置
  get_contents:
    # 默认文本最大字符数 (1-100000)
    default_max_characters: 10000

    # 默认是否包含高亮
    include_highlights: false

    # 默认是否包含摘要
    include_summary: false
```

---

## 二、Type Definitions（类型定义）

### 2.1 配置文件类型（YAML 结构）

```typescript
/**
 * exa.yaml 文件结构
 */
interface ExaConfigFile {
  exa: {
    /** API 端点 */
    base_url?: string

    /** 搜索配置 */
    search?: {
      default_mode?: 'neural' | 'keyword' | 'auto' | 'fast'
      default_num_results?: number
      default_max_characters?: number
    }

    /** 内容获取配置 */
    get_contents?: {
      default_max_characters?: number
      include_highlights?: boolean
      include_summary?: boolean
    }
  }
}
```

### 2.2 运行时配置类型

```typescript
/**
 * 运行时 Exa 配置（合并后的完整配置）
 */
interface ExaConfig {
  /** API 密钥（来自 .env） */
  apiKey: string

  /** API 端点 */
  baseURL: string

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

## 三、Zod Schemas（Schema 定义）

### 3.1 配置文件 Schema

```typescript
import { z } from 'zod'

/**
 * 搜索配置 Schema
 */
const SearchConfigSchema = z.object({
  default_mode: z.enum(['neural', 'keyword', 'auto', 'fast'])
    .optional()
    .default('neural'),

  default_num_results: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10),

  default_max_characters: z.number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .default(10000),
}).optional()

/**
 * 内容获取配置 Schema
 */
const GetContentsConfigSchema = z.object({
  default_max_characters: z.number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .default(10000),

  include_highlights: z.boolean()
    .optional()
    .default(false),

  include_summary: z.boolean()
    .optional()
    .default(false),
}).optional()

/**
 * 完整配置文件 Schema
 */
export const ExaConfigFileSchema = z.object({
  exa: z.object({
    base_url: z.string().url().optional(),
    search: SearchConfigSchema,
    get_contents: GetContentsConfigSchema,
  }),
})

export type ExaConfigFileType = z.infer<typeof ExaConfigFileSchema>
```

---

## 四、Default Values（默认值）

### 4.1 默认配置常量

```typescript
/**
 * 默认 API 端点
 */
export const DEFAULT_BASE_URL = 'https://api.exa.ai'

/**
 * 默认搜索配置
 */
export const DEFAULT_SEARCH_CONFIG: ExaSearchConfig = {
  defaultMode: 'neural',
  defaultNumResults: 10,
  defaultMaxCharacters: 10000,
}

/**
 * 默认内容获取配置
 */
export const DEFAULT_GET_CONTENTS_CONFIG: ExaGetContentsConfig = {
  defaultMaxCharacters: 10000,
  includeHighlights: false,
  includeSummary: false,
}

/**
 * 完整默认配置
 */
export const defaultExaConfig: ExaConfig = {
  apiKey: '',
  baseURL: DEFAULT_BASE_URL,
  search: DEFAULT_SEARCH_CONFIG,
  getContents: DEFAULT_GET_CONTENTS_CONFIG,
}
```

### 4.2 默认值表

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `base_url` | `https://api.exa.ai` | Exa 官方 API |
| `search.default_mode` | `neural` | 语义搜索 |
| `search.default_num_results` | `10` | 返回 10 条结果 |
| `search.default_max_characters` | `10000` | 10K 字符 |
| `get_contents.default_max_characters` | `10000` | 10K 字符 |
| `get_contents.include_highlights` | `false` | 不包含高亮 |
| `get_contents.include_summary` | `false` | 不包含摘要 |

---

## 五、Config Path Types（配置路径类型）

### 5.1 路径解析结果

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

### 5.2 路径常量

```typescript
/**
 * 配置文件名
 */
export const CONFIG_FILE_NAME = 'exa.yaml'

/**
 * 项目配置相对路径
 */
export const PROJECT_CONFIG_PATH = '.ohbaby-code/tools/exa.yaml'

/**
 * 用户配置目录名
 */
export const USER_CONFIG_DIR = 'ohbaby-code/tools'
```

---

## 六、Validation Types（验证类型）

### 6.1 验证结果

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

### 6.2 验证错误类型

```typescript
/**
 * 配置错误类型
 */
enum ConfigErrorType {
  /** 文件解析错误 */
  PARSE_ERROR = 'PARSE_ERROR',

  /** Schema 验证错误 */
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  /** 缺少必需配置 */
  MISSING_REQUIRED = 'MISSING_REQUIRED',

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

## 七、Merge Strategy Types（合并策略类型）

### 7.1 合并选项

```typescript
/**
 * 配置合并选项
 */
interface MergeOptions {
  /** 是否深度合并 */
  deep: boolean

  /** 是否覆盖数组 */
  overwriteArrays: boolean
}

/**
 * 默认合并选项
 */
export const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  deep: true,
  overwriteArrays: true,
}
```

### 7.2 合并结果

```typescript
/**
 * 配置合并结果
 */
interface MergeResult<T> {
  /** 合并后的配置 */
  config: T

  /** 合并来源 */
  sources: ConfigSource[]
}

/**
 * 配置来源
 */
enum ConfigSource {
  DEFAULT = 'default',
  USER = 'user',
  PROJECT = 'project',
}
```

---

## 八、Environment Types（环境类型）

### 8.1 环境变量

```typescript
/**
 * Exa 相关环境变量
 */
interface ExaEnvironment {
  /** API 密钥 */
  EXA_API_KEY?: string
}
```

### 8.2 环境变量名常量

```typescript
/**
 * 环境变量名
 */
export const ENV_VARS = {
  API_KEY: 'EXA_API_KEY',
} as const
```

---

## 九、Field Name Mapping（字段名映射）

### 9.1 YAML 到 TypeScript 映射

| YAML 字段 (snake_case) | TypeScript 字段 (camelCase) |
|------------------------|----------------------------|
| `base_url` | `baseURL` |
| `default_mode` | `defaultMode` |
| `default_num_results` | `defaultNumResults` |
| `default_max_characters` | `defaultMaxCharacters` |
| `include_highlights` | `includeHighlights` |
| `include_summary` | `includeSummary` |
| `get_contents` | `getContents` |

### 9.2 转换函数类型

```typescript
/**
 * 配置转换函数
 */
type ConfigTransformer = (fileConfig: ExaConfigFile) => ExaConfig
```

---

## 十、文档自检

- [x] 配置文件结构定义完整
- [x] TypeScript 类型定义完整
- [x] Zod Schema 与类型对应
- [x] 默认值明确定义
- [x] 字段名映射清晰
- [x] 验证类型完整
