# commands 模块 dfd-interface.md

本文档描述 `commands` 模块与外部模块的数据流和接口定义。

---

## 一、Context and Scope（上下文与范围）

commands 模块是用户命令的业务逻辑层，位于以下交互关系中：

```
┌─────────────────────────────────────────────────────────────────┐
│                        调用层 (CLI/UI)                          │
│                     CLI Commands 模块                           │
│                 代码: src/cli/commands/                         │
│                 文档: docs/cli/commands/                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 调用 Commands.execute()
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       commands 模块                              │
│                 代码: src/commands/                              │
│                    （本文档描述范围）                             │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 调用各功能模块
        ┌───────────┬───────────┼───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Session │ │ Message │ │   MCP   │ │ Policy  │ │ Memory  │
   └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
        │                                               
        └───────────────────► Bus ◄─────────────────────┘
                        事件发布
```

**与本模块交互的外部模块**：

| 模块 | 代码位置 | 文档位置 | 状态 |
|------|----------|----------|------|
| CLI Commands | `src/cli/commands/` | `docs/cli/commands/` | 待实现 |
| Bus | `src/bus/` | `docs/bus/` | 已设计 |
| Session | `src/services/session/` | `docs/services/session/` | 待实现 |
| Message | `src/services/message/` | `docs/services/message/` | 已设计 |
| Context | `src/core/context/` | `docs/core/context/` | 已设计 |
| MCP | `src/mcp/` | `docs/mcp/` | 已设计 |
| Policy | `src/policy/` | `docs/policy/` | 已设计 |
| Agent | `src/agents/` | `docs/agents/` | 已设计 |
| Provider | `src/config/` | `docs/config/` | 已设计 |
| Tools | `src/tools/` | `docs/tools/` | 已设计 |
| Permission | `src/permission/` | `docs/permission/` | 已设计 |
| Memory | `src/core/memory/` | `docs/core/memory/` | 已设计 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 典型数据流：命令执行

```
1. CLI Commands 接收用户输入 "/model switch gemini-pro"
2. CLI Commands 调用 CommandService.execute("model switch", "gemini-pro", context)
3. CommandService 解析路径 ["model", "switch"]，在子命令树中查找
4. 找到 model.subCommands.switch 命令
5. 执行 switch.action(context, "gemini-pro")
6. action 调用 Provider.switchModel("gemini-pro")
7. Provider 返回切换结果
8. action 返回 CommandResult { success: true, type: 'message', message: '已切换到 gemini-pro' }
9. CommandService 通过 Bus 发布 Command.Event.Executed
10. CommandService 返回 CommandResult 给 CLI Commands
11. CLI Commands 根据 CommandResult 渲染输出
```

### 2.2 数据流：Session 切换

```
1. CLI Commands 调用 CommandService.execute("session choose", "sess_123", context)
2. CommandService 解析路径，找到 session.subCommands.choose 命令
3. action 调用 Session.get("sess_123") 获取会话元数据
4. action 调用 Message.getMessages("sess_123") 获取消息历史
5. action 通过 Bus 发布 Session.Event.Switched 事件
6. lifecycle 模块订阅事件，加载新会话消息历史
7. action 返回 CommandResult { success: true, action: { type: 'switch_session' } }
```

### 2.3 数据流：Memory 添加

```
1. CLI Commands 调用 CommandService.execute("memory add", "--project \"内容\"", context)
2. CommandService 解析路径，找到 memory.subCommands.add 命令
3. action 解析参数，调用 Memory.add(content, scope)
4. Memory 模块写入 OHBABY.md 文件
5. Memory 模块发布 Memory.Event.Updated 事件
6. action 返回 CommandResult { success: true, type: 'message' }
```

### 2.4 数据流：Status 聚合

