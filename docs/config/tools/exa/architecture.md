# Exa Config Loader - architecture.md

本文档描述 `config/tools/exa` 配置加载器的内部架构与设计模式。

---

## 一、Architecture Overview（架构概览）

### 模块定位

Exa 配置加载器是 ohbaby-agent config 模块的一部分，负责加载和管理 Exa 工具的配置文件。用户级配置统一使用 `OHBABY_HOME`（默认 `~/.ohbaby`）。

### 模块结构

```
src/config/tools/exa/
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
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐       │ │
│  │  │ exa/loader.ts  │  │tavily/loader.ts│  │ .../loader.ts  │       │ │
│  │  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘       │ │
│  │          │                   │                   │                 │ │
│  └──────────┼───────────────────┼───────────────────┼─────────────────┘ │
│             │                   │                   │                   │
└─────────────┼───────────────────┼───────────────────┼───────────────────┘
              │                   │                   │
              ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Config File Sources                               │
│                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐               │
│  │    Project Level       │    │      User Level         │               │
│  │                        │    │                         │               │
│  │  {project}/            │    │  ~/.ohbaby/   │               │
│  │    .ohbaby/         │    │    tools/               │               │
│  │      tools/            │    │      exa.yaml           │               │
│  │        exa.yaml        │    │      tavily.yaml        │               │
│  │                        │    │      ...                │               │
│  │  优先级: 1 (最高)      │    │  优先级: 2              │               │
│  │                        │    │                         │               │
│  └────────────────────────┘    └────────────────────────┘               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Environment                                    │
│                                                                          │
│  ┌────────────────────────┐                                             │
│  │         .env           │                                             │
│  │                        │                                             │
│  │  EXA_API_KEY=xxx       │  ◄── API Key 只从 .env 获取                 │
│  │                        │                                             │
│  └────────────────────────┘                                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 ExaConfigLoader（loader.ts）

**职责**：加载和合并 Exa 配置

```typescript
class ExaConfigLoader {
  private projectRoot: string
  private userConfigDir: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
    this.userConfigDir = this.resolveUserConfigDir()
  }

  /**
   * 加载配置
   * 优先级：项目级 > 用户级 > 默认值
   */
  async load(): Promise<ExaConfig> {
    // 1. 加载默认配置
    let config = { ...defaultExaConfig }

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

    // 4. 从环境变量获取 API Key
    config.apiKey = process.env.EXA_API_KEY || ''

    // 5. 验证配置
    this.validate(config)

    return config
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<ExaConfig> {
    return this.load()
  }

  /**
   * 验证配置
   */
  validate(config: ExaConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!config.apiKey) {
      errors.push('EXA_API_KEY is required in .env file')
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    }
  }
}
```

### 2.2 Config Schema（schema.ts）

**职责**：定义配置文件结构验证

```typescript
import { z } from 'zod'

