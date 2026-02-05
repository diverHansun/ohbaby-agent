# context 模块 goals-duty.md

本文档定义 `context` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：context 模块负责组装、压缩和管理传递给 LLM 的上下文信息，确保对话不会超出 token 限制，并为上下文扩展提供统一入口。

**如果没有这个模块**：
- 长对话会话超出 LLM 的 token 限制，导致请求失败
- 压缩逻辑分散在 lifecycle 中，导致职责膨胀
- 未来增加 IDE 上下文、RAG 等新上下文源时，没有统一入口
- 无法提供 `/compact` 命令给用户主动管理上下文

---

## 二、Design Goals（设计目标）

### G1: 统一上下文组装

从多个来源（Memory、SystemPrompt、Message 历史）收集上下文，组装成 LLM 可用的格式。提供统一的入口，屏蔽底层数据源的差异。

### G2: 自动上下文压缩

当上下文使用量达到阈值（85% context limit）时，自动触发压缩，避免请求失败。压缩过程对用户透明，不中断对话流程。

### G3: 手动压缩命令支持

提供 `/compact` 命令支持，允许用户主动触发上下文压缩。用户可以在感觉对话变慢时主动清理上下文。

### G4: Prune 策略

支持 Prune 策略，自动丢弃旧的 tool output 以释放上下文空间。Prune 不删除数据，只标记为已压缩，保持历史完整性。

### G5: 可扩展的上下文源

为未来的上下文源扩展预留接口（如 IDE 上下文、RAG 结果），但当前版本只实现 Memory + History。

### G6: 简单可靠

遵循 KISS 原则，避免过度设计。压缩和 Prune 策略使用成熟的阈值配置，减少运行时决策复杂度。

---

## 三、Duties（职责）

### D1: 上下文组装

从多个来源收集上下文并组装：
- 调用 Memory 模块获取记忆内容
- 调用 SystemPrompt 模块获取系统提示词
- 调用 Message 模块获取历史消息
- 合并成 LLM 可用的请求格式

**核心接口**：`Context.assemble(sessionId, directory, isSubagent?): Promise<AssembledContext>`

**子代理模式**（`isSubagent = true`）：
- 不加载 Memory（子代理不继承父代理的 Memory）
- 不继承父 Session 的历史消息
- 使用子代理专属的 SystemPrompt
- 消息流与主代理完全隔离

详见 `docs/agents/context-isolation.md`

### D2: Token 使用量计算

调用 tokenCounting 模块计算当前上下文的 token 使用情况：
- 估算组装后的上下文 token 数
- 与模型的 context limit 对比
- 返回使用率和剩余空间

**核心接口**：`Context.getUsage(assembledContext, model): ContextUsage`

### D3: 自动压缩触发

监控上下文使用量，达到阈值时自动触发压缩：
- 阈值：85% 的 context limit
- 在 lifecycle 调用 assemble 后检查
- 触发后执行压缩流程

**核心接口**：`Context.shouldCompress(usage): boolean`

### D4: 上下文压缩

调用 LLM 将旧历史压缩成结构化摘要：
- 保留最近 30% 的历史（基于 token）
- 将更早的历史交给 LLM 总结成 XML snapshot
- 创建 summary Message 持久化压缩结果

**核心接口**：`Context.compress(sessionId, force): Promise<CompressionResult>`

### D5: Prune 策略执行

自动丢弃旧的 tool output 以释放空间：
- 保护最近的 tool output（约 40k tokens）
- 对更早的 tool output 标记 `time.compacted` 时间戳
- 不删除 Part，只标记，保持历史完整

**核心接口**：`Context.prune(sessionId): Promise<PruneResult>`

### D6: 提供压缩提示词

定义压缩时使用的提示词模板：
- 使用 Gemini 风格的结构化 XML 格式
- 包含 overall_goal、key_knowledge、file_system_state、recent_actions、current_plan

### D7: 事件发布

通过 Bus 发布上下文相关事件：
- `Context.Event.Compressed`：压缩完成后发布
- `Context.Event.Pruned`：Prune 完成后发布

---

## 四、Non-Duties（非职责）

### N1: 不负责 Memory 文件的 CRUD

Memory 文件（IRIS.md）的读写由 Memory 模块负责。Context 只调用 `Memory.load()` 获取内容。

### N2: 不负责 SystemPrompt 构建

系统提示词的模板和构建逻辑由 SystemPrompt 模块负责。Context 只调用其接口获取内容。

### N3: 不负责 Message 存储

消息的存储和 CRUD 由 Message 模块负责。Context 只调用接口获取历史和更新 Part。

### N4: 不负责 Token 估算算法

Token 的估算算法由 tokenCounting 模块负责。Context 只调用接口获取估算结果。

### N5: 不负责 LLM 调用

实际的 LLM 调用由 LLMClient 模块负责。Context 只调用其接口执行压缩总结。

### N6: 不负责执行循环协调

对话的执行流程由 lifecycle 模块负责。Context 只提供上下文组装和压缩接口。

### N7: 不负责 toModelMessages 过滤

过滤已压缩 tool output 的逻辑由 Message 模块的 `toModelMessages()` 函数负责。Context 只负责标记 compacted。

### N8: 不实现 IDE 上下文和 RAG 集成

当前版本不实现 IDE 上下文和 RAG 集成。这些功能预留接口，在后续版本实现。

---

## 五、设计约束与假设

### 约束

1. **依赖 Memory 模块**：调用 `Memory.load()` 获取记忆内容
2. **依赖 Message 模块**：调用 `getMessages()` 获取历史，`updatePart()` 标记 compacted，`updateMessage()` 创建 summary
3. **依赖 tokenCounting 模块**：调用其接口进行 token 估算
4. **依赖 LLMClient 模块**：调用其接口执行压缩总结
5. **依赖 Bus 模块**：发布上下文相关事件
6. **自动压缩阈值**：固定为 85%，不可运行时配置（MVP）
7. **保留比例**：固定为 30%，不可运行时配置（MVP）

### 假设

1. tokenCounting 模块的估算结果足够准确，误差在可接受范围内
2. LLM 能够有效地将历史压缩成结构化摘要
3. 同一 sessionId 在同一时刻只有一个压缩操作在执行
4. 压缩后的 summary 能够有效保留上下文信息

---

## 六、与其他模块的关系

| 模块 | 代码位置 | 关系 | 调用接口 | 说明 |
|------|----------|------|----------|------|
| Memory | `src/core/memory/` | 依赖 | `Memory.load()` | 获取记忆内容 |
| Message | `src/core/message/` | 依赖 | `getMessages()`, `updatePart()`, `updateMessage()` | 获取历史、标记 compacted、创建 summary |
| tokenCounting | `src/services/llm-model/tokenCounting/` | 依赖 | `estimateTokens()`, `getLimit()` | Token 估算和限额查询 |
| LLMClient | `src/core/llm-client/` | 依赖 | `generateContent()` | 执行压缩总结 |
| SystemPrompt | `src/core/system-prompt/` | 依赖 | `getSystemPrompt()` | 获取系统提示词 |
| lifecycle | `src/core/lifecycle/` | 被依赖 | `Context.assemble()`, `Context.compress()` | lifecycle 调用 Context 接口 |
| Commands | `src/commands/` | 被依赖 | `Context.compress({ force: true })` | `/compact` 命令调用 |
| Bus | `src/bus/` | 依赖 | `Bus.publish()` | 发布上下文事件 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] 与 Memory、Message、tokenCounting、LLMClient 的关系明确
- [x] Prune 策略只标记不删除，保持历史完整性
