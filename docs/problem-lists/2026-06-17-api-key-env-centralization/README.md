# API Key 统一收敛到 .env 与内置搜索配置入口

版本背景：v0.1.4 发布后发现的配置持久化问题。

## 文档导航

1. [problem-analysis.md](./problem-analysis.md) —— 现有问题与代码分析（涉及模块、数据流、根因）
2. [implementation-plan.md](./implementation-plan.md) —— 实施修改 / 优化方案（分批次、精确到文件）
3. [test-and-acceptance.md](./test-and-acceptance.md) —— 测试与验收标准

## 一句话目标

把所有 api-key（LLM、内置搜索 Tavily、以及后续的 MCP）统一收敛到用户级 `~/.ohbaby-agent/.env`，
各能力的配置文件（model.json / search.json / mcp/settings.json）只存“键名 + 非密钥配置”，
真实密钥值只存一份在 `.env`，并提供交互界面入口（`/connect`、新增 `/connect-search`）让用户无需手改文件。

## 决策记录（已确认）

- 决策 1：所有 api-key 统一放 `.env`，包括 MCP。各能力配置文件位置不同，但真实 key 都从 `.env` 读取。
- 决策 2：MCP 支持 `${ENV}` 插值的增强，安排在内置搜索（Tavily）之后的下一批完成；本批先打地基。
- 决策 3：新增独立命令 `/connect-search`，便于后续在内置搜索工具中切换 / 新增供应商（当前为 Tavily）。

## 批次划分

- 批次一（本批）：
  - 任务 A：LLM API Key 首次写入即落到全局 `~/.ohbaby-agent/.env`。
  - 任务 B：新增 `/connect-search` 命令与面板，Tavily key 落到全局 `.env`。
- 批次二（后续）：
  - 任务 C：MCP 配置支持 `${ENV}` 插值，使 MCP 密钥也能集中放 `.env`。
