# Exa Config Loader - goals-duty.md

本文档定义 `config/tools/exa` 配置加载器的目标与职责边界。

---

## 一、Module Goals（模块目标）

### 1.1 核心目标

为 Exa 工具模块提供统一的配置加载能力，支持多级配置和 XDG 标准。

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
| 路径解析 | 解析配置文件路径 | config/tools/exa |
| 文件读取 | 读取 YAML 文件 | config/tools/exa |
| Schema 验证 | 验证配置结构 | config/tools/exa |
| 配置合并 | 合并多级配置 | config/tools/exa |
| 默认值填充 | 填充缺失的默认值 | config/tools/exa |
| API Key 获取 | 从 .env 获取密钥 | config/tools/exa |

### 2.2 职责边界

**本模块负责**：
- 通过统一路径门面解析 OHBABY_HOME（默认 `~/.ohbaby`）
- 读取和解析 exa.yaml 文件
- 验证配置 Schema
- 合并项目级和用户级配置
- 从环境变量获取 EXA_API_KEY
- 提供配置验证接口

**本模块不负责**：
- 创建配置文件（用户手动创建）
- 配置 UI 编辑界面
- 配置热重载监听
- 其他工具的配置（如 tavily）
- Exa 工具的具体执行

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
| EXA_API_KEY | .env 文件 | 环境变量 |

### 4.2 输出

```typescript
interface ExaConfig {
  /** API 密钥 */
  apiKey: string

  /** API 端点 */
  baseURL: string

  /** 搜索配置 */
  search: {
    defaultMode: 'neural' | 'keyword' | 'auto' | 'fast'
    defaultNumResults: number
    defaultMaxCharacters: number
  }

  /** 内容获取配置 */
  getContents: {
    defaultMaxCharacters: number
    includeHighlights: boolean
    includeSummary: boolean
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
| 密钥加密存储 | 使用 .env 标准方式 |

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
- API Key 仅从 .env 获取

---

## 七、Interfaces（接口定义）

### 7.1 ExaConfigLoader 接口

```typescript
interface IExaConfigLoader {
  /**
   * 加载配置
   * @returns 完整的 Exa 配置
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
  validate(config: ExaConfig): { valid: boolean; errors?: string[] }
}
```

### 7.2 使用示例

```typescript
// 加载配置
const loader = new ExaConfigLoader(projectRoot)
const config = await loader.load()

// 验证配置
const result = loader.validate(config)
if (!result.valid) {
  console.error('Config errors:', result.errors)
}
```

---

## 八、文档自检

- [x] 模块目标明确
- [x] 职责边界清晰
- [x] 输入输出定义完整
- [x] 非目标明确列出
- [x] 接口定义清晰
