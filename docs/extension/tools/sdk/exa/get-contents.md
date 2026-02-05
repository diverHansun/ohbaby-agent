# exa_get_contents Tool Documentation

本文档详细描述 `exa_get_contents` 工具的功能、参数和使用方式。

---

## 一、Overview（概述）

### 工具信息

| 属性 | 值 |
|------|-----|
| 名称 | `exa_get_contents` |
| 分类 | `network` |
| 来源 | exa-js SDK |
| 功能 | URL 内容提取 |

### 功能描述

`exa_get_contents` 是基于 Exa AI 的内容提取工具，提供以下能力：

- **文本提取**：从网页提取干净的文本内容
- **高亮获取**：获取页面关键片段
- **摘要生成**：获取页面内容摘要
- **批量处理**：支持同时处理多个 URL

---

## 二、Parameters（参数）

### 参数列表

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| `urls` | string[] | ✅ | - | URL 列表 (1-100) |
| `text` | boolean | ❌ | true | 是否获取文本内容 |
| `max_characters` | number | ❌ | 10000 | 文本最大字符数 |
| `highlights` | boolean | ❌ | false | 是否获取高亮片段 |
| `summary` | boolean | ❌ | false | 是否获取摘要 |

### 参数详情

#### urls (必填)

要获取内容的 URL 列表。

- 必须是有效的 URL（以 `http://` 或 `https://` 开头）
- 最少 1 个，最多 100 个

```typescript
// 单个 URL
urls: ["https://example.com/article"]

// 多个 URL
urls: [
  "https://example.com/article1",
  "https://example.com/article2",
  "https://another-site.com/page"
]
```

#### text (可选)

是否获取页面的文本内容。

- `true`：获取文本（默认）
- `false`：不获取文本

```typescript
// 获取文本内容
text: true

// 不获取文本（只要高亮或摘要）
text: false
```

#### max_characters (可选)

每个 URL 的文本最大字符数。

- 最小值：1
- 最大值：100000
- 默认值：10000

```typescript
// 获取更多内容
max_characters: 50000

// 只要简短内容
max_characters: 2000
```

#### highlights (可选)

是否获取页面的关键片段（高亮）。

- `true`：获取高亮
- `false`：不获取（默认）

高亮是 Exa AI 自动识别的页面关键内容片段。

```typescript
// 获取高亮
highlights: true
```

#### summary (可选)

是否获取页面的自动生成摘要。

- `true`：获取摘要
- `false`：不获取（默认）

摘要是 Exa AI 对页面内容的自动总结。

```typescript
// 获取摘要
summary: true
```

---

## 三、Output（输出）

### 成功输出

Markdown 格式的内容结果：

```markdown
# Exa Contents

Retrieved 2 URLs
Request ID: req_xyz789

## Content 1
**URL:** https://example.com/article1
**Title:** Understanding Machine Learning

**Summary:**
This article provides a comprehensive introduction to machine learning,
covering supervised and unsupervised learning approaches...

**Highlights:**
- Machine learning is a subset of artificial intelligence
- Deep learning has revolutionized image recognition
- Transfer learning enables efficient model development

**Full Text:**
Machine learning (ML) is a type of artificial intelligence (AI) that
allows software applications to become more accurate at predicting
outcomes without being explicitly programmed to do so...

---

## Content 2
**URL:** https://example.com/article2
**Title:** Neural Networks Explained

**Summary:**
A beginner-friendly explanation of neural networks and their applications...

**Full Text:**
Neural networks are computing systems inspired by biological neural
networks that constitute animal brains...

---

**Cost:** $0.0008
```

### 元数据

```typescript
{
  num_urls: 2,           // 处理的 URL 数
  request_id: 'req_xyz789',  // 请求 ID
  cost: 0.0008           // API 费用（美元）
}
```

### 错误输出

```typescript
{
  error: {
    type: 'ExaGetContentsError',
    code: 400,
    message: 'Invalid URL format',
    suggestion: 'Please ensure all URLs are valid and accessible'
  }
}
```

---

## 四、Usage Examples（使用示例）

### 基础内容获取

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: ["https://example.com/article"]
  }
}
```

### 获取完整信息

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: ["https://example.com/article"],
    text: true,
    max_characters: 20000,
    highlights: true,
    summary: true
  }
}
```

### 批量获取

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: [
      "https://example.com/page1",
      "https://example.com/page2",
      "https://example.com/page3"
    ],
    max_characters: 5000
  }
}
```

### 只获取摘要

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: ["https://long-article.com/post"],
    text: false,
    summary: true
  }
}
```

