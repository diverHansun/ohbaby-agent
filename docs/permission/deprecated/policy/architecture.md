# policy 模块 architecture.md

> Deprecated: 本文档描述的是已移除的 `policy` 模块，仅作为历史参考保留。
> 当前实现与后续设计请以 [docs/permission](../../) 与
> [docs/permission/refactor](../../refactor/) 为准。

本文档描述 `policy` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

Policy 模块是 ohbaby-agent 的策略决策中心，位于 Commands/ToolScheduler 与 Permission 之间，负责根据当前工作模式判断工具调用是否需要用户确认。

### 核心架构

```
┌─────────────────────────────────────────────────────────┐
│                     PolicyManager                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────┐      ┌─────────────────┐           │
│  │   ModeManager   │      │  DecisionEngine │           │
│  │                 │      │                 │           │
│  │  - currentMode  │      │  - check()      │           │
│  │  - agentState   │      │  - matrix       │           │
│  │  - cycleMode()  │      │                 │           │
│  │  - setState()   │      │                 │           │
│  └─────────────────┘      └─────────────────┘           │
│            │                       │                     │
│            └───────────┬───────────┘                     │
│                        │                                 │
│              ┌─────────────────┐                         │
│              │ CategoryOverride│                         │
│              │                 │                         │
│              │  - overrides    │                         │
│              │  - getCategory()│                         │
│              └─────────────────┘                         │
│                                                          │
└─────────────────────────────────────────────────────────┘
                          │
                          │ 发布事件
                          ▼
                    ┌───────────┐
                    │    Bus    │
                    └───────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 PolicyManager

**职责**：对外统一接口，协调内部组件

**设计原则**：
- 单一职责：只做协调，不包含业务逻辑
- 依赖倒置：依赖 Bus 抽象而非具体实现

**主要方法**：
- `getMode()`: 获取当前工作模式
- `setMode(mode)`: 设置工作模式
- `cycleMode()`: 循环切换模式（Agent -> Ask -> Plan -> Agent）
- `getAgentState()`: 获取 Agent 模式状态
- `setAgentState(state)`: 设置 Agent 模式状态
- `toggleAgentState()`: 切换 Agent 状态
- `check(toolCategory)`: 获取策略决策
- `isCritical(operation)`: 检查操作是否为关键操作（始终需要 HITL 确认）

### 2.2 ModeManager

**职责**：管理模式和状态

**内部状态**：
- `currentMode`: 当前工作模式（Ask / Plan / Agent）
- `agentState`: Agent 模式内部状态（ask-before-edit / edit-automatically）

**设计原则**：
- 状态封装：外部只能通过方法修改状态
- 状态一致性：模式切换时自动重置 Agent 状态

### 2.3 DecisionEngine

**职责**：根据模式和工具类别返回决策

**决策矩阵**：

```
                    │  readonly  │   write    │  dangerous │
────────────────────┼────────────┼────────────┼────────────┤
 Ask                │   ALLOW    │    DENY    │    DENY    │
 Plan               │   ALLOW    │    DENY    │    DENY    │
 Agent/ask-before   │   ALLOW    │    ASK     │    ASK     │
 Agent/auto-edit    │   ALLOW    │   ALLOW    │    ASK     │
```

**设计原则**：
- 开放封闭：通过矩阵配置扩展决策规则，无需修改代码
- 简单至上：决策逻辑为纯函数，输入确定则输出确定

### 2.4 CategoryOverride

**职责**：管理工具类别覆盖规则

**功能**：
- 允许将特定工具的类别从默认值覆盖为其他值
- 例如：将某个第三方工具标记为 dangerous

**设计原则**：
- 精益求精：初期仅支持简单的名称-类别映射，不做复杂的规则引擎

### 2.5 CriticalOperationChecker

**职责**：检查操作是否为关键操作

**功能**：
- 根据 Agent 配置的 `permission.critical` 定义判断操作是否为关键操作
- 关键操作即使在 edit-automatically 模式下仍需要 HITL 确认

**接口**：
```typescript
interface CriticalOperationChecker {
  /**
   * 检查 bash 命令是否为关键操作
   * 内部调用 utils/command-parser.getCommandRoots() 获取命令头部
   * 然后与默认关键操作列表和 Agent 配置的扩展列表进行通配符匹配
   */
  isCriticalBashCommand(command: string, agentConfig?: AgentConfig): boolean

