# 讨论记录与已确认要点

> 2026-08-26 与用户讨论定稿。正式方案见后续 01–04。本文只保留已确认结论。

---

## 1. 背景与动机

improve-4～5 与联合回归已经把请求占用总量、tools-aware 分母和 provider cache 语义做准，但 UI 仍只有 `currentTokens / contextWindowTokens`。用户需要窗口**被什么占满**可解释，并要一条 cache 命中率的后端→前端通道；命中率不作为占用面板第一优先级。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 批次 / 落点 | `improve-6`，`docs/core/context/improve-6/` |
| 文档结构 | 前后端分离；Web / TUI 分别设计（01 三篇现状，02 后端 + `02-web-ui` + `02-tui`） |
| 关键改动清单 | 写入 02；承重项到符号 + 行号快照，禁止全量文件表 |
| 占用对象 | 只展示**主代理**当前窗口。子代理内部仍按 `sessionId + contextScopeId` 计量/压缩，不进用户主占用 UI |
| 计量入口 | 分桶不能只靠最终 `PreparedModelRequest.tools`（`toOpenAiTools` 丢 `source`）。Lifecycle 每步显式保留窄的 `ResolvedStepTools { definitions, requestTools }`；Context 同时消费实际请求 tools、带 `source` 的 definitions 与带来源元数据的 history。总量仍走现有启发式 + 校准 |
| 数字呈现 | 总量百分比与 `~used / window` 跟校准后的 `UiContextWindowUsage` 一致；分类行加 `~`。彩条**长度**跟总量百分比，**颜色比例**跟七类启发式之和，不强制各类精确加总等于总量 |
| 环形 UI | **Web 紧凑态使用小占用环**（hover 前可见）。TUI 不用环，也不做 hover/click |
| Web 交互 | 小环 → hover 粗信息（百分比 + `used / window`）→ click 彩条 + 七类数量。Click 面板**不含** cache |
| TUI 交互 | 不使用 hover/click；本轮底栏和 `/status` 均保留现有总占用，不展示七类，不做 ASCII 堆叠条 |
| `/status` | Web **已有** slash `/status` 卡片（`StatusCommandResult`），本批展示七类详细占用；TUI `/status` 本批仍为总量。Cache 行下一轮加入（设计已冻结，见 §2.4） |
| Cache（**下一轮实施**，本批只冻结设计） | 不画进占用彩条。显示口径：**session aggregate 唯一**（Cache-Read Share，公式见 §2.4）；run aggregate 后端继续计数作 session 累加原料，**前端不显示**。不完整轮**尽力而为**跳过，不降级整会话显示。文案极简：`Cache hit 61%` / `Cache hit —`。cached input 仍占窗口 |
| 显示语言 | 分类**显示名一律使用 §2.1 固定英文文案及大小写**，不用「工具」「子代理回复」等中文 |

### 2.1 占用七类（内部 key → 英文显示名）

| 内部 key | 英文显示名 | 量什么 |
|----------|------------|--------|
| `system-prompt` | System prompt | Ohbaby 控制的系统侧上下文：真实 `role: "system"`、拼进 system 的 memory，以及标记为 `model-context:runtime:v1` 的 runtime model context。runtime 物理上仍附着 initiating user message，不改变 wire role |
| `builtin-tools` | Built-in tools | `source === "builtin"` 的 **tool schema**。用户所说的 tools 即此类。`select_tools` 属于 builtin schema，不算 MCP |
| `mcp` | MCP tools | `source === "mcp"` 且已进入**本次请求** `requestTools` 的 schema。尚未 load 的 MCP 菜单属于 runtime model context，本轮归 `system-prompt` |
| `skills` | Skills | `source === "skill"` 的 schema，即 `skill` / `skill_resource` 的 description（含 `<available_skills>` 目录），对标 Cursor Skills 行 |
| `conversation` | Conversation | 普通用户、助手、普通工具 call/result；排除 summary、runtime model context 与 subagent exchanges。**模型调用 `skill` 后整份 SKILL.md 作为普通 tool result 进入本类，不算 Skills** |
| `summarized-conversation` | Summarized conversation | `context-summary` part 序列化后的 `<context_summary>` 消息；不再与普通 Conversation 双计 |
| `subagent-exchanges` | Subagent exchanges | 主会话里 `subagent_run` / `subagent_status` / `subagent_close` 的 call arguments + result/status/close（含 `<subagent_output>`）。子代理内部历史不进父 `PreparedModelRequest`；这些工具的 schema 仍算 `builtin-tools` |

