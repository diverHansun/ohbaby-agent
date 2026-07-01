# system-prompt improve-2 · 参考清单

> 日期：2026-06-30
> 用途：四个优秀项目的系统提示词**文件定位 + 组织范式 + 可引片段 + 借鉴点**，供《重写规格》落笔时按图索骥。
> 基准路径：所有参考项目位于 `/Users/hansun025/Projects/code-cli/`。行号为查阅当日实际值，随上游更新可能漂移，以就近搜索为准。
> **借鉴纪律**：借"怎么表达"（结构、分级、举例方式、决策程序的写法），不照抄"表达什么"（各家的价值观是它们的产品判断）。

---

## 一、claude-code — 语气与哲学的黄金标准

### 主文件
| 文件 | 行数 | 角色 |
|------|------|------|
| `claude-code/src/constants/prompts.ts` | 877 | 主提示词，按"分节函数"组织（`getSimpleDoingTasksSection()` 等） |
| `claude-code/src/constants/systemPromptSections.ts` | 68 | 分节 + 缓存边界（静态可跨会话缓存 vs 动态） |
| `claude-code/src/utils/systemPrompt.ts` | 123 | 组装入口 |

### 组织范式
- 提示词切成**语义分节函数**，每节独立、可条件拼装。
- 用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记**缓存边界**：静态前缀跨组织缓存，动态后缀不缓存（prompts.ts L110–120）。ohbaby 未来若做 prompt 缓存可借鉴。
- 大量 feature-gate 条件段（poor mode、proactive、skill search 等）。

### 可引片段（借"怎么写"）
- **反镀金 / 反投机抽象 / 注释纪律**：L206–216。示例句气质：`Three similar lines of code is better than a premature abstraction`、`Default to writing no comments. Only add one when the WHY is non-obvious`。
- **含糊指令 → 具体动作**（清晰度范本）：L225，`change "methodName" to snake case → 去代码里找到并改，而非只回 "method_name"`。
- **协作者而非执行器**：L229，`You're a collaborator, not just an executor`。
- **读后再改**：L230。
- **失败先诊断再换招**：L233。
- **忠实汇报**（正反双向）：L238，`if tests fail, say so with output; … Equally, when a check did pass … state it plainly`。
- **担责不过度道歉**：L239。
- **可逆性 / 爆炸半径 + 风险动作清单**（决策程序范本）：L250–259。
- **子代理默认提示词**：L721，`Complete the task fully—don't gold-plate, but don't leave it half-done … a concise report`。
- **自主运行 / 简洁 / 终端焦点**：L829–876（`Be concise`、`Bias toward action`、focused vs unfocused 的自主度校准）。

### 对 ohbaby 的借鉴点
→ 《重写规格》§1（价值气质）、§3（工作方式）、§4（决策程序）、§5（语气与忠实汇报）、§6（完成前验证）、附 A（子代理）。

---

## 二、gemini-cli — 条件逻辑与动态装配

### 主文件
| 文件 | 行数 | 角色 |
|------|------|------|
| `gemini-cli/packages/core/src/core/prompts.ts` | 43 | 对外入口（薄封装 `PromptProvider`） |
| `gemini-cli/packages/core/src/prompts/snippets.ts` | 954 | 全部 section renderer + 组合逻辑 |
| `gemini-cli/packages/core/src/prompts/promptProvider.ts` | 348 | Provider 装配 |

### 组织范式
- **option 驱动的分段 renderer**：`getCoreSystemPrompt(options)` 用一串 `renderXxx(options.xxx)` 插值组合（snippets.ts L136–163）。**与 ohbaby 的分层 assembler 架构最接近**，但内容厚得多——是 ohbaby "同构但更成熟"的对照样本。
- 每个 renderer 按 `interactive` / `approvalMode` / 是否有 skill / 是否有 memory 等条件产出不同文本（如 `renderPreamble` L183–196 按模式切换开场白）。

### 可引片段（借"怎么写"）
- **上下文经济 + 并行搜索/读取**（逻辑范本）：L221–249，`<estimating_context_usage>`、`<guidelines>`、`<examples>` 三段式，把"为什么省上下文、怎么省、别省过头"讲透。
- **工程标准**（约定/类型/库/测试）：L252–261。
- **Directives vs Inquiries**（决策程序范本）：L258，`Distinguish between Directives … and Inquiries … Assume all requests are Inquiries unless … explicit instruction`。
- **安全与不可信上下文**：L216–219，`<untrusted_context>` 标签把外部数据当被动数据。
- **子代理编排哲学**："context window is your most precious resource"、何时委派/何时亲自动手：L273–311。

