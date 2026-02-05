# tools 模块 architecture.md

本文档描述 `tools` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

tools 模块是 iris-code 的工具实现层，提供纯净的工具函数，不包含业务逻辑。每个工具是一个独立的执行单元，接收参数并返回结果。

### 模块结构

```
tools/
├── index.ts              # 导出所有工具
├── types.ts              # 工具类型定义
├── utils/                # 工具共享的工具函数
│   ├── file.ts          # 文件处理工具
│   ├── output.ts        # 输出格式化工具
│   └── binary.ts        # 二进制检测工具
│
├── read.ts              # 文件读取
├── write.ts             # 文件写入
├── edit.ts              # 文件编辑
├── glob.ts              # 文件搜索
├── grep.ts              # 内容搜索
├── list.ts              # 目录列表
├── bash.ts              # 命令执行
├── task.ts              # 子代理调用
└── todo.ts              # 待办事项
```

---

## 二、Tool Definition Pattern（工具定义模式）

### 2.1 统一的工具定义

每个工具遵循相同的定义模式：

```typescript
// 工具定义结构
const ReadTool = Tool.define({
  name: 'read',
  description: '读取文件内容...',
  parameters: z.object({
    file_path: z.string().describe('文件的绝对路径'),
    offset: z.number().optional().describe('起始行号'),
    limit: z.number().optional().describe('读取行数'),
  }),
  execute: async (params, context) => {
    // 执行逻辑
    return { content, metadata }
  }
})
```

### 2.2 工具组成要素

| 要素 | 说明 | 用途 |
|------|------|------|
| name | 工具唯一标识 | ToolScheduler 查找工具 |
| description | 工具功能描述 | LLM 理解工具用途 |
| parameters | Zod Schema | 参数验证、LLM 生成参数 |
| execute | 执行函数 | 实际执行逻辑 |

---

## 三、Core Components（核心组件）

### 3.1 工具类型定义（types.ts）

定义工具相关的核心类型：

- `Tool`: 工具接口定义
- `ToolContext`: 执行上下文
- `ToolOutput`: 返回值格式
- `Tool.define()`: 工具定义辅助函数

### 3.2 共享工具函数（utils/）

**file.ts**：文件处理
- 路径解析和验证
- 文件类型检测
- 编码处理

**output.ts**：输出处理
- 行号添加
- 输出截断
- 截断提示生成

**binary.ts**：二进制检测
- 检测文件是否为二进制
- 检测不可打印字符

---

## 四、Tool Implementations（工具实现）

### 4.1 文件操作工具

#### read（文件读取）

```
输入: file_path, offset?, limit?
输出: 文件内容（带行号）
限制: 默认 2000 行，每行 2000 字符
特殊: 支持图片（base64）、PDF（文本提取）
```

#### write（文件写入）

```
输入: file_path, content
输出: 写入确认、诊断信息
特殊: 创建不存在的目录
```

#### edit（文件编辑）

```
输入: file_path, old_string, new_string, replace_all?
输出: diff 信息、诊断信息
特殊: 多种替换策略、相似度匹配
```

### 4.2 搜索工具

#### glob（文件搜索）

```
输入: pattern, path?
输出: 匹配的文件列表
限制: 100 个文件
排序: 按修改时间（最新优先）
```

#### grep（内容搜索）

```
输入: pattern, path?, include?
输出: 匹配结果（文件:行号:内容）
限制: 100 个匹配
排序: 按修改时间
```

#### list（目录列表）

```
输入: path?, ignore?
输出: 树形目录结构
限制: 100 个文件
默认忽略: node_modules, .git, dist 等
```

### 4.3 命令执行工具

#### bash（Shell 命令）

```
输入: command, timeout?, workdir?, description
输出: 命令输出、退出码
限制: 30,000 字符输出，2 分钟超时
特殊: 跨平台 Shell 选择、进程树终止
```

**bash 工具执行流程**：

```
1. 命令解析（调用 utils/command-parser）
   ├── getCommandRoots(command) 提取命令头部
   └── detectPaths(command) 检测路径参数
   |
   v
2. 权限检查 ─────────────────────────────────────┐
   ├── 检查 external_directory（调用 utils/paths.contains）│
   ├── 检查是否为关键操作（调用 Policy.isCritical）   │
   └── 匹配 Agent 配置的 bash 权限模式                 │
   |                                                  │
   v                                                  │
3. Permission.ask() ──────────────────────────────┤ [特殊：bash 工具自行调用]
   |                                                  │
   v                                                  │
4. Shell.acceptable() 获取 shell 路径                 │
   |                                                  │
   v                                                  │
5. 执行命令（spawn）                                   │
   |                                                  │
   v                                                  │
6. 超时/取消时调用 Shell.killTree() 清理进程           │
   |                                                  │
   v                                                  │
7. 返回输出和退出码                                    │
───────────────────────────────────────────────────────┘
```

**权限检查细节**：

| 检查步骤 | 输入 | 输出 | 调用接口 |
|----------|------|------|----------|
| 解析命令 | `command` 字符串 | 命令头部 + 路径参数 | `utils/command-parser.getCommandRoots()` + `detectPaths()` |
| external_directory | 路径参数列表 | 是否访问项目外目录 | `utils/paths.contains(projectRoot, path)` |
| 关键操作 | 命令头部 | 是否为关键操作 | `Policy.isCritical(command, agentConfig)` |
| 权限模式匹配 | 命令 + Agent 配置 | `allow` / `deny` / `ask` | `utils/command-parser.matchesPattern()` |

**与 ToolScheduler 的分工**：