```
1. CLI Commands 调用 CommandService.execute("status", "", context)
2. action 并行调用:
   - Provider.getCurrentModel()
   - Provider.checkConnectivity()
   - MCP.getServerStatuses()
   - Tools.list()
   - Session.get(currentSessionId) / Message.getStats()
3. action 聚合所有结果
4. action 返回 CommandResult { success: true, type: 'data', data: { ... } }
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

CommandService 是 commands 模块的核心服务，通过工厂方法创建：

```typescript
class CommandService {
  /**
   * 创建 CommandService 实例
   * @param loaders 命令加载器列表（按优先级排序：Builtin > File > MCP）
   * @param signal 取消信号
   */
  static async create(
    loaders: ICommandLoader[],
    signal: AbortSignal
  ): Promise<CommandService>
}
```

#### CommandService.execute

执行指定命令

```typescript
async execute(
  commandPath: string,
  args: string,
  context: CommandContext
): Promise<CommandResult>
```

**参数说明**：
- `commandPath`：命令路径，支持子命令（如 "model switch"、"session list"）
- `args`：命令参数字符串（如 "gemini-pro"）
- `context`：命令执行上下文

**返回值**：CommandResult 结构

**执行流程**：
1. 解析命令路径，在子命令树中查找目标命令
2. 如果找到叶子命令，执行其 action 函数
3. 如果是父命令且无参数，返回子命令帮助信息
4. 如果命令不存在，返回错误并附带建议

#### CommandService.getCommands

获取所有可用命令列表

```typescript
getCommands(): SlashCommand[]
```

**返回值**：所有注册命令的定义数组（包含子命令树结构）

#### CommandService.findCommand

查找命令并提供建议

```typescript
findCommand(name: string): {
  command?: SlashCommand
  suggestion?: string
}
```

**返回值**：
- `command`：找到的命令（精确匹配或唯一前缀匹配）
- `suggestion`：未找到时的建议命令名（基于 Levenshtein 距离）

**示例**：
```typescript
findCommand("model")      // { command: modelCommand }
findCommand("mdoel")      // { suggestion: "model" }
findCommand("mod")        // { command: modelCommand } (唯一前缀匹配)
```

#### ICommandLoader 接口

命令加载器接口，用于从不同来源加载命令：

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

**V1 实现**：
- `BuiltinLoader`：加载内置命令（model, session, mcp, etc.）

**V2 预留**：
- `FileLoader`：加载用户自定义命令（TOML 格式）
- `McpPromptLoader`：加载 MCP Prompt 命令

**命令优先级**：当多个 Loader 返回同名命令时，按 Builtin > File > MCP 优先级处理。

### 3.2 发布的事件

#### Commands.Event.Executed

命令执行完成后发布。遵循 Bus 模块的事件定义规范（见 `docs/bus/dfd-interface.md`）。

```typescript
// src/commands/events.ts
import { BusEvent } from '@/bus/bus-event'
import { z } from 'zod'

export namespace Commands {
  export const Event = {
    Executed: BusEvent.define("commands.executed", z.object({
      name: z.string(),                    // 命令名称（如 "model.switch"）
      sessionId: z.string().optional(),    // 会话 ID
      arguments: z.record(z.unknown()),    // 命令参数
      success: z.boolean(),                // 是否成功
      duration: z.number(),                // 执行耗时（毫秒）
      error: z.object({
        code: z.string(),
        message: z.string(),
      }).optional(),                       // 错误信息（失败时）
    })),
  }
}
```

**事件发布时机**：每个命令执行完成后（无论成功或失败）

**订阅者**：UI 层（可选，用于日志或统计）

### 3.3 依赖的外部接口

#### Session 模块接口

代码位置：`src/services/session/`  
文档位置：`docs/services/session/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `SessionManager.get(sessionId)` | 获取会话元数据 | session.choose |
| `SessionManager.getByProject(projectId, options)` | 获取项目会话列表 | session.list |
| `SessionManager.create(projectDirectory, options)` | 创建新会话 | session.clear |
| `SessionManager.touch(sessionId)` | 更新会话时间戳 | session.choose |

#### Message 模块接口

代码位置：`src/services/message/`  
文档位置：`docs/services/message/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `MessageManager.getMessages(sessionId)` | 获取会话消息历史 | session.choose |

#### MCP 模块接口

代码位置：`src/mcp/`  
文档位置：`docs/mcp/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `McpManager.getStatus()` | 获取所有 MCP 服务器状态 | mcp.list, status |
| `McpManager.getAllTools()` | 获取所有 MCP 工具 | tools |
| `McpManager.dispose()` + 重新初始化 | 刷新 MCP 连接 | mcp.refresh |

**注意**：`mcp.auth` 命令的 OAuth 认证流程由 CLI Commands 层处理，commands 模块仅触发认证请求。

#### Policy 模块接口

代码位置：`src/policy/`  
文档位置：`docs/policy/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `Policy.getMode()` | 获取当前工作模式 | agents.mode, status |
| `Policy.setMode(mode)` | 设置工作模式 | agents.mode |
| `Policy.getAgentState()` | 获取 Agent 状态 | status |

#### Agent 模块接口

代码位置：`src/agents/`  
文档位置：`docs/agents/goals-duty.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `AgentManager.list()` | 获取所有代理列表 | agents.list |
| `AgentManager.get(name)` | 获取指定代理配置 | agents.list |

#### Provider 模块接口

代码位置：`src/config/`  
文档位置：`docs/config/`

