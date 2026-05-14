# policy 模块 goals-duty.md

本文档定义 `policy` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供清晰的工作模式管理

为用户提供三种工作模式（Ask、Plan、Agent），每种模式对应不同的工具使用范围和交互方式，使用户能够根据任务性质选择合适的工作模式。

### 2. 实现简洁的决策逻辑

基于当前模式和工具类别，提供确定性的策略决策（ALLOW / DENY / ASK），决策逻辑应当简单、可预测、易于理解。

### 3. 支持灵活的状态切换

允许用户通过快捷键或交互响应切换模式和状态，切换应即时生效，无需重启会话。

### 4. 保持模块边界清晰

Policy 只负责决策和状态管理，不负责确认流程的执行（由 Permission 负责），不负责工具的实际调度（由 ToolScheduler 负责）。

---

## 二、Duties（职责）

### 1. 管理当前工作模式

维护当前会话的工作模式状态（Ask / Plan / Agent），提供模式查询和切换接口。

### 2. 管理 Agent 模式状态

当处于 Agent 模式时，维护内部状态（ask-before-edit / edit-automatically），提供状态查询和切换接口。

### 3. 提供策略决策

根据当前模式、Agent 状态和工具类别，返回策略决策结果：
- ALLOW：允许执行
- DENY：拒绝执行
- ASK：需要用户确认

### 4. 发布状态变化事件

当模式或 Agent 状态发生变化时，通过 Bus 发布事件，通知 UI 和其他订阅者。

### 5. 响应状态切换请求

处理来自 Commands 模块的模式切换请求（快捷键触发），处理来自 Permission 模块的 Agent 状态切换请求（用户选择 "don't ask again"）。

### 6. 协同 Agent 模块切换代理

当模式切换时，触发 Agent 模块切换对应的代理：
- Agent 模式 → build Agent（默认主代理，可通过配置更改）
- Plan 模式 → plan Agent
- Ask 模式 → 当前代理不变，仅限制为只读

**快捷键 Shift+Tab**：循环切换 Agent → Ask → Plan → Agent

### 7. 读取 Agent 权限配置

订阅 Agent 变化事件，读取当前 Agent 的 permission 配置，用于决策计算。

### 8. 维护工具类别覆盖规则

支持对特定工具的类别进行覆盖配置，允许将工具从默认类别调整为其他类别（如将某个工具标记为 dangerous）。

---

## 三、Non-Duties（非职责）

### 1. 不负责确认流程执行

确认框的显示、用户响应的收集、Promise 的管理由 Permission 模块负责。Policy 只提供决策，不执行确认。

### 2. 不负责工具调度

工具的实际执行由 ToolScheduler 负责。Policy 不直接调用任何工具。

### 3. 不负责快捷键监听

快捷键的监听和解析由 UI 层或 Commands 模块负责。Policy 只提供被调用的接口。

### 4. 不负责 UI 渲染

模式指示器、颜色变化等 UI 表现由 UI 层负责。Policy 只发布状态变化事件。

### 5. 不负责跨会话持久化

模式和状态仅在会话内有效，不持久化到配置文件。每个新会话从默认状态开始。

### 6. 不负责工具类别定义

工具的默认类别（readonly / write / dangerous）由 Tool 模块自身声明。Policy 只维护覆盖规则。

### 7. 不负责批准记录管理

"don't ask again" 产生的批准记录和后续 Pattern 匹配自动批准由 Permission 模块管理。Policy 只负责显式模式/状态管理与工具决策，不直接消费 permission 的 always 授权事件。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| ToolScheduler | 被依赖 | ToolScheduler 查询决策和模式 |
| AgentManager | 双向 | 模式切换时触发 Agent 切换；订阅 Agent 变化读取 permission |
| Permission | 上游协作 | ToolScheduler 在 Policy 返回 ask 后调用 Permission；Policy 不直接订阅 Permission 事件 |
| Commands | 被依赖 | Commands 调用模式切换接口 |
| Bus | 依赖 | 发布状态变化事件，订阅 Agent 变化事件 |
| UI | 被依赖（间接） | 通过 Bus 事件通知状态变化 |

---

## 五、文档自检

- [x] 可以用一句话说明该模块的存在意义：Policy 模块负责工作模式管理和工具使用策略决策
- [x] 能清楚回答"这个模块不该做什么"：不执行确认流程、不调度工具、不监听快捷键、不渲染 UI、不持久化状态
- [x] 职责与其他模块无明显重叠：与 Permission（确认执行）、ToolScheduler（工具调度）、Commands（快捷键处理）、Agent（代理配置）边界清晰
