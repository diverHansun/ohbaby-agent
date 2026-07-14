# Tavily Config Loader - dfd-interface.md

本文档定义 `config/tools/tavily` 配置加载器的数据流与接口设计。

---

## 一、Data Flow Diagrams（数据流图）

### 1.1 配置加载数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Config Load Request                               │
│                                                                          │
│  TavilyConfigLoader.load(projectRoot)                                    │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Path Resolution                                  │
│                                                                          │
│  1. 解析项目配置路径                                                      │
│     projectPath = {projectRoot}/.ohbaby/tools/tavily.yaml             │
│                                                                          │
│  2. 解析用户配置路径                                                      │
│     Windows: %USERPROFILE%/.ohbaby/tools/tavily.yaml                       │
│     Linux/Mac: ~/.ohbaby/tools/tavily.yaml                     │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Config Loading                                   │
│                                                                          │
│  ┌─────────────────────┐                                                │
│  │  默认配置           │ <-- 初始化                                      │
│  │  defaultTavilyConfig│                                                │
│  └──────────┬──────────┘                                                │
│             │                                                            │
│             ▼                                                            │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  用户级配置          │ <--  │  ~/.config/.../     │                   │
│  │  (如果存在)          │      │  tavily.yaml        │                   │
│  └──────────┬──────────┘      └─────────────────────┘                   │
│             │ merge                                                      │
│             ▼                                                            │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  项目级配置          │ <--  │  .ohbaby/tools/  │                   │
│  │  (如果存在)          │      │  tavily.yaml        │                   │
│  └──────────┬──────────┘      └─────────────────────┘                   │
│             │ merge                                                      │
│             ▼                                                            │
│  ┌─────────────────────┐                                                │
│  │  字段名转换          │                                                │
│  │  snake_case -->      │                                                │
│  │  camelCase          │                                                │
│  └──────────┬──────────┘                                                │
│             │                                                            │
└─────────────┼────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Validation                                      │
│                                                                          │
│  1. Schema 验证（Zod）                                                   │
│  2. 值范围验证                                                           │
│                                                                          │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  验证通过            │      │  验证失败            │                   │
│  │                     │      │                     │                   │
│  │  返回               │      │  抛出               │                   │
│  │  TavilyFileConfig   │      │  ConfigValidation   │                   │
│  │                     │      │  Error              │                   │
│  └─────────────────────┘      └─────────────────────┘                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 配置合并数据流

```
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   默认配置     │   │  用户级配置    │   │  项目级配置    │
│               │   │               │   │               │
│  search:      │   │  search:      │   │  search:      │
│    depth:basic│   │    depth:adv  │   │  (未定义)     │
│    max: 5     │   │  (未定义)     │   │    max: 10    │
│               │   │               │   │               │
│  crawl:       │   │  crawl:       │   │  crawl:       │
│    limit: 20  │   │    limit: 30  │   │  (未定义)     │
│               │   │               │   │               │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        │                   ▼                   │
        │           ┌───────────────┐           │
        └──────────>│   第一次合并   │<──────────┘
                    │               │
                    │  search:      │
                    │    depth: adv │ <-- 来自用户级
                    │    max: 10    │ <-- 来自项目级
                    │               │
                    │  crawl:       │
                    │    limit: 30  │ <-- 来自用户级
                    │               │
                    └───────────────┘
```

---

## 二、External Interfaces（外部接口）

### 2.1 TavilyConfigLoader 类

```typescript
/**
 * Tavily 配置加载器
 */
export class TavilyConfigLoader {
  /**
   * 创建加载器实例
   * @param projectRoot 项目根目录
   */
  constructor(projectRoot: string)

  /**
   * 加载配置
   * @returns 完整的 Tavily 配置
   * @throws ConfigValidationError 配置无效时
   */
  load(): Promise<TavilyFileConfig>

  /**
   * 重新加载配置
   * @returns 重新加载的配置
   */
  reload(): Promise<TavilyFileConfig>

  /**
   * 验证配置
   * @param config 要验证的配置
   * @returns 验证结果
   */
  validate(config: unknown): ConfigValidationResult

  /**
   * 获取配置文件路径信息
   * @returns 路径信息
   */
  getPathInfo(): ConfigPathInfo
}
```

