# Exa Tools Module - goals-duty.md

本文档定义 `exa` 工具模块的目标与职责边界。

---

## 一、Module Goals（模块目标）

### 1.1 核心目标

为 iris-code Agent 提供基于 Exa AI 的 Web 搜索和内容获取能力。

### 1.2 具体目标

| 目标 | 描述 | 优先级 |
|------|------|--------|
| Web 搜索 | 提供语义搜索能力，支持多种搜索模式 | P0 |
| 内容获取 | 从 URL 提取结构化内容 | P0 |
| 配置灵活 | 支持项目级和用户级配置 | P1 |
| 错误透明 | 将 SDK 错误清晰传递给 Agent | P1 |

---

## 二、Module Duties（模块职责）

### 2.1 职责范围

| 职责 | 描述 | 负责方 |
|------|------|--------|
| SDK 封装 | 封装 exa-js SDK，提供统一接口 | exa 模块 |
| 参数验证 | 验证工具调用参数 | exa 模块 |
| 格式转换 | 将 SDK 响应转换为 Markdown | exa 模块 |
| 配置管理 | 加载和管理 Exa 配置 | config/tools/exa |
| 工具注册 | 注册工具到调度器 | tool-scheduler |
| 并发控制 | 控制工具执行并发 | tool-scheduler |
| 权限检查 | 检查工具执行权限 | tool-scheduler |

### 2.2 职责边界

**exa 模块负责**：
- 封装 exa-js SDK 的 `search()` 和 `getContents()` 方法
- 参数 snake_case 到 camelCase 的转换
- 响应格式化为 Markdown
- 错误捕获和格式化

**exa 模块不负责**：
- 工具执行权限判断（由 tool-scheduler 负责）
- 并发控制（由 tool-scheduler 负责）
- 输出渲染（由 UI 层负责）
- 错误重试（由 Agent 决定）
- API Key 验证（由 SDK 处理）

---

## 三、Tools Definition（工具定义）

### 3.1 exa_search

**职责**：执行 Web 语义搜索

**输入**：

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| query | string | 是 | - | 搜索查询 |
| type | enum | 否 | 配置文件 | 搜索模式 |
| num_results | number | 否 | 10 | 结果数量 |
| include_domains | string[] | 否 | - | 包含域名 |
| exclude_domains | string[] | 否 | - | 排除域名 |
| start_published_date | string | 否 | - | 发布起始日期 |
| end_published_date | string | 否 | - | 发布结束日期 |
| category | enum | 否 | - | 内容分类 |
| include_text | boolean | 否 | true | 包含文本 |
| max_characters | number | 否 | 10000 | 文本最大字符 |

**输出**：
- 成功：Markdown 格式的搜索结果列表
- 失败：错误信息和建议

**工具分类**：`network`

### 3.2 exa_get_contents

**职责**：从 URL 提取内容

**输入**：

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| urls | string[] | 是 | - | URL 列表 |
| text | boolean | 否 | true | 获取文本 |
| max_characters | number | 否 | 10000 | 文本最大字符 |
| highlights | boolean | 否 | false | 获取高亮 |
| summary | boolean | 否 | false | 获取摘要 |

**输出**：
- 成功：Markdown 格式的内容列表
- 失败：错误信息和建议

**工具分类**：`network`

---

## 四、Component Duties（组件职责）

### 4.1 client.ts

| 职责 | 描述 |
|------|------|
| 客户端管理 | 维护 Exa SDK 客户端单例 |
| 实例获取 | 提供 `getClient()` 方法 |
| 实例重置 | 提供 `resetInstance()` 用于测试 |

**不负责**：
- 配置加载
- 请求执行
- 错误处理

### 4.2 config.ts

| 职责 | 描述 |
|------|------|
| 配置整合 | 整合 .env 和 yaml 配置 |
| 配置验证 | 验证必要配置项 |
| 配置获取 | 提供 `getConfig()` 方法 |

**不负责**：
- 配置文件读取（由 config/tools/exa 加载器负责）
- 环境变量读取（直接使用 process.env）

### 4.3 types.ts

| 职责 | 描述 |
|------|------|
| Schema 定义 | 定义工具参数的 Zod Schema |
| 类型导出 | 导出 TypeScript 类型 |
| 输出类型 | 定义工具输出结构 |

### 4.4 exa-search.ts

| 职责 | 描述 |
|------|------|
| 工具定义 | 定义 exa_search 工具 |
| 参数转换 | snake_case → camelCase |
| SDK 调用 | 调用 exa.search() |
| 结果格式化 | 转换为 Markdown |

### 4.5 get-contents.ts

| 职责 | 描述 |
|------|------|
| 工具定义 | 定义 exa_get_contents 工具 |
| 参数转换 | snake_case → camelCase |
| SDK 调用 | 调用 exa.getContents() |
| 结果格式化 | 转换为 Markdown |

---

## 五、Non-Goals（非目标）

以下功能明确不在本模块范围内：

| 非目标 | 理由 |
|--------|------|
| Exa Answer API | 不使用 Exa 的 AI 问答功能，Agent 自行处理 |
| Exa Research API | 不使用 Exa 的研究代理，避免与 iris-code Agent 混淆 |
| Exa Websets API | 数据管理功能，不属于 Web 工具范畴 |
| URL 自动切换 | 不自动检测 URL 切换搜索模式，由用户配置 |
| 结果缓存 | 不缓存搜索结果 |
| 自动重试 | 不自动重试失败请求 |

---

## 六、Quality Attributes（质量属性）

### 6.1 可靠性

- 错误清晰传递，不吞没异常
- 参数严格验证，防止无效请求

### 6.2 可维护性

- 代码结构清晰，职责单一
- 类型完备，便于重构

### 6.3 可扩展性

- 支持添加新工具
- 配置项可扩展

### 6.4 可测试性

- 客户端单例可重置
- 依赖可注入

---

## 七、文档自检

- [x] 模块目标明确
- [x] 职责边界清晰
- [x] 每个工具的输入输出定义完整
- [x] 非目标明确列出
- [x] 与其他模块的职责划分清晰
