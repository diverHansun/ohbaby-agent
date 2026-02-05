# cli/commands 模块 dfd-interface.md

本文档描述 `cli/commands` 模块与外部模块的数据流和接口定义。

**模块位置**：
- 代码：`src/cli/commands/`
- 文档：`docs/cli/commands/`

---

## 一、Context and Scope（上下文与范围）

cli/commands 模块是 commands 模块在终端环境下的薄封装层：

```
┌─────────────────────────────────────────────────────────────────┐
│                     UI Layer (REPL/TUI)                         │
│                   用户输入 Slash Command                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 原始输入字符串
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    cli/commands 模块                             │
│                 代码: src/cli/commands/                          │
│                    （本文档描述范围）                             │
│   ┌──────────┐                           ┌──────────┐           │
│   │  Parser  │ ─────────────────────────→│ Renderer │           │
│   └──────────┘                           └──────────┘           │
│        │ { path, args }                       ▲                 │
└────────┼──────────────────────────────────────┼─────────────────┘
         │                                      │ CommandResult
         ▼                                      │
┌─────────────────────────────────────────────────────────────────┐
│                 commands 模块 (CommandService)                   │
│                 代码: src/commands/                              │
│                 文档: docs/commands/                             │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │ • 命令发现和加载（Loaders）                                │  │
│   │ • 子命令树解析和执行                                       │  │
│   │ • 命令建议（Levenshtein 距离）                             │  │
│   │ • 业务逻辑协调                                             │  │
│   └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**核心原则**：cli/commands 是薄封装层，只负责解析和渲染。命令发现、执行、建议等功能由 CommandService 提供。

**与本模块交互的外部模块**：

| 模块 | 代码位置 | 文档位置 | 关系 |
|------|----------|----------|------|
| UI Layer | `src/cli/ui/` | - | 调用方 |
| commands | `src/commands/` | `docs/commands/` | 被调用方 |
| lifecycle | `src/lifecycle/` | `docs/services/lifecycle/` | 间接（通过 action 触发） |

---

## 二、Data Flow Description（数据流描述）

### 2.1 典型数据流：简单命令执行

```
1. 用户在终端输入 "/mcp list"
2. UI Layer 调用 executeSlashCommand("/mcp list", context, commandService)
3. Parser 解析输入:
   - 提取路径: "mcp list"
   - 提取参数: ""
4. 调用 CommandService.execute("mcp list", "", commandContext)
5. CommandService 在子命令树中查找并执行 mcp.list.action
6. action 返回 CommandResult:
   { success: true, type: 'data', data: [...servers] }
7. Renderer 根据 type='data' 选择表格渲染策略
8. Renderer 格式化 servers 数据为 ASCII 表格
9. executeSlashCommand 返回 { handled: true, output: "..." }
10. UI Layer 输出到终端
```

### 2.2 数据流：交互式命令执行

```
1. 用户输入 "/model switch"（无参数）
2. Parser 解析: { path: "model switch", args: "" }
3. 调用 CommandService.execute("model switch", "", commandContext)
4. CommandService 执行 switch.action，返回:
   { success: true, type: 'interactive', interactive: { dialog: 'model-select', data: [...models] } }
5. Renderer 检测到 type='interactive'，显示模型选择对话框
6. 用户选择 "gemini-pro"
7. Renderer 再次调用 CommandService.execute("model switch", "gemini-pro", commandContext)
8. action 执行切换，返回成功消息
9. Renderer 渲染成功消息
10. 返回结果给 UI Layer
```

### 2.3 数据流：带 action 的命令

```
1. 用户输入 "/exit"
2. Parser 解析: { path: "exit", args: "" }
3. 调用 CommandService.execute("exit", "", commandContext)
4. action 返回: { success: true, type: 'action', action: { type: 'exit' } }
5. Renderer 渲染告别消息
6. executeSlashCommand 返回 { handled: true, action: { type: 'exit' } }
7. UI Layer 检测到 exit action，执行退出逻辑
```

### 2.4 数据流：prompt 类型（/init）

```
1. 用户输入 "/init"
2. Parser 解析: { path: "init", args: "" }
3. 调用 CommandService.execute("init", "", commandContext)
4. action 读取模板文件，返回: { success: true, type: 'prompt', prompt: "请分析项目..." }
5. Renderer 显示提示消息（表示正在生成 IRIS.md）
6. executeSlashCommand 返回 { handled: true, action: { type: 'prompt', payload: "..." } }
7. UI Layer 将 prompt 提交给 LLM 处理
```

### 2.5 数据流：未知命令（带建议）

```
1. 用户输入 "/mdoel"（拼写错误）
2. Parser 解析: { path: "mdoel", args: "" }
3. 调用 CommandService.execute("mdoel", "", commandContext)
4. CommandService 未找到命令，计算 Levenshtein 距离
5. action 返回: { success: false, error: { code: 'COMMAND_NOT_FOUND', message: '未知命令: mdoel', suggestion: 'model' } }
6. Renderer 渲染错误信息和建议: "未知命令: /mdoel，您是否想输入: /model"
7. executeSlashCommand 返回 { handled: true, output: "..." }
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### executeSlashCommand

