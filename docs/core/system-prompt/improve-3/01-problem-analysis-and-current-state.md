# 1. 问题基线与当前实施状态

> 时间口径：2026-07-13，以仓库当时代码为基线（规划会话，尚未按本批改代码）。
> 范围：`packages/ohbaby-agent` 的 system-prompt、context、agents、MCP、skill、lifecycle/runner，以及 web/tui 对内部工具的 transcript 隐藏。

---

## 1.1 问题陈述

1. **工具描述双通道**：同一 `description` 进入 `<tool_guidance>`（system）与原生 `tools[]`，归属不清，且扩大不可信 MCP 文本的注入面。
2. **MCP 永久全量顶层**：`getAllTools()` → 全量 `register` → run 创建时快照进 `tools[]`；无按需点菜；与 Skills 的渐进披露不一致。
3. **System prompt 双真相**：生产 LLM 走 `createSystemPromptProvider`；`AgentManager` 默认 `FALLBACK_SYSTEM_PROMPT_PROVIDER` 写入 `RuntimeAgent.systemPrompt`，生产几乎不用该字段却易误导。
4. **死路径 `ask`**：`ask.md` / `PrimaryTaskKind "ask"` 存在，运行时 `taskKindResolver` 永不返回 `"ask"`。
5. **Subagent 不完整**：缺安全护栏；`tools.include` 未含 `skill`/`select_tools`/MCP 披露入口；explore 任务 prompt 要求只读，但配置含 write/edit，且 `permission.mcp` 未进 evaluator。

---

## 1.2 已确认的产品/技术分界

见 [00-discussion.md](./00-discussion.md)。示意：

```text
System（身份/策略/任务契约/护栏）
  ≠ 工具接口（原生 tools[]）
  ≠ 三类菜单披露（内置顶层 / MCP select / Skill 元工具）
  ≠ 历史（可压缩）
```

---

## 1.3 system-prompt 模块现状

### 1.3.1 goals-duty

- 文档主张：跨工具行为在 `base.md`；工具 description/schema 只描述接口（`docs/core/system-prompt/goals-duty.md`）。
- **Gap**：运行时仍把 description 灌进 `<tool_guidance>`，与「只描述接口」的展示层冲突。

### 1.3.2 architecture

- 主路径：`SystemPrompt.assemble()` 7 层（primary）/ 5 层（subagent）— `assembler.ts`。
- Provider：`createSystemPromptProvider` — `assembler.ts` ~254+；接线于 `adapters/ui-runtime/composition.ts`。

### 1.3.3 data-model

- `PrimaryTaskKind = "ask" | "plan" | "agent"` — `types.ts`；ask 资产存在但未接线。
- `toolSnippets` → `generateToolGuidancePrompt` — `layers/tools.ts`。

### 1.3.4 dfd-interface

```text
toolDetailsProvider: description → toolSnippets
  → safeToolSnippets(scan) → <tool_guidance>
并行：getAvailableTools → toOpenAiTools → streamChatCompletion tools
```

- 扫描只保护进 system 的 snippet（`assembler.ts` `safeToolSnippets`），**不**保护原生 `tools[]`。

### 1.3.5 use-case

- 每轮 `prepareTurn` → 完整重建 system（`context-manager.ts`）；压缩只动 history。

### 1.3.6 non-functional

- Custom instructions 有 50KB 上限；MCP description **无**长度 cap（进 guidance / tools[]）。
- Skill listing 有字符预算（`skill/tool.ts`）。

### 1.3.7 test

- `provider.test.ts`：恶意 MCP description 可从 guidance omit。
- `prompt-assets.unit.test.ts`：含 ask 资产断言。
- **缺**：select_tools / 每步 tools 重算 / FALLBACK 删除后的契约测试。

---

## 1.4 context / lifecycle / runner 现状

| 点 | 锚点 | 问题 |
|----|------|------|
| 每步 prepareTurn | `lifecycle.ts` 循环内调用 | system 每轮全量重建（本批接受；不上 memo） |
| tools 快照 | `runner.ts` `toOpenAiTools` + run 创建写入；`lifecycle` 复用 `params.tools` | **无法**在 select 后于同 run 扩顶层 tools，除非改每步 resolve |
| 序列化 | `serializer.ts` | 无 message-level tools；本批也不引入 |
| Provider | `openai-compatible.ts` / `anthropic.ts` `convertTools` | **两边都已支持**每请求 `tools`；适合每步重算方案 |

