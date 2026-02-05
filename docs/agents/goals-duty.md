# agent 模块 goals-duty.md

本文档定义 `agent` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：agent 模块是 iris-code 的代理配置管理中心，负责管理主代理和子代理的配置、提供查询接口，并通过 SubagentExecutor 支持子代理的受控执行。

**如果没有这个模块**：
- Lifecycle 将缺乏切换不同代理行为的能力
- 无法支持子代理来处理复杂的独立任务
- 工具权限、maxSteps 等配置将难以统一管理
- 系统提示词无法按角色定制
- 无法实现主代理与子代理的协作模式

---

## 二、Design Goals（设计目标）

### G1: 统一的代理配置管理

为系统提供统一的代理配置管理能力，支持主代理（Primary Agent）和子代理（Subagent）两种类型，每种类型有不同的配置特性和使用场景。

### G2: 灵活的配置加载机制

支持从多个来源加载代理配置：
- 内置代理：代码定义的默认代理（build、plan、explore、research）
- 全局配置：用户级配置文件（`~/.iris-code/agents/`）
- 项目配置：项目级配置文件（`.iris-code/agents/`）

配置采用合并策略，项目级可覆盖全局级，全局级可覆盖内置配置。

### G3: 受控的子代理执行

通过 SubagentExecutor 提供子代理的受控执行能力：
- 子代理在独立 Session 中运行，上下文隔离
- 限制最大并发数（3个），防止资源耗尽
- 禁止子代理创建孙代理，防止递归失控

### G4: 与 System-Prompt 模块协作

与 System-Prompt 模块协作，为每个代理组装完整的系统提示词：
- 主代理使用完整的主代理提示
- 子代理使用精简的专属提示

### G5: 与 Policy 模块协同

Agent 配置中的 permission 字段与 Policy 模块协同工作：
- Policy 模块订阅当前 Agent 变化，读取 permission 字段
- Policy 的 Plan 模式对应 plan Agent
- Policy 的 Agent 模式对应 build Agent

---

## 三、Duties（职责）

### D1: 管理代理配置

加载、存储、获取代理配置，提供统一的查询接口：
- `get(name)`: 获取指定代理的配置
- `list()`: 列出所有可用代理
- `getDefault()`: 获取默认主代理

### D2: 提供内置代理

提供 4 个内置代理：

| 代理 | 类型 | 说明 |
|------|------|------|
| build | primary | 全功能开发代理，可执行所有操作 |
| plan | primary | 只读分析代理，用于规划方案 |
| explore | subagent | 代码探索代理，快速搜索和分析代码 |
| research | subagent | 深度研究代理，处理复杂的多步骤任务 |

### D3: 默认代理管理

管理默认代理和 Policy 模式的对应关系：
- **默认主代理**：`build`，即 Policy 的 Agent 模式
- `getDefault()`: 返回默认主代理名称（`build`）
- Policy 模式切换时自动关联对应代理：
  - Agent 模式 → build Agent（默认主代理）
  - Plan 模式 → plan Agent
  - Ask 模式 → 当前代理不变，仅限制为只读
- 用户可通过配置 `default: true` 更改默认主代理

### D4: 验证代理配置

确保代理配置的完整性和有效性：
- 必填字段验证（name、mode）
- 子代理必须有 description 字段
- 工具配置格式验证
- 权限配置格式验证

### D5: 区分主代理与子代理

通过 mode 字段区分代理类型：
- `primary`: 主代理，用户直接交互
- `subagent`: 子代理，被主代理通过 Task 工具调用
- `all`: 两者皆可

防止主代理被作为子代理调用。

### D6: 执行子代理任务

通过 SubagentExecutor 执行子代理任务：
- 创建独立的子 Session
- 调用 Lifecycle 执行子代理循环
- 等待执行完成并返回结果
- 控制并发数量（最多 3 个）
- **中断处理**：用户按 Ctrl+C 时，同时中断主代理和所有正在运行的子代理

### D7: 组装系统提示词

调用 System-Prompt 模块组装完整的系统提示词：
- 主代理：使用完整主代理提示 + 环境信息 + 自定义指令
- 子代理：使用精简专属提示 + 环境信息（不含自定义指令）

### D8: 加载自定义指令

加载项目级和全局级的自定义指令文件（如 IRIS.md），用于组装主代理的系统提示词。

---

## 四、Non-Duties（非职责）

### N1: 不负责执行循环

代理的执行循环（LLM 调用、工具执行）由 Lifecycle 模块负责。Agent 模块只提供配置。

### N2: 不负责 Session 管理

Session 的创建、存储、删除由 Session 模块负责。Agent 模块只在 SubagentExecutor 中调用 Session 模块的接口。

### N3: 不负责权限检查

工具的权限检查由 Policy 模块负责。Agent 模块只提供 permission 配置。

### N4: 不负责权限确认

用户确认流程由 Permission 模块负责。Agent 模块不参与确认交互。

### N5: 不负责工具执行

工具的实际执行由 ToolScheduler 模块负责。Agent 模块只提供工具启用/禁用配置。

### N6: 不负责消息存储

消息的存储和查询由 Message 模块负责。Agent 模块不直接操作消息。

### N7: 不负责提示词存储

提示词模板的存储和管理由 System-Prompt 模块负责。Agent 模块只调用其组装接口。

### N8: 不负责模式切换

工作模式（Ask/Plan/Agent）的切换由 Policy 模块负责。Agent 模块只响应模式切换，提供对应的代理配置。

### N9: 不负责动态生成代理

MVP 阶段不支持通过 LLM 动态生成新的代理配置。

---

## 五、设计约束与假设

### 约束

1. **并发限制**：最多同时运行 3 个子代理，超出则抛出错误
2. **递归禁止**：子代理禁用 task 工具，不能创建孙代理
3. **配置格式**：使用 JSON 格式配置文件
4. **重试策略**：子代理执行失败不自动重试，由主代理决定

### 假设

1. Lifecycle 模块已正确实现执行循环
2. Session 模块支持 parent-child 关系
3. System-Prompt 模块提供分层提示词组装能力
4. Policy 模块能订阅 Agent 变化事件

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| Lifecycle | 被依赖 | Lifecycle 获取 Agent 配置执行循环 |
| Session | 依赖 | SubagentExecutor 创建子 Session |
| System-Prompt | 依赖 | 调用 System-Prompt 组装提示词 |
| Policy | 被订阅 | Policy 订阅 Agent 变化，读取 permission |
| Permission | 无关 | 不直接交互，通过 Policy 间接协作 |
| ToolScheduler | 被依赖 | ToolScheduler 读取 Agent 的工具配置 |
| tools/task | 被依赖 | task 工具调用 SubagentExecutor.execute() |
| Bus | 依赖 | 发布 Agent 变化事件 |
| Config | 依赖 | 读取配置文件路径 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
