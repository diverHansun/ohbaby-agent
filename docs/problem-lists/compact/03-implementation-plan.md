# Compact 模块实施与优化方案

## 0. 设计原则

| 原则 | 具体含义 | 反面案例（避免） |
|------|----------|-----------------|
| **KISS** | 每个修复独立、最小化，不引入不必要的抽象 | 为 compact 重试造一个通用重试框架 |
| **SRP** | token 估算只负责估算，compact 只负责压缩，重试只负责重试 | Phase 3.4 的 `isContextOverflowError` 复用 Phase 5.3 的 pattern 列表（先实现 5.3 再 3.4） |
| **DRY** | 竞品已验证的最佳实践直接复用（见 02 文档） | 重新设计已有成熟方案的提示词结构 |
| **YAGNI** | 暂不实现 post-compact re-injection（P3），先修致命 BUG | 在 BUG #1 未修复前就去实现 post-compact re-injection |
| **Fail-safe** | compact 失败不应阻塞用户操作 | circuit breaker 触发后直接丢弃用户请求 |
| **渐进式** | P0 → P1 → P2 → P3，每个 Phase 可独立交付和回滚 | 一次 PR 包含 5 个 Phase 的改动 |

## 0.1 本轮范围：方案 B（稳定版一轮交付）

本轮目标是把 compact 从“会失效”推进到“稳定可用且可验证”，但不做完整架构迁移：

**本轮包含：**

1. stale usage anchor 修复，并覆盖已 compact session 的兼容路径。
2. `/connect` metadata probe 自动探测 context window。
3. context summary 在发送给 LLM 时投影为 user-wrapped `<context_summary>`。
4. 压缩提示词升级。
5. empty summary retry 与 inflated summary aggressive retry。
6. 单元测试、真实 ZenMux/Kimi e2e、子代理审核。

**本轮不包含：**

- `tokenCountCoveredMessageCount` 长期架构迁移。
- microcompact。
- post-compact file re-injection。
- 完整 context overflow fallback/circuit breaker。

---

## 1. Phase 1：修复致命 BUG（低垂果实）

### 1.1 修复 Usage Anchor 过期

**目标：** compact 后，保留消息中的 stale usage anchor 不再污染 token 估算。

**方案 A（推荐）：compact 后清理保留消息 tokenUsage + 估算层 summary boundary 防御**

真实调用路径中，`estimateContextTokens()` 通常接收到的是 `getActiveHistory()` 过滤后的 history，已 compacted 的旧 part 不会出现。因此只检查“anchor 前是否存在 compacted part”不够。推荐双保险：

1. `summarizeHistory()` 成功创建 summary 并标记旧消息后，清理保留消息里的 `metadata.tokenUsage`。
2. `estimateContextTokens()` 在发现 latest context summary 后，跳过创建时间早于该 summary 的 usage anchor。

```typescript
// context-manager.ts
async function clearStaleTokenUsageAfterSummary(input: {
  readonly rawHistory: readonly MessageWithParts[];
  readonly compressedMessageIds: ReadonlySet<string>;
  readonly summaryCreatedAt: number;
}) {
  for (const message of input.rawHistory) {
    if (input.compressedMessageIds.has(message.info.id)) continue;
    if (message.info.time.created > input.summaryCreatedAt) continue;

    for (const part of message.parts) {
      if (part.metadata?.tokenUsage) {
        const { tokenUsage: _tokenUsage, ...metadata } = part.metadata;
        await options.messageManager.updatePart(part.id, { metadata });
      }
    }
  }
}
```

```typescript
// token-estimation.ts，兼容历史上已经 compact 但未清理 metadata 的 session
function findLatestUsageAnchor(
  history: readonly MessageWithParts[],
): { readonly index: number; readonly tokens: number } | undefined {
  const latestSummaryCreatedAt = latestContextSummaryCreatedAt(history);

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const usage = message.parts
      .map((part) => readTokenUsage(part.metadata))
      .find((candidate): candidate is TokenUsageMetadata => candidate !== undefined);

    if (usage) {
      if (
        latestSummaryCreatedAt !== undefined &&
        message.info.time.created < latestSummaryCreatedAt
      ) {
        continue;
      }
      return { index, tokens: usage.totalTokens };
    }
  }
  return undefined;
}
```

**为什么要双保险：**

- 清理 metadata 是根治：新 compact 后不再把旧 API usage 当作当前上下文。
- summary boundary 检测是兼容：用户已有 session 可能已经 compact 过但没有被清理。
- 后续 compact 之后产生的新 assistant response 仍可作为 fresh anchor，因为它的 `createdAt` 晚于最新 summary。

