# Compact 模块问题与现状分析

## 1. 问题描述

### 1.1 用户报告的现象

当上下文窗口接近满载时，compact 机制未能有效压缩信息。具体表现为：

```
Context compacted: 113,350 -> 113,350 tokens
```

compact 前后的 token 数完全相同，说明压缩操作没有产生任何实际效果。

### 1.2 触发条件

- 使用 zenmux 代理的 kimi 2.6 模型（Anthropic-compatible 接口）
- 之前使用 zhipu（智谱）模型时 compact 正常工作
- 上下文窗口接近满载（约 113K tokens）

---

## 2. 根因分析

### 2.1 BUG #1（致命）：Usage Anchor 过期导致 token 估算失真

**位置：** `packages/ohbaby-agent/src/core/context/token-estimation.ts:12-35`

**机制：** `estimateContextTokens()` 使用"usage anchor"优化——在历史消息中查找最近一条带有 `tokenUsage` 元数据的 assistant 消息，用其 `totalTokens` 作为基准值，加上后续消息的估算 tokens。

```typescript
// token-estimation.ts
export function estimateContextTokens(history, tokenCounter) {
  const anchor = findLatestUsageAnchor(history);
  if (!anchor) {
    // 纯启发式估算（无 anchor 时）
    const tokens = tokenCounter.estimateTokens(serializeHistory(history));
    return { tokens, anchorTokens: 0, tailTokens: tokens, anchorIndex: -1 };
  }
  // 使用 anchor 的 totalTokens + 尾部消息估算
  const tailTokens = history.slice(anchor.index + 1)
    .reduce((sum, msg) => sum + tokenCounter.estimateTokens(serializeMessage(msg)), 0);
  return { tokens: anchor.tokens + tailTokens, ... };
}
```

**问题链：**

1. 用户与 kimi 2.6 对话多轮，某轮的 `tokenUsage.total_tokens = 113,350` 被写入该轮 assistant 消息的 metadata（由 `lifecycle.ts:748-758` 的 `toPartTokenUsageMetadata()` 完成）
2. Compact 触发，`summarizeHistory()` 将旧消息标记为 `compacted`
3. 但带有 usage anchor 的那条消息在"保留区"（最近 20K tokens 内），未被 compact
4. `assemble()` 重新计算 tokens 时，`findLatestUsageAnchor()` 仍然找到这个 anchor
5. 返回 `113,350 + tailTokens`——anchor 的 `totalTokens` 是 API 返回的**该轮次所有输入消息的总 token 数**，包含了已被压缩的旧消息
6. 结果：compact 前后的 `currentTokens` 完全相同 → **"113,350 -> 113,350"**

**实现细节补充：**

`assemble()` 实际使用的是 `getActiveHistory()` 后的 history；已 compacted 的 part 会被过滤掉。因此仅在 `estimateContextTokens()` 中检查“anchor 前面是否存在 compacted message”不足以覆盖真实路径。真实修复需要两层保护：

1. compact 成功后，清理保留消息中已过期的 `metadata.tokenUsage`，避免旧 anchor 继续进入 active history。
2. `estimateContextTokens()` 识别最新 context summary boundary；如果 anchor 的消息创建时间早于最新 summary 创建时间，则该 anchor 代表 summary 之前的请求，必须跳过。

**为什么 zhipu 模型没出问题：**

zhipu 的 API 可能不返回 `tokenUsage` 元数据（或返回格式不兼容 `readTokenUsage()` 的校验逻辑），导致 `findLatestUsageAnchor()` 返回 `undefined`，系统走纯启发式估算路径。纯启发式估算不依赖 anchor，compact 后重新序列化活跃历史，token 数自然下降。

**验证方法（测试用例）：**

