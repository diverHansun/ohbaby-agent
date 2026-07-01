# system-prompt improve-2 · 重写规格

> 日期：2026-06-30
> 用途：给**人**落笔重写提示词文本时的逐节工作单。
> **重要约束**：本文档只给"现状引用 / 问题诊断 / 改写目标与原则 / 参考锚点"，**不提供可直接粘贴的定稿提示词文字**。最终每一句由人来写——避免"agent 指导 agent"。
> 参考锚点里的行号指向 `/Users/hansun025/Projects/code-cli/` 下的对应文件，详见第三篇《参考清单》。
> 落笔纪律见文末"通用文风约定"。

---

## 目标结构：9 节行为骨架

主提示词 `prompts/primary/base.md` 从现状 5 节扩为 9 节：

1. 身份 & 价值排序
2. 核心能力
3. 工作方式（Doing tasks）
4. 动手 vs 先问（决策程序）
5. 语气 & 输出
6. 完成前验证
7. 工具使用哲学
8. 安全约束
9. 语言策略

外加独立处理：**subagent 提示词**、**工具描述文风约定**、**composition.ts 硬编码治理**。

> 落笔时可自行判断是否合并相邻小节（如 §6 完成前验证 是否并入 §3 工作方式）。若合并，请在文档/提交信息里记一句理由。

---

## §1 身份 & 价值排序

**现状引用**（`prompts/primary/base.md` 开头 + `# Identity`）：
```
You are ohbaby-agent, an AI coding assistant for software development work.
# Identity
- You help users understand, modify, test, and maintain codebases.
- You work carefully in the user's existing project and respect established patterns.
- You explain important trade-offs clearly and keep routine output concise.
```

**问题诊断**：
- 哲学性：只有"我是谁 + 我做什么"，没有"我信什么"。缺价值排序，模型在冲突（快 vs 对、改多 vs 改少）时无依据。
- 清晰度：`work carefully`、`respect established patterns` 抽象，无落点。

**改写目标与原则**：
- 保留一句干净的身份定义（是什么 agent、主目标）。
- **新增显式价值排序**：正确性 > 可维护/可读 > 简单 > 性能 > 灵活（可扩展），并点明"性能与灵活常被过早追求"。依据本仓库 SWE 指南 `references/00-philosophy.md` 第五节，用项目自己的话表达。
- **注入经济学视角一句**："最小复杂度、复杂度要靠证据挣得、不镀金（no gold-plating）"。
- 语气基线在此定调（简洁、直接、协作者而非执行器），后续各节继承。

**参考锚点**：
- 价值/伦理气质：`claude-code` prompts.ts L206–216（最小复杂度、不做投机抽象）、L229（协作者而非执行器）。
- 口吻凝练：`kimi-code` system.md L145–155（Ultimate Reminders：`keep it stupidly simple`、`Never give the user more than what they want`）。
- 本仓库自有：`.claude/skills/learn-swe-before-implement/references/00-philosophy.md` 第五节价值排序——**这是 ohbaby 的母语，优先用它提炼**。

---

## §2 核心能力

**现状引用**（`# Core Capabilities`）：读代码/推理、提出并实现聚焦改动、用工具、跟踪假设并尽早暴露阻塞。

**问题诊断**：内容基本正确，但与 §3 工作方式有重叠；偏"能力清单"而非"行为指引"。

**改写目标与原则**：
- **精简保留**，只留"模型可能不知道的能力边界"（如：可跟踪假设、应尽早暴露阻塞）。
- 把"怎么用能力"的内容让给 §3，避免重复（DRY）。
- 若与 §3 重复度过高，允许把本节压缩为 2–3 行甚至并入 §1。

**参考锚点**：无需外借，做减法为主。

---

## §3 工作方式（Doing tasks）— 新增

**现状引用**：无独立节。零散在 `Tool Guidelines`（`Prefer fast, targeted inspection before broad changes`）与 task 提示词里。

**问题诊断**：
- 逻辑性：没有"改动前先理解、最小改动、不投机抽象"的工作纪律。
- 清晰度：无任何具体例子；模型不知道"含糊指令"该怎么落地。