**注意：** 清理只在 summary 成功并准备提交 compact 状态后执行。summary 生成失败或 inflated 且最终放弃时，不应修改任何历史消息。

### 1.2 修复模型上下文窗口检测

**目标：** `/connect` 配置新模型时使用 `baseUrl` 与 API key 静默探测 context window；探测成功覆盖用户填写值，探测失败不报错。

**目标优先级：**

1. 探测成功：使用探测到的值，`contextWindowSource = "detected"`。
2. 探测失败且用户填写了 `--context-window`：使用用户填写值，`contextWindowSource = "user"`。
3. 探测失败且用户未填写：使用 `128_000`，`contextWindowSource = "default"`。
4. 返回结果包含 `contextWindowSource`，前端 UI 不展示该字段；探测失败发轻量 warning，不作为 error。

```typescript
type ContextWindowSource = "detected" | "user" | "default";

interface ProbeContextWindowResult {
  readonly contextWindowTokens?: number;
  readonly warning?: string;
}

async function resolveContextWindow(input): Promise<{
  readonly contextWindowTokens: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly warning?: string;
}> {
  const detected = await probeContextWindowFromMetadata(input);
  if (detected.contextWindowTokens !== undefined) {
    return {
      contextWindowTokens: detected.contextWindowTokens,
      contextWindowSource: "detected",
    };
  }
  if (input.contextWindowTokens !== undefined) {
    return {
      contextWindowTokens: input.contextWindowTokens,
      contextWindowSource: "user",
      warning: detected.warning,
    };
  }
  return {
    contextWindowTokens: 128_000,
    contextWindowSource: "default",
    warning: detected.warning,
  };
}
```

**探测 endpoint：**

| 接口类型 | URL | Headers |
|----------|-----|---------|
| Anthropic-compatible | `{baseUrl}/v1/models` | `x-api-key`, `anthropic-version: 2023-06-01` |
| OpenAI-compatible | `{baseUrl}/models` | `Authorization: Bearer <apiKey>` |

`baseUrl` 拼接必须处理已包含 `/v1`、`/v1/messages`、尾部 slash 等情况，避免生成 `/v1/v1/models`。

**字段解析：**

可接受字段：`context_length`、`contextWindow`、`context_window`、`context_window_tokens`、`max_input_tokens`、`max_context_tokens`。

不可接受字段：`max_tokens`、`maxOutputTokens`、`output_token_limit`。这些通常表示输出上限，不是上下文窗口。

**已验证目标：**

- ZenMux Anthropic endpoint 对 `moonshotai/kimi-k2.6` 返回 `context_length: 262144`。
- Kimi 官方文档确认 Kimi K2.6 为 256K context。

### 1.3 Context Summary LLM 投影兼容

**目标：** summary 在持久层保持 synthetic assistant message，发送给 LLM 时投影为 user-wrapped context block，避免 Anthropic-compatible 代理把首条 assistant 误解为不自然历史或 prefill。

```typescript
// serializer.ts
function serializeMessageForLlm(message: MessageWithParts): ChatCompletionMessage[] {
  if (isSummaryMessage(message)) {
    const summary = textContentFromParts(message.parts.filter(isActivePart)).trim();
    if (summary === "") return [];
    return [
      {
        role: "user",
        content: `<context_summary>\n${summary}\n</context_summary>`,
      },
    ];
  }
  // existing role-specific serialization
}
```

**已验证：**

- ZenMux + `moonshotai/kimi-k2.6` 对首条 assistant summary 请求可返回，但输出出现重复 marker。
- user-wrapped `<context_summary>` 请求返回精确 marker，兼容性更好。

---

## 2. Phase 2：改进压缩提示词

### 2.1 新提示词设计

综合 opencode、kimi-code、claude-code 的最佳实践：

**System prompt：**
```
You are a context summarization assistant for coding sessions.

Read the conversation history below and create a concise summary that another
coding agent can use to continue the work. The summary should preserve essential
technical details while being significantly shorter than the original.

Do not continue the conversation. Do not answer questions from the conversation.
Do not mention that you are summarizing or compacting context.
Respond in the same language as the conversation.
```

**User prompt：**
```
Create a concise context checkpoint from the conversation history above.

## Compression Rules

- Target: compress to at most 30% of the original length
- Use terse bullets, not prose paragraphs
- Preserve exact file paths, function names, command names, and error messages
- Remove intermediate attempts — keep only final working versions
- Omit resolved errors unless the resolution pattern is important
- Preserve all non-tool user intent; keep short user messages verbatim, but summarize very long pasted logs/code while preserving key paths, commands, errors, and constraints

## Output Format (keep this exact structure)

## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]
### In Progress
- [current work or "(none)"]
### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
1. [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

## User Intent & Feedback
- [all non-tool user intent, constraints, corrections, and feedback; quote short critical messages verbatim]
```

