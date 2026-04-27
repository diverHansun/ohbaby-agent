# lifecycle 模块 goals-duty.md

本文档定义 `lifecycle` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：lifecycle 是 ohbaby-agent 的核心执行引擎，负责管理用户请求从输入到完成的完整生命周期，协调 LLM 调用与工具执行的循环。

**如果没有这个模块**：
- LLM Client 只能完成单次调用，无法处理多轮工具调用
- 工具执行结果无法反馈给 LLM 继续推理
- 没有统一的"完成"判断逻辑
- 各调用方需要自行实现循环控制，导致代码重复

---

## 二、Design Goals（设计目标）

### G1: 职责单一

模块只负责循环控制和组件协调，不负责 LLM 通信细节或工具执行细节。LLM 调用交给 LLMClient，工具执行交给 ToolScheduler，本模块专注于编排。

### G2: 简洁可理解

核心循环逻辑应在 50 行内可读懂。采用双层循环结构：外层管理多步推理，内层处理单次 LLM 交互，职责分离清晰。

### G3: 可扩展

为未来功能（如上下文压缩、子任务并行执行）预留接口，但当前版本不实现这些功能。遵循开放封闭原则，扩展无需修改核心循环。

### G4: UI 无关

通过 AsyncGenerator 和回调函数提供执行状态更新，不依赖任何特定 UI 框架。CLI、IDE 扩展、Web 等均可接入。

### G5: 可测试

核心逻辑可独立于真实 LLM 和工具进行单元测试。通过依赖注入允许 mock 外部依赖。

### G6: 依赖注入

所有外部依赖通过构造函数或工厂函数注入，便于测试和替换实现。

---

## 三、Duties（职责）

### D1: 实现执行循环

实现 `用户请求 -> LLM 响应 -> 工具执行 -> LLM 响应 -> ... -> 完成` 的循环流程。循环持续直到 LLM 返回 finish_reason 为 stop，或达到最大步数限制。

### D2: 协调组件

调用 LLMClient 获取 LLM 响应，调用 ToolScheduler 执行工具调用。本模块不关心这些组件的内部实现，只关心其接口契约。

### D3: 判断退出条件

根据以下条件判断循环是否应该退出：
- LLM 返回 finish_reason 为 stop（正常完成）
- 达到 maxSteps 限制（从 Agent 配置读取）
- 收到 abort 信号（用户取消）
- 发生不可恢复的错误

### D4: 维护执行状态

在内存中维护当前执行的状态信息，包括：
- 当前步数（step）
- 工具调用记录
- 执行时间
- Token 使用统计（如可获取）

### D5: 提供执行事件

通过 AsyncGenerator yield 执行过程中的事件，事件类型包括：
- `llm:start` - LLM 调用开始
- `llm:delta` - LLM 流式输出片段
- `llm:complete` - LLM 单次调用完成
- `tool:start` - 工具开始执行
- `tool:result` - 工具执行完成
- `step:complete` - 单步完成
- `error` - 错误发生

### D6: 并发控制与重复调用处理

在模块内部实现并发控制，防止同一个 sessionId 同时运行多个循环：
- 使用内部状态 Map 记录每个 sessionId 的执行状态
- 重复调用时支持"等待已有循环完成"机制，而非直接拒绝
- 调用方可选择等待或立即返回错误

### D7: 格式化工具结果

将工具执行的结构化结果格式化为 LLM 可理解的消息格式（OpenAI function_result），作为下一轮 LLM 调用的输入。

### D8: 中断管理

管理执行循环的中断机制：
- **内部状态管理**：为每个正在运行的 sessionId 创建 AbortController 并存储在内部状态 Map
- **中断信号传递**：将 AbortSignal 传递给 TurnProcessor、LLMClient、ToolScheduler
- **中断检查点**：在每次循环迭代开始时检查 `signal.aborted`
- **清理工作**：中断后更新未完成的工具 Part 状态为 `aborted`

### D9: 中断后消息处理

