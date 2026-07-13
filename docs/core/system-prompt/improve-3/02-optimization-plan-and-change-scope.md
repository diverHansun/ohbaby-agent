# 2. 优化方案与改动面

> 给**后续开发会话**的执行契约。本规划会话不写业务代码。
> 约束来源：[00-discussion.md](./00-discussion.md)；问题证据：[01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md)。

---

## 2.1 方案总览

统一为**单一 system 真源 + 三类工具菜单 + 每步可见 tools 重算**：

```text
┌─ System（唯一）──────────────────────────────────────┐
│ createSystemPromptProvider → assemble()               │
│  base / task(plan|agent) / addon / roles              │
│  （无 tool description 复读）                          │
│  environment（不含全量 MCP 长名单；可指向点菜机制）     │
│  custom instructions（仅 primary）                    │
│ prepareTurn → + memory（primary）+ history            │
└──────────────────────────────────────────────────────┘

┌─ 三类菜单（正式默认，无双模式）────────────────────────┐
│ 1. 内置：永久顶层 tools[]                             │
│ 2. MCP：公告 <mcp_tools> 精确名称 → select_tools      │
│         → 下一步顶层带 schema（执行层仍可全量 register）│
│ 3. Skills：skill / skill_resource 顶层 + 按需正文     │
└──────────────────────────────────────────────────────┘

┌─ AgentManager ───────────────────────────────────────┐
│ 角色校验、tools 配置、maxSteps —— 不提供假 systemPrompt │
└──────────────────────────────────────────────────────┘
```

OpenAI-compatible 与 Anthropic 均消费每步 `request.tools`（现有 `convertTools` / Chat Completions tools）。

---

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| MCP 点菜协议 | `select_tools` + **每步** `tools[]` | 双 provider 已通；改动可控 | `messages[].tools`；Anthropic-only defer_loading | 顶层 tools 变化影响 cache（可接受） |
| 双模式回退全量 MCP | **不做** | KISS；00 确认 | experimental 关 → 全量灌 | 无 MCP 时第 2 类为空即可 |
| 内置是否点菜 | **否**（永顶层） | 避免每次 read 多一轮 | 三类全走 select | — |
| Skills | 保持元工具渐进披露 | 已健康 | 强行并入 select_tools | 两套披露并存（可接受） |
| tool_guidance | **默认空**（不再灌 description） | 归属清晰 + 少一条注入面 | 保留双份 | improve-2 文案需同步 |
| FALLBACK | **删除** | 单一真源 | 注入真 provider 进 Manager | 测试/类型要改 |
| ask | **删除链路** | 死资产 | 仅标废弃留文件 | 类型收窄 |
| Subagent MCP/skills | **接入** + 自有 loaded/公告 | 00 确认 | 主 Agent 独享披露 | agents 配置与白名单改造 |
| Subagent 审批 | 对齐用户 permission | 00 确认 | 依赖未接线 `permission.mcp` | 清理死配置 |
| UI | 隐藏 select_tools | 对齐 todo | 展示给用户 | 历史仍保留 |
| MCP schema 防护 | 扫描 + 长度 cap | 不可信外部文本 | 只扫 guidance | 需选 cap 数值（见 Phase） |

---

## 2.3 分阶段实施

### Phase A — 数据流收敛（FALLBACK / ask / guidance）

**目标**：单一 system 真源；去掉双份 description 与死路径。

**改动（示意）**：

| 动作 | 路径 |
|------|------|
| 删除 FALLBACK；调整 `getRuntimeAgent` | `packages/ohbaby-agent/src/agents/manager.ts`、`types.ts` |
| 删除 ask 资产与类型 | `prompts/primary/tasks/ask.md`、`tasks.ts`、`types.ts`、`templates.generated.ts`（经生成）、相关测试 |
| 删除 tool description snippets 与 `<tool_guidance>` 渲染 | `composition.ts`、`layers/mcp-tools.ts`、assembler 调用方 |
| environment：有 MCP 披露时不列全量 MCP 名长串 | `layers/environment.ts`、composition toolsProvider 语义 |
| 更新单测 | `assembler.test.ts`、`provider.test.ts`、`manager.unit.test.ts`、`prompt-assets.unit.test.ts`、`composition.unit.test.ts` |

**DoD**：

