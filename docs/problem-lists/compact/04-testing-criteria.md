# Compact 模块测试与验收标准

> 本文按本轮确认的方案 B 更新：先修 stale usage anchor、`/connect` context window metadata probe、context summary 的 LLM 投影、压缩提示词与两类轻量 retry。完整 overflow fallback、circuit breaker、长期 token tracking 架构迁移留到下一轮。

---

## 1. 测试策略

### 1.1 测试分层

| 层级 | 范围 | 工具 | 目标 |
|------|------|------|------|
| 单元测试 | 单个函数/模块 | Vitest | 精确验证边界条件 |
| 集成测试 | context manager + message store + serializer | Vitest + mock LLM | 验证 compact 数据流不会污染后续 turn |
| 端到端测试 | provider metadata + Anthropic-compatible 请求 | Vitest 或脚本 + real API | 验证 Kimi/ZenMux 真实兼容性 |

### 1.2 推荐测试文件组织

```
packages/ohbaby-agent/src/core/context/
├── manager.unit.test.ts
├── token-estimation.unit.test.ts
├── serializer.unit.test.ts
├── compression-prompt.test.ts
└── compact.real.test.ts      # gated by env，不在普通 CI 强制跑

packages/ohbaby-agent/src/config/llm/__tests__/
└── apply-active-model-config.unit.test.ts

packages/ohbaby-agent/src/services/llm-model/
└── context-window-probe.unit.test.ts
```

---

## 2. Phase 1 测试：致命 BUG 与兼容性修复

### 2.1 Usage Anchor 过期修复

目标不是只在 `estimateContextTokens()` 中查找 compacted part。真实调用链里 `getActiveHistory()` 已经会过滤 compacted part，因此测试必须覆盖两层防御：

1. compact 成功后清理保留消息中的旧 `metadata.tokenUsage`。
2. 估算层通过最新 context summary boundary 跳过早于 summary 的 usage anchor，以兼容已经 compact 过的旧 session。

**文件：** `token-estimation.unit.test.ts`

```typescript
describe("estimateContextTokens: summary boundary", () => {
  it("skips usage anchors created before the latest context summary", () => {
    const history = [
      messageWithUsage("assistant", "old anchor", {
        totalTokens: 113_350,
        createdAt: 1000,
      }),
      contextSummary("compressed work so far", { createdAt: 2000 }),
      textMessage("user", "continue", { createdAt: 3000 }),
    ];

    const result = estimateContextTokens(history, tokenCounter);

    expect(result.anchorIndex).toBe(-1);
    expect(result.tokens).toBeLessThan(10_000);
  });

  it("uses a fresh usage anchor created after the latest context summary", () => {
    const history = [
      messageWithUsage("assistant", "old anchor", {
        totalTokens: 113_350,
        createdAt: 1000,
      }),
      contextSummary("compressed work so far", { createdAt: 2000 }),
      textMessage("user", "continue", { createdAt: 3000 }),
      messageWithUsage("assistant", "fresh anchor", {
        totalTokens: 6_000,
        createdAt: 4000,
      }),
      textMessage("user", "new turn", { createdAt: 5000 }),
    ];

    const result = estimateContextTokens(history, tokenCounter);

    expect(result.anchorIndex).toBe(3);
    expect(result.anchorTokens).toBe(6_000);
  });
});
```

**文件：** `manager.unit.test.ts`

