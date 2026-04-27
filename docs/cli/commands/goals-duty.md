# cli/commands 模块 goals-duty.md

本文档定义 `cli/commands` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`src/cli/commands/`
- 文档：`docs/cli/commands/`

---

## 一、模块定位

**一句话说明**：cli/commands 模块负责 Slash Command 的解析和输出渲染，是 commands 模块在终端环境下的薄封装层。

**如果没有这个模块**：
- commands 模块需要关心终端输出格式，破坏接口无关性
- 参数解析逻辑与业务逻辑混杂，难以测试
- 无法统一处理终端交互（如 spinner、表格、颜色）
- 不同命令的输出格式不一致

---

## 二、Design Goals（设计目标）

### G1: 薄封装

只做参数解析和输出渲染，不包含业务逻辑。所有业务逻辑委托给 commands 模块处理。代码量应保持最小。

### G2: 用户体验

提供友好的终端交互体验：
- 表格化输出
- 颜色高亮
- Spinner 进度提示
- 错误信息格式化

### G3: 参数验证

在调用 commands 模块前验证参数合法性，提供清晰的参数错误提示。

### G4: 输出一致性

统一各命令的输出格式，保持视觉一致性。成功/失败/数据展示有统一的样式规范。

### G5: 交互式支持

支持交互式场景（如模型选择列表），在需要时提供用户选择界面。

---

## 三、Duties（职责）

### D1: Slash Command 解析

解析用户输入的 Slash Command：
- 识别命令名称（如 `/model`、`/session`）
- 解析子命令（如 `switch`、`list`）
- 解析命令参数和选项

示例：`/model switch gemini-pro` -> `{ command: "model.switch", params: { name: "gemini-pro" } }`

### D2: 参数验证

在调用 commands 模块前验证参数：
- 必填参数检查
- 参数类型验证
- 参数取值范围验证

### D3: 调用 CommandService

将命令路径和参数传递给 CommandService 执行：
```typescript
const result = await CommandService.execute(commandPath, args, context)
```

**注意**：cli/commands 不直接调用各功能模块，所有业务逻辑由 commands 模块的 CommandService 处理。

### D4: 结果渲染

将 CommandResult 渲染为终端输出：
- `data` 类型：根据数据结构渲染表格或列表
- `message` 类型：输出格式化消息
- `prompt` 类型：提交给 LLM 处理
- `action` 类型：执行相应动作（如退出、切换会话）

### D5: 错误展示

将 CommandResult 中的错误信息格式化输出：
- 使用红色高亮错误
- 提供可能的解决建议
- 显示帮助信息链接

### D6: 交互式 UI

在需要时提供交互式选择界面：
- 模型选择列表（`/model switch` 无参数时）
- 会话选择列表（`/session choose` 无参数时）
- 确认提示（`/clear`）

### D7: Help 渲染

格式化输出命令帮助信息：
- 命令列表表格
- 单个命令详细帮助
- 命令用法示例

### D8: 处理键盘快捷键

处理特殊键盘快捷键：

| 快捷键 | 行为 | 说明 |
|--------|------|------|
| **双击 Ctrl+C** | 中断执行 | 500ms 内双击触发，调用 `Commands.abort()` |
| **Shift+Tab** | 切换模式 | 循环切换 Agent → Ask → Plan → Agent，调用 `Commands.agentsModeSwitch()` |

**双击 Ctrl+C 中断机制**：
- 记录上一次 SIGINT 信号时间
- 如果两次间隔小于 500ms，触发中断
- 单击 Ctrl+C 不触发中断（给用户一个"取消正在输入"的选项）
- **Permission UI 显示时**：Ctrl+C 不触发中断，用户应使用 UI 中的 Reject 按钮

**实现示例**：
```typescript
let lastSigintTime = 0

process.on('SIGINT', async () => {
  const now = Date.now()
  if (now - lastSigintTime < 500) {
    // 双击，调用 commands 模块执行中断
    const result = await Commands.abort({ sessionId: currentSessionId })
    if (result.type === 'message') {
      console.log('\n' + result.data.text)
    }
  }
  lastSigintTime = now
})
```