### 2.2 导出函数

```typescript
/**
 * 创建配置加载器
 */
export function createTavilyConfigLoader(projectRoot: string): TavilyConfigLoader

/**
 * 加载 Tavily 配置（便捷函数）
 */
export async function loadTavilyConfig(projectRoot: string): Promise<TavilyFileConfig>

/**
 * 获取默认配置
 */
export function getDefaultTavilyConfig(): TavilyFileConfig
```

---

## 三、Internal Interfaces（内部接口）

### 3.1 文件读取接口

```typescript
/**
 * 配置文件读取器
 */
interface ConfigFileReader {
  /**
   * 检查文件是否存在
   */
  exists(path: string): Promise<boolean>

  /**
   * 读取并解析 YAML 文件
   */
  read(path: string): Promise<TavilyConfigFile | null>
}
```

### 3.2 路径解析接口

```typescript
/**
 * 路径解析器
 */
interface PathResolver {
  /**
   * 解析项目配置路径
   */
  resolveProjectPath(projectRoot: string): string

  /**
   * 解析用户配置路径
   */
  resolveUserPath(): string
}
```

### 3.3 配置合并接口

```typescript
/**
 * 配置合并器
 */
interface ConfigMerger {
  /**
   * 合并两个配置
   */
  merge(base: TavilyFileConfig, override: Partial<TavilyConfigFile>): TavilyFileConfig
}
```

### 3.4 配置转换接口

```typescript
/**
 * 配置转换器
 * 将 YAML 文件中的 snake_case 转换为 camelCase
 */
interface ConfigTransformer {
  /**
   * 转换搜索配置
   */
  transformSearchConfig(config: TavilyConfigFile['tavily']['search']): TavilySearchDefaults

  /**
   * 转换提取配置
   */
  transformExtractConfig(config: TavilyConfigFile['tavily']['extract']): TavilyExtractDefaults

  /**
   * 转换爬取配置
   */
  transformCrawlConfig(config: TavilyConfigFile['tavily']['crawl']): TavilyCrawlDefaults

  /**
   * 转换映射配置
   */
  transformMapConfig(config: TavilyConfigFile['tavily']['map']): TavilyMapDefaults
}
```

---

## 四、Usage Examples（使用示例）

### 4.1 基本使用

```typescript
import { TavilyConfigLoader } from '@/config/tools/tavily'

// 创建加载器
const loader = new TavilyConfigLoader('/path/to/project')

// 加载配置
const config = await loader.load()

console.log(config.search.defaultMaxResults)  // 5 或配置的值
console.log(config.baseURL)                   // API 端点
```

### 4.2 便捷函数

```typescript
import { loadTavilyConfig } from '@/config/tools/tavily'

const config = await loadTavilyConfig('/path/to/project')
```

### 4.3 验证配置

```typescript
const loader = new TavilyConfigLoader(projectRoot)
const config = await loader.load()

const result = loader.validate(config)
if (!result.valid) {
  console.error('Configuration errors:')
  result.errors?.forEach(err => console.error(`  - ${err}`))
}
```

### 4.4 获取路径信息

```typescript
const loader = new TavilyConfigLoader(projectRoot)
const pathInfo = loader.getPathInfo()

console.log('Project config:', pathInfo.projectPath)
console.log('Project exists:', pathInfo.projectExists)
console.log('User config:', pathInfo.userPath)
console.log('User exists:', pathInfo.userExists)
```

---

## 五、Integration with Tavily Tools（与 Tavily 工具集成）

