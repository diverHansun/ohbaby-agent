# Exa Config Loader - dfd-interface.md

本文档定义 `config/tools/exa` 配置加载器的数据流与接口设计。

---

## 一、Data Flow Diagrams（数据流图）

### 1.1 配置加载数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Config Load Request                               │
│                                                                          │
│  ExaConfigLoader.load(projectRoot)                                      │
│                                                                          │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Path Resolution                                  │
│                                                                          │
│  1. 解析项目配置路径                                                      │
│     projectPath = {projectRoot}/.ohbaby-code/tools/exa.yaml               │
│                                                                          │
│  2. 解析用户配置路径                                                      │
│     Windows: %APPDATA%/ohbaby-code/tools/exa.yaml                         │
│     Linux/Mac: ~/.config/ohbaby-code/tools/exa.yaml                       │
│                                                                          │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Config Loading                                   │
│                                                                          │
│  ┌─────────────────────┐                                                │
│  │  默认配置           │ ◄── 初始化                                      │
│  │  defaultExaConfig   │                                                │
│  └──────────┬──────────┘                                                │
│             │                                                            │
│             ▼                                                            │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  用户级配置          │ ◄──  │  ~/.config/.../     │                   │
│  │  (如果存在)          │      │  exa.yaml           │                   │
│  └──────────┬──────────┘      └─────────────────────┘                   │
│             │ merge                                                      │
│             ▼                                                            │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  项目级配置          │ ◄──  │  .ohbaby-code/tools/  │                   │
│  │  (如果存在)          │      │  exa.yaml           │                   │
│  └──────────┬──────────┘      └─────────────────────┘                   │
│             │ merge                                                      │
│             ▼                                                            │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  添加 API Key       │ ◄──  │  .env               │                   │
│  │                     │      │  EXA_API_KEY=xxx    │                   │
│  └──────────┬──────────┘      └─────────────────────┘                   │
│             │                                                            │
└─────────────┼────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Validation                                      │
│                                                                          │
│  1. Schema 验证（Zod）                                                   │
│  2. 必需字段检查（API Key）                                              │
│  3. 值范围验证                                                           │
│                                                                          │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │  验证通过            │      │  验证失败            │                   │
│  │                     │      │                     │                   │
│  │  返回 ExaConfig     │      │  抛出               │                   │
│  │                     │      │  ConfigValidation   │                   │
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
│    mode:neural│   │    mode:fast  │   │  (未定义)     │
│    num: 10    │   │  (未定义)     │   │    num: 5     │
│               │   │               │   │               │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        │                   ▼                   │
        │           ┌───────────────┐           │
        └──────────►│   第一次合并   │◄──────────┘
                    │               │
                    │  search:      │
                    │    mode: fast │ ◄── 来自用户级
                    │    num: 5     │ ◄── 来自项目级
                    │               │
                    └───────────────┘
```

---

## 二、External Interfaces（外部接口）

### 2.1 ExaConfigLoader 类

```typescript
/**
 * Exa 配置加载器
 */
export class ExaConfigLoader {
  /**
   * 创建加载器实例
   * @param projectRoot 项目根目录
   */
  constructor(projectRoot: string)

  /**
   * 加载配置
   * @returns 完整的 Exa 配置
   * @throws ConfigValidationError 配置无效时
   */
  load(): Promise<ExaConfig>

  /**
   * 重新加载配置
   * @returns 重新加载的配置
   */
  reload(): Promise<ExaConfig>

  /**
   * 验证配置
   * @param config 要验证的配置
   * @returns 验证结果
   */
  validate(config: ExaConfig): ConfigValidationResult

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
export function createExaConfigLoader(projectRoot: string): ExaConfigLoader

/**
 * 加载 Exa 配置（便捷函数）
 */
export async function loadExaConfig(projectRoot: string): Promise<ExaConfig>

/**
 * 获取默认配置
 */
export function getDefaultExaConfig(): ExaConfig
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
  read(path: string): Promise<ExaConfigFile | null>
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
  merge(base: ExaConfig, override: Partial<ExaConfigFile>): ExaConfig
}
```

---

## 四、Usage Examples（使用示例）

### 4.1 基本使用

```typescript
import { ExaConfigLoader } from '@/config/tools/exa'

