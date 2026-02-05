# lifecycle 模块 test.md

本文档描述 `lifecycle` 模块的测试策略与验证方法。测试围绕职责而非代码结构，关注交互边界而非内部实现。

---

## 一、Test Scope（测试范围）

### 覆盖范围

本模块测试覆盖以下职责（对应 goals-duty.md）：

| 职责 | 测试重点 |
|------|----------|
| D1: 实现执行循环 | 验证循环能正确执行到完成 |
| D2: 协调组件 | 验证正确调用 LLMClient 和 ToolScheduler |
| D3: 判断退出条件 | 验证各种退出条件的正确处理 |
| D4: 维护执行状态 | 验证状态正确更新 |
| D5: 提供执行事件 | 验证事件类型和顺序正确 |
| D6: 并发控制 | 验证重复调用被正确拒绝 |
| D7: 格式化工具结果 | 验证工具结果正确转换 |

### 不在测试范围

以下内容由其他模块负责测试：

- LLMClient 的 API 调用细节
- ToolScheduler 的工具执行逻辑
- Conversation 的消息持久化
- AgentManager 的配置加载

---

## 二、Critical Scenarios（关键场景）

### 场景 1: 简单对话（无工具调用）

**前置条件**：
- LLM 返回纯文本响应，finishReason 为 stop

**验证要点**：
- 循环执行 1 步后正常退出
- yield 事件顺序：llm:start -> llm:delta -> llm:complete -> step:complete
- LoopResult.success 为 true
- LoopResult.finishReason 为 stop

### 场景 2: 工具调用循环

**前置条件**：
- LLM 第一次返回 tool_calls
- 工具执行成功
- LLM 第二次返回纯文本，finishReason 为 stop

**验证要点**：
- 循环执行 2 步
- yield 事件包含 tool:start 和 tool:result
- 工具结果正确格式化并发送给 LLM
- 最终 LoopResult.success 为 true

### 场景 3: 达到 maxSteps 限制

**前置条件**：
- Agent 配置 maxSteps 为 3
- LLM 持续返回 tool_calls

**验证要点**：
- 循环在第 3 步后退出
- LoopResult.finishReason 为 maxSteps
- 最后一步收到特殊提示（如 MAX_STEPS 提示词）

### 场景 4: 用户取消

**前置条件**：
- 执行过程中调用 controller.abort()

**验证要点**：
- 循环立即退出
- LoopResult.finishReason 为 abort
- 清理并发状态

### 场景 5: 并发调用拒绝

**前置条件**：
- 对同一 sessionId 同时发起两次 run()

**验证要点**：
- 第二次调用抛出 SessionBusyError 或返回错误事件
- 第一次调用继续正常执行

### 场景 6: 工具执行错误

**前置条件**：
- LLM 返回 tool_calls
- 工具执行抛出错误

**验证要点**：
- yield tool:error 事件
- 错误信息格式化为工具结果
- 循环继续，让 LLM 处理错误
- 不会导致整个循环崩溃

### 场景 7: LLM 调用失败

**前置条件**：
- LLMClient 抛出网络错误

**验证要点**：
- 内部重试（最多 3 次）
- 重试失败后 yield error 事件
- LoopResult.success 为 false
- LoopResult.error 包含错误信息

### 场景 8: 空工具列表

**前置条件**：
- Agent 配置不包含任何工具
- 或 ToolScheduler 未提供

**验证要点**：
- 循环正常执行
- LLM 返回的 tool_calls 被跳过或返回错误信息
- 不会崩溃

---

## 三、Integration Points（集成点测试）

### 与 LLMClient 集成

**正常情况**：
- 正确传递 messages 和配置
- 正确消费流式响应
- 正确处理 finishReason

**异常情况**：
- LLMClient 超时：触发重试
- LLMClient 返回空响应：优雅处理
- 流式中断：能够检测并处理

### 与 ToolScheduler 集成

**正常情况**：
- 正确传递 toolCalls 列表
- 正确接收 toolResults
- 正确格式化为消息

**异常情况**：
- ToolScheduler 未提供：跳过工具执行或返回错误
- 权限被拒绝：记录并返回给 LLM
- 执行超时：正确处理

### 与 Conversation 集成

**正常情况**：
- 正确读取历史消息
- 执行完成后正确写入新消息

**异常情况**：
- 读取失败：抛出错误，循环不启动
- 写入失败：记录错误，不影响返回结果

### 与 AgentManager 集成

**正常情况**：
- 正确获取 Agent 配置
- 正确使用 maxSteps 限制

**异常情况**：
- Agent 不存在：使用默认配置
- 配置缺失字段：使用默认值

---

## 四、Verification Strategy（验证策略）

### 单元测试策略

**Lifecycle 测试**：
- Mock 所有依赖（LLMClient, ToolScheduler, Conversation, AgentManager）
- 验证外层循环逻辑
- 验证退出条件判断
- 验证并发控制

**TurnProcessor 测试**：
- Mock LLMClient 和 ToolScheduler
- 验证流式事件处理
- 验证工具结果格式化
- 验证错误处理

### 集成测试策略

**组件集成**：
- 使用真实 LLMClient（可配置使用 mock provider）
- 使用真实 ToolScheduler（配置测试工具）
- 验证完整数据流

**端到端测试**：
- 需要真实 LLM API（或 mock server）
- 验证真实场景下的行为

### Mock 策略

**LLMClient Mock**：
```
模拟返回预定义的流式响应序列
支持配置：
- 响应内容
- 是否包含 tool_calls
- finishReason
- 是否抛出错误
```

**ToolScheduler Mock**：
```
模拟返回预定义的工具结果
支持配置：
- 执行延迟
- 返回结果
- 是否抛出错误
```

### 测试数据

**Fixtures 目录**：
```
__tests__/fixtures/
├── messages/           # 预定义消息序列
├── responses/          # 预定义 LLM 响应
├── tool-results/       # 预定义工具结果
└── configs/            # Agent 配置
```

---

## 五、测试优先级

| 优先级 | 场景 | 理由 |
|--------|------|------|
| P0 | 简单对话、工具调用循环 | 核心功能 |
| P0 | 并发控制 | 数据一致性关键 |
| P1 | 退出条件（maxSteps, abort） | 用户体验关键 |
| P1 | 错误处理 | 系统稳定性关键 |
| P2 | 边界情况（空工具等） | 健壮性 |

---

## 六、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试策略关注行为而非覆盖率
