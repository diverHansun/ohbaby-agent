# Improve 1：OpenAI 与 Anthropic SDK 升级

## 目标

在保持当前 Chat Completions、Anthropic Messages、agent lifecycle、context/cache 和 SQLite 语义不变的前提下：

- 将 `openai` 升至 `7.13.0`；
- 将 `@anthropic-ai/sdk` 升至 `0.124.0`；
- 修复新版 SDK 暴露的类型边界和测试 fixture 问题；
- 通过完整本地预检与两类 provider 的可选真实 smoke；
- 同步受影响的 LLM client 文档。

## 当前状态

已实施，并通过完整本地 `pnpm preflight`。需要真实 API 凭据与配额的 provider/cache smoke 未运行，保留为可选验收。

实施方案见 [`02-optimization-plan-and-change-scope.md`](./02-optimization-plan-and-change-scope.md)，测试标准见 [`04-test-and-acceptance.md`](./04-test-and-acceptance.md)，实际结果见 [`05-implementation-acceptance.md`](./05-implementation-acceptance.md)。