// 创建加载器
const loader = new ExaConfigLoader('/path/to/project')

// 加载配置
const config = await loader.load()

console.log(config.search.defaultMode)  // 'neural' 或配置的值
console.log(config.apiKey)              // 来自 .env 的值
```

### 4.2 便捷函数

```typescript
import { loadExaConfig } from '@/config/tools/exa'

const config = await loadExaConfig('/path/to/project')
```

### 4.3 验证配置

```typescript
const loader = new ExaConfigLoader(projectRoot)
const config = await loader.load()

const result = loader.validate(config)
if (!result.valid) {
  console.error('Configuration errors:')
  result.errors?.forEach(err => console.error(`  - ${err}`))
}
```

### 4.4 获取路径信息

```typescript
const loader = new ExaConfigLoader(projectRoot)
const pathInfo = loader.getPathInfo()

console.log('Project config:', pathInfo.projectPath)
console.log('Project exists:', pathInfo.projectExists)
console.log('User config:', pathInfo.userPath)
console.log('User exists:', pathInfo.userExists)
```

---

## 五、Integration with Exa Tools（与 Exa 工具集成）

### 5.1 集成流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Exa Tool Module                                     │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                   ExaConfigManager                                │   │
│  │                   (extensions/tools/sdk/exa/config.ts)            │   │
│  │                                                                   │   │
│  │  class ExaConfigManager {                                         │   │
│  │    private loader: ExaConfigLoader                                │   │
│  │    private config: ExaConfig | null                               │   │
│  │                                                                   │   │
│  │    constructor(projectRoot: string) {                             │   │
│  │      this.loader = new ExaConfigLoader(projectRoot)               │   │
│  │    }                                                              │   │
│  │                                                                   │   │
│  │    async getConfig(): Promise<ExaConfig> {                        │   │
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
│  │                   ExaClient                                       │   │
│  │                                                                   │   │
│  │  const config = await configManager.getConfig()                   │   │
│  │  const client = new Exa(config.apiKey, config.baseURL)           │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 工具使用配置

```typescript
// exa-search.ts 中使用配置
export const ExaSearchTool = Tool.define({
  name: 'exa_search',
  // ...

  execute: async (params, context) => {
    const config = await exaConfigManager.getConfig()

    // 使用配置中的默认值
    const searchType = params.type || config.search.defaultMode
    const numResults = params.num_results || config.search.defaultNumResults
    const maxChars = params.max_characters || config.search.defaultMaxCharacters

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

/**
 * 缺少 API Key 错误
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super('EXA_API_KEY is not set in .env file')
    this.name = 'MissingApiKeyError'
  }
}
```

### 6.2 错误处理流程

```
配置加载
   │
   ├── 文件不存在 ──► 使用默认值（不报错）
   │
   ├── YAML 解析失败 ──► 抛出 ConfigParseError
   │
   ├── Schema 验证失败 ──► 抛出 ConfigValidationError
   │
   └── API Key 缺失 ──► 抛出 MissingApiKeyError
```

---

## 七、Configuration File Examples（配置文件示例）

### 7.1 最小配置

```yaml
# 只修改需要的值
exa:
  search:
    default_mode: keyword
```

### 7.2 完整配置

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

### 7.3 项目特定配置

```yaml
# 项目级配置：覆盖搜索结果数
exa:
  search:
    default_num_results: 5
    default_mode: fast
```

---

## 八、文档自检

- [x] 数据流图清晰完整
- [x] 外部接口定义完整
- [x] 内部接口定义完整
- [x] 使用示例覆盖主要场景
- [x] 与 Exa 工具集成清晰
- [x] 错误处理完整
