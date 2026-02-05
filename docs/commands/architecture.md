# commands 模块 architecture.md

本文档描述 `commands` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

commands 模块采用 **CommandService + Loader 模式**，通过子命令树结构组织命令：

```
┌─────────────────────────────────────────────────────────────────┐
│                      CommandService                             │
│                     （命令发现与聚合）                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
        ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
        │BuiltinLoader│ │ FileLoader  │ │McpPromptLdr │
        │  (V1 实现)   │ │  (V2 预留)  │ │  (V2 预留)  │
        └──────┬──────┘ └─────────────┘ └─────────────┘
               │
               ▼
        ┌─────────────────────────────────────────────────┐
        │                 builtin/                         │
        │    子命令树结构的内置命令实现                      │
        │    model, session, mcp, status, ...             │
        └─────────────────────────────────────────────────┘
```

### 文件结构

```
src/commands/
├── index.ts                    # 模块入口，导出 Commands 命名空间
├── types.ts                    # 核心类型定义（SlashCommand、CommandResult 等）
├── service.ts                  # CommandService 实现
│
├── loaders/                    # 命令加载器
│   ├── index.ts               # 导出所有 Loader
│   ├── types.ts               # ICommandLoader 接口定义
│   └── BuiltinLoader.ts       # 内置命令加载器（V1）
│   # FileLoader.ts            # 文件命令加载器（V2 预留）
│   # McpPromptLoader.ts       # MCP Prompt 加载器（V2 预留）
│
├── builtin/                    # 内置命令实现（业务逻辑）
│   ├── index.ts               # 导出所有内置命令
│   ├── model.ts               # /model 命令（含 list, switch 子命令）
│   ├── session.ts             # /session 命令
│   ├── mcp.ts                 # /mcp 命令
│   ├── agents.ts              # /agents 命令
│   ├── memory.ts              # /memory 命令
│   ├── status.ts              # /status 命令
│   ├── help.ts                # /help 命令
│   ├── tools.ts               # /tools 命令
│   ├── compact.ts             # /compact 命令
│   ├── init.ts                # /init 命令
│   ├── stats.ts               # /stats 命令
│   ├── approval-mode.ts       # /approval-mode 命令
│   ├── abort.ts               # abort 命令（内部使用）
│   └── exit.ts                # /exit 命令
│
├── utils/                      # 工具函数
│   └── levenshtein.ts         # Levenshtein 距离计算（命令建议）
│
└── template/                   # 命令模板
    └── init.txt               # /init 命令的 Prompt 模板
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **index.ts** | 模块入口，导出 Commands 命名空间和事件定义 |
| **types.ts** | 定义 SlashCommand、CommandResult 等核心类型 |
| **service.ts** | CommandService 实现，管理命令发现和执行 |
| **loaders/** | 命令加载器，从不同来源加载命令 |
| **builtin/** | 内置命令的业务逻辑实现 |
| **utils/** | 工具函数（如 Levenshtein 距离） |
| **template/** | 命令模板文件 |

---

## 二、Design Pattern and Rationale（设计模式与理由）

### 1. 加载器模式（Loader Pattern）

**使用理由**：
- 分离命令发现与命令实现
- 便于未来扩展（文件命令、MCP 命令）
- 符合开放封闭原则

**实现方式**：
```typescript
// loaders/types.ts
interface ICommandLoader {
  load(signal: AbortSignal): Promise<SlashCommand[]>
}