有 composition 时零值类仍显示为 `~0`，七行布局稳定；来源不足时 composition **整体省略**，不画七个假零。

### 2.2 runtime model context 的归因与物理位置

- **占用归因**按内容所有者分类，不等同于 provider wire role。runtime 环境与 MCP 菜单由 Ohbaby 生成，因此归 `system-prompt`，不是用户 Conversation。
- **物理位置不改**：runtime part 继续附着 initiating user message，保持 improve-5 已有的稳定 system prefix 与缓存行为；本轮不调整 prompt cache 请求结构。
- 本轮不为 environment 与 MCP 菜单引入 typed contribution，不按 XML/tag 解析拆桶。若未来 runtime 菜单成为显著占用，再以新证据重开设计，避免过早抽象。

### 2.3 `module` 来源

`ToolSource` 含 `"module"`，文档原意是「各模块自带工具」。skill 已从 module 拆出。当前生产注册路径**没有** `source: "module"` 的工具（只出现在单测夹具）。本批：

- **不**为 Module 增加占用行；
- 若将来出现 module schema，token **并入** `builtin-tools`，不单独展示。

### 2.4 Cache 冻结设计（下一轮实施，本批不写代码）

> 依据知识库（本仓库外，Obsidian）：`Hansun-database/knowledge-base/computer-science/agent-harness/llm-client/2026-08-23-prompt-cache-api-fields.md` 与 `…/2026-08-23-kv-cache-vs-prompt-cache.md`。对标 dsh StatsLine（整会话累计命中率）。

| 决策项 | 结论 |
|--------|------|
| 显示口径 | **session aggregate 唯一**：`Cache-Read Share = ΣcacheRead / Σ(uncached + cacheRead + cacheWrite)`。**分母必须含 cacheWrite**，否则冷启动首轮（read=0、write 大）比率剧烈抖动 |
| run aggregate | 后端继续计数（`LifecycleTokenUsage.inputBreakdown` + `usageComplete` 已存在），作为 session 累加的原料；**前端不显示** |
| 不完整轮语义 | **尽力而为**：某轮 `usageComplete=false` 或无 `inputBreakdown` → 该轮跳过累加，session 桶继续显示；内部记 `incompleteRuns`（供排查，不显示） |
| 显示文案 | 极简单行：`Cache hit 61%`；尚无可信数据时 `Cache hit —`。不带 token 明细长串 |
| 取整规则 | `cacheReadShare`（0–1）×100 后**四舍五入**到整数显示；`cacheRead = 0` 且有可信数据时显示 `Cache hit 0%`（与「—」严格区分） |
| 显示位置 | `/status`（Web 卡片 + TUI 面板），与占用详情同卡不同块；不进彩条、不进顶栏 |
| 物理语义 | cache 只改变计费与延迟，**绝不**从窗口占用扣除；Compaction 分母按 Total Input 算 |
| 冷启动预期 | 新 session 首条消息 Cache-Read Share ≈ 0%，属「天然偏低」，不设告警阈值 |
| 链路现状 | provider 归一化（improve-5 `token-usage.ts`，含 `observed` 标志）→ per-step metadata → run 级聚合已通；**缺**：session 级累加器 + SDK 类型 + `/status` 出口 |

三分桶语义（互斥，加总 = 总输入）：`cacheRead`＝命中此前写入的缓存（跳过 Prefill）；`cacheWrite`＝本轮首次写入缓存的前缀（为下次命中投资）；`uncached`＝既不命中也不构成新写入的普通输入。OpenAI 系 `uncached = prompt_tokens − cacheRead − cacheWrite`，须同时减两个。