```typescript
describe("compact: usage metadata cleanup", () => {
  it("clears stale tokenUsage from retained messages after summary is created", async () => {
    await seedLargeConversationWithRetainedUsageAnchor(sessionId);

    const result = await contextManager.compact(sessionId, {
      directory: projectRoot,
      force: true,
      modelId: "test-model",
    });

    expect(result.status).toBe("compacted");

    const activeHistory = await contextManager.getActiveHistory(sessionId);
    const summary = activeHistory.find(isSummaryMessage);
    expect(summary).toBeDefined();

    const staleAnchors = activeHistory.filter((message) =>
      message.info.time.created < summary!.info.time.created &&
      message.parts.some((part) => part.metadata?.tokenUsage !== undefined),
    );

    expect(staleAnchors).toHaveLength(0);
    expect(result.usageAfter.currentTokens).toBeLessThan(result.usageBefore.currentTokens);
  });

  it("clears stale tokenUsage when compaction resolves through prune only", async () => {
    await seedPrunableToolOutputAndRetainedUsageAnchor(sessionId);

    const result = await contextManager.compact(sessionId, {
      directory: projectRoot,
      modelId: "test-model",
    });

    expect(result.status).toBe("pruned");
    expect(result.usageAfter.currentTokens).toBeLessThan(100);
    expect(retainedMessagePart.metadata).toEqual({ keep: true });
  });

  it("summarizes the active history after same-pass pruning", async () => {
    await seedPrunableReadFileOutput("old-pruned.txt");

    const result = await contextManager.compact(sessionId, {
      directory: projectRoot,
      force: true,
      modelId: "test-model",
    });

    expect(result.status).toBe("compacted");
    expect(summaryText).not.toContain("old-pruned.txt");
    expect(summaryText).not.toContain("<read-files>");
  });
});
```

### 2.2 `/connect` Context Window Metadata Probe

`/connect` 每次配置新模型时都应使用 `base_url` 和 `api-key` 尝试探测模型 metadata。探测成功覆盖用户填写值；探测失败时不报 error，只给轻量 warning，并按优先级回退。

优先级：

1. 探测成功：`contextWindowTokens = detected`，`contextWindowSource = "detected"`。
2. 探测失败且用户填写：`contextWindowTokens = user`，`contextWindowSource = "user"`。
3. 探测失败且用户未填写：`contextWindowTokens = 128_000`，`contextWindowSource = "default"`。

**文件：** `context-window-probe.unit.test.ts`

```typescript
describe("context window metadata probe", () => {
  it("reads Anthropic-compatible context_length from /v1/models", async () => {
    mockFetchModels({
      data: [{ id: "moonshotai/kimi-k2.6", context_length: 262_144 }],
    });

    const result = await probeContextWindow({
      provider: "anthropic-compatible",
      baseUrl: "https://zenmux.ai/api/anthropic",
      apiKey: "secret",
      modelId: "moonshotai/kimi-k2.6",
    });

    expect(result.contextWindowTokens).toBe(262_144);
  });

  it("handles base URLs that already include /v1 or /v1/messages", async () => {
    expect(modelsUrl("https://example.com/api/v1")).toBe("https://example.com/api/v1/models");
    expect(modelsUrl("https://example.com/api/v1/messages")).toBe("https://example.com/api/v1/models");
    expect(modelsUrl("https://example.com/api/")).toBe("https://example.com/api/v1/models");
  });

  it("accepts input-context fields but ignores output-token fields", async () => {
    expect(extractContextWindow({ context_window: 262_144 })).toBe(262_144);
    expect(extractContextWindow({ contextWindow: 262_144 })).toBe(262_144);
    expect(extractContextWindow({ context_window_tokens: 262_144 })).toBe(262_144);
    expect(extractContextWindow({ max_input_tokens: 262_144 })).toBe(262_144);
    expect(extractContextWindow({ max_context_tokens: 262_144 })).toBe(262_144);
    expect(extractContextWindow({ max_tokens: 16_384 })).toBeUndefined();
  });

  it("does not treat broad digit substrings as a fuzzy model match", async () => {
    mockFetchModels({
      data: [{ id: "anthropic/claude-3-5-sonnet-20240620", context_length: 200_000 }],
    });

    const result = await probeContextWindow({
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      apiKey: "secret",
      modelId: "claude-sonnet-4.6",
    });

    expect(result.contextWindowTokens).toBeUndefined();
    expect(result.warning).toMatch(/context window/i);
  });
});
```

**文件：** `apply-active-model-config.unit.test.ts`

