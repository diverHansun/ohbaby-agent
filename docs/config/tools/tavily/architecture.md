# Tavily Config Loader - architecture.md

本文档描述 `config/tools/tavily` 配置加载器的内部架构与设计模式。

---

## 一、Architecture Overview（架构概览）

### 模块定位

Tavily 配置加载器是 ohbaby-agent config 模块的一部分，负责加载和管理 Tavily 工具的配置文件。遵循 XDG 标准配置方案。

### 模块结构

```
src/config/tools/tavily/
├── index.ts              # 导出入口
├── loader.ts             # 配置加载器
├── schema.ts             # 配置 Schema 定义
├── defaults.ts           # 默认配置值
└── __tests__/
    └── loader.test.ts    # 加载器测试
```

### 架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Config Module                                    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                      Tool Config Loaders                           │ │
│  │                                                                    │ │
│  │  ┌────────────────┐  ┌─────────────────┐  ┌────────────────┐      │ │
│  │  │ exa/loader.ts  │  │tavily/loader.ts │  │ .../loader.ts  │      │ │
│  │  └───────┬────────┘  └───────┬─────────┘  └───────┬────────┘      │ │
│  │          │                   │                    │                │ │
│  └──────────┼───────────────────┼────────────────────┼────────────────┘ │
│             │                   │                    │                  │
└─────────────┼───────────────────┼────────────────────┼──────────────────┘
              │                   │                    │
              ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Config File Sources                               │
│                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐               │
│  │    Project Level       │    │      User Level         │               │
│  │                        │    │                         │               │
│  │  {project}/            │    │  ~/.config/ohbaby-agent/   │               │
│  │    .ohbaby-agent/         │    │    tools/               │               │
│  │      tools/            │    │      tavily.yaml        │               │
│  │        tavily.yaml     │    │      ...                │               │
│  │                        │    │                         │               │
│  │  优先级: 1 (最高)      │    │  优先级: 2              │               │
│  │                        │    │                         │               │
│  └────────────────────────┘    └────────────────────────┘               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 TavilyConfigLoader（loader.ts）

**职责**: 加载和合并 Tavily 配置

```typescript
class TavilyConfigLoader {
  private projectRoot: string
  private userConfigDir: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
    this.userConfigDir = this.resolveUserConfigDir()
  }

  /**
   * 加载配置
   * 优先级: 项目级 > 用户级 > 默认值
   */
  async load(): Promise<TavilyFileConfig> {
    // 1. 加载默认配置
    let config = { ...defaultTavilyConfig }

    // 2. 加载用户级配置（如果存在）
    const userConfig = await this.loadUserConfig()
    if (userConfig) {
      config = this.mergeConfig(config, userConfig)
    }

    // 3. 加载项目级配置（如果存在）
    const projectConfig = await this.loadProjectConfig()
    if (projectConfig) {
      config = this.mergeConfig(config, projectConfig)
    }

    // 4. 验证配置
    this.validate(config)

    return config
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<TavilyFileConfig> {
    return this.load()
  }

  /**
   * 验证配置
   */
  validate(config: unknown): { valid: boolean; errors?: string[] } {
    const result = TavilyConfigFileSchema.safeParse(config)
    if (!result.success) {
      return {
        valid: false,
        errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      }
    }
    return { valid: true }
  }
}
```

### 2.2 Config Schema（schema.ts）

**职责**: 定义配置文件结构验证