- [x] 生产路径仅 `createSystemPromptProvider`；无 FALLBACK；`RuntimeAgent` 无误导 `systemPrompt`（或字段移除且调用方已改）
- [x] 无 `ask` task kind / 资产；task 仅 `plan` \| `agent`（及 subagent kinds）
- [x] 组装结果中无「把各 tool.description 抄进 `<tool_guidance>`」；恶意 MCP description 测试改为覆盖 **tools[] 扫描**（见 Phase B）或删除过时 guidance 断言
- [x] `pnpm` 相关单测通过

---

### Phase B — 三类菜单：`select_tools` + 每步 tools 重算

**目标**：MCP 不进永久顶层；公告 + 点菜；双 provider 可用。

**核心机制**：

1. **执行注册**：可继续 `refreshMcpTools` 全量 register（执行期能 resolve）。
2. **LLM 可见集**（每步）：`builtins`（含 `skill*`、**始终注册的** `select_tools`）+ **本会话已 select 的 MCP**。
3. **公告**：每轮 system prompt 仅渲染 `<mcp_tools>`：已准入且未加载工具的精确本地名，加固定说明；无 MCP 或全部已加载时不渲染该层。不得写入 description、schema、server 返回值或另一条历史 diff 协议。
4. **`select_tools`**：入参 `tools: string[]`；更新按 `sessionId + contextScopeId` 隔离的 loaded 集；每个 session/context scope 最多加载 8 个，**下一步** `tools[]` 才含完整 schema。更新是同步的 run-to-completion 临界区；无 MCP、未知名或达到该 scope 上限时返回明确结果，**不**因此改回全量顶层。
5. **Provider**：lifecycle 每步 `resolveLlmTools()` → `streamChatCompletion({ tools })`；Anthropic `convertTools` 无需新协议。
6. **防护**：MCP description/schema 文本进可见 tools 前 `scanPromptLikeContent`；description 长度 cap（建议实现时定常数，如 2k–4k chars，写入代码常量并测）。
7. **compaction**：loaded 集由 composition 持有而非消息历史，context compaction 后保留；应用重启或状态无法恢复时清空，并重新公告当前可加载名。该策略须可测。

**改动（示意）**：

| 新增 | `packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.ts`、`core/system-prompt/layers/mcp-tools.ts` |
| 修改 | `lifecycle.ts`（每步 tools）、`runner.ts` / run-manager（弱化「创建时永久快照全部 MCP」）、`tool-scheduler`（llm vs execute 可见性）、`composition.ts`、`mcp/core/manager.ts`（loadable 列表 API）、system prompt 短说明（base 或 environment） |
| 隐藏 UI | `run-stream-adapter.ts`、`persistent-store.ts`、TUI 过滤：`select_tools` 加入 `HIDDEN_TRANSCRIPT_TOOLS`；公告不对用户气泡展示 |

**DoD**：

- [x] 无 MCP：行为 = 仅内置 + skill 元工具 + 始终注册的 `select_tools`（loadable 为空）；无报错；**不**退回全量灌顶层
- [x] 有 N 个 MCP：初始 `tools[]` **不含**其 schema；公告含名；`select_tools` 后下一步可调用
- [x] OpenAI-compatible 与 Anthropic 路径各有自动化或契约测试覆盖「每步 tools 变化」
- [x] `select_tools` 在 web/tui transcript **不可见**；模型历史仍可见
- [x] 恶意/超长 MCP description 被扫描并拒绝，不得静默污染

---

### Phase C — Subagent 护栏与工具接入

**目标**：瘦 prompt + 安全护栏；内置/skills/MCP 点菜；审批跟用户设置。

**改动**：

| 动作 | 路径 |
|------|------|
| 安全护栏短节 | `prompts/subagents/base.md`（+ 生成快照） |
| 点菜说明一句 | subagent base 或 task；与主 Agent 一致语义 |
| builtin 配置 | `explore.ts` / `research.ts` / `generic.ts`：保证 `select_tools`、`skill`、`skill_resource` 可见；MCP 经披露而非写死 `mcp_*` include；清理或标注无效的 `permission.mcp`（explore 的 `deny` 勿假装生效） |
| 白名单模型 | 倾向 exclude 禁用 `subagent_*` 控制工具，或 include 放宽到「内置+元工具」；避免永远列不全 MCP 名 |
| 独立 loaded/公告 | subagent context scope 自有披露状态（对齐 Kimi：子代理也有 select_tools） |
| explore 只读 | **保留** `explore.md` 任务偏好；不另建审批体系 |

