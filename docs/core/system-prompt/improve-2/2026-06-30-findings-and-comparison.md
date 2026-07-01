# system-prompt improve-2 · 发现与对比

> 日期：2026-06-30
> 范围：`packages/ohbaby-agent/src/core/system-prompt/` 的**提示词文本**，以及散落在其它模块的等效提示词内容
> 承接：improve-1 已完成模块**架构**治理（`.md` 资产化、公共 API 清理、custom loader 服务化），并明确把"扩充 subagent prompt 内容"列为**未实施**。improve-2 接手这块——**文本本身的哲学性、逻辑性、清晰度**。
> 参考项目（均在 `/Users/hansun025/Projects/code-cli/` 下）：claude-code、gemini-cli、kimi-code、oh-my-pi。具体文件路径见第三篇《参考清单》。

---

## 零、一句话结论

**架构是好的，问题在文字。** 当前主提示词（约 29 行）是一份"安全、通用、但没有灵魂"的模板：扁平 bullet、无价值排序、无决策逻辑、无具体例子。参考项目在同样的三个维度上远比它厚重。improve-2 的任务是**在不动 improve-1 架构的前提下，把文本从"规则清单"升级为"带哲学与决策程序的行为骨架"**。

---

## 一、学习启发（SWE 原则 → 本项目）

### 1.1 对本项目有直接指导意义的原则

- **代码为人而写 / 提示词为模型而写**（`00-philosophy` 第二节）
  - 对应场景：提示词是"写给模型读的代码"，同样遵循"清晰胜过聪明、显式胜过隐式"。
  - 启发：现状文字抽象、悬空（如 `Avoid noisy transcripts`），模型无法把它落到具体动作。应像 claude-code 那样给**具体例子 + MUST/NEVER 分级**。
  - 优先级：高

- **价值观需要在冲突时能排序**（`00-philosophy` 第五节）
  - 对应场景：现状提示词没有任何价值排序，模型在"快"与"对"、"改多"与"改少"冲突时无依据。
  - 启发：显式写入价值序（正确性 > 可维护 > 简单 > 性能 > 灵活），并注入"最小复杂度、不镀金"的经济学视角。
  - 优先级：高

- **可逆 vs 不可逆决策**（`00-philosophy` 第三节）
  - 对应场景：现状只有一句 `For risky operations, explain the risk and choose the conservative path`，没定义什么算 risky。
  - 启发：借 claude-code 的"可逆性/爆炸半径"框架，给出**判定标准 + 具体清单**。
  - 优先级：高

### 1.2 SWE 指南中的反例，恰好是项目正在犯的

- **反例：抽象而无落点的规则**（`06-code-craft` 的"注释应解释 why 而非 what"同理适用于提示词）
  - 位置：`prompts/primary/base.md` 的 `Tool Guidelines` / `Output Format` 各节。
  - 为什么是问题：`Prefer fast, targeted inspection`、`Lead with the result` 都是正确的废话——模型已"知道"这些概念，但不知道在本项目的具体情境里怎么执行。清晰度不足。
  - 建议：每条规则配一个"何时触发 + 怎么做 + 反例"的最小落点。

- **反例：行为提示词藏在管道代码里**（违反"关注点分离"，`02-fundamental-forces`）
  - 位置：`adapters/ui-runtime/composition.ts` 的 `toolPromptGuidelines()`（约 296–315 行），硬编码了 `Prefer read/list/glob/grep tools over bash` 等**面向模型的行为规则**。
  - 为什么是问题：这是给模型的话，却住在装配/接线层，脱离了 `core/system-prompt` 这个内容资产的"单一事实源"。以后没人会想到去 adapter 里改提示词。
  - 建议：把这段规则的**语义**上移到工具使用哲学节（见《重写规格》第 7 节），composition 只保留"按当前可用工具集选择性拼装"的机制。

### 1.3 有意识的合理权衡（现状做得对的地方，别推翻）

- **内容与代码分离（`.md` 是源、生成 TS 快照）**：improve-1 的选择正确，improve-2 全程沿用，不引入运行时 `.md` loader。
- **工具描述住在工具里**：`tools/*.ts` 的 `description` 经 `toolDetailsProvider` 喂进 `<tool_guidance>`——这是**高内聚**（指引跟着工具走），是对的，不要搬进核心提示词。improve-2 只统一它们的文风，不改变归属。
- **compression-prompt.ts 写得好**：`core/context/compression-prompt.ts` 结构化、规则清晰（含"不要提及这是摘要"这类高级技巧），是本仓库现有提示词里质量最高的一份，可作为**内部文风基线**参考，本轮不重写。
- **对 MCP / 工具片段做 prompt-injection 安全扫描**：`security/index.ts` 是多数项目没有的防线，保留。

