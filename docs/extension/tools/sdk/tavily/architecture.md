# Tavily Tools Module - architecture.md

本文档描述 `tavily` 工具模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

Tavily 工具模块是 ohbaby-agent 的扩展工具之一，属于 Extension Tools 类别，通过 tool-scheduler 注册和调度。模块封装 @tavily/core SDK，为 Agent 提供 Web 搜索、内容提取、网站爬取和结构映射能力。

### 核心架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         tool-scheduler                                   │
│                                                                          │
│  Extension Tools Registry                                                │
│    └── tavily tools (source: 'extension', category: 'network')          │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  │ 调用
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       extension/tools/sdk/tavily                         │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                           index.ts                                 │  │
│  │                                                                    │  │
│  │  - registerTools(): 注册所有工具到 scheduler                       │  │
│  │  - 导出工具定义和类型                                              │  │
│  │                                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                  │                                       │
│           ┌──────────────────────┼──────────────────────┐               │
│           │                      │                      │               │
│           ▼                      ▼                      ▼               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ tavily-search   │  │ tavily-extract  │  │ tavily-crawl    │  ...    │
│  │                 │  │                 │  │                 │         │
│  │ - Tool.define() │  │ - Tool.define() │  │ - Tool.define() │         │
│  │ - execute()     │  │ - execute()     │  │ - execute()     │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                   │
│           └────────────────────┼────────────────────┘                   │
│                                │                                        │
│                                ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                         client.ts                                  │  │
│  │                                                                    │  │
│  │  - getClient(): TavilyClient                                       │  │
│  │  - resetInstance(): void (测试用)                                  │  │
│  │                                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                │                                        │
│                                ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                         config.ts                                  │  │
│  │                                                                    │  │
│  │  - getConfig(): TavilyToolConfig                                   │  │
│  │  - 整合 .env (API Key) + yaml (默认参数)                           │  │
│  │                                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                │                                        │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  config/tools/tavily   │
                    │                        │
                    │  配置加载器             │
                    │  (独立模块)             │
                    └────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │    @tavily/core SDK    │
                    │                        │
                    │  tavily()              │
                    │    .search()           │
                    │    .extract()          │
                    │    .crawl()            │
                    │    .map()              │
                    └────────────────────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 client.ts - 客户端管理

**职责**: 管理 Tavily SDK 客户端单例

**设计要点**:
- 使用单例模式，避免重复创建客户端
- 延迟初始化，首次调用时创建
- 支持重置实例，便于测试

**核心逻辑**:

```typescript
class TavilyClientManager {
  private client: TavilyClient | null = null

  async getClient(): Promise<TavilyClient> {
    if (!this.client) {
      const config = await getConfig()
      this.client = tavily({
        apiKey: config.apiKey,
        apiBaseURL: config.baseURL,
        proxies: config.proxy
      })
    }
    return this.client
  }

  resetInstance(): void {
    this.client = null
  }
}
```

### 2.2 config.ts - 配置整合

**职责**: 整合环境变量和配置文件

**数据来源**:
- `.env`: TAVILY_API_KEY
- `tavily.yaml`: 默认参数、代理配置

**核心逻辑**:

```typescript
interface TavilyToolConfig {
  apiKey: string
  baseURL: string
  proxy?: { http?: string; https?: string }
  search: TavilySearchDefaults
  extract: TavilyExtractDefaults
  crawl: TavilyCrawlDefaults
  map: TavilyMapDefaults
}

async function getConfig(): Promise<TavilyToolConfig> {
  // 1. 从 config/tools/tavily 加载配置
  const loader = new TavilyConfigLoader(projectRoot)
  const fileConfig = await loader.load()

  // 2. 从 .env 获取 API Key
  const apiKey = process.env.TAVILY_API_KEY || ''

  // 3. 合并返回
  return {
    apiKey,
    ...fileConfig
  }
}
```

### 2.3 types.ts - 类型定义

**职责**: 定义工具参数 Schema 和 TypeScript 类型

**内容**:
- Zod Schema 定义（供参数验证）
- TypeScript 类型导出
- 输出结构定义