### 2.2 提示词改进点

| 改进 | 来源 | 理由 |
|------|------|------|
| "Respond in the same language" | opencode | 多语言支持 |
| "Do not mention summarizing" | opencode | 避免元信息污染 |
| "Target: compress to at most 30%" | 新增 | 量化压缩力度 |
| "terse bullets, not prose" | opencode | 明确格式要求 |
| "Remove intermediate attempts" | kimi-code | 减少冗余 |
| "User Intent & Feedback" section | kimi-code + claude-code | 保留用户意图，同时避免超长 pasted content 膨胀 |
| "Relevant Files" section | opencode | 文件路径是编码任务的关键 |
| No-tools 声明 | kimi-code + claude-code | 防止 summary 中产生 tool 调用 |

### 2.3 增量更新支持（可选，Phase 3）

参考 opencode 的 `<previous-summary>` 机制：

```typescript
// compression-prompt.ts
export const INCREMENTAL_UPDATE_PROMPT = `Update the anchored summary below using the conversation history above.
Preserve still-true details, remove stale details, and merge in the new facts.

<previous-summary>
{previousSummary}
</previous-summary>

{SUMMARY_TEMPLATE}`;
```

---

## 3. Phase 3：增加本轮重试与容错

### 3.1 Inflation Retry

当 summary 未通过 inflation check 时，用更激进的提示词重试一次：

```typescript
// context-manager.ts - summarizeHistory()
const AGGRESSIVE_COMPRESSION_PROMPT = `...
CRITICAL: The previous summary was too long. Compress aggressively:
- Maximum 15% of original length
- Only keep: Goal, Current Progress, Next Steps, Critical Files
- Omit all completed tasks that are no longer relevant
`;

let compression = await summarizeOnce(historyToCompress, COMPRESSION_PROMPT);
if (compression.status === "inflated") {
  compression = await summarizeOnce(historyToCompress, AGGRESSIVE_COMPRESSION_PROMPT);
}
```

### 3.2 Empty Summary Retry

```typescript
// prompt-context.ts - createContextSummaryClient()
const MAX_RETRIES = 2;
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  // ... stream and accumulate
  if (trimmed !== "") return trimmed;
  if (attempt < MAX_RETRIES) continue; // retry
}
throw new Error("Context compact summary was empty after retries");
```

### 3.3 本轮暂缓：Circuit Breaker

Circuit breaker 留到下一轮。原因：本轮先修“compact 成功时估算仍不下降”和“summary 太弱/空 summary”两个直接问题；circuit breaker 需要定义 per-session 失败状态、重置时机和 UI 提示，属于 P2。

### 3.4 本轮暂缓：Context Overflow Fallback

完整 overflow fallback 留到下一轮。原因：需要修改 lifecycle 的 LLM 调用重试路径，处理当前 user turn 重放、工具调用副作用和 abort signal，风险高于本轮目标。
## 4. Phase 4：Token 估算改进

### 4.1 分层 Token 跟踪（参考 kimi-code）

引入 `tokenCountCoveredMessageCount` 机制：

```typescript
// token-estimation.ts
interface TokenEstimationState {
  readonly anchorTokens: number;       // 来自最近 API 响应的真实值
  readonly coveredMessageCount: number; // 真实值覆盖到哪条消息
  readonly pendingTokens: number;       // 新增消息的估算值
}

function estimateContextTokens(history, state): number {
  return state.anchorTokens + estimatePendingTokens(
    history.slice(state.coveredMessageCount),
  );
}
```

### 4.2 ASCII/Non-ASCII 加权估算

当前 ohbaby-agent 的 `estimateTokensForText()` 已经实现了 ASCII/Non-ASCII 加权（0.25/1.3），这比 opencode 的简单 chars/4 更精确。保持不变。

---

## 5. Phase 5：高级特性（可选）

### 5.1 Post-Compact File Re-injection

参考 claude-code，compact 后重新注入最近读取的关键文件：

```typescript
// 新增：post-compact-reinjection.ts
const MAX_FILES_TO_RESTORE = 3;
const TOKEN_BUDGET = 20_000;
const MAX_TOKENS_PER_FILE = 5_000;

async function reInjectRecentFiles(
  history: readonly MessageWithParts[],
  tokenCounter: TokenCounter,
): Promise<string> {
  const fileOps = extractFileOps(history);
  const readFiles = fileOps.readFiles.slice(0, MAX_FILES_TO_RESTORE);
  // ... 读取文件内容，截断到 MAX_TOKENS_PER_FILE
}
```