**DoD**：

- [x] subagent system 含安全护栏；仍不含 primary 全文身份
- [x] subagent 能 skill / select_tools / 调已点 MCP（在用户 permission 允许下）
- [x] explore 只读仅体现为 task prompt；写操作走用户 permission，非死 `mcp: deny`
- [x] 相关单测 / 契约测通过

---

### Phase D — 文档与权威对齐

**目标**：模块权威文档与 improve-2 冲突表述更新。

**改动**：`docs/core/system-prompt/{architecture,data-model,dfd-interface,goals-duty,test}.md`；必要时 `docs/mcp/dfd-interface.md` 交叉引用「执行全量注册 vs LLM 可见披露」。

**DoD**：文档与代码一致；README 本目录闸门可勾选进入验收。

---

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `src/core/system-prompt/` | `layers/mcp-tools.ts` | assembler、composition、prompts、tests | `tasks/ask.md`、ask 类型 | MCP 精确名称公告；subagent base 护栏 |
| `src/mcp/integration/` | `dynamic-tool-menu.ts` | MCP adapter、测试 | — | `select_tools`、准入、防护与 session/context scope loaded 集 |
| `src/core/lifecycle/` | — | 每步 resolve tools | — | |
| `src/core/agents/` | — | runner | — | |
| `src/core/tool-scheduler/` | 可见性 API | registry/scheduler | — | |
| `src/core/context/` | 传递 `contextScopeId` 给 prompt provider | `context-manager.ts`、`types.ts` | — | |
| `src/mcp/` | loadable 列表 | adapter 扫描/cap | — | |
| `src/agents/` | — | manager、builtin、tests | FALLBACK | |
| `src/skill/` | — | 微调（若需与三类菜单文案对齐） | — | 不大改 |
| `src/adapters/ui-runtime/` | — | composition、run-stream-adapter | — | |
| `src/adapters/ui-state/` | — | persistent-store | — | |
| `packages/ohbaby-cli` TUI | — | transcript 过滤 | — | |
| `apps/ohbaby-web`（若另有过滤） | — | 对齐隐藏集合 | — | 以实际过滤点为准 |
| `docs/core/system-prompt/` | improve-3/* | 权威 md | — | Phase D |

---

## 2.5 API / 协议 / 迁移与兼容

| 项 | 说明 |
|----|------|
| Wire | **不**新增 `messages[].tools`；仅每请求顶层 `tools` |
| RuntimeAgent | breaking：移除或停止填充 `systemPrompt`；仅 agent 包内部/测试消费者 |
| PrimaryTaskKind | breaking：移除 `"ask"` |
| 会话兼容 | 首 turn 以 `<mcp_tools>` 公告当前安全且未加载的可选名；不依赖历史 diff |
| 配置 | 不引入「关闭则全量灌」主开关；若需紧急逃生，须文档标明非推荐且默认关闭（优先不实现） |

---

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 每步 tools 假设被多处快照 | Phase B 搜全 `params.tools` / run.options.tools 用法 | 临时恢复创建时全量 tools（仅紧急；与 00 冲突，需同步改 00） |
| 模型不会 select | base/environment 短说明 + 公告文案；测试用 fake LLM 脚本 | — |
| +1 LLM round 延迟 | 可批量 names；UI 隐藏降低体感 | 可接受（00） |
| compaction 丢 loaded | composition 内存集跨 compaction 保留；重启时清空并再公告 | — |
| 并发 select | 同步 run-to-completion 更新 + 会话级上限测试 | — |
| Anthropic/OpenAI 行为差 | 双路径测 | — |

---

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 体现 |
|---------|---------|
| 无双模式 KISS | §2.2 放弃回退全量；Phase B DoD「无 MCP」 |
| 双 provider | Phase B DoD |
| 删 FALLBACK / ask | Phase A |
| Subagent 护栏+工具 | Phase C |
| UI 隐藏 | Phase B |
| 不上 Epoch / messages[].tools | §2.2 |
| 不设 token 硬上限 | 全文无预算门禁；仅 MCP description cap（安全） |

---

## 2.8 不在本批（显式）

- Context Epoch / section memo
- `messages[].tools`
- Skill listing 架构迁移
- MCP resource/prompt 披露
- 语义搜索 discovery
- system-prompt token 硬上限
- 权限体系大重构

详见 [00 §3](./00-discussion.md)。
