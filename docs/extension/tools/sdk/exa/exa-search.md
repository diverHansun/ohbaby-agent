# exa_search Tool Documentation

本文档详细描述 `exa_search` 工具的功能、参数和使用方式。

---

## 一、Overview（概述）

### 工具信息

| 属性 | 值 |
|------|-----|
| 名称 | `exa_search` |
| 分类 | `network` |
| 来源 | exa-js SDK |
| 功能 | Web 语义搜索 |

### 功能描述

`exa_search` 是基于 Exa AI 的 Web 搜索工具，提供以下能力：

- **语义搜索**：基于含义而非关键词匹配
- **域名过滤**：包含或排除特定网站
- **日期过滤**：按发布日期筛选
- **分类过滤**：聚焦特定内容类型
- **内容获取**：可选获取搜索结果的文本内容

---

## 二、Parameters（参数）

### 参数列表

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| `query` | string | ✅ | - | 搜索查询字符串 |
| `type` | enum | ❌ | 配置文件 | 搜索类型 |
| `num_results` | number | ❌ | 10 | 返回结果数量 (1-100) |
| `include_domains` | string[] | ❌ | - | 包含的域名列表 |
| `exclude_domains` | string[] | ❌ | - | 排除的域名列表 |
| `start_published_date` | string | ❌ | - | 发布起始日期 (YYYY-MM-DD) |
| `end_published_date` | string | ❌ | - | 发布结束日期 (YYYY-MM-DD) |
| `category` | enum | ❌ | - | 内容分类 |
| `include_text` | boolean | ❌ | true | 是否包含文本内容 |
| `max_characters` | number | ❌ | 10000 | 文本最大字符数 (1-100000) |

### 参数详情

#### query (必填)

搜索查询字符串，支持自然语言查询。

```typescript
// 示例
query: "latest developments in artificial intelligence 2024"
query: "machine learning best practices for production"
query: "TypeScript design patterns"
```

#### type (可选)

搜索类型，控制搜索算法：

| 值 | 描述 | 适用场景 |
|-----|------|----------|
| `neural` | 语义搜索，理解查询含义 | 复杂问题、概念性搜索 |
| `keyword` | 关键词精确匹配 | 精确术语、代码搜索 |
| `auto` | 自动选择最佳方式 | 通用场景 |
| `fast` | 快速搜索，牺牲部分精度 | 需要快速响应时 |

```typescript
// 示例
type: "neural"   // 语义搜索
type: "keyword"  // 关键词搜索
```

#### num_results (可选)

返回的搜索结果数量。

- 最小值：1
- 最大值：100
- 默认值：10

```typescript
// 示例
num_results: 5   // 返回 5 条结果
num_results: 20  // 返回 20 条结果
```

#### include_domains / exclude_domains (可选)

域名过滤，限制搜索范围。

```typescript
// 只搜索特定网站
include_domains: ["arxiv.org", "nature.com", "github.com"]

// 排除特定网站
exclude_domains: ["pinterest.com", "reddit.com"]
```

#### start_published_date / end_published_date (可选)

日期过滤，格式为 `YYYY-MM-DD`。

```typescript
// 搜索 2024 年的内容
start_published_date: "2024-01-01"
end_published_date: "2024-12-31"

// 搜索最近 30 天
start_published_date: "2024-11-01"
```

#### category (可选)

内容分类过滤，可选值：

| 值 | 描述 |
|-----|------|
| `company` | 公司信息 |
| `research paper` | 学术论文 |
| `news` | 新闻报道 |
| `pdf` | PDF 文档 |
| `github` | GitHub 仓库 |
| `tweet` | Twitter/X 帖子 |
| `personal site` | 个人网站 |
| `financial report` | 财务报告 |
| `people` | 人物信息 |

```typescript
// 只搜索学术论文
category: "research paper"

// 只搜索 GitHub
category: "github"
```

#### include_text (可选)

是否在搜索结果中包含文本内容。

- `true`：包含文本（默认）
- `false`：仅返回元数据

```typescript
// 不获取文本内容，只要链接
include_text: false
```

#### max_characters (可选)

每个结果的文本最大字符数。

- 最小值：1
- 最大值：100000
- 默认值：10000

```typescript
// 获取更多文本
max_characters: 20000

// 只要摘要级别的文本
max_characters: 1000
```

---

## 三、Output（输出）

### 成功输出

Markdown 格式的搜索结果：