```typescript
describe("applyActiveModelConfig: context window source", () => {
  it("uses detected context window even when user provided another value", async () => {
    mockProbeResult({ contextWindowTokens: 262_144 });

    const result = await applyActiveModelConfig({
      modelId: "moonshotai/kimi-k2.6",
      provider: "anthropic-compatible",
      baseUrl: "https://zenmux.ai/api/anthropic",
      apiKey: "secret",
      contextWindowTokens: 128_000,
    });

    expect(result.contextWindowTokens).toBe(262_144);
    expect(result.contextWindowSource).toBe("detected");
  });

  it("uses the user value when probe fails and user provided one", async () => {
    mockProbeFailure();

    const result = await applyActiveModelConfig({
      modelId: "custom",
      provider: "anthropic-compatible",
      baseUrl: "https://example.com/api",
      apiKey: "secret",
      contextWindowTokens: 64_000,
    });

    expect(result.contextWindowTokens).toBe(64_000);
    expect(result.contextWindowSource).toBe("user");
    expect(result.warning).toMatch(/context window/i);
  });

  it("uses 128k default when probe fails and user did not provide a value", async () => {
    mockProbeFailure();

    const result = await applyActiveModelConfig({
      modelId: "custom",
      provider: "anthropic-compatible",
      baseUrl: "https://example.com/api",
      apiKey: "secret",
    });

    expect(result.contextWindowTokens).toBe(128_000);
    expect(result.contextWindowSource).toBe("default");
    expect(result.warning).toMatch(/context window/i);
  });

  it("surfaces probe failure as a lightweight warning without displaying contextWindowSource", async () => {
    mockProbeFailure();

    const result = await connectThroughCliOrTui();

    expect(result.warning).toMatch(/context window/i);
    expect(renderedUiText).toContain("warning");
    expect(renderedUiText).not.toContain("contextWindowSource");
    expect(renderedUiText).not.toContain("default");
  });
});
```

### 2.3 Context Summary LLM 投影

持久层仍保留 summary 为 synthetic assistant message；发送给 LLM 时必须转换为 user-wrapped block，避免 Anthropic-compatible 代理把首条 assistant 当成异常历史或 prefill。

**文件：** `serializer.unit.test.ts`

```typescript
describe("serializeHistoryMessages: context summary", () => {
  it("projects context summary as a user wrapped context_summary block", () => {
    const messages = [
      contextSummary("Goal: fix compact\nNext: run tests"),
      textMessage("user", "continue"),
    ];

    const serialized = serializeHistoryMessages(messages);

    expect(serialized[0]).toEqual({
      role: "user",
      content: "<context_summary>\nGoal: fix compact\nNext: run tests\n</context_summary>",
    });
    expect(serialized[1]).toMatchObject({ role: "user", content: "continue" });
  });
});
```

---

## 3. Phase 2 测试：压缩提示词

### 3.1 提示词结构验证

**文件：** `compression-prompt.test.ts`

```typescript
describe("compression prompt", () => {
  it("contains the required continuation sections", () => {
    const requiredSections = [
      "## Goal",
      "## Current State",
      "## Key Decisions",
      "## User Intent & Feedback",
      "## Relevant Files",
      "## Next Steps",
      "## Risks",
    ];

    for (const section of requiredSections) {
      expect(COMPRESSION_PROMPT).toContain(section);
    }
  });

  it("sets a concrete compression target", () => {
    expect(COMPRESSION_PROMPT).toMatch(/15-30%|30%|one third/i);
  });

  it("discourages meta commentary and tool calls", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/do not.*tool/i);
    expect(COMPRESSION_PROMPT).toMatch(/do not mention.*summar/i);
  });

  it("has an aggressive fallback prompt for inflated summaries", () => {
    expect(AGGRESSIVE_COMPRESSION_PROMPT).toMatch(/too long|compress aggressively/i);
  });
});
```

### 3.2 压缩效果集成测试

这些测试不要求真实 LLM；可以用 mock summary 验证 compact 数据流和 token 下降。