### 获取关键片段

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: ["https://research-paper.com/paper.html"],
    text: false,
    highlights: true
  }
}
```

---

## 五、Configuration（配置）

### 配置文件位置

```
项目级：{project}/.iris-code/tools/exa.yaml
用户级：~/.config/iris-code/tools/exa.yaml
```

### 相关配置项

```yaml
exa:
  get_contents:
    default_max_characters: 10000  # 默认文本长度
    include_highlights: false      # 默认是否包含高亮
    include_summary: false         # 默认是否包含摘要
```

---

## 六、Error Handling（错误处理）

### 常见错误

| 错误码 | 错误类型 | 原因 | 解决方案 |
|--------|----------|------|----------|
| 401 | ExaGetContentsError | API Key 无效 | 检查 .env 中的 EXA_API_KEY |
| 400 | ExaGetContentsError | URL 格式错误 | 确保 URL 格式正确 |
| 404 | ExaGetContentsError | URL 不可访问 | 检查 URL 是否可访问 |
| 429 | ExaGetContentsError | 速率限制 | 等待后重试 |
| 500 | ExaGetContentsError | 服务端错误 | 稍后重试 |

### 部分失败处理

当批量请求中部分 URL 失败时：
- 成功的 URL 会返回内容
- 失败的 URL 会在结果中标注错误

### 错误处理策略

- 工具层不自动重试
- 错误信息包含建议
- 由 Agent 决定是否重新调用

---

## 七、Best Practices（最佳实践）

### URL 选择

1. **确保 URL 可访问**：提交前验证 URL 有效性
   ```typescript
   // 使用完整 URL
   urls: ["https://example.com/full/path/to/article"]
   ```

2. **避免需要登录的页面**：Exa 无法访问需要认证的内容

3. **优先使用直接链接**：避免重定向链接

### 内容选择

1. **按需获取**：只请求需要的内容类型
   ```typescript
   // 只要摘要，不要全文
   text: false,
   summary: true
   ```

2. **控制文本长度**：避免获取过多内容
   ```typescript
   max_characters: 5000  // 合理的长度
   ```

3. **使用高亮**：快速获取关键信息
   ```typescript
   highlights: true  // 获取页面要点
   ```

### 批量处理

1. **合理分批**：不要一次请求太多 URL
   ```typescript
   // 推荐：每批 10-20 个 URL
   urls: [...first20Urls]
   ```

2. **相关内容一起获取**：减少请求次数
   ```typescript
   // 一次获取相关页面
   urls: [mainArticle, relatedArticle1, relatedArticle2]
   ```

---

## 八、Use Cases（使用场景）

### 场景 1：深入阅读搜索结果

在 `exa_search` 找到相关文章后，使用 `exa_get_contents` 获取完整内容：

```typescript
// 1. 先搜索
const searchResult = await exa_search({
  query: "TypeScript design patterns",
  num_results: 5,
  include_text: false  // 搜索时不要全文
})

// 2. 获取感兴趣的文章全文
const contents = await exa_get_contents({
  urls: [searchResult.results[0].url],
  max_characters: 20000
})
```

### 场景 2：批量文档分析

分析多个相关文档：

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: [
      "https://docs.python.org/3/tutorial/classes.html",
      "https://docs.python.org/3/tutorial/modules.html",
      "https://docs.python.org/3/tutorial/errors.html"
    ],
    summary: true,
    highlights: true
  }
}
```

### 场景 3：快速页面摘要

快速了解页面内容而不读全文：

```typescript
{
  name: "exa_get_contents",
  params: {
    urls: ["https://long-article.com/very-long-post"],
    text: false,
    summary: true,
    highlights: true
  }
}
```

---

## 九、Limitations（限制）

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 最大 URL 数 | 100 | 单次请求 |
| 最大文本长度 | 100,000 字符 | 单个 URL |
| URL 格式 | http/https | 必须是有效 URL |
| 请求超时 | 由 tool-scheduler 控制 | - |
| 需要登录的页面 | 不支持 | 无法访问 |

---

## 十、Related Tools（相关工具）

- [exa_search](./exa-search.md) - Web 语义搜索

---

## 十一、Workflow Example（工作流示例）

典型的搜索-获取工作流：

```
1. Agent 需要了解某个主题
   │
   ▼
2. 调用 exa_search 搜索相关内容
   │  params: { query: "topic", include_text: false }
   │
   ▼
3. 获取搜索结果列表（只有链接和标题）
   │
   ▼
4. Agent 选择最相关的 URL
   │
   ▼
5. 调用 exa_get_contents 获取详细内容
   │  params: { urls: [selected_urls], summary: true }
   │
   ▼
6. Agent 分析内容并回答用户问题
```

---

## 十二、Changelog（变更日志）

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-01 | 初始版本 |