```typescript
// 测试：compact 后 usage anchor 应被忽略或清除
describe("token-estimation: usage anchor staleness", () => {
  it("should NOT use stale anchor after compaction", () => {
    const history = [
      // 旧消息（将被 compact）
      createMessage("user", "old message 1"),
      createMessage("assistant", "old response 1"),
      // anchor 消息（在保留区，带有 tokenUsage metadata）
      createMessageWithTokenUsage("assistant", "response with usage", {
        promptTokens: 100000,
        completionTokens: 13350,
        totalTokens: 113350,
      }),
      // 新消息
      createMessage("user", "new message"),
    ];

    // 模拟 compact：标记前两条消息为 compacted
    const compactedHistory = markCompacted(history, [0, 1]);

    const result = estimateContextTokens(compactedHistory, tokenCounter);

    // BUG: 当前返回 113350 + tailTokens（错误）
    // 期望: 应该只估算活跃消息的 tokens（远小于 113350）
    expect(result.tokens).toBeLessThan(50000);
  });

  it("should detect anchor preceded by compacted messages", () => {
    const history = [
      createCompactedMessage("user", "old"),
      createCompactedMessage("assistant", "old"),
      createMessageWithTokenUsage("assistant", "anchor", {
        totalTokens: 113350,
      }),
      createMessage("user", "new"),
    ];

    const result = estimateContextTokens(history, tokenCounter);

    // anchor 之前存在 compacted 消息，说明 anchor 的 totalTokens 已过时
    // 应该跳过此 anchor，使用纯启发式估算
    expect(result.anchorIndex).toBe(-1);
  });
});
```

### 2.2 BUG #2（设计缺陷）：模型上下文窗口自动检测失效

**位置：**

- `packages/ohbaby-agent/src/services/llm-model/modelProfiles.ts:69-142`
- `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts:68-69`

**机制：** `/connect` 命令通过 `BUILTIN_PROFILE_RULES` 匹配模型前缀来获取上下文窗口大小。

```typescript
const BUILTIN_PROFILE_RULES = [
  { modelPrefix: "gpt-4.1", contextWindowTokens: 1_000_000, ... },
  { modelPrefix: "claude-", contextWindowTokens: 200_000, ... },
  { modelPrefix: "glm-4", contextWindowTokens: 128_000, ... },
  // ... 没有 kimi 前缀
];
```

**问题：** kimi 2.6 不在任何内置 profile 中。`resolve()` 走到 `fallbackProfile()`，返回 `DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000`。更关键的是，当前 `/connect` 并没有访问 provider metadata endpoint，所以不存在真正的“自动获取 context window”。

在 `apply-active-model-config.ts:68-69`：
```typescript
const resolvedContextWindowTokens =
  contextWindowTokens ?? (profile.source === "fallback" ? undefined : profile.contextWindowTokens);
```

由于 `profile.source === "fallback"`，`resolvedContextWindowTokens` 被设为 `undefined`，**不会持久化到 model.json**。运行时 token counter 使用 128K fallback。

**已验证事实（2026-06-09）：**

- Kimi 官方文档说明 `kimi-k2.6`、`kimi-k2.5` 等模型提供 256K context window。
- ZenMux Anthropic endpoint `GET https://zenmux.ai/api/anthropic/v1/models` 返回 `moonshotai/kimi-k2.6`，并包含 `context_length: 262144`。
- 因此 `/connect` 应将 metadata probe 提升为主路径，而不是仅依赖内置前缀匹配。

**目标解析优先级：**

1. metadata probe 成功：使用探测到的 context window，并覆盖用户填写值。
2. metadata probe 失败且用户填写了 `--context-window`：使用用户填写值。
3. metadata probe 失败且用户未填写：使用 `128_000`。
4. 返回结果包含内部字段 `contextWindowSource: "detected" | "user" | "default"`；前端 UI 不展示该字段，但探测失败时给轻量提示，不报错。

**影响：**
- 如果 kimi 2.6 实际上下文窗口不是 128K，compact 阈值计算就会出错
- 如果实际更小（如 64K），系统会在 109K（85% of 128K）才触发 compact，但模型在 64K 就已经满了
- 如果实际更大（如 256K），compact 触发太晚，浪费上下文空间

**旧行为复现：**

