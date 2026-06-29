# `/connect` 取消 API env / API key 强制校验

背景：本地用 LM Studio / Ollama 等推理服务时只需 `baseUrl`，不需要 API key，
但当前 `/connect` 全链路（后端 + CLI + Web）强制要求 `apiKeyEnv` 与 `apiKey`。

## 文档导航

1. [01-problem-analysis.md](./01-problem-analysis.md) —— 现有问题分析（后端 + 前端 web/cli，六层强制链路、根因）
2. [02-implementation-plan.md](./02-implementation-plan.md) —— 实施方案与修改 / 影响点（分阶段、精确到文件、待确认决策）
3. [03-test-and-acceptance.md](./03-test-and-acceptance.md) —— 测试与验收标准
4. [04-implementation-review.md](./04-implementation-review.md) —— 实施复盘、Claude review 处理与最终验证记录

## 一句话目标

把 `apiKeyEnv` 与 `apiKey` 从**全链路强制**改为**可选**——无论 base_url 是本机回环、
私有局域网还是远程公网；填了就用，没填则后端合成非空占位符满足底层 SDK 约束，
"密钥对不对/需不需要"交由上游请求（401）来回答。**不引入任何地址探测启发式。**

## 关键结论（必读）

- 真正的重心是**第 6 层"运行时加载校验"**（`config/llm/manager.ts:179`）：只放开 connect 不够，
  否则"连得上、用不了"。
- 底层 SDK 仅要求 key **非空**、不校验内容 → "后端合成占位符"方案成立。
- 不破坏既有"配置存键名、真实值进 `.env`、收敛到全局 `~/.ohbaby-agent/.env`"范式
  （见 [2026-06-17-api-key-env-centralization](../2026-06-17-api-key-env-centralization/README.md)）；
  既有云端用户零回归。

## 已采用决策

- **D1** 占位符取值：`"not-needed"`，集中在 `api-key.ts`。
- **D2** "有值无名"时密钥持久化位置：派生 `<PROVIDER>_API_KEY`。
- **D3** 结果契约无 key 时 `apiKeyEnv` 返回：省略字段。
- **D4** 显式配置了 env 名但取不到值：不阻断保存；后端返回 warning，由 CLI/Web 展示。

详见 [02-implementation-plan.md](./02-implementation-plan.md) 第二节与
[04-implementation-review.md](./04-implementation-review.md)。