```typescript
describe("compact: compression quality", () => {
  it("reduces active token estimate when summary is smaller than compressed history", async () => {
    await createLargeHistory(sessionId, { estimatedTokens: 100_000 });
    mockSummary("## Goal\n- Continue the compact fix.\n\n## Next Steps\n- Run tests.");

    const result = await contextManager.compact(sessionId, {
      directory: projectRoot,
      force: true,
      modelId: "test-model",
    });

    expect(result.status).toBe("compacted");
    expect(result.usageAfter.currentTokens).toBeLessThan(30_000);
    expect(result.compression?.savedTokens).toBeGreaterThan(60_000);
  });

  it("preserves critical file paths and user feedback in the summary message", async () => {
    const keyFilePath = "packages/ohbaby-agent/src/core/context/token-estimation.ts";
    const feedback = "不要只剪裁历史，要真的压缩。";
    await createHistoryWithCriticalFacts(sessionId, { keyFilePath, feedback });
    mockSummary(`## Relevant Files\n- ${keyFilePath}\n\n## User Intent & Feedback\n- ${feedback}`);

    await contextManager.compact(sessionId, { directory: projectRoot, force: true, modelId: "test-model" });

    const summary = await getSummaryText(sessionId);
    expect(summary).toContain(keyFilePath);
    expect(summary).toContain(feedback);
  });
});
```

---

## 4. Phase 3 测试：轻量重试与容错

### 4.1 Inflation Retry

```typescript
describe("compact: inflation retry", () => {
  it("retries once with the aggressive prompt when the first summary is inflated", async () => {
    llmClient.generateSummary = vi.fn()
      .mockResolvedValueOnce(repeatText("inflated", 50_000))
      .mockResolvedValueOnce("## Goal\n- Short enough.");

    const result = await contextManager.compact(sessionId, {
      directory: projectRoot,
      force: true,
      modelId: "test-model",
    });

    expect(llmClient.generateSummary).toHaveBeenCalledTimes(2);
    expect(llmClient.generateSummary.mock.calls[1][0].prompt).toContain("CRITICAL");
    expect(result.status).toBe("compacted");
  });

  it("does not mutate history when both summary attempts remain inflated", async () => {
    llmClient.generateSummary = vi.fn()
      .mockResolvedValueOnce(repeatText("inflated", 50_000))
      .mockResolvedValueOnce(repeatText("still inflated", 50_000));

    const before = await messageManager.listBySession(sessionId);
    const result = await contextManager.compact(sessionId, { directory: projectRoot, force: true, modelId: "test-model" });
    const after = await messageManager.listBySession(sessionId);

    expect(result.status).toBe("not-needed");
    expect(after).toEqual(before);
  });
});
```

### 4.2 Empty Summary Retry

**文件：** `prompt-context.unit.test.ts` 或已有 summarization client 测试

```typescript
describe("createContextSummaryClient: empty summary retry", () => {
  it("retries once when the stream completes with empty content", async () => {
    streamChatCompletion
      .mockResolvedValueOnce(streamWithContent("  "))
      .mockResolvedValueOnce(streamWithContent("valid summary"));

    await expect(client.generateSummary(input)).resolves.toBe("valid summary");
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error after repeated empty summaries", async () => {
    streamChatCompletion
      .mockResolvedValueOnce(streamWithContent(""))
      .mockResolvedValueOnce(streamWithContent("  "));

    await expect(client.generateSummary(input)).rejects.toThrow("empty after retries");
  });
});
```

---

## 5. 端到端测试

真实 API 测试必须 gated，避免普通 CI 和本地无 key 环境失败。建议使用：

```powershell
$env:OHBABY_COMPACT_REAL_E2E='1'
$env:ZENMUX_API_KEY='...'
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compact.real.test.ts --passWithNoTests
```

### 5.1 ZenMux + Kimi K2.6 Metadata Probe

验收点：

| 条件 | 期望 |
|------|------|
| `GET https://zenmux.ai/api/anthropic/v1/models` | HTTP 200 |
| model id | `moonshotai/kimi-k2.6` |
| context field | `context_length` |
| parsed context window | `262_144` |
| API key handling | 不打印、不写入测试快照、不进入错误消息 |

### 5.2 Anthropic-Compatible Summary Projection

构造两种真实请求做兼容性对比：