| 接口 | 用途 | 命令 |
|------|------|------|
| `Provider.getCurrentModel()` | 获取当前模型 | model.current, status |
| `Provider.listModels()` | 获取可用模型列表 | model.list |
| `Provider.switchModel(name)` | 切换模型 | model.switch |
| `Provider.checkConnectivity()` | 检查 API 连通性 | status |

#### Permission 模块接口

代码位置：`src/permission/`  
文档位置：`docs/permission/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `Permission.getApprovalMode()` | 获取当前审批模式 | approval-mode |
| `Permission.setApprovalMode(mode)` | 设置审批模式 | approval-mode |

#### Tools 模块接口

代码位置：`src/tools/`  
文档位置：`docs/tools/goals-duty.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `ToolRegistry.getAll()` | 获取所有内置工具 | tools |

#### Memory 模块接口

代码位置：`src/core/memory/`  
文档位置：`docs/core/memory/`

| 接口 | 用途 | 命令 |
|------|------|------|
| `Memory.get()` | 获取全局和项目记忆内容 | memory.show |
| `Memory.add(content, scope)` | 添加记忆条目 | memory.add |
| `Memory.refresh()` | 刷新记忆（重新加载文件） | memory.refresh |

#### Context 模块接口

代码位置：`src/core/context/`  
文档位置：`docs/core/context/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `Context.compress(sessionId, force)` | 压缩会话上下文 | compact |
| `Context.getUsage(assembledContext, modelId)` | 获取上下文使用情况 | status |

#### Bus 模块接口

代码位置：`src/bus/`  
文档位置：`docs/bus/dfd-interface.md`

| 接口 | 用途 | 命令 |
|------|------|------|
| `Bus.publish(event, payload)` | 发布事件 | 所有命令 |

---

## 四、各命令的数据流详情

### 4.1 Model 命令族

| 命令 | 输入 | 处理流程 | 输出 |
|------|------|----------|------|
| model.list | 无 | `Provider.listModels()` | data: Model[] |
| model.switch | { name } | `Provider.switchModel(name)` | message: string |
| model.current | 无 | `Provider.getCurrentModel()` | data: Model |

### 4.2 Session 命令族

| 命令 | 输入 | 处理流程 | 输出 |
|------|------|----------|------|
| session.list | 无 | `SessionManager.getByProject(projectId, { status: 'active' })` | data: Session[] |
| session.choose | { sessionId } | `SessionManager.get(sessionId)` + `MessageManager.getMessages(sessionId)` + `Bus.publish(Session.Event.Switched)` | action: switch_session |
| session.clear | 无 | `SessionManager.create(projectDirectory)` + `Bus.publish(Session.Event.Created)` | action: clear |

### 4.3 MCP 命令族

| 命令 | 输入 | 处理流程 | 输出 |
|------|------|----------|------|
| mcp.list | 无 | `McpManager.getStatus()` | data: Record<string, McpClientStatus> |
| mcp.auth | { serverName } | 触发 OAuth 认证流程（由 CLI 层处理） | message: string |
| mcp.refresh | 无 | `McpManager.dispose()` + 重新初始化 | message: string |

### 4.4 Memory 命令族（待设计）

| 命令 | 输入 | 处理流程 | 输出 |
|------|------|----------|------|
| memory.show | 无 | `Memory.get()` | data: MemoryContent |
| memory.add | { content, scope } | `Memory.add(content, scope)` | message: string |
| memory.refresh | 无 | `Memory.refresh()` | message: string |

**注意**：Memory 模块接口已实现，见 `docs/core/memory/dfd-interface.md`

### 4.5 Compact 命令数据流

```
Commands.execute("compact", { sessionId })
   │
   ├─→ Context.compress(sessionId, true)
   │      │
   │      ├─→ Context.prune(sessionId)        → 标记旧的 tool output
   │      ├─→ Message.getMessages(sessionId)  → 获取历史
   │      ├─→ LLMClient.generateContent(...)  → 压缩摘要
   │      └─→ Message.updateMessage(summary)  → 创建 summary Message
   │
   └─→ 返回 CompressionResult { status, originalTokens, newTokens, savedTokens }
         │
         ▼
   构建 CommandResult {
     type: 'message',
     data: {
       text: '上下文已压缩',
       status: 'compressed',
       originalTokens: 85000,
       newTokens: 28000,
       savedTokens: 57000
     }
   }
```

### 4.6 Agents 命令族

| 命令 | 输入 | 处理流程 | 输出 |
|------|------|----------|------|
| agents.list | 无 | `AgentManager.list()` | data: AgentConfig[] |
| agents.mode | { mode } | `Policy.setMode(mode)` -> 发布 `Policy.Event.ModeChanged` | message: string |

**与 Policy 模块的交互流程**（参考 `docs/policy/dfd-interface.md` 第 55-81 行）：

```
Commands                    Policy 模块                     Bus
   │                            │                            │
   │ 1. setMode('plan')         │                            │
   │---------------------------→│                            │
   │                            │ 2. 更新内部模式状态         │
   │                            │ 3. 发布 ModeChanged         │
   │                            │---------------------------→│
   │ 4. 返回成功                │                            │
   │←---------------------------│                            │
