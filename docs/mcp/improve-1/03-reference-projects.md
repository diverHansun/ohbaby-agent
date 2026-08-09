# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|------|------|----------|
| Codex | `/Users/hansun025/Projects/code-cli/codex/codex-rs/.../tool_search*.rs`、`tools/src/tool_discovery.rs` | BM25 deferred 工具检索 |
| Grok-build | `/Users/hansun025/Projects/code-cli/grok-build/.../search_tool/`、`tool_index.rs` | 精确名高分 + BM25；语料字段 |
| Kun | `/Users/hansun025/Projects/code-cli/Kun/.../mcp-tool-search.ts` | MCP 分轨；BM25+keyword；topK/minScore |
| Claude Code | `.../SearchExtraToolsTool/`、`searchExtraTools/` | query + `select:ExactName`；延迟加载心智 |
| Kimi Code | `.../select-tools.ts`、`dynamic-tools.ts` | exact 点菜（ohbaby 现状同类） |
| oh-my-pi | 历史 BM25 → 名单挂载 | ranking 非银弹的反例 |

---

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|------|------|----------|-------------|
| Codex | BM25 over name+desc；limit；返回可加载规格 | 算法与语料主流 | **adopt** BM25；**adapt** 进 `select_tools` 而非独立协议工具 |
| Grok | 精确名优先再 BM25；语料含 server/参数标识符拆词 | 提高命中 | **adapt** 精确命中 rank 1 / score=1（**不**自动 load）；query load 时仍按排名逐个选择，不强行搜到即灌完整 schema |
| Kun | MCP 与 skill 分入口；topK/minScore | 00 三轨 | **adopt** 分轨与 topK；**reject** 虚拟 `mcp_call` 面 |
| Claude | query 模糊 + exact 可选；搜与执行分离 | UX | **adopt** 发现与加载分离；**reject** Anthropic-only defer_loading、ExecuteExtraTool |
| Kimi | exact select、串行、byte-stable description | 回归基线 | **保留** exact 路径不变 |

---

## 3.3 明确不借鉴

- Responses / `ToolSearch` 专有线协议（Codex）
- Embedding tool discovery
- 统一 search 服务同时索引 builtin + MCP + skill
- Kun 整套虚拟 MCP 调用面替代原生 `tools[]`
- 以名单挂载完全取代 ranking（oh-my-pi）作为本批主路径——本批是 **exact + BM25 并存**

---

## 3.4 对 02 方案的影响

| 02 决策 | 来自 |
|---------|------|
| BM25 + 旁路原始 desc | Codex/Grok + 本仓 stub 现实 |
| 扩展 select_tools，不新建工具 | 00 + 减 builtin 数量 |
| 精确命中给 score=1；加载只看 `load`，并按排名逐个选择 | 用户第五轮确认（消隐式副作用 + 防误装） |
| `load` 默认 false | 无 unload + 防误装（本仓约束，非友商默认） |
| 三轨分治 | Kun/笔记/上轮讨论 |