1. 首条 assistant summary：记录是否成功，以及模型是否出现 marker 续写/重复。
2. user-wrapped `<context_summary>`：期望成功且输出精确 marker。

验收结论不是要求 assistant-first 必然失败，而是证明 user-wrapped projection 在当前 ZenMux/Kimi 组合上更稳定。

---

## 6. 验收标准

### 6.1 Phase 1 验收

| 编号 | 验收条件 | 验证方法 |
|------|----------|----------|
| 1.1 | compact 后 active token estimate 明显下降，不再出现 `113K -> 113K` | unit + integration |
| 1.2 | 旧 usage anchor 在 summary boundary 之前会被跳过 | `token-estimation.unit.test.ts` |
| 1.3 | compact 成功后保留消息不携带 stale `metadata.tokenUsage` | `manager.unit.test.ts` |
| 1.4 | `/connect` metadata 成功时覆盖用户填写 context window | `apply-active-model-config.unit.test.ts` |
| 1.5 | metadata 失败时按 user/default 回退，并只给轻量 warning | `apply-active-model-config.unit.test.ts` |
| 1.6 | context summary 发送给 LLM 时是 user-wrapped block | `serializer.unit.test.ts` |

### 6.2 Phase 2 验收

| 编号 | 验收条件 | 验证方法 |
|------|----------|----------|
| 2.1 | prompt 包含结构化 continuation sections | `compression-prompt.test.ts` |
| 2.2 | prompt 有明确压缩目标 | `compression-prompt.test.ts` |
| 2.3 | summary 保留关键文件路径和用户意图 | integration/mock LLM |
| 2.4 | summary 不包含元信息，如 `I am summarizing` | 负面正则测试 |

### 6.3 Phase 3 验收

| 编号 | 验收条件 | 验证方法 |
|------|----------|----------|
| 3.1 | inflated summary 自动用 aggressive prompt 重试一次 | mock LLM 调用次数 |
| 3.2 | 两次仍 inflated 时不修改历史 | integration |
| 3.3 | empty summary 自动重试一次 | summarization client unit |
| 3.4 | compact 失败不破坏原始消息 | integration |

### 6.4 回归测试

| 编号 | 验收条件 | 验证命令 |
|------|----------|----------|
| R.1 | context 相关测试通过 | `pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --passWithNoTests` |
| R.2 | model config 相关测试通过 | `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts --passWithNoTests` |
| R.3 | provider adapter 相关测试通过 | `pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers/anthropic.test.ts packages/ohbaby-agent/src/services/interface-providers/openai-compatible.test.ts --passWithNoTests` |
| R.4 | 全量测试在合并前通过 | `pnpm exec vitest run --passWithNoTests` |

---

## 7. 性能与质量基准

| 指标 | BUG 状态 | 本轮目标 | 测量方法 |
|------|----------|----------|----------|
| Compact 后 token 减少比 | 可能 0% | mock/integration 中 >= 60% | `(before - after) / before` |
| Kimi context window | fallback 128K 或 undefined | metadata probe 得到 256K | real e2e |
| Summary 投影兼容性 | 首条 assistant 风险 | user-wrapped 成功 | real e2e |
| Empty summary | 直接失败 | 重试一次 | unit |
| Inflated summary | 可能照样提交 | aggressive retry，仍失败则不提交 | integration |

---

## 8. 测试运行命令

```powershell
# 目标单元测试
pnpm exec vitest run packages/ohbaby-agent/src/core/context/token-estimation.unit.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/core/context/serializer.unit.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compression-prompt.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/services/llm-model/context-window-probe.unit.test.ts --passWithNoTests

# 已有回归测试
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --passWithNoTests
pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers/anthropic.test.ts packages/ohbaby-agent/src/services/interface-providers/openai-compatible.test.ts --passWithNoTests

# 真实 e2e，需要显式开启
$env:OHBABY_COMPACT_REAL_E2E='1'
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compact.real.test.ts --passWithNoTests

# 合并前
pnpm exec vitest run --passWithNoTests
pnpm --filter ohbaby-agent typecheck
```
