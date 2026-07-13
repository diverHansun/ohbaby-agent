# system-prompt improve-3 · 冗余清理、工具三类菜单与数据流收敛

> 状态：**已实施并完成自动化验收与独立审查；真实凭据环境的 provider/MCP smoke 可按发布环境另行运行。**
> 日期：2026-07-13
> 落点：`docs/core/system-prompt/improve-3/`
> 承接：improve-1（资产/分层架构）→ improve-2（提示词文本）→ **本批（归属清晰、MCP 点菜、删死路径）**

## 1. 议题

主 Agent / subagent 的 system-prompt 与 context、工具暴露之间存在偶然复杂度：

- 工具 `description` 同时进入 `<tool_guidance>` 与原生 `tools[]`（双份）
- MCP 工具默认永久全量顶层可见，缺少按需点菜
- `ask.md` 与 `FALLBACK_SYSTEM_PROMPT_PROVIDER` 为未接线/误导路径
- Subagent 缺少安全护栏；工具白名单未覆盖 skill / MCP 披露；`permission.mcp` 未真正接线

本批目标：**内容归属清晰（KISS、无双模式）**、**统一三类工具菜单**、**理清 system prompt 单一真源**、**补 subagent 护栏并接入内置/MCP/skills**。不为 system-prompt 设 token 硬上限。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状与问题（代码锚点） |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：方案、改动面、分阶段 DoD |
| [03-reference-projects.md](./03-reference-projects.md) | claude-code / codex / kimi-code / opencode 借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收门 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

## 3. In scope

- 关掉 tool description 进 `<tool_guidance>` 的复读；system 只保留跨工具策略（`base.md` 等）
- 统一三类菜单：**内置顶层** / **MCP 经 `select_tools` 点菜** / **Skills 经 `skill` 元工具**（无 MCP 时第 2 类为空，**不**退回全量灌顶层）
- `select_tools` + lifecycle **每步重算** `tools[]`；OpenAI-compatible 与 Anthropic 均走现有 provider `request.tools` 转换
- 删除 `ask.md` 及 `"ask"` task 链路；删除 FALLBACK / 误导性 `RuntimeAgent.systemPrompt`
- Subagent：安全护栏进 `subagents/base.md`；接入内置 + skills + MCP（点菜）；独立 context / loaded 集；审批对齐用户设置
- UI（web/tui）：隐藏 `select_tools` 的请求与结果（对齐 todo 隐藏模式）
- MCP description 进入 LLM 可见 `tools[]` 前：安全扫描 + 长度 cap
- 同步更新 `docs/core/system-prompt/` 权威模块文档中与本批冲突的表述

## 4. Out of scope

- OpenCode Context Epoch / Claude section memo 全套 prompt-cache 基建
- Kimi 式 `messages[].tools` 协议
- 为 system-prompt 设 token 硬上限或预算仪表盘
- Skill 大改（把 listing 从 `skill` description 迁到 attachment/SystemContext）——可后续批次
- MCP resource/prompt 工具的渐进披露（本批只覆盖 callTool 类 MCP）
- 语义搜索式 MCP discovery（MVP 为公告 + 精确点名；搜索可后续增强）
- `permission.mcp` 全面产品化接线以外的权限体系重构（本批只去掉死配置误导，审批走现有用户设置）

## 5. 与既有文档的关系

| 文档 | 关系 |
|------|------|
| [../architecture.md](../architecture.md) / [../dfd-interface.md](../dfd-interface.md) / [../goals-duty.md](../goals-duty.md) | 权威模块文档；本批实施后需同步「工具 guidance / ask / FALLBACK」相关段落 |
| [../improve-1/](../improve-1/) | 分层与 `.md` 资产化——保留 |
| [../improve-2/](../improve-2/) | 文本灵魂——保留；其中「toolSnippets 进 guidance 高内聚」结论由本批**修正归属**（跟工具走，但只进原生 schema） |
| [../improve-2/2026-06-30-adr-system-prompt-decisions.md](../improve-2/2026-06-30-adr-system-prompt-decisions.md) | ADR-2 删除 promptGuidelines 仍有效；本批进一步收缩 `<tool_guidance>` |

## 6. 开发闸门

1. [x] 用户审阅并确认本目录 00–04
2. [x] 按 02 分阶段实施
3. [x] 按 04 完成自动化测试与验收
4. [x] 独立验收会话对照 02/04