### 5.1 集成流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Tavily Tool Module                                  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                   TavilyConfigManager                             │   │
│  │                   (extension/tools/sdk/tavily/config.ts)          │   │
│  │                                                                   │   │
│  │  class TavilyConfigManager {                                      │   │
│  │    private loader: TavilyConfigLoader                             │   │
│  │    private config: TavilyFileConfig | null                        │   │
│  │                                                                   │   │
│  │    constructor(projectRoot: string) {                             │   │
│  │      this.loader = new TavilyConfigLoader(projectRoot)            │   │
│  │    }                                                              │   │
│  │                                                                   │   │
│  │    async getConfig(): Promise<TavilyFileConfig> {                 │   │
│  │      if (!this.config) {                                          │   │
│  │        this.config = await this.loader.load()                     │   │
│  │      }                                                            │   │
│  │      return this.config                                           │   │
│  │    }                                                              │   │
│  │  }                                                                │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│                              │                                           │
│                              ▼                                           │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                   TavilyClient                                    │   │
│  │                                                                   │   │
│  │  const config = await configManager.getConfig()                   │   │
│  │  const client = tavily({                                          │   │
│  │    apiKey: process.env.TAVILY_API_KEY,                           │   │
│  │    apiBaseURL: config.baseURL,                                    │   │
│  │    proxies: config.proxy                                          │   │
│  │  })                                                               │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 工具使用配置

```typescript
// tavily-search.ts 中使用配置
export const TavilySearchTool = Tool.define({
  name: 'tavily_search',
  // ...

  execute: async (params, context) => {
    const config = await tavilyConfigManager.getConfig()

    // 使用配置中的默认值
    const searchDepth = params.search_depth || config.search.defaultSearchDepth
    const maxResults = params.max_results || config.search.defaultMaxResults
    const topic = params.topic || config.search.defaultTopic

    // ...
  }
})
```

---

## 六、Error Handling（错误处理）

### 6.1 错误类型

```typescript
/**
 * 配置文件解析错误
 */
export class ConfigParseError extends Error {
  constructor(
    public filePath: string,
    public cause: Error
  ) {
    super(`Failed to parse config file: ${filePath}`)
    this.name = 'ConfigParseError'
  }
}

/**
 * 配置验证错误
 */
export class ConfigValidationError extends Error {
  constructor(public errors: string[]) {
    super(`Invalid configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`)
    this.name = 'ConfigValidationError'
  }
}
```

### 6.2 错误处理流程

```
配置加载
   │
   ├── 文件不存在 --> 使用默认值（不报错）
   │
   ├── YAML 解析失败 --> 抛出 ConfigParseError
   │
   └── Schema 验证失败 --> 抛出 ConfigValidationError
```

---

## 七、Configuration File Examples（配置文件示例）

### 7.1 最小配置

```yaml
# 只修改需要的值
tavily:
  search:
    default_max_results: 10
```

### 7.2 完整配置

```yaml
tavily:
  base_url: https://api.tavily.com

  proxy:
    http: http://proxy.example.com:8080
    https: https://proxy.example.com:8080

  search:
    default_search_depth: basic
    default_topic: general
    default_max_results: 5
    default_include_answer: false
    default_include_images: false
    default_include_raw_content: false
    default_timeout: 60

  extract:
    default_extract_depth: basic
    default_format: markdown
    default_include_images: false
    default_timeout: 60

  crawl:
    default_max_depth: 2
    default_max_breadth: 10
    default_limit: 20
    default_extract_depth: basic
    default_format: markdown
    default_allow_external: false
    default_include_images: false
    default_timeout: 120

  map:
    default_max_depth: 2
    default_max_breadth: 10
    default_limit: 100
    default_allow_external: false
    default_timeout: 60
```

### 7.3 项目特定配置

```yaml
# 项目级配置: 增加搜索结果数和爬取深度
tavily:
  search:
    default_max_results: 10
    default_search_depth: advanced

  crawl:
    default_max_depth: 3
    default_limit: 50
```

---

## 八、文档自检

- [x] 数据流图清晰完整
- [x] 外部接口定义完整
- [x] 内部接口定义完整
- [x] 使用示例覆盖主要场景
- [x] 与 Tavily 工具集成清晰
- [x] 错误处理完整
