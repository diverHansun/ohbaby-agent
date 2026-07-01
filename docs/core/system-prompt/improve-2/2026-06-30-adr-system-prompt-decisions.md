# ADR · system-prompt improve-2 架构决策记录

> 日期：2026-06-30
> 状态：Accepted（已实施）
> 范围：`packages/ohbaby-agent/src/core/system-prompt/` 及其消费方
> 背景文档：见同目录《发现与对比》《重写规格》《参考清单》。本文件只记录**决策与取舍**，不重复分析。

本轮（improve-2）在提示词文本重写之外，做了四个会影响后续维护的决策。每条按 Context / Decision / Consequences 记录。

---

## ADR-1：subagent 角色指引外置为 `.md` 资产 + `{{ROLES}}` 占位符

**Context**
`generateSubagentRolesPrompt()` 原先把整段 `<subagent_roles>` 指引硬编码在 `assembler.ts` 里，与"提示词即内容资产、`.md` 为单一事实源"的既定架构（improve-1）不一致。

**Decision**
新增 `prompts/primary/subagent-roles.md`（含 `{{ROLES}}` 占位符）+ `subagent-roles.ts` wrapper，经生成脚本进入 `templates.generated.ts`。assembler 在运行时用 role 列表**函数式替换** `{{ROLES}}`（`replace("{{ROLES}}", () => ...)`，避免 role 描述里的 `$&`/`$1` 被当作替换模式）。

**Consequences**
- ✅ 静态文案与代码分离，编辑无 TS 转义噪音。
- ⚠️ 引入一个"魔法字符串" `{{ROLES}}`：若 `.md` 误删占位符，`replace` 不报错、只会把字面量喂给模型。已用 `prompt-assets.unit.test.ts` 的占位存在断言兜底（非运行时 throw，避免炸掉整份提示词）。
- 约束：assembler 需在运行时拼接 role 列表（来自 agentManager），故该资产**不能**完全静态化。

---

## ADR-2：删除 `promptGuidelines` 通道

**Context**
`toolPromptGuidelines()`（原在 `composition.ts` 硬编码）被移除、工具使用规则统一进 `base.md # Tool Use` 后，`promptGuidelines` 端到端已无人喂——成为死路（types.ts / layers/tools.ts / assembler.ts / composition.ts 全链皆有，但无数据流经）。

**Decision**
完全删除该通道：`AssembleOptions.promptGuidelines`、`GenerateToolGuidancePromptOptions.promptGuidelines`、`tools.ts` 的 "Tool use rules:" 渲染块与 `uniqueNonEmpty` 助手、assembler 的 `toolDetailsProvider` 返回类型与传参、对应测试断言。

**Consequences**
- ✅ 减少 API 表面与"这字段是干嘛的"困惑；`<tool_guidance>` 只承载工具描述片段。
- ⚠️ 若将来要按"当前可用工具集"条件化渲染工具规则（如 oh-my-pi 的 feature-gate 模式），需重建该机制。依 YAGNI：现在不需要就不留空壳，且易于再加。
- 这是模块内部 API 的 breaking change，但无外部消费者（cli/sdk/server 均未使用）。

---

## ADR-3：`identity` → `base` 重命名 + 去除恒等间接层

**Context**
`base.md` 已从单纯 identity 扩为 9 节行为骨架，"identity" 一名名不副实（它承载的是整份 primary base）。且取一个常量要走 4 跳：`layers/identity.ts → prompts/identity.ts(纯别名) → primary/base.ts → 快照`。

**Decision**
- `layers/identity.ts` → `layers/base.ts`，`generateIdentityPrompt()` → `generateBasePrompt()`（直接引 `PRIMARY_BASE_PROMPT`，删除纯别名 `prompts/identity.ts`）。
- `SystemPrompt.getIdentity()` → `getPrimaryBase()`（与既有 `getSubagentBase()` 对齐）。
- `LayerType` 的 `"identity"` → `"base"`。

**Consequences**
- ✅ 命名诚实、间接层减少（4 跳→2 跳）。
- ⚠️ public API breaking change（`generateIdentityPrompt`/`getIdentity` 不再导出），但均为模块内部使用，无外部消费者。

---

## ADR-4：Agent 人设名 `ohbaby-agent` → `Lychee`（仅人设，不改包名）

**Context**
希望给 agent 一个亲和的自我认同名"荔枝"。但 `ohbaby-agent` 在仓库出现 ~441 次，绝大多数是**包名/路径/配置目录**（`packages/ohbaby-agent`、`import ... from "ohbaby-agent"`、`.ohbaby-agent/`、`OHBABY.md`）。

**Decision**
只改**人设**（`base.md` 第 1 行 `You are Lychee, …`），**不动**包名、目录、配置文件、记忆头等产品/包层面。人设名 ≠ 包名是业界常态（Claude↔claude-code、Gemini↔gemini-cli、Kimi↔kimi-code）。

**Consequences**
- ✅ 用户看到"Lychee"，工程/发布层仍是 ohbaby，互不干扰；改动面从 441 处收敛到 1 处。
- ⚠️ 存在人设(Lychee)与产品品牌(ohbaby)不一致：若日后要让 agent 产出物（如记忆文件头 `## Ohbaby Added Memories`）也显示 Lychee，是另一项独立的品牌改名决策，本轮不含。
- 连带更新了断言人设名的测试哨兵（primary-only sentinel 用 `"You are Lychee, an AI coding assistant"`）。