// service.ts
class CommandService {
  static async create(
    loaders: ICommandLoader[],
    signal: AbortSignal
  ): Promise<CommandService> {
    const commands: SlashCommand[] = []
    for (const loader of loaders) {
      const loaded = await loader.load(signal)
      commands.push(...loaded)
    }
    return new CommandService(commands)
  }
}
```

### 2. 子命令树结构（Command Tree）

**使用理由**：
- 命令自然分组（/model list, /model switch）
- 便于生成帮助信息
- 预留 Tab 补全能力

**实现方式**：
```typescript
// 子命令树结构
const modelCommand: SlashCommand = {
  name: 'model',
  description: '模型管理',
  category: 'model',
  subCommands: [
    {
      name: 'list',
      description: '列出所有可用模型',
      action: async (ctx, args) => { /* ... */ }
    },
    {
      name: 'switch',
      description: '切换模型',
      action: async (ctx, args) => { /* ... */ }
    }
  ]
}
```

### 3. 无状态命令执行

**使用理由**：
- 每次调用独立，便于测试
- 避免状态同步问题
- 状态由各功能模块管理

**实现方式**：
- 命令函数是纯函数
- 通过 CommandContext 传递执行环境
- 通过 CommandResult 返回结果

### 4. 未使用的模式

**未使用中间件模式**：
- 当前不需要命令拦截或前置/后置处理
- 保持简单，KISS 原则
- 未来如需可扩展

**未使用单例模式**：
- CommandService 在应用启动时创建一次
- 通过参数传递而非全局单例

---

## 三、Module Structure and File Layout（模块结构与文件组织）

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 导出 Commands 命名空间 |
| `types.ts` | 类型定义 | SlashCommand、CommandResult 等 |
| `service.ts` | 核心服务 | CommandService 实现 |
| `loaders/*.ts` | 命令加载 | 各加载器实现 |
| `builtin/*.ts` | 命令实现 | 内置命令业务逻辑 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `Commands.execute(name, args, context)` 方法
- `Commands.getCommands()` 方法
- `Commands.findCommand(name)` 方法
- `Commands.Event.Executed` 事件
- `SlashCommand` 类型定义
- `CommandResult` 类型定义

### 内部实现

以下内容为内部实现，可自由重构：
- CommandService 的具体实现
- 各 Loader 的加载逻辑
- 各命令文件的内部实现

---

## 四、核心类型定义

### SlashCommand（命令定义）

```typescript
interface SlashCommand {
  name: string                     // 命令名称
  description: string              // 命令描述
  category: CommandCategory        // 命令分类
  hidden?: boolean                 // 是否在 help 中隐藏

  // 执行函数（叶子命令必须有）
  action?: (context: CommandContext, args: string) => Promise<CommandResult>

  // 子命令（父命令可以有）
  subCommands?: SlashCommand[]
}

type CommandCategory =
  | 'model'       // 模型相关
  | 'context'     // 上下文相关
  | 'session'     // 会话相关
  | 'tools'       // 工具相关
  | 'system'      // 系统相关
```

### CommandResult（命令执行结果）

```typescript
interface CommandResult {
  success: boolean
  type: 'data' | 'message' | 'prompt' | 'action' | 'interactive'
  data?: unknown               // 结构化数据
  message?: string             // 简单消息
  prompt?: string              // 提交给 LLM 的 Prompt
  action?: {
    type: 'switch_session' | 'exit' | 'clear' | 'refresh'
    payload?: unknown
  }
  interactive?: {              // 需要交互式 UI
    dialog: 'model-select' | 'session-select' | 'confirm'
    data: unknown
  }
  error?: {
    code: string
    message: string
    suggestion?: string        // 命令建议（拼写错误时）
  }
}
```

### CommandContext（命令上下文）

```typescript
interface CommandContext {
  sessionId: string            // 当前会话 ID
  workingDirectory: string     // 当前工作目录
  signal?: AbortSignal         // 取消信号
}
```

### ICommandLoader（加载器接口）

```typescript
interface ICommandLoader {
  /**
   * 加载命令列表
   * @param signal 取消信号
   * @returns 命令列表
   */
  load(signal: AbortSignal): Promise<SlashCommand[]>
}
```

---

## 五、Architectural Constraints and Trade-offs（约束与权衡）

### 约束 1: 无状态设计

**当前选择**：commands 模块不持有任何状态

**代价**：
- 每次执行需要重新获取必要信息
- 无法缓存中间结果

**理由**：
- 简化测试，每次调用独立
- 避免状态同步问题
- 状态由各功能模块管理

### 约束 2: 启动时加载

**当前选择**：CommandService 在应用启动时创建，加载所有命令

**代价**：
- 启动时需要加载所有命令
- 运行期间新增命令需要刷新

**理由**：
- 简化运行时逻辑
- 命令查找性能更好
- 可通过 `/commands refresh` 刷新（V2）

### 约束 3: 子命令树结构

**当前选择**：使用嵌套树结构而非点分隔命名

**代价**：
- 解析逻辑稍复杂
- 需要递归查找命令

**理由**：
- 帮助信息自然分组
- 便于 Tab 补全
- 与 gemini-cli 设计一致

### 约束 4: V1 只有 BuiltinLoader

**当前选择**：V1 版本只实现内置命令加载器

**代价**：
- 不支持用户自定义命令
- 不支持 MCP Prompt 命令

**理由**：
- 降低 V1 复杂度
- 架构已预留扩展点
- V2 可添加 FileLoader 和 McpPromptLoader

---

## 六、命令优先级规则

当多个 Loader 返回同名命令时，按以下优先级处理：

1. **Builtin**（最高）- 内置命令
2. **File**（中）- 用户自定义命令（V2）
3. **MCP**（最低）- MCP Prompt 命令（V2）

```typescript
// 示例：同名命令处理
const commands = new Map<string, SlashCommand>()

