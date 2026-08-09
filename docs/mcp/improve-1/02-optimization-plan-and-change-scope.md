# 2. 优化方案与改动面

> 执行契约：当前开发批次按本文 + [04](./04-test-and-acceptance.md) 实施。

---

## 2.1 方案总览

在 improve-3 精确点菜之上，为 MCP 轨增加 **BM25 检索**，能力并入现有元工具 `select_tools`：

```text
refresh / list_changed
  → adapt（保留原始 description）
  → admit（LLM 可见 description 仍 stub；未通过的不入 available）
  → 写入 SearchCorpus（仅 admitted/available；语料 = name + server + tool + 准入前原始 desc）
  → register → setAvailable

select_tools:
  A) tools[]     → exact load（现状）
  B) query       → BM25 top-k → 仅返回 { name, score } 排名候选
                  → load:true 时按候选排名依次占槽
```

不新建全局 discovery；builtin/skill 不进该索引。

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 工具面 | 扩展 `select_tools` | 00 确认；少一个 builtin | 独立 `search_tools` | schema 变复杂，需互斥校验 |
| 算法 | BM25（纯 TS 自研或轻量依赖） | Codex/Grok/Kun 验证；短文档合适 | 纯 substring；embedding | 需维护分词/索引 |
| 语料 | localName + mcpServer + mcpToolName + **admit 前** description | stub 无语义；编码名弱 | 只索引 stub；索引整份 schema | 需旁路存储 |
| Exact 与 search | `query` 精确命中 available 名 → **rank 1、score=1**；其余 BM25 候选归一化到 `[0,1)` 并按 score 降序、name 升序稳定排序；**是否加载只看 `load`**（默认 false）。`tools[]` 始终 exact 加载 | 排名可解释且无隐式副作用 | query 精确命中自动 load；未归一化分数 | 精确名想只加载自身应调用 `tools[]`；query load 仍按完整排名处理 |
| Search 默认是否 load | **`load` 默认 `false`** | 无 unload，防误占 8 槽 | 默认 auto-load | 可能多一轮 exact select |
| `load:true` 的范围 | 将 query 的 top-`limit` 已排序候选逐个交给 `menu.select`；直到候选用尽或槽满 | 与现有 select 的顺序/限额语义一致；不会因精确命中走特殊分支 | 只加载 exact；一次加载所有 registry 工具 | 默认 false 仍是防误装主护栏 |
| 结果回传 | 候选固定为 `{ name, score }`；`output` 保持简短选择摘要，`metadata.mcpSelection` 记录候选与选择结果；**不**回传任何 description | 原始描述不再形成第二条 prompt 注入通道 | 截断片段；完整原始 desc | 模型需 load 后阅读 callable schema，且 description 仍是固定 stub |
| top-k | `limit` 默认 5，最大 8 | 对齐点菜上限心智 | 无上限 | — |
| LLM 可见 desc | 保持 stub | 安全面已验证 | 恢复原文进 tools[] | 本批不做 |
| 索引归属 | `mcp` 包内（menu/manager 旁） | 与 refresh 同生命周期 | 塞进 tool-scheduler | — |

---

## 2.3 分阶段实施

### Phase A — Corpus 与索引（纵切）

- **目标**：refresh 后可对 available MCP 做 BM25 查询（库内 API），尚不改工具 schema。
- **改动**：
  - 新增例如 `packages/ohbaby-agent/src/mcp/integration/mcp-tool-search.ts`（tokenize + BM25 + `search(query, limit)`）
  - `adapt`/`admit` 路径旁路保存原始 description（字段或并行 Map：`localName → corpus doc`）
  - `composition.refreshMcpTools` / list_changed 回调：**重建索引**
  - refresh 使用单一串行/合并 runner：执行中收到新触发只置 dirty，当前轮结束后再刷新；每次触发递增 revision，旧 revision 的 in-flight 结果不得提交
  - manager 内部 `getAllTools` 不递归追逐 generation；最多 3 次 generation 检查、2 次实际 listTools，持续变化时返回最后一份成功快照但不缓存
  - ToolScheduler registry、menu available、search corpus 必须从同一份 admitted snapshot 提交；刷新失败时三者一起清空，保持现有 fail-closed 语义