```typescript
import { z } from 'zod'

/**
 * 搜索配置 Schema
 */
const SearchConfigSchema = z.object({
  default_search_depth: z.enum(['basic', 'advanced'])
    .optional()
    .default('basic'),

  default_topic: z.enum(['general', 'news', 'finance'])
    .optional()
    .default('general'),

  default_max_results: z.number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5),

  default_include_answer: z.boolean()
    .optional()
    .default(false),

  default_include_images: z.boolean()
    .optional()
    .default(false),

  default_include_raw_content: z.union([
    z.literal(false),
    z.enum(['markdown', 'text'])
  ])
    .optional()
    .default(false),

  default_timeout: z.number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .default(60)
}).optional()

/**
 * 提取配置 Schema
 */
const ExtractConfigSchema = z.object({
  default_extract_depth: z.enum(['basic', 'advanced'])
    .optional()
    .default('basic'),

  default_format: z.enum(['markdown', 'text'])
    .optional()
    .default('markdown'),

  default_include_images: z.boolean()
    .optional()
    .default(false),

  default_timeout: z.number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .default(60)
}).optional()

/**
 * 爬取配置 Schema
 */
const CrawlConfigSchema = z.object({
  default_max_depth: z.number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(2),

  default_max_breadth: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10),

  default_limit: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20),

  default_extract_depth: z.enum(['basic', 'advanced'])
    .optional()
    .default('basic'),

  default_format: z.enum(['markdown', 'text'])
    .optional()
    .default('markdown'),

  default_allow_external: z.boolean()
    .optional()
    .default(false),

  default_include_images: z.boolean()
    .optional()
    .default(false),

  default_timeout: z.number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .default(120)
}).optional()

/**
 * 映射配置 Schema
 */
const MapConfigSchema = z.object({
  default_max_depth: z.number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(2),

  default_max_breadth: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10),

  default_limit: z.number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(100),

  default_allow_external: z.boolean()
    .optional()
    .default(false),

  default_timeout: z.number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .default(60)
}).optional()

/**
 * 代理配置 Schema
 */
const ProxyConfigSchema = z.object({
  http: z.string().url().optional(),
  https: z.string().url().optional()
}).optional()

/**
 * 完整配置文件 Schema
 */
export const TavilyConfigFileSchema = z.object({
  tavily: z.object({
    base_url: z.string().url().optional(),
    proxy: ProxyConfigSchema,
    search: SearchConfigSchema,
    extract: ExtractConfigSchema,
    crawl: CrawlConfigSchema,
    map: MapConfigSchema
  })
})
```

### 2.3 Default Config（defaults.ts）

**职责**: 提供默认配置值

```typescript
export const DEFAULT_BASE_URL = 'https://api.tavily.com'

export const DEFAULT_SEARCH_CONFIG = {
  defaultSearchDepth: 'basic' as const,
  defaultTopic: 'general' as const,
  defaultMaxResults: 5,
  defaultIncludeAnswer: false,
  defaultIncludeImages: false,
  defaultIncludeRawContent: false as const,
  defaultTimeout: 60
}

export const DEFAULT_EXTRACT_CONFIG = {
  defaultExtractDepth: 'basic' as const,
  defaultFormat: 'markdown' as const,
  defaultIncludeImages: false,
  defaultTimeout: 60
}

export const DEFAULT_CRAWL_CONFIG = {
  defaultMaxDepth: 2,
  defaultMaxBreadth: 10,
  defaultLimit: 20,
  defaultExtractDepth: 'basic' as const,
  defaultFormat: 'markdown' as const,
  defaultAllowExternal: false,
  defaultIncludeImages: false,
  defaultTimeout: 120
}

export const DEFAULT_MAP_CONFIG = {
  defaultMaxDepth: 2,
  defaultMaxBreadth: 10,
  defaultLimit: 100,
  defaultAllowExternal: false,
  defaultTimeout: 60
}

export const defaultTavilyConfig: TavilyFileConfig = {
  baseURL: DEFAULT_BASE_URL,
  search: DEFAULT_SEARCH_CONFIG,
  extract: DEFAULT_EXTRACT_CONFIG,
  crawl: DEFAULT_CRAWL_CONFIG,
  map: DEFAULT_MAP_CONFIG
}
```

---

## 三、Design Patterns（设计模式）

### 3.1 策略模式（Strategy）

配置加载使用策略模式，支持不同来源:

```typescript
interface ConfigSource {
  load(): Promise<Partial<TavilyConfigFile> | null>
  exists(): Promise<boolean>
}

class ProjectConfigSource implements ConfigSource { ... }
class UserConfigSource implements ConfigSource { ... }
```

### 3.2 合并策略

深度合并配置，后加载的覆盖先加载的:

```typescript
function mergeConfig(
  base: TavilyFileConfig,
  override: Partial<TavilyConfigFile>
): TavilyFileConfig {
  return {
    ...base,
    baseURL: override.tavily?.base_url ?? base.baseURL,
    proxy: override.tavily?.proxy ?? base.proxy,
    search: {
      ...base.search,
      ...transformSearchConfig(override.tavily?.search)
    },
    extract: {
      ...base.extract,
      ...transformExtractConfig(override.tavily?.extract)
    },
    crawl: {
      ...base.crawl,
      ...transformCrawlConfig(override.tavily?.crawl)
    },
    map: {
      ...base.map,
      ...transformMapConfig(override.tavily?.map)
    }
  }
}
```

---

## 四、Config File Locations（配置文件位置）

### 4.1 XDG 标准路径

遵循 XDG Base Directory Specification:

| 级别 | 路径 | 环境变量 |
|------|------|----------|
| 项目级 | `{project}/.ohbaby-agent/tools/tavily.yaml` | - |
| 用户级 (Linux/Mac) | `~/.config/ohbaby-agent/tools/tavily.yaml` | `$XDG_CONFIG_HOME` |
| 用户级 (Windows) | `%APPDATA%/ohbaby-agent/tools/tavily.yaml` | `%APPDATA%` |

