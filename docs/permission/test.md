# permission 模块 test.md

本文档说明如何验证 `permission` 模块在真实协作环境中的可信性。测试围绕模块职责和交互边界展开，而非内部实现细节。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责：

| 职责 | 验证目标 |
|------|----------|
| 权限确认执行 | ask() 正确阻塞并等待响应 |
| 队列管理 | 请求按序处理，一次一个 |
| 批准列表管理 | always 响应正确记录，后续请求可跳过确认 |
| 响应处理 | 四种响应类型均正确处理 |
| Pattern 生成与匹配 | 生成的 Pattern 格式正确，匹配逻辑符合预期 |
| 事件发布 | 正确时机发布正确事件 |
| 会话清理 | 清理时移除所有相关数据 |

### 不在测试范围

以下内容不在本模块测试范围内：

- UI 层的确认框渲染与交互逻辑
- Policy 模块的模式切换决策
- Bus 模块的事件分发机制
- 工具模块的调用逻辑
- 超时处理（由 Agent 运行时负责）

---

## 二、Critical Scenarios（关键场景）

### 2.1 权限确认基本流程

**场景 1：首次请求需要用户确认**

- 前置条件：无已批准记录
- 操作：调用 ask() 请求权限
- 预期结果：
  - 生成包含 permissionId 的 PermissionInfo
  - 发布 Event.Updated 事件
  - Promise 保持 pending 状态直到 respond() 被调用

**场景 2：已批准的请求自动通过**

- 前置条件：存在匹配的批准记录
- 操作：调用 ask() 请求权限
- 预期结果：
  - Promise 立即 resolve
  - 不发布 Event.Updated 事件

**场景 3：用户选择 once**

- 前置条件：有待处理的权限请求
- 操作：调用 respond() 传入 { type: 'once' }
- 预期结果：
  - ask() 的 Promise resolve
  - 发布 Event.Replied 事件
  - 不添加批准记录
  - 不发布 SwitchModeRequested 事件

**场景 4：用户选择 always**

- 前置条件：有待处理的权限请求
- 操作：调用 respond() 传入 { type: 'always' }
- 预期结果：
  - ask() 的 Promise resolve
  - 发布 Event.Replied 事件
  - 添加对应 Pattern 到批准记录
  - 发布 SwitchModeRequested 事件

**场景 5：用户选择 reject**

- 前置条件：有待处理的权限请求
- 操作：调用 respond() 传入 { type: 'reject' }
- 预期结果：
  - ask() 的 Promise reject
  - 抛出 PermissionRejectedError
  - 发布 Event.Replied 事件

**场景 6：用户选择 suggest**

- 前置条件：有待处理的权限请求
- 操作：调用 respond() 传入 { type: 'suggest', suggestion: '...' }
- 预期结果：
  - ask() 的 Promise reject
  - 抛出 PermissionRejectedWithSuggestionError，包含建议内容
  - 发布 Event.Replied 事件

### 2.2 队列管理

**场景 7：多个请求串行处理**

- 前置条件：无
- 操作：连续调用两次 ask()
- 预期结果：
  - 只发布一次 Event.Updated（第一个请求）
  - 第一个请求 respond() 后，发布第二个请求的 Event.Updated
  - 两个请求按顺序处理

**场景 8：队列中的请求被会话清理**

- 前置条件：队列中有待处理请求
- 操作：调用 clearSession()
- 预期结果：
  - 该会话的所有待处理请求被移除
  - 对应的 Promise 被 reject（可选：使用特定错误类型）

### 2.3 Pattern 匹配

**场景 9：精确匹配**

- 前置条件：批准记录包含 `tool:edit:src/components/**`
- 操作：请求 `tool:edit:src/components/Button.tsx`
- 预期结果：匹配成功，自动通过

**场景 10：父级匹配**

- 前置条件：批准记录包含 `tool:edit:src/**`
- 操作：请求 `tool:edit:src/components/Button.tsx`
- 预期结果：匹配成功，自动通过

**场景 11：不匹配**

- 前置条件：批准记录包含 `tool:edit:src/**`
- 操作：请求 `tool:edit:tests/unit/test.ts`
- 预期结果：不匹配，需要用户确认

**场景 12：工具级匹配**

- 前置条件：批准记录包含 `tool:read`
- 操作：请求读取任意文件
- 预期结果：匹配成功，自动通过

### 2.4 会话隔离

**场景 13：不同会话的批准记录隔离**

- 前置条件：Session A 有批准记录 `tool:edit:src/**`
- 操作：Session B 请求 `tool:edit:src/file.ts`
- 预期结果：不匹配，Session B 需要用户确认

**场景 14：会话清理只影响目标会话**

- 前置条件：Session A 和 Session B 都有批准记录
- 操作：调用 clearSession(sessionA)
- 预期结果：
  - Session A 的批准记录被清除
  - Session B 的批准记录保持不变

---

## 三、Integration Points（集成点测试）

### 3.1 与 Bus 模块集成

**验证重点**：

- Event.Updated 在正确时机发布
- Event.Replied 包含正确的响应数据
- Event.SwitchModeRequested 仅在 always 响应时发布

**失败处理预期**：

- 如果 Bus.publish() 失败，permission 模块应记录错误但不影响核心流程
- 事件发布失败不应导致 Promise resolve/reject 失败

### 3.2 与工具模块集成

**验证重点**：

- ask() 返回的 Promise 能正确阻塞工具执行
- 工具模块传入的参数能正确转换为 PermissionInfo
- reject 错误能被工具模块正确捕获和处理

**失败处理预期**：

- 工具模块传入无效参数时，ask() 应抛出明确错误

### 3.3 与 Session 模块集成

**验证重点**：

- clearSession() 能正确清理指定会话的所有数据
- 清理操作不影响其他会话

**失败处理预期**：

- 清理不存在的会话时，应静默成功（幂等性）

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

**适用场景**：

- Pattern 生成逻辑
- Pattern 匹配逻辑
- ID 生成逻辑
- 队列操作逻辑

**策略**：

- 使用纯函数测试，无需 mock
- 覆盖边界情况（空输入、特殊字符、长路径）

### 4.2 集成测试（Mock 外部依赖）

**适用场景**：

- ask() / respond() 完整流程
- 事件发布验证
- 批准记录管理

**策略**：

- Mock Bus 模块，验证事件发布调用
- 使用内存存储，无需真实持久化
- 验证 Promise 状态变化

### 4.3 集成测试（真实依赖）

**适用场景**：

- 与真实 Bus 模块的事件流转
- 多会话并发场景

**策略**：

- 在测试环境中使用真实 Bus 实例
- 验证端到端事件流

### 4.4 手动验证

**适用场景**：

- UI 确认框的用户体验
- 不同响应选项的交互流程

**验证要点**：

- 确认框显示内容是否清晰
- 四个选项是否都能正常工作
- 队列处理时用户感知是否正常

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 模块与外部交互时的失败处理预期已明确
- [x] 测试围绕行为而非实现细节
- [x] 场景来源于 goals-duty.md 和 dfd-interface.md
