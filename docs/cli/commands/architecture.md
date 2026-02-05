# cli/commands 模块 architecture.md

本文档描述 `cli/commands` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

cli/commands 模块采用**薄封装架构**，职责是解析用户输入并渲染 CommandService 的执行结果：

```
用户输入: "/model switch gemini-pro"
           │
           ▼
   ┌───────────────────┐
   │     Parser        │  解析阶段
   │  提取命令路径和参数 │
   └─────────┬─────────┘
             │ { path: "model switch", args: "gemini-pro" }
             ▼
   ┌───────────────────┐
   │ CommandService    │  执行阶段
   │  (commands 模块)   │  ← 业务逻辑在这里
   └─────────┬─────────┘
             │ CommandResult
             ▼
   ┌───────────────────┐
   │    Renderer       │  渲染阶段
   │  输出格式化       │
   └───────────────────┘
```

**核心原则**：cli/commands 是薄封装层，不包含业务逻辑。所有命令发现、执行、建议等功能由 commands 模块的 CommandService 提供。

### 文件结构

```
src/cli/commands/
├── index.ts              # 模块入口，导出 executeSlashCommand 等公共接口
├── parser.ts             # 命令解析器（提取命令路径和参数）
├── renderer.ts           # 结果渲染器（根据 CommandResult 类型渲染）
├── interactive.ts        # 交互式 UI 组件（选择列表、确认框）
└── formatters/           # 格式化工具
    ├── table.ts          # 表格格式化
    ├── list.ts           # 列表格式化
    └── message.ts        # 消息格式化
```

**注意**：不再需要 `slash-commands/` 目录，因为命令定义已移至 commands 模块的 `builtin/` 目录。cli/commands 只负责解析和渲染。

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **index.ts** | 模块入口，导出 executeSlashCommand 等公共接口 |
| **parser.ts** | 解析 Slash Command 字符串，提取命令路径和参数 |
| **renderer.ts** | 根据 CommandResult 类型选择渲染方式 |
| **interactive.ts** | 交互式组件（选择列表、确认框），复用 ui/components/dialogs |
| **formatters/** | 各类数据的格式化工具 |

---

## 二、Design Pattern and Rationale（设计模式与理由）

### 1. 管道模式（Pipeline Pattern）

**使用理由**：
- 命令处理天然是"输入 -> 处理 -> 输出"的流程
- 各阶段职责清晰，易于独立测试

**实现方式**：
```typescript
async function executeSlashCommand(
  input: string,
  context: CliContext,
  commandService: CommandService
): Promise<SlashCommandResult> {
  // 1. 解析：提取命令路径和参数
  const { path, args } = parser.parse(input)

  // 2. 执行：调用 CommandService（业务逻辑在 commands 模块）
  const commandContext = buildCommandContext(context)
  const result = await commandService.execute(path, args, commandContext)

  // 3. 渲染：根据 CommandResult 类型格式化输出
  return renderer.render(result, context)
}
```

### 2. 策略模式（Strategy Pattern）- 渲染器

**使用理由**：
- 不同类型的 CommandResult 需要不同的渲染方式
- 便于扩展新的渲染类型

**实现方式**：
```typescript
const renderStrategies = {
  data: renderDataResult,
  message: renderMessageResult,
  prompt: renderPromptResult,
  action: renderActionResult,
  interactive: renderInteractiveResult,  // 需要交互式 UI
}

function render(result: CommandResult, context: CliContext): SlashCommandResult {
  // 错误处理
  if (!result.success && result.error) {
    return renderError(result.error, context)
  }

  const strategy = renderStrategies[result.type]
  return strategy(result, context)
}
```

### 3. 未使用的模式

**未使用命令注册表**：
- 命令定义和发现由 commands 模块的 CommandService 负责
- cli/commands 不维护命令列表

**未使用依赖注入容器**：
- 依赖关系简单（仅依赖 CommandService）
- 通过构造函数参数传递即可
- KISS 原则

---

## 三、Module Structure and File Layout（模块结构与文件组织）

### 格式化工具

```typescript
// formatters/table.ts

interface TableColumn {
  key: string
  header: string
  width?: number
  align?: 'left' | 'right' | 'center'
}

function formatTable(data: unknown[], columns: TableColumn[]): string {
  // 格式化为 ASCII 表格
}
```

### 对外稳定接口

以下内容构成模块的公共 API：
- `executeSlashCommand(input: string, context: CliContext): Promise<SlashCommandResult>`
- `getSlashCommandCompletions(partial: string): string[]` - 用于自动补全
- `getSlashCommandHelp(command?: string): string` - 获取帮助文本

### 内部实现

以下内容为内部实现，可自由重构：
- Parser 的具体解析逻辑
- Renderer 的格式化细节
- 交互式 UI 的实现方式

---

## 四、核心类型定义

### ParsedInput（解析结果）

```typescript
interface ParsedInput {
  path: string                    // 命令路径（如 "model switch"）
  args: string                    // 参数字符串（如 "gemini-pro"）
  raw: string                     // 原始输入
}
```

**注意**：cli/commands 不再定义 SlashCommandDefinition，命令定义由 commands 模块的 SlashCommand 类型负责。

### CliContext（CLI 上下文）

```typescript
interface CliContext {
  sessionId?: string              // 当前会话 ID
  projectId?: string              // 当前项目 ID
  terminal: {
    width: number
    height: number
    supportsColor: boolean
  }
}
```

### SlashCommandResult（执行结果）

```typescript
interface SlashCommandResult {
  handled: boolean                // 命令是否被处理
  output?: string                 // 渲染后的输出文本
  action?: {
    type: 'prompt' | 'exit' | 'switch_session'
    payload?: unknown
  }
}
```

---

## 五、Architectural Constraints and Trade-offs（约束与权衡）

### 约束 1: 薄封装原则

**当前选择**：cli/commands 不包含业务逻辑

**代价**：
- 需要与 commands 模块保持接口同步
- 某些边界情况需要在两层都处理

**理由**：
- 支持多端复用
- 便于测试
- 职责分离清晰

### 约束 2: 同步渲染

**当前选择**：收到 CommandResult 后立即渲染完成

**代价**：
- 长时间运行的命令期间无法显示进度

**理由**：
- 大多数命令执行时间短
- 进度显示可通过 Bus 事件独立实现
- 简化渲染逻辑

### 约束 3: ASCII 表格

**当前选择**：使用纯 ASCII 字符绘制表格

**代价**：
- 视觉效果不如 Unicode Box Drawing

**理由**：
- 兼容性更好
- 复制粘贴更友好

---

## 六、交互式 UI 设计

### 选择列表

用于模型选择、会话选择等场景：

```
? 请选择模型:
  ❯ gemini-pro      (Google Gemini Pro)
    gemini-flash    (Google Gemini Flash)
    gpt-4           (OpenAI GPT-4)
```

### 确认提示

用于危险操作确认：

```
? 确定要清除当前会话吗？此操作不可撤销。 (y/N)
```

### 进度提示

用于较长时间操作：

```
⠋ 正在刷新 MCP 服务器...
```

---

## 七、颜色规范

| 场景 | 颜色 |
|------|------|
| 成功消息 | 绿色 |
| 错误消息 | 红色 |
| 警告消息 | 黄色 |
| 命令/代码 | 青色 |
| 表头 | 加粗 |
| 提示文字 | 灰色 |

---

## 八、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构足够简单，各文件职责清晰
