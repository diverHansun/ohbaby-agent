# policy 模块 dfd-interface.md

本文档描述 `policy` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

Policy 模块位于 Commands/ToolScheduler 与 Permission 之间，是工具执行决策的核心。

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| **ToolScheduler** | 输入 | 查询工具执行决策 |
| **Commands** | 输入 | 模式切换、状态切换请求 |
| **Permission** | 输入 | Agent 状态切换请求（通过 Bus） |
| **AgentManager** | 双向 | 模式切换时触发 Agent 切换；订阅 Agent 变化读取 permission |
| **Bus** | 输出 | 状态变化事件发布 |
| **UI** | 输出（间接） | 通过 Bus 事件通知状态变化 |

### 本文档范围

- 描述数据如何进入 Policy 模块
- 描述数据如何从 Policy 模块输出
- 定义模块的对外接口
- 说明与 Commands、UI 的协作关系

---

## 二、Data Flow Description（数据流描述）

### 2.1 主流程：工具决策查询

```
ToolScheduler                   Policy 模块
     │                              │
     │  1. check(toolCategory)      │
     │----------------------------->│
     │                              │
     │              2. 查询当前模式和状态
     │              3. 查找决策矩阵
     │              4. 返回决策结果
     │                              │
     │  5. PolicyDecision           │
     │<-----------------------------|
     │                              │
     │  [ALLOW] 直接执行工具        │
     │  [DENY]  返回警告            │
     │  [ASK]   调用 Permission     │
```

### 2.2 模式切换流程（快捷键触发）

```
用户                UI 层              Commands            Policy 模块           Bus
 │                   │                    │                    │                  │
 │  1. Shift+Tab     │                    │                    │                  │
 │------------------>│                    │                    │                  │
 │                   │                    │                    │                  │
 │                   │ 2. 触发命令        │                    │                  │
 │                   │------------------->│                    │                  │
 │                   │                    │                    │                  │
 │                   │                    │ 3. cycleMode()     │                  │
 │                   │                    │------------------->│                  │
 │                   │                    │                    │                  │
 │                   │                    │        4. 计算下一个模式              │
 │                   │                    │        5. 更新内部状态                │
 │                   │                    │        6. 发布 ModeChanged            │
 │                   │                    │                    │----------------->│
 │                   │                    │                    │                  │
 │                   │                    │ 7. 返回新模式      │                  │
 │                   │                    │<-------------------|                  │
 │                   │                    │                    │                  │
 │                   │ 8. 订阅事件更新 UI │                    │                  │
 │                   │<-------------------------------------------------------|
 │  9. 显示新模式    │                    │                    │                  │
 │<------------------|                    │                    │                  │
```

### 2.3 Agent 状态切换流程（快捷键触发）

```
用户                UI 层              Commands            Policy 模块           Bus
 │                   │                    │                    │                  │
 │  1. Shift+M       │                    │                    │                  │
 │------------------>│                    │                    │                  │
 │                   │                    │                    │                  │
 │                   │ 2. 触发命令        │                    │                  │
 │                   │------------------->│                    │                  │
 │                   │                    │                    │                  │
 │                   │                    │ 3. toggleAgentState()                 │
 │                   │                    │------------------->│                  │
 │                   │                    │                    │                  │
 │                   │                    │        4. 切换状态                    │
 │                   │                    │        5. 发布 AgentStateChanged      │
 │                   │                    │                    │----------------->│
 │                   │                    │                    │                  │
 │                   │ 6. 订阅事件更新 UI │                    │                  │
 │                   │<-------------------------------------------------------|
 │  7. 显示新状态    │                    │                    │                  │
 │     (颜色变化)    │                    │                    │                  │
 │<------------------|                    │                    │                  │
```

### 2.4 Permission always 授权流程

```
Permission 模块                   Bus                  Audit/UI/Runtime
     │                             │                          │
     │  1. 用户选择 "don't ask again"                         │
     │                             │                          │
     │  2. 记录 session+pattern 批准                          │
     │                             │                          │
     │  3. 发布 SwitchModeRequested（审计/协调）               │
     │---------------------------->│                          │
     │                             │                          │
     │                             │  4. 事件分发              │
     │                             │------------------------->│
     │                             │                          │
     │                             │         5. 记录审计或更新 UI
     │                             │                          │
     │                             │  6. 通知 UI 更新         │
```

### 2.5 模式切换触发 Agent 切换流程