---

## 1.5 agents / FALLBACK / ask 现状

| 点 | 锚点 | 问题 |
|----|------|------|
| FALLBACK | `agents/manager.ts:22-44` | primary 几乎只返回 addon；与真实 assemble 不等价 |
| getRuntimeAgent | `manager.ts:163-184` | 填充 `systemPrompt`；生产 `subagent-host` / `AgentService` **不用**该字段做 LLM |
| taskKind | `composition.ts` taskKindResolver | `plan` 或 `agent` only |
| ask 资产 | `prompts/primary/tasks/ask.md` | 死资产 |

---

## 1.6 MCP / Skills / 工具注册现状

| 点 | 锚点 | 问题 |
|----|------|------|
| MCP 全量 | `composition.refreshMcpTools` ← `mcpManager.getAllTools()` | LLM 与执行同一可见集 |
| 适配 | `mcp/integration/tool-adapter.ts` | description/schema 原样；无扫描 |
| Skills | `skill/tool.ts` `buildSkillToolDescription` | **已渐进披露**（listing 预算 + 调用后正文）——相对健康 |
| Subagent include | `agents/builtin/explore.ts` 等 | 无 `skill*`；无 MCP 名；explore 含 write/edit 但 task 写 read-only |
| permission.mcp | `agents/types.ts`；`explore` `mcp: "deny"` | `permission/evaluator.ts` **不读取**该字段 |

---

## 1.7 Subagent prompt 现状

- `prompts/subagents/base.md`：bounded task、不加载 custom instructions、不嵌套 subagent；**无**破坏性操作/不可信内容等安全护栏。
- `tasks/explore.md`：明确 `Operate read-only`——**prompt 偏好**，非权限引擎。
- Subagent assemble：无 primary base、无 custom、无 memory（`assembler.ts` isSubagent 分支）——方向正确，护栏不足。

---

## 1.8 UI 隐藏内部工具现状

- `HIDDEN_TRANSCRIPT_TOOLS = todo_read/todo_write` — `run-stream-adapter.ts`、`persistent-store.ts`；TUI 亦有过滤。
- **无** `select_tools`（尚未存在）。

---

## 1.9 跨模块一致性

| 文档说 | 代码做 | Gap |
|--------|--------|-----|
| 行为在 base，接口在 tool | description 仍进 guidance | 展示层重复 |
| improve-2：guidance 高内聚正确 | 归属对、双份错 | 本批修正 |
| MCP list_changed 动态刷新 | 全量 re-register 进顶层 | 缺 LLM 可见层披露 |
| Agent permission.mcp | 配置存在 | evaluator 未用 |

---

## 1.10 改动影响面（现状视角）

- `core/system-prompt/**`、`adapters/ui-runtime/composition.ts`
- `core/lifecycle/lifecycle.ts`、`core/agents/runner.ts`、tool-scheduler
- 新 `select_tools` + 动态工具辅助
- `mcp/**`（loadable 列表 / schema 扫描入口）
- `agents/manager.ts`、builtin agent 配置、`subagents/base.md`
- UI：`HIDDEN_TRANSCRIPT_TOOLS`（web adapter + tui）
- 文档：`docs/core/system-prompt/*`、相关 MCP 文档交叉引用

---

## 1.11 SWE 原则审视摘要

| 原则 | 观察 |
|------|------|
| 偶然 vs 本质复杂度 | 双份 description、FALLBACK、ask 死路径属偶然复杂度 |
| KISS / YAGNI | 用户确认**无双模式**；不上 Epoch/`messages[].tools` |
| 信息隐藏 | 外部 MCP 文本不应进入身份层 system |
| 单一真源 | system 组装应唯一；RuntimeAgent.systemPrompt 误导 |

---

## 1.12 与既有文档关系

- improve-2 ADR-2（删 promptGuidelines）有效；本批继续收缩 guidance。
- improve-2「toolSnippets 高内聚」→ 本批改为：**定义跟工具，展示只走原生 schema**。
- 权威 `architecture.md` / `goals-duty.md` 在实施后需改「guidance 含 description」类表述。
