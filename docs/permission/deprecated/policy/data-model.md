# policy 模块 data-model.md

> Deprecated: 本文档描述的是已移除的 `policy` 模块，仅作为历史参考保留。
> 当前实现与后续设计请以 [docs/permission](../../) 与
> [docs/permission/refactor](../../refactor/) 为准。

本文档定义 `policy` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 Mode（工作模式）

工作模式决定了 Agent 可以使用的工具范围和交互方式。

| 模式 | 说明 | 允许的工具类别 |
|------|------|----------------|
| Ask | 回答用户问题，不涉及文件写入 | readonly |
| Plan | 帮助用户规划方案，不涉及写入 | readonly |
| Agent | 完整代理模式，可执行所有操作 | readonly, write, dangerous |

**设计说明**：
- Ask 和 Plan 模式的工具限制相同，区别在于输出形式
- 只有 Agent 模式才能执行写入操作

### 1.2 AgentState（Agent 状态）

当处于 Agent 模式时，内部状态决定写入操作的处理方式。

| 状态 | 说明 | 写入操作处理 |
|------|------|--------------|
| ask-before-edit | 编辑前询问 | 需要用户确认（ASK） |
| edit-automatically | 自动编辑 | 自动执行（ALLOW），危险操作仍需确认 |

**状态转换**：
- 默认状态：ask-before-edit
- 切换方式：快捷键（Shift+M）或 Permission 响应（"don't ask again"）
- 切换模式时：自动重置为 ask-before-edit

### 1.3 ToolCategory（工具类别）

工具类别由 Tool 模块声明，Policy 基于类别做决策。

| 类别 | 说明 | 示例工具 |
|------|------|----------|
| readonly | 只读操作，不修改任何内容 | read, glob, grep, web_search |
| write | 写入操作，会修改文件或状态 | edit, write, delete |
| dangerous | 危险操作，可能有不可逆影响 | bash, external_command |

**设计说明**：
- 类别由 Tool 模块声明，Policy 可通过覆盖规则调整
- dangerous 类别在任何状态下都需要确认

### 1.4 CriticalOperation（关键操作）

关键操作是指即使在 edit-automatically 模式下仍需要 HITL 确认的操作。

| 关键操作 | 说明 | 识别方式 |
|----------|------|----------|
| git push/force | 推送代码到远程仓库 | bash 命令以 `git push` 或 `git push -f` 开头 |
| git reset --hard | 硬重置代码 | bash 命令包含 `git reset --hard` |
| rm -rf | 递归强制删除 | bash 命令包含 `rm -rf` 或 `rm -r -f` |
| shell 模块操作 | 使用 shell 基础设施 | 工具类型为 shell |
| external_directory | 访问项目外目录 | 路径不在项目根目录下 |

**设计原则**：
- 关键操作的定义在 Agent 配置的 `permission.critical` 中声明
- 关键操作的检查在 bash 工具内部进行
- Policy 提供 `isCritical(operation)` 方法供工具查询
- 关键操作始终返回 ASK 决策，无论当前 AgentState 如何

**与 dangerous 类别的区别**：
- `dangerous` 是工具级别的类别，由工具声明
- `critical` 是操作级别的标记，基于具体参数判断
- 例如：bash 工具是 dangerous 类别，但 `git status` 不是关键操作，而 `git push` 是

### 1.5 PolicyDecision（策略决策）

Policy 对工具调用的决策结果。

| 决策 | 说明 | 后续处理 |
|------|------|----------|
| ALLOW | 允许执行 | ToolScheduler 直接执行工具 |
| DENY | 拒绝执行 | ToolScheduler 返回警告，Agent 告知用户 |
| ASK | 需要确认 | ToolScheduler 调用 Permission.ask() |

---

## 二、Data Types（数据类型）

### 2.1 枚举类型

```typescript
// 工作模式
type Mode = 'ask' | 'plan' | 'agent'

// Agent 状态
type AgentState = 'ask-before-edit' | 'edit-automatically'

// 工具类别
type ToolCategory = 'readonly' | 'write' | 'dangerous'

// 策略决策
type PolicyDecision = 'allow' | 'deny' | 'ask'
```

### 2.2 状态类型

```typescript
// Policy 完整状态
interface PolicyState {
  mode: Mode
  agentState: AgentState
}
```

### 2.3 事件类型

```typescript
// 模式变化事件数据
interface ModeChangedEvent {
  previousMode: Mode
  currentMode: Mode
}

// Agent 状态变化事件数据
interface AgentStateChangedEvent {
  previousState: AgentState
  currentState: AgentState
}
```

### 2.4 覆盖规则类型

```typescript
// 工具类别覆盖规则
interface CategoryOverrideRule {
  toolName: string
  category: ToolCategory
}
```

---

## 三、Decision Matrix（决策矩阵）

决策矩阵是 Policy 模块的核心数据结构，定义了不同条件下的决策结果。

### 3.1 矩阵定义

```typescript
type DecisionMatrix = {
  [mode in Mode]: mode extends 'agent'
    ? { [state in AgentState]: { [category in ToolCategory]: PolicyDecision } }
    : { [category in ToolCategory]: PolicyDecision }
}
```

### 3.2 矩阵值

| 模式 | Agent 状态 | readonly | write | dangerous |
|------|------------|----------|-------|-----------|
| ask | - | allow | deny | deny |
| plan | - | allow | deny | deny |
| agent | ask-before-edit | allow | ask | ask |
| agent | edit-automatically | allow | allow | ask |

### 3.3 设计原则

- **保守原则**：当出现未知类别时，默认返回 DENY
- **危险优先**：dangerous 类别在任何状态下都需要确认
- **简单确定**：相同输入必定产生相同输出

---

## 四、Constants（常量定义）

### 4.1 默认值

```typescript
const DEFAULT_MODE: Mode = 'agent'
const DEFAULT_AGENT_STATE: AgentState = 'ask-before-edit'
```

### 4.2 模式切换顺序

```typescript
const MODE_CYCLE: Mode[] = ['agent', 'ask', 'plan']
// Agent -> Ask -> Plan -> Agent
```

---

## 五、Validation Rules（验证规则）

### 5.1 模式验证

- Mode 必须是 'ask' | 'plan' | 'agent' 之一
- 无效值应被忽略，保持当前模式不变

### 5.2 状态验证

- AgentState 必须是 'ask-before-edit' | 'edit-automatically' 之一
- 无效值应被忽略，保持当前状态不变

### 5.3 类别验证

- ToolCategory 必须是 'readonly' | 'write' | 'dangerous' 之一
- 未知类别返回 DENY 决策

---

## 六、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 决策矩阵逻辑正确
- [x] 验证规则明确
- [x] 类型定义符合 TypeScript 规范