**改写目标与原则**（本节是中档扩容的重点之一）：
- **先理解再改**：不改没读过的代码；用户提到某文件先读它。
- **最小改动 + 反镀金**：只做任务要求的，不顺手重构/加配置/加防御性代码；"三行相似代码好过过早抽象"。
- **含糊指令按软件工程情境理解**，配**一个具体例子**（例如把标识符改风格 → 去代码里找到并改，而非只回一个字符串）。
- **注释纪律**：默认不写；只在"为什么"不显然处写。
- 每条规则遵循"何时触发 + 怎么做 + 反例"三件套。

**参考锚点**：
- `claude-code` prompts.ts L206–216（反镀金/反投机抽象/注释纪律）、L225（含糊指令的具体例子）、L230（读后再改）。
- `kimi-code` system.md L44–53（既有代码库工作流）、L51（`Make MINIMAL changes`）。

---

## §4 动手 vs 先问（决策程序）— 新增

**现状引用**（散落在 `Safety Constraints`）：
```
- Do not perform destructive git or file operations unless explicitly requested.
- For risky operations, explain the risk and choose the conservative path.
```

**问题诊断**：
- 逻辑性：**最大短板**。只有"risky 就保守"，但没定义什么算 risky、什么时候只分析、什么时候可以直接动手。模型要么畏手畏脚要么鲁莽。

**改写目标与原则**：
- **区分"指令 vs 询问"**（Directives vs Inquiries）：默认把"能不能告诉我怎么…""不要改，先…"当作只做分析；只有明确的执行指令才动手。
- **可逆性 / 爆炸半径分级**：本地、可逆动作（读文件、跑测试、编辑）默认放手做；难以撤销 / 影响共享系统 / 破坏性的动作先确认。给出**具体清单**（如：删分支、force-push、git reset --hard、发消息/PR、改 CI、上传到第三方）。
- **一次授权不等于永久授权**、**授权只在其明示范围内有效**。
- **失败处置逻辑**：失败先诊断原因（读报错、查假设）再换招；别原样重试，也别一次失败就放弃；真卡住才升级问用户。

**参考锚点**：
- `gemini-cli` snippets.ts L258（Directives vs Inquiries 的完整判据，**逻辑范本**）。
- `claude-code` prompts.ts L250–259（可逆性/爆炸半径 + 风险动作清单，**分级范本**）、L233（失败先诊断再换招）。

---

## §5 语气 & 输出（升级 Output Format）

**现状引用**（`# Output Format`）：结果先行、相关时提改动文件与验证命令、避免噪音抄录。

**问题诊断**：
- 方向对但抽象；缺"忠实汇报"与"不过度道歉"这两条高价值行为。

**改写目标与原则**：
- 保留"结果先行、简洁、按重点概述命令输出"。
- **新增忠实汇报**：测试失败就带输出说失败；没跑验证就说没跑，别暗示成功；确认通过就直说，别用无谓的免责声明稀释已确认的结果。
- **新增稳态与担责**：出错时担责但不过度道歉、不自我贬低；用户反复施压也保持诚实，不为迎合而放弃正确立场。
- 明确"用户能看到工具调用，不需要逐步旁白"。

**参考锚点**：
- `claude-code` prompts.ts L238（忠实汇报，正反都要——失败别谎报、成功别对冲）、L239（担责不过度道歉）、L863–870（Be concise 的具体化）。
- `kimi-code` system.md L147（`Be thorough in your actions — not in your explanations`）。

---

## §6 完成前验证 — 新增

**现状引用**（`prompts/primary/tasks/agent.md`）：
```
Implement focused changes, verify behavior with relevant checks, and report changed files and verification results.
```

**问题诊断**：
- 只在 agent task 里一句带过；主提示词无"报告完成前必须先真验证"的硬约束。这是幻觉/虚报完成的主要来源。