```

### 4.7 其他命令

| 命令 | 输入 | 处理流程 | 输出 |
|------|------|----------|------|
| init | 无 | 读取 `src/commands/template/init.txt` | prompt: string |
| status | 无 | 聚合多模块数据（见下方详情） | data: StatusInfo |
| help | { command? } | 查询命令注册表 | data: CommandInfo[] |
| tools | 无 | `ToolRegistry.getAll()` + `McpManager.getAllTools()` | data: ToolInfo[] |
| approval-mode | { mode? } | `Permission.getApprovalMode()` / `Permission.setApprovalMode(mode)` | data 或 message |
| stats | 无 | `SessionManager.getByProject()` + 消息统计 | data: StatsInfo |
| exit | 无 | 无 | action: exit |

### 4.8 Status 命令详细数据流

```
Commands.execute("status", {})
   │
   ├─→ Provider.getCurrentModel()        → modelInfo
   ├─→ Provider.checkConnectivity()       → apiStatus
   ├─→ Policy.getMode()                   → currentMode
   ├─→ Policy.getAgentState()             → agentState
   ├─→ McpManager.getStatus()             → mcpServersStatus
   ├─→ SessionManager.get(currentSessionId) → sessionInfo
   └─→ Context.getUsage(context, modelId)  → contextUsage
         │
         ▼
   聚合为 StatusInfo {
     model: modelInfo,
     api: apiStatus,
     mode: currentMode,
     agentState: agentState,
     mcpServers: mcpServersStatus,
     session: sessionInfo,
     context: {
       currentTokens: contextUsage.currentTokens,
       contextLimit: contextUsage.contextLimit,
       usageRatio: contextUsage.usageRatio,
       remainingTokens: contextUsage.remainingTokens
     }
   }
```

**StatusInfo 类型定义**：

```typescript
interface StatusInfo {
  model: {
    name: string           // 模型名称
    provider: string       // 提供商
  }
  api: {
    connected: boolean     // 是否连接
    latency?: number       // 响应延迟（毫秒）
  }
  mode: 'ask' | 'plan' | 'agent'
  agentState: 'ask-before-edit' | 'edit-automatically'
  mcpServers: Record<string, McpClientStatus>
  session: {
    id: string
    name: string
    messageCount: number
  }
  context: {
    currentTokens: number  // 当前 token 使用量
    contextLimit: number   // 模型 context limit
    usageRatio: number     // 使用率（0-1）
    remainingTokens: number // 剩余可用 tokens
  }
}
```

**说明**：
- `/status` 命令显示详细的系统状态信息，供用户主动查询
- StatusBar（状态栏）显示简化的状态信息，始终可见于界面底部
- StatusBar 中 token 显示格式为 `"1.2k (1%)"` 表示当前使用量和占 context limit 的百分比
- 状态栏不显示警告信息，context 模块会在 85% 阈值时自动触发压缩

---

## 五、Data Ownership and Responsibility（数据归属与责任）

| 数据 | 创建者 | 更新者 | 说明 |
|------|--------|--------|------|
| CommandResult | commands | - | 命令执行结果，一次性创建，不更新 |
| 命令注册表 | commands | commands | 启动时注册，运行期只读 |
| 命令参数 | CLI Commands | - | 由调用层创建并传入 |
| Command.Event.Executed | commands | - | 事件数据，发布后不可修改 |

**责任边界说明**：
- commands 模块只读取其他模块的数据，不直接修改
- 状态变更（如模型切换、会话切换）由各功能模块负责
- commands 模块不缓存从其他模块获取的数据

---

## 六、错误处理策略

### 6.1 错误类型

| 错误类型 | 处理方式 |
|----------|----------|
| 命令不存在 | 返回 { success: false, error: { code: 'COMMAND_NOT_FOUND' } } |
| 参数无效 | 返回 { success: false, error: { code: 'INVALID_PARAMS' } } |
| 功能模块错误 | 包装错误信息返回 { success: false, error: { code: 'EXECUTION_ERROR' } } |

### 6.2 错误传播

- commands 模块捕获所有功能模块抛出的错误
- 将错误转换为统一的 CommandResult 格式
- 不抛出异常，始终返回 CommandResult

---

## 七、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 接口定义关注语义而非实现细节
- [x] 错误处理策略明确
