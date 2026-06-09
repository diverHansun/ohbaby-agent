# Compact 模块文档索引

## 文档导航

| # | 文档 | 内容 | 读者 |
|---|------|------|------|
| [01](./01-problem-analysis.md) | 问题与现状分析 | 5 个问题的根因链、测试验证用例、影响范围 | 所有人 |
| [02](./02-reference-projects.md) | 业界项目借鉴 | opencode / kimi-code / claude-code 的 compact 机制对比 | 架构/开发 |
| [03](./03-implementation-plan.md) | 实施与优化方案 | 5 个 Phase 的具体代码方案、优先级、工作量估算 | 开发 |
| [04](./04-testing-criteria.md) | 测试与验收标准 | 单元/集成/e2e 测试用例、验收门槛、性能基准 | QA/开发 |

## 当前确认方案

采用“方案 B：稳定版一轮交付”。本轮先完成可验证、可回滚的稳定修复：

1. 修复 compact 后 stale `tokenUsage` anchor 污染估算的问题。
2. `/connect` 通过模型 metadata endpoint 探测 context window，探测成功覆盖用户填写值。
3. 改进压缩提示词，并增加 empty summary retry 与 inflated summary aggressive retry。
4. 将持久化的 context summary 在发送给 LLM 时投影为 user-wrapped `<context_summary>`，提高 Anthropic-compatible 兼容性。
5. 暂不实现 microcompact、post-compact file re-injection、完整 overflow fallback 和长期 token tracking 架构迁移。

## 阅读顺序建议

```
01 (根因) ──→ 02 (竞品) ──→ 03 (方案) ──→ 04 (测试)
                  ↓
              可独立阅读（纯分析）
```

## 问题与方案映射

| 问题 (01) | 根因 | 方案 (03) | 测试 (04) |
|-----------|------|-----------|----------------|
| BUG #1: Usage Anchor 过期 | `token-estimation.ts:12-35` | Phase 1.1 | 2.1 |
| BUG #2: 模型 profile 缺失 | `apply-active-model-config.ts:68-69` + metadata probe 缺失 | Phase 1.2 | 2.2 |
| BUG #3: 压缩提示词弱 | `compression-prompt.ts` | Phase 2 | 3.x |
| BUG #4: Anchor 未清理 | `context-manager.ts:496-505` | Phase 1.1 (合并修复) | 2.1 |
| BUG #5: summary 作为首条 assistant 发送 | `serializer.ts` summary 投影缺失 | Phase 1.3 | 2.3 / 6.1 |

## 竞品借鉴来源（详见 [02](./02-reference-projects.md)）

| 借鉴点 | 来源 | 应用到 Phase |
|--------|------|--------------|
| "terse bullets" / "same language" | opencode | Phase 2 (提示词) |
| "All User Messages" / "<20 lines" 限制 | kimi-code | Phase 2 (提示词) |
| analysis/summary 两阶段 | claude-code | Phase 2 (提示词) |
| post-compact re-injection | claude-code | Phase 5.1 |
| `tokenCountCoveredMessageCount` | kimi-code | Phase 4 |
| circuit breaker | claude-code | Phase 3.3 |
| overflow fallback | kimi-code + opencode | Phase 3.4 |
| user-wrapped context summary | Anthropic Messages API + ZenMux e2e | Phase 1.3 |
