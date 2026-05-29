# tool-scheduler 模块 test.md

本文档说明如何验证 `tool-scheduler` 模块在真实协作环境中的可信性。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责：

| 职责 | 验证目标 |
|------|----------|
| 工具注册 | 正确注册和查询工具 |
| 类别映射 | 正确维护工具类别 |
| 模式过滤 | 根据模式正确过滤工具 |
| 策略集成 | 正确调用 Policy 并处理决策 |
| 权限集成 | 正确调用 Permission 并处理响应 |
| 并发控制 | 正确控制读写操作的并发 |
| 状态管理 | 正确管理工具调用状态 |
| 事件发布 | 正确发布状态变化事件 |
| 取消执行 | 正确取消工具调用 |
| 来源语义 | 区分 `module`、`skill`、`mcp` source |
| 显式确认 | `requireExplicitApproval` 触发不可 remember 的用户确认 |

### 不在测试范围

以下内容不在本模块测试范围内：

- 工具的具体执行逻辑（tools 模块职责）
- 策略决策逻辑（Policy 模块职责）
- 用户确认 UI（Permission 模块职责）
- 事件分发机制（Bus 模块职责）

### improve-1 新增验收场景

- `createSkillTool()` 与 `createSkillResourceTool()` 注册为 `source: "skill"`，且 `category: "skill"` 保持不变。
- `ToolRegistry` 对 `source: "skill"` 且未显式 category 的工具推断为 `category: "skill"`，并在 `list()` / `getAvailableTools()` 中保留 `source: "skill"`。
- 非 MCP 工具只要设置 `requireExplicitApproval: true`，即使 permission state 已允许，也必须调用 `Permission.ask()`，`reason` 为 `explicit-approval-required`，`rememberable` 为 `false`。
- `source: "mcp"` 本身不触发额外确认；只有 `requireExplicitApproval: true` 才触发确认。
- MCP adapter 将 `trust: false` 映射为 `requireExplicitApproval: true`，`trust: true` 映射为 `false`。
- `mcp_resource` / `mcp_prompt` 固定设置 `requireExplicitApproval: true`。
- `stream-bridge-run-event-source` 独立测试 stream event 到 lifecycle event 的转换，并验证缺失 `sessionId` 的事件被跳过。

---

## 二、Critical Scenarios（关键场景）

### 2.1 工具注册与查询

**场景 1：注册内置工具**
- 前置条件：无
- 操作：调用 register(ReadTool)
- 预期结果：工具可通过 get('read') 查询到

**场景 2：查询不存在的工具**
- 前置条件：无
- 操作：调用 get('nonexistent')
- 预期结果：返回 undefined

**场景 3：注册工具类别**
- 前置条件：无
- 操作：调用 registerCategory('custom_tool', 'dangerous')
- 预期结果：getCategory('custom_tool') 返回 'dangerous'

### 2.2 模式感知的工具过滤

**场景 4：Ask 模式下的可用工具**
- 前置条件：Policy.getMode() 返回 'ask'
- 操作：调用 getAvailableTools()
- 预期结果：只返回 readonly 和 network 类别的工具

**场景 5：Agent 模式下的可用工具**
- 前置条件：Policy.getMode() 返回 'agent'
- 操作：调用 getAvailableTools()
- 预期结果：返回所有类别的工具

**场景 6：Plan 模式下尝试写工具**
- 前置条件：Policy.getMode() 返回 'plan'
- 操作：调用 getAvailableTools()
- 预期结果：不包含 write 和 dangerous 类别的工具

### 2.3 策略集成

**场景 7：Policy 返回 ALLOW**
- 前置条件：Policy.check() 返回 'allow'
- 操作：调用 execute({ toolName: 'read', ... })
- 预期结果：直接执行工具，返回成功结果

**场景 8：Policy 返回 DENY**
- 前置条件：Policy.check() 返回 'deny'
- 操作：调用 execute({ toolName: 'bash', ... })
- 预期结果：返回 rejected 结果，不执行工具

**场景 9：Policy 返回 ASK**
- 前置条件：Policy.check() 返回 'ask'
- 操作：调用 execute({ toolName: 'edit', ... })
- 预期结果：调用 Permission.ask()

### 2.4 权限集成

**场景 10：用户批准（once）**
- 前置条件：Policy 返回 'ask'，用户选择 'once'
- 操作：调用 execute()
- 预期结果：执行工具，返回成功结果

**场景 11：用户批准（always）**
- 前置条件：Policy 返回 'ask'，用户选择 'always'
- 操作：调用 execute()
- 预期结果：执行工具，返回成功结果

**场景 12：用户拒绝**
- 前置条件：Policy 返回 'ask'，用户选择 'reject'
- 操作：调用 execute()
- 预期结果：返回 rejected 结果，error.type = 'PermissionRejectedError'

### 2.5 并发控制

**场景 13：多个读操作并行**
- 前置条件：无正在执行的工具
- 操作：同时调用 5 个 read 工具
- 预期结果：5 个工具同时执行

**场景 14：读操作达到并发上限**
- 前置条件：已有 5 个读操作执行中
- 操作：再调用一个 read 工具
- 预期结果：第 6 个工具状态为 queued，等待执行

**场景 15：写操作等待读操作完成**
- 前置条件：有读操作执行中
- 操作：调用 edit 工具
- 预期结果：edit 工具状态为 queued，等待读操作完成

