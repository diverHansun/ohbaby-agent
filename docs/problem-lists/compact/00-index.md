# Compact 模块文档索引

## 文档导航

| # | 文档 | 内容 | 读者 |
|---|------|------|------|
| [01](./01-problem-analysis.md) | 问题与现状分析 | 5 个问题的根因链、测试验证用例、影响范围 | 所有人 |
| [02](./02-reference-projects.md) | 业界项目借鉴 | opencode / kimi-code / claude-code 的 compact 机制对比 | 架构/开发 |
| [03](./03-implementation-plan.md) | 实施与优化方案 | 5 个 Phase 的具体代码方案、优先级、工作量估算 | 开发 |
| [04](./04-testing-criteria.md) | 测试与验收标准 | 单元/集成/e2e 测试用例、验收门槛、性能基准 | QA/开发 |
| [05](./05-compact-result-and-notice-ui-design.md) | Compact 结果语义与 Notice UI 优化 | 手动 `/compact`、后端防膨胀、spinner、notice/历史边界的增量设计 | 架构/开发 |

## 当前确认方案

采用“方案 B：稳定版一轮交付”。本轮先完成可验证、可回滚的稳定修复：

1. 修复 compact 后 stale `tokenUsage` anchor 污染估算的问题。
2. `/connect` 通过模型 metadata endpoint 探测 context window，探测成功覆盖用户填写值。
3. 改进压缩提示词，并增加 empty summary retry 与 inflated summary aggressive retry。
4. 将持久化的 context summary 在发送给 LLM 时投影为 user-wrapped `<context_summary>`，提高 Anthropic-compatible 兼容性。
5. 暂不实现 microcompact、post-compact file re-injection、完整 overflow fallback 和长期 token tracking 架构迁移。
6. 手动 `/compact` 的用户可见结果只显示 `Compacted`；token delta 只作为内部 metadata/debug 信息保留。compact 成功必须以后端提交后的 active context 下降为准，不能只看 summary 字符串比被压缩片段短。

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
| BUG #6: Compact 结果表意不清 | command output 与 context notice 都展示 token delta，且 `compacted` 未保证 active context 下降 | 05 后端提交不变量 + UI 文案 | 05 验收 |
| BUG #7: Notice 粘在输入框上方 | `NoticeLane` 是持久 lane state，不会随下一条用户消息进入历史或消失 | 05 notice 分层设计 | 05 验收 |

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