  /**
   * 检查路径是否为 external_directory
   * 内部调用 utils/paths.contains() 判断
   */
  isExternalDirectory(path: string, projectRoot: string): boolean
}
```

**依赖**：
| 依赖模块 | 调用接口 | 用途 |
|----------|----------|------|
| utils/command-parser | `getCommandRoots()` | 解析命令，获取命令头部列表 |
| utils/command-parser | `matchesPattern()` | 匹配关键操作模式 |
| utils/paths | `contains()` | 检查路径是否在项目目录内 |

**默认关键操作列表**（硬编码）：
- `git push*`、`git push -f*`、`git push --force*`
- `git reset --hard*`
- `rm -rf*`、`rm -r -f*`

**Agent 配置扩展**：
- `permission.critical.bashPatterns`: 额外的关键 bash 命令模式
- `permission.critical.disableDefaults`: 禁用默认关键操作检查（危险）

**检查流程**：
```
isCriticalBashCommand(command, agentConfig)
    │
    ├── 1. 调用 getCommandRoots(command) 获取命令头部
    │
    ├── 2. 检查默认关键操作列表
    │      （除非 agentConfig.permission.critical.disableDefaults = true）
    │
    ├── 3. 检查 agentConfig.permission.critical.bashPatterns
    │
    └── 4. 任一匹配则返回 true
```

**设计原则**：
- 关键操作列表可通过 Agent 配置扩展
- 检查逻辑为纯函数，便于测试

---

## 三、Design Patterns（设计模式）

### 3.1 状态模式（State Pattern）

**应用场景**：模式和 Agent 状态管理

**实现方式**：
- 不使用传统的状态类继承
- 采用简化实现：状态枚举 + 决策矩阵
- 状态切换通过 ModeManager 统一管理

**选择理由**：
- 模式数量有限（3 种模式 + 2 种状态）
- 决策逻辑简单，无需复杂的状态行为封装
- 符合 KISS 原则

### 3.2 策略模式（Strategy Pattern）

**应用场景**：决策计算

**实现方式**：
- DecisionEngine 内部使用决策矩阵
- 未来可扩展为可插拔的决策策略

**选择理由**：
- 决策逻辑可能随需求变化
- 便于单元测试

### 3.3 观察者模式（Observer Pattern）

**应用场景**：状态变化通知

**实现方式**：
- 通过 Bus 模块发布事件
- UI 和其他模块订阅事件

**选择理由**：
- 解耦 Policy 与 UI
- 支持多个订阅者

---

## 四、Event Design（事件设计）

### 4.1 发布的事件

| 事件名称 | 触发时机 | 携带数据 |
|----------|----------|----------|
| Policy.Event.ModeChanged | 模式切换时 | { previousMode, currentMode } |
| Policy.Event.AgentStateChanged | Agent 状态切换时 | { previousState, currentState } |

### 4.2 订阅的事件

当前 MVP 中 Policy 不直接订阅 Permission 事件。Permission 的 always 授权只写入 permission 自己的会话级批准表；后续匹配请求由 Permission 自动批准。若后续产品需要全局或会话级自动编辑模式，应由 Commands 或 runtime composition 显式调用 Policy 接口。

---

## 五、Dependency（依赖关系）

### 5.1 外部依赖

| 依赖模块 | 依赖方式 | 用途 |
|----------|----------|------|
| Bus | 运行时依赖 | 发布/订阅事件 |
| utils/command-parser | 运行时依赖 | CriticalOperationChecker 使用，解析命令头部和模式匹配 |
| utils/paths | 运行时依赖 | CriticalOperationChecker 使用，检查路径包含关系 |

### 5.2 被依赖

| 依赖方 | 调用接口 | 用途 |
|--------|----------|------|
| ToolScheduler | check() | 获取工具执行决策 |
| Commands | cycleMode(), toggleAgentState() | 响应快捷键 |
| UI | getMode(), getAgentState() | 显示当前状态 |

---

## 六、Initialization（初始化）

### 初始状态

- 默认模式：Agent
- 默认 Agent 状态：ask-before-edit

### 初始化流程

1. 创建 PolicyManager 实例
2. 初始化 ModeManager（设置默认状态）
3. 初始化 DecisionEngine（加载决策矩阵）
4. 初始化 CategoryOverride（加载覆盖规则，如有）
5. 订阅 Permission 的状态切换请求事件

---

## 七、Error Handling（错误处理）

### 设计原则

Policy 模块的操作均为同步、确定性的，不涉及 I/O 或外部调用，因此错误场景有限。

### 错误场景

| 场景 | 处理方式 |
|------|----------|
| 无效的模式值 | 忽略，保持当前模式不变 |
| 无效的工具类别 | 返回 DENY（保守策略） |
| Bus 发布失败 | 记录日志，不影响状态变更 |

---

## 八、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 组件职责单一，边界清晰
- [x] 设计模式选择有明确理由
- [x] 依赖关系明确，无循环依赖
- [x] 遵循 KISS、YAGNI、SOLID 原则