- **DoD**：单测：建索引 → 用描述关键词命中目标工具；stub 文本不能作为唯一语料来源；refresh 后旧工具消失。

### Phase B — 扩展 `select_tools` 契约

- **目标**：模型可 `query` 发现候选，并按明确的 top-limit 排名策略选择性加载。
- **Schema（建议）**：
- **Schema（冻结）**：

```ts
{
  type: "object",
  additionalProperties: false,
  properties: {
    tools: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    query: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 8 },
    load: { type: "boolean" } // 仅与 query 联用；默认 false
  }
  // 基础约束由 schema 表达；字段组合由运行时矩阵校验
}
```

- **行为**：
  - 仅 `tools`：**始终**精确加载（旧语义不变）。
  - 仅 `query`：精确名候选（若有）固定排第 1、`score=1`；其余 BM25 候选按归一化 score 降序、name 升序，取 top-`limit`。
  - `query` 精确等于某 available 名：只改变候选排序；**不**因精确命中而隐式加载——仍遵守 `load`。
  - `load: false`（默认）：只返回检索结果，不改变 loaded 集。
  - `load: true`：把 top-`limit` 的名字按排名顺序交给 `menu.select`；已加载候选记录为 `alreadyLoaded`，不会耗新槽；后续候选持续选择直至用尽或 `limitReached`。
  - query 候选仅为 `{ name, score }`；原始 description 永不写入 `output` 或 metadata。选择结果沿用 `loaded/alreadyLoaded/limitReached/unknown`。

#### 参数组合矩阵（冻结）

| 输入 | 结果 |
|------|------|
| 非空 `tools`，无其它字段 | 有效：精确加载；重复名称沿用既有去重，未知名称进入 `unknown` |
| `tools + query` | 报错 |
| `tools + load`（即使 `load:false`） | 报错 |
| `tools + limit` | 报错 |
| 非空白 `query`，可选 `load/limit` | 有效；`load=false`、`limit=5` 为默认值 |
| 仅 `load` / 仅 `limit` / 二者同时但无 query | 报错 |
| `{}` / 空 `tools` / 空白 `query` | 报错 |
| query 无命中 | 成功，返回空 candidates 与空选择结果 |

Schema 负责类型、数组长度、整数范围等基础约束；运行时仍必须执行上表校验，避免不同 provider 对 JSON Schema 组合关键字支持不一致。
- **文案**：更新 `SELECT_TOOLS_DESCRIPTION` 与 system/provider 中相关说明；明确「精确命中 ≠ 自动加载」「query load 按排名逐个选择」。
- **DoD**：单测覆盖 exact `tools` 回归、排名稳定性、query 命中、精确命中 + load false/true、部分槽位、limit、limitReached、unknown、候选不泄露 description；UI 仍隐藏 `select_tools` transcript。

### Phase C — 文档与回归门

- **目标**：权威文档与验收对齐。
- **改动**：同步 `docs/mcp/goals-duty.md`、`dfd-interface.md`、`architecture.md`、`data-model.md`、`test.md` 中与点菜/检索冲突的段落；交叉引用 improve-3。
- **DoD**：04 验收清单通过；既有 MCP 点菜单测全绿。

---

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `src/mcp/integration/` | `mcp-tool-search.ts` (+ unit test) | `dynamic-tool-menu.ts` | — | 索引 + select 契约 |
| `src/mcp/integration/tool-adapter.ts` | — | 可选导出原始字段 | — | 便于建 corpus |
| `src/adapters/ui-runtime/composition.ts` | — | refresh 挂索引 | — | 生命周期 |
| `src/mcp/system-prompt.ts` | MCP 公告生成器 | — | — | MCP 文案归属 MCP 模块，通过 core 的通用 runtime prompt hook 注入 |
| `src/core/system-prompt/` | — | 将 MCP 专用字段收敛为通用 `runtimePromptsProvider` | `layers/mcp-tools.ts` | core 不反向依赖 mcp |
| `src/core/context/tool-metadata-projection.ts` | — | select_tools 的 mcpSelection 白名单 | — | 复用既有逐工具 metadata 投影 |
| `docs/mcp/*.md` | — | 同步 | — | Phase C |
| `docs/mcp/improve-1/` | — | 本批规划 | — | 已存在 |

