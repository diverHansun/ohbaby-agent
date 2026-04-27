# Exa Tools Module - architecture.md

本文档描述 `exa` 工具模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

Exa 工具模块是 ohbaby-agent 的扩展工具层，封装 exa-js SDK 提供 Web 搜索和内容获取能力。作为 network 类别工具，为 Agent 提供互联网信息检索功能。

### 模块结构

```
src/extensions/tools/sdk/exa/
├── index.ts              # 导出入口
├── types.ts              # 类型定义（Zod Schema + TypeScript）
├── client.ts             # Exa 客户端（单例模式）
├── config.ts             # 配置管理
├── exa-search.ts         # exa_search 工具实现
├── get-contents.ts       # exa_get_contents 工具实现
└── __tests__/
    ├── client.test.ts
    ├── exa-search.test.ts
    └── get-contents.test.ts
```

### 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Scheduler                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Tool Registry                          │   │
│  │                                                           │   │
│  │  ┌─────────────┐  ┌─────────────────┐                    │   │
│  │  │ exa_search  │  │ exa_get_contents│  ...other tools    │   │
│  │  └──────┬──────┘  └────────┬────────┘                    │   │
│  │         │                  │                              │   │
│  └─────────┼──────────────────┼──────────────────────────────┘   │
│            │                  │                                  │
└────────────┼──────────────────┼──────────────────────────────────┘
             │                  │
             ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Exa Tools Module                            │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │   exa-search.ts  │  │  get-contents.ts │                     │
│  │                  │  │                  │                     │
│  │  - execute()     │  │  - execute()     │                     │
│  │  - validate()    │  │  - validate()    │                     │
│  └────────┬─────────┘  └────────┬─────────┘                     │
│           │                     │                                │
│           └──────────┬──────────┘                                │
│                      │                                           │
│           ┌──────────▼──────────┐                                │
│           │      client.ts      │                                │
│           │                     │                                │
│           │  ExaClient (单例)   │                                │
│           │  - getClient()      │                                │
│           └──────────┬──────────┘                                │
│                      │                                           │
│           ┌──────────▼──────────┐                                │
│           │     config.ts       │                                │
│           │                     │                                │
│           │  ExaConfigManager   │                                │
│           │  - loadConfig()     │                                │
│           └──────────┬──────────┘                                │
│                      │                                           │
└──────────────────────┼───────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                       External                                   │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │     exa-js       │  │   Config Files   │                     │
│  │     (SDK)        │  │                  │                     │
│  │                  │  │  .env            │                     │
│  │  Exa API Client  │  │  exa.yaml        │                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 ExaClient（client.ts）

**职责**：管理 Exa SDK 客户端实例

**设计模式**：单例模式

```typescript
class ExaClient {
  private static instance: ExaClient | null = null
  private client: Exa

  private constructor(config: ExaConfig) {
    this.client = new Exa(config.apiKey, config.baseURL)
  }

  static getInstance(): ExaClient {
    if (!ExaClient.instance) {
      const config = exaConfig.getConfig()
      ExaClient.instance = new ExaClient(config)
    }
    return ExaClient.instance
  }

  static resetInstance(): void {
    ExaClient.instance = null
  }

  getClient(): Exa {
    return this.client
  }
}
```

**单例模式理由**：
- 避免重复创建 SDK 客户端
- API Key 只需初始化一次
- 便于测试（可重置实例）

### 2.2 ExaConfigManager（config.ts）

**职责**：管理 Exa 工具配置

**配置来源优先级**：
1. 项目级别：`{project}/.ohbaby-agent/tools/exa.yaml`
2. 用户级别：`~/.config/ohbaby-agent/tools/exa.yaml`

**配置项**：

| 配置项 | 来源 | 说明 |
|--------|------|------|
| api_key | `.env` (EXA_API_KEY) | API 密钥 |
| base_url | `exa.yaml` | API 端点 |
| search.default_mode | `exa.yaml` | 默认搜索模式 |
| search.default_num_results | `exa.yaml` | 默认结果数 |

### 2.3 Tool Implementations

#### exa_search（exa-search.ts）

**功能**：Web 语义搜索

**核心流程**：
```
1. 参数验证（Zod Schema）
   │
   ▼
2. 获取配置（搜索模式等）
   │
   ▼
3. 构建 SDK 请求参数
   │
   ▼
4. 调用 exa.search()
   │
   ▼
5. 转换响应格式
   │
   ▼
6. 返回 Markdown 格式结果
```

#### exa_get_contents（get-contents.ts）

**功能**：URL 内容提取

