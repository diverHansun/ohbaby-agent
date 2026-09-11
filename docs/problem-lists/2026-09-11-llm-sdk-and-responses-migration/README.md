# LLM SDK 升级与 Responses 协议调查

## 状态

- 文档状态：已实施并通过本地验收
- 代码状态：Improve 1 完成
- 实施基线：同步远端后的 `main@e095c7fa`
- 调查日期：2026-09-11

本目录把“协议方向调查”和“可立即实施的 SDK 升级”分开管理：

- [`investigation/`](./investigation/)：记录 Chat Completions、Responses、Anthropic Messages、第三方兼容性和参考项目结论。
- [`improve-1/`](./improve-1/)：只升级 OpenAI 与 Anthropic 官方 TypeScript SDK，并修复升级直接暴露的兼容问题。

## 已冻结的阶段边界

`improve-1` 不引入 `/v1/responses`，不新建 `openai-responses.ts`，不改变当前 OpenAI-compatible 的 `chat.completions.create()` 路径，也不改变 Anthropic 的 `messages.stream()` 路径。

以下内容全部延后到独立阶段重新设计和审核：

- 新增 Responses provider；
- provider-neutral message/tool/output IR；
- `previous_response_id`、Conversations 或其他服务端状态链；
- lifecycle、context 压缩、cache 统计、SQLite 消息格式的协议迁移；
- 移除 Chat Completions 兼容能力。

## 审核入口

建议按以下顺序审核：

1. [`investigation/00-discussion.md`](./investigation/00-discussion.md)
2. [`investigation/01-problem-analysis-and-current-state.md`](./investigation/01-problem-analysis-and-current-state.md)
3. [`investigation/03-reference-projects-and-ecosystem.md`](./investigation/03-reference-projects-and-ecosystem.md)
4. [`improve-1/02-optimization-plan-and-change-scope.md`](./improve-1/02-optimization-plan-and-change-scope.md)
5. [`improve-1/04-test-and-acceptance.md`](./improve-1/04-test-and-acceptance.md)
6. [`improve-1/05-implementation-acceptance.md`](./improve-1/05-implementation-acceptance.md)
7. [`planning-review.md`](./planning-review.md)

Improve 1 已按审核范围实施；Responses 相关工作仍需另行规划和审核。
