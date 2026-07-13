# 讨论记录与已确认要点

> 2026-07-13 与用户讨论定稿。正式方案见 01–04。
> 本文件只冻结**已确认结论**；推理见 01，实施见 02。

---

## 1. 背景与动机

improve-1/2 已完成 system-prompt 资产分层与文本升级。当前暴露的问题是**归属与数据流**：

- 工具接口描述双份发送（system `<tool_guidance>` + 原生 `tools[]`）
- MCP 默认永久全量顶层，Skills 已有渐进披露，三类工具策略不一致
- `ask.md`、FALLBACK provider 造成死路径 / 双真相
- Subagent 缺安全护栏；工具与 MCP/skills 接入不完整

动机是修偶然复杂度与安全边界，**不为压 token 设硬指标**。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/core/system-prompt/improve-3/` |
| 成功标准 | 内容归属清晰、单一 system 真源、三类菜单一致、安全护栏到位；**不**设 system-prompt token 硬上限 |
| 工具三类菜单 | **1. 内置**：永久顶层 `tools[]`；**2. MCP**：公告名字 → `select_tools` 精确点名 → 下一步顶层带 schema；**3. Skills**：`skill` / `skill_resource` 元工具 + 按需正文（保持现有渐进披露） |
| 无 MCP 时 | 第 2 类公告为空；**不**退回「全量 MCP schema 永久顶层」；**无双模式切换**（KISS） |
| 点菜实现 | `select_tools` + lifecycle **每步重算** `tools[]`；经现有 OpenAI-compatible **与** Anthropic provider 的 `request.tools` 转换 |
| 明确不用 | Kimi `messages[].tools`；Claude/Codex 专有 defer_loading / tool_search 作为主路径 |
| `<tool_guidance>` | 默认不再复读各工具 `description`；跨工具策略留在 `base.md` / subagent base |
| MCP schema 防护 | 进入 LLM 可见 `tools[]` 前：`scanPromptLikeContent` + 长度 cap |
| FALLBACK | **删除** `FALLBACK_SYSTEM_PROMPT_PROVIDER`；理清数据流；`RuntimeAgent` 不再暴露误导性 `systemPrompt`（或等价清理） |
| ask | **本批删除** `ask.md` 及 `PrimaryTaskKind "ask"` 相关未接线链路 |
| Subagent prompt | **不**继承主 Agent 身份/全文 base；补充**安全护栏**短节 |
| Subagent 工具 | 接入内置 + skills + MCP（经点菜）；独立 session context 与 loaded 集 |
| Subagent 审批 | 与主 Agent **对齐用户设置**（同一 permission evaluator）；不以死配置 `permission.mcp` 假装禁 MCP |
| explore「只读」 | **system-prompt 任务契约偏好**（`explore.md`）；不是独立审批体系 |
| UI | web/tui **不展示** `select_tools` 请求与结果（对齐 `todo_read`/`todo_write` 隐藏）；内部历史仍保留给模型 |
| 静态/动态 | 本批做到**内容归属清晰**；不上 Context Epoch / section memo 全套 |
| 发布策略 | 三类菜单为**正式默认路径**；不为「全量灌 ↔ 点菜」做 experimental 双主路径 |

---

## 3. 已确认：边界（不做的事）

| 项 | 说明 |
|----|------|
| Prompt cache Epoch / section memo | 后续可选 |
| `messages[].tools` | 不用 |
| Skill listing 迁出 tool description | improve-4+ |
| MCP resource/prompt 渐进披露 | 本批不做 |
| 语义搜索 MCP discovery | MVP 精确点名即可 |
| system-prompt token 硬上限 | 明确不做 |
| 权限体系大重构 | 只清死配置误导；审批跟用户设置 |
| 双模式「关闭披露 → 全量顶层」 | 明确不做 |

---

## 4. 已确认：与关联议题的关系

| 关联 | 关系 |
|------|------|
| improve-1 | 分层/`md` 资产——保留 |
| improve-2 | 文本——保留；修正「guidance 双份高内聚」为「接口只进 schema」 |
| `docs/core/system-prompt/*.md` | 实施后同步权威文档 |
| `docs/mcp/` | Dynamic Tool Refresh 仍是 list_changed 全量 re-register 执行层；本批在 **LLM 可见层**加披露，执行注册可仍全量 |

---

## 5. 参考项目（摘要）

| 项目 | 借鉴 | 不照搬 |
|------|------|--------|
| kimi-code | 公告 + `select_tools` 交互；subagent 同样披露；description byte-stable | `messages[].tools` |
| claude-code | 策略 vs schema 分离；动态列表勿写进静态 tool description；UI/attachment 增量思路 | Anthropic-only defer_loading 作唯一路径 |
| codex | base 与动态 world_state 分离意识 | 子代理继承全量 base；绑定 tool_search API |
| opencode | Skills 与正文分离；瘦 subagent | 默认 MCP 仍全量顶层；Epoch 过重 |

细节见 [03-reference-projects.md](./03-reference-projects.md)。

---

## 6. 用户确认记录

- 确认落点 `docs/core/system-prompt/improve-3/`；不纠结 token 上限。
- 确认删除 FALLBACK；理清数据流。
- 确认 subagent 补安全护栏，并接入内置/MCP/skills。
- 确认 MCP 点菜进本批；UI 隐藏 `select_tools`。
- 确认实现用每步 `tools[]`（双 provider），不用 `messages[].tools`。
- 确认**不要双模式切换，保持 KISS**；无 MCP 时仍走三类菜单（第 2 类为空）。
- 确认本批删除 `ask.md` 及不相干链路。
- 确认 explore 只读是 prompt 偏好；审批对齐用户设置。
- 2026-07-13：用户确认本版本，要求撰写文档 → 自检 → 再开发。