```typescript
describe("model profile: unknown model fallback", () => {
  it("should use fallback 128K for kimi model", () => {
    const registry = createModelProfileRegistry({ defaultProvider: "zenmux" });
    const profile = registry.resolve("kimi-2.6", "zenmux");

    // 当前行为：fallback 到 128K
    expect(profile.source).toBe("fallback");
    expect(profile.contextWindowTokens).toBe(128_000);
  });

  it("should NOT persist fallback context window to model.json", async () => {
    const result = await applyActiveModelConfig({
      provider: "zenmux",
      model: "kimi-2.6",
      // ...
    });

    // 当前行为：不持久化
    expect(result.contextWindowTokens).toBeUndefined();
  });
});
```

**本轮目标测试：**

```typescript
describe("applyActiveModelConfig: metadata context window", () => {
  it("should persist detected Kimi context window and override user input", async () => {
    mockProviderModels({
      data: [{ id: "moonshotai/kimi-k2.6", context_length: 262_144 }],
    });

    const result = await applyActiveModelConfig({
      provider: "anthropic-compatible",
      model: "moonshotai/kimi-k2.6",
      baseUrl: "https://zenmux.ai/api/anthropic",
      apiKey: "secret",
      contextWindowTokens: 128_000,
    });

    expect(result.contextWindowTokens).toBe(262_144);
    expect(result.contextWindowSource).toBe("detected");
  });

  it("should fall back to user value or 128K default without throwing on probe failure", async () => {
    mockProviderModelsFailure();

    await expect(applyActiveModelConfig({
      provider: "anthropic-compatible",
      model: "custom",
      baseUrl: "https://example.com/api",
      apiKey: "secret",
      contextWindowTokens: 64_000,
    })).resolves.toMatchObject({
      contextWindowTokens: 64_000,
      contextWindowSource: "user",
    });

    await expect(applyActiveModelConfig({
      provider: "anthropic-compatible",
      model: "custom",
      baseUrl: "https://example.com/api",
      apiKey: "secret",
    })).resolves.toMatchObject({
      contextWindowTokens: 128_000,
      contextWindowSource: "default",
    });
  });
});
```

### 2.3 BUG #3（设计缺陷）：压缩提示词缺乏力度控制

> **关联 BUG #4**：BUG #3 和 #4 的根源均为"compact 后缺乏后处理清理"——前者是提示词层面未指导模型充分压缩，后者是数据层面未清理 stale metadata。Phase 3 修复方案中两句相关代码相邻。

**位置：** `packages/ohbaby-agent/src/core/context/compression-prompt.ts`

**当前提示词（完整）：**

```
# SUMMARIZATION_SYSTEM_PROMPT
You are a context summarization assistant. Read a conversation between a user and
an AI coding assistant, then output only the requested structured summary.

Do not continue the conversation. Do not answer questions from the conversation.

# COMPRESSION_PROMPT
The messages above are conversation history to summarize. Create a concise context
checkpoint another coding agent can use to continue.

Use this exact format:

## Goal / ## Constraints & Preferences / ## Progress (Done/In Progress/Blocked)
## Key Decisions / ## Next Steps / ## Critical Context

Keep each section concise. Preserve exact file paths, function names, command
names, and error messages.
```


**位置：** `packages/ohbaby-agent/src/core/context/compression-prompt.ts`

**当前提示词：**

```
The messages above are conversation history to summarize. Create a concise context
checkpoint another coding agent can use to continue.

Use this exact format:
## Goal / ## Constraints & Preferences / ## Progress / ## Key Decisions / ## Next Steps / ## Critical Context

Keep each section concise. Preserve exact file paths, function names, command names, and error messages.
```

**问题：**
1. **无目标压缩比**：只说"Keep each section concise"，没有量化要求
2. **无最大输出限制**：没有限制 summary 的最大 token 数
3. **无分级压缩策略**：不管原文多长，都用同一套提示词
4. **inflation check 过于宽松**：只要 `newTokens < originalTokens` 就算成功，即使只节省 1%

**对比：** claude-code 的提示词要求 9 个详细 section（包括完整代码片段），但配合了 post-compact re-injection 和 microcompact 等多层策略。opencode 的提示词明确要求"terse bullets over paragraphs"。kimi-code 的提示词要求"<20 lines"的代码片段。