中断发生时进行适当的消息处理：
- 创建 SystemMessage（role: 'system', kind: 'abort'）记录中断事件
- 将未完成的 ToolPart 状态更新为 `aborted`
- 保留对话上下文，允许用户继续后续对话

### D10: 发布中断相关事件

通过 Bus 发布中断相关事件：
- `Lifecycle.Event.AbortRequested`：收到中断请求时发布（用户触发 cancel）
- `Lifecycle.Event.Aborted`：中断清理完成后发布

### D11: 子代理执行支持

支持子代理的独立执行，实现上下文隔离：
- 接受 `parentSessionId` 和 `isSubagent` 参数标识子代理执行
- 子代理模式下调用 `Context.assemble(sessionId, directory, true)` 不加载父 Memory
- 子代理使用独立的 maxSteps（默认 60）和 timeout（默认 10 分钟）
- 子代理中断时更新对应的 SubtaskPart 状态和 terminationReason

**中断行为差异**：
- 单击 Ctrl+C：只中断主代理当前操作，子代理继续运行
- 双击 Ctrl+C（500ms 内）：中断主代理并终止所有子代理

详见 `docs/agents/context-isolation.md`

---

## 四、Non-Duties（非职责）

### N1: 不负责消息持久化

本模块调用 Message 模块接口实时写入消息。Message 模块负责底层持久化实现，本模块不关心存储细节。

### N2: 不负责 LLM 通信细节

LLM API 调用、流式响应解析、错误重试等由 LLMClient 模块负责。本模块只调用 LLMClient 提供的接口。

### N3: 不负责工具执行细节

工具的发现、验证、权限检查、实际执行由 ToolScheduler 模块负责。本模块只调用 ToolScheduler 的 executeToolCalls 接口。

### N4: 不负责权限判断

工具执行前的权限检查和用户确认由 ToolScheduler 配合 ConfirmationBus 处理。本模块不直接处理权限逻辑。

### N5: 不负责 Agent 配置管理

Agent 的定义、加载、切换由 Agent 模块负责。本模块通过 AgentManager 接口获取当前 Agent 的配置（如 maxSteps、tools、permission）。

### N5.1: 不负责系统提示词组装

系统提示词的分层组装由 Agent 模块调用 SystemPrompt 模块完成。本模块通过 AgentManager.getSystemPrompt() 获取组装后的系统提示词。

### N6: 不负责 Session 生命周期

Session 的创建、销毁、多会话管理不在本模块职责范围内。本模块假设调用方已经准备好了有效的 sessionId。

### N7: 不负责消息历史存储

对话历史的底层存储由 Message 模块负责。本模块通过 Message 接口读取历史消息，执行过程中实时写入新消息。

---

## 五、设计约束与假设

### 约束

1. **依赖接口而非实现**：本模块依赖 LLMClient、ToolScheduler、Message、AgentManager 的接口，不依赖具体实现。
2. **单线程执行**：当前版本假设单线程环境，不处理多线程并发问题。
3. **同步完成语义**：AsyncGenerator 的完成表示整个循环执行完毕。

### 假设

1. 调用方保证传入有效的 sessionId
2. 依赖的模块接口已正确实现
3. CLI 层正确处理 SIGINT 信号并调用 `Lifecycle.cancel()`

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| LLMClient | 依赖 | 用于执行 LLM 调用 |
| ToolScheduler | 依赖 | 用于执行工具调用 |
| Message | 依赖 | 用于读取历史消息、写入新消息 |
| AgentManager | 依赖 | 用于获取 Agent 配置和系统提示词 |
| SystemPrompt | 间接依赖 | 通过 AgentManager 间接使用 |
| ConfirmationBus | 间接依赖 | 通过 ToolScheduler 间接交互 |
| Session | 被依赖 | Session 模块可能调用本模块执行请求 |
| SubagentExecutor | 被依赖 | 子代理执行时调用本模块 |
| CLI/UI | 被依赖 | 用户界面层调用本模块并消费事件 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