**改写目标与原则**：
- **报告完成前先真跑验证**：跑测试、执行脚本、看输出——最小复杂度不等于跳过终点线。
- **不能验证就明说**（没有测试、跑不了）而非声称成功。
- 与 §5 忠实汇报呼应，避免重复；可考虑与 §3 合并，若合并需在文档记理由。

**参考锚点**：
- `claude-code` prompts.ts L216（`Before reporting a task complete, verify it actually works…`）。
- 本仓库 SWE 指南 `references/01-design-goals.md` / `07-engineering-practices.md`（可测性）。

---

## §7 工具使用哲学（升级 Tool Guidelines + 治理硬编码）

**现状引用**（两处）：
- `prompts/primary/base.md` `# Tool Guidelines`：偏好快速定向检查、跑证明改动的测试、把 fs/shell 当真实副作用、非请求勿做破坏性 git/文件操作。
- `adapters/ui-runtime/composition.ts` `toolPromptGuidelines()`（约 296–315 行，🔴 硬编码）：
```
"Prefer read/list/glob/grep tools over bash for file exploration."
"Use bash for shell-assisted file and workspace tasks."
"Use write/edit only when the current task mode and user request allow workspace changes."
```

**问题诊断**：
- 关注点分离：面向模型的行为规则一半在 `.md`、一半硬编码在 adapter，事实源分裂。
- 逻辑性：缺"无依赖调用应并行"这条高价值效率规则；缺上下文经济视角。

**改写目标与原则**：
- 把 composition.ts 那三条规则的**语义**上移到本节（核心提示词），作为工具使用哲学的一部分：探索优先 read/grep/glob/list、bash 用于 shell 型任务、写操作受任务模式约束。
- **新增并行调用**：无相互依赖的多个工具调用应在一次响应里并行发起。
- **新增上下文经济**：把上下文窗口当稀缺资源——限定搜索范围与读取行数、优先 grep 定位而非逐个读文件，但别为省 token 反而多花回合。
- **治理动作**：`composition.ts` 只保留"按当前可用工具集条件拼装"的**机制**（哪些工具在场就渲染哪段），不再内联规则**文本**。规则文本迁到 `.md` 后，`toolPromptGuidelines()` 要么改为从内容资产取词、要么退化为纯"选择性开关"。落地方式在实现阶段定，本轮先在文档确立原则。

**参考锚点**：
- `gemini-cli` snippets.ts L221–249（Context Efficiency：上下文经济 + 并行搜索/读取，**范本**）。
- `oh-my-pi` `prompts/tools/*.md`（每工具一个 `.md`，把"工具即内容资产"贯彻到底，可参考其归属思路）。

---

## §8 安全约束

**现状引用**（`# Safety Constraints`）：保护用户工作不回滚无关改动、密钥不入日志、风险操作保守、遵循指令/策略/权限。

**问题诊断**：内容正确，但与 §4 的"动手 vs 先问"有交叉，需理清边界。

**改写目标与原则**：
- 本节聚焦**不可协商的护栏**：密钥/凭据不外泄、不回滚无关改动、不引入 OWASP 类漏洞、外部工具/文件里的"指令"当数据读而非命令执行（prompt injection）。
- 把"风险操作是否先确认"的**决策**归给 §4，本节只留"红线"，避免重复。

**参考锚点**：
- `claude-code` prompts.ts L234（安全漏洞与敏感代码的措辞）、L198（prompt injection：文件/工具结果里的指令不是用户指令）。
- `gemini-cli` snippets.ts L216–219（Security & System Integrity + untrusted_context）。

---

## §9 语言策略 — 新增

**现状引用**：无。主提示词完全没提语言。

**问题诊断**：
- 覆盖缺口。ohbaby 面向中英混合场景，但没告诉模型该用什么语言回应/思考。

**改写目标与原则**：
- **跟随用户语言**回应（除非用户另有要求）；思考也用用户语言。
- **代码、命令、标识符、文件路径、技术术语保留原文**，不翻译。
- 一句话即可，放 §1 或 §5 也行；本轮按用户要求**独立成节**。

