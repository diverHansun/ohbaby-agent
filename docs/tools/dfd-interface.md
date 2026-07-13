# tools 模块 dfd-interface.md

本文档描述 `tools` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

tools 模块是纯工具实现层，位于 ToolScheduler 之下，提供具体的工具执行能力。

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| **ToolScheduler** | 输入 | 工具调用请求（参数 + 上下文） |
| **ToolScheduler** | 输出 | 工具执行结果（内容 + 元数据） |
| **文件系统** | 双向 | 文件读写操作 |
| **Shell** | 输出 | 命令执行 |
| **网络** | 输出 | HTTP 请求 |

### 本文档范围

- 描述工具模块的对外接口
- 描述工具执行的数据流
- 明确工具与 ToolScheduler 的交互方式

---

## 二、Data Flow Description（数据流描述）

### 2.1 工具执行流程

```
ToolScheduler                     tools 模块                    外部资源
     │                                │                            │
     │  1. 调用 tool.execute()        │                            │
     │     (params, context)          │                            │
     │------------------------------->│                            │
     │                                │                            │
     │                   2. 参数验证（Zod）                         │
     │                                │                            │
     │                   3. 执行核心逻辑                            │
     │                                │  4. 访问资源               │
     │                                │--------------------------->│
     │                                │                            │
     │                                │  5. 资源返回               │
     │                                │<---------------------------|
     │                                │                            │
     │                   6. 处理输出（截断、格式化）                 │
     │                                │                            │
     │  7. 返回 ToolOutput            │                            │
     │<-------------------------------|                            │
```

### 2.2 取消执行流程

```
ToolScheduler                     tools 模块
     │                                │
     │  1. 调用 tool.execute()        │
     │     context.signal             │
     │------------------------------->│
     │                                │
     │                   2. 开始执行   │
     │                                │
     │  3. signal.abort()             │
     │------------------------------->│
     │                                │
     │                   4. 检测到取消 │
     │                   5. 清理资源   │
     │                                │
     │  6. 返回（或抛出 AbortError）   │
     │<-------------------------------|
```

---

## 三、Interface Definition（接口定义）

### 3.1 工具接口

#### Tool.execute()

**语义**：执行工具的核心逻辑

**输入**：
- params: 工具参数（类型由 Zod Schema 定义）
- context: ToolContext（执行上下文）

**输出**：
- Promise<ToolOutput>：执行结果

**异步特性**：异步

**示例**：
```typescript
const result = await ReadTool.execute(
  { file_path: '/path/to/file', limit: 100 },
  { sessionId, messageId, callId, signal }
)
```

---

### 3.2 工具导出接口

#### getAllTools()

**语义**：获取所有内置工具

**输入**：无

**输出**：Tool[] - 所有内置工具数组

**用途**：供 ToolScheduler 初始化时注册

---

#### getToolByName()

**语义**：根据名称获取工具

**输入**：
- name: string - 工具名称

**输出**：Tool | undefined

---

### 3.3 工具定义接口

#### Tool.define()

**语义**：定义一个新工具

**输入**：
- config: ToolConfig（name, description, parameters, execute）

**输出**：Tool

**用途**：内部使用，定义工具时使用

---

## 四、Tool Interfaces（各工具接口）

### 4.1 read 工具

**名称**：`read`

**描述**：读取文件内容，支持文本、图片、PDF

**参数**：
```typescript
{
  file_path: string      // 必需，绝对路径
  offset?: number        // 可选，起始行号
  limit?: number         // 可选，读取行数
}
```

**返回**：
```typescript
{
  content: string        // 文件内容（带行号）或 base64
  metadata: {
    lineCount: number
    fileSize: number
    fileType: 'text' | 'image' | 'pdf'
    truncated?: boolean
  }
}
```

**错误场景**：
- FileNotFoundError：文件不存在
- PermissionDeniedError：无读取权限
- BinaryFileError：二进制文件

---

### 4.2 write 工具

**名称**：`write`

**描述**：将内容写入文件，创建不存在的目录

**参数**：
```typescript
{
  file_path: string      // 必需，绝对路径
  content: string        // 必需，要写入的内容
}
```

**返回**：
```typescript
{
  content: string        // 确认信息
  metadata: {
    created: boolean     // 是否新创建
    bytesWritten: number
  }
}
```

---

### 4.3 edit 工具

**名称**：`edit`

**描述**：替换文件中的文本

**参数**：
```typescript
{
  file_path: string      // 必需，绝对路径
  old_string: string     // 必需，要替换的文本
  new_string: string     // 必需，替换后的文本
  replace_all?: boolean  // 可选，替换所有匹配
}
```