| 职责 | 负责方 | 说明 |
|------|--------|------|
| 工具级权限检查 | ToolScheduler | 检查 bash 工具是否被禁用 |
| 命令级权限检查 | bash 工具 | 解析命令内容后检查 |
| 调用 Permission.ask() | bash 工具 | 工具自行调用，非 ToolScheduler |
| 执行命令 | bash 工具 | 权限通过后执行 |

### 4.4 子代理工具

#### task（子代理调用）

```
输入: description, prompt, subagent_type, session_id?
输出: 子代理执行结果
特殊: 子代理禁用此工具防止递归
```

**task 工具执行流程**：

```
1. 接收任务参数
   │
   ▼
2. 调用 SubagentExecutor.execute()
   ├── 检查并发数 (< MAX_CONCURRENT_SUBAGENTS)
   ├── 获取子代理配置
   ├── 验证 mode !== 'primary'
   ├── 创建子 Session
   └── 调用 Lifecycle.run()
   │
   ▼
3. 返回 SubagentResult
   ├── sessionId
   ├── success
   ├── output
   └── summary (工具调用记录)
```

### 4.5 任务管理工具

#### todo_write / todo_read

```
输入: todos 数组 (包含 id, content, status, priority)
输出: 任务列表
状态: pending, in_progress, completed, cancelled
优先级: high, medium, low
```

---

## 五、Design Patterns（设计模式）

### 5.1 工厂模式

使用 `Tool.define()` 工厂函数创建工具，确保所有工具符合统一接口。

### 5.2 策略模式

edit 工具使用多种替换策略，按优先级尝试：

1. SimpleReplacer - 精确匹配
2. LineTrimmedReplacer - 行修剪匹配
3. WhitespaceNormalizedReplacer - 空格规范化
4. IndentationFlexibleReplacer - 缩进灵活匹配
5. ...更多策略

### 5.3 模板方法模式

所有工具遵循相同的执行流程：
1. 参数验证（由 Zod Schema 自动完成）
2. 执行核心逻辑
3. 格式化输出
4. 返回结果

---

## 六、Output Limits（输出限制）

### 6.1 限制配置

| 工具 | 限制项 | 默认值 |
|------|--------|--------|
| read | 行数 | 2,000 |
| read | 行长 | 2,000 字符 |
| bash | 输出 | 30,000 字符 |
| bash | 超时 | 120 秒 |
| glob | 结果数 | 100 |
| grep | 匹配数 | 100 |
| web_fetch | 响应大小 | 5 MB |
| web_fetch | 超时 | 30 秒 |

### 6.2 截断处理

当输出超出限制时：
1. 截断到限制值
2. 在输出末尾添加截断提示
3. 提示中包含总数信息

示例：
```
... (truncated, showing 100 of 256 files)
```

---

## 七、Error Handling（错误处理）

### 7.1 错误类型

| 错误类型 | 场景 | 处理方式 |
|----------|------|----------|
| FileNotFoundError | 文件不存在 | 返回错误信息 |
| PermissionDeniedError | 无文件权限 | 返回错误信息 |
| BinaryFileError | 尝试读取二进制 | 拒绝并提示 |
| TimeoutError | 命令超时 | 终止并返回已有输出 |
| InvalidParameterError | 参数无效 | 由 Zod 自动处理 |

### 7.2 错误返回格式

```typescript
{
  content: '',
  error: {
    type: 'FileNotFoundError',
    message: 'File not found: /path/to/file'
  }
}
```

---

## 八、Dependencies（依赖）

### 8.1 外部依赖

| 依赖 | 用途 |
|------|------|
| zod | 参数验证 |
| ripgrep | glob/grep 实现 |
| turndown | HTML 转 Markdown |

### 8.2 内部依赖

工具模块原则上不依赖其他业务模块，保持纯净。

**例外：bash 工具和 task 工具**

bash 工具需要依赖业务模块：

| 依赖模块 | 调用接口 | 用途 |
|----------|----------|------|
| utils/command-parser | `getCommandRoots()` | 解析命令，提取命令头部列表 |
| utils/command-parser | `detectPaths()` | 检测命令中的路径参数 |
| utils/command-parser | `matchesPattern()` | 匹配 bash 权限模式 |
| utils/paths | `contains()` | 检查路径是否在项目目录内 |
| Shell | `acceptable()` | 获取兼容的 shell 路径 |
| Shell | `killTree()` | 清理超时/取消的进程树 |
| Permission | `ask()` | 请求命令执行确认 |
| Policy | `isCritical()` | 检查是否为关键操作 |

task 工具需要依赖 agents 模块：

| 依赖模块 | 调用接口 | 用途 |
|----------|----------|------|
| agents | `SubagentExecutor.execute()` | 执行子代理任务 |
| agents | `AgentManager.get()` | 获取子代理配置 |

**依赖理由**：
- bash 工具的权限粒度需要到命令级别
- task 工具是子代理的入口，必须调用 SubagentExecutor
- ToolScheduler 无法解析 bash 命令内容
- 这些依赖是特殊工具的需求，不适用于其他工具

---

## 九、Extension Points（扩展点）

### 9.1 扩展工具支持

本模块只包含内置工具。扩展工具（Extension Tools）和 MCP 工具由其他模块管理，但需遵循相同的 Tool 接口定义。

### 9.2 工具接口兼容性

扩展工具需要实现 Tool 接口，并额外声明：
- category: 工具类别
- requiredConfig: 所需配置项

---

## 十、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 每个工具的职责单一、边界清晰
- [x] 设计模式选择有明确理由
- [x] 错误处理策略明确
- [x] 输出限制有合理默认值