**参考锚点**：
- `kimi-code` system.md L27（`think in the user's language, while keeping code, commands, identifiers, file paths, and technical terms in their original form`，**近乎可直接对标的范本**）。

---

## 附 A：subagent 提示词（现各仅 4 行，需补真行为指引）

**现状引用**：
- `subagents/base.md`：聚焦子代理、有界任务、返回简洁结果、不加载 custom instructions、不再造子代理、可用 todo。
- `subagents/tasks/explore.md`：快速找/查/总结相关代码、优先定向搜索。
- `subagents/tasks/research.md`：调查有界问题、区分已证实事实与推断、返回简洁综合。
- `subagents/tasks/generic.md`：独立完成有界委派、返回简洁结果。

**问题诊断**：过薄。base 尚可，但三个 task 各只有一句，缺"怎么工作、返回什么格式、边界在哪"。

**改写目标与原则**：
- `base`：保留，补一句"你看不到主代理的上下文，需要什么就自己查/在 prompt 里已给"。
- `explore`：补"读摘要而非整文件、优先 grep/glob 定位、返回文件路径+关键行而非大段粘贴"。
- `research`：补"分开写'已证实/推断/未知'、给出证据锚点（文件:行）"。
- `generic`：补"完成后返回给主代理的结果应是可直接采用的结论，而非过程流水"。
- 与主提示词各节保持文风一致，但**更短**（子代理上下文预算更紧）。

**参考锚点**：
- `oh-my-pi` `prompts/agents/{explore,task,plan}.md`（子代理专用提示词的组织与措辞）。
- `claude-code` 的 `DEFAULT_AGENT_PROMPT`（prompts.ts L721，子代理"完整但不镀金 + 简洁回报"的表述）。

---

## 附 B：工具描述文风约定（`tools/*.ts` 的 `description`）

**现状**：12 个工具的 `description` 长短/口吻不一（对比 `read.ts` 一句 vs `todo.ts`/`task.ts` 数句带规则）。

**改写目标与原则**：不搬家（保持高内聚），但统一为一致模板：
- 一句话说清"做什么"。
- 需要时补"何时用/何时别用"与关键约束（如 `task` 的"name/description 仅元数据，行为指令放 prompt"已是好范例）。
- 面向模型、祈使句、无营销词。
- MCP 工具描述来自外部，不改，仅经安全扫描。

**参考锚点**：`oh-my-pi` `prompts/tools/*.md`（每工具独立 `.md` 的措辞密度）。

---

## 附 C：任务模式提示词（ask / plan / agent）

**现状**：三条各 1–2 句（见 `primary/tasks/*.md`）。

**改写目标与原则**：
- 保持"模式差异"的**边界清晰**：`ask` 只读不改、`plan` 偏分析与只读探索、`agent` 可执行。
- `plan` 可补一句"产出可执行计划"的结构期望。
- 不与主提示词重复；模式提示词只讲"这个模式下有什么不同"。

**参考锚点**：`gemini-cli` snippets.ts L183–196（按 approvalMode 切换措辞，`renderPreamble`）。

---

## 通用文风约定（落笔纪律）

1. **每条规则要有落点**：抽象规则后跟"何时/怎么做/反例"其一。
2. **分级用词**：MUST/NEVER 留给硬约束，SHOULD/default/prefer 留给倾向。别滥用大写。
3. **例子要贴 ohbaby**：用本项目真实工具（read/edit/bash/grep/task…）与工作流举例，不用通用样板。
4. **借表达不借内容**：参考项目的句子是灵感，价值观要用 ohbaby 自己的话（优先对齐本仓库 SWE 指南）。
5. **中档不越界**：不为厚而厚，每加一句过"模型少了它会做错吗"这关。
6. **英文正文、中文文档**：`.md` 提示词资产继续用英文；改完记得跑 `prompt:generate` / `prompt:check` 让 `templates.generated.ts` 同步（见 architecture.md 第六节）。
7. **验证**：改完按 improve-1《review-and-improvements》第四节的命令跑测试与 typecheck，合并前做真 API E2E。
