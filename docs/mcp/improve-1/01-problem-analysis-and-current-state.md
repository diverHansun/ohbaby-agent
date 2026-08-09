# 1. 问题基线与当前实施状态

> 时间口径：2026-08-09，仓库 `ohbaby-agent` 当前主干实现（improve-3 MCP 点菜已落地；本议题尚未改代码）。
> 范围：MCP 发现 / `select_tools` / 公告层 / admit；不含 bash 后台（见 `docs/shell/improve-3/`）。

---

## 1.1 问题陈述

1. **MCP 只能精确点名**：模型必须从 `<mcp_tools>` 里的 `mcp_s…_t…` 编码名猜对，工具一多就点不中或空转。
2. **无检索层**：仓库内无 BM25 / 倒排 / fuzzy；`select_tools` schema 仅 `tools: string[]`。
3. **索引语料若做错会失效**：`admitMcpTool` 把原始 description 换成固定 stub；若 BM25 读 admitted `Tool.description`，语料无语义。
4. **点菜槽位紧张且不可释放**：`PER_SELECTION = PER_SESSION = 8`，无 unload；误装会占满 scope。
5. **模块文档滞后**：`docs/mcp/*.md` 仍偏「启动全量 register、不监听 list_changed」，与 improve-3 代码分叉。
6. **`load:true` 的选择范围曾未定义**：必须规定 query 候选是只取精确命中还是按排名依次点菜，否则会改变误装风险。
7. **检索结果的安全字段形状曾未冻结**：若回传原始或截断 description，会把仅供索引的未信任文本重新带回模型上下文。

---

## 1.2 已确认的产品/技术分界

引用 [00-discussion.md](./00-discussion.md)：

```text
Builtin  ──常驻 schema──► tools[]
Skill    ──元工具 exact──► 按需正文
MCP      ──公告名 + select_tools(exact|BM25)──► 点菜后 schema
              ▲
         ToolScheduler（只调度执行，不负责发现检索）
```

- 扩展 **现有** `select_tools`，不新建 `search_tools`。
- 索引用 **准入前原始 description**；LLM 可见仍可 stub。
- 本批不做统一索引、embedding、unload、skill/builtin BM25。

---

## 1.3 MCP 发现与点菜现状

### 1.3.1 goals-duty

| 文档说 | 代码做 | Gap |
|--------|--------|-----|
| `docs/mcp/goals-duty.md`：工具发现 = listTools + 转换；阶段不监听 list_changed | `McpClient` 监听 `tools/list_changed`；composition 有 `refreshMcpTools`；另有 `select_tools` 点菜 | 文档未写「LLM 披露 vs 执行注册」双层；未提检索职责 |
| improve-3：MCP 公告 → exact select → schema | 已落地 | 本批要在其上加 BM25 |

职责现实：`mcp` 管连接/list/adapt/admit/menu；`composition` 管 register + LLM 过滤 + accessGuard；`system-prompt` 渲未加载名；`tool-scheduler` 只管执行。

### 1.3.2 architecture

主链路（代码）：

```text
McpClient.listTools
  → McpManager.getAllTools
  → adaptMcpTool          # 保留原始 description；本地名 mcp_s{len}_…_t{len}_…
  → admitMcpTools         # 扫描 + cap；description → FIXED stub
  → ToolScheduler.register（执行层可全量）
  → McpToolMenu.setAvailable
       ├─ resolveMcpToolNames → <mcp_tools> 公告（未 loaded 精确名）
       ├─ resolvePromptTools  → LLM tools[] = builtins + loaded MCP
       └─ select_tools / accessGuard
```

锚点：

