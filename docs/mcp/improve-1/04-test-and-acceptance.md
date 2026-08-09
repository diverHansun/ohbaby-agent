# 4. 测试与验收标准

> 实施会话按本文件自测；验收会话对照本文件检查。

---

## 4.1 测试范围

| 类型 | 覆盖 |
|------|------|
| 单测 | BM25 索引/查询、`select_tools` exact 回归、query/load/互斥、排名顺序、metadata 字段形状、refresh 重建、scope 隔离 |
| 集成（composition） | refresh → 公告 → query → exact load → resolvePromptTools 含 schema；accessGuard |
| 回归 | improve-3 点菜单测、UI 隐藏 `select_tools`、subagent scope loaded 隔离 |
| 手工（可选） | 真实 MCP server 工具较多时，用自然语言 query 能否点到目标工具 |

项目若有 `test-blueprint`，单测风格与目录约定从其规定。

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Phase |
|----|------|------|--------|---------------|
| T-A1 | 建 corpus 后用描述关键词检索 | 单测 | 命中目标 localName；不以 stub 为语料 | A |
| T-A2 | refresh / list_changed 后索引 | 单测 | 移除的工具不可搜；新增可搜 | A |
| T-A2b | list_changed 连续发生 | 单测 | getAllTools 有界返回；实际 listTools 最多两轮，未稳定快照不缓存 | A |
| T-A3 | unsafe/超长 description | 单测 | 与 admit 策略一致：拒进 LLM 的是否进索引有明确断言（建议：未通过 admit 的不入 available，故不可 select；索引仅 available） | A |
| T-B1 | 仅 `tools` exact | 单测 | 与改前行为一致 | B |
| T-B2 | 仅 `query`、`load:false` | 单测 | 返回排名；**不**增加 loaded | B |
| T-B3 | `query` + `load:true` | 单测 | 将 top-`limit` 候选按排名逐个加载；候选耗尽或槽满停止；触顶进 `limitReached` | B |
| T-B4 | `tools` 与 `query` 同时出现 | 单测 | 明确报错 | B |
| T-B4b | `tools` 搭配 `load/limit`；仅 `load/limit`；空对象/空 tools/空白 query | 单测 | 全部按 02 参数矩阵报错 | B |
| T-B5 | `query` 精确等于 available 名、`load:false` | 单测 | 精确项 rank 1 / score=1；**不**增加 loaded | B |
| T-B5b | `query` 精确等于 available 名、`load:true` | 单测 | 精确项先被选择；其余 top-limit 候选仍按排名继续选择，直至候选耗尽或槽满 | B |
| T-B6 | `limit` 边界 | 单测 | 默认 5；最大 8；非法值报错 | B |
| T-B7 | query 候选字段形状 | 单测 | candidates 每项**只**有 name、score；任何原始/截断/scanned description 均不出现于 output 或 metadata | B |
| T-B8 | fuzzy 排名稳定性 | 单测 | 非精确候选按归一化 score 降序、name 升序；score 位于 [0,1) | B |
| T-B9 | metadata 选择结果 | 单测 | `mcpSelection` 含 candidates/loaded/alreadyLoaded/limitReached/unknown；顺序与实际 menu.select 调用一致 | B |
| T-C1 | composition 端到端 | 集成 | query → metadata candidates/选择结果 →（可选 load）→ 下一步 tools[] 含 schema+stub | B/C |
| T-C2 | accessGuard | 集成 | 未 load 不可调用 MCP | 回归 |
| T-C3 | UI 隐藏 | 单测/回归 | transcript 不展示 select_tools | 回归 |
| T-C4 | 无 MCP | 集成 | query 返回空/无 available；不崩溃 | B |
| T-C5 | 并发 refresh latest-wins | 集成 | 延迟旧 refresh 后触发新 revision；最终 registry/menu/corpus 只包含新 admitted snapshot，旧结果不得覆盖 | A/C |

---

## 4.3 集成边界

- **MCP server 进程**：单测用假工具列表，不依赖真实 server。
- **Lifecycle / provider**：确认每步 `resolvePromptTools` 使用更新后的 loaded 集。
- **Subagent**：独立 `contextScopeId` 的 loaded 与父 session 互不污染（复用现有测例并加一条 query）。

---

## 4.4 回归清单

- improve-3：无 MCP 不退回全量 schema 顶层
- 单次/会话上限 8
- admit stub description 仍在 LLM `tools[]`
- `disposeSession` 清理 loaded
- 既有 `dynamic-tool-menu.unit.test.ts` / composition MCP cases 全绿

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| Exact 兼容 | 旧 `tools` 调用行为不变 | T-B1 + 既有单测 |
| 可检索 | 描述性 query 能稳定命中夹具工具 | T-A1、T-B2 |
| 语料正确 | 索引不依赖 stub | T-A1 |
| 安全 | search 回传不含任何 description | T-B7 |
| 排名可预测 | 精确 rank 1；fuzzy 有稳定排序；load 严格按该顺序 | T-B3、T-B5、T-B5b、T-B8 |
| 误装可控 | 默认 `load:false`；精确命中也不自动 load；load 时可审计实际 loaded/limitReached | T-B2、T-B3、T-B5、T-B5b、T-B9 |
| 文档 | `docs/mcp` 关键段落已同步点菜+检索 | Phase C 人工 diff |
| 排期 | 本批不含 bash bg | 代码 diff 无 bash/task_* |
| 批次隔离 | 本批不含 Shell job 或 `memory_*` 清理 | 代码 diff 与独立 commit 审查 |

---

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| Prompt 注入藏在 MCP description，经 search 输出进对话 | 原始 description 仅用于索引；query 只回传 name + score | 名称本身仍受既有 safe local-name admission 约束 |
| 模型 `load:true` 一次灌满 8 个无关工具 | 默认 false；输出提示剩余槽 | 无 unload → session 内无法换血 |
| load 顺序与返回顺序不一致 | 一个最终 ranking 同时驱动 candidates 与 menu.select | 需以 T-B9 锁定，避免后续重构分叉 |
| 索引与 available 不同步 | 单一串行/合并 runner + revision latest-wins；registry/menu/corpus 同快照提交或一起清空 | T-C5 锁定旧 in-flight 结果不可覆盖新状态 |
| 把 skill 名丢进 MCP 索引 | 语料只来自 MCP adapt 路径 | 代码审查防抽象「大一统 Search」 |