执行 Slash Command

```typescript
async function executeSlashCommand(
  input: string,
  context: CliContext,
  commandService: CommandService
): Promise<SlashCommandResult>
```

**参数说明**：
- `input`：原始用户输入（如 "/model switch gemini-pro"）
- `context`：CLI 执行上下文（终端信息）
- `commandService`：CommandService 实例（由 commands 模块提供）

**返回值**：
```typescript
interface SlashCommandResult {
  handled: boolean                // 命令是否被识别和处理
  output?: string                 // 渲染后的输出文本（用于直接输出）
  action?: {
    type: 'prompt' | 'exit' | 'switch_session' | 'clear'
    payload?: unknown
  }
}
```

#### getSlashCommandCompletions（V2）

获取命令自动补全建议（V2 实现，MVP 不实现）

```typescript
function getSlashCommandCompletions(
  partial: string,
  commandService: CommandService
): CompletionItem[]
```

**参数说明**：
- `partial`：用户已输入的部分命令（如 "/mo"）
- `commandService`：CommandService 实例

**返回值**：
```typescript
interface CompletionItem {
  text: string          // 完整命令文本
  description: string   // 命令描述
}
```

**实现方式**：调用 `commandService.getCommands()` 获取命令树，遍历匹配前缀。

#### getSlashCommandHelp

获取命令帮助信息

```typescript
function getSlashCommandHelp(
  command: string | undefined,
  commandService: CommandService
): string
```

**参数说明**：
- `command`：可选，指定命令名称；无参数时返回所有命令帮助（按 category 分组）
- `commandService`：CommandService 实例

#### isSlashCommand

判断输入是否为 Slash Command

```typescript
function isSlashCommand(input: string): boolean
```

**实现**：简单检查是否以 `/` 开头。

### 3.2 依赖的外部接口

| 模块 | 接口 | 用途 |
|------|------|------|
| commands | `CommandService.execute(path, args, context)` | 执行命令业务逻辑 |
| commands | `CommandService.getCommands()` | 获取命令列表（用于帮助和补全） |
| commands | `CommandService.findCommand(name)` | 查找命令并获取建议 |

### 3.3 与 UI Layer 的交互协议

UI Layer 调用 cli/commands 后，需要根据返回结果执行相应动作：

```typescript
const result = await executeSlashCommand(input, context, commandService)

if (!result.handled) {
  // 不是有效的 Slash Command，可能是普通输入
  return handleNormalInput(input)
}

// 输出渲染结果
if (result.output) {
  console.log(result.output)
}

// 处理特殊 action
if (result.action) {
  switch (result.action.type) {
    case 'exit':
      process.exit(0)
      break
    case 'prompt':
      // 将 payload 作为 prompt 提交给 LLM
      await submitToLLM(result.action.payload)
      break
    case 'switch_session':
      // 会话切换由 Bus 事件触发，这里可能需要刷新 UI
      refreshUI()
      break
    case 'clear':
      // 清屏或清除历史
      clearScreen()
      break
  }
}
```

---

## 四、Parser 接口详情

### 4.1 解析规则

Parser 只负责提取命令路径和参数字符串，不做命令验证（由 CommandService 负责）：

| 输入格式 | 解析结果 |
|----------|----------|
| `/cmd` | `{ path: "cmd", args: "" }` |
| `/cmd sub` | `{ path: "cmd sub", args: "" }` |
| `/cmd sub arg1` | `{ path: "cmd sub", args: "arg1" }` |
| `/cmd sub --opt val` | `{ path: "cmd sub", args: "--opt val" }` |
| `/cmd sub --flag arg` | `{ path: "cmd sub", args: "--flag arg" }` |

**注意**：参数解析由 commands 模块的各命令 action 负责，cli/commands 只传递原始参数字符串。

### 4.2 特殊语法

| 语法 | 说明 |
|------|------|
| `/?` | 等价于 `/help` |

**注意**：不再支持别名（如 `/quit`），每个命令只有一个名称。

### 4.3 解析错误处理

Parser 本身只检查格式错误，命令验证由 CommandService 负责：

```typescript
// Parser 只返回解析结果，不返回错误
interface ParsedInput {
  path: string    // 命令路径
  args: string    // 参数字符串
  raw: string     // 原始输入
}

// 命令验证错误由 CommandService 返回
// 在 CommandResult.error 中包含 suggestion 字段
```

---

## 五、Renderer 接口详情

### 5.1 渲染策略

| CommandResult.type | 渲染方式 |
|-------------------|----------|
| `data` | 根据数据结构自动选择表格或列表 |
| `message` | 格式化文本消息 |
| `prompt` | 显示处理中提示 |
| `action` | 显示相应的操作消息 |
| `interactive` | 显示交互式对话框（模型选择、会话选择等） |
| error | 红色错误信息 + 建议（使用 Levenshtein 距离计算的建议） |

### 5.2 /compact 命令渲染

