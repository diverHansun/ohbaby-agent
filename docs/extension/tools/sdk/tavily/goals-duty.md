# Tavily Tools Module - goals-duty.md

本文档定义 `tavily` 工具模块的目标与职责边界。

**模块位置**:
- 代码: `src/extension/tools/sdk/tavily/`
- 文档: `docs/extension/tools/sdk/tavily/`

---

## 一、Module Goals（模块目标）

### 1.1 核心目标

为 ohbaby-agent Agent 提供基于 Tavily AI 的 Web 搜索、内容提取、网站爬取和结构映射能力。

### 1.2 具体目标

| 目标 | 描述 | 优先级 |
|------|------|--------|
| Web 搜索 | 提供为 LLM 优化的 Web 搜索能力 | P0 |
| 内容提取 | 从 URL 列表批量提取原始内容 | P0 |
| 网站爬取 | 智能爬取网站，支持自然语言指令引导 | P0 |
| 结构映射 | 发现和映射网站 URL 结构 | P0 |
| 配置灵活 | 支持项目级和用户级配置 | P1 |
| 错误透明 | 将 SDK 错误清晰传递给 Agent | P1 |

---

## 二、Module Duties（模块职责）

### 2.1 职责范围

| 职责 | 描述 | 负责方 |
|------|------|--------|
| SDK 封装 | 封装 @tavily/core SDK，提供统一接口 | tavily 模块 |
| 参数验证 | 验证工具调用参数 | tavily 模块 |
| 格式转换 | 将 SDK 响应转换为 Markdown | tavily 模块 |
| 配置管理 | 加载和管理 Tavily 配置 | config/tools/tavily |
| 工具注册 | 注册工具到调度器 | tool-scheduler |
| 并发控制 | 控制工具执行并发 | tool-scheduler |
| 权限检查 | 检查工具执行权限 | tool-scheduler |

### 2.2 职责边界

**tavily 模块负责**:
- 封装 @tavily/core SDK 的 `search()`, `extract()`, `crawl()`, `map()` 方法
- 参数 snake_case 到 camelCase 的转换
- 响应格式化为 Markdown
- 错误捕获和格式化
- 客户端实例管理

**tavily 模块不负责**:
- 工具执行权限判断（由 tool-scheduler 负责）
- 并发控制（由 tool-scheduler 负责）
- 输出渲染（由 UI 层负责）
- 错误重试（由 Agent 决定）
- API Key 验证（由 SDK 处理）
- 配置文件读取（由 config/tools/tavily 负责）

---

## 三、Tools Definition（工具定义）

### 3.1 tavily_search

**职责**: 执行为 LLM 优化的 Web 搜索

**输入**:

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| query | string | 是 | - | 搜索查询 |
| search_depth | enum | 否 | basic | 搜索深度: basic / advanced |
| topic | enum | 否 | general | 搜索主题: general / news / finance |
| max_results | number | 否 | 5 | 最大结果数量 (1-20) |
| include_answer | boolean | 否 | false | 是否包含 AI 生成的答案 |
| include_images | boolean | 否 | false | 是否包含图片 |
| include_raw_content | enum | 否 | false | 原始内容格式: false / markdown / text |
| include_domains | string[] | 否 | - | 包含的域名列表 |
| exclude_domains | string[] | 否 | - | 排除的域名列表 |
| time_range | enum | 否 | - | 时间范围: year / month / week / day |
| country | string | 否 | - | 国家代码 (如 US, CN) |

**输出**:
- 成功: Markdown 格式的搜索结果列表，包含标题、URL、内容摘要、相关性分数
- 失败: 错误信息和建议

**工具分类**: `network`

### 3.2 tavily_extract

**职责**: 从 URL 列表批量提取原始内容

**输入**:

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| urls | string[] | 是 | - | URL 列表 (最多 20 个) |
| extract_depth | enum | 否 | basic | 提取深度: basic / advanced |
| format | enum | 否 | markdown | 输出格式: markdown / text |
| include_images | boolean | 否 | false | 是否包含图片 URL |

**输出**:
- 成功: Markdown 格式的内容列表，包含 URL、原始内容、图片列表
- 失败: 错误信息，包含失败的 URL 列表

**工具分类**: `network`

### 3.3 tavily_crawl

**职责**: 智能爬取网站，使用广度优先策略和自然语言指令

**输入**:

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| url | string | 是 | - | 起始 URL |
| max_depth | number | 否 | 2 | 最大爬取深度 |
| max_breadth | number | 否 | 10 | 每层最大链接数 |
| limit | number | 否 | 20 | 最大返回页面数 |
| instructions | string | 否 | - | 自然语言指令，引导爬取方向 |
| extract_depth | enum | 否 | basic | 提取深度: basic / advanced |
| format | enum | 否 | markdown | 输出格式: markdown / text |
| select_paths | string[] | 否 | - | 包含的路径 |
| exclude_paths | string[] | 否 | - | 排除的路径 |
| select_domains | string[] | 否 | - | 包含的域名 |
| exclude_domains | string[] | 否 | - | 排除的域名 |
| allow_external | boolean | 否 | false | 是否允许爬取外部链接 |
| include_images | boolean | 否 | false | 是否包含图片 |