- `packages/ohbaby-agent/src/mcp/core/client.ts` — `listTools`、list_changed
- `packages/ohbaby-agent/src/mcp/core/manager.ts` — 多 server 聚合、invalidate
- `packages/ohbaby-agent/src/mcp/integration/tool-adapter.ts` — `adaptMcpTool` / `localToolName`
- `packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.ts` — admit、`McpToolMenu`、`createSelectToolsTool`
- `packages/ohbaby-agent/src/core/system-prompt/layers/mcp-tools.ts` — 公告层
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` — 装配与 refresh

### 1.3.3 data-model

| 概念 | 现状 | 锚点 |
|------|------|------|
| 本地名 | `mcp_s{len}_{server}_t{len}_{tool}` | `tool-adapter.ts` |
| 准入 | 通过后 `description = FIXED_MCP_TOOL_DESCRIPTION` | `admitMcpToolUnchecked` |
| Scope | `sessionId` + optional `contextScopeId`；key `sessionId\0scope` | `McpToolMenuScope` |
| 上限 | `MAX_MCP_TOOLS_PER_SELECTION = 8`、`MAX_MCP_TOOLS_PER_SESSION = 8` | `dynamic-tool-menu.ts` |
| select 结果 | `loaded / alreadyLoaded / limitReached / unknown` | `McpToolSelection` |
| 原始 description 旁路 | **不存在** | — |
| query 候选返回形状 | **不存在** | 需要冻结为 `{ name, score }`，不得夹带 description |

### 1.3.4 dfd-interface

- **刷新**：`refreshMcpTools` → admit → register → `setAvailable`；rejected → notice。
- **每步 LLM**：未 loaded 只进公告；loaded 进 `tools[]`（schema + stub description）。
- **点菜**：`select_tools({ tools })` → `menu.select` → 下一步可见。
- **护栏**：未 select 的 MCP 被 `accessGuard` 拒绝。
- **接口缺口**：无 `query`；`McpToolMenu` 只存 name Set，无语料/索引。

### 1.3.5 use-case

| 用例 | 现状 |
|------|------|
| 工具少、名可猜 | 公告 → exact select → 用 | OK |
| 工具多 / 名难读 | 只能猜编码名 | **痛点** |
| 一次选满 8 | 占满 session/scope 槽 | 无 unload |
| Subagent | 独立 `contextScopeId` loaded 集 | 已隔离；仍无搜索 |
| 无 MCP | `select_tools` 仍注册；公告空 | 符合 improve-3 |

### 1.3.6 non-functional

- **安全**：admit 前扫 description/schema；stub 降低 LLM 侧注入面。BM25 若把原始 description 回传给模型，会重新打开注入面。
- **性能**：执行层仍可全量 register；披露只减 LLM 可见面。索引需随 `refreshMcpTools` / list_changed 重建。
- **可观测**：rejected 仅 notice；无检索 metrics。

### 1.3.7 test

- 有：`dynamic-tool-menu.unit.test.ts`（admit/上限/scope）、`composition.unit.test.ts` MCP 用例、UI 隐藏 `select_tools`。
- 无：任何 BM25 / query 模式测试。

---

## 1.4 跨模块一致性

| 模块 | 关系 | 一致性问题 |
|------|------|------------|
| system-prompt improve-3 | 点菜权威已落地 | 本批应交叉引用，不回退全量顶层 |
| tool-scheduler | accessGuard / register | 发现逻辑不应渗入 scheduler |
| skill | catalog 在元工具 description | 勿与 MCP 共用索引（00 已禁） |
| docs/mcp 权威文档 | 过时 | 实施后需同步 |

---

## 1.5 改动影响面（现状视角）

预期会动到的区域（方案见 02，此处仅标热点）：

- `mcp/integration/dynamic-tool-menu.ts`（schema + 行为）
- 新增轻量索引模块（mcp 包内）
- `composition.ts`（refresh 时重建语料）
- `tool-adapter` / admit：旁路保存原始 description
- system-prompt / provider 文案中对 `select_tools` 的说明
- 单测与（可选）docs/mcp 权威同步

---

## 1.6 SWE 原则审视摘要

- **偶然复杂度**：缺检索导致模型多轮瞎点，是产品缺口；上统一 discovery 或 embedding 会引入更多偶复杂度 → 拒绝。
- **信息隐藏**：原始 description 对索引可见、对 LLM tools[] 可仍 stub，分层正确。
- **YAGNI**：不做 unload、不做跨源索引、不做独立 `search_tools`。
- **可逆性**：扩展 `select_tools` 参数为可逆增量；改变 LLM 可见 description 策略需更谨慎（本批默认保持 stub）。

---

## 1.7 与既有文档关系

| 文档 | 关系 |
|------|------|
| `docs/core/system-prompt/improve-3/*` | 前置已实施；本批增强发现 |
| `docs/mcp/{goals-duty,architecture,dfd,data-model,test}.md` | 权威但漂移；实施后更新 |
| `docs/shell/improve-3/` | 姐妹批次，本批之后 |
| 笔记 `2026-08-07-ohbaby-agent-tools-upgrade.md` | 背景；P0 债不并入本批 |

---

## 1.8 承重问题 → 02 入口

| ID | 问题 | 02 回应入口 |
|----|------|-------------|
| M1 | 无 BM25 / query | 扩展 `select_tools` |
| M2 | stub 导致索引语料断裂 | 旁路原始 description corpus |
| M3 | exact 与 search 共存契约 | schema 互斥 + 行为表 |
| M4 | 双 8 上限与误装 | search 默认不强制占槽；load 策略明确 |
| M5 | list_changed 后索引陈旧 | refresh 重建索引 |
| M6 | `load:true` 未定义选择全部还是按排名加载 | 固定 top-limit 排名顺序，复用 menu.select 的逐个限额行为 |
| M7 | search 回传 description 的安全形状未定 | 仅回传 name + score；原始 description 永不离开索引 |
| M8 | 文档漂移 | 同步 docs/mcp + select 说明 |
