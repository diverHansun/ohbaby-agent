# mcp improve-1 · MCP 发现增强（扩展 `select_tools` + BM25）

> 状态：**已实施（第 1 批）**
> 日期：2026-08-09
> 落点：`docs/mcp/improve-1/`
> 承接：`docs/core/system-prompt/improve-3/`（MCP 精确点菜已落地）→ **本批（点菜之上加 BM25 检索）**
> 姐妹议题：`docs/shell/improve-3/`（bash background + `task_output` / kill；**本批之后**实施）

## 1. 议题

improve-3 已落地「公告精确名 → `select_tools` 精确点名 → schema 进 `tools[]`」。当 MCP 工具变多、本地编码名不直观时，模型只能瞎猜精确名，点不中或空转。

本批目标：**在保持 builtin / MCP / skill 三轨分治、ToolScheduler 仍为上层调度的前提下，扩展现有 `select_tools`，使 MCP 轨支持 BM25 检索发现，再点菜加载**。不新建全局统一 search，不上 embedding。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状与问题（代码锚点） |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：方案、改动面、分阶段 DoD |
| [03-reference-projects.md](./03-reference-projects.md) | Codex / Grok / Kun / Claude / Kimi 借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收门 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

## 3. In scope

- 扩展 `select_tools`：保留精确名点菜；增加 BM25 查询能力（语料固定为 **localName + mcpServer + mcpToolName + 准入前原始 description**）
- 检索候选只返回 `name + score`；`load:true` 时按排名依次走既有 menu.select，直至候选耗尽或 scope 槽满
- 检索结果 → 既有 admit / loaded 上限 / accessGuard / lifecycle 每步重算 `tools[]` 路径
- 明确三轨契约（文档 + 必要注释）：builtin 常驻；MCP deferred+可检索；skill 元工具另轨
- 同步更新与本批冲突的 `docs/mcp/`、`docs/core/system-prompt/` 相关表述

## 4. Out of scope（本批）

| 项 | 说明 |
|----|------|
| 统一 discovery 中枢 | builtin/MCP/skill 不进同一索引 |
| Embedding tool search | YAGNI |
| 独立 `search_tools` 元工具 | 能力并入扩展后的 `select_tools` |
| unload / 释放已点菜槽位 | 后续可选；本批保持现有上限语义 |
| bash background / `task_*` | 见 `docs/shell/improve-3/` |
| MCP resource/prompt 渐进披露 | 非本批 |
| 独立 background daemon | 非本议题 |

## 5. 实施契约声明

本目录文档是本批实现与验收的执行契约；实现已按 `02` 落地，并按 `04` 的自动化门槛验证。