### 2.4 工具实现文件

每个工具一个独立文件，结构一致:

| 文件 | 工具名称 | SDK 方法 |
|------|----------|----------|
| tavily-search.ts | tavily_search | tavily.search() |
| tavily-extract.ts | tavily_extract | tavily.extract() |
| tavily-crawl.ts | tavily_crawl | tavily.crawl() |
| tavily-map.ts | tavily_map | tavily.map() |

**工具实现模板**:

```typescript
export const TavilySearchTool = Tool.define({
  name: 'tavily_search',
  description: '执行为 LLM 优化的 Web 搜索',
  parameters: TavilySearchParamsSchema,
  category: 'network',

  execute: async (params, context) => {
    // 1. 获取客户端
    const client = await getClient()

    // 2. 获取配置默认值
    const config = await getConfig()

    // 3. 参数转换 (snake_case -> camelCase)
    const options = transformParams(params, config.search)

    // 4. 调用 SDK
    const response = await client.search(params.query, options)

    // 5. 格式化输出
    return formatSearchResult(response)
  }
})
```

### 2.5 index.ts - 统一入口

**职责**: 导出和注册

```typescript
// 导出所有工具
export { TavilySearchTool } from './tavily-search'
export { TavilyExtractTool } from './tavily-extract'
export { TavilyCrawlTool } from './tavily-crawl'
export { TavilyMapTool } from './tavily-map'

// 导出类型
export * from './types'

// 注册函数
export function registerTools(scheduler: ToolScheduler): void {
  scheduler.register(TavilySearchTool)
  scheduler.register(TavilyExtractTool)
  scheduler.register(TavilyCrawlTool)
  scheduler.register(TavilyMapTool)
}
```

---

## 三、Design Patterns（设计模式）

### 3.1 单例模式（Singleton）

**应用场景**: TavilyClient 管理

**选择理由**:
- SDK 客户端创建成本较低，但无需重复创建
- 配置在运行期间通常不变
- 便于测试时重置状态

**实现方式**:
- 模块级变量保存实例
- getClient() 延迟初始化
- resetInstance() 支持测试重置

### 3.2 策略模式（Strategy）- 预留

**当前状态**: 未使用

**预留设计**:
- 后续可扩展为 Provider 机制
- 不同 Provider（Exa, Tavily, Google）实现相同接口
- 通过配置切换

**不立即实现的理由**:
- 当前只有 Tavily 一个实现
- 避免过度设计
- 保持代码简单

### 3.3 适配器模式（Adapter）

**应用场景**: 参数格式转换

**选择理由**:
- LLM 倾向使用 snake_case 参数名
- SDK 使用 camelCase 参数名
- 需要统一转换

**实现方式**:
- transformParams() 函数处理转换
- 每个工具独立的转换逻辑

---

## 四、Module Structure（模块结构）

```
src/extension/tools/sdk/tavily/
├── index.ts              # 统一导出和注册入口
├── client.ts             # SDK 客户端管理（单例）
├── config.ts             # 配置整合
├── types.ts              # 类型和 Schema 定义
├── tavily-search.ts      # tavily_search 工具实现
├── tavily-extract.ts     # tavily_extract 工具实现
├── tavily-crawl.ts       # tavily_crawl 工具实现
├── tavily-map.ts         # tavily_map 工具实现
├── formatter.ts          # 输出格式化（Markdown）
└── __tests__/
    ├── client.test.ts
    ├── tavily-search.test.ts
    ├── tavily-extract.test.ts
    ├── tavily-crawl.test.ts
    └── tavily-map.test.ts
```

**目录说明**:

| 文件/目录 | 稳定性 | 说明 |
|-----------|--------|------|
| index.ts | 稳定 | 对外接口，不轻易改动 |
| types.ts | 稳定 | 类型定义，Schema |
| client.ts | 稳定 | 客户端管理 |
| config.ts | 稳定 | 配置整合 |
| tavily-*.ts | 可扩展 | 工具实现，可添加新工具 |
| formatter.ts | 内部 | 输出格式化，实现细节 |
| __tests__/ | 内部 | 测试文件 |