```
Commands            Policy 模块            AgentManager           Bus
   │                     │                      │                  │
   │  1. setMode('plan') │                      │                  │
   │-------------------->│                      │                  │
   │                     │                      │                  │
   │         2. 更新内部模式状态                 │                  │
   │                     │                      │                  │
   │                     │ 3. switchTo('plan')  │                  │
   │                     │--------------------->│                  │
   │                     │                      │                  │
   │                     │                      │ 4. 切换到 plan Agent
   │                     │                      │ 5. 发布 agent.changed
   │                     │                      │----------------->│
   │                     │                      │                  │
   │                     │ 6. 发布 ModeChanged  │                  │
   │                     │------------------------------------>│
   │                     │                      │                  │
```

### 2.6 Agent 变化时读取权限配置

```
AgentManager                    Bus                    Policy 模块
     │                           │                          │
     │  1. Agent 切换完成        │                          │
     │                           │                          │
     │  2. 发布 agent.changed    │                          │
     │-------------------------->│                          │
     │                           │                          │
     │                           │  3. 事件分发              │
     │                           │------------------------->│
     │                           │                          │
     │                           │    4. 读取 Agent.permission
     │                           │    5. 更新权限决策缓存
     │                           │                          │
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### Policy.getMode()

**语义**：获取当前工作模式

**输入**：无

**输出**：Mode（'ask' | 'plan' | 'agent'）

**异步特性**：同步

---

#### Policy.setMode()

**语义**：设置工作模式

**输入**：
- mode: Mode - 目标模式

**输出**：无

**副作用**：
- 更新内部模式状态
- 如果模式发生变化，发布 ModeChanged 事件
- 重置 Agent 状态为 ask-before-edit

**异步特性**：同步

---

#### Policy.cycleMode()

**语义**：按顺序切换到下一个模式

**切换顺序**：Agent -> Ask -> Plan -> Agent

**输入**：无

**输出**：Mode - 切换后的模式

**副作用**：
- 更新内部模式状态
- 发布 ModeChanged 事件
- 重置 Agent 状态为 ask-before-edit

**异步特性**：同步

---

#### Policy.getAgentState()

**语义**：获取当前 Agent 状态

**输入**：无

**输出**：AgentState（'ask-before-edit' | 'edit-automatically'）

**异步特性**：同步

---

#### Policy.setAgentState()

**语义**：设置 Agent 状态

**输入**：
- state: AgentState - 目标状态

**输出**：无

**副作用**：
- 更新内部 Agent 状态
- 如果状态发生变化，发布 AgentStateChanged 事件

**异步特性**：同步

---

#### Policy.toggleAgentState()

**语义**：切换 Agent 状态

**输入**：无

**输出**：AgentState - 切换后的状态

**副作用**：
- 在 ask-before-edit 和 edit-automatically 之间切换
- 发布 AgentStateChanged 事件

**异步特性**：同步

---

#### Policy.check()

**语义**：查询工具执行决策

**输入**：
- toolCategory: ToolCategory - 工具类别

**输出**：PolicyDecision（'allow' | 'deny' | 'ask'）

**异步特性**：同步

**决策逻辑**：基于当前模式、Agent 状态和工具类别，查询决策矩阵返回结果

---

#### Policy.getState()

**语义**：获取完整的 Policy 状态

**输入**：无

**输出**：PolicyState（{ mode, agentState }）

**异步特性**：同步

**用途**：供 UI 层获取完整状态用于显示

---

### 3.2 发布的事件（通过 Bus）

#### Policy.Event.ModeChanged

**语义**：通知工作模式已变化

**携带数据**：
```typescript
{
  previousMode: Mode
  currentMode: Mode
}
```

**订阅者**：UI 层

**触发时机**：setMode() 或 cycleMode() 导致模式变化时

---

#### Policy.Event.AgentStateChanged

**语义**：通知 Agent 状态已变化

**携带数据**：
```typescript
{
  previousState: AgentState
  currentState: AgentState
}
```

**订阅者**：UI 层

**触发时机**：setAgentState() 或 toggleAgentState() 导致状态变化时

---

### 3.3 订阅的事件

#### Permission.Event.SwitchModeRequested

**语义**：permission 通知一次 always 授权已产生

**来源**：Permission 模块

**触发场景**：用户在确认框中选择 "don't ask again"

**处理逻辑**：Policy 不直接订阅或处理该事件；后续匹配请求由 Permission 按 Pattern 自动批准。若产品需要全局/会话级自动编辑模式，应由 Commands 或 runtime composition 显式调用 Policy.setAgentState()。

---

#### Agent.Event.Changed

**语义**：Agent 已切换

**来源**：AgentManager 模块

**触发场景**：Agent 切换完成时

**处理逻辑**：读取新 Agent 的 permission 配置，更新权限决策缓存

---

### 3.4 依赖的外部接口

#### Bus.publish()

**语义**：发布事件

**使用场景**：发布 ModeChanged 和 AgentStateChanged 事件

---

#### Bus.subscribe()

**语义**：订阅事件

**使用场景**：
- 订阅 Agent.Event.Changed

---

#### AgentManager.switchTo()

**语义**：切换当前代理

**输入**：agentName: string

**使用场景**：模式切换时触发对应的 Agent 切换
- Plan 模式 -> switchTo('plan')
- Agent 模式 -> switchTo('build')

---

#### AgentManager.get()

**语义**：获取代理配置

**输入**：agentName: string

**输出**：Promise<AgentConfig>

**使用场景**：读取 Agent 的 permission 配置用于决策计算

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| Mode | Policy | 内部状态，由 Policy 管理 |
| AgentState | Policy | 内部状态，由 Policy 管理 |
| PolicyDecision | Policy | check() 的返回值，由 Policy 计算 |
| ToolCategory | Tool 模块 | 工具自身声明的类别 |

### 4.2 数据更新责任

| 数据 | 更新者 | 更新时机 |
|------|--------|----------|
| Mode | Policy | 响应 Commands 的切换请求 |
| AgentState | Policy | 响应 Commands 或 runtime composition 的显式切换请求 |

### 4.3 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 模式状态管理 | Policy | Commands, UI |
| 决策计算 | Policy | ToolScheduler |
| 快捷键监听 | UI -> Commands | Policy |
| 状态显示 | UI | Policy |
| 确认流程执行 | Permission | Policy |
| 工具类别声明 | Tool | Policy |

---

## 五、接口使用示例

### 5.1 ToolScheduler 查询决策

```typescript
// ToolScheduler 中
async function executeTool(tool: Tool) {
  const decision = Policy.check(tool.category)

  switch (decision) {
    case 'allow':
      return await tool.execute()

    case 'deny':
      return { warning: `Tool ${tool.name} is not allowed in current mode` }

    case 'ask':
      await Permission.ask({
        sessionId,
        messageId,
        type: 'tool',
        name: tool.name,
        title: `Execute ${tool.name}`,
        metadata: tool.getMetadata()
      })
      return await tool.execute()
  }
}
```

### 5.2 Commands 处理模式切换

```typescript
// Commands 模块中
const commands = [
  {
    name: 'switchMode',
    keybind: 'shift+tab',
    execute: () => {
      const newMode = Policy.cycleMode()
      // 事件已由 Policy 发布，UI 会自动更新
    }
  },
  {
    name: 'toggleAgentState',
    keybind: 'shift+m',
    execute: () => {
      const newState = Policy.toggleAgentState()
      // 事件已由 Policy 发布，UI 会自动更新
    }
  }
]
```

### 5.3 UI 层订阅状态变化

```typescript
// UI 层中
Bus.subscribe(Policy.Event.ModeChanged, (event) => {
  updateModeIndicator(event.currentMode)
})

