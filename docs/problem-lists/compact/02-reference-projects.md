# 业界 Compact 机制借鉴

## 1. 项目概览

| 项目 | 语言 | 架构特点 | Compact 层数 |
|------|------|----------|---------------|
| opencode | TypeScript | 单体 CLI | 2 层（prune + compress） |
| kimi-code | TypeScript | monorepo (agent-core + node-sdk + TUI) | 2 层（compress + overflow fallback） |
| claude-code | TypeScript | 单体 CLI | 5 层（session memory + reactive + traditional + microcompact + API-level） |

---

## 2. Token 估算机制对比

### 2.1 opencode：真实 API usage + 简单启发式

```typescript
// opencode/src/util/token.ts
const CHARS_PER_TOKEN = 4;
export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN));
}
```

**overflow 检测使用真实 API 返回值：**
```typescript
// opencode/src/session/overflow.ts
const count = input.tokens.total
  || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write;
return count >= usable(input);
```

**关键设计：** 不存在"usage anchor"概念。每次 LLM 调用后直接用 API 返回的 token 数判断是否溢出。估算仅用于预判断（pruning 和 tail selection）。

### 2.2 kimi-code：分层 token 跟踪

```typescript
// kimi-code/src/utils/tokens.ts
export function estimateTokens(text: string): number {
  let asciiCount = 0, nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) asciiCount++;
    else nonAsciiCount++;
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}
```

**两层 token 跟踪（ContextMemory）：**
1. `tokenCount` — 来自最近一次 LLM 响应的 `usage` 字段（真实值）
2. `tokenCountWithPending` — 真实值 + 自上次 LLM 调用后新增消息的估算值

```typescript
get tokenCountWithPending(): number {
  const pendingMessages = this._history.slice(this.tokenCountCoveredMessageCount);
  return this._tokenCount + estimateTokensForMessages(project(pendingMessages));
}
```

**关键设计：** `tokenCountCoveredMessageCount` 记录了真实 token 数覆盖到哪条消息。新增消息用启发式估算追加。**不会出现 anchor 过期问题**，因为真实值总是基于最新的 LLM 响应。

### 2.3 claude-code：回溯式 token 估算

```typescript
// claude-code/src/utils/tokens.ts
function tokenCountWithEstimation(messages) {
  // 从最后一条消息向前回溯，找到最近的带 API usage 的 assistant 消息
  // 处理并行 tool calls：回溯到同一 message.id 的兄弟记录
  // 返回：API usage total + 后续消息的粗略估算
}
```

**关键设计：** 与 kimi-code 类似，但增加了并行 tool calls 的处理。始终从最新消息回溯，确保使用最新的真实 token 数。

### 2.4 本节结论