**返回**：
```typescript
{
  content: string        // diff 输出
  metadata: {
    replacementCount: number
    diff: string
  }
}
```

**错误场景**：
- FileNotFoundError：文件不存在
- NoMatchFoundError：未找到匹配文本

---

### 4.4 glob 工具

**名称**：`glob`

**描述**：使用模式匹配搜索文件

**参数**：
```typescript
{
  pattern: string        // 必需，glob 模式
  path?: string          // 可选，基础路径
}
```

**返回**：
```typescript
{
  content: string        // 文件列表（每行一个）
  metadata: {
    matchCount: number
    truncated?: boolean
    totalCount?: number
  }
}
```

---

### 4.5 grep 工具

**名称**：`grep`

**描述**：在文件内容中搜索正则表达式

**参数**：
```typescript
{
  pattern: string        // 必需，正则表达式
  path?: string          // 可选，搜索路径
  include?: string       // 可选，文件过滤模式
}
```

**返回**：
```typescript
{
  content: string        // 匹配结果（文件:行号:内容）
  metadata: {
    matchCount: number
    truncated?: boolean
  }
}
```

---

### 4.6 list 工具

**名称**：`list`

**描述**：列出目录结构

**参数**：
```typescript
{
  path?: string          // 可选，目录路径
  ignore?: string[]      // 可选，忽略模式
}
```

**返回**：
```typescript
{
  content: string        // 树形结构
  metadata: {
    fileCount: number
    truncated?: boolean
  }
}
```

---

### 4.7 bash 工具

**名称**：`bash`

**描述**：执行 Shell 命令

**参数**：
```typescript
{
  command: string        // 必需，命令
  description: string    // 必需，命令描述
  timeout?: number       // 可选，超时（毫秒）
  workdir?: string       // 可选，工作目录
}
```

**返回**：
```typescript
{
  content: string        // 命令输出
  metadata: {
    exitCode: number
    truncated?: boolean
  }
}
```

**错误场景**：
- TimeoutError：执行超时
- ExecutionError：命令执行失败

---

### 4.8 web_fetch 工具

**名称**：`web_fetch`

**描述**：获取 URL 内容

**参数**：
```typescript
{
  url: string            // 必需，URL
  format?: 'text' | 'markdown' | 'html'  // 可选，返回格式
  timeout?: number       // 可选，超时（毫秒）
}
```

**返回**：
```typescript
{
  content: string        // 网页内容
  metadata: {
    contentType: string
    contentLength: number
  }
}
```

**错误场景**：
- NetworkError：网络请求失败
- TimeoutError：请求超时

---

### 4.9 web_search 工具

**名称**：`web_search`

**描述**：网络搜索

**参数**：
```typescript
{
  query: string          // 必需，搜索关键词
  num_results?: number   // 可选，结果数量
  type?: 'auto' | 'fast' | 'deep'  // 可选，搜索类型
}
```

**返回**：
```typescript
{
  content: string        // 搜索结果
  metadata: {
    resultCount: number
  }
}
```

---

### 4.10 todo_write / todo_read 工具

**名称**：`todo_write` / `todo_read`

**描述**：管理待办事项列表

**todo_write 参数**：
```typescript
{
  todos: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
  }>
}
```

`todos` 最多 10 项；每项 `content` trim 后非空且最多 100 个 Unicode 字符。数组整体替换当前 session/context scope 的列表，`[]` 表示显式清空。

**todo_read 参数**：无

**返回**：
```typescript
{
  content: string        // 格式化的待办列表
  metadata: {
    count: number
    todos: Array<{
      content: string
      status: 'pending' | 'in_progress' | 'completed'
    }>
  }
}
```

`todo_read` 不产生更新事件；发生实际变化的成功 `todo_write` 通过 `UiSnapshot.todos` / `todo.updated` 向 Web/TUI 投影完整列表。两个工具的 call/result 不进入正常 transcript，底层消息历史仍保留以供 Agent 和恢复使用。详见 [`todo-list/dfd-interface.md`](./todo-list/dfd-interface.md)。

---

## 五、Data Ownership & Responsibility（数据归属与责任）

### 5.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| ToolContext | ToolScheduler | 调用工具时创建 |
| ToolOutput | tools 模块 | 工具执行后返回 |
| 参数验证错误 | Zod | 参数不合法时 |

### 5.2 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 参数验证 | tools（Zod） | ToolScheduler |
| 执行逻辑 | tools | ToolScheduler |
| 输出截断 | tools | ToolScheduler |
| 权限检查 | ToolScheduler | tools |
| 状态管理 | ToolScheduler | tools |
| 并发控制 | ToolScheduler | tools |

---

## 六、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰
- [x] 每个工具的接口定义完整
- [x] 接口定义与 data-model.md 中的类型一致