---

## 二、健康度分层评估（聚焦"提示词文本"这一切面）

只评与本轮相关的层，不重复 improve-1 已处理的架构层。评价星数为**严重程度**（5=健康，1=问题严重）。

### 2.1 哲学/价值观层
- ✅ 有基本的安全与保守倾向（`Safety Constraints`）。
- ❌ 无价值排序、无经济学视角、无"最小复杂度/不镀金"、无语气与人格。模型拿不到"我们怕什么、追求什么"。
- 评价：★★☆☆☆

### 2.2 设计目标层（提示词想让模型达成的质量）
- ✅ 覆盖了读/改/验证/报告的基本闭环。
- ❌ 目标之间无优先级；"何时该问、何时该动手"这一核心决策没有明确目标定义。
- 评价：★★☆☆☆

### 2.3 逻辑性（决策程序）层
- ✅ 规则本身不矛盾。
- ❌ 给的是**规则**不是**决策程序**。缺 Directives↔Inquiries 判定、缺失败后的诊断-重试逻辑、缺可逆性分级。对比 gemini/claude 差距最大。
- 评价：★★☆☆☆

### 2.4 清晰度 / 代码工艺层
- ✅ 结构整齐、bullet 简短。
- ❌ 全部抽象、零具体例子、无 MUST/NEVER 分级、无"不要做什么 + 为什么"。
- 评价：★★☆☆☆

### 2.5 覆盖完整性层
- ✅ 身份/能力/工具/输出/安全五要素齐。
- ❌ 缺失：语气与简洁、完成前验证、语言策略（跟随用户语言）、并行工具调用、上下文经济、subagent 的真行为指引（每个仅 4 行）。
- 评价：★★☆☆☆

### 2.6 一致性 / 分布层
- ✅ 核心 `.md` 内部文风一致。
- ❌ 有效提示词散落在 6 处（见第三节），文风不统一，且有一处（composition.ts）住在管道里。
- 评价：★★★☆☆

---

## 三、分布地图：有效系统提示词到底"住在哪"

用户直觉正确：**有效系统提示词远不止 `core/system-prompt/`。** 运行时最终喂给模型的文本由以下各处拼成：

| # | 位置 | 内容 | 性质 | improve-2 处置 |
|---|------|------|------|----------------|
| 1 | `core/system-prompt/prompts/primary/base.md` + `primary/tasks/*.md` + `subagents/*.md` | 主干身份/任务/子代理提示词 | ✅ 内容资产（正确归属） | **重写主战场** |
| 2 | `tools/*.ts` 的 `description:`（12 个文件） | 工具行为指引，经 `toolDetailsProvider`→`<tool_guidance>` | ⚠️ 散在各工具，但归属正确（高内聚） | **统一文风，不搬家** |
| 3 | MCP 工具描述（外部服务器） | 同 2 的通道，经安全扫描 | 外部不可控 | 不动，仅在文档说明 |
| 4 | `core/context/compression-prompt.ts` | 上下文压缩/摘要提示词 | ✅ 独立且质量高 | **作文风基线，不重写** |
| 5 | `agents/builtin/*.ts` 的 `description` | 变成 prompt 里 subagent_roles + agentPromptAddon | 元数据 | 校准描述文风 |
| 6 | `adapters/ui-runtime/composition.ts` 的 `toolPromptGuidelines()`（约 296–315 行） | 硬编码的工具使用规则 | 🔴 **行为提示词埋在管道里** | **语义上移到第 7 节，治理硬编码** |

**治理原则（本轮采纳）**：
- **语气与哲学集中**在 `core/system-prompt`（单一事实源）。
- **工具细节就近**留在工具描述里（高内聚），但服从统一文风。
- **消灭"藏在管道里的提示词"**：第 6 处的规则语义并入核心提示词的工具使用哲学节。

---

## 四、三维对比：ohbaby vs 四个参考项目

（具体文件路径与可引片段见第三篇《参考清单》，此处只做维度对照。）

