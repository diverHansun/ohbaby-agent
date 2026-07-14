# Tavily Config Loader - goals-duty.md

本文档定义 `config/tools/tavily` 配置加载器的目标与职责边界。

**模块位置**:
- 代码: `src/config/tools/tavily/`
- 文档: `docs/config/tools/tavily/`

---

## 一、Module Goals（模块目标）

### 1.1 核心目标

为 Tavily 工具模块提供统一的配置加载能力，支持多级配置和 XDG 标准。

### 1.2 具体目标

| 目标 | 描述 | 优先级 |
|------|------|--------|
| 配置加载 | 从 yaml 文件加载配置 | P0 |
| 多级支持 | 支持项目级和用户级配置 | P0 |
| 优先级合并 | 项目级覆盖用户级 | P0 |
| 配置验证 | 验证配置格式和值 | P1 |
| 默认值 | 提供合理的默认配置 | P1 |

---

## 二、Module Duties（模块职责）

### 2.1 职责范围

| 职责 | 描述 | 负责方 |
|------|------|--------|
| 路径解析 | 解析配置文件路径 | config/tools/tavily |
| 文件读取 | 读取 YAML 文件 | config/tools/tavily |
| Schema 验证 | 验证配置结构 | config/tools/tavily |
| 配置合并 | 合并多级配置 | config/tools/tavily |
| 默认值填充 | 填充缺失的默认值 | config/tools/tavily |

### 2.2 职责边界

**本模块负责**:
- 通过统一路径门面解析 OHBABY_HOME（默认 `~/.ohbaby`）
- 读取和解析 tavily.yaml 文件
- 验证配置 Schema
- 合并项目级和用户级配置
- 提供配置验证接口

**本模块不负责**:
- 创建配置文件（用户手动创建）
- 配置 UI 编辑界面
- 配置热重载监听
- 其他工具的配置（如 exa）
- Tavily 工具的具体执行
- API Key 获取（由 tavily 工具模块从 .env 获取）

---

## 三、Component Duties（组件职责）

### 3.1 loader.ts

| 职责 | 描述 |
|------|------|
| 路径解析 | 确定配置文件位置 |
| 配置加载 | 读取并解析配置文件 |
| 配置合并 | 按优先级合并配置 |
| 配置验证 | 调用 Schema 验证 |

### 3.2 schema.ts

| 职责 | 描述 |
|------|------|
| Schema 定义 | 定义配置文件结构 |
| 类型验证 | 验证值类型 |
| 范围验证 | 验证值范围 |

### 3.3 defaults.ts

| 职责 | 描述 |
|------|------|
| 默认值定义 | 定义所有配置项默认值 |
| 常量导出 | 导出默认配置常量 |

---

## 四、Input/Output（输入输出）

### 4.1 输入

| 输入 | 来源 | 说明 |
|------|------|------|
| 项目根路径 | 调用方 | 用于定位项目级配置 |
| 用户配置目录 | XDG 标准 / 环境变量 | 自动解析 |

### 4.2 输出

```typescript
interface TavilyFileConfig {
  /** API 端点 */
  baseURL: string

  /** 代理配置 */
  proxy?: {
    http?: string
    https?: string
  }

  /** 搜索配置 */
  search: {
    defaultSearchDepth: 'basic' | 'advanced'
    defaultTopic: 'general' | 'news' | 'finance'
    defaultMaxResults: number
    defaultIncludeAnswer: boolean
    defaultIncludeImages: boolean
    defaultIncludeRawContent: false | 'markdown' | 'text'
    defaultTimeout: number
  }

  /** 提取配置 */
  extract: {
    defaultExtractDepth: 'basic' | 'advanced'
    defaultFormat: 'markdown' | 'text'
    defaultIncludeImages: boolean
    defaultTimeout: number
  }

  /** 爬取配置 */
  crawl: {
    defaultMaxDepth: number
    defaultMaxBreadth: number
    defaultLimit: number
    defaultExtractDepth: 'basic' | 'advanced'
    defaultFormat: 'markdown' | 'text'
    defaultAllowExternal: boolean
    defaultIncludeImages: boolean
    defaultTimeout: number
  }

  /** 映射配置 */
  map: {
    defaultMaxDepth: number
    defaultMaxBreadth: number
    defaultLimit: number
    defaultAllowExternal: boolean
    defaultTimeout: number
  }
}
```

---

## 五、Non-Goals（非目标）

| 非目标 | 理由 |
|--------|------|
| 配置文件创建 | 用户应手动创建配置文件 |
| 配置 UI | 不属于 config 模块范畴 |
| 热重载 | 配置变更需重启生效 |
| 其他 SDK 配置 | 每个 SDK 有独立的配置加载器 |
| API Key 管理 | API Key 由 tavily 工具模块从 .env 获取 |

---

## 六、Quality Attributes（质量属性）

### 6.1 可靠性

- 配置文件不存在时使用默认值
- 配置解析失败时提供清晰错误

### 6.2 可维护性

- Schema 定义清晰
- 默认值集中管理

### 6.3 可扩展性

- 支持添加新配置项
- Schema 支持可选字段

### 6.4 安全性

- API Key 不存储在配置文件中
- 代理配置可选

---

## 七、Interfaces（接口定义）

### 7.1 TavilyConfigLoader 接口

```typescript
interface ITavilyConfigLoader {
  /**
   * 加载配置
   * @returns 完整的 Tavily 配置
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
  validate(config: unknown): { valid: boolean; errors?: string[] }
}
```

### 7.2 使用示例

```typescript
// 加载配置
const loader = new TavilyConfigLoader(projectRoot)
const config = await loader.load()

// 验证配置
const result = loader.validate(config)
if (!result.valid) {
  console.error('Config errors:', result.errors)
}
```

---

## 八、与其他模块的关系

| 模块 | 代码位置 | 关系 | 说明 |
|------|----------|------|------|
| extension/tools/sdk/tavily | `src/extension/tools/sdk/tavily/` | 被依赖 | tavily 工具模块调用加载器 |
| config | `src/config/` | 被集成 | 统一配置管理入口 |

---

## 九、文档自检

- [x] 模块目标明确
- [x] 职责边界清晰
- [x] 输入输出定义完整
- [x] 非目标明确列出
- [x] 接口定义清晰
- [x] 与 API Key 管理的职责划分明确