**场景 16：写操作执行时读操作等待**
- 前置条件：有写操作执行中
- 操作：调用 read 工具
- 预期结果：read 工具状态为 queued

**场景 17：写操作完成后队列处理**
- 前置条件：写操作执行中，队列中有 3 个读操作
- 操作：写操作完成
- 预期结果：3 个读操作开始并行执行

**场景 18：读操作全部完成后写操作执行**
- 前置条件：3 个读操作执行中，队列中有 1 个写操作
- 操作：所有读操作完成
- 预期结果：写操作开始执行

### 2.6 状态管理

**场景 19：状态正常流转（成功）**
- 前置条件：无
- 操作：执行一个成功的工具调用
- 预期结果：状态依次为 pending → checking_permission → queued → executing → success

**场景 20：状态流转（被拒绝）**
- 前置条件：Policy 返回 'deny'
- 操作：调用 execute()
- 预期结果：状态依次为 pending → checking_permission → rejected

**场景 21：状态流转（等待确认）**
- 前置条件：Policy 返回 'ask'
- 操作：调用 execute()
- 预期结果：状态依次为 pending → checking_permission → awaiting_approval

**场景 22：查询工具状态**
- 前置条件：工具正在执行
- 操作：调用 getStatus(callId)
- 预期结果：返回 'executing'

### 2.7 事件发布

**场景 23：状态变化事件**
- 前置条件：无
- 操作：执行工具，状态从 pending 变为 checking_permission
- 预期结果：发布 StatusChanged 事件，携带正确数据

**场景 24：执行开始事件**
- 前置条件：无
- 操作：工具开始执行
- 预期结果：发布 ExecutionStarted 事件

**场景 25：执行完成事件**
- 前置条件：无
- 操作：工具执行完成
- 预期结果：发布 ExecutionCompleted 事件，携带结果

### 2.8 取消执行

**场景 26：取消队列中的工具**
- 前置条件：工具状态为 queued
- 操作：调用 cancel(callId)
- 预期结果：状态变为 cancelled，从队列移除

**场景 27：取消执行中的工具**
- 前置条件：工具状态为 executing
- 操作：调用 cancel(callId)
- 预期结果：发送 abort 信号，状态变为 cancelled

**场景 28：取消所有工具**
- 前置条件：有多个工具在执行和队列中
- 操作：调用 cancelAll()
- 预期结果：所有工具状态变为 cancelled

**场景 29：取消已完成的工具**
- 前置条件：工具状态为 success
- 操作：调用 cancel(callId)
- 预期结果：返回 false，状态不变

### 2.9 错误处理

**场景 30：工具不存在**
- 前置条件：无
- 操作：调用 execute({ toolName: 'nonexistent', ... })
- 预期结果：返回 error 结果，error.type = 'ToolNotFoundError'

**场景 31：工具执行超时**
- 前置条件：工具执行时间超过 2 分钟
- 操作：等待超时
- 预期结果：状态变为 error，error.type = 'TimeoutError'

**场景 32：工具执行失败**
- 前置条件：工具执行抛出异常
- 操作：执行工具
- 预期结果：状态变为 error，error.type = 'ExecutionError'

---

## 三、Integration Points（集成点测试）

### 3.1 与 Policy 模块集成

**验证重点**：
- getMode() 被正确调用
- check() 被正确调用，传入正确的 category
- 决策结果被正确处理

**失败处理预期**：
- Policy 调用失败时，返回错误结果

### 3.2 与 Permission 模块集成

**验证重点**：
- ask() 在 Policy 返回 'ask' 时被调用
- 用户响应被正确处理
- RejectedError 被正确捕获

**失败处理预期**：
- Permission 调用失败时，返回错误结果

### 3.3 与 tools 模块集成

**验证重点**：
- 工具被正确调用
- 参数被正确传递
- 返回值被正确包装

**失败处理预期**：
- 工具执行失败时，错误被正确捕获和返回

### 3.4 与 Bus 模块集成

**验证重点**：
- 事件在正确时机发布
- 事件携带正确数据

**失败处理预期**：
- Bus 发布失败不影响主流程

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**适用场景**：
- 状态机转换逻辑
- 并发控制逻辑
- 类别映射逻辑
- 模式过滤逻辑

**策略**：
- Mock 外部依赖（Policy, Permission, tools）
- 验证状态转换正确性
- 验证并发控制正确性

### 4.2 集成测试（Mock 外部模块）

**适用场景**：
- 完整执行流程
- 事件发布验证
- 错误处理验证

**策略**：
- Mock Policy、Permission、Bus
- 使用真实的 tools 模块
- 验证端到端流程

### 4.3 并发测试

**适用场景**：
- 多工具并行执行
- 队列处理逻辑
- 资源释放逻辑

**策略**：
- 创建多个并发请求
- 验证并发数量符合限制
- 验证队列处理顺序

### 4.4 压力测试

**适用场景**：
- 大量工具调用
- 长时间运行稳定性

**策略**：
- 连续执行大量工具调用
- 验证内存无泄漏
- 验证状态管理正确

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 并发控制场景完整覆盖
- [x] 状态转换场景完整覆盖
- [x] 集成点测试明确
- [x] 场景来源于 goals-duty.md 和 dfd-interface.md