---

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 / 后续做 |
|----|-------------------|
| 占用彩条里画 cache read/write | 明确不做 |
| 子代理占用进主 UI | 明确不做 |
| Skills 行计入已 load 的 SKILL.md 正文 | 明确不做（正文进 Conversation） |
| Rules / Memory files 独立行 | 不做（无独立 Rules；memory 在 System prompt） |
| Cache 实施（session 累加器、SDK 类型、`/status` Cache 行） | **下一轮做**；本批只冻结设计（§2.4），不动代码 |
| 精确 tokenizer、价格引擎 | 不做 |
| 改压缩阈值或 prompt cache 请求策略 | 不做 |
| TUI 小环或 hover/click | 不做 |
| TUI 七类详情或 ASCII 堆叠条 | 本轮不做；仅保持现有总量展示 |
| 对话内再拆 user / assistant / 普通 tool | 不做 |

---

## 4. 已确认：与关联议题的关系

- improve-4 曾锁「后续占用 UI = KISS 三类 + `~`」。本批按用户对标 Cursor 扩为七类英文 key；`~` 与「条长跟总量、颜色跟比例」仍采用。
- improve-4.1：静态/手动路径已 tools-aware，本批不再偿还该债。
- improve-5：`TokenUsage.inputBreakdown` / `observed` / 命中率公式原样投影到 `/status`；不改 normalization。
- 联合回归：粗略占用可见 ≠ breakdown/cache 已验收；本批补上。
- `goals-duty.md`：cache hit 不等于释放 token；子代理自身窗口/child transcript 不进主占用 UI，但父窗口已有的 subagent exchanges 属于主窗口占用。

---

## 5. 参考项目（摘要；细节见 03）

| 来源 | 采用 | 不采用 |
|------|------|--------|
| Cursor 占用面板 | Web：小环 + hover 粗信息 + click 彩条/行 | 不抄 Rules；Subagent 按父窗口 exchanges 而非 definitions |
| deepseek-harness ContextMeter | `~`、条长=总量%、彩段=分类比例；cache 不进占用条 | Web 本批**要**小环（dsh 也是环触发）；TUI 不用环 |
| claude-code-best `/context` | System tools / MCP / Skills / Messages 分桶量 schema；Skills 从 SkillTool 抠出避免与 builtin 双计 | Autocompact buffer、deferred 虚占、Memory files 独立行 |
| Codex | footer 与 `/status` 都优先保持紧凑总量 | 不要求 TUI 本轮同步 Web 分类 |
| kimi-code | footer/usage 只显示总量；子代理历史不进父窗口 | 无七类弹层 |

---

## 6. 用户确认记录

- 2026-08-26：TUI 不用 hover/click；最终确认本轮底栏与 `/status` 都保留现有总量，七类 TUI 详情延期；下一轮仍可独立增加 Cache 行。
- 2026-08-26：Web hover/click 确认；hover 前是小占用环。
- 2026-08-26：Skills = `skill` 工具 description（`<available_skills>`）走 schema；调用后 SKILL.md 进对话历史。
- 2026-08-26：分类显示名一律英文；确认单列 Summarized conversation；子代理父窗口回写统一命名为 Subagent exchanges。
- 2026-08-26：用户指定的 tools 即 builtin-tools。`module` 由讨论澄清后并入 builtin-tools、不单列。
- 2026-08-26：文档放 `docs/core/context/improve-6/`；前后端分离；Web/TUI 分别设计；02 需要关键改动清单。
- 2026-08-26：Web 紧凑态不保留 `7.1k / 1m` 文本，只靠 hover；无 composition 时七行隐藏（非全 `~0`）。
- 2026-08-26：Cache 口径改为 **session aggregate 唯一显示**；run aggregate 后端计数、前端不显示；不完整轮**尽力而为**跳过；文案极简 `Cache hit 61%`；**cache 整体下一轮实施，本批只做 context 占用 + UI**；cache 设计依据两篇知识库文档（prompt-cache-api-fields / kv-cache-vs-prompt-cache）。
- 2026-08-26：确认采用窄的 step-local `ResolvedStepTools` 与独立 composition/UI adapter；不得扩展成 manager、缓存或持久状态。