### 2.4 BUG #4（设计缺陷）：Compact 后未清理 stale usage anchor

**位置：** `packages/ohbaby-agent/src/core/context/context-manager.ts:496-505`

`summarizeHistory()` 在标记旧消息为 compacted 后，没有遍历保留消息并清除其 `tokenUsage` metadata。这导致后续所有 token 估算都被 stale anchor 污染。

```typescript
// context-manager.ts:496-505
const compactedAt = now();
for (const message of historyToCompress) {
  for (const part of message.parts) {
    if (part.time?.compacted === undefined) {
      await options.messageManager.updatePart(part.id, {
        time: { ...part.time, compacted: compactedAt },
      });
    }
  }
}
// 缺失：没有清理保留消息中的 stale tokenUsage metadata
```

### 2.5 BUG #5（兼容风险）：Context Summary 作为首条 assistant 消息发送

**位置：**

- `packages/ohbaby-agent/src/core/context/context-manager.ts:227-242`
- `packages/ohbaby-agent/src/core/context/serializer.ts`

`getActiveHistory()` 会把 context summary 消息提前到 active history 最前面。summary 在持久层是 `assistant` 消息，当前 `serializeForLlm()` 没有对 `metadata.kind === "context-summary"` 做特殊投影，因此发送给 LLM 的第一条非-system message 可能是：

```json
{ "role": "assistant", "content": "..." }
```

Anthropic Messages API 支持 synthetic assistant messages，也支持最后一条 assistant prefill；但 Anthropic/Bedrock/ZenMux 文档都强调模型按 user/assistant 轮次工作，且 ZenMux 文档明确说明最后一条 assistant 会被当作“继续补全”前缀。

**已做最小 e2e：**

- `assistant-summary-first`：ZenMux + `moonshotai/kimi-k2.6` 请求成功，但模型输出出现 marker 重复（`OK_ASSISTANT_SUMMARY_FIRST_FIRST`）。
- `user-wrapped-summary`：将 summary 包在 `<context_summary>` 的 user 消息中，请求成功且输出精确（`OK_USER_WRAPPED_SUMMARY`）。

**结论：** 这不是 `113K -> 113K` 的直接根因，但属于 Anthropic-compatible 接口的真实兼容风险。本轮应在 LLM 序列化层修复：持久化仍保留 summary 为 synthetic assistant message，但发送给模型时投影为：

```text
<context_summary>
...
</context_summary>
```

并使用 `role: "user"`。

---

## 3. 问题影响范围

| 问题 | 影响 | 严重性 | 触发频率 |
|------|------|--------|----------|
| Usage Anchor 过期 | compact 完全无效，上下文持续膨胀直到 API 报错 | 致命 | 每次 compact 后 |
| 模型 profile 缺失 | compact 阈值计算错误 | 高 | 使用非内置模型时 |
| 压缩提示词弱 | summary 过大，节省空间有限 | 中 | 每次 compact |
| Anchor 未清理 | 后续所有 token 估算被污染 | 高 | 每次 compact 后 |
| Summary assistant-first | Anthropic-compatible 代理可能把 summary 当 assistant prefill 或扰乱轮次 | 中 | compact 后每轮 |

---

## 4. 与竞品的差距

详细竞品分析见 **[02-reference-projects.md](./02-reference-projects.md)**。核心差距总结：

| 维度 | 差距 | 竞品最佳实践 | 修复 Phase |
|------|------|--------------|------------|
| Token 估算 | usage anchor 会过期 | kimi-code 的 `tokenCountCoveredMessageCount` | Phase 1.1 + 4 |
| 模型上下文窗口 | 未知模型 fallback 128K 且不持久化 | claude-code 的 model capability registry | Phase 1.2 |
| 压缩提示词 | 无力度控制、无用户消息保留 | opencode 的 "terse bullets" + kimi-code 的 "All User Messages" | Phase 2 |
| 压缩后清理 | 仅标记 compacted | claude-code 的 boundary marker + re-injection | Phase 1.1 + 5.1 |
| 重试机制 | 完全缺失 | 三家均有多层 retry + fallback | Phase 3 |