### 4.1 哲学性（价值观与语气）
- **ohbaby**：无。语气中性、企业化，读不出立场。
- **claude-code**：`You're a collaborator, not just an executor`；`Three similar lines of code is better than a premature abstraction`；整套"最小复杂度、不镀金、忠实汇报、不过度道歉"的伦理。
- **kimi**：`Be thorough in your actions — not in your explanations`；`keep it stupidly simple`；`Never give the user more than what they want`。
- **gemini**：把"上下文窗口是你最宝贵的资源"当成显式价值来推理。
- **差距**：ohbaby 需要从零注入价值排序 + 语气基线。

### 4.2 逻辑性（决策程序）
- **ohbaby**：规则罗列，无判定。
- **gemini**：`Directives vs Inquiries` 二分——什么时候只分析、什么时候动手，有明确判据。
- **claude-code**：可逆性/爆炸半径框架 + 具体清单；失败时"先诊断为什么再换招"。
- **差距**：ohbaby 需要把"动手 vs 先问"、"失败后如何处置"变成可执行的决策程序。

### 4.3 清晰度（具体化）
- **ohbaby**：抽象、无例子。
- **claude-code**：`change methodName to snake case → 去代码里找到方法改掉，别只回 method_name`——一句话把抽象规则钉死到具体动作。
- **通用模式**：四个项目全部用"具体例子 + MUST/NEVER/默认 分级 + 反例（不要做什么 + 为什么）"。
- **差距**：ohbaby 每条规则都缺落点。

---

## 五、风险与债务地图

| 问题 | 严重性 | 可优化性 | 位置 | SWE 依据 | 处置 |
|------|--------|----------|------|----------|------|
| 主提示词无哲学/价值排序 | 🟡设计 | 🎯战略 | `primary/base.md` | 00 价值排序 | 重写规格 §1 |
| 规则无决策程序（动手 vs 先问、失败处置） | 🟡设计 | 🎯战略 | `primary/base.md`/tasks | 00 可逆决策 | 重写规格 §4 |
| 全文缺具体例子与 MUST/NEVER 分级 | 🟢代码 | 🍒低垂 | 全部 `.md` | 06 代码工艺 | 重写规格 全节 |
| 语言策略缺失（不跟随用户语言） | 🟡设计 | 🍒低垂 | `primary/base.md` | 对齐 kimi | 重写规格 §9 |
| 完成前验证缺失 | 🟡设计 | 🍒低垂 | `primary/tasks/agent.md` | 01/07 可测 | 重写规格 §6 |
| subagent 提示词过薄（各 4 行） | 🟢代码 | 🍒低垂 | `subagents/tasks/*.md` | improve-1 遗留 | 重写规格 §子代理 |
| 行为规则硬编码在 composition.ts | 🟡设计 | 🎯战略 | `composition.ts:296` | 02 关注点分离 | 重写规格 §7 + 治理 |
| 有效提示词散 6 处、文风不统 | ⚪风格 | 🌸锦上 | 见 §三 | 一致性 | 分布地图 + 文风约定 |

**关键发现**
- 最值得马上做的：给全文补**具体例子与 MUST/NEVER 分级**（低垂果实，收益立竿见影）。
- 最大的定时炸弹：**行为规则硬编码在 adapter**——随项目长大，提示词事实源会持续漂移。
- 债务最密集处：`primary/base.md`（哲学、逻辑、清晰度三缺）。

---

## 六、行动建议（指向后两篇）

1. **《重写规格》**（`2026-06-30-rewrite-spec.md`）：9 节行为骨架，逐节给"现状引用 / 问题诊断 / 改写目标与原则 / 参考锚点"，**不出定稿文字**（由人落笔）。
2. **《参考清单》**（`2026-06-30-reference-catalog.md`）：四项目主提示词文件路径、组织范式、可引片段与借鉴点。

---

## 七、反教条警告（写文字时守住）

- **别把参考项目的字照抄**。claude-code 的伦理、kimi 的口吻是它们的产品判断，ohbaby 要提炼**自己的**价值排序，借的是"怎么表达"而非"表达什么"。
- **别为厚而厚**。中档目标是"补齐决策程序与落点"，不是堆到 877 行。每加一句都要过"模型少了它会做错吗"这一关。
- **例子要真**。给的具体例子必须贴合 ohbaby 的工具集（read/edit/bash/task…）与工作流，不能是通用样板。
- **保守项别过度**。安全与"先问再动"是护栏，但过度会让 agent 畏手畏脚——用可逆性分级来平衡，而非一刀切要求事事确认。