### 5.2 Microcompact（工具输出清理）

参考 claude-code 的 microcompact，在 compact 前先清理旧的工具输出：

```typescript
// 新增：microcompact.ts
const KEEP_RECENT_TOOLS = 5;
const CLEARED_MESSAGE = "[Old tool result content cleared]";

function microcompact(history: MessageWithParts[]): MessageWithParts[] {
  const toolParts = collectToolParts(history);
  const toKeep = toolParts.slice(-KEEP_RECENT_TOOLS);
  const toClear = toolParts.filter((p) => !toKeep.includes(p));
  // ... 替换 toClear 的内容为 CLEARED_MESSAGE
}
```

### 5.3 Context Overflow Error 检测（扩展）

Phase 3.4 已定义基础 `OVERFLOW_PATTERNS`，此 Phase 扩展为完整的 provider 适配（参考 opencode 的 20+ 正则模式）：

```typescript
// provider-error.ts — 在 3.4 基础上扩展
const OVERFLOW_PATTERNS = [
  // 原有（3.4 实现）
  /prompt is too long/i,
  /exceeds the context window/i,
  /context[_ ]length[_ ]exceeded/i,
  /input is too long/i,
  /maximum context length/i,
  /model_context_window_exceeded/i,
  // Phase 5.3 新增
  /input token count.*exceeds the maximum/i,  // Google Gemini
  /this request's token count.*exceeds this model's maximum/i,  // OpenAI
  /requested token count exceeds the model's maximum/i,  // Bedrock
  /too many tokens/i,
];

export function isContextOverflowError(error: unknown): boolean {
  const message = errorToMessage(error);
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}
```

**注意：** 如果 Phase 3.4 先于 5.3 实现，`OVERFLOW_PATTERNS` 应设计为开放数组，允许后续 Phase 追加 pattern 而无需修改 `isContextOverflowError` 函数体。

---

## 6. 实施优先级

### 6.1 Phase-Priority 映射

```
P0 (致命，立即修)     → Phase 1.1, 1.2, 1.3
P1 (重要，本迭代)     → Phase 2, 3.1, 3.2
P2 (下迭代)           → Phase 3.3, 3.4, 4
P3 (增强，远期)       → Phase 5.1, 5.2, 5.3
```

### 6.2 依赖关系

```
Phase 1.1 ──────────────────────────────→ (无依赖，独立)
Phase 1.2 ──────────────────────────────→ (无依赖，独立)
Phase 1.3 ──────────────────────────────→ (无依赖，独立)
Phase 2 ──── (无依赖，独立)
Phase 3.1 ── 依赖 Phase 2（需新提示词区分 normal/aggressive）
Phase 3.2 ── (无依赖，独立)
Phase 3.3 ── (无依赖，独立)
Phase 3.4 ── 依赖 Phase 1.1（需 compact 能正常工作才能 fallback）
Phase 4 ──── 依赖 Phase 1.1（替换旧 anchor 逻辑）
Phase 5.1 ── 依赖 Phase 2（compact 后 re-injection 需等 compact 稳定）
Phase 5.2 ── (无依赖，独立)
Phase 5.3 ── 依赖 Phase 3.4（在 3.4 的基础 pattern 上扩展）
```

### 6.3 工作量与收益

| Phase | 内容 | 工作量 | 收益 | 优先级 |
|-------|------|--------|------|--------|
| 1.1 | 清理 stale usage anchor + summary boundary 防御 | 2h | 解决 "113K -> 113K" 致命问题 | P0 |
| 1.2 | `/connect` metadata probe context window | 2h | Kimi/ZenMux 自动识别 256K，消除静默 fallback | P0 |
| 1.3 | context summary user-wrapped LLM 投影 | 1h | 提升 Anthropic-compatible 兼容性 | P0 |
| 2 | 改进压缩提示词 | 3h | 提高压缩质量和效率 | P1 |
| 3.1 | Inflation retry | 1h | 提高 compact 成功率 | P1 |
| 3.2 | Empty summary retry | 0.5h | 提高鲁棒性 | P1 |
| 3.3 | Circuit breaker | 0.5h | 防止无限失败循环 | P2 |
| 3.4 | Context overflow fallback | 2h | 最后一道防线 | P2 |
| 4 | 分层 token 跟踪 | 3h | 长期准确性 | P2 |
| 5.1 | Post-compact file re-injection | 3h | 恢复关键上下文 | P3 |
| 5.2 | Microcompact | 2h | 减少 compact 频率 | P3 |
| 5.3 | Overflow error 检测 | 1h | 多 provider 兼容 | P3 |