ohbaby-agent 的问题详见 [01-problem-analysis.md BUG #1](./01-problem-analysis.md#21-bug-1致命usage-anchor-过期导致-token-估算失真)。核心差异：三家竞品均通过"始终使用最新 API 真实值 + 启发式追加"避免 stale anchor，而 ohbaby-agent 的 `findLatestUsageAnchor()` 缺少 compacted 检测导致过期值被复用。

---

## 3. 上下文窗口大小获取

### 3.1 opencode：依赖 provider metadata

```typescript
// opencode/src/session/overflow.ts
const context = input.model.limit.context;  // 从 provider 模型定义获取
```

模型限制直接从 provider 的模型定义中获取，不需要手动配置。

### 3.2 kimi-code：多层解析 + UNKNOWN_CAPABILITY fallback

```typescript
// kimi-code/src/providers/runtime-provider.ts
const providerCapability = capabilityProvider.getCapability?.(provider.model) ?? UNKNOWN_CAPABILITY;
// UNKNOWN_CAPABILITY.max_context_tokens = 0 → 不触发自动 compact
```

**关键设计：** 当 `max_context_tokens = 0` 时，`shouldCompact()` 返回 `false`（不自动 compact）。但如果 API 返回 `APIContextOverflowError`，仍然触发 reactive compact 作为 fallback。

### 3.3 claude-code：模型 capability registry + 环境变量覆盖

```typescript
// claude-code/src/utils/context.ts
// 解析顺序：环境变量 > [1m] 后缀 > model capability > 1M beta > 默认 200K
```

支持 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 环境变量覆盖，`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 测试覆盖。

### 3.4 分析与建议

三种获取上下文窗口的方式各有优劣：

- **opencode 方式**依赖 provider metadata，对第三方 provider 不友好
- **kimi-code 方式**通过 capability probe，未知时标记为 0 并依赖 overflow fallback
- **claude-code 方式**通过 registry + 环境变量覆盖，最灵活但维护成本高

ohbaby-agent 当前的内置 profile 前缀匹配 + 128K fallback 与 claude-code 的 registry 思路最接近，但缺少三个关键能力：

1. 不访问 provider metadata endpoint。
2. fallback 用户不可见，且不会持久化到 `model.json`。
3. 未知模型无提示。

具体修复方案见 [03-implementation-plan.md Phase 1.2](./03-implementation-plan.md#12-修复模型上下文窗口检测)。

### 3.5 本次调研结论：metadata probe 可作为 `/connect` 主路径

针对当前问题模型已做调研和最小 e2e：

- Kimi 官方文档：`kimi-k2.6`、`kimi-k2.5`、`kimi-k2-0905-preview` 等模型提供 256K context window。
- ZenMux Anthropic endpoint：`GET https://zenmux.ai/api/anthropic/v1/models` 返回模型列表；`moonshotai/kimi-k2.6` 的 metadata 包含 `context_length: 262144`。
- Anthropic Models API：模型列表返回字段中包括 `max_input_tokens`（最大输入上下文窗口）和 `max_tokens`（最大输出参数值）。两者语义不同，解析时不能把 `max_tokens` 当作 context window。

因此本轮实现应将 `/connect` metadata probe 作为主路径：

| 接口类型 | 探测 URL | 鉴权头 | 可接受字段 |
|----------|----------|--------|------------|
| Anthropic-compatible | `{baseUrl}/v1/models` | `x-api-key`, `anthropic-version` | `context_length`, `context_window`, `context_window_tokens`, `max_input_tokens`, `max_context_tokens` |
| OpenAI-compatible | `{baseUrl}/models` | `Authorization: Bearer ...` | `context_length`, `context_window`, `context_window_tokens`, `max_input_tokens`, `max_context_tokens` |

解析必须保守：只接受明确表达上下文窗口的字段；`max_tokens`、`output_token_limit` 等输出限制字段不能用于 context window。

---

## 4. 压缩提示词对比

### 4.1 opencode 提示词

**System prompt：**
```
You are an anchored context summarization assistant for coding sessions.
Summarize only the conversation history you are given. The newest turns may be kept
verbatim outside your summary, so focus on the older context that still matters.
If the prompt includes a <previous-summary> block, treat it as the current anchored
summary. Update it with the new history by preserving still-true details, removing
stale details, and merging in the new facts.
Do not answer the conversation itself. Do not mention that you are summarizing.
Respond in the same language as the conversation.
```

**User prompt 结构：**
```
## Goal / ## Constraints & Preferences / ## Progress (Done/In Progress/Blocked)
## Key Decisions / ## Next Steps / ## Critical Context / ## Relevant Files

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers.
- Do not mention the summary process.
```

**亮点：**
- **增量更新**：支持 `<previous-summary>` 块，后续 compact 只需更新而非重建
- **"terse bullets, not prose paragraphs"**：明确要求简洁
- **"Respond in the same language as the conversation"**：多语言支持
- **"Do not mention that you are summarizing"**：避免元信息污染

### 4.2 kimi-code 提示词

**核心指令：**
```
Output text only. DO NOT CALL ANY TOOLS. Calling tools will be rejected.
You already have all the information you need. You have only one chance.
```

**压缩优先级（按顺序）：**
1. Current Task State: 当前正在做什么
2. Errors & Solutions: 所有遇到的错误及解决方案
3. Code Evolution: 只保留最终工作版本（删除中间尝试）
4. System Context: 项目结构、依赖、环境
5. Design Decisions: 架构选择及理由
6. TODO Items: 未完成任务和已知问题

**输出结构：**
```
## Current Focus / ## Environment / ## Completed Tasks / ## Active Issues
## Code State（关键文件 + <20 lines 代码片段）
## Important Context / ## All User Messages
```

**亮点：**
- **"You have only one chance"**：强调一次性输出质量
- **明确的压缩优先级**：指导模型在有限空间内做取舍
- **"<20 lines" 代码限制**：防止 summary 膨胀
- **"remove intermediate attempts"**：明确要求删除中间过程
- **"All User Messages"**：保留所有用户消息（非 tool result）

### 4.3 claude-code 提示词

**No-tools 前言（所有 compact 变体共用）：**
```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and will waste your only turn.
Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

**9-section 结构：**
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections（含完整代码片段）
4. Errors and fixes（特别关注用户反馈）
5. Problem Solving
6. All user messages（非 tool result 的所有用户消息）
7. Pending Tasks
8. Current Work（最近工作的详细描述）
9. Optional Next Step（含直接引用最近对话）

**分析阶段（analysis block）：**
```
Before providing your precise summary, wrap your analysis in <analysis> tags:
1. Chronologically analyze each message and section
2. Double-check for technical accuracy and completeness
```

**后处理：** `formatCompactSummary()` 会剥离 `<analysis>` 块（作为草稿纸），只保留 `<summary>` 内容。

**亮点：**
- **analysis/summary 两阶段**：先分析再总结，提高质量
- **"include direct quotes from the most recent conversation"**：防止任务漂移
- **No-tools 前言 + 后语**：双重保障防止 tool 调用
- **Post-compact re-injection**：compact 后重新注入最近读取的文件（最多 5 个，每个 5K tokens）

### 4.4 提示词对比总结

| 维度 | opencode | kimi-code | claude-code | ohbaby-agent（当前） |
|------|----------|-----------|-------------|---------------------|
| 防 tool 调用 | 无（compaction agent 禁用所有 tools） | "DO NOT CALL ANY TOOLS" + "will be rejected" | "CRITICAL: TEXT ONLY" 前言 + 后语 | 无 |
| 压缩力度控制 | "terse bullets" | "<20 lines" 代码限制 | 无（但配合 post-compact re-injection） | 无 |
| 增量更新 | 支持 `<previous-summary>` | 不支持 | 不支持（但支持 partial compact） | 不支持 |
| 分析阶段 | 无 | 无 | `<analysis>` 块 | 无 |
| 用户消息保留 | 无专门 section | "All User Messages" | "All user messages" | 无 |
| 代码片段 | 无 | "<20 lines" | 完整代码片段 | 无 |
| 多语言 | "same language as conversation" | 无 | 无 | 无 |
| 元信息抑制 | "Do not mention summarizing" | 无 | 无 | 无 |

---

## 5. Compact 后消息替换机制

### 5.1 opencode：filterCompacted 过滤

旧消息不删除，通过 `filterCompacted()` 在构建 LLM 请求时过滤掉。Summary 作为 assistant 消息插入，compaction 请求作为 user 消息插入。

### 5.2 kimi-code：直接替换 history 数组

```typescript
applyCompaction(summary) {
  this._history = [
    { role: 'assistant', content: summary.summary, origin: { kind: 'compaction_summary' } },
    ...this._history.slice(summary.compactedCount),
  ];
}
```

直接替换整个 history 数组，旧消息被丢弃（但归档到 `_compactedHistory`）。

### 5.3 claude-code：boundary marker + 完整替换

```typescript
function buildPostCompactMessages(result) {
  return [
    result.boundaryMarker,      // SystemCompactBoundaryMessage
    ...result.summaryMessages,  // 用户消息格式的 summary
    ...(result.messagesToKeep ?? []),
    ...result.attachments,      // 文件、计划、技能附件
    ...result.hookResults,      // CLAUDE.md 等
  ];
}
```

插入 boundary marker，后续所有操作使用 `getMessagesAfterCompactBoundary()` 获取活跃消息。

### 5.4 本节结论

ohbaby-agent 使用 `isActivePart()` 过滤（`part.time?.compacted === undefined`），与 opencode 的 `filterCompacted` 思路一致。差距在于缺少 boundary marker 和 post-compact re-injection。详见 [01-problem-analysis.md BUG #4](./01-problem-analysis.md#24-bug-4设计缺陷compact-后未清理-stale-usage-anchor)。

### 5.5 Anthropic-compatible summary 投影

Anthropic 官方文档说明 Messages API 是无状态的，调用方每次发送完整历史；早期 turn 可以包含 synthetic assistant messages。但文档和 ZenMux Anthropic 文档都强调模型训练假设 user/assistant 轮次，且最后一条 assistant 会被当作续写前缀。

ohbaby-agent 当前做法是：context summary 在持久层保存为 synthetic assistant message，并在 active history 中提前到第一条。这对 OpenAI Chat Completions 通常可接受，但对 Anthropic-compatible 代理存在两类风险：

1. 第一条非-system message 是 assistant，可能被兼容层当作不自然的对话开头。
2. 如果 summary 位于末尾或兼容层合并角色，assistant 内容可能被当作 prefill 风格上下文。

本次用 ZenMux + `moonshotai/kimi-k2.6` 做最小 e2e：

| 形态 | 结果 |
|------|------|
| summary 作为首条 assistant | 请求成功，但输出 marker 出现重复 |
| summary 包成 user `<context_summary>` | 请求成功，输出精确 |

因此本轮采用“持久层不变、LLM 投影改变”的低风险方案：summary 仍存为 assistant synthetic message，`serializeForLlm()` 输出时转换为 `role: "user"` 的 `<context_summary>` block。

---

## 6. 重试与容错机制

### 6.1 opencode

- **PTL retry**：compact 请求本身超出上下文窗口时，截断最旧的消息组重试（最多 3 次）
- **Streaming retry**：流式传输失败时重试（最多 2 次）
- **Overflow replay**：compact 后重放上一条用户消息（去除媒体附件）
- **Context overflow 不重试**：正常对话的 context overflow 错误不重试，直接触发 compact

### 6.2 kimi-code

- **Generation retry**：网络/服务器错误重试（最多 3 次，指数退避 300ms-5s）
- **Empty summary retry**：空 summary 被视为可重试错误
- **Overflow fallback**：API 返回 context overflow 时强制触发 compact
- **Staleness detection**：compact 期间如果 history 被修改（如 undo），取消 compact
- **Compaction limit**：单轮最多 3 次 auto-compact

### 6.3 claude-code

- **PTL retry**：最多 3 次，按 API round-trip 分组截断
- **Streaming retry**：最多 2 次
- **Circuit breaker**：连续 3 次 auto-compact 失败后停止重试
- **Session memory fallback**：传统 compact 失败时尝试 session memory compact
- **Reactive compact**：紧急 compact（prompt-too-long 时触发）

### 6.4 本节结论

ohbaby-agent 在重试与容错机制上完全空白，与三家竞品差距最大。应从 PTL retry、circuit breaker、overflow fallback 三个方向补齐。详见 [03-implementation-plan.md Phase 3](./03-implementation-plan.md#3-phase-3增加重试与容错)。