### 对 ohbaby 的借鉴点
→ 《重写规格》§4（Directives/Inquiries 判据）、§7（上下文经济 + 并行调用）、§8（不可信上下文）、附 C（按模式切换措辞）。

---

## 三、kimi-code — 与 ohbaby 现状最接近，可直接对标重写

### 主文件
| 文件 | 行数 | 角色 |
|------|------|------|
| `kimi-code/packages/agent-core/src/profile/default/system.md` | 155 | **单个模板化 `.md`**，Jinja 风格 `{{VAR}}` / `{% if %}` |

### 组织范式
- 一个 `.md` 从头到尾，用模板变量注入运行时上下文（`{{ KIMI_OS }}`、`{{ KIMI_WORK_DIR }}`、`{{ KIMI_SKILLS }}` 等）。
- 与 ohbaby 的"`.md` 源 + 生成快照 + layer 注入"目标一致，但 kimi 把动态部分也放进同一个 `.md` 用模板占位；ohbaby 把动态部分交给 layer renderer。**中档重写的体量与口吻，直接以 kimi 这份为标尺最省力。**

### 可引片段（借"怎么写"）
- **语言策略**（§9 近乎可对标范本）：L27，`think in the user's language, while keeping code, commands, identifiers, file paths, and technical terms in their original form`。
- **既有代码库工作流**：L44–53（先读懂、最小侵入、跟随既有风格、`Make MINIMAL changes`）。
- **git 变更需每次确认**：L55。
- **Ultimate Reminders**（口吻凝练范本）：L145–155，`Be thorough in your actions … not in your explanations`、`keep it stupidly simple`、`Never give the user more than what they want`。

### 对 ohbaby 的借鉴点
→ 《重写规格》§9（语言策略）、§3（既有代码库）、§1/§5（凝练口吻）。**建议把这份 155 行通读一遍再动笔**，它就是"中档"的样子。

---

## 四、oh-my-pi — 可扩展性天花板（细粒度 `.md` 资产）

### 主文件
| 路径 | 角色 |
|------|------|
| `oh-my-pi/packages/coding-agent/src/system-prompt.ts`（698 行） | 装配机器（capability 走查、条件渲染） |
| `oh-my-pi/packages/coding-agent/src/prompts/tools/*.md`（41 个） | **每个工具一份独立 `.md`** |
| `oh-my-pi/packages/coding-agent/src/prompts/agents/*.md` | 子代理提示词（explore/plan/task/reviewer/oracle/librarian…） |
| `oh-my-pi/packages/coding-agent/src/prompts/system/*.md` | 系统级片段（plan-mode、auto-continue、各类 reminder…） |
| `.../prompts/{goals,steering,memories,system/personalities}/` | 目标模式、引导、记忆、人格 |

### 组织范式
- **把"提示词即内容资产"贯彻到极致**：每工具、每子代理、每系统片段各一个 `.md`。
- 甚至有 `personalities/`（人格）与 `steering/`（引导）目录。
- 对 ohbaby 的意义：**当核心提示词与工具描述继续膨胀时的目标形态**。ohbaby 现在的 `prompts/` 已是这个方向的雏形（primary/subagents 分目录），无需现在就拆到 41 个文件，但可作为长期北极星。

### 可引片段（借"怎么组织"）
- 工具描述的措辞密度：`prompts/tools/{read,search,apply-patch,replace}.md`。
- 子代理措辞与边界：`prompts/agents/{explore,task,plan}.md`。

### 对 ohbaby 的借鉴点
→ 《重写规格》附 A（子代理）、附 B（工具描述文风）；以及"提示词归属"的长期治理方向。

---

## 五、速查：ohbaby 每节该先看谁

| ohbaby 重写节 | 首选参考 | 次选 |
|---------------|----------|------|
| §1 身份 & 价值排序 | 本仓库 `references/00-philosophy.md` 第五节 | claude L206–216 / kimi L145–155 |
| §2 核心能力 | （做减法，无需外借） | — |
| §3 工作方式 | claude L206–216, L225, L230 | kimi L44–53 |
| §4 动手 vs 先问 | gemini L258 / claude L250–259 | claude L233 |
| §5 语气 & 输出 | claude L238, L239, L863–870 | kimi L147 |
| §6 完成前验证 | claude L216 | 本仓库 `references/07` |
| §7 工具使用哲学 | gemini L221–249 | oh-my-pi `prompts/tools/` |
| §8 安全约束 | gemini L216–219 / claude L198, L234 | — |
| §9 语言策略 | kimi L27 | — |
| 附 A 子代理 | oh-my-pi `prompts/agents/` | claude L721 |
| 附 B 工具描述 | oh-my-pi `prompts/tools/` | 本仓库 `task.ts` 现有范例 |
| 附 C 任务模式 | gemini L183–196 | — |