### 4.2 优先级

```
项目级配置  -->  覆盖  -->  用户级配置  -->  覆盖  -->  默认配置
   1                           2                          3
```

### 4.3 路径解析

```typescript
function resolveUserConfigDir(): string {
  // Windows
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'ohbaby-agent', 'tools')
  }

  // Linux/Mac (XDG)
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ||
    path.join(os.homedir(), '.config')
  return path.join(xdgConfigHome, 'ohbaby-agent', 'tools')
}

function resolveProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.ohbaby-agent', 'tools', 'tavily.yaml')
}
```

---

## 五、Loading Process（加载流程）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     TavilyConfigLoader.load()                            │
│                                                                          │
│  1. 初始化默认配置                                                        │
│     config = defaultTavilyConfig                                         │
│     │                                                                    │
│     ▼                                                                    │
│  2. 检查用户级配置是否存在                                                │
│     ~/.config/ohbaby-agent/tools/tavily.yaml                                │
│     │                                                                    │
│     ├── 存在 --> 加载并合并                                              │
│     │   config = merge(config, userConfig)                               │
│     │                                                                    │
│     └── 不存在 --> 跳过                                                  │
│     │                                                                    │
│     ▼                                                                    │
│  3. 检查项目级配置是否存在                                                │
│     {project}/.ohbaby-agent/tools/tavily.yaml                               │
│     │                                                                    │
│     ├── 存在 --> 加载并合并（覆盖用户级）                                 │
│     │   config = merge(config, projectConfig)                            │
│     │                                                                    │
│     └── 不存在 --> 跳过                                                  │
│     │                                                                    │
│     ▼                                                                    │
│  4. 验证配置完整性                                                        │
│     validate(config)                                                     │
│     │                                                                    │
│     ├── 有效 --> 返回配置                                                │
│     │                                                                    │
│     └── 无效 --> 抛出错误                                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 六、Integration Points（集成点）

### 6.1 与 Tavily 工具模块的集成

```typescript
// extension/tools/sdk/tavily/config.ts
import { TavilyConfigLoader } from '@/config/tools/tavily'

export class TavilyConfigManager {
  private loader: TavilyConfigLoader
  private config: TavilyFileConfig | null = null

  constructor(projectRoot: string) {
    this.loader = new TavilyConfigLoader(projectRoot)
  }

  async getConfig(): Promise<TavilyFileConfig> {
    if (!this.config) {
      this.config = await this.loader.load()
    }
    return this.config
  }
}
```

### 6.2 与 Config 模块主入口的集成

```typescript
// config/index.ts
import { TavilyConfigLoader } from './tools/tavily'

export class ConfigManager {
  private loaders: Map<string, ConfigLoader>

  constructor(projectRoot: string) {
    this.loaders = new Map([
      ['tavily', new TavilyConfigLoader(projectRoot)],
      // 其他加载器...
    ])
  }

  async loadToolConfig(tool: string): Promise<any> {
    const loader = this.loaders.get(tool)
    if (!loader) {
      throw new Error(`Unknown tool config: ${tool}`)
    }
    return loader.load()
  }
}
```

---

## 七、Error Handling（错误处理）

### 7.1 错误类型

| 错误类型 | 场景 | 处理 |
|----------|------|------|
| ConfigFileNotFound | 配置文件不存在 | 使用默认配置，不报错 |
| ConfigParseError | YAML 解析失败 | 抛出错误，提示文件位置 |
| ConfigValidationError | 配置项无效 | 抛出错误，列出无效项 |

### 7.2 错误消息

```typescript
class ConfigParseError extends Error {
  constructor(filePath: string, cause: Error) {
    super(`Failed to parse config file: ${filePath}\n${cause.message}`)
    this.name = 'ConfigParseError'
  }
}

class ConfigValidationError extends Error {
  constructor(errors: string[]) {
    super(`Invalid Tavily configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`)
    this.name = 'ConfigValidationError'
  }
}
```

---

## 八、Dependencies（依赖）

### 8.1 外部依赖

| 依赖 | 用途 |
|------|------|
| zod | 配置 Schema 验证 |
| js-yaml | YAML 解析 |

### 8.2 内部依赖

| 模块 | 用途 |
|------|------|
| utils/path | 路径解析 |
| utils/fs | 文件读取 |

---

## 九、文档自检

- [x] 架构服务于配置加载需求
- [x] XDG 标准配置路径清晰
- [x] 优先级规则明确
- [x] 与其他模块集成点明确
- [x] 错误处理策略完整
