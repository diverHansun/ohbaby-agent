# policy 模块 test.md

本文档说明如何验证 `policy` 模块在真实协作环境中的可信性。测试围绕模块职责和交互边界展开，而非内部实现细节。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责：

| 职责 | 验证目标 |
|------|----------|
| 模式管理 | getMode/setMode/cycleMode 正确工作 |
| Agent 状态管理 | getAgentState/setAgentState/toggleAgentState 正确工作 |
| 决策计算 | check() 返回正确的 PolicyDecision |
| 事件发布 | 状态变化时正确发布事件 |
| 状态重置 | 模式切换时 Agent 状态正确重置 |

### 不在测试范围

以下内容不在本模块测试范围内：

- 快捷键的监听和解析（Commands 模块职责）
- UI 的模式指示器渲染（UI 层职责）
- Permission 确认流程的执行（Permission 模块职责）
- 工具的实际执行（ToolScheduler 职责）
- Bus 的事件分发机制（Bus 模块职责）

---

## 二、Critical Scenarios（关键场景）

### 2.1 模式管理

**场景 1：获取默认模式**

- 前置条件：新创建的 Policy 实例
- 操作：调用 getMode()
- 预期结果：返回 'agent'

**场景 2：设置模式**

- 前置条件：当前模式为 'agent'
- 操作：调用 setMode('ask')
- 预期结果：
  - getMode() 返回 'ask'
  - 发布 ModeChanged 事件，携带 { previousMode: 'agent', currentMode: 'ask' }

**场景 3：设置相同模式**

- 前置条件：当前模式为 'agent'
- 操作：调用 setMode('agent')
- 预期结果：
  - getMode() 返回 'agent'
  - 不发布 ModeChanged 事件

**场景 4：循环切换模式**

- 前置条件：当前模式为 'agent'
- 操作：连续调用 cycleMode() 三次
- 预期结果：
  - 第一次：返回 'ask'，发布事件
  - 第二次：返回 'plan'，发布事件
  - 第三次：返回 'agent'，发布事件

**场景 5：无效模式值**

- 前置条件：当前模式为 'agent'
- 操作：调用 setMode('invalid' as any)
- 预期结果：
  - getMode() 仍返回 'agent'
  - 不发布事件

### 2.2 Agent 状态管理

**场景 6：获取默认 Agent 状态**

- 前置条件：新创建的 Policy 实例
- 操作：调用 getAgentState()
- 预期结果：返回 'ask-before-edit'

**场景 7：设置 Agent 状态**

- 前置条件：当前状态为 'ask-before-edit'
- 操作：调用 setAgentState('edit-automatically')
- 预期结果：
  - getAgentState() 返回 'edit-automatically'
  - 发布 AgentStateChanged 事件

**场景 8：切换 Agent 状态**

- 前置条件：当前状态为 'ask-before-edit'
- 操作：调用 toggleAgentState()
- 预期结果：
  - 返回 'edit-automatically'
  - getAgentState() 返回 'edit-automatically'
  - 发布 AgentStateChanged 事件

**场景 9：模式切换重置 Agent 状态**

- 前置条件：当前模式为 'agent'，Agent 状态为 'edit-automatically'
- 操作：调用 setMode('ask')，再调用 setMode('agent')
- 预期结果：
  - getAgentState() 返回 'ask-before-edit'（已重置）

### 2.3 决策计算

**场景 10：Ask 模式下的决策**

- 前置条件：当前模式为 'ask'
- 操作：分别调用 check('readonly')、check('write')、check('dangerous')
- 预期结果：
  - readonly: 'allow'
  - write: 'deny'
  - dangerous: 'deny'

**场景 11：Plan 模式下的决策**

- 前置条件：当前模式为 'plan'
- 操作：分别调用 check('readonly')、check('write')、check('dangerous')
- 预期结果：
  - readonly: 'allow'
  - write: 'deny'
  - dangerous: 'deny'

**场景 12：Agent/ask-before-edit 下的决策**

- 前置条件：当前模式为 'agent'，Agent 状态为 'ask-before-edit'
- 操作：分别调用 check('readonly')、check('write')、check('dangerous')
- 预期结果：
  - readonly: 'allow'
  - write: 'ask'
  - dangerous: 'ask'

**场景 13：Agent/edit-automatically 下的决策**

- 前置条件：当前模式为 'agent'，Agent 状态为 'edit-automatically'
- 操作：分别调用 check('readonly')、check('write')、check('dangerous')
- 预期结果：
  - readonly: 'allow'
  - write: 'allow'
  - dangerous: 'ask'

**场景 14：未知工具类别**

- 前置条件：任意模式
- 操作：调用 check('unknown' as any)
- 预期结果：返回 'deny'（保守策略）

### 2.4 Permission 协作边界

**场景 15：Permission always 不直接切换 Policy 状态**

- 前置条件：当前 Agent 状态为 'ask-before-edit'
- 操作：Bus 发布 Permission.Event.SwitchModeRequested 事件
- 预期结果：
  - Agent 状态保持 'ask-before-edit'
  - 不发布 AgentStateChanged 事件

---

## 三、Integration Points（集成点测试）

### 3.1 与 Bus 模块集成

**验证重点**：

- ModeChanged 事件在模式变化时正确发布
- AgentStateChanged 事件在状态变化时正确发布
- Permission 的 always 授权事件不会隐式改变 Policy 状态

**失败处理预期**：

- 如果 Bus.publish() 失败，Policy 应记录错误但不影响状态变更
- 如果 Bus.subscribe() 失败，应在初始化时报错

### 3.2 与 ToolScheduler 集成

**验证重点**：

- check() 返回值能被 ToolScheduler 正确使用
- 决策结果与实际工具执行行为一致

**失败处理预期**：

- 传入无效类别时返回 DENY，不抛出异常

### 3.3 与 Commands 集成

**验证重点**：

- cycleMode() 被调用时模式正确切换
- toggleAgentState() 被调用时状态正确切换
- 返回值能被 Commands 正确使用

**失败处理预期**：

- 无特殊失败场景，所有操作均为同步确定性操作

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**适用场景**：

- 决策矩阵查询逻辑
- 模式循环顺序
- 状态切换逻辑
- 输入验证逻辑

**策略**：

- 使用纯函数测试，无需 mock
- 覆盖所有模式和状态组合
- 覆盖边界情况（无效输入）

### 4.2 集成测试（Mock Bus）

**适用场景**：

- 事件发布验证
- Permission 协作边界验证
- 状态变化与事件的一致性

**策略**：

- Mock Bus 模块，验证 publish/subscribe 调用
- 验证事件携带的数据正确性
- 验证事件发布时机正确

### 4.3 集成测试（真实 Bus）

**适用场景**：

- 与真实 Bus 的事件流转
- 多模块协作场景

**策略**：

- 在测试环境中使用真实 Bus 实例
- 模拟 Permission 发布 SwitchModeRequested
- 验证 Policy 不隐式切换状态，后续匹配授权由 Permission 处理

### 4.4 决策矩阵完整性测试

**适用场景**：

- 确保决策矩阵覆盖所有模式、状态、类别组合

**策略**：

- 枚举所有 Mode x AgentState x ToolCategory 组合
- 验证每个组合都有明确的决策结果
- 验证决策结果符合设计文档

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 模块与外部交互时的失败处理预期已明确
- [x] 测试围绕行为而非实现细节
- [x] 场景来源于 goals-duty.md 和 dfd-interface.md
- [x] 决策矩阵的所有组合都有测试覆盖