---

## 2.5 API / 协议 / 迁移与兼容

- **向后兼容**：仅传 `tools` 的旧调用必须行为不变。
- **破坏性**：无（旧的合法 `tools` 调用保持兼容；过去未定义的字段组合现在明确报错）。
- **持久化**：索引纯内存；进程重启后随 refresh 重建；loaded 集语义不变。
- **Subagent**：共享同一 `select_tools` 实现；scope 仍按 `contextScopeId` 隔离。

**query 结果的局部 metadata 契约**：

```ts
{
  output: string; // 保持既有 selection summary；不含 description
  metadata: {
    mcpSelection: {
      candidates: Array<{ name: string; score: number }>;
      loaded: string[];
      alreadyLoaded: string[];
      limitReached: string[];
      unknown: string[];
    };
  };
}
```

- `candidates` 始终按最终排名顺序排列；`tools[]` 精确加载路径可返回空 candidates，保持旧 output 语义。
- `score` 是有限数值：精确 local name 为 `1`；非精确候选为 `[0,1)`。它用于排序与解释，不是“加载许可”。
- 该 metadata 仅为 `select_tools` 的局部扩展，并通过现有逐工具投影发送给模型；不是全局 response envelope。
- 原始 description、截断 description 和扫描片段均不得出现在 candidates、output 或 metadata。

---

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 原始 desc 经 search 输出注入 | query 只回传 name + score；原始 desc 仅留在索引 | 不存在 description 输出降级分支；若未来要暴露另开安全设计 |
| 误 `load: true` 占满槽 | 默认 false；load 时严格按 top-limit 排名、元数据报告 loaded/limitReached | 模型明确要批量加载时仍可能占满，必须改用 exact tools 控制 |
| BM25 质量差 | 保留 `tools[]` exact；query 精确名给 score=1 便于确认后再 load | feature 开关关掉 query 分支 |
| 精确命中隐式加载 | **禁止**：load 显式控制 | T-B5/B5b |
| 排名结果迭代不稳定 | exact rank 1；fuzzy score 降序、name 升序；metadata 保存最终顺序 | 语料变动会改变相关性，refresh 测试锁定一致性 |
| 依赖膨胀 | 优先小实现/单文件 | 去掉依赖，退回 exact-only |

---

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 体现 |
|---------|---------|
| 扩展 select_tools + BM25 | Phase B |
| 不新建 search_tools | 无新元工具 |
| 三轨分治 / Scheduler 不发现 | 索引在 mcp 包 |
| 不做 unload / embedding / 统一索引 | §2.8 |
| 先 MCP 后 bash | 本文件仅 MCP |
| query load 按排名逐个选择 | Phase B + §2.5 mcpSelection metadata |
| query 不回传 description | Phase B + §2.5 + 风险表 |

---

## 2.8 不在本批

memory_* 虚假 LLM 工具契约已单列到 docs/core/memory/improve-1/，本批不实现。

- 独立 `search_tools`、embedding、跨 builtin/skill 索引
- unload / 释放已点菜工具
- 恢复 MCP 原文 description 进 LLM `tools[]`
- bash background / `task_*`（`docs/shell/improve-3/`）
- 独立 background daemon
- 清理虚假 `memory_*` LLM 工具契约（第 3 批见 `docs/core/memory/improve-1/`）
- bash 双超时债：已由 `docs/shell/improve-3/`（Phase 1 `timeoutOwner: "tool"`）承接，非本批