// 按优先级加载，后加载的不覆盖已有命令
for (const loader of [builtinLoader, fileLoader, mcpLoader]) {
  for (const cmd of await loader.load(signal)) {
    if (!commands.has(cmd.name)) {
      commands.set(cmd.name, cmd)
    }
  }
}
```

---

## 七、命令解析流程

```
输入: "/model switch gemini-pro"
           │
           ▼
    ┌──────────────────────────────────────────┐
    │ 1. 拆分路径: ['model', 'switch']          │
    │ 2. 提取参数: 'gemini-pro'                 │
    └──────────────────────────────────────────┘
           │
           ▼
    ┌──────────────────────────────────────────┐
    │ 3. 在命令树中递归查找                      │
    │    - 找到 'model' 命令                    │
    │    - 在 subCommands 中找到 'switch'       │
    └──────────────────────────────────────────┘
           │
           ▼
    ┌──────────────────────────────────────────┐
    │ 4. 调用 switch.action(context, args)      │
    │    - context: { sessionId, workingDir }   │
    │    - args: 'gemini-pro'                   │
    └──────────────────────────────────────────┘
           │
           ▼
    ┌──────────────────────────────────────────┐
    │ 5. 返回 CommandResult                     │
    │    { success: true, type: 'message', ... }│
    └──────────────────────────────────────────┘
```

### 无参数时的行为

当用户输入 `/model`（无子命令）时：
1. 找到 `model` 命令
2. 检查是否有 `action`
3. 如无 `action` 且有 `subCommands`，返回帮助信息

```typescript
// 无参数时显示帮助
if (!targetCommand.action && targetCommand.subCommands) {
  return {
    success: true,
    type: 'message',
    message: formatSubCommandsHelp(targetCommand)
  }
}
```

---

## 八、错误处理与命令建议

### Levenshtein 距离匹配

当用户输入未知命令时，使用 Levenshtein 距离提供建议：

```typescript
// utils/levenshtein.ts
function findSimilarCommand(
  input: string,
  commands: SlashCommand[],
  maxDistance: number = 2
): string | undefined {
  // 计算输入与所有命令名的距离
  // 返回距离最小且 <= maxDistance 的命令名
}

// 使用示例
const suggestion = findSimilarCommand('mdoel', commands)
// suggestion: 'model'

return {
  success: false,
  error: {
    code: 'COMMAND_NOT_FOUND',
    message: `未知命令: mdoel`,
    suggestion: `您是否想输入: /model`
  }
}
```

---

## 九、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构足够简单，核心代码可控制在合理范围内
- [x] 预留了 V2 扩展点（FileLoader、McpPromptLoader）