```markdown
# Exa Search Results

Found 5 results
Request ID: req_abc123

## Result 1
**Title:** Advances in Large Language Models
**URL:** https://arxiv.org/abs/2024.12345
**Published:** 2024-01-15
**Author:** John Doe
**Score:** 0.923

**Content:**
This paper presents significant advances in large language models,
demonstrating improved performance across multiple benchmarks...

---

## Result 2
**Title:** Machine Learning in Production
**URL:** https://example.com/ml-production
**Published:** 2024-02-20
**Score:** 0.891

**Content:**
Best practices for deploying machine learning models...

---

**Cost:** $0.0012
```

### 元数据

```typescript
{
  num_results: 5,        // 返回的结果数
  request_id: 'req_abc123',  // 请求 ID
  cost: 0.0012           // API 费用（美元）
}
```

### 错误输出

```typescript
{
  error: {
    type: 'ExaSearchError',
    code: 401,
    message: 'Invalid API key',
    suggestion: 'Please check your EXA_API_KEY in .env file'
  }
}
```

---

## 四、Usage Examples（使用示例）

### 基础搜索

```typescript
{
  name: "exa_search",
  params: {
    query: "TypeScript best practices 2024"
  }
}
```

### 高级搜索

```typescript
{
  name: "exa_search",
  params: {
    query: "machine learning deployment strategies",
    type: "neural",
    num_results: 10,
    include_domains: ["arxiv.org", "papers.nips.cc"],
    start_published_date: "2024-01-01",
    category: "research paper",
    max_characters: 5000
  }
}
```

### 快速元数据搜索

```typescript
{
  name: "exa_search",
  params: {
    query: "OpenAI GPT-4",
    num_results: 20,
    include_text: false  // 只要链接，不要内容
  }
}
```

### 新闻搜索

```typescript
{
  name: "exa_search",
  params: {
    query: "AI regulation Europe",
    category: "news",
    start_published_date: "2024-11-01",
    num_results: 10
  }
}
```

---

## 五、Configuration（配置）

### 配置文件位置

```
项目级：{project}/.ohbaby-code/tools/exa.yaml
用户级：~/.config/ohbaby-code/tools/exa.yaml
```

### 相关配置项

```yaml
exa:
  search:
    default_mode: neural          # 默认搜索类型
    default_num_results: 10       # 默认结果数
    default_max_characters: 10000 # 默认文本长度
```

---

## 六、Error Handling（错误处理）

### 常见错误

| 错误码 | 错误类型 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 401 | ExaSearchError | API Key 无效 | 检查 .env 中的 EXA_API_KEY |
| 400 | ExaSearchError | 参数错误 | 检查参数格式和值 |
| 429 | ExaSearchError | 速率限制 | 等待后重试 |
| 500 | ExaSearchError | 服务端错误 | 稍后重试 |

### 错误处理策略

- 工具层不自动重试
- 错误信息包含建议
- 由 Agent 决定是否重新调用

---

## 七、Best Practices（最佳实践）

### 查询优化

1. **使用自然语言**：Exa 擅长理解自然语言查询
   ```
   ✅ "How to implement authentication in Node.js"
   ❌ "nodejs auth impl"
   ```

2. **明确时间范围**：使用日期过滤获取新鲜内容
   ```typescript
   start_published_date: "2024-01-01"
   ```

3. **域名过滤**：针对特定来源搜索
   ```typescript
   include_domains: ["stackoverflow.com", "github.com"]
   ```

### 性能优化

1. **控制结果数量**：只请求需要的数量
   ```typescript
   num_results: 5  // 而不是默认的 10
   ```

2. **按需获取内容**：不需要全文时关闭
   ```typescript
   include_text: false
   ```

3. **限制文本长度**：减少传输数据
   ```typescript
   max_characters: 2000
   ```

### 分类使用

- `research paper`：学术研究
- `github`：代码和项目
- `news`：时事新闻
- `company`：公司信息

---

## 八、Limitations（限制）

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 最大结果数 | 100 | Exa API 限制 |
| 最大文本长度 | 100,000 字符 | 单个结果 |
| 请求超时 | 由 tool-scheduler 控制 | - |
| 速率限制 | 取决于 Exa 账户计划 | - |

---

## 九、Related Tools（相关工具）

- [exa_get_contents](./get-contents.md) - 从 URL 获取详细内容

---

## 十、Changelog（变更日志）

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-01 | 初始版本 |