---

## 五、Integration Points（集成点）

### 5.1 与 tool-scheduler 集成

**注册时机**: ToolScheduler 初始化时

**注册方式**:
```typescript
// tool-scheduler 初始化代码
import { registerTools as registerTavilyTools } from '@/extension/tools/sdk/tavily'

// 注册 Tavily 工具
registerTavilyTools(scheduler)
```

**工具属性**:
```typescript
{
  source: 'extension',
  category: 'network'
}
```

### 5.2 与 config/tools/tavily 集成

**依赖关系**: tavily 模块依赖配置加载器

```typescript
// config.ts
import { TavilyConfigLoader } from '@/config/tools/tavily'

const loader = new TavilyConfigLoader(projectRoot)
const config = await loader.load()
```

### 5.3 与 message 模块集成

**输出格式**: 符合 ToolStateCompleted.output 要求

```typescript
// 工具输出为 string 类型
interface ToolStateCompleted {
  status: 'completed'
  output: string  // Markdown 格式
  // ...
}
```

---

## 六、Error Handling（错误处理）

### 6.1 错误类型

| 错误来源 | 错误类型 | 处理方式 |
|----------|----------|----------|
| 参数验证 | ZodError | 转换为可读错误消息 |
| API Key 缺失 | ConfigError | 提示用户配置 .env |
| SDK 调用失败 | TavilyError | 透传错误信息 |
| 网络超时 | TimeoutError | 返回超时提示 |

### 6.2 错误格式化

```typescript
function formatError(error: unknown): string {
  if (error instanceof ZodError) {
    return `参数验证失败: ${formatZodError(error)}`
  }
  if (error instanceof ConfigError) {
    return `配置错误: ${error.message}\n请在 .env 文件中设置 TAVILY_API_KEY`
  }
  if (error instanceof TavilyError) {
    return `Tavily API 错误: ${error.message}`
  }
  return `未知错误: ${String(error)}`
}
```

### 6.3 特殊处理: extract 失败的 URL

tavily_extract 支持批量 URL，部分 URL 可能失败:

```typescript
// SDK 响应
interface TavilyExtractResponse {
  results: TavilyExtractResult[]
  failedResults: { url: string; error: string }[]
}

// 格式化输出时包含失败列表
function formatExtractResult(response: TavilyExtractResponse): string {
  let output = '## 提取成功\n\n'
  // ... 成功结果

  if (response.failedResults.length > 0) {
    output += '\n## 提取失败\n\n'
    for (const failed of response.failedResults) {
      output += `- ${failed.url}: ${failed.error}\n`
    }
  }

  return output
}
```

---

## 七、Architectural Constraints（架构约束）

### 7.1 约束

| 约束 | 说明 |
|------|------|
| 不缓存结果 | 每次调用都请求 Tavily API |
| 不自动重试 | 失败后由 Agent 决定是否重试 |
| 同步等待 | 不支持流式响应 |
| 单一 SDK | 只封装 @tavily/core |

### 7.2 权衡

| 选择 | 放弃 | 理由 |
|------|------|------|
| 简单单例 | 依赖注入 | 模块内部实现，无需复杂 DI |
| Markdown 输出 | 结构化对象 | 符合 ToolPart 规范，LLM 可读 |
| 独立文件 | 单文件 | 便于定位和维护，工具间互不干扰 |

---

## 八、Dependencies（依赖关系）

### 8.1 外部依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| @tavily/core | ^0.6.4 | Tavily SDK |
| zod | ^3.24.1 | 参数验证 |

### 8.2 内部依赖

| 模块 | 用途 |
|------|------|
| config/tools/tavily | 配置加载 |
| core/tool-scheduler | 工具注册 |

---

## 九、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 组件职责单一，边界清晰
- [x] 设计模式选择有明确理由
- [x] 模块结构清晰，文件组织合理
- [x] 集成点明确定义
- [x] 错误处理策略完整
- [x] 约束和权衡已说明