export const ExaConfigFileSchema = z.object({
  exa: z.object({
    base_url: z.string().url().optional(),

    search: z.object({
      default_mode: z.enum(['neural', 'keyword', 'auto', 'fast'])
        .default('neural'),
      default_num_results: z.number().int().min(1).max(100)
        .default(10),
      default_max_characters: z.number().int().min(1).max(100000)
        .default(10000),
    }).optional(),

    get_contents: z.object({
      default_max_characters: z.number().int().min(1).max(100000)
        .default(10000),
      include_highlights: z.boolean().default(false),
      include_summary: z.boolean().default(false),
    }).optional(),
  }),
})
```

### 2.3 Default Config（defaults.ts）

**职责**：提供默认配置值

```typescript
export const defaultExaConfig: ExaConfig = {
  apiKey: '',
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

## 三、Design Patterns（设计模式）

### 3.1 策略模式（Strategy）

配置加载使用策略模式，支持不同来源：

```typescript
interface ConfigSource {
  load(): Promise<Partial<ExaConfigFile> | null>
  exists(): Promise<boolean>
}

class ProjectConfigSource implements ConfigSource { ... }
class UserConfigSource implements ConfigSource { ... }
```

### 3.2 合并策略

深度合并配置，后加载的覆盖先加载的：

```typescript
function mergeConfig(base: ExaConfig, override: Partial<ExaConfigFile>): ExaConfig {
  return {
    ...base,
    ...override.exa,
    search: {
      ...base.search,
      ...override.exa?.search,
    },
    getContents: {
      ...base.getContents,
      ...override.exa?.get_contents,
    },
  }
}
```

---

## 四、Config File Locations（配置文件位置）

### 4.1 XDG 标准路径

遵循 XDG Base Directory Specification：

| 级别 | 路径 | 环境变量 |
|------|------|----------|
| 项目级 | `{project}/.ohbaby/tools/exa.yaml` | - |
| 用户级 (Linux/Mac) | `~/.ohbaby/tools/exa.yaml` | `$OHBABY_HOME` |
| 用户级 (Windows) | `%USERPROFILE%/.ohbaby/tools/exa.yaml` | `%OHBABY_HOME%` |

### 4.2 优先级

```
项目级配置  ──►  覆盖  ──►  用户级配置  ──►  覆盖  ──►  默认配置
   1                           2                          3
```

### 4.3 路径解析

```typescript
function resolveUserConfigDir(): string {
  return path.join(resolveOhbabyHome(), 'tools')
}

function resolveProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.ohbaby', 'tools', 'exa.yaml')
}
```

---

## 五、Loading Process（加载流程）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ExaConfigLoader.load()                            │
│                                                                          │
│  1. 初始化默认配置                                                        │
│     config = defaultExaConfig                                           │
│     │                                                                    │
│     ▼                                                                    │
│  2. 检查用户级配置是否存在                                                │
│     ~/.ohbaby/tools/exa.yaml                                  │
│     │                                                                    │
│     ├── 存在 → 加载并合并                                                │
│     │   config = merge(config, userConfig)                              │
│     │                                                                    │
│     └── 不存在 → 跳过                                                    │
│     │                                                                    │
│     ▼                                                                    │
│  3. 检查项目级配置是否存在                                                │
│     {project}/.ohbaby/tools/exa.yaml                                 │
│     │                                                                    │
│     ├── 存在 → 加载并合并（覆盖用户级）                                   │
│     │   config = merge(config, projectConfig)                           │
│     │                                                                    │
│     └── 不存在 → 跳过                                                    │
│     │                                                                    │
│     ▼                                                                    │
│  4. 从环境变量获取 API Key                                               │
│     config.apiKey = process.env.EXA_API_KEY                             │
│     │                                                                    │
│     ▼                                                                    │
│  5. 验证配置完整性                                                        │
│     validate(config)                                                     │
│     │                                                                    │
│     ├── 有效 → 返回配置                                                  │
│     │                                                                    │
│     └── 无效 → 抛出错误                                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 六、Integration Points（集成点）

### 6.1 与 Exa 工具模块的集成

```typescript
// extensions/tools/sdk/exa/config.ts
import { ExaConfigLoader } from '@/config/tools/exa'

export class ExaConfigManager {
  private loader: ExaConfigLoader
  private config: ExaConfig | null = null

  constructor(projectRoot: string) {
    this.loader = new ExaConfigLoader(projectRoot)
  }

  async getConfig(): Promise<ExaConfig> {
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
import { ExaConfigLoader } from './tools/exa'
import { TavilyConfigLoader } from './tools/tavily'

export class ConfigManager {
  private loaders: Map<string, ConfigLoader>

  constructor(projectRoot: string) {
    this.loaders = new Map([
      ['exa', new ExaConfigLoader(projectRoot)],
      ['tavily', new TavilyConfigLoader(projectRoot)],
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
| MissingApiKeyError | API Key 缺失 | 抛出错误，提示设置 .env |

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
    super(`Invalid Exa configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`)
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
- [x] OHBABY_HOME 配置路径清晰
- [x] 优先级规则明确
- [x] 与其他模块集成点明确
- [x] 错误处理策略完整
