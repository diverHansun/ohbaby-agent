# 讨论记录与已确认要点

> 2026-08-09 定稿。讨论来源：[Ohbaby agent optimization](656ac25a-1867-4e78-86e5-94d4a9680088)（2026-08-09）及本规划会话确认；笔记参考 `Hansun-database/.../2026-08-07-ohbaby-agent-tools-upgrade.md`、`.../2026-08-07-coding-agent-builtin-tools-survey.md`。正式方案见 01–04。

---

## 1. 背景与动机

- improve-3 已实现 MCP「精确名点菜」；工具一多、编码名不直观时，模型难以命中正确工具。
- 用户直觉「三类工具应各司其职」正确；对照调研确认 ohbaby **已是分轨**，缺的是 **MCP 轨可检索**，不是造统一 search。
- 长命令堵对话是另一痛点，但产品排期与本规划会话确认：**先 MCP 发现，后 bash 后台**（见姐妹议题 `docs/shell/improve-3/`）。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/mcp/improve-1/`（与 shell 后台拆成 **两套** 文档） |
| 成功标准 | 模型可用查询找到相关 MCP 工具并加载 schema；精确点名仍可用；三轨分治不变；Scheduler 仍只做注册/过滤/执行 |
| 产品形态 | **扩展现有 `select_tools`**，增加 BM25 能力；**不**新增独立 `search_tools` 元工具 |
| 检索语料 | MCP 工具的 **localName + mcpServer + mcpToolName + 准入前原始 description**；仅 admitted/available 工具入索引。LLM 可见 description 仍走现有 stub 策略 |
| 三轨契约 | Builtin：常驻、不搜。MCP：deferred + 本批可 BM25。Skill：catalog + exact load，本批不改 |
| 上层调度 | ToolScheduler 仍是统一执行层；发现逻辑不进入 Scheduler |
| 实施顺序（跨议题） | 三批次依次为 **MCP → Shell → Memory**；本批为第 1 批，后续见 `docs/shell/improve-3/` 与 `docs/core/memory/improve-1/` |
| `query` vs `load` | `query` 精确命中 → 返回 **score=1**；**是否加载只看 `load`**（默认 false）。`tools[]` 始终精确加载。无隐式副作用 |
| `load:true` 的对象 | 对 query 的**已排序 top-limit 候选**按排名依次调用 menu.select；已加载项记录为 alreadyLoaded，不占新槽；其余到候选耗尽或 session/context scope 满为止。精确命中只排第一，不触发特殊全量加载 |
| query 回传内容 | 候选仅为 `{ name, score }`；原始 description 只在索引内使用，永不经 output/metadata 回传给模型。加载后可见的是既有 callable schema + 固定 stub description |
| 非法参数组合 | `tools` 只能单独出现；`tools+query`、`tools+load`（含 false）、`tools+limit` 均报错。`query` 必须非空白，可配 `load/limit`。空对象、空 tools、空白 query、仅 load/limit 均报错 |
| 并发 refresh | 单一串行/合并 runner；刷新期间再次触发只标记 dirty 并在当前轮后重跑。revision 保证旧的 in-flight 结果不能覆盖新快照；registry/menu/corpus 从同一 admitted snapshot 一次提交或一起清空 |
| Manager list_changed 风暴 | `getAllTools` 最多做 3 次 generation 检查、2 次实际 listTools；第二份快照仍被失效时返回但不缓存，后续 refresh 再取最新，禁止递归无界重试 |
| system prompt 归属 | MCP menu 公告由 `src/mcp/system-prompt.ts` 自有；core system-prompt 只保留通用 runtime prompt 注入点，不在 `layers/` 内承载 MCP 领域代码 |
| 本批文档完整度 | 产出齐全 00–04 |

---

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 / 后续做 |
|----|-------------------|
| 统一 discovery / 跨源同一索引 | 不做 |
| Embedding tool search | 不做 |
| 独立 `search_tools` 工具 | 不做（能力并入 `select_tools`） |
| Skill / Builtin 的 BM25 | 不做 |
| unload / 换一批已加载 MCP | 本批不做（保持现有 session 上限语义） |
| bash `run_in_background` / `task_output` / kill | **后续** `docs/shell/improve-3/` |
| 独立 background daemon | 不做 |
| 把 subagent 改成 bash 参数 | 不做（域不同） |
| 虚假 `memory_*` LLM 工具契约清理 | 不并入本批；第 3 批独立处理，见 `docs/core/memory/improve-1/` |

---

## 4. 已确认：与关联议题的关系

| 关联 | 关系 |
|------|------|
| `docs/core/system-prompt/improve-3/` | 权威：精确点菜已落地；本批在其上增强发现，不回退「全量 MCP schema 顶层」 |
| `docs/mcp/*.md` | 模块权威文档；实施后同步「发现 = list + 可检索点菜」表述 |
| `docs/core/tool-scheduler/` | 执行/权限层；本批不改并发模型，仅消费已 select 的工具 |
| `docs/shell/improve-3/` | 姐妹批次；本批之后 |
| 笔记 P0 债（虚假 `memory_*` 契约） | **不并入本批**；已另立 `docs/core/memory/improve-1/` 第 3 批。bash 双超时债由 `docs/shell/improve-3/`（Phase 1）承接 |

---

## 5. 参考项目（摘要）

| 项目 | 借鉴 | 不照搬 |
|------|------|--------|
| Codex / Grok | BM25 搜 deferred/MCP 语料 | 专有 `tool_search` API 绑定为唯一路径 |
| Kun | MCP 与 skill **分轨**入口 | 把写作检索 BM25 整套搬进 agent 工具面 |
| Claude | query 模糊 + exact 短路的产品形态 | Anthropic-only defer_loading 作唯一路径；**不**把「精确命中」做成隐式 load |
| Kimi | 与 ohbaby 同类的 exact `select_tools` | 无 fuzzy 时的停滞状态 |
| oh-my-pi | 曾 BM25 后改名单挂载 → ranking 非银弹，需保留 exact | 强制 `xd://` 目录挂载为本批主路径 |

细节见 [03-reference-projects.md](./03-reference-projects.md)。

---

## 6. 用户确认记录

| 时间 | 确认项 |
|------|--------|
| 2026-08-09 上轮 | 三轨分治；MCP 侧加 BM25；不做统一 search / embedding / 独立 bg daemon |
| 2026-08-09 上轮 | bash 与 subagent 域分离；启动倾向 bash 参数；观测工具面待拍板 |
| 2026-08-09 本会话 | 文档拆 2 套；两套都写齐 00–04；**扩展 `select_tools` 做 BM25**；排期先 MCP 后 bash+task(output/kill)；bash 进程内 job 表；permission/sandbox 沿用前台 bash；讨论以上一轮为准 |
| 2026-08-09 本会话 | kill 与 stop 同义（归入 shell improve-3，非本批） |
| 2026-08-09 本会话（第三轮） | `query` 精确命中只返回 score=1；加载只看 `load`（默认 false）；`tools[]` 保持旧精确加载；无隐式副作用 |
| 2026-08-09 本会话（第四轮） | 三批次分别测试并提交；本批仅 MCP BM25，不混入 Shell 或 Memory 改动 |
| 2026-08-09 本会话（第五轮） | `load:true` 按排名依次加载到候选耗尽或槽满；精确命中只负责 rank 1 / score 1。query 候选只回传 name + score，不回传原始 description |