`/compact` 命令返回的 CommandResult 包含压缩统计，需特殊渲染：

```typescript
// /compact 命令返回结构
interface CompactCommandResult {
  type: 'message'
  data: {
    text: string
    status: 'compressed' | 'skipped' | 'failed'
    originalTokens?: number
    newTokens?: number
    savedTokens?: number
  }
}

// 渲染示例
if (result.data.status === 'compressed') {
  // ✓ 上下文已压缩
  //   原始: 85,000 tokens → 压缩后: 28,000 tokens
  //   节省: 57,000 tokens (67%)
}
if (result.data.status === 'skipped') {
  // ⊜ 无需压缩 - 历史消息太少
}
if (result.data.status === 'failed') {
  // ✗ 压缩失败: [error message]
}
```

### 5.3 自动压缩通知订阅

cli/commands 模块应订阅 `Context.Event.Compressed` 事件，用于显示自动压缩的简短通知：

```typescript
import { Context } from '@/core/context'
import { Bus } from '@/bus'

// 订阅自动压缩事件
Bus.subscribe(Context.Event.Compressed, (event) => {
  const { result } = event
  if (result.status === 'compressed') {
    // 显示简短通知（不打断当前操作）
    showNotification(
      `⊚ 上下文已自动压缩（${formatPercent(result.originalTokens, limit)} → ${formatPercent(result.newTokens, limit)}）`
    )
  }
})
```

**注意**：
- 自动压缩发生时，Agent 处于阻塞等待状态
- 通知不应影响当前的 UI 状态（如不清除输入框）
- 压缩内容（LLM 生成的摘要）不输出到终端

### 5.4 /status 命令渲染

`/status` 命令返回详细系统状态，需要格式化渲染：

```typescript
// /status 命令返回结构（来自 commands 模块）
interface StatusInfo {
  model: { name: string; provider: string }
  api: { connected: boolean; latency?: number }
  mode: 'ask' | 'plan' | 'agent'
  agentState: 'ask-before-edit' | 'edit-automatically'
  mcpServers: Record<string, McpClientStatus>
  session: { id: string; name: string; messageCount: number }
  context: {
    currentTokens: number
    contextLimit: number
    usageRatio: number
    remainingTokens: number
  }
}

// 渲染示例输出
function renderStatus(info: StatusInfo): string {
  const percent = Math.round(info.context.usageRatio * 100)
  const currentFormatted = formatNumber(info.context.currentTokens)  // "12.5k"
  const limitFormatted = formatNumber(info.context.contextLimit)    // "128k"

  return `
System Status
─────────────────────────────
Model:    ${info.model.name} (${info.model.provider})
API:      ${info.api.connected ? '✓ Connected' : '✗ Disconnected'}${info.api.latency ? ` (${info.api.latency}ms)` : ''}
Mode:     ${info.mode}
Agent:    ${info.agentState}
Session:  ${info.session.name} (${info.session.messageCount} messages)
Context:  ${currentFormatted} / ${limitFormatted} (${percent}%)
MCP:      ${Object.keys(info.mcpServers).length} servers
─────────────────────────────
`
}
```

**说明**：
- `/status` 命令用于主动查询详细系统状态
- 与 StatusBar（状态栏）不同，StatusBar 始终显示在界面底部，只显示简化信息
- Context 使用量显示：`"12.5k / 128k (10%)"` 格式

### 5.5 数据渲染规则

```typescript
// 数组数据 -> 表格
if (Array.isArray(result.data)) {
  return formatTable(result.data, inferColumns(result.data))
}

// 对象数据 -> 键值列表
if (typeof result.data === 'object') {
  return formatKeyValueList(result.data)
}

// 原始值 -> 直接输出
return String(result.data)
```

---

## 六、Data Ownership and Responsibility（数据归属与责任）

| 数据 | 创建者 | 更新者 | 说明 |
|------|--------|--------|------|
| 原始输入 | UI Layer | - | 用户输入，传入后不修改 |
| ParsedCommand | Parser | - | 解析结果，一次性创建 |
| CommandResult | commands | - | 来自 commands 模块 |
| 渲染输出 | Renderer | - | 格式化后的字符串 |
| SlashCommandResult | cli/commands | - | 返回给 UI Layer |

**责任边界说明**：
- cli/commands 不修改 CommandResult，只读取并渲染
- 解析失败时直接返回错误信息，不调用 commands 模块
- action 类型由 UI Layer 负责执行

---

## 七、交互式组件接口

### 7.1 选择列表

```typescript
async function showSelectList<T>(options: {
  message: string
  items: Array<{ label: string; value: T; hint?: string }>
  defaultValue?: T
}): Promise<T | null>
```

### 7.2 确认框

```typescript
async function showConfirm(options: {
  message: string
  default?: boolean
}): Promise<boolean>
```

### 7.3 文本输入

```typescript
async function showTextInput(options: {
  message: string
  placeholder?: string
  validate?: (value: string) => string | null
}): Promise<string | null>
```

---

## 八、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 接口定义关注语义而非实现细节
- [x] 与 UI Layer 的交互协议明确