**注意**：符合模块分工原则，cli/commands 只负责键盘事件检测和结果渲染，业务逻辑（调用 Lifecycle.cancel）由 commands 模块的 Abort 命令处理。

---

## 四、Non-Duties（非职责）

### N1: 不负责业务逻辑

所有业务逻辑由 commands 模块负责。cli/commands 只做参数传递和结果渲染。

### N2: 不直接调用功能模块

不直接调用 Session、MCP、Provider 等功能模块，统一通过 commands 模块访问。

### N3: 不负责事件发布

命令执行事件由 commands 模块发布，cli/commands 不与 Bus 直接交互。

### N4: 不负责权限确认

权限确认 UI 由 Permission 模块协调，cli/commands 不处理。

### N5: 不维护状态

命令执行状态由调用层（UI/REPL）维护，cli/commands 不持有状态。

---

## 五、设计约束与假设

### 约束

1. **依赖 commands 模块**：所有业务逻辑通过 commands 模块执行
2. **终端环境**：假设运行在支持 ANSI 颜色的终端环境
3. **同步渲染**：收到 CommandResult 后同步完成渲染

### 假设

1. commands 模块已正确实现所有命令
2. 调用方（UI/REPL）会正确处理渲染结果
3. 终端支持基本的 ANSI 转义序列

---

## 六、支持的命令列表

### 模型相关

| 命令 | 说明 | 参数 |
|------|------|------|
| `/model list` | 列出可用模型 | 无 |
| `/model switch [name]` | 切换模型 | name: 模型名称（可选，无参数时交互选择） |

**注意**：输入 `/model` 无子命令时，显示子命令帮助信息。

### 会话相关

| 命令 | 说明 | 参数 |
|------|------|------|
| `/session list` | 列出项目会话 | 无 |
| `/session choose [id]` | 切换会话 | id: 会话 ID（可选） |
| `/clear` | 清除上下文（创建新会话） | 无 |

### MCP 相关

| 命令 | 说明 | 参数 |
|------|------|------|
| `/mcp list` | 列出 MCP 服务器 | 无 |
| `/mcp auth [name]` | 认证 MCP 服务器 | name: 服务器名称 |
| `/mcp refresh` | 刷新 MCP 服务器 | 无 |

**注意**：输入 `/mcp` 无子命令时，显示子命令帮助信息。

### 代理相关

| 命令 | 说明 | 参数 |
|------|------|------|
| `/agents list` | 列出代理 | 无 |
| `/agents mode [mode]` | 切换策略模式 | mode: Ask/Plan/Agent |

**注意**：输入 `/agents` 无子命令时，显示子命令帮助信息。

### 记忆相关

| 命令 | 说明 | 参数 |
|------|------|------|
| `/memory add` | 添加记忆 | --project/--global |
| `/memory refresh` | 刷新记忆 | 无 |

**注意**：输入 `/memory` 无子命令时，显示子命令帮助信息。

### 系统相关

| 命令 | 说明 | 参数 |
|------|------|------|
| `/init` | 生成 OHBABY.md | 无 |
| `/status` | 系统状态（模型、API、模式、MCP、会话、Context 使用率） | 无 |
| `/compact` | 压缩会话上下文 | 无 |
| `/help [command]` | 帮助信息（按 category 分组） | command: 命令名（可选） |
| `/tools` | 列出工具 | 无 |
| `/approval-mode [mode]` | 审批模式 | mode: 模式（可选） |
| `/stats` | 统计信息 | 无 |
| `/exit` | 退出程序 | 无 |


---

## 七、与其他模块的关系

| 模块 | 代码位置 | 文档位置 | 关系 | 调用接口 |
|------|----------|----------|------|----------|
| commands | `src/commands/` | `docs/commands/` | 依赖 | `CommandService.execute()`, `CommandService.getCommands()`, `CommandService.findCommand()` |
| UI/REPL | `src/cli/ui/` | - | 被依赖 | `executeSlashCommand()` |
| lifecycle | `src/lifecycle/` | `docs/services/lifecycle/` | 间接 | 通过 action 触发会话切换 |

**详细接口定义见** `docs/cli/commands/dfd-interface.md`

---

## 八、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] 命令列表完整且与 commands 模块一致