**核心流程**：
```
1. 参数验证（Zod Schema）
   │
   ▼
2. 构建内容选项
   │
   ▼
3. 调用 exa.getContents()
   │
   ▼
4. 转换响应格式
   │
   ▼
5. 返回 Markdown 格式结果
```

---

## 三、Design Patterns（设计模式）

### 3.1 单例模式（Singleton）

用于 ExaClient，确保全局只有一个 SDK 客户端实例。

### 3.2 工厂模式（Factory）

使用 `Tool.define()` 工厂函数创建工具，确保所有工具符合统一接口。

### 3.3 适配器模式（Adapter）

将 exa-js SDK 的 camelCase 接口适配为 ohbaby-agent 的 snake_case 参数风格。

```typescript
// SDK 接口 (camelCase)
exa.search(query, { numResults, includeDomains })

// 工具参数 (snake_case)
{ query, num_results, include_domains }
```

---

## 四、Integration Points（集成点）

### 4.1 与 Tool Scheduler 的集成

**注册方式**：显式代码注册

```typescript
import { ExaTools } from '@/extensions/tools/sdk/exa'

// tool-scheduler 初始化时
toolScheduler.registerTools(ExaTools)
```

**工具分类**：`network`

**并发控制**：由 tool-scheduler 统一管理

### 4.2 与 Config 模块的集成

```typescript
// config 模块提供配置加载能力
import { loadExaConfig } from '@/config/tools/exa'

const config = await loadExaConfig()
```

### 4.3 与 Agent 的交互

```
Agent
  │
  │ 调用工具
  ▼
Tool Scheduler
  │
  │ 查找 + 权限检查 + 执行
  ▼
exa_search / exa_get_contents
  │
  │ 返回结果
  ▼
Agent
  │
  │ 处理结果 / 错误处理
  ▼
继续对话或重试
```

---

## 五、Error Handling（错误处理）

### 5.1 错误类型

遵循 exa-js SDK 的错误类型：

| 错误类型 | HTTP Code | 场景 |
|----------|-----------|------|
| ExaError | 4xx/5xx | SDK 基础错误 |
| AuthenticationError | 401 | API Key 无效 |
| RateLimitError | 429 | 超出速率限制 |
| ServerError | 5xx | Exa 服务端错误 |

### 5.2 错误处理流程

```
SDK 抛出错误
   │
   ▼
工具层捕获
   │
   ├── 转换为统一格式
   │   {
   │     error: {
   │       type: 'ExaAPIError',
   │       code: 401,
   │       message: 'Invalid API key',
   │       suggestion: 'Check EXA_API_KEY in .env'
   │     }
   │   }
   │
   ▼
返回给 Tool Scheduler
   │
   ▼
Agent 决定是否重试
```

### 5.3 不自动重试

错误处理策略：不在工具层自动重试，将错误返回给 Agent，由 Agent 决定是否重新调用。

---

## 六、Output Format（输出格式）

### 6.1 Markdown 格式输出

所有工具输出采用 Markdown 格式，便于阅读和 UI 渲染。

**exa_search 输出示例**：
```markdown
# Exa Search Results

Found 10 results
Request ID: req_abc123

## Result 1
**Title:** Example Article
**URL:** https://example.com/article
**Published:** 2024-01-15
**Score:** 0.892

**Content:**
Article content excerpt...

---

## Result 2
...
```

### 6.2 输出限制

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 搜索结果数 | 默认 10，最大 100 | 由参数控制 |
| 单结果文本 | 默认 10000 字符 | 由参数控制 |
| 总输出 | 无限制 | 由上层控制 |

---

## 七、Dependencies（依赖）

### 7.1 外部依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| exa-js | ^2.0.12 | Exa API SDK |
| zod | ^3.24.1 | 参数验证 |

### 7.2 内部依赖

| 模块 | 用途 |
|------|------|
| config/tools/exa | 配置加载 |
| core/tool-scheduler | 工具注册和执行 |
| utils | 错误处理基类 |

---

## 八、Extension Points（扩展点）

### 8.1 添加新工具

如需添加新的 Exa 工具（如 `exa_find_similar`），遵循以下步骤：

1. 在 `types.ts` 中添加参数 Schema
2. 创建新的工具文件（如 `find-similar.ts`）
3. 在 `index.ts` 中导出
4. 更新 tool-scheduler 注册

### 8.2 配置扩展

配置文件支持扩展新的配置项，只需：

1. 更新 `config.ts` 中的类型定义
2. 更新配置加载器
3. 在工具中使用新配置

---

## 九、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 每个组件的职责单一、边界清晰
- [x] 设计模式选择有明确理由
- [x] 错误处理策略明确
- [x] 与其他模块的集成点明确