**输出**:
- 成功: Markdown 格式的页面内容列表，包含 URL、原始内容、图片列表
- 失败: 错误信息

**工具分类**: `network`

### 3.4 tavily_map

**职责**: 发现和映射网站 URL 结构

**输入**:

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| url | string | 是 | - | 起始 URL |
| max_depth | number | 否 | 2 | 最大映射深度 |
| max_breadth | number | 否 | 10 | 每层最大链接数 |
| limit | number | 否 | 100 | 最大返回 URL 数 |
| instructions | string | 否 | - | 自然语言指令，筛选特定页面 |
| select_paths | string[] | 否 | - | 包含的路径 |
| exclude_paths | string[] | 否 | - | 排除的路径 |
| select_domains | string[] | 否 | - | 包含的域名 |
| exclude_domains | string[] | 否 | - | 排除的域名 |
| allow_external | boolean | 否 | false | 是否包含外部链接 |

**输出**:
- 成功: URL 列表，Markdown 格式
- 失败: 错误信息

**工具分类**: `network`

---

## 四、Component Duties（组件职责）

### 4.1 client.ts

| 职责 | 描述 |
|------|------|
| 客户端管理 | 维护 Tavily SDK 客户端单例 |
| 实例获取 | 提供 `getClient()` 方法 |
| 实例重置 | 提供 `resetInstance()` 用于测试 |

**不负责**:
- 配置加载
- 请求执行
- 错误处理

### 4.2 config.ts

| 职责 | 描述 |
|------|------|
| 配置整合 | 整合 .env 和 yaml 配置 |
| 配置验证 | 验证必要配置项 |
| 配置获取 | 提供 `getConfig()` 方法 |

**不负责**:
- 配置文件读取（由 config/tools/tavily 加载器负责）
- 环境变量读取（直接使用 process.env）

### 4.3 types.ts

| 职责 | 描述 |
|------|------|
| Schema 定义 | 定义工具参数的 Zod Schema |
| 类型导出 | 导出 TypeScript 类型 |
| 输出类型 | 定义工具输出结构 |

### 4.4 tavily-search.ts

| 职责 | 描述 |
|------|------|
| 工具定义 | 定义 tavily_search 工具 |
| 参数转换 | snake_case 到 camelCase |
| SDK 调用 | 调用 tavily.search() |
| 结果格式化 | 转换为 Markdown |

### 4.5 tavily-extract.ts

| 职责 | 描述 |
|------|------|
| 工具定义 | 定义 tavily_extract 工具 |
| 参数转换 | snake_case 到 camelCase |
| SDK 调用 | 调用 tavily.extract() |
| 结果格式化 | 转换为 Markdown |

### 4.6 tavily-crawl.ts

| 职责 | 描述 |
|------|------|
| 工具定义 | 定义 tavily_crawl 工具 |
| 参数转换 | snake_case 到 camelCase |
| SDK 调用 | 调用 tavily.crawl() |
| 结果格式化 | 转换为 Markdown |

### 4.7 tavily-map.ts

| 职责 | 描述 |
|------|------|
| 工具定义 | 定义 tavily_map 工具 |
| 参数转换 | snake_case 到 camelCase |
| SDK 调用 | 调用 tavily.map() |
| 结果格式化 | 转换为 Markdown |

### 4.8 index.ts

| 职责 | 描述 |
|------|------|
| 统一导出 | 导出所有工具和类型 |
| 工具注册 | 提供 `registerTools()` 方法 |

---

## 五、Non-Goals（非目标）

以下功能明确不在本模块范围内:

| 非目标 | 理由 |
|--------|------|
| Tavily Research API | 高成本异步 API，需轮询结果，增加复杂度 |
| Tavily getResearch API | 配合 Research API 使用，一同排除 |
| 结果缓存 | 不缓存搜索/爬取结果，保持实时性 |
| 自动重试 | 不自动重试失败请求，由 Agent 决定 |
| Provider 抽象 | 当前仅实现 Tavily，不做 Provider 机制抽象 |
| 流式响应 | 不支持流式返回，等待完整结果 |

---

## 六、Quality Attributes（质量属性）

### 6.1 可靠性

- 错误清晰传递，不吞没异常
- 参数严格验证，防止无效请求
- 失败 URL 明确列出（extract 场景）

### 6.2 可维护性

- 代码结构清晰，职责单一
- 类型完备，便于重构
- 每个工具独立文件，易于定位

### 6.3 可扩展性

- 支持添加新工具（如 research）
- 配置项可扩展
- 后续可扩展为 Provider 机制

### 6.4 可测试性

- 客户端单例可重置
- 依赖可注入
- 参数验证可独立测试

---

## 七、与其他模块的关系

| 模块 | 代码位置 | 关系 | 说明 |
|------|----------|------|------|
| tool-scheduler | `src/core/tool-scheduler/` | 被调用 | 注册工具，接受调度 |
| config/tools/tavily | `src/config/tools/tavily/` | 依赖 | 获取配置 |
| message | `src/core/message/` | 遵循 | 工具输出符合 ToolPart 格式 |

---

## 八、文档自检

- [x] 模块目标明确
- [x] 职责边界清晰
- [x] 每个工具的输入输出定义完整
- [x] 非目标明确列出
- [x] 与其他模块的职责划分清晰
- [x] 组件职责单一