Bus.subscribe(Policy.Event.AgentStateChanged, (event) => {
  const color = event.currentState === 'ask-before-edit' ? 'orange' : 'blue'
  updateInputBoxColor(color)
})
```

---

## 六、与 Commands 和 UI 的协作说明

### 6.1 职责分工

```
┌─────────────────────────────────────────────────────────────────┐
│                          用户交互层                              │
├─────────────────────────────────────────────────────────────────┤
│  UI 层                                                          │
│  - 监听键盘事件                                                  │
│  - 渲染模式指示器                                                │
│  - 根据 Agent 状态设置输入框颜色                                 │
│  - 订阅 Policy 事件更新显示                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 触发命令
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Commands 模块                             │
├─────────────────────────────────────────────────────────────────┤
│  - 定义快捷键与命令的映射                                        │
│  - 执行命令逻辑                                                  │
│  - 调用 Policy 接口                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 调用接口
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Policy 模块                              │
├─────────────────────────────────────────────────────────────────┤
│  - 管理模式和状态                                                │
│  - 提供决策查询                                                  │
│  - 发布状态变化事件                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 UI 显示规则

| 元素 | 显示内容 | 数据来源 |
|------|----------|----------|
| 模式指示器 | Ask / Plan / Agent | Policy.getMode() 或 ModeChanged 事件 |
| 输入框颜色 | 橙色（ask-before-edit）/ 蓝色（edit-automatically） | AgentStateChanged 事件 |

---

## 七、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义与 data-model.md 中的类型一致
- [x] 事件定义与 architecture.md 中的设计一致
- [x] 与 Commands、UI 的协作关系清晰
