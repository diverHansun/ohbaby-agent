# commands 模块 goals-duty.md

本文档定义 `commands` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/commands/`
- 文档：`docs/commands/`

---

## 一、模块定位

**一句话说明**：commands 模块负责命令发现、管理和执行，通过 CommandService + Loader 模式组织命令，是各功能模块的协调者和统一入口。

**如果没有这个模块**：
- CLI 层需要直接调用多个功能模块，耦合严重
- 命令逻辑散落在各处，难以复用
- 未来 UI 层（Web/Extension）无法复用命令逻辑
- 命令执行结果缺乏统一的事件通知机制
- 无法统一管理内置命令和扩展命令

---

## 二、Design Goals（设计目标）

### G1: 业务聚合

作为各功能模块的协调者，聚合调用并编排业务流程。每个命令的实现应聚焦于"协调哪些模块、按什么顺序"，而非"如何实现具体功能"。

### G2: 接口无关

不依赖 CLI/UI 的具体实现，可被 CLI、Web、VS Code Extension 等多端复用。命令逻辑不应包含任何终端输出、颜色渲染或交互式 UI 代码。

### G3: 事件驱动

命令执行完成后通过 Bus 发布事件，支持 UI 层和其他模块响应命令执行结果。遵循现有 Bus 模块的设计模式（见 `docs/bus`）。

### G4: 结构化返回

返回结构化的命令执行结果，由调用层（CLI/UI）决定如何渲染。不直接输出字符串，而是返回可被解析的数据对象。

### G5: 简单直接

每个命令实现简单直接，遵循 KISS 原则。避免过度抽象，不引入不必要的中间层或设计模式。

---

## 三、Duties（职责）

### D1: Model 命令

提供模型相关操作：
- 获取当前模型信息
- 列出所有可用模型
- 切换当前使用的模型

调用模块：`Provider` (config)

### D2: Init 命令

生成项目初始化的 Prompt 模板，用于创建 OHBABY.md 文件。模板存放于 `src/commands/template/` 目录。

调用模块：`Template`（内部子模块）

### D3: MCP 命令

提供 MCP 服务器管理操作：
- 列出已配置的 MCP 服务器及状态
- 执行 OAuth 认证流程
- 刷新（重启）所有 MCP 服务器

调用模块：`MCP`

### D4: Agents 命令

提供代理和策略管理操作：
- 列出所有主代理和子代理
- 切换 Policy 模式（Ask/Plan/Agent）

调用模块：`Agent`、`Policy`

### D5: Session 命令

提供会话管理操作：
- 列出当前项目的会话列表
- 选择并切换到指定会话
- 创建新会话（清除当前上下文）

调用模块：`Session`、`Message`

### D6: Status 命令

聚合系统状态信息，供用户主动查询详细状态：
- 当前模型名称和提供商
- API 连通性状态（包含延迟）
- 当前模式和 Agent 状态
- MCP 服务器状态
- 会话信息（名称、消息数）
- Context 使用情况（当前 tokens / context limit，百分比，剩余可用）

调用模块：`Provider`、`MCP`、`Policy`、`Session`、`Context`

**说明**：
- `/status` 命令返回详细的结构化数据，由 CLI 层渲染输出
- 与 StatusBar（状态栏）不同，StatusBar 始终显示简化信息于界面底部
- Context 显示格式：`"12.5k / 128k (10%)"` 表示当前用量、限制和使用百分比

### D7: Help 命令

获取所有可用命令的帮助信息：
- 命令名称
- 命令描述
- 子命令列表
- 按 category 分组展示

调用模块：CommandService（命令注册表）

### D8: Tools 命令

列出所有可用工具：
- 内置工具（定义于 `tools` 模块）
- MCP 工具（来自 MCP 服务器）

调用模块：`Tools`、`MCP`

### D9: Approval-Mode 命令

查看和设置审批模式：
- 获取当前审批模式
- 切换审批模式

调用模块：`Permission`、`Policy`

### D10: Memory 命令

管理 OHBABY.md 记忆文件：
- `add`: 手动添加新记忆（支持项目级/全局级）
- `refresh`: 强制重新加载记忆文件（在手动编辑文件后使用）

注意：Memory 模块不提供 remove/update 的 CLI 命令，鼓励用户直接编辑 OHBABY.md 文件或通过 AI 完成这些操作。

调用模块：`Memory`（代码: `src/core/memory/`）

### D11: Stats 命令

聚合 Token 使用和会话统计：
- 会话数量
- 消息数量
- Token 使用量（input/output/cache）
- 工具使用统计

调用模块：`Session`、`Message`

### D12: Exit 命令

执行清理并退出：
- 通知相关模块进行清理
- 返回退出信号

调用模块：无特定模块

### D13: 事件发布

命令执行完成后，通过 Bus 发布 `Command.Event.Executed` 事件，包含：
- 命令名称
- 执行参数
- 执行结果
- 会话 ID

调用模块：`Bus`

### D14: Abort 命令

中断当前正在执行的循环：
- 检查指定 sessionId 是否正在执行
- 调用 `Lifecycle.cancel(sessionId)` 触发中断
- 返回中断结果（成功/无循环在运行）

调用模块：`Lifecycle`

**注意**：这是一个"命令"而非"快捷键"。CLI 层在检测到双击 Ctrl+C 后调用此命令。

### D15: CommandService 管理

提供命令发现、注册和执行的核心服务：

**命令发现**：
- 通过 ICommandLoader 接口加载命令
- V1 只实现 BuiltinLoader（内置命令）
- 架构预留 FileLoader、McpPromptLoader 扩展点（V2）

**命令执行**：
- 解析子命令路径（如 "model switch" → 在 model 下找 switch）
- 执行叶子命令的 action 函数
- 无参数且有子命令时，返回子命令帮助信息

**命令建议**：
- 使用 Levenshtein 距离匹配相似命令
- 未知命令时提供建议（如 "mdoel" → 建议 "/model"）

调用模块：`loaders/*`（内部子模块）

### D16: 延后实现的功能（V2）

以下功能在 V1 版本中不实现，但架构已预留扩展点：
- FileLoader：用户自定义命令（TOML 格式）
- McpPromptLoader：MCP Prompt 命令
- Tab 补全：子命令树结构支持，UI 层实现

### D17: Compact 命令

压缩当前会话上下文：
- 调用 `Context.compress(sessionId, true)` 执行压缩
- 返回压缩结果（成功/跳过/失败）
- 显示压缩前后的 token 统计（压缩了多少、节省了多少）

调用模块：`Context`

---

## 四、Non-Duties（非职责）

### N1: 不负责参数解析

命令行参数的解析由 CLI Commands 模块负责。commands 模块接收已解析的结构化参数对象。

### N2: 不负责输出渲染

终端输出的格式化、颜色、表格渲染由 CLI Commands 模块负责。commands 模块只返回结构化数据。

### N3: 不负责交互式 UI

确认框、选择列表、进度条等交互式 UI 由 CLI Commands 模块或 Permission 模块负责。

### N4: 不负责具体功能实现

具体的功能实现由各功能模块负责。commands 模块只做协调调用，不实现业务细节。

### N5: 不维护命令历史

用户的命令输入历史由调用层（CLI/UI）维护，commands 模块不持有状态。

### N6: 不负责持久化

命令执行过程中的数据持久化由各功能模块负责（如 Session、Message）。

---

## 五、设计约束与假设

### 约束

1. **依赖 Bus 模块**：事件发布通过 Bus 模块实现
2. **无状态设计**：commands 模块不持有任何状态，每次调用独立执行
3. **同步返回**：命令执行完成后同步返回结果，不使用回调或事件返回结果

### 假设

1. 各功能模块已正确实现并可被调用
2. Bus 模块已正确实现事件发布订阅机制
3. 调用方（CLI/UI）会正确处理返回的结果对象

---

## 六、与其他模块的关系

| 模块 | 代码位置 | 关系 | 调用接口 | 用途 |
|------|----------|------|----------|------|
| CLI Commands | `src/cli/commands/` | 被依赖 | `CommandService.execute()` | 调用命令执行 |
| CLI Commands | `src/cli/commands/` | 被依赖 | `CommandService.getCommands()` | 获取命令列表 |
| CLI Commands | `src/cli/commands/` | 被依赖 | `CommandService.findCommand()` | 查找命令（含建议） |
| Bus | `src/bus/` | 依赖 | `Bus.publish()` | 发布 `Commands.Event.Executed` |
| Session | `src/services/session/` | 依赖 | `SessionManager.get/create/getByProject` | Session 命令 |
| Message | `src/services/message/` | 依赖 | `MessageManager.getMessages` | session.choose |
| Context | `src/core/context/` | 依赖 | `Context.compress()` | Compact 命令 |
| MCP | `src/mcp/` | 依赖 | `McpManager.getStatus/getAllTools` | MCP/Tools 命令 |
| Policy | `src/policy/` | 依赖 | `Policy.getMode/setMode` | agents.mode |
| Agent | `src/agents/` | 依赖 | `AgentManager.list/get` | agents.list |
| Provider | `src/config/` | 依赖 | `Provider.listModels/switchModel` | Model 命令 |
| Permission | `src/permission/` | 依赖 | `Permission.getApprovalMode` | approval-mode |
| Tools | `src/tools/` | 依赖 | `ToolRegistry.getAll` | tools |
| Memory | `src/core/memory/` | 依赖 | `Memory.add/refresh` | Memory 命令 |
| Lifecycle | `src/core/lifecycle/` | 依赖 | `Lifecycle.cancel/isRunning` | Abort 命令 |

**详细接口定义见** `docs/commands/dfd-interface.md`

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] 延后实现的功能已明确标注
