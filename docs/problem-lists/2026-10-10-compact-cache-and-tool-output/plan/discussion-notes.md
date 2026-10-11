# Compact 与工具输出：临时讨论记录

> 日期：2026-10-10
> 最近讨论更新：2026-10-11
> 代码调查基线：`24c70034`
> 状态：讨论过程存档，含已撤回建议。现行需求与整体方案以 [00](./00-discussion.md)、[02](./02-optimization-plan-and-change-scope.md) 为准；本记录不作为逐条实施清单。
> 实施前讨论与规划统一保存在plan/。00～04及模块设计已按最新确认重写；第16节记录本轮确认，旧讨论中的待定状态不代表现行结论。

## 1. 用户已经明确的要求

- 用通俗的语言逐题讨论，每题给出明确建议，不一次铺开所有设计问题。
- 已确认：最近原文正常默认预算为 20K；补齐完整轮次最多放宽到 40K，同时不能超过上下文窗口的 30%。此前随窗口增长的“20% 正常预算”建议撤回，不作为当前设计。
- 已确认优先按完整用户轮次保留。长轮次内部切分和超大不可拆单元的具体处理继续讨论；不把“优先完整”理解为可以无限突破上限。
- 摘要不超过 16K tokens。摘要正文预算与 API 总输出、thinking 预算之间的关系继续讨论，不能直接等同。
- 自动摘要基于下一份正常请求，保留其共享前缀，在末尾追加总结指令。
- 用户再次确认：生成摘要不换短 system，直接使用下一份正常请求的材料和配置，只在末尾追加摘要指令；压缩后的第一次正常请求自然建立新缓存，不额外预热。
- 2026-10-11 用户纠正并确认：自动压缩默认触发阈值为 90%，不是 80%；复用现有容量检查，仅在实际输出预算需要时提前，不硬等到 90%，不为此关闭／降低 thinking 或裁掉摘要输入。现状代码仍是 95%。容量保护不延后超过 90%，不引入复杂预测机制。
- 已确认：手动和自动共用压缩过程，只改变触发方式。会话运行时手动 compact 简单提示忙碌；压缩中不重复发起、不自动取消，只有用户通过会话暂停／停止操作中断。成功后才一次性替换活动历史，失败不能留下前置 prune 已生效的半成品。
- 已确认：成功摘要没有读到的历史不能被标为已压缩；收拢重试，避免同一失败经不同入口重复尝试；取消“整个任务最多成功压缩两次”的限制，保护重点是失败和无收益重试。具体重试次数仍按最小方案细化，不增加配置面。
- 2026-10-11 用户确认保留段算法：从最新往前找约 20K 的位置，先补齐切点所在完整 LLM 返回及关联工具结果，再尝试补齐所在用户轮；整个尾段不超过 `min(40K, 窗口 × 30%)` 才补齐用户轮，否则停在完整 LLM 交互边界。单个不可拆组超过硬上限的例外已在后续确认，见下文及 12.1。
- 用户确认摘要正文不超过 16K 不等于所有接口都发送 maxoutput=16K；要求核实 thinking 用量和估算，缺失部分放到 compact 改造之前。调查发现已有 thinking 计数，需补齐的是请求预算、真实用量明细与摘要用量接线，见 8.5。
- 2026-10-11 用户明确：reasoning 与正文复用现有计数模块，不新建 thinking 计数模块；要求核实持久化及对 20K／40K 保留预算的影响，调查与建议见 8.6。
- 用户明确：摘要请求自己的真实用量和缓存结果必须记录，暂不要求 UI 展示；摘要使用内部输出预算，不继承 `/connect` 的普通请求 maxoutput。后续可增加轻量完成提示，不能把摘要请求消耗和压缩后上下文大小混为一个数字。
- 用户本轮再次确认：thinking／reasoning 的计数补齐是前置任务，复用现有方案，前端后续仅做轻微调整；20K／40K 包含需要回传的 reasoning，不另给 thinking 额度。high effort 下单组超限的处理随后按下一条确认。
- 用户随后确认超大组例外：最新完整交互组超过 `min(40K, 窗口 × 30%)` 时，允许整组纳入摘要，本次原文尾段可为空；摘要可以先于普通请求读取这组新工具结果。未闭合调用和未首次正常交付的新用户输入继续保护。
- 2026-10-11 用户已确认摘要总输出与 thinking 控制分开，32K 总输出作为首版试行值。numeric thinking budget 不增加用户配置项，由内部合理配置；沿用现有解析和容量计算，发送参数与容量预留必须来自同一结果。
- 方案沿用并衔接已有的缓存计数、上下文窗口估算、OpenAI Chat Completions、OpenAI Responses、Anthropic 接口实现。
- 参考八个本地项目的具体做法，结合 ohbaby 的结构选择，不整套照搬。
- 本轮先讨论和记录，不实施代码，也不提前重写正式文档。
- 已确认：模型上下文只保留一份更新后的摘要；历代摘要和原始记录继续保存在数据库中。将来的旧信息召回保留扩展空间，本轮不提前设计或实施召回系统。
- 新摘要必须覆盖旧摘要承载的重要信息和后续进展，不能只记录当前窗口新增的内容。
- 新事实可以修正旧事实；用户约束不能在缺少依据时被改写。摘要记录冲突、疑问、可选方案和受影响的操作，不把“停下来讨论”设计成统一的强制要求。用户补充：ohbaby 目前没有 ask-user 工具，可以继续不受影响的工作，在合适的交互时机用回复提出问题或选择项。
- 已确认摘要沿用现有七节，并继承仍有效的旧信息；16K 是上限，不沿用“原历史的 15%～30%”作为摘要目标。具体措辞仍可在正式方案中调整。
- 遵循 SWE 原则，优先复用现有结构，避免过度设计。
- 已确认：按当前路线重构复杂的 prune/mask，遵循 KISS；工具调用关系不变，错误与未完成状态不能被裁没，已发送预览及引用保持稳定；摘要提交后不再额外裁剪保留原文。
- 用户要求重点核对接近窗口上限、压缩前最后一次普通请求、摘要请求、摘要后第一次普通请求的缓存复用能力。目标是消除客户端造成的无谓失效，不把提供商缓存命中当作无条件保证。
- Shell／Bash 独立议题在 `docs/problem-lists/2026-10-11-shell-and-glob/`，用户明确其与本轮无关。本议题不承接该议题的业务范围，也不把它列为实施前置；此前关于“先完成 Bash 输出契约”的依赖推断撤回。
- 用户提供了 Codex“聊天期间无法使用 Compact”的提示截图作为交互参考；Web／TUI 提示将在后续专门优化。本轮只确定后端行为和结果含义，不改界面或新增提示系统。

## 2. 文档分工与实施阶段：以用户最新说明为准

- `docs/core/context/improve-7/` 是 Context 模块的变更与方案记录，说明模块如何变化以及变化原因。
- `docs/problem-lists/2026-10-10-compact-cache-and-tool-output/` 承载真正的实施规划、阶段拆分和实施记录。
- 后续实施分为多个 `improve-N` 阶段，不能把所有工作塞进一个 `improve-1`，仅靠内部 Stage 编号分开。
- Context 的 `improve-7` 不与议题的 `improve-1` 一对一绑定；它可以记录该议题多个实施阶段对模块带来的变化。
- 用户已确认五个 improve 实施批次；第五批增加安全删除旧机制、代码清扫和 SWE 检查。规模过大或新增独立流程时再考虑第六批，目前不预建目录。
- 2026-10-11 用户指定：实施前讨论和现有规划全部放到本议题的 `plan/`；`improve-1/` 等第一批实际实施时再建立。模块侧旧规划暂收进 `plan/context-design/`，`docs/core/context/improve-7/` 保留模块记录入口。
- 现有 README 中“全部放在 improve-1”“Stage 1、Stage 2 都算 improve-1”“Context improve-7 对应议题 improve-1”的表述，已与用户最新要求不一致，正式重写时修正。

## 3. 已核实事实

### 3.1 多份摘要会累积

ohbaby 的 `getActiveHistory()` 把所有有效摘要放在普通历史之前；`generateSummaryCandidate()` 却排除旧摘要，只总结选中的普通历史。提交新摘要不会让旧摘要退出活动视图。

- 代码：`packages/ohbaby-agent/src/core/context/context-manager.ts:220`、`:823`、`:986`。
- 离线实验：预置一份旧摘要，连续成功压缩两次，模型视图同时保留三份摘要；两次摘要输入都没有旧摘要。
- 风险：摘要总量不断增加，旧状态与后来的修正并存。

### 3.2 摘要超窗兜底存在覆盖范围不一致

超窗重试缩小 `summaryHistory`，成功后的候选却仍使用原始 `historyToCompress` 作为提交范围。

- 代码：`packages/ohbaby-agent/src/core/context/context-manager.ts:925`、`:968`、`:988`。
- 离线实验：首次摘要请求模拟超窗，重试省略最早一轮；成功提交后，被省略的那一轮也被标为已压缩。
- 风险：没有进入成功摘要请求的独有信息，也从活动上下文退出。
- 待确认建议：摘要覆盖范围与退出活动视图的范围必须一致；失败或缩小输入不能暗中扩大移除范围。

### 3.3 裁剪发生在多个位置

| 位置 | 当前行为 | 初步建议，待逐题讨论 |
|------|----------|--------------------|
| 源头捕获 | Bash 保留有限头部或尾部；Grep 可提前停止；Read 分页 | 保留资源限制，准确记录内容是否完整 |
| 返回结果限长 | 部分工具截正文，常用字符近似 token | 统一模型入口预算；超长证据可回查 |
| 历史 mask | 可替换结果、错误或中止输出正文，生产默认关闭 | 从常规自动路径移除 |
| 历史 prune | 移除符合条件的 completed tool part 的模型投影，包括调用和结果 | 不在摘要之前执行，不以 prune-only 结束自动维护 |
| 摘要提交 | 让被摘要替代的原文退出活动视图 | 保留，明确覆盖范围并原子提交 |
| 摘要超窗恢复 | 缩小摘要输入后重试 | 修复覆盖范围，单独设计有界恢复 |

prune 跳过带有效原生模型状态的消息，但没有 mask 的工具名前缀豁免规则。不能把两种机制的保护条件混为一谈。

### 3.4 已有验证的范围

- 6 个相关测试文件、120 项测试通过，覆盖现有 Context、请求准备、mask、原生工具依赖和三种接口的缓存请求体契约。
- 另做两个内存存储与模拟摘要客户端的离线实验，核实 3.1、3.2。
- 没有运行真实模型 API。以上不能证明真实缓存命中率、价格收益或摘要语义完整性。
- 未修改业务代码或正式设计文档。

## 4. 当前讨论：旧摘要怎样延续

### 已确认：一份滚动摘要，历史记录继续保存

采用一份滚动更新的有效摘要：上一份摘要与随后需要压缩的原文共同生成新版摘要；成功后，新版替换旧版在模型上下文中的位置。数据库继续保留原始记录和历代摘要。

用户确认该方案能简化当前摘要管理，同时为未来召回保留扩展空间。召回机制本轮不提前实施；后文提到的引用仅使用已经存在且确实可用的标识或路径，不虚构查询能力。

正常自动摘要仍发送当前完整请求加总结指令，最近保留段也可供模型理解上下文；“摘要需要覆盖的范围”与“摘要请求看见的范围”要分清，不能为了分离材料而重新拼坏请求前缀。

首次从当前实现迁移时，需要合并所有有效旧摘要，因为它们分别覆盖不同历史；不能只取最后一份。此后才维持单份有效摘要。

### 建议优先保留的信息

1. 当前用户目标、仍然有效的限制、明确的修正和授权范围。保留原意及适用范围，不能把授权扩大。
2. 已确认完成的工作、当前步骤、未解决问题；新证据更新旧状态。
3. 影响下一步的决策与理由、重要文件路径、命令和验证结果。
4. 已发出但结果未确认的操作，包括关联任务 ID；不能把“已发起”写成“已完成”。
5. 已有的证据引用。没有回查入口时，不宣称模型可以读取；旧摘要和数据库记录的通用召回机制留待未来讨论。

不继续累加已过时的状态、重复日志、每次尝试的叙事过程；近期保留原文中的细节无需在摘要里大段重复。失败尝试若会影响后续决策，则保留原因和结论。

滚动摘要仍然有信息损失风险。提示词和结构检查不能证明每项事实都被正确保留，后续验收需要连续多次压缩的场景，而非只测一次短摘要。

### 参考依据

- OpenCode：`packages/core/src/session/compaction.ts:47`，明确旧摘要会被替换，要求继承旧约束、让新事实修正旧状态。
- Pi：`packages/coding-agent/src/core/compaction/compaction.ts:880`，提取上一份摘要并走更新路径。
- Reasonix：`internal/agent/compact_incremental_test.go:65`，再次压缩后只剩一个主摘要的测试。
- Codex：`codex-rs/core/src/compact_remote_v2.rs:478`，新活动视图不累积旧 Compaction。

### 4.1 四个参考项目的实际提示词调查

以下路径相对于 `/Users/hansun025/Projects/code-cli/`。这里只借鉴内容要求，不替换正常请求的 system，不照搬其历史筛选或缓存处理。

| 项目 | 实际来源 | 可复用的内容规则 | 不直接采用的部分 |
|------|----------|------------------|------------------|
| kimi-code | `packages/agent-core-v2/src/agent/fullCompaction/compaction-instruction.md:10` | 交接信息自足；有效旧要求继续保留；已定与未定分开；保留真实命令、结果、关键数据；明确未知和未验证事项；保持对话语言 | 自动附加日志回查指针、重挂 TODO 是 Kimi 的能力，ohbaby 不能只复制文字就宣称具备 |
| codex | `codex-rs/prompts/templates/compact/prompt.md:1` | 进展、决策、约束、下一步、关键数据与引用；简洁且有结构 | 这是本地摘要模板，不代表 remote v2 服务端的完整压缩提示词 |
| claude-code | `src/services/compact/prompt.ts:62` | 用户意图和纠正；文件与技术决策；未完成任务；不把助手伪造的用户口吻归为用户要求或批准 | 本地仓库是逆向重建；不照搬全部用户消息和大段代码逐条复述，也不要求输出随后被丢弃的分析草稿 |
| ZCode | `apps/zcode-cli/packages/core/src/compact/prompt.ts:14` | 跨整个对话保留用户要求、错误与修复、当前工作、未完成事项；关键限制尽量保留原措辞 | 不照搬长日志式九节模板或无条件禁止向用户提问的续接规则 |

Claude Code 的 `getCompactUserSummaryMessage()` 和 ZCode 的 `buildCompactSummaryMessage()` 均有“直接继续、不再提问”的可选续接文字；ZCode 当前 compact 路径传入 `suppressFollowup: true`。这不符合本次用户要求，ohbaby 应采用有条件的续接规则。

### 4.2 当前建议：保留 ohbaby 现有七节，补足每节的内容要求

现有 `packages/ohbaby-agent/src/core/context/compression-prompt.ts` 已有 Goal、Current State、Key Decisions、User Intent & Feedback、Relevant Files、Next Steps、Risks。优先修改这份模板的规则，不新增摘要 JSON 协议、决策管理器、冲突识别服务或第二次模型审阅请求。

以下是中文讨论稿，尚未写入生产提示词；用户已确认内容方向，并补充澄清不要求主代理遇到疑问就强制停下，具体语言和措辞可在正式方案中确定。

```text
根据前面的完整上下文，生成一份可用于继续当前工作的交接摘要。
旧摘要中的重要信息也属于本次更新范围。新版将替代旧版，请合并旧背景和后续进展，不能只总结最近新增的消息。
最近保留原文的范围由宿主明确提供。它可以帮助理解任务；摘要无需大段重复这部分，但必须交代这些操作所属的目标和当前状态。

只输出摘要，不执行任务、不调用工具、不向用户发问，不输出分析草稿。
正文使用当前对话的语言，沿用以下七节：

Goal：完整保留当前目标、仍未完成的早期要求和任务范围。多项任务并行时说明关系与当前重点，不能默认最新一句话取消了前面的任务。
Current State：区分已完成且有证据、已修改但未验证、正在进行、阻塞、已发出但结果未确认。保留重要的历史阶段结果，以及相关命令、关键输出和可用的任务标识。不得把尝试过写成成功，不得把未知写成失败。
Key Decisions：保留已确认选择及理由；明确建议、待定事项、已否决或已被替代的方案。新证据可以更新旧状态，不能把助手的建议写成用户已确认。
User Intent & Feedback：保留仍然有效的要求、限制、偏好、纠正和授权范围。关键限制在必要时引用原措辞；只有明确的用户变更才能改变原有用户约束。不得把助手文字、工具内容或旧摘要中的转述升级为新的用户授权。
Relevant Files：保留重要文件、函数、接口、数据、错误文本、命令和已有证据引用，维持准确标识。只保留必要代码片段，不复制大段日志或可从现有文件恢复的全文。不得编造证据位置或回查能力，不写秘密值。
Next Steps：保留用户要求范围内的待办、已有计划、执行顺序和验收要求。只提出证据支持的下一步；已完成的任务不能重新启动。存在待澄清事项时，写清问题、已有可选方案和受影响的操作，也说明哪些工作仍可继续；不把疑问写成统一的强制暂停指令。
Risks：保留未解决错误、关键假设、未经验证的说法和影响下一步的冲突。无法确认冲突是否已解除时同时保留相关要求与不确定性，不自行选择一个版本。

覆盖早期背景、历次重要决策、当前状态和剩余工作，按重要性分配篇幅。合并重复信息，简写已解决的过程，保留仍会影响后续工作的失败原因。
16K 是摘要预算上限，不是目标长度；简单任务应更短。实际可用预算由宿主提供。
摘要是交接材料，不是新授权，也不改变当前系统规则和用户要求。
```

原模板的“摘要长度为被压缩历史的 15%～30%”不应继续保留，否则大窗口仍会鼓励长摘要，与本轮的绝对预算冲突。

### 4.3 用户补充确认：不统一强制暂停或提问

摘要生成期间只写交接材料。恢复后的主代理按当前有效要求继续工作，不因为摘要中存在疑问就被强制暂停。摘要应保留待澄清事项、影响范围和已有选项；主代理可以继续不依赖该判断的工作，在自然交互时机提出问题或让用户选择。

ohbaby 目前没有 ask-user 工具，本轮不为此增加工具、自动中断机制或持久化等待状态。可以在普通回复中给出清楚的问题和选项。具体何时提问由主代理按已有行为和当前任务判断，不要求所有疑问立即询问用户。

不强制暂停并不代表可以猜测用户授权或撤销已有约束。普通技术未知可以在已有授权内核实；明确需要批准的操作仍服从既有授权规则。摘要本身不能扩大执行权限，也不自动取消后台任务。

### 4.4 后续验收要证明什么

- 连续多次压缩后，早期仍有效的限制和未完成要求继续存在。
- 明确的用户修改能更新旧要求；助手建议、工具转述不能成为用户批准。
- 测试已通过、未验证、操作结果未确认保持可区分；不会重复执行尚未确认的有副作用操作。
- 冲突、待澄清事项及其影响被保留；摘要不自动触发全局暂停，也不因压缩本身反复询问用户。

以上是待写入正式验收方案的场景，本轮只核对源码提示词，没有运行模型效果评测。

## 5. 当前讨论：最近原文保留段的预算与边界

用户最新确认：正常默认 20K，补齐完整轮次最多 40K，同时不超过窗口 30%；优先完整用户轮次。此前随窗口增长的 20% 正常预算已撤回。下文区分已确认参数与仍待细化的边界处理。

### 5.1 当前实现与参考依据

- ohbaby：`packages/ohbaby-agent/src/core/context/compaction-policy.ts:214` 按普通活动历史估算保留量。历史超过 `KEEP_RECENT_TOKENS` 时主要采用固定 20K 预算；较短时才使用 `fullTokens × compressionPreserveRatio`，默认比例 0.3。当前不是按完整模型窗口的 20% 计算，也没有 30% 窗口硬上限。
- ohbaby：同文件 `findCutPoint()` 从末尾累计，允许在用户或助手消息处切分；未结束的原生依赖会把切点往前拉，因此实际保留量可以超过预算。
- ohbaby：`packages/ohbaby-agent/src/core/context/native-context.ts:6` 已把原生助手消息与关联工具结果视为不可拆单元。应沿用这个约束，不为本议题另建平行的依赖管理系统。
- Pi：`/Users/hansun025/Projects/code-cli/pi/packages/coding-agent/src/core/compaction/compaction.ts:431` 允许从长用户轮次内部切分，保留助手调用与结果的配对，并将轮次前段纳入摘要。借鉴切分思想，不直接复制其固定预算或另起一份摘要的流程。

### 5.2 本次重新调查：实际生效的保留预算

各行首个路径相对于 `/Users/hansun025/Projects/code-cli/`；同行后续短路径相对于首个文件所在目录，仅行号沿用前一个文件。核对本地源码和自动入口，未调用模型，不把参考数值当作质量验证结果。

| 项目与路径 | 当前默认 | 范围及限制 | 关键源码 |
|------|----------|------------|----------|
| Pi | 固定 20K | 完整模型消息尾段；从后向前累计接近预算，允许拆用户轮；没有轮数上限和补齐后的第二道绝对上限 | `pi/packages/coding-agent/src/core/settings-defaults.ts:8`、`compaction/compaction.ts:817`；自动入口 `agent-session.ts:3097` |
| OpenCode 旧 session | `min(15K, max(2K, usable × 25%))` | 按用户轮及其 assistant/tool 选尾段；支持 `tail_turns` 候选轮数，但默认不设；可拆长轮次 | `opencode/packages/opencode/src/session/compaction.ts:115`、`:223`；自动入口 `prompt.ts:1149` |
| OpenCode 新 core | 8K | 序列化后的消息后缀，工具结果先缩到 2,000 字符；无完整用户轮分组 | `opencode/packages/core/src/session/compaction.ts:95`、`:123`；自动入口 `runner/llm.ts:224` |
| Kimi 当前 full | 用户输入 20K，超限时最早约 2K、最近约 18K | 只保留用户输入，不包括完整 assistant/tool 尾段；边界用户消息可以截断 | `kimi-code/packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts:10`、`:86`、`:236` |
| Codex local / remote v2 | 20K / 64K | local 只保留用户文字；remote 保留特定用户、hook、agent 消息，不是完整工具历史。按 provider capability 分流，不能把 local 20K 当全局默认 | `codex/codex-rs/core/src/compact.rs:63`、`:583`；`compact_remote_v2.rs:73`、`:545`；分流 `session/turn.rs:1461` |
| 本地 Claude Code 重建版 | 普通完整 compact 不固定留尾段；可选 session-memory 为 min 10K / max 40K / 至少 5 条带文字消息 | 5 条消息不是 5 个用户轮；工具配对及消息分片修正后可能超过 40K。session-memory 开关 fallback 为 false，不能说是官方线上统一默认 | `claude-code/src/services/compact/sessionMemoryCompact.ts:57`、`:326`、`:405`；普通路径 `compact.ts:767` |
| ZCode | 正常自动压缩留最近 1 个 assistant 起始交互组 | 不是 1 个用户轮；没有尾段 token 帽；overflow 选择和重试可能增加保留组数 | `ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/compact-selection.ts:30`、`:59`；分组 `../../compact/rounds.ts:10` |
| deepseek-harness | `16% × 可用消息预算` | 可用预算扣除普通请求输出预留；没有额外绝对 cap；工具配对会向前扩展 | `deepseek-harness/packages/compaction/compaction-basic/src/config.ts:172`、`:219`；`region.ts:133` |
| DeepSeek-Reasonix | `16% × 有效窗口` | 1M 对应 160K；常规还会保住整个当前用户轮，可能更大；没有额外绝对 cap，超窗路径才拆当前轮 | `DeepSeek-Reasonix/internal/agent/compact.go:126`、`compact_threshold_test.go:29`、`compact_projection.go:682` |

这些项目说明固定预算、比例预算和按交互组保留都存在，并不支持“窗口越大就必须保留同比例原文”。Kimi/Codex 的 20K 与 ohbaby 完整尾段不是同一口径；OpenCode 新 core 的 8K 也不能脱离其工具结果缩短直接比较。

### 5.3 已确认：固定 20K 正常预算，40K 只用于补齐，且不超过窗口 30%

- C 表示 ohbaby 当前为该模型采用的有效上下文窗口，沿用现有窗口与模型配置，不另造一套限额来源。
- 正常默认 20K 已确认，沿用 ohbaby 已有量级。此前另外提出、尚未确认的“小窗口 20% 保护”撤回，避免与已确认的 30% 硬上限并列增加一套比例。当前简化建议为 `B = min(20,000, H)`，再服从整请求容量检查；这项小窗口接法与 5.5 的切分细节一起讨论。
- 补齐完整边界的上限 `H = min(40,000, 0.3 × C)` 已确认。40K 是本议题选定的绝对上限，不是 Claude 源码已保证的硬帽，也不是已验证的最佳值；用于给 20K 附近的轮次留余量，不是正常填充目标。
- 128K 窗口：正常 20K，补齐最多 38.4K；200K 窗口：正常 20K，补齐最多 40K；1M 窗口：同样正常 20K，最多 40K。按当前简化建议，64K 小窗口最多保留 19.2K，不额外设 12.8K 档位；还需通过整请求容量检查。
- 不默认再增加“最多最近 2／3 个用户轮”的限制。两句短的“继续”“这个先别改”也会成为新轮次，固定轮数可能把前面的详细任务过早移入摘要；20K 已控制总体积。OpenCode 旧路径支持这种配置，但默认没有启用，不能作为两轮最优的证据。
- 不为当前讨论增加 32K／60K 档位、自适应策略或新的配置面。20K／40K 的选择需要后续多次压缩场景验证；若观察到具体信息连续性不足，再据证据调整。
- 原文预算计入该段实际发给模型的用户消息、助手消息、工具调用与结果、必要原生状态和相关内容；不能只计算可见文字。数据库里的完整日志和未进入主请求的子代理内部历史不算入该段。
- 系统提示、工具定义、最新摘要不占这个“原文预算”，但必须一起计入压缩后总请求的窗口检查。比例是估算规则，不保证提供商的精确 token 计数；最终沿用统一请求估算和输出预留规则。
- 示例只用于说明量级：系统与工具 12K、摘要实际 8K、保留原文 20K，总输入约 40K。不能把原文 20K 误认为整个压缩后输入只有 20K。摘要 16K 是上限，不应主动补满到 16K，也不要求总输入填满窗口的 50%。

### 5.4 更新后的切分建议

1. 从最新记录向前选取连续尾段，按 B 估算；优先落在完整用户轮次起点。20K 是预算，不保证精确留下 20K，不把数据库中已退出上下文的旧消息重新取回凑数。
2. 若正常预算边界落在某轮中间，可以向前补齐该轮，但总量不能超过 H。只为补齐边界放宽，不为了多留几轮主动塞到 40K。
3. 若补齐后超过 H，先选择更短的完整用户轮次尾段；若最新用户轮本身就超过 H，允许在其内部已完成的工具交互边界切分，尽量靠近 B。用户原始要求和前段进展进入唯一的新摘要，不增加第二份“轮次摘要”。
4. 单个工具调用、对应结果和协议要求的原生状态不能拆开。一组并行调用及其关联结果按现有消息与原生依赖结构处理，不能只留下结果或只删调用。
5. 修正边界后重新计量，不允许协议配对把 H 悄悄突破。完整请求若仍放不下，还需继续收紧预算；尾段合规不代表整份请求一定合规。
6. 若最新单个已完成依赖组本身就超过 H，正常尾段选择无法同时满足保留原文和上限。可讨论将该完整组也纳入摘要、尾段为空的有界退路；未结束的调用不能据此清除。具体超大输出与恢复规则在对应议题确定，不能先破坏依赖或假报成功。

上述规则复用现有切点计算、原生依赖保护和请求估算，不新增尾段管理服务，也不在本轮实施。20K 默认、40K 补齐上限、最多 30% 窗口及优先完整用户轮次已确认；长用户轮次内部切分与单个超大依赖组的恢复细节继续讨论。

### 5.5 本轮继续讨论：一轮很长，或一个完整工具组就超过上限

复核依据：Pi 的 `findCutPoint()` 允许在用户轮内部切开，工具结果本身不是合法切点；OpenCode 旧 session 的 `splitTurn()` 在一轮放不下时选择其后缀；Reasonix 正常路径保护完整当前轮，超窗恢复才允许折叠当前轮的早期交互。分别见 `/Users/hansun025/Projects/code-cli/pi/packages/coding-agent/src/core/compaction/compaction.ts:351`、`:431`；`opencode/packages/opencode/src/session/compaction.ts:140`；`DeepSeek-Reasonix/internal/agent/compact_projection.go:682`。借鉴切分思路，不将它们的全部保护条件或额外轮次摘要直接搬入 ohbaby。

明确建议，尚待本轮讨论确认：

1. 完整用户轮次是优先目标；工具调用、关联结果和协议必需状态完整配对是硬约束。若完整一轮超过 H，不以“保整轮”为由放宽到 60K、80K。
2. 在该轮内部已经闭合的交互之间切分，选靠近 B 的连续尾段；前面的用户目标、约束和进展并入唯一新版摘要，不新增“当前轮摘要”。摘要请求仍看完整材料，切分只决定成功后哪些旧原文退出活动视图，不是发送摘要前先删材料。
3. 一个不能拆开的组超过 B 但不超过 H，可以完整保留该组；不能先剪短已发送的工具结果再假称满足 20K。重新计量后仍必须满足 H 和整请求容量。
4. 如果最新的单个已闭合组本身超过 H，可将其完整纳入摘要覆盖范围，允许这次保留原文为空。摘要必须明确交代当前操作的结果、未完成状态、任务标识、错误与必要引用；不得将其直接删除或只保留一半。只有完整摘要请求仍可发送且成功通过校验时才能采用此退路，否则保留旧历史并报告失败，不绕过容量检查。
5. 尚未返回对应结果、协议尚未闭合的调用不能这样处理。按现有工具执行或中断恢复路径先完成真实收尾，不能伪造成功结果，也不能把缺少工具结果的历史直接接上摘要指令。
6. “协议已闭合”不等于后台业务任务已经完成。Bash 已返回 job ID 和 running 状态，或者子代理已返回任务标识时，这次工具调用已有结果；后台任务继续运行不应独自阻止 compact。若这段被摘要，必须保留任务标识、已知状态、待确认结果和现有查询方式，不能写成已完成。ohbaby 已有对应状态：`packages/ohbaby-agent/src/tools/bash.ts:111`、`shell-job-registry.ts:480`。具体返回约定以实施时已有代码核实，不假设独立 Shell 议题会改变它。
7. 本规则用于已进入工作历史的长轮次。刚收到、尚未首次交给正常模型请求的新用户输入仍遵守现有 protectedInputs 规则，不为满足尾段预算而先替用户压掉。它不是被保留的旧原文，需另计入下一次整请求容量。

例：当前一个用户轮已累计 80K，最后若干完整交互为 18K，则将前面的要求和进展合入新摘要，原样保留最后 18K。若最后一个不可拆组为 28K（H 至少 28K），可以整组保留；若最后一个已闭合组为 50K 而 H 为 40K，则整组进入摘要，不强留 50K，也不裁成半组。

这属于现有切点选择的边界处理，不新增尾段服务、轮次摘要类型、后台任务管理器或新的存储体系。原文为空只用于无法保留最新完整组的例外，不作为正常保留策略。

### 5.6 2026-10-11 已确认：用户轮与 LLM 交互边界

用户此前明确说过“我也同意优先按完整用户轮次保留”，随后确认“正常默认用 20K 补齐完整轮次最多放宽到 40K，同时不能超过窗口的 30%”。经过参考代码复核后，用户进一步明确确认本节的三步算法。当前仍沿用原预算；单个不可拆组超过 H 等例外不随之自动视为已确认。

- 用户轮：一条真实用户输入及其后的助手、工具工作，到下一条真实用户输入前；它可以包含多次 LLM 调用。
- LLM 交互组：一次模型返回，以及它发起的调用对应的全部工具结果和协议必需状态。这里只计算新增记录，不重复累加每次请求携带的旧输入。纯文字回复也可以形成一个组；依赖关系以已有原生协议保护为准，不仅凭消息角色切分。
- 保留原文按 token 预算决定数量，以完整交互组保证调用关系，有空间再补齐用户轮。不采用固定保留 N 次 LLM 调用或 N 个用户轮。

本轮重新核实的差异：

| 项目 | 实际边界选择 | 对本方案的意义 |
|------|--------------|----------------|
| Pi | `prepareCompaction()` 实际调用 `findProjectedCutPoint()`；从最新往前达到 20K 后，选该位置或更靠近尾部的合法 user／assistant 切点，不能从 toolResult 开始；末尾无后续切点时可能保留超预算的完整调用组 | Pi 不主动补齐用户轮，也没有 40K／30% 硬帽。不能把 ohbaby 的用户轮补齐建议说成 Pi 原算法 |
| OpenCode 旧 session | 按真实用户轮从后选择，整轮放不下再选轮内后缀；默认预算为 `min(15K, max(2K, usable × 25%))` | 可借鉴“用户轮优先、长轮可拆”，顶部 prune 的 20K／40K 常量不是这个保留段预算 |
| OpenCode 新 core | 默认 8K，从尾部选序列化文本条目；工具正文会先缩到 2,000 字符 | 和 ohbaby 保留完整原生交互的口径不同，不拿 8K 直接证明应降低预算 |
| ZCode 当前自动路径 | 每条 assistant 消息开始一个组，后续工具消息归同组，正常自动压缩默认留最近一组；手动路径不同 | 存在按助手交互组保留的实现，但组数不能保证 token 体积 |

源码相对于 `/Users/hansun025/Projects/code-cli/`：Pi `pi/packages/coding-agent/src/core/compaction/compaction.ts:351`、`:817`、`:898`、`:994`，默认 `core/settings-defaults.ts:8`；OpenCode `opencode/packages/opencode/src/session/compaction.ts:115`、`:122`、`:223` 与 `opencode/packages/core/src/session/compaction.ts:13`、`:137`；ZCode `ZCode/apps/zcode-cli/packages/core/src/compact/rounds.ts:13`、`runtime/helpers/compact-selection.ts:36`、`:362`。均限定本地检出版本。

已确认算法：从尾部按 B 找到预算边界，先向前补齐该处不可拆的 LLM 交互组；若仍不超过 H，再尝试向前补齐所在用户轮。若补齐用户轮超过 H，回到完整交互组边界，前段交给同一份新版摘要。每次补齐都检查整个尾段的体积。此处替代 5.4 第 3 项中“先选更短完整用户轮尾段”的优先顺序，避免为凑完整用户轮无必要地少留大量近期细节。5.4／5.5 与本节重复的轮内合法切分部分以本次确认状态为准。单个依赖组超过 H 的例外继续按 5.5 单独讨论，不暗中突破上限。

按代码推导的示例，不是模型实测：用户消息 1K，后面 A、B、C 三组调用各为 0.5K 调用与 8K 结果，总共 26.5K。Pi 从尾部累计到结果 A 时达到预算，但结果不能作为切点，因此保留 B、C 共 17K。ohbaby 若采用上述补齐规则，并且 H 为 40K，则可以补齐用户轮，留下 26.5K。对于一个 60K 的用户轮，若最近三个完整交互组依次为 7K、8K、9K，20K 边界会落在 7K 那组内部，补齐后留 24K；整轮 60K 放不下，前 36K 进入新版摘要。

20K／40K 是首版选择，参考代码不能证明它是最优值。本轮建议不改数值；后续用真实会话回放检查多次 compact 后的任务衔接、是否反复重读刚压掉的必要材料，以及压缩频率，再决定是否需要调整。保留段选择不改变摘要输入；摘要成功后才一次性切换活动历史。

## 6. 已确认方向：工具输出限长与历史裁剪的去留

用户已确认按当前路线重构 prune/mask，以及调用关联、错误和未完成状态、稳定预览及引用三项约束；摘要后不再额外裁剪保留段。以下具体接入方式、单条和同批结果预算、兼容迁移与异常恢复仍需细化，未修改代码。

### 6.1 本轮复核的 ohbaby 现状

- `context-manager.ts` 的 `pruneHistory()` 只选择已完成工具输出，跳过带活动原生模型状态的消息；不是扫描并裁短所有 user/assistant 普通文字。默认保护最近约 40K 工具输出，可回收不足 20K 就不执行。
- prune 将整个工具 part 标为 compacted。`serializer.ts:109` 先过滤 inactive part，随后依据余下 part 同时构造调用和结果，所以调用参数和结果都会退出模型视图，不是仅结果正文缩短；数据库记录仍保留。
- `projection.ts:46` 的 mask 默认关闭；开启后可替换 completed 的 output、error 的 error 文本，以及 aborted 的已有 output，保留调用结构。它仍会改变已发送历史的正文，与“固定入口预览”不是同一机制。
- `context-manager.ts` 自动路径先 prune 再测量；降到摘要阈值以下就直接返回 `pruned`，不会生成摘要。这是本议题所指“清一点就停”的具体路径。
- 工具源头已有不同限制：Bash 捕获约 32K 字符的头部或尾部；Read 使用行数、50 KiB 和游标分页；Grep 可达到输出限制后提前停止扫描。不能因此声称完整输出已经存储。
- `tools/utils/output.ts` 名为 8K token 的默认限长，经 `utils/truncate.ts` 实际转换为约 32K 字符。它不等于统一 token 估算，也没有统一覆盖所有工具。
- MCP 的 `transformMcpResult()` 将多个内容块转成 output 文本，图片和音频还能变成含 base64 的字符串；这里没有通用大小上限。媒体语义需要单独保留，不能只截 base64 文本。
- 子代理回传给主代理的报告与执行状态会进入主上下文；子代理自己的全部内部历史不会因此自动整体进入主请求。回传报告需要接受主请求的预算，但不能删掉执行 ID、状态和必要结果说明。

上述文件均位于 `packages/ohbaby-agent/src/` 对应的 `core/context/`、`tools/`、`mcp/integration/` 下。

### 6.2 建议：保留入口限长，取消日常改写旧结果

| 动作 | 建议 | 原因 |
|------|------|------|
| 捕获时限制内存、磁盘、扫描量；Read 分页 | 保留并说明完整性 | 控制工具自身资源，模型预算不能替代这些限制 |
| 工具结果首次进入模型请求前限长 | 保留，统一兜底 | 避免单条／并行结果第一次就把上下文撑满 |
| 已发送旧工具结果按年龄或当前压力继续缩短 | 从常规路径移除 | 反复改写前缀，丢失已读证据，容易使维护停在阈值附近 |
| 摘要成功后，覆盖范围内的旧消息退出活动视图 | 保留，成组原子提交 | 已由新摘要接替，数据库仍保留原始记录 |
| 摘要失败、已超窗、旧版本遗留超长结果 | 单独讨论有界恢复／迁移 | 不能为了处理例外恢复常规 prune-first，也不能假装没有损失 |

“先压缩”不意味着“摘要后必须再裁一次”。正常目标是入口就有稳定上限；摘要成功后留下新摘要与选定原文，原文不再额外改短。历史兼容与超窗例外在对应议题细化。

### 6.3 首次给模型的结果定型后保持稳定

1. 在工具结果第一次进入模型请求之前，决定模型看到的正文。短结果保持原样；超长结果生成稳定预览，保留工具已有的行号、分页游标、执行状态及截断说明，不能盲目截掉尾部关键提示。
2. 对确实捕获到的较大正文，可保存到受管理的文件中并给出真实、可访问的引用；复用现有工具读取能力，不为本轮另建召回系统。保存有资源上限，必须区分全文、部分捕获、保存失败。
3. 固定的不只是预览正文，还包括实际发出的引用与说明。重试、后续 step 和重启后重放同一版本；未截断过的已发送结果也不因以后预算变小被重新裁剪。
4. 调用 ID、工具名、输入参数、结果配对与执行状态继续保留。大块结果正文可以缩短；输出保存失败不能把已成功的外部操作改成失败，更不能诱导重复执行。
5. 本轮曾建议额外设置同批工具结果预算，用户随后指出限制过于机械，已撤回。继续使用工具自身已有分页／限长和整请求容量检查，不新增批次配额或分配算法；已发送历史保持稳定。
6. 文本、结构化结果、图片／音频不能混为一段字符串处理；模型实际收到的内容统一计量。非必要内部元数据不应泄漏进模型正文，但压缩与回放所需状态要保存在内部记录中。

这里的“稳定”针对已经送入模型的历史条目，不要求正在运行的工具停止更新。后续状态查询返回的是新的结果记录；旧的已发送结果不原地改成最新状态。

### 6.4 参考项目中值得借的部分

- Codex 将当次历史截断预算写入 metadata，重放沿用该值，避免重启按新预算改旧结果：`codex/codex-rs/core/src/session/mod.rs:3603`。
- 本地 Claude Code 重建版保存 `seenIds` 和 replacements，首次未截断的结果也冻结，恢复后沿用已保存的准确替换正文：`claude-code/src/utils/toolResultStorage.ts:369`、`:741`、`:940`。
- Kimi 明确区分全文、仅保存捕获部分和保存失败：`kimi-code/packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts:264`。
- ZCode 将内存预览与磁盘捕获上限分开，并记录捕获／保存是否完整：`ZCode/apps/zcode-cli/packages/adapters/src/exec/output-collector.ts:51`。

参考路径相对于 `/Users/hansun025/Projects/code-cli/`。本轮只讨论如何借鉴，不整套引入其他仓库的输出存储体系，也不增加额外模型调用去总结每条工具结果。

缓存预期：避免历史结果被再次裁短所造成的前缀变化；并不保证每次请求一定命中。若旧消息中间被改写，改动之前的前缀仍可能复用，不能笼统说整份请求的缓存必定归零。

## 7. 本轮继续讨论：缓存衔接与工具议题边界

### 7.1 新核对到的 ohbaby 请求差异

- `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts:101` 当前将摘要材料重新拼成短 system、序列化历史的 user 文本和摘要指令；不带普通请求的 tools。历史的角色、原生状态和工具协议表示因此不再与普通请求相同。
- `packages/ohbaby-agent/src/core/llm-client/prompt-cache.ts:215` 将所有非 `agent-step` 请求降为 `observe-only`，所以 `context-summary` 没有沿用主动缓存控制。这不等于提供商的隐式缓存被关闭。
- 同文件 `:125` 当前将 Responses 设为 observe-only。OpenAI 官方 Responses 支持 `prompt_cache_key`，这里是本地尚未接入，不能解释为接口不支持；兼容端点仍应按已经核实的能力处理。
- `packages/ohbaby-agent/src/core/context/context-manager.ts:435` 已有 `assembleModelRequest()`，应复用它形成摘要请求的基础。当前 `PreparedModelRequest` 只固定消息、工具及输入记录标识，尚未固定全部模型／端点／reasoning 配置；仅共用 messages 数组不足以保证实际发送前缀一致。
- `packages/ohbaby-agent/src/services/interface-providers/anthropic.ts:383` 当前显式策略主要标记最后一个合适的消息块；官方自动策略另外标记稳定 system。摘要要在原历史末尾追加指令，缓存标记也需要随之核对，不能直接把普通请求的“标记最后一块”规则机械套用。

### 7.2 已确认方向：沿用一条请求准备路径，摘要只追加末尾指令

复用下一份普通请求已经准备好的 system、tools、消息及原生字段，并沿用同一份已解析的 provider、协议、端点、model、reasoning 和缓存配置。在其末尾追加独立的摘要指令，不为摘要临时重新发现工具、替换 system 或将历史扁平化。

这可以沿用现有请求准备函数、LLMClient 配置与 provider 转换器实现；不新增独立的缓存管理服务或第二套消息装配系统。`purpose` 继续使用 `context-summary` 以保留计费与观测语义，仅让符合上述条件的摘要请求沿用既有会话缓存身份和适用策略，不伪装成 `agent-step`。

摘要生成路径只接收文本，不接入工具执行器。保留工具定义和原有调用配置，尾部指令要求只写摘要；若仍生成工具调用，则作为本次摘要失败处理，不执行工具、不提交替换。它保证的是不会执行工具，不保证模型绝不生成工具调用。Anthropic 将 `tool_choice` 改成 `none` 会使消息缓存失效，因此不建议仅为摘要临时更改。thinking 模式、预算和 effort 也不能为了缩短摘要随意切换；16K 正文与总输出预算在下一议题讨论。

### 7.3 四次请求分别能复用什么

| 时点 | 客户端应保证 | 缓存的客观边界 |
|------|--------------|----------------|
| 接近阈值的普通请求 | 已发送历史不因压力被 prune/mask 改写，只追加新增内容 | 新生成的回复及工具结果未必已经作为后续输入缓存；只能复用此前可匹配的前缀 |
| 摘要请求 | 相同完整历史及配置，末尾增加摘要指令 | 争取复用最昂贵的旧历史前缀；仍受提供商缓存长度、写入位置、有效期和配置影响 |
| 摘要后第一次普通请求 | 固定前缀保持不变，活动历史变为唯一新摘要与稳定保留段 | 新摘要改变后续前缀，不能期待旧历史或相同尾段继续完整命中；固定前缀也要已有可用缓存位置才可复用 |
| 后续普通请求 | 新摘要、保留段继续稳定，只追加新消息 | 从摘要后首次请求开始建立并继续复用新的上下文缓存 |

不额外发一次付费请求来“预热”摘要后的缓存。验收关注总输入费用、未缓存输入量和压缩频率，不能只盯缓存命中比例；更短的新上下文即使首次命中比例下降，仍可能比旧大窗口便宜。

对 Anthropic，在现有能力策略下保留合适的稳定 system 缓存位置，并在摘要末尾指令之前标记真实历史边界；检查标记数量与查找范围，不对所有兼容端点强加相同字段。稳定片段必须曾在可复用位置写入缓存，不能把“字没变”直接等同于“已经缓存”。OpenAI 的独立消息／块边界也要保留，不把摘要指令拼接进原有消息正文。

接近上限时，缓存命中不会减少上下文占用。自动触发必须预留摘要指令、适用的输出／thinking 预算和估算余量；不能先把窗口用尽，再靠删历史让摘要请求勉强发出。具体触发公式待预算议题确认。

### 7.4 参考与验证依据

- ZCode 在原消息后追加摘要指令，并把缓存标记放在该指令之前：`/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts:80`、`runtime/helpers/provider-request-messages.ts:292`。其中 `skipCacheWrite` 不是禁止整个请求写缓存，而是跳过末尾指令作为标记位置。
- Kimi 的 requester 被普通与摘要路径复用，但摘要时仍会重新计算部分工具配置，不能直接照搬为“请求完全一致”的保证：`/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:659`、`agent/llmRequester/llmRequesterService.ts:690`。可借鉴其现有 system/tools 指纹及摘要 cache read/create 记录，ohbaby 不必为此建立新观测框架。
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)：前缀及有效边界决定复用；压缩会重建后续上下文缓存，应结合总 token 成本评估。
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：工具、system、消息的层级与缓存断点决定可复用范围；未曾写入的稳定位置不能凭空命中。
- [Anthropic Tool Use with Prompt Caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)：更改 `tool_choice` 会使消息缓存失效。

后续测试要检查三种协议最终实际发送的请求体，而非只检查内部消息对象：普通请求到摘要请求的共享前缀、原生工具关联、缓存控制、摘要后的单份摘要与稳定尾段，以及重试／恢复时的同一预览。真实缓存效果另用有界 API 实验核实，记录压缩前、摘要、压缩后首次及后续请求的完整输入、cache read/write 与费用。缺失计数字段不得当作零。本轮只读代码与官方资料，没有调用真实模型，也未新增或重跑测试。

### 7.5 Bash 调查背景与范围纠正

用户提供的共享页面 `https://chatgpt.com/s/cx_6ac9f0174e4081919d65370f73066ad3` 未成功返回正文。通过本地任务读取工具读取了相关对话《分析读写工具与 Bash 优化》（thread `01a10743-b5ef-7000-8267-a70493ccd808`），不宣称已核对其与共享快照完全一致。

该对话已报告 Bash 前台大量 stdout 挤掉末尾 stderr 错误、仅保留退出码而没有完整日志回查的复现，也讨论了 shell 解析与授权判断不一致。这里引用的是该次调查结果，本轮未重跑复现。这段历史调查不能直接证明当前独立 Shell 议题会交付全部修复。用户随后明确 `2026-10-11-shell-and-glob` 与本轮无关，因此撤回前置依赖；本轮核实当前输出和状态，只处理实际需要的首次入模与稳定引用，不另造 Bash 执行／日志系统。

等工具变更落地后重新核对代码基线与输出约定，再确定上下文入口限长的具体接入点。当前方向要求错误和未完成状态不能消失，但不等于必须把全部错误日志永久塞进模型窗口；关键错误说明、执行标识、状态及有效回查引用必须保留。

## 8. 新调查与待讨论建议：什么时候提前压缩

本节为 2026-10-10 本轮调查；只读本地代码，未运行新的测试或真实模型请求。以下参考行为以当前本地 checkout 为准，不代表其官方产品线上行为或已验证的最佳参数。

### 8.1 ohbaby 已有发送前检查，主要缺口在预算接线

- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:557` 每个 model step 都先准备并测量下一份请求；工具批次执行并记录后回到这个入口（`:1161`）。并非等完整用户轮次结束才检查，因此不需要新增后台预测压缩服务。
- `core/context/compaction-policy.ts:108` 当前自动摘要按 `currentTokens / contextLimit >= 0.95` 判断，刻意未使用已经扣除输出预留的 input budget。
- `services/llm-model/modelProfiles.ts:221` 已有 `C − reservedOutput − safety`，safety 默认 1,024。输出预留默认取模型 profile 上限，还被可用窗口的 50% 限制；它并不保证等于实际发送值。
- `adapters/ui-runtime/composition.ts:649` 创建 token counter 时未传请求的 maxTokens；`core/context/compaction-policy.ts:47` 计算预算时只传 usedInputTokens。真正的输出上限由 `core/llm-client/streaming.ts:291` 的 request override 或 config.maxTokens 决定。不能只把触发阈值改为 inputBudget 的百分比而忽略这处差异。
- 输入测量已覆盖完整准备消息、tools、native 状态，并用成功普通请求的真实输入量校准。继续使用这套估算与三种协议的归一化 token usage；ohbaby 的统一 inputTokens 已是总输入口径，不能照搬其他项目再额外加一次 cacheRead/cacheWrite。
- 目前每个 lifecycle run 默认最多自动压缩两次，另有无收益保护；普通请求 overflow 后只强制重新准备一次。这些保护与新触发线的关系后续一并检查，不能因为达到次数上限就发送已知超预算请求。

例：128K 窗口，现有 95% 线是 121.6K；若实际输出需预留 16K，再留 1,024 的误差空间，普通输入预算已只有 110.976K。提前检查位置已有，但触发线会晚于可用输入边界。摘要还会追加指令并需要自己的输出空间。

### 8.2 八个参考项目的实际选择

以下路径相对于 `/Users/hansun025/Projects/code-cli/`。C 的口径须看每行说明，O 表示该项目使用的普通请求输出预算，不能直接把八行数字横向当成同一种窗口占比。

| 项目 | 本地默认自动触发规则与时点 | 代码依据 |
|------|--------------------------|----------|
| Pi | 当前占用大于 `C − 16,384`；固定 reserve，不取真实 maxTokens。每次 assistant 响应前检查，结束后另检查 usage/overflow | `pi/packages/coding-agent/src/core/compaction/compaction.ts:267`；`core/agent-session.ts:776`、`:3003` |
| Codex | 模型 auto limit 默认 `0.9C`，配置可更低；另有默认 95% 的 usable window，不能把两者混成一个阈值。请求前及采样／工具完成后检查 | `codex/codex-rs/protocol/src/openai_models.rs:527`、`:391`；`core/src/session/turn.rs:1304`、`:560` |
| Kimi | C 优先取 max_input_tokens，并可受观察到的更小窗口限制。C 大于 50K 时默认 `min(0.85C, C−50K)`；小窗口只用 `0.85C`。step 前用 usage 锚点加新增消息检查，默认同步等待 compact | `kimi-code/packages/agent-core-v2/src/agent/fullCompaction/strategy.ts:91`；`fullCompactionService.ts:258`、`:497` |
| ZCode | 实际公式为 `max(0, C−min(O,21K,C)−13K)`，不是注释所暗示的完整 32K 输出预留。每次普通／工具续轮前检查 | `ZCode/apps/zcode-cli/packages/core/src/compact/policy.ts:67`；`runtime/methods/turn-loop.ts:55` |
| Claude Code 本地重建版 | 窗口先扣 `min(模型输出上限,20K)`，再扣 13K／30K／50K 分档缓冲；有环境与功能开关覆盖。所谓 predictive 分支还会重新检查原阈值，不能仅凭函数名认定预测有效 | `claude-code/src/services/compact/autoCompact.ts:28`、`:72`、`:296`；`src/query.ts:848` |
| deepseek-harness | `floor(min(0.8C, C−O−65,536))`，O 来自请求或模型默认；pre-step 检查，先 prune 再测量，仍有压力才摘要 | `deepseek-harness/packages/compaction/compaction-basic/src/config.ts:172`；`index.ts:158` |
| DeepSeek-Reasonix | `0.8C`，明确不将输出预算纳入提前触发，发送时另裁输出预算；每次构建采样请求前检查 | `DeepSeek-Reasonix/internal/agent/compact.go:76`；`sampling_request.go:118` |
| OpenCode V2 | 最终 request 构建后按 `C−max(O,20K)` 判断，是 max 而非相加；当前 V1 手动路由与这条 V2 自动路径不能混为同一实现 | `opencode/packages/core/src/session/compaction.ts:232`；`runner/llm.ts:215` |

OpenCode V1 另有不同公式：若有独立 input limit，使用 `inputLimit−min(20K,O)`；否则使用 `C−O`，并根据上次完成 assistant 的 usage 判断。依据 `opencode/packages/opencode/src/session/overflow.ts:10`、`prompt.ts:1149`。

共同边界：检查过的这些普通自动路径都未提供“下一次最大 assistant 输出＋下一批工具结果上界＋届时摘要输出”三项一起预留的完整保证。它们主要靠余量、下一请求前重测和 overflow 恢复；不能声称照搬一个 16K／20K／50K buffer 就彻底消除超窗。Kimi 摘要前裁输入、ZCode microcompact、DSH prune-first 等做法不符合本议题已确认的稳定历史方向，不照搬。

### 8.3 已确认：90% 默认线，加必要的容量保护

2026-10-11 用户明确纠正：ohbaby 采用 90% 默认触发线。上一轮把“不能只把 95% 改成 80%”写进回复，混淆了参考项目数值与已讨论方案。撤回该表述，也不再把 90% 当作尚未决定的参数。当前代码中的 95% 仍作为现状事实保留，未在本轮修改代码。

按现有总窗口口径，正常触发条件为完整输入估算达到 `0.9 × C`；不悄悄将分母换成扣除输出后的 inputBudget。沿用每次模型请求前的检查，包括新用户输入、上一批工具结果、system/tools 和必要原生状态；缓存部分仍占窗口。在工具协议完整的 step 边界执行，不等待整个用户任务结束。

触发条件只在启动前判断。一旦已开始生成摘要，不因为用量刷新、重复命令或普通新增输入重新判断为“不需要”而取消／重启。模型请求正常失败与用户通过会话暂停／停止中断应区别记录，不能把“不自动取消”解释为请求永远不会报错。

用户已确认实际容量不足时允许提前；以下沿用现有预算机制落实，不新增预测服务：

1. 使用最终解析后的实际输出配置计算预算。模型 profile 的最大输出只作能力上限，不能代替本次请求值；不能低估预留后仍发送更大的 maxTokens。
2. 在 90% 默认线外，复用已有发送前容量检查：若等到 90% 已无法容纳普通请求输出或摘要的“末尾指令＋完整输出＋误差余量”，允许因容量原因提前触发。可简写为 `实际触发线 = min(0.9C, 容量允许的输入线)`。方向已确认；具体输出配置解析沿用三种接口的现有能力实现。
3. 首版不引入上一轮公式中的独立增长预测 G 或新的后台策略。工具沿用自身已有分页／限长，每步对完整请求重新检查；一次巨大输入仍可能越过触发线，不能声称 90% 或容量保护能彻底消除 overflow。例外走有限恢复，未覆盖的历史不得退出活动视图。
4. 容量保护只允许比 90% 更早，不允许因为大窗口预留够用就延后到 95%／96%。此前“1M 窗口剩 40K 时到 960K 才压缩”的举例撤回：它没有体现用户已定的 90% 上限。

例：200K 在 90% 时输入为 180K，仅剩 20K。若摘要完整输出预算为 32K，尚未加入摘要指令与误差余量就已放不下，需要比 168K 更早留空间；若是 1M 窗口，同样输出预算在 900K 默认线仍有充足余量。这说明预算保护与默认比例的职责不同，不意味着把 ohbaby 的默认线改成 80%。

16K 仍只指最终交接摘要正文。API 输出上限是否包含 reasoning／thinking，按当前接口和模型能力解析，不一律写成 maxTokens=16K。[Anthropic 手动 thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)明确 thinking 计入总输出上限；固定 budget 模式与 adaptive／effort 模式不能用同一套数值相加规则。ohbaby 的 `services/interface-providers/reasoning.ts:341` 已对 budget 与 maxTokens 的关系做校验，应该沿用。

SWE 取舍：一个默认阈值、现有预算检查、现有请求准备和原子提交；具体输出预算是下一项讨论。只改必要的信息传递，不增加预测服务，也不为摘要临时降低 thinking 配置以迁就剩余空间。

### 8.4 2026-10-11 新议题：摘要输出预算与 /connect 解耦

用户建议：compact 等内部请求的 max output 由系统确定，不受 `/connect` 的普通输出设置支配；连接界面是否继续提供该项，可后续考虑。本轮支持解耦方向，以下是建议及新核实事实；不将移除界面字段或所有模型的具体总输出值记为已经确认。

ohbaby 当前接线：

1. `adapters/ui-runtime/prompt-context.ts:101` 的摘要入口未传单次 maxTokens；`core/llm-client/streaming.ts:291` 因而回退到 `config.maxTokens`。底层已支持只覆盖本次请求、不改共享客户端配置；可以直接复用。
2. `config/llm/apply-active-model-config.ts:301`、`:316` 把同一 resolvedMaxOutputTokens 同时写入普通请求 maxTokens 与模型 profile maxOutputTokens；`config/llm/manager.ts:47` 也会把 llmParams.maxTokens 作为 profile 的输出上限。当前“普通请求偏好”和“模型输出能力”存在混用，单改摘要 override 不足以修复预算。
3. `services/llm-model/modelProfiles.ts:225` 支持 requestedOutputTokens，但预留仍会受 profile.maxOutputTokens 和窗口保护约束；`core/context/compaction-policy.ts:47` 没有传本次真实输出值。应让摘要发送值与同一请求的容量检查一致，不能发送 16K 却只预留 4K。
4. ZCode 可借鉴显式专用预算：`ZCode/apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:383` 传摘要 maxOutputTokens，`:716` 按模型能力与摘要 20,000 上限取小，常量在 `compact/policy.ts:11`。借鉴独立请求参数，不照抄其 20K 数字及其他配置。Kimi full 则仍优先 resolvedModel.maxOutputSize（`kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:640`），不能声称参考项目均已解耦。

明确建议：保留三种含义，使用现有请求参数和模型能力信息表达，不增加配置管理服务：模型／端点真实上限约束所有请求；普通请求使用普通输出设置；摘要请求使用内部输出预算，不读取普通输出偏好作为上限。用户将普通请求设为 4K，不应把有能力输出更多的模型锁成只能写 4K 摘要。自定义端点真实只支持 4K 时则不能绕过；能力信息不能从普通回复偏好倒推。

摘要正文仍以 16K 为上限，不是要求写满。非 thinking 模型可以用该正文预算生成本次输出上限；计入 thinking／reasoning 的接口必须为总输出留空间，不能统一机械设 maxTokens=16K。固定 thinking budget 可据现有预算计算；只有 effort 的模式不能准确换算成固定 thinking token 数，内部总输出默认值另行确定，不能偷偷回退到 `/connect` 偏好或假称保证正文能写满 16K。实际输出被截断仍按摘要失败处理，不保存半份摘要。

此建议把此前“材料和配置复用”说得更准确：system、tools、历史、协议原生字段和已确定的 thinking 配置继续复用，摘要专用输出上限是有意允许的请求级差异。不得为迁就该上限临时关闭或降低 thinking，也不裁掉摘要输入；容量保护使用摘要实际总输出预算，可早于默认 90% 线。

核实资料：[Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) 说明 thinking 计入总输出；[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) 说明 Responses 的 max_output_tokens 包含 reasoning 和可见输出；[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 说明改变 thinking／effort 会影响缓存。不能把调整总输出上限顺带变成改变 thinking，也不能据此保证所有兼容端点的缓存行为一致。

连接界面的建议是后续默认自动选择，把普通输出覆盖移到高级设置；本次先确定内部职责分离，不依赖先删 UI，也不取消 API 发送时的输出上限。正文 16K 与各类 thinking 总预算的具体规则继续逐题讨论。本轮仅代码与资料核对，没有调用真实模型或新增测试。

### 8.5 2026-10-11 thinking 计数复核与前置改造建议

用户确认三步保留算法，以及“摘要正文不超过 16K，不等于所有接口 maxoutput=16K”；进一步询问 thinking 是否占用总输出、现有计数是否覆盖，若缺失则建议作为上下文改造前置。本节为核实结果和待确认的最小补齐方案，不是开始实施。

#### 三种数必须分开

- 本次实际输出：官方 Anthropic output_tokens、OpenAI Responses output_tokens、OpenAI Chat completion_tokens 已包含 thinking／reasoning；reasoning 明细是其中一部分，不能再加到总输出。第三方兼容端点需遵守已核实的字段口径，不能只凭协议名称猜测。
- 下次请求的输入：只计算实际回传的正文、工具和原生思考状态。过去花过的全部 thinking 不能机械累计成当前窗口占用；不同模型对历史 thinking 的保留方式不同，发送的签名／密文字符长度也不等于其服务端 token 数。
- 下次请求的输出预留：这是发送前允许模型生成的总额度，不是已发生的实际消耗。对于共享输入／输出窗口，检查的是完整输入加本次总输出额度和已有安全余量；总输出已含 thinking 时不再额外加一次。

例：请求实际生成正文 3K、thinking 7K，总输出为 10K；input=100K 时总用量是 110K，不是 117K。若下次请求把其中的原生思考状态回传，就按下次输入规则计；未回传的旧思考不直接塞进下次输入统计。

#### ohbaby 已有能力与具体缺口

1. **已经计入总输出。** `services/interface-providers/token-usage.ts:154`、`:259`、`:373` 分别读取 Chat／Responses／Anthropic 总输出；`:100` 的统一总量是 input+output，没有再加 reasoning。Anthropic 的 input 在归一化层已合并 cache read/write，不得照抄 Pi 的原始字段求和再加一次缓存。
2. **已经读取思考明细。** Chat `openai-compatible.ts:182`、Responses `openai-responses-stream.ts:95`、Anthropic `anthropic.ts:720` 读取相应 reasoning／thinking 子项，缺失保持 undefined，明确的 0 保留。该值目前主要用于 `core/llm-client/streaming.ts:595` 的原生状态估算来源，未贯穿标准 TokenUsage、普通用量聚合和消息 usage metadata。它可能随 model-state 落库，但不能把 model-state.estimate 当成真实用量报表字段。
3. **已经估算历史思考。** `core/context/token-estimation.ts:51`、`:63` 把普通内容与原生状态分开计，避免把 modelState 整个 JSON 再算一遍；`native-context.ts:28` 覆盖三种协议的可读 thinking／reasoning，Chat 重复字段会去重。opaque 数据每次响应只取一份代理值，不按密文或 signature 字符数算。
4. **代理不是精确值。** opaque 代理来源依次为真实 reasoning 用量、总输出、该次 maxTokens（`streaming.ts:595`）；当前还可能叠加可读摘要的文字估算。这个数用于保守容量判断，不能拿它冒充精确思考计费。`context-manager.ts:302`、`lifecycle.ts:842` 已用普通请求实际 input 校准估算；继续沿用并核实协议差异，不新增独立预测服务，也不能直接用上次 totalTokens 冒充下次 input。
5. **输出预留接线仍需修正。** 8.4 中已确认的 profile 与普通偏好混用、未传本次 requestedOutputTokens 问题，会影响 thinking 请求的容量判断。已知固定 thinking budget 的关系校验存在于 `services/interface-providers/reasoning.ts:341`，当前不合法时直接报错，没有自动压低预算；应保留不暗改 thinking 的性质。
6. **摘要用量没有完整回传。** `adapters/ui-runtime/prompt-context.ts:85` 的摘要接口返回字符串，`:125` 起只消费文本和完成状态，不带回 tokenUsage。普通 `lifecycle.ts:831` 聚合及校准只处理普通步骤。现有 `onRequestObservation` 记录请求阶段和结果，不是摘要 usage 账本；`client.ts:67` 的 reporter 是归一化异常诊断。严格结论是当前内置摘要路径未找到专用 usage 持久化，不能据此断言外部网关没有账单。

标准用量的最小补齐建议：增加可选 reasoningTokens 子项，沿现有返回、metadata 和聚合传递；子项不参与 total 的再次求和。缺失与 0 区分，部分已知不能呈现成全部已知；不合理的子项（例如大于 output）丢弃或标记未知，保留可信总量。Responses 已有子项≤总量校验，Chat／Anthropic 当前仅校验非负整数，可统一这一条件。

摘要返回文本的同时带回实际 input/output/cache/可用 reasoning 明细，按现有 context-summary 用途单独记录。普通步骤、摘要与其失败重试需要可区分，失败时接口没返回 usage 就记录未知，不能当免费；不要把摘要消耗混进压缩后上下文占用，也不直接污染普通输入估算的校准样本。保留目的分类，不新增一套计费服务。

#### 参考项目可借鉴与不可照搬的部分

- Pi 与 Codex 都把 reasoning 存为 output 子项。Pi：`pi/packages/ai/src/api/openai-completions.ts:1547`、`openai-responses-shared.ts:566`、`anthropic-messages.ts:832`；Codex：`codex/codex-rs/codex-api/src/sse/responses.rs:128`，测试 `:845` 明确 input=100、output=10、reasoning=5 时 total=110。
- Pi 的 Anthropic 固定 thinking 路径会把基础输出额加 thinking budget，但余量不足会降低 thinking（`pi/packages/ai/src/api/simple-options.ts:92`、`anthropic-messages.ts:948`）。只借“明确考虑总输出”的做法，不复制降低 thinking 的退路。
- Reasonix 按 provider replay policy 选择是否计入 reasoning 和 Responses items（`DeepSeek-Reasonix/internal/agent/output_budget.go:269`）。方向值得借鉴；它对 opaque JSON 的字符估算不能当精确值，ohbaby 已有按实际请求投影估算，无需另造同类层。
- Codex 普通生成与 compact 复用窗口内固定的 effort（`codex/codex-rs/core/src/session/reasoning_effort.rs:93`）。本地 Claude 重建版 `claude-code/src/services/compact/compact.ts:1215` 特别防止较小 maxOutputTokens 经底层 `claude.ts:1707` 把 thinking budget 压低而失配缓存。后者不是官方代码保证，但说明应检查最终发出的参数，不只看上层 intent。
- Kimi 固定 budget 与 adaptive effort 分支不同（`kimi-code/packages/kosong/src/providers/anthropic.ts:320`、`:1237`）。high 是档位，不能套其 32K 映射到所有模型；ZCode 摘要总额 20K 也不证明正文可独占 20K。

#### 明确建议：先统一已有计数与预算，不新建 thinking 模块

前置改造放在现有 interface-providers／llm-model／context 请求准备和用量链路内：分清真实模型能力、普通输出偏好、摘要内部总额度；让发送参数和容量检查用同一个已解析数值；保留既有原生输入估算，补上 reasoning 子项与摘要用量记录。输入计数以实际材料为准，不仅以“当前 thinking 开关”为准：即使本次不开新 thinking，仍回传的历史状态也不能漏计。

早期曾讨论无 thinking 按正文额度、fixed 按16K+B、adaptive 按32K的分支申请方式。用户随后确认摘要总输出32K作为首版试行值，现行方向见第13节；正文仍≤16K，thinking控制分开，不保证正文能写满16K。真实端点上限与容量保护共同约束最终额度，发送与预留使用同一个结果；不为凑额度压低已解析B，不新增动态预测或UI参数。目前尚未做真实模型质量验证。

新增接口核对点：当前 Chat adapter `openai-compatible.ts:78` 固定发送 max_tokens，而 OpenAI 官方推理 Chat 的总输出参数是 max_completion_tokens；官方文档注明旧字段不兼容 o-series。前置阶段应按实际模型／端点能力选正确字段，不能把所有第三方兼容端点全局改成新字段。本轮确认代码与文档不一致风险，没有对真实端点复现错误。

本轮验证：只运行现有 native-context、token-estimation、tokenCounting、modelProfiles 四个单元测试文件，共 51 项通过；未新增测试、未修改业务代码、未调用真实模型。测试证实已有估算行为，不证明真实 token 精度、摘要质量或缓存命中率。

官方依据：[Anthropic context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)、[Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

### 8.6 Reasoning 存在哪里、怎样占保留预算，以及摘要请求如何记账

2026-10-11 补充调查。以下区分当前代码事实、用户已明确的要求和实现建议；本轮只更新讨论记录。

#### 当前事实：普通对话的 reasoning 已有数据库持久化

“thinking 只在内存、不落库”的猜测不符合当前普通代理运行路径。这里有三份不同用途的数据：

| 数据 | 当前保存方式 | 是否作为后续模型输入 |
| --- | --- | --- |
| 界面展示的思考文字 `reasoning` part | 流式生成时先在内存累计，片段结束后异步写入 SQLite；保存成功后重开会话可恢复 | 不直接作为普通消息正文回传，也不额外计入输入 |
| 协议需要的原生状态 `model-state` part | 完整、有效的模型结果与正文、工具调用在同一事务保存 | 按模型来源和协议规则恢复；实际恢复的内容参与输入估算 |
| `activeReasoningByMessageId` | 每次 run 的内存 Map | 没有原生状态时，供工具循环兼容回传；不是唯一的 reasoning 保存位置 |

展示链：`core/lifecycle/lifecycle.ts:367` 接 `saveReasoningPart`，`core/lifecycle/display-reasoning.ts:46` 先累计、结束后异步保存；`core/message/database-store.ts:256` 写入 part JSON。UI 主路径 `adapters/ui-state/source-session-projection.ts:70` 也接同一保存动作。

原生链：`core/lifecycle/lifecycle.ts:991` 调用 `commitModelStep`；`core/message/database-store.ts:314` 原子提交正文、原生状态及工具调用。`services/interface-providers/native-state.ts` 允许保存 Anthropic thinking／signature／redacted data、Responses reasoning summary／content／encrypted content，以及 Chat reasoningText／details。保存的是接口实际返回的信息，不能据此声称取得了模型全部隐藏思考过程。

`core/context/serializer.ts:159` 从持久化 part 恢复合法原生状态，`:208` 才处理缺少原生状态时的内存兼容路径。给人看的 reasoning part 不会再复制一遍加入模型输入。数据库有两种表示，不等于模型收到两份。

中断也要区分用途：半段展示文字可以带 interrupted／failed 状态保存；`length`、过滤、abort 等未完成结果不会作为完整原生状态提交回放。展示保存是异步且有限重试，崩溃或持续写盘失败可能丢失尚未保存的展示文字，不能承诺每一个流增量都立即持久化。

以上结论针对普通代理对话。**当前摘要客户端是另一条路径**：`adapters/ui-runtime/prompt-context.ts:85` 只返回摘要字符串，没有接入普通步骤的展示 reasoning／原生状态保存和独立 usage 记录。不能把普通步骤已有持久化误写成“摘要请求也已完整留档”。

#### 保留预算建议：按下一次会发送的材料计数，同一内容只算一次

同意复用现有计数模块。普通文本和可读 reasoning 都用现有 TokenCounter；签名、加密内容继续按已有原生状态估算处理，不能把密文字符数当思考 token 数。实际输出里的 reasoningTokens 是用量子项，也不能不加判断地用作每次历史输入的精确大小。

20K／40K 是最近原文保留段的预算，包含这一段中需要回传的正文、工具参数／结果及原生 reasoning 的估算占用。它不包含系统和工具定义、独立的新摘要，以及下一次生成的输出预留；这些另在完整请求容量检查中计算。

所以，**需要回传的 reasoning 越多，同一保留预算里能留下的正文和工具结果确实可能越少**。例如一个连续尾段估算为正文和工具材料 12K、回传 reasoning 8K，合计就是 20K；不能忽略这 8K 后再往前多留一段。40K 仍只是补齐完整交互／用户轮次时的放宽上限，不增加一份专门给 reasoning 的额外额度。按已经确认的三步边界算法选择即可，不因这次发现调整 20K／40K 数值。

历史 thinking 是否实际占用服务端窗口还取决于模型：Anthropic 官方说明部分模型保留旧 thinking，部分旧模型会自动移除已完成轮次的 thinking，工具交互中又有完整回传要求。因此不能把数据库所有 thinking 一律加上，也不能一律扣掉。首版沿用实际请求投影及现有保守估算；明确的协议／模型差异在既有适配与估算位置处理，无法精确判断时不假装是精确 token 数，不新增独立策略系统。

这次发现一处具体接线差异：`core/context/compaction-policy.ts:26` 的 `estimateHistoryForCompaction()` 没有接收 `activeReasoningByMessageId`；有原生状态时传给序列化器的第二个参数也是 undefined，而无原生状态时走可读历史序列化。完整请求的 `core/context/token-estimation.ts:59` 则会计算实际投影里的兼容 reasoningText。因而在缺少原生状态、仍有内存 reasoning 回传的兼容场景，尾段估算可能少算。建议让尾段选择和完整请求共用现有消息投影与估算入口，并传入同一份活动 reasoning；不要新增另一套 thinking tokenizer。此差异由静态链路确认，本轮没有新增针对它的复现测试。

压缩后，退出活动上下文的正文和 reasoning 仍可保留在数据库；只有新摘要与选定尾段进入下一次正常请求。摘要生成过程中新增的 thinking 计入那次摘要请求的输出用量，不作为新摘要正文，也不额外塞进 20K 尾段。

#### 摘要用量：复用请求记录，每次尝试分别记，UI 后置

用户已明确要求记录摘要 usage／cache。当前 `createContextSummaryClient()` 没有消费返回的 tokenUsage，也没有传普通步骤使用的 requestOwner／onRequestObservation。现有 `ModelRequestRecord` 已有 requestId、attempt、purpose、时间和 outcome，但没有 usage 字段；普通请求通过消息 metadata 持久化这些记录。它提供了可复用的结构，摘要路径仍需接入，不能称为已经完成。

建议在现有请求观察和 metadata 结构中补充可选标准 usage，摘要按 `purpose=context-summary` 留档，并关联所属会话／上下文和本次压缩。不新建计费模块；摘要记录的归属必须覆盖手动压缩没有活动普通 step、以及失败没有成功摘要消息的情况，具体落点在正式方案中确定。

- 每次实际尝试分别保存 input、output、已有 cacheRead／cacheWrite 明细和可用 reasoning 子项，以及成功／失败／中断结果；同一 requestId 的流式累计值更新为最终值，不能把每帧累计数字相加。
- reasoning 是 output 的子项，总量仍为 input + output；缓存明细也是 input 的组成部分，不能再次加到总量。Pi 和 Codex 都遵循 reasoning 属于 output 的做法，参见 8.5。
- 请求失败、取消或重试也可能已有消耗。已收到 usage 就保存；没收到则记未知，不能填 0 或凭估算伪装成真实账单。只有成功摘要的 metadata 不足以覆盖这些情况。
- 摘要请求完成与摘要成功应用是两件事：即使摘要被判定无收益或提交前被停止，已经发生的模型消耗仍要留档；活动历史替换仍遵守原有成功后原子提交规则。
- 用量记录不进入模型消息，不给缓存前缀添加动态记账文字。汇总成本时可以包含摘要消耗，但应能按用途区分；不要将其作为普通下一请求的输入占用或用量校准样本直接混入。

用户关于 maxoutput 的理解在对应推理接口上成立：OpenAI Responses 的 max_output_tokens、OpenAI 推理 Chat 的 max_completion_tokens，以及 Anthropic 的 max_tokens 都包含本次 reasoning／thinking 的输出占用。第三方 Chat 兼容端点按自身协议映射，不能只看字段名字断言语义相同。摘要独立解析内部输出预算，保留已选 thinking 配置，并让容量检查与实际发出的总输出额度一致；正文 16K 上限与总输出额度继续分开。8.5 当时的32K建议随后已获用户确认作为首版试行值，最新边界见第13节。

后续 UI 可以只显示“已压缩，上下文约 36K tokens”，或另显示“本次摘要消耗……”；前者是压后输入估算，后者是请求用量，字段含义不能混淆。本轮不实施提示，也不新增摘要 thinking 展示或全量保存要求。

#### 本轮验证与来源

运行现有 `core/message/database-store.integration.test.ts` 和 `core/message/atomic-model-step.integration.test.ts`，2 个文件、40 项测试通过。前者 `:553` 明确验证展示思考保存、物理关闭／重开数据库后仍存在，且不进入模型序列化；后者 `:357` 验证含 thinking／signature 的完整原生状态重开后恢复，并覆盖原子提交失败回滚。测试使用临时数据库；未读取用户真实数据库、未修改业务代码、未调用真实模型。结果证明这些持久化路径，不证明真实 token 精度或缓存命中率。

重新核对本地 Pi `packages/ai/src/api/openai-completions.ts:1547` 和 Codex `codex-rs/codex-api/src/sse/responses.rs:845`：reasoning 单独记录但不重复加进 total。官方依据：[Anthropic 上下文与 thinking](https://platform.claude.com/docs/en/build-with-claude/context-windows)、[OpenAI reasoning 输出预算](https://developers.openai.com/api/docs/guides/reasoning)、[OpenAI Chat 总输出额度](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

## 9. 手动 /compact：已确认规则与实现边界

### 9.1 ohbaby 的实际入口

- `packages/ohbaby-agent/src/commands/builtin.ts:530` 默认 force=true，支持 `--no-force`。手动 force 会绕过自动阈值和部分防重复限制，不是新的自动策略。
- `adapters/ui-inprocess.ts:2798` 和 `adapters/ui-runtime/composition.ts:1211` 没有明确拒绝正在运行的同会话任务。借用当前 runtime 不等于等任务结束；context mutation lane 只串行上下文操作，不锁住模型流和工具写入。
- 手动路径重新 assemble，不复用活动 run 的 promptSnapshot、protectedInputs 和 tailDirectives。因此在 busy 时执行，不只是界面体验问题，还会造成请求材料或工具协议处于不同步状态。
- `packages/ohbaby-sdk/src/compact.ts:8` 与 Context CompactOptions 没有 signal；手动取消未贯通到摘要请求。
- `apps/ohbaby-web/src/ui/commands/CompactOverlay.tsx:128` 只在没有 sessionId 时禁用按钮；重复请求可能排队多次强制压缩。
- 摘要成功提交已有版本／parts 校验，值得保留；但当前前置 prune 已独立提交，所以不能声称现状中“摘要失败则历史完全不变”。取消正常 prune-first 后，才能落实失败／取消不切换活动历史。

### 9.2 参考项目没有统一的忙时行为

- Kimi、deepseek-harness、Reasonix：忙时拒绝手动压缩；Kimi 有独占修改锁和取消支持，手动完成不额外启动普通模型请求。依据 `kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:333`、`:538`、`:748`；`deepseek-harness/packages/compaction/compaction-basic/src/index.ts:375`；`DeepSeek-Reasonix/internal/control/maintenance.go:70`。
- Pi：手动入口先 abort 当前任务，压缩后不自动恢复。依据 `pi/packages/coding-agent/src/core/agent-session.ts:2749`。
- Codex：TUI 禁止 busy 时使用 compact；core 直接收到 Compact 时会先中止旧任务再创建 CompactTask。依据 `codex/codex-rs/tui/src/slash_command.rs:240`；`core/src/session/handlers.rs:247`。
- ZCode：v4 忙时入已有 FIFO，重复 compact 拒绝。失败或 Stop 会 hold 后续队列；存在 active goal 时，app 层可能在手动 compact 后自动继续目标，不能笼统说永不续写。依据 `ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts:48`、`:171`；`bootstrap/src/app/input-facade.ts:127`；`core/src/runtime/methods/runtime-command-queue.ts:214`。
- OpenCode V1：写入 compaction 请求，启动或加入已有 loop；不能和 V2 自动路径混称。Claude 本地重建版的手动入口接收 AbortController，区分取消、不足消息和其他失败。

### 9.3 用户已确认的交互方向及必要边界

2026-10-11 用户确认共用压缩过程、忙时提示、禁止重复发起、禁止自动取消及成功后一次性替换，并纠正上轮“可以取消”的宽泛表述：中断通过已有会话暂停／停止操作，不为 compact 单独新增取消入口。以下按该方向记录，内部接线细节留给正式方案。

1. 自动与手动共用请求准备、单份滚动摘要、尾段选择、校验和原子提交。手动只绕过自动触发阈值，不绕过输出预算、协议完整性、摘要有效性和版本校验；不另设一套更激进的尾段裁剪规则。
2. 第一版只允许目标会话空闲时手动 compact，busy 明确返回稍后再试。检查与执行资格由后端既有 run／会话控制统一处理，不能只禁按钮。不要暗中 abort 当前 Bash，也不为此新建维护命令队列；其他会话和已合法转后台的任务无需全局停止。
3. 同一上下文正在 compact 时，重复请求提示“正在压缩”，不排队再次付费，也不取消原压缩。摘要开始后持续完成，普通新消息和用量刷新不触发自动取消／重启。只有会话暂停／停止信号中断本次操作，复用既有会话控制，不单独增加 compact 取消按钮或命令。
4. 暂停／停止发生在提交前：停止摘要请求，不替换旧活动历史，不自动恢复压缩。发生在原子提交已完成后：保留成功压缩事实，同时停止会话后续执行；不撤销摘要，也不能只报“取消”让用户以为历史仍旧。网络超时、服务端错误等是失败，不等同于用户主动停止。
5. 非空历史但没有可压缩旧段、或摘要不能带来有效缩小时，返回无需压缩／未应用，不能为了完成命令裁掉保留段或覆盖一个更大的摘要。手动绕过比例阈值不代表必须修改历史。
6. 自动成功且会话未被停止时继续原 step；手动成功后报告结果，不因 compact 命令自行开始新的工作。已有 goal 的调度仍归原运行控制管理，不让 compact 增加隐含继续语义。
7. 压缩期间到达的新用户输入按现有输入接收机制保留，不插入已经发出的摘要请求，不因它取消摘要；其记录不计入本次摘要覆盖范围，也不能在提交时一起移除。成功后准备下一请求时再纳入。这是落实“不中途取消”和“覆盖范围准确”的必要边界，不新增一套消息队列。
8. 若以后确有“运行中请求，下一安全点执行”的需求，再复用现有执行循环与排队能力；本轮不预建。Kimi/ZCode 支持额外摘要要求可作为参考，但不是完成当前目标所必需，暂不新增命令参数面。

后续验收聚焦：请求前预算和最终 wire 参数一致、固定前缀不变、大批新增结果越线、manual 低占用可触发、busy 和重复请求、取消时序、失败后原历史完整，以及摘要后不自动发一次普通请求。本轮只调查并记录，未实施这些行为。

## 10. 2026-10-11 收尾复核：压后请求与剩余问题

本节是对当前方案的补充调查和推荐，除已注明用户确认的方向外，不能当作全部已定实施细节。只读本地源码与既有测试断言，没有修改业务代码、运行新测试或真实模型请求。

### 10.1 压缩后下一次请求的组成

正常请求保留系统规则、工具定义和其他必需的请求上下文；会话历史部分变成：唯一的新摘要、已选定且不再裁剪的最近原文、随后接收的新增输入。历代摘要和被覆盖原文仍在数据库，不继续整体发给模型。

“最近几轮”按已确认的 token 预算选取，不固定为两轮或三轮：正常 20K，补齐完整轮次最多 40K，同时不超过窗口 30%。一组调用与结果、必要原生状态不能拆开；异常长轮次和单个超大依赖组的退路仍按 5.4 细化。

本次摘要指令是一次请求的控制材料，不作为新的长期用户任务留在压后正常上下文。提交交接摘要正文，不把生成摘要时的额外 thinking 或工具调用当成摘要正文。保留段自身协议要求的原生状态则继续遵循既有规则。

ZCode 的 `buildPostCompactRuntimeEntries()` 明确按 prefix、summary、preservedEntries 重建，可借其组成方式：`/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts:72`。但该项目手动默认不保留 recent 的选择策略与本议题不同，不照搬。

### 10.2 手动入口可借的最小做法

- Kimi 在 `begin()` 中检查现有 compact 和会话状态，同步取得独占执行资格后才启动异步工作，避免“检查时空闲，真正执行时已经忙了”：`/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:333`、`agent/loop/loopService.ts:770`。ohbaby 优先复用已有会话运行控制和上下文修改入口，不另建维护队列。
- Kimi 的执行暂停不阻止接收新输入；ZCode 将 compact 标为不可插入新指令，输入留待后续处理：`kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts:302`、`:785`；`ZCode/apps/zcode-cli/packages/core/src/runtime/methods/compact.ts:57`、`prompt-admission.ts:44`。这与用户已确认的新输入不取消摘要一致。不能照搬 Kimi 把新收到用户输入又送入 20K 截断选择器的做法。
- ZCode 把压缩的 controller 接到现有会话 Stop，Kimi 用操作身份核对结束回调，避免旧操作清除新状态：`ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts:130`；`kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:439`。只借这两条接线规则，不搬整套调度系统。
- 原子提交直接复用 ohbaby 的 `packages/ohbaby-agent/src/core/message/database-store.ts:526`：已有事务和 expectedParts 比较，适合在同一提交中写入新版摘要并让其覆盖范围退出活动视图。增加单份摘要规则时，旧有效摘要也要在同一事务内退出，而非另做一次事后清理。

### 10.3 已确认优先修复：不能把未读到的历史当成已压缩

当前 ohbaby 在 `context-manager.ts:925` 超窗后缩短 summaryHistory，却在 `:967` 返回最初 historyToCompress，最终 `:985` 按原始范围提交。这会让成功摘要请求没有读到的历史也退出上下文；它是数据完整性问题，优先级高于命中率优化。

明确推荐：本次计划被替换的历史范围在启动时固定，成功摘要必须完整覆盖它。首版移除“不断丢最早轮次后仍替换整个范围”的恢复路径。完整材料放不下就返回失败并保留旧历史；不为本轮引入多层分块摘要系统。用户已明确不为预算不足裁掉摘要输入。

提交前只接受正常结束、非空、符合正文预算的正式摘要。length、空正文、工具调用、provider error 都不能拿部分输出冒充成功；thinking 不充当摘要。Pi 拒绝 length 的规则可借，但它有直接返回空文本的路径；Reasonix 会将纯 reasoning 截断后作摘要，也不采用。依据：`pi/packages/coding-agent/src/core/compaction/compaction.ts:581`、`:755`；`DeepSeek-Reasonix/internal/agent/compact.go:494`、`:499`。

### 10.4 已确认方向：收敛重试，避免一个失败被多个入口反复重做

现状有摘要 client 的空正文重试、Context 的两种提示词及最多四次摘要调用、stream 重试、SDK 内部重试，以及普通请求 overflow 后再 force compact。`packages/ohbaby-agent/src/core/llm-client/sdk-retry.integration.test.ts:146` 的现有断言说明持续 503 时，一次 stream 可到 18 次 HTTP 尝试；本轮未运行该测试，也不能将 HTTP 尝试次数直接当成成功计费次数。

用户已确认收拢重试的方向。下面是具体推荐规则；“最多一次内容修正”等次数和底层总预算仍需在最小实现中细化：

1. 摘要内容修正由 Context 一处负责，首版建议最多追加一次修正；只改末尾摘要要求，保持共享历史前缀和 thinking 配置。无可修正条件的超窗、协议错误不盲目重试；用户 Stop 不重试。
2. 运输错误继续由 LLM 层负责，但给摘要使用明确的有限预算，并把 SDK 内部尝试纳入实际计数。不能只限制 generateSummary 调用次数，底层又独立放大。内容修正和运输重试的最终总次数，在实施方案中结合现有重试接口定清楚，不增加通用重试框架。
3. 同一份准备输入、同一步已经耗尽的 compact，不能因普通请求 overflow 或 force 入口重新获得一套额度。已知普通请求也放不下时，直接返回明确错误，不再发一次注定失败的请求来触发压缩。
4. 摘要生成失败而旧正常请求仍可安全发送，可继续原工作，但不得在每个 step 立即重复同一失败。需要用现有运行状态记录本次失败及有限保护；若提交结果未确认，则不能继续派发模型请求。

Codex remote v2 给 compact 单独收紧运输重试上限，值得借的是职责和有界预算：`/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/compact_remote_v2.rs:77`。具体数值不机械照搬。

### 10.5 已确认取消“成功压缩也占每轮两次额度”的限制

当前 `MAX_COMPACTION_PER_TURN=2` 在尝试开始时计数，成功也占用；仅在整个 lifecycle run 开始重置。两次成功后，长任务不再正常自动摘要，可能等普通请求真的超窗才由 force 绕过保护。依据：`core/lifecycle/lifecycle.ts:481`；`core/context/context-manager.ts:1228`；`core/context/compaction-policy.ts:86`。

明确推荐：不要限制长任务中成功且有效的压缩总次数；限制连续失败、无收益和同一次失败的重复请求。成功提交后清理失败记录，用户 Stop 不算服务失败。必须与 10.4 一起收敛，不能只删除两次上限，放大失败后的重复请求。

本地 Claude 重建版采用连续失败计数，成功归零，可借这个含义，不能把本地实现当作官方线上保证：`/Users/hansun025/Projects/code-cli/claude-code/src/services/compact/autoCompact.ts:286`、`:357`。无需另造熔断服务或配置面。

Reasonix 提交前再次检查 Stop，开始提交后完成一致性与持久化；提交结果不明时阻止继续执行，可借其边界语义：`/Users/hansun025/Projects/code-cli/DeepSeek-Reasonix/internal/agent/compact_commit.go:32`、`:53`、`internal/control/maintenance.go:170`。ohbaby 仍复用自身事务，不引入 Reasonix 的 checkpoint 状态体系。Pi 先更新内存后写盘，ZCode 使用补偿回滚，均不能作为“数据库原子提交已实现”的证据。

剩余需要细化而非扩展新功能的项目：摘要正文上限与实际总输出配置的对应、工具已有结果的稳定入模与引用、超长不可拆单元，以及重试总预算。确定后再拆分实施阶段并重写正式文档。

## 11. 后续讨论顺序

1. 旧摘要的更新、内容保留规则及回查方式。
2. 固定原文预算与 30% 窗口上限；完整用户轮、工具组、长用户回合、超大不可拆单元。
3. 工具结果入口定型、原始证据保存、状态关联与批量预算；现有 mask/prune 的去留。
4. 摘要复用正常请求，三种协议的原生字段、缓存策略、计数和实际发送内容如何保持一致。
5. 摘要 16K、普通输出、Anthropic thinking 与触发阈值。
6. 摘要失败、超窗恢复、重试次数、取消与手动 compact。
7. 按依赖划分多个实施 improve 阶段，明确每阶段交付和验收，再重写正式文档。

本节是讨论顺序，不是实施阶段划分。

## 12. 2026-10-11 路线收拢：前置依赖、超大组与验收

本节是本轮供讨论的路线草案，尚未替代正式实施文档。用户明确要求多个 improve 阶段，优先于 skill 默认单轮安排；Context 的 improve-7 仍只表示模块方案变更记录，不是第七个实施阶段。先落实剩余承重选择，再统一重写旧正式草案，不能把待定建议写成用户确认。

### 12.1 High effort 不自动提高尾段上限

高推理强度确实可能让一个完整交互组超过 H，但不能根据 high 档位直接断言其 token 大小。例：实际需要回传的模型正文／原生状态 35K，加工具结果 12K，一个不可拆组就是 47K。若 H 为 40K，既保留全组又遵守硬上限在逻辑上无法同时满足。

首选建议仍维持 B=min(20K,H)、H=min(40K,窗口30%)：普通情况按已确认三步算法；遇到较早的超大组时将其与之前的历史纳入摘要，原样保留后面的合法连续尾段。只有最新的完整组本身超过 H，才考虑整组交给摘要、这一次尾段为空的例外。失败仍保留原历史，不裁 thinking、不拆调用结果、不自动放大到 60K／80K。

必须说明这一例外的实际代价：当前 ToolState.completed 只证明工具执行结束，不证明正常模型已经读到结果。`core/lifecycle/lifecycle.ts:1163` 工具完成到下一轮 `:557` prepareTurn 之间可能先发生 compact；`core/context/context-manager.ts:1703` 的 protectedInputs 保护的是 user 输入，不能假称它已保护新工具结果。因此，允许零尾段也可能允许摘要请求第一次读取这组工具结果，之后普通请求从摘要接手。允许协议已闭合的工具组这样交接，但不篡改普通请求的交付状态，摘要必须保留操作结果、错误、未完成任务标识和真实引用。**2026-10-11 用户已通过本轮问答确认接受此例外。** 不再把它列为未决问题。

pending／running 且尚无协议结果的组不能套用此退路；后台 Bash 已返回 job ID 的工具交互可以闭合，但摘要仍需写清后台任务未完成。未首次正常交付的新用户输入继续单独保护，不因摘要读过就标成已经正常处理。

opaque reasoning 的估算还有不确定性：`core/llm-client/streaming.ts:595` 优先真实 reasoning usage，其次总 output，最后用 requestMaxTokens；source=limit 超过 40K 只是保守估算，不是实测回放体积。沿用并保留估算来源，不把它报成精确占用，也不另造 effort→token 预测器。

参考只支持取舍思路：Pi 末尾不可拆组可能超出其 20K 预算（`pi/packages/coding-agent/src/core/compaction/compaction.ts:471`）；ZCode 正常自动路径保留最近组但没有尾段 token 硬帽（`ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/compact-selection.ts:30`）。它们不能替 ohbaby 证明“严格 40K 且永远保留完整最新组”可行。

### 12.2 阶段拆分的约束

范围纠正：Shell／Bash 独立议题不作为本轮前置。本轮直接核实已有工具结果、状态和引用，解决首次入模与稳定回放；不在这里改造 Shell 执行、网络继承或 glob。遇到现有工具输出缺口，只按本议题实际需要界定，不假设其他议题会交付一套新日志契约。

建议至少分开这些可验收交付，最终编号在本轮审查后归并：

| 交付 | 应包含什么 | 不能留到下一阶段才补什么 |
| --- | --- | --- |
| 计数、实际用量及输出预算基础 | 复用 TokenCounter；尾段／完整请求回传 reasoning 口径一致；模型能力、普通偏好与摘要额度分开；摘要每次尝试 usage／cache 留档 | 发送总输出与本地预留一致，reasoning／cache 不重复相加，未知不假装 0；手动／失败时仍有记录归属 |
| 工具首次入模表示 | 复用 Bash 等工具捕获结果；复用已持久化工具结果和现有模型投影；保持正文与引用稳定 | 首次定型、持久化和重启后稳定重放必须同交付；错误、终态、调用关系不能丢 |
| 完整压缩流程 | 正常请求前缀＋末尾指令；旧摘要继承；20K／40K；覆盖范围准确；一次性提交；去常规 prune/mask | 缓存准备与实际容量保护一起启用；单摘要、选择范围和原子替换一起启用；取消成功次数上限和有界失败重试一起启用；手动自动同过程 |
| 轻量提示与效果核验 | 可读状态提示，压后占用与本次消耗含义分开；真实协议效果核验 | 每个前置阶段已经有自己的测试，不能把正确性全部推迟到最后；UI 是否独立成阶段按改动规模决定 |

不为了阶段数量拆开一个必须原子成立的规则；也不因为存在一个压缩内核就把计数、工具捕获、前端和所有基础设施全塞进同一 improve。参考项目可以帮助定义边界，不能代替 ohbaby 的依赖分析。

### 12.3 验收重点和审查要求

计数阶段验收：同一材料在普通请求、摘要请求和尾段选择中使用相同的可回传表示；包含原生文字、opaque 和兼容内存路径；普通偏好 4K 不限制摘要；容量预留与最终 wire 输出参数一致；reasoning 是 output 子项，cache 是 input 子项；缺失明细与真实 0 区分；数据库重开后可读且不入模。

工具阶段验收：stdout 较大、末尾 stderr、非零退出码、部分捕获和保存失败；多个并行返回单条合格但合计超限；MCP／子代理／结构化和媒体入口不漏；重试、重启、改配置后已经发送的预览与引用不变；后台状态更新生成新结果，不回写旧结果。核对工具现有分页／限长和完整请求容量，不新增统一单条额度、批次额度或分配器。

压缩阶段验收：三协议最终请求体共享前缀、原生字段和 thinking 配置；默认 90% 与提前容量保护；三份旧摘要各自包含独有约束；连续三次以上成功压缩；长用户轮内部合法切分；超大不可拆组；摘要期间新输入到达；空正文、length、意外工具调用、无收益、Stop、提交冲突均不留下半次历史替换；同一失败不因自动／overflow／force 换入口重复拿重试额度。摘要工具调用不得执行。

16K 必须校验最终保存的摘要正文，包含确定性追加的文件操作信息。当前 `core/context/context-manager.ts:947` 会在模型摘要后 appendFileOpsSummary，只校验模型原始输出不够。提交前还要检查完整压后请求能放下且确实缩小；不能在摘要完成后临时重切尾段、截断摘要尾部来通过验收。

审查按“用户决定 → 问题代码 → 改动规则 → 可执行验收”对应。子代理先独立找反例，主代理核实；Fable 独立复核承重决策，建议应核查、采纳或说明不采用的理由，不能只因模型意见强就当事实。正式文档完成后还要再审查正式文本，当前对讨论稿的审查不能冒称正式文档已验收。

离线测试可以证明请求形状、配对、容量和事务规则；不能证明提供商真实 cache 命中率。后续有界实网核验比较压前普通请求、摘要请求、压后第一次及再下一次请求的真实 usage／cache。首次压后请求自然建立新缓存，不把它零旧历史命中判失败，也不额外发请求预热。正文质量用带已知约束、错误、任务标识的多次压缩样本核查，不能只验标题存在。

### 12.4 尚需收口的内容

1. 超大已闭合组的零尾段退路，以及允许摘要成为其工具结果第一次接收者的取舍：用户随后已确认，见 12.1，不再待定。
2. 摘要 32K 总输出试行值已获用户确认，见第 13 节；内部 fixed thinking 上限仍是工程细化项，模型能力和小窗口容量必须共同约束。
3. 工具结果稳定回放与真实状态保留；新增8K／20K统一配额已撤回，不再作为待确认项，也不依赖独立Shell议题。
4. 摘要失败／手动无普通 run 时用量记录的具体已有存储落点；复用结构，不能只挂成功摘要消息。
5. 所有层合计的有限重试数及失败何时允许重新尝试；不新建通用重试框架，不恢复成功两次上限。

更新：早期供审查的“三次请求＋一次内容修正”建议已被后续决定替代。用户现已确认总共最多两次实际请求，即首次＋一次暂时性网络故障重试，不换提示词修正摘要；SDK和其他入口不能独立放大。摘要失败后是否一律结束run尚未确认，见第15节。

### 12.5 独立复核后给用户的明确推荐

本轮已由子代理复核交互边界、依赖和数据库落点，并调用 `github-copilot/claude-fable-5.1`、medium 审查当前讨论方案。Pi 会话为 `codex-ohbaby-compact-review-20261011-a`，启动目录为本仓库根目录。Fable 核查了 ohbaby 源码；它报告本地沙箱拒绝读取相邻参考仓库，因此其参考比较沿用讨论记录，不能声称它独立复核了八个参考项目。本轮对参考项目的直接核对来自主代理和子代理。本节记录主代理核实后的建议，不复制或代写 Fable 原始回复。

用户已确认以下五个 improve 实施批次；Shell／Bash 独立议题不作为本轮前置，也不另造 improve-0：

| 阶段 | 交付与依赖 | 这一阶段的验收重点 |
| --- | --- | --- |
| improve-1：计数、预算与用量基础 | 复用现有计数器，补 reasoning 标准子项和兼容 map；分离模型能力、普通偏好与摘要额度；统一最终发送额度和容量预留；补摘要尝试记录的基础。先删除缩小摘要输入后仍按原范围提交的危险恢复分支，禁止未读历史退场 | 真实 usage 与估算分开、未知与 0 分开、reasoning/cache 不重复累加；4K 普通偏好不限制摘要；失败覆盖范围不扩大；必要 Chat 输出参数按端点能力映射 |
| improve-2：工具结果稳定回放 | 复用现有工具分页／限长、ToolPart持久化和serializer投影；核对状态、引用与回放，消除上下文层对旧结果的再次改写 | 错误／状态／配对保留；重启后旧结果不变；分页与实际返回一致；大批结果交完整容量和已定保留算法处理 |
| improve-3：摘要请求与缓存接通 | 基于正常 prepared request 追加指令；独立总输出；三协议最终 wire 和 cache 配置；每次尝试实际用量落档；一个有界重试预算。启用完整材料前必须已有摘要指令＋实际输出的容量检查和提前触发条件 | 三协议共享前缀及工具／native／thinking 字段；实际发送预算等于预留；空／length／工具调用不成为成功摘要；SDK 隐藏重试不放大；失败也记录用量 |
| improve-4：滚动摘要与原子切换 | 继承所有有效旧摘要；20K／40K／30% 与完整交互边界；明确超大组例外；最终摘要正文≤16K；固定覆盖范围和保留段；成功同事务替换 | 三份旧摘要各有独有约束、连续三次压缩、巨型组、压缩期间新输入、数据库重开、失败／提交冲突无部分退场；最终压后请求可发送且缩小 |
| improve-5：统一入口与旧策略退出 | 手动／自动共用完整过程，90% 默认线及更早容量保护正式接入；删除常规 prune/mask；跨入口失败保护；删除成功两次上限；后端 busy／重复／Stop 接线，轻量 UI 随后接入；安全清理旧分支、无用配置／事件／测试，按 SWE 原则复核 | 同一失败不从其他入口再重做、超过两次成功可继续、Stop 前后时序、手动空闲执行且不自动续跑、原文预览稳定、完整三协议回归 |

这些是实施与验收阶段，不代表每个中间提交都能单独作为完整新策略发布。improve-3～5 共同完成压缩切换，只有关键条件齐备才启用完整新流程；不为分期增加长期双实现或复杂运行时开关。尤其不能先让全量摘要进入旧 95% 触发路径，再等后续阶段补容量保护；也不能先删成功次数限制，后补失败重试边界。阶段内的测试从该阶段开始，最后验收只做贯通和效果核验。

对 Fable 建议的取舍：

- 采纳 32K 可能被 reasoning 用尽、输出正文截断的风险，但这不是已做真实模型实验得出的概率结论。用户已选择独立 32K 总输出作为首版试行值，length 则明确失败且不按相同参数自动重发；本轮不改成直接申请模型最大输出。模型能力上限不一定能在当前窗口中完整预留，不能沿用本地 50% cap 却在 wire 发更大的值。不能把其示例触发百分比写成所有模型的定律。
- 采纳 opaque 估算来源必须区分的提醒。source=output／limit 是保守代理值，可能高估；原生估算偏大和实际 usage 重复计费是两回事。Anthropic 可读 thinking 路径并不一律使用 output 代理，只有 opaque 分支会用它。Fable 建议 source=limit 时可保留整组、交整请求检查，但若这让尾段突破 H，就与用户硬上限冲突，不采用这一隐含放宽。首版仍按明确标注的保守估算执行硬帽；不能为了减少误触直接按不可靠文本估算做减法，存在高估导致多摘要的质量代价。
- 摘要前缀的验收基准修正为“同一份材料将要发出的正常请求”，不是要求它与前一次已经发出的请求完整相等。中间新增了模型回复和工具结果很正常；应检查已有共享前缀未被改写，新材料与摘要指令只追加在后。
- 采纳覆盖范围错误前置修复、最终持久化正文含文件操作追加一起检查、SDK 与外层不能各自重试，以及小窗口的验收。增加 64K／200K／1M 三档，检查小窗口下 H 小于 20K 的行为、无收益返回与压后下一请求不会无进展连续重压。

用量持久化的明确建议：复用 SQLite 和现有请求记录字段，增加一张小的摘要请求尝试表，而不是新建计费服务。requestId 唯一，关联 session／可选 scope／compactionId；runId 和成功摘要 messageId 可选。开始创建记录，终态更新同一行，保留可选标准 usage；是否应用摘要另记，不把请求成功等同摘要提交。会话外键级联删除，记账失败不得触发重发模型。理由是当前 run-ledger 只有 user trigger，Session data 没有自由请求记录容器，Storage 键没有会话外键清理且更新锁只在进程内；强塞旧结构会增加假 run、假消息或清理协调。准确依据：`runtime/run-ledger/types.ts:9`、`services/session/database-store.ts:87`、`services/storage/storage.ts:119`、`services/database/index.ts:126`／`:324`。表名和字段命名在正式方案确定，当前没有创建表或 migration。

工具预算纠正：此前新增单条8K、批次20K和共同上限分配算法的建议已撤回。用户要求的是问题和需求精细化，不是新增工具使用限制。沿用工具自身已有结果处理，复用已存ToolPart与模型投影，保持已发送内容稳定，不新建预览生命周期。

Read 必须专门验收：当前 50KiB 页的 cursor 指向完整已读页末尾（`tools/utils/read-file-page.ts:13`、`:262`）。若通用裁剪扔掉页中后半段却保留该 cursor，后续继续读会跳过内容。应让分页边界与实际交付一致，或提供已经可读取的该页引用；数据库里有原记录不等于已经提供召回工具。结构化／媒体结果不能用字符串 slice 冒充统一处理。

上述五阶段分组已获用户确认；新增8K／20K工具额度已撤回，重试已改为用户确认的总两次短暂故障请求；小表仍是工程建议。本轮已经向用户重点询问超大组交接和 effort 模式摘要总输出两项取舍；正式文档重写仍待讨论收口。

### 12.6 用户追问：这里要新设计 thinking budget 吗？

用户接受了零尾段例外，对输出预算则追问“设计 thinking budget？是吗看看 code-cli 下项目怎么做的”。明确答复：不新增 thinking 预算机制，不为 effort=high 人为造一个固定 token 值。需要选择的是摘要这一请求的总输出额度，thinking 和正文共用；已存在的固定 budget 和 effort 设置沿用原请求。两个问题不能混称。

本轮重新核对的本地实现（路径相对于 `/Users/hansun025/Projects/code-cli/`）：

| 项目 | 摘要总输出做法 | thinking 处理与借鉴边界 |
| --- | --- | --- |
| Pi | 基础额度 `min(floor(0.8×reserveTokens), model.maxTokens)`；默认 reserveTokens=16384 时基础 13107 | Responses／Anthropic adaptive 保持 effort，不因此再加固定 thinking 数；旧固定 budget 分支才加 B 并限于模型能力。空间不足会压低 B，此退路不采用。`pi/packages/coding-agent/src/core/compaction/compaction.ts:712`、`pi/packages/ai/src/api/simple-options.ts:92`、`anthropic-messages.ts:959` |
| Reasonix | 通常独立 8192，总共享窗口较小时降为 `min(8192,max(window/4,512))` | 保持原 effort，不另加一个固定 thinking 额度。`DeepSeek-Reasonix/internal/agent/compact_fold_input.go:15`、`compact.go:423`、`internal/provider/anthropic.go:364` |
| ZCode core | 独立 `min(模型输出能力,20000)` | 此摘要函数不按 effort 新造 thinking token 预算。`ZCode/apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:716` |
| Kimi full compact | 优先 resolvedModel.maxOutputSize，未配置回退 `min(上下文窗口,128×1024)` | fixed budget 和 adaptive effort 在 provider 分支分别处理，摘要不新建一套 thinking 规则；继承普通模型配置的额度不符合 ohbaby 已确认的解耦要求，不照搬。`kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:633`、`packages/kosong/src/providers/anthropic.ts:1237` |
| Codex 所查 Responses compact 路径 | local compact／remote v2 使用的请求结构没有显式 max_output_tokens 字段 | 复用当前上下文窗口的 effort；不能据此推断服务端内部额度无限，也不能拿它证明摘要32K。`codex/codex-rs/codex-api/src/common.rs:279`、`core/src/session/reasoning_effort.rs:93` |

因此，没有“参考项目证明 effort 摘要应统一 32K”的结论。主代理此前的 32K 是给 ohbaby 的首版工程建议，不是 thinking 专属 budget，也不是保证“正文 16K＋thinking 固定 16K”。本节调查后用户已确认其为首版试行值；这仍不代表参考项目证明它最优。

机制上给出明确建议：effort-only 沿用 effort，只选择摘要独立总输出上限；已有固定 B 的协议保持已解析的 B，校验它与摘要总输出及正文目标的关系；两者都受真实模型能力和完整请求容量约束。不要新建 high/medium→token 映射，也不要为了选一个数再造模型默认额度的独立配置系统。首版数值随后已确认独立 32K 总额作为试行值，代价是 high 下可能 length 失败；无正文或不完整时不替换历史、不拿同参数自动重试。若用户更重视这种场景下成功率，再讨论更大总额度及更早触发的取舍。没有真实样本验证前，不把成功率或失败概率说成已知。

例：effort=high、max_output_tokens=32K，表示整次最多输出 32K，模型自行分配给 reasoning／正文，不意味着必须思考 32K。若已有固定 budget_tokens=12K，则 B＋正文上限16K为28K，能容纳在32K试行总额度内；在实际能力和容量允许时保持原12K设置。这是在消费既有 thinking 配置，并非重新发明 thinking 机制。


## 13. 2026-10-11 最新确认与数据流补充

### 13.1 用户确认及目录安排

- 摘要总输出与 thinking 控制分开；32K 总输出作为首版试行值。thinking 的数字预算由代码内部合理配置，不增加用户设置。两种 thinking 模式复用现有解析、预算和容量计算，最终发送值与容量预留值一致。
- 确认五个 improve 实施批次。Shell／Bash 的 `2026-10-11-shell-and-glob` 是独立议题，与本轮无关；此前将其写成本轮前置是主代理的误判，已经修正。
- improve-5 除入口贯通外，要安全删除旧压缩机制与代码冗余，做实施后的代码清扫和 SWE 检查。若确有额外流程或内容过多，再延到 improve-6；不先增加第六批。
- 阶段验收时，允许在 agent 自己启动的 ohbaby 服务进程中使用真实 API key 请求并探测上下文行为。模型和凭据来源为仓库 `tests/models-4-tests.md`，文档不复制凭据。
- 实施前讨论、现状分析、参考调查、方案和测试规划统一放进本目录 `plan/`。本次把原 `improve-1/` 的 00～04、临时讨论、raw 原始存档及模块侧草案收进来；第一批真正开始实施时再建立 `improve-1/`。原始存档保留原文，旧链接代表历史，不把其中旧指令当作现行方案。

### 13.2 thinking 配置的实际缺口与建议

调查结果：`ReasoningConfig` 已经只有 enabled／effort，`/connect` 没有数字 thinking 输入框。但 fixed thinking 当前从可编辑 model profile 的 `reasoningCapabilities.budgets[effort]` 读取；`reasoning.ts:341` 检查最小额度及 B < maxTokens，没有内置统一默认数值，也不会自动 clamp。不能把“不要新增 UI”误写成“已经完全由内部管理”。

继续使用现有 reasoning resolver 和模型能力配置，fixed 的数字映射由内部维护，不新建配置服务；effort／adaptive 只传真实支持的档位，不伪造数字 budget。主代理曾建议统一 fixed 上限16K，但本轮复核后撤回：正文≤16K不意味着必须为正文留满16K，这一上限会不必要地改变普通请求。保持既有已解析B，数字配置不交给普通用户填写；摘要沿用B，不到compact时重新降档。大B与32K不兼容时的取舍见第14节，尚待用户确认。

32K 是摘要整次输出的试行上限，16K 是最终摘要正文上限，二者不表示一定分别消耗 16K thinking 和 16K 正文。fixed B < 32K 才满足对应协议的基本关系；B > 16K 不必然失败，只是正文可用空间更少。已有会话的 B >= 32K 或模型真实能力不足时，必须明确处理不兼容，不能静默改 thinking 或把本地预留与发送额度做成两个值。effort-only 无法保证 thinking 的精确消耗，length／无有效正文仍保留旧历史并报告失败，同参数不自动重发。

依据：`packages/ohbaby-agent/src/config/llm/types.ts:12`、`:34`；`services/interface-providers/reasoning.ts:332`、`:341`；`core/llm-client/streaming.ts:291`；`services/llm-model/modelProfiles.ts:221`。数值能力应在已授权的阶段实测中核对，不声称32K对所有模型保证成功。

### 13.3 数据结构：补齐现有对象，不造通用框架

以下是主代理核实后的最小设计建议，尚未实施。

1. **准备好的请求包含已解析的发送配置。** 当前 `PreparedModelRequest` 只固定 inputIds／messages／tools，reasoning、maxTokens 和 cache 配置在 streaming 再解析。复用现有请求类型，将模型标识、温度、ResolvedReasoning、最终 maxTokens、purpose、session／scope 和 cache 策略随材料一起准备好；signal 仍由本次调用传入。容量检查和实际发送读取同一结果，不复制客户端、密钥或整份配置。
2. **每次摘要请求有独立的用量归属。** 摘要客户端接收 prepared 请求，返回有效正文和产出它的 requestId。复用普通请求的事实字段，在小型摘要尝试表记录 compactionId、session／scope、attempt、时间、结束原因、可选 usage；runId 可选。不能为了手动 compact 伪造 run，也不能让普通请求必填的 run／message 所有权全部变成可选。
3. **压缩只选一次范围。** 复用当前 candidate，持有 prepared 请求、待退场 parts 快照、保留 IDs、受保护 inputIds。摘要输入和待退场集合分开命名：保留段可以被摘要读取，但仍原样保留。生成、压后容量验证和提交都使用同一份选择，不在摘要完成后重选尾段。现有整次 compact 的 attemptId 可直接作为 compactionId，不另加操作表或历史版本系统。
4. **请求成功与摘要应用分开记录。** 请求结束先保存消耗，即使正文无效也保留；随后只有通过正文、覆盖范围、工具关系和容量检查，才在现有 commitCompaction 事务中同时插入摘要、标记旧 parts、关联 requestId 与 summaryMessageId／appliedAt。记录失败不能触发重新请求模型；应用事务失败不退场旧历史。事务内部复用同步 SQL，不嵌套另一笔异步写事务。
5. **新输入沿用现有投递机制。** 摘要读过受保护用户输入不代表普通请求已处理。摘要期间新到输入留给既有调度器，下一次普通请求重新准备；提交只处理计划中的精确 IDs，不按时间批量退场，也不因新增一条输入就重做已付费摘要。
6. **旧会话自然迁移。** 第一次成功压缩时，读取全部仍活动的旧摘要和对应旧历史，把它们合并为一份新摘要；同事务让旧摘要退出活动视图。失败保持原状，数据库原文不删。不新增 activeSummaryId、摘要链表或后台全文迁移任务；hasSummary 按活动摘要判断。

代码依据：`core/context/types.ts:51`、`:95`；`services/interface-providers/types.ts:170`；`core/llm-client/types.ts:257`；`adapters/ui-runtime/prompt-context.ts:85`；`core/message/database-store.ts:526`；`core/context/context-manager.ts:208`、`:540`、`:823`、`:862`、`:1486`、`:1699`。路径均相对于 `packages/ohbaby-agent/src/`，行号为当前调查快照。

数据流为：准备一次请求与范围 → 校验容量 → 发起摘要并逐次记录用量 → 校验最终正文与压后请求 → 一次事务切换活动历史。自动 compact 随后重建普通请求并继续；手动 compact 报告结果即结束。停止、生成失败或提交冲突都不留下半次历史替换。

### 13.4 第五批清扫与阶段实网验收

第五批清扫必须以新路径已有回归覆盖为前提：删除常规 prune／mask、成功两次限制和重复 retry 入口，检查随之失去引用的参数、类型、事件、辅助函数和旧测试。保留数据库原始历史、旧摘要以及读取既有会话需要的兼容逻辑；“清扫”不等于删除旧数据。检查职责、重复计算、耦合和无用抽象，不做与本议题无关的全仓库重构。跨入口验收与 Stop／失败保护不能单纯以减工作量为由后移；只有额外独立流程或非必要大范围清理才考虑第六批。

阶段验收先做有针对性的离线测试，再在 agent 自己启动的服务、独立测试会话和数据目录中做有界真实调用，不占用或停止用户正在运行的服务。凭据在进程中从指定测试说明或环境加载，不放进命令行参数、文档、请求转储和审查提示。现有测试说明由用户维护，本轮不改写。

实网按当前阶段选择必要样本，不遍历全部模型：计数阶段核对原生／兼容 reasoning 的实际回传、usage 和输出额度；工具阶段核对首次定型与重启稳定；摘要阶段覆盖 Chat Completions、Responses、Anthropic 的最终参数、结束原因和 cache usage；最后贯通手动／自动、90%／更早容量保护、多次成功压缩及失败保留原历史。使用带已知约束、工具错误和任务标识的历史核对摘要没有丢承重信息。

64K／200K／1M 边界可先用离线构造测试，真实服务探测应记录实际输入规模、模型、协议和提供商返回用量；未实测的规模不能报成已通过。缓存不保证每次命中，验收分别说明客户端共享前缀是否保持和服务端是否实际返回 cache read；压后首请求自然建立新缓存，不要求复用已被摘要替换的旧历史。

本次只整理文档和补充讨论；没有改业务代码，没有启动服务或进行真实 API 请求。

## 14. 2026-10-11 重新梳理：待确认的取舍与各批边界

### 14.1 plan 与实施文档的职责

用户明确：plan 阶段可以有较详细的整体构想；后续逐一撰写 improve-1～5，记录该批精细化但保持 KISS 的规划，以及实际实施和验收。不是等实现时才补关键失败语义，也不是现在预写五套重复文档。

plan 要说清规则、跨模块数据流、阶段依赖、失败处理和验收目标。各 improve 开始前按当时的真实代码细化本批改动、必要迁移和可执行测试，再记录实施结果。阶段细化不默默改变已经确认的预算、尾段或缓存规则。

90%默认线、提前容量保护、单份滚动摘要、正文≤16K、20K／40K／30%保留算法、巨型组零尾段、统一手动自动过程、成功才切历史等继续有效。用户最新要求重新调查32K试行值如何适用，不能把此前同意试行值扩成所有协议硬帽，见第15节。

### 14.2 仍值得用户确认的三个取舍

下面是本轮明确建议，还不是用户确认。内部字段命名、函数拆分和小表字段不再当作产品选择逐项询问。

**A. 已撤回：新增工具正文单条8K／批次20K配额。**

用户明确指出该方案过于机械，精细化应聚焦问题和需求，保留LLM操作灵活性。撤回配额、共同上限／均分算法以及为此新增的第二份预览生命周期。不再要求用户确认这组数字。工具自身已有分页和必要资源限制继续使用，正文、状态和引用在当前持久化路径确定，后续普通请求与摘要请求共用已有投影；窗口压力通过完整请求容量与既定compact流程处理。

**B. 摘要重试与失败后的运行行为：首版采用更小的失败流程。**

用户现已确认：最多两次实际provider请求，即首次＋最多一次暂时性网络故障重试；沿用现有退避和错误分类，并保留“已收到正文／thinking／工具片段后不自动重发”的保护。SDK和其他入口不能另开重试额度。此建议替代12.4中未确认的“三次请求＋一次内容修正”构想；子代理倾向三次，主代理选择两次以控制首版成本，用户已确认两次这一上限，未声称实测证明两次最优。

空正文、length、意外工具调用、最终正文超过16K、压后不缩小或仍放不下、协议或配置错误，均直接失败，不再换一句提示词要求“重新总结”。保留原历史和实际用量。已成功生成正文但提交失败，不重新付费生成；不能把HTTP成功当成摘要已应用。

以下仍仅为主代理建议，用户这次只确认了重试次数和不修正正文，没有确认统一停止run：自动压缩最终失败时，结束本次自动运行并给出简短原因，保留会话与已经完成的工具结果，待用户重试／继续；手动失败只报告结果。这是失败终态，不是在生成过程中自动取消。已有明确“无需压缩”结果也不当作失败处理。

另一种可行方案是仅在完整容量检查仍允许时继续普通请求，但这需要区分90%触发、摘要余量保护、普通请求溢出、网络故障和提交冲突等情况。两种失败后行为仍待后续讨论，不能因为用户确认重试次数就视为已选停止run。例：200K窗口，旧输入已接近能容纳32K摘要输出的边界，普通请求只要8K暂时还能发；若摘要失败仍继续消耗空间，下一次可能连完整摘要都放不下。结束本轮能避免这一连锁问题，代价是偶发摘要失败时需要用户再继续一次。

同一次自动运行内，自动／overflow／force入口共享最终失败结果，不能从别的入口重新拿到付费尝试次数；用户主动重试或新开一次运行才重新获得额度。服务端已经报超窗时，不能在压缩失败后原样重发普通请求。成功压缩次数仍不设总上限，不恢复“最多两次成功”。

**C. 已撤回：仅因固定thinking达到32K就拒绝摘要。**

用户要求重新调查参考实现。重新追踪到provider层后，Pi的fixed路径会将基础输出额度与thinking B相加；没有统一32K总硬帽。把32K试行值套在所有协议上、再人为制造B≥32K不兼容，是主代理新增的限制，撤回。新建议与真实模型能力边界见第15节，不将其写成用户已确认。

### 14.3 不必反复确认的内部设计建议

- 请求参数在发送前解析一次，沿用现有模型／协议能力处理；容量检查与发送读同一结果。
- 一个临时压缩计划固定输入、退场范围和保留段；新输入仍走已有投递机制，不能被旧计划顺手退场。
- 小型摘要尝试记录复用现有SQLite及标准usage字段，失败也记消耗；摘要应用与旧parts退场在现有事务内关联。不要因此新建计费服务或通用工作流框架。
- 旧会话多份活动摘要在下一次成功compact自然合并，不后台重写历史。失败保留原状态。
- 90%指完整上下文窗口占用，容量检查另考虑实际输出与余量。当前`needsSummaryCompaction()`已经使用完整窗口比例，应保留这个含义，不能改成对扣完输出的输入预算再次乘90%。
- 压缩后完整请求必须能发且确实缩小；不另设“必须减少X%”或50%新阈值，不在成功后继续剪保留段。
- 验收使用独立服务进程／测试会话，按用户已授权的模型说明做有界真实调用，不重复索要已给的授权；不在文档复制key。

### 14.4 五批实施各自解决什么

| 实施批次 | 计划中的主要交付 | 进入下一批前要证明什么 |
| --- | --- | --- |
| improve-1 | 计数、模型输出能力与普通偏好分开、已解析输出／reasoning预算、标准usage与摘要记录基础；提前删除未读历史却退场的危险恢复分支 | 同一材料不重计／漏计；发送与预留一致；未知用量不写成0；普通maxoutput不限制摘要专用额度 |
| improve-2 | 复用ToolPart和现有serializer，工具结果稳定回放、状态与引用核对；不新增批次配额或预览生命周期 | 错误和调用关系保留；Read续读位置正确；重启后已存结果稳定；大批返回由整请求容量检查处理 |
| improve-3 | 复用正常请求生成摘要、缓存策略、独立总输出、实际尝试用量和单层重试 | 三协议最终请求形状正确；启用完整输入时已具备容量保护；失败记录真实且没有隐藏重试 |
| improve-4 | 旧摘要继承、20K／40K选择、超大组、最终正文校验、原子替换 | 新输入和未完成调用不丢；一份活动摘要；失败／Stop／冲突没有半次提交；压后请求可发 |
| improve-5 | 手动／自动入口贯通、90%与提前保护正式接入、轻量提示、旧prune／mask／重复retry清除、SWE清扫与实网贯通验收 | 默认路径完整使用新流程；失败不会换入口再付费；多次成功压缩可继续；保留必要数据兼容且无旧策略残留 |

各批有各批的测试，不能只在第五批测试。第三至第五批是共同完成的行为切换，不假设每个中间状态都能独立上线；第三批的完整输入路径不能等第五批才补容量检查。第五批删除旧入口前，要确认新路径已覆盖所有调用方。是否出现第六批按届时实际新增工作判断，不预建。

本轮由子代理分别复核预算、工具批次、失败入口，主代理核对并作出上述推荐。依据仍是本地代码调查，未运行真实API；本节没有把建议标成用户确认。


## 15. 2026-10-11 用户纠正：减少工具限制，重查摘要总输出

### 15.1 本轮用户原意与状态

用户明确指出“精细化是指问题和需求的精细化”，要求保留LLM操作灵活性，不要增加不必要限制。主代理撤回工具单条8K／批次20K统一额度、共同上限分配算法以及由此衍生的额外预览状态。

用户确认摘要总共最多两次实际请求：首次＋一次暂时性网络故障重试，不换一句“请更简短”重做摘要。该确认不包含“所有摘要失败都自动结束run”；后者仍是未决行为，不能扩大用户确认范围。

用户要求重新从code-cli源码判断是否有32K固定总上限。此前同意32K首版试行，不构成“任何协议、任何thinking预算都不得超过32K”的授权或依据。

### 15.2 工具结果的最小改造

现有`resultToToolState()`已将正文、metadata、错误或取消状态存入ToolPart；lifecycle在工具结束后更新持久化。serializer从同一part生成调用和对应结果，`formatToolResultContentForModel()`将现有状态、退出码、游标、子代理标识等投影到模型输入。

因此首选复用这条已有路径：工具自己的分页／必要限长先完成，保存最终结果；普通请求与摘要从相同记录生成输入。移除日常prune／mask对旧结果的再改写，核对恢复后的投影一致。若稳定性测试发现具体缺口，再修实际缺口，不先新增“生成预览—发送—冻结”的状态机或第二份正文。

LLM仍可按需要决定读哪些文件、读哪一页、继续调用哪些工具。大批结果不强制均分额度；如确实让上下文变大，按已确认的整请求检查、合法交互边界和超大组摘要规则处理。一次巨大输入仍可能超过可用容量，不能以取消配额为由假称不存在超窗；这种情况按现有容量失败与禁止未读历史退场的原则处理。

依据（相对于`packages/ohbaby-agent/src/`）：`core/lifecycle/lifecycle.ts:234`、`:1789`；`core/context/serializer.ts:196`；`core/context/tool-metadata-projection.ts:280`；`tools/utils/read-file-page.ts:262`；`agents/subagents/result-artifacts.ts:141`。现有`tools/utils/output.ts:4`的8000参数是字符近似限长来源，不等于本轮批准新增统一8K token规则。

### 15.3 参考项目的实际输出额度

本轮重新沿摘要入口追到请求／provider层，不能只看到某个maxTokens变量就断言所有协议最终总额度相同。以下路径相对于`/Users/hansun025/Projects/code-cli/`。

| 项目与路径 | 直接读到的行为 | 借鉴边界 |
| --- | --- | --- |
| Pi摘要入口 | 基础额度`min(floor(reserveTokens×0.8),model.maxTokens)`；默认reserve16384时为13107 | `pi/packages/coding-agent/src/core/compaction/compaction.ts:712`；基础数值不等于所有协议的最终总额 |
| Pi Anthropic fixed | `min(基础额度+B,模型输出上限)`，再检查剩余窗口；B来自既有thinking档位配置 | `pi/packages/ai/src/api/simple-options.ts:92`、`anthropic-messages.ts:959`；默认high时13107+16384=29491，总额不是固定32K，custom B更大时总额可以更大 |
| Pi adaptive／Responses | 不加虚构B，沿用effort与基础总额度；是否发送输出字段还受协议兼容设置控制 | `anthropic-messages.ts:948`、`openai-responses.ts:238`／`:340`；不能把high换算成固定thinking token数 |
| Reasonix | 摘要专用8192；小共享窗口按`min(8192,max(C/4,512))`；发送前再按模型及剩余容量解析 | `DeepSeek-Reasonix/internal/agent/compact.go:23`／`:423`、`compact_fold_input.go:15`、`output_budget.go:512`；所查Anthropic实现为adaptive／binary，不能拿它证明fixed B怎么加 |
| ZCode core | 摘要option为`min(模型输出能力,20000)`，保留原reasoning option；实际JSON字段由路由的option map映射 | `ZCode/apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:716`、`compact-summary-model-request.ts:311`；不能未经实际route核对就把20K说成所有协议同样的wire总额 |
| Kimi full compact | 采用resolvedModel.maxOutputSize，否则按窗口与128×1024取小；请求层还可能受全局输出override影响 | `kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:633`；不照搬普通配置继承，因为ohbaby已要求与/connect普通额度解耦 |
| Codex所查local／remote-v2 compact | 复用Responses请求与当前窗口的effort，所查请求结构没有显式max_output_tokens | `codex/codex-rs/codex-api/src/common.rs:279`；不能据此推断服务端无限输出或不需要容量管理 |
| OpenCode新core | 先取普通generation.maxTokens或模型默认，再与4096取小；压缩函数没有新增thinking budget | `opencode/packages/core/src/session/compaction.ts:181`、`:189`、`:208`；与旧packages/opencode是不同路径，不混称 |

本地claude-code为非官方重建项目。其共享缓存的fork路径明确不另设输出override，避免底层随之压低thinking；短system兜底路径才设置独立20K且关闭thinking。可借前者保持配置的理由，后者与ohbaby已确认规则不符，不采用。依据`claude-code/src/services/compact/compact.ts:1215`、`:1345`、`:1357`及`src/utils/context.ts:17`。

结论：所核查路径没有共同的32K硬上限。各项目都有自己的输出策略；可以借它们区分基础额度、thinking和模型能力的做法，不能把其中某个数字宣传为共同最佳实践。

Kimi实际full-service的补充链路：`llmRequesterService.ts:695`与`llm-adapter/model/completion-budget.ts:11`允许全局maxCompletionTokens优先；最终human requester的Responses／Chat／Anthropic各自映射输出字段。其Anthropic旧fixed high为32000，是thinking映射，不是摘要总额；adaptive只传effort。依据`packages/agent-core-v2/src/human/llm/requester/bases/anthropic/profile.ts:252`。不能拿这处32000为ohbaby统一32K提供依据。

### 15.4 主代理的修订建议：沿用预算解析，去掉统一硬帽

这是依据本轮调查提出的建议，尚未获用户确认：

- 无thinking：摘要申请额以已确认正文16K和真实模型输出能力为界。
- 已有固定thinking B：借Pi的“基础额度+B”，以`min(16K+B,真实模型输出能力)`解析摘要请求总输出。保留B不变。例：B=32K、模型允许时申请48K；不再因为额外的32K人工硬帽直接拒绝。
- 只有effort／adaptive：没有已知B，不能做上述加法。可保留用户此前同意的32K作为ohbaby首版内部试行总额，仍受真实模型能力约束；明确它是本项目试行选择，参考项目没有证明32K最优。它不约束fixed分支，也不意味着固定分配16K给thinking。用户当前重审其适用范围，正式稿不能写成全部已定。
- 这几种结果都走同一个现有预算解析与完整请求容量检查，实际发送和预留一致。摘要不继承/connect普通输出偏好；正文最终仍≤16K。不新建自动升额重试、动态预测、thinking用户输入或普通请求16K thinking硬限。
- 真正的不兼容只按模型／协议能力判断，例如实际cap≤B；不因32K试行值制造不兼容。Pi容量不足时可能压低B的分支不采用；不得为凑空间裁掉摘要输入。

不推荐所有摘要都直接申请模型最大输出：有些模型可输出100K甚至更多，全部预留会让压缩明显提前。能申请这么多不代表摘要需要这么多。提前触发本身不违反90%默认线，但本轮没有证据证明为每个摘要预留模型最大额值得。

现有预算函数还有“最多约半窗预留”的行为。这是待核对的旧实现，不能因为参考意见提到就新增成产品硬限制；尤其不能本地只预留半窗，实际却发送更大的额度。improve-1在现有解析中统一实际可发送额度，并分清模型能力与/connect偏好后，后续才能消费可信的结果。

### 15.5 独立复核范围

子代理重新检查Pi／Reasonix／ZCode、Kimi／Codex及ohbaby现有投影。主代理另用calling-pi-agent调用`github-copilot/claude-fable-5.1`、medium，同一会话`codex-ohbaby-compact-review-20261011-a`进行只读复核。

Fable支持fixed按16K+B、effort沿用32K试行值，而不是全部直接用模型最大输出；它只直接读取ohbaby，相邻项目使用主代理提供的调查事实，不能声称它自行复查了那些源码。主代理纠正其两处表述：因更大输出预算提前压缩不自动构成与90%规则矛盾；现有50%预留上限不是用户新确认的规则。模型cap若小于B仍需合法性校验，不能说16K+B再取min之后必然通过。

本轮没有改业务代码、没有运行上下文实网探测。Pi调用用于设计复核，不是ohbaby接口或缓存效果验收。原始审查回复在对话中呈现，不当作用户确认或直接复制进正式设计。

## 16. 2026-10-11 整体规划更新与最终失败行为确认

用户接受上一轮修订方向，并再次要求尽量减少不必要的上下文大小／token限制，避免Context机械化。整体规划采用正文基础＋已有fixed B、effort／adaptive32K内部试行值，继续复用现有预算解析；移除工具配额、分配算法和额外预览状态。

用户对本轮异步问题明确选择：

> 结束本次运行，保留会话，等待重试或继续。

适用场景为自动摘要在允许的重试后仍失败。保留全部历史和已完成工具结果，不从其他入口在同一运行重新请求摘要；用户重试或继续后再进入新运行。前文“此行为尚未确认”的状态至此结束。

plan/00～04和context-design已按当前讨论重写。plan保留整体规则、数据流、五批依赖与验收目标；improve-1～5后续逐一细化并记录实施，本轮没有预建实施目录、修改业务代码或运行ohbaby实网探测。原始raw记录不改写。

正式稿经子代理和 Fable 复核后，主代理修正了“已有部分正文／thinking 就禁止网络重试”的额外限制。按用户原先的两次实际请求规则，符合暂时性网络故障分类的断流仍可使用剩余一次机会，半成品不拼接、不提交，用量分次记录；Stop、length、工具调用及协议错误仍不重试。摘要用途的处理不全局改变普通请求规则。

实施顺序明确为第三批同时接入完整摘要请求、90%默认线与必要的容量提前保护，第五批贯通所有入口和清扫。原稿已经要求第三批有容量保护，不能将审查意见中的“保护完全缺失”当作现状事实。小窗口可能通常早于 90%触发，这是实际输出预留的结果，不另设百分比；64K 窗口＋B=32K 也按完整材料判断，不能一概断言失败。宿主已知追加的文字在生成前计入既有 16K 正文额度，避免生成后确定性超限，不新增文件操作配额。

## 17. 2026-10-11 逐项确认（实施前收口）

本节记录与用户逐项讨论后新确认的决定。与前面章节冲突时以本节为准。每确认一项追加一条。

下面的“取代”一律按**章节名**引用，不按行号——行号会随文档重写失效。

### 17.1 保留段不写进摘要指令（已确认）

摘要指令只要求把完整对话讲清楚，不包含"哪一段会原样保留"。保留段在提交那一刻决定，不进入摘要请求。

理由：保留段要到提交时才定死，中途可能因为超窗、无收益等原因变化。提前告诉模型的边界一旦和实际不一致，模型会按错的边界省略信息。核查的五个项目（claude-code、codex、gemini-cli、opencode、kimi-code）都没有把保留段写进摘要指令。claude-code 的"最近的消息会原样保留"出现在压缩之后的摘要消息里，不在这条请求里。

取代 `00-discussion.md` §3 里“保留段是否写进指令”的表述、`02` §5.2，以及 `context-design/02-change-spec.md` 里“指令里原样保留的那段”相关表述。压缩后的摘要消息可以补一句"最近的消息会原样保留"。

### 17.2 保留段预算按固定 20K（已确认）

保留段是压缩后进入上下文窗口的最近原文，按固定 token 预算选取，沿用现有 `KEEP_RECENT_TOKENS = 20_000`，不按窗口比例。`00-discussion.md` §3 里任何按窗口比例选取保留段的表述一并作废。切分算法见后续条目。

### 17.3 手动 `/compact` 与自动共用分叉（已确认）

手动 `/compact` 不再保持现状。它与自动压缩共用同一套请求构建（下一份正常请求加末尾指令）、同一份滚动摘要、同一套保留段与原子提交。差别只在触发方式：手动绕过自动阈值、低占用也允许。

取代 `00-discussion.md` 第 48 行"手动压缩整条管道保持现状"，以及 `02` §2.3、`context-design/02` 里"手动路径仍先 prune、短 system、无 tools、拍扁历史"的表述。连带结论：prune 不再需要为手动路径保留，可以整体删除。

### 17.4 保留段切法：固定 20K，对齐合法边界（已确认）

保留段只用一个固定预算 20K，删掉"补齐完整轮次最多到 `min(40K,窗口×30%)`"和"最新超大组交给摘要、原文尾段为空"两条规则。

选取方式借鉴 Pi：从最新往前累计到约 20K，切点对齐到合法边界（真实用户消息起点或助手消息起点），不拆工具调用与对应结果；未闭合的调用整组向前扩展。20K 是预算不是硬线，为了对齐允许略超。最新一组不可拆交互本身超过 20K 时，整组保留，允许超出预算。

核查过 pi、codex、kimi、opencode（新旧两版）、gemini，没有项目使用"20K + 40K + 30%"这种三层规则。Pi 的做法最接近，也只用一个固定预算。

取代 `00-discussion.md` §3、`02` §5.1 与 §9 improve-4、`04` D2 与 D3、`03` 的 40K 表述，以及 `context-design/02`、`03` 的对应句子。现有代码 `compaction-policy.ts` 的 `findCutPoint` 已经做到"合法边界对齐"和"未闭合调用保护"，`getHistoryToCompress` 里 `fullTokens × COMPRESSION_PRESERVE_RATIO` 这条比例分支应删除，保留段只留固定 20K 一个口径。

### 17.5 摘要用量不新建表，挂在摘要消息上（已确认）

用户确认：摘要用量不进新表。

核查现有代码后确定落点：成功摘要本身就是一条 `AssistantMessage`（`core/message/types.ts:232` 的 `CommitCompactionInput.summary`（字段在 `:237`）），而 `AssistantMessage` 已经有 `modelRequests?: readonly ModelRequestRecord[]`（`core/message/types.ts:47`）。普通请求正是这样留档的。所以摘要这次 `purpose=context-summary` 的请求记录直接跟着摘要消息一起提交，与 parts 退场同一个 `commitCompaction` 事务。

`ModelRequestRecord`（`core/llm-client/types.ts:257`）现在有 requestId、runId、messageId、step、attempt、purpose、起止时间、outcome，没有 usage 字段。只有确认真需要时才在既有记录类型上补一个可选 usage，不新建计费服务。

失败、被停止或判定无收益而没有产生摘要消息时，没有可挂的对象，只写一行日志（requestId、用量、结束原因）。不为失败路径单独造记录容器。

取代 `00-discussion.md` §4、`02` §6.1 的"小型摘要尝试记录"表（原设计：requestId 唯一、session／scope、compactionId、attempt、起止时间、outcome、可选 usage、可选 runId、summaryMessageId／appliedAt）、`02` §6.2 的"开始请求前建立尝试记录"、`02` §10 的"小型用量记录采用增量 schema 迁移"，以及 `04` C5、`context-design/02` 第 34 行的对应表述。

依据：`run_ledger`（`services/database/migrations.ts:52`）只记 run 状态／时间／错误，本来就不存 token 用量；为一次内部动作新建表，是当前代码里没有的复杂度。

### 17.6 压缩完成后的 UI 显示（已确认）

用户要求压缩后像 claude-code、opencode 那样显示压缩信息并刷新上下文占用。

参考做法（依子代理对本地源码的复核，详见[03 §5.1](./03-reference-projects.md)）：

- claude-code：进行中 spinner 显示`Compacting conversation`并带一个渐近进度条；完成后往对话流插永久消息。**手动`/compact`那条带压前／压后占用**（`Context: ~X → ~Y tokens`），自动那条只有`✻ Conversation compacted`，没有再给数字。占用显示本身**不立即重算** —— 它只统计 compact 边界之后的真实 usage，边界后没有带 usage 的响应，计数归零，等下一轮才刷新。
- opencode：完成提示是消息流里一个` Compaction `分隔框（Web 文案`Session compacted`）；**没有进行中文字提示，也没有完成 toast**；摘要指令还要求模型别提压缩这件事。占用同样**不立即刷新**，因为摘要那条 assistant 的 tokens 是 0，会被"取最后一条有 tokens 的消息"的逻辑过滤掉，也要等下一轮。
- 两家都没有单独的用量面板，摘要用量都不入库。

ohbaby 的现状：`UiContextWindowUsage`（`packages/ohbaby-sdk/src/context-window.ts`）已经带 `currentTokens`、`contextWindowTokens`、`contextWindowRatio` 和 `composition`，其中已经有 `summarized-conversation` 一格；footer 用 `formatFooterContextUsage`（`12% 24k/200k`），面板用 `formatContextWindowUsage`（`24K / 200K (12%)`）；`ContextEvent.CompactionStarted`／`CompactionFinished{outcome,status}` 也已经存在，CLI 已经把它渲染成 `Compacted`／`Compact failed`／`Compact skipped`。

结论：全部复用，不新做界面。

1. 进行中：沿用现有 spinner，文案加`Compacting`。不照搬 claude-code 的渐近进度条，那需要额外的 token 进度事件。
2. 完成：消息流一条暗色单行，手动与自动统一，都给压前／压后占用，例如`✻ 已压缩对话 148K → 22K`，直接回答"腾出多少空间"。参考项目里只有 claude-code 的手动路径给了这个数字，自动路径没给；ohbaby 统一都给。
3. 占用显示：ohbaby 的占用本来就是本地估算口径，所以提交后可以立即刷新 footer／面板，不必像两家参考那样等下一轮。要写明它是估算值，下一轮真实 usage 回来后按既有路径校正。
4. 摘要请求自身的消耗不进占用显示，也不混进下一份普通请求的输入估算；只在日志里。

取代 `00-discussion.md` §4 里“暂不要求在 UI 显示全部明细”的含糊表述。

### 17.7 effort／adaptive 的 32K 保留，并明确它是输出上限（已确认）

用户确认保留 32K，同时纠正一处措辞：16K 与 32K 都是**发送时的输出上限**，不是主动要求模型写这么多，也不是目标长度。摘要实际写多长由模型自行决定，宿主只保证不因此超限。

表述从“32K 内部试行总额”改为“`16K 正文＋试行 thinking 预留，合计 32K`”，与上一行“16K＋B”变成同一形状（正文额度＋thinking 额度），只是 B 已知、effort 下未知，所以用试行预留代替。规则从三种形状收敛为一种。

保留 32K 的理由是不对称：要多了只是普通请求前的容量预留偏保守、压缩略早触发，正文仍卡 16K，代价小；要少了 thinking 可能把额度吃掉，正文被 `length` 截断判定失败，正好在最需要压缩时失败。数字是常量，实网数据回来后可调。

取代 `00-discussion.md` §4、`02` §4.1 表格与段落、`03` §3 结尾的对应表述。

### 17.8 保持五批，并调整批次边界（已确认）

用户确认继续分五批做实施，理由是各司其职、更精细。主代理补充了分五批的技术理由：**按"错法"分批**——请求发错（第 3 批，抓 wire 就能验）、本地切错（第 4 批，要故障注入和崩进程才现形）、计量算错（第 1 批）、投影不稳（第 2 批），四种故障面的查法和验法都不同，混批做出了问题要先花时间分锅。

据此调整三处：

1. **第 1 批标明为独立 bug 修复**，可最快单独合入，不受其他批次进度阻塞。`02` §9 表的"性质"列区分"修 bug＋计量"与"加功能"。
2. **"轻量提示"（压缩后 UI）从第 5 批挪到第 4 批**，与压缩同批验证，避免压缩正确性和提示正确性隔三批。`04` 的 E6 从批次 5 改为批次 4。
3. **"实网贯通"不再是交付物，改为每批的收尾动作**。用`tests/models-4-tests.md`里的真实 api-key 发真实请求，每批完成时做本批相关的字段、usage 和 cache 探测；第五批做的是全部入口的贯通回归，不是补交前三批的正确性。`04` §1、§4 和 `00` §7 相应改写。

另加一条共同纪律：**每批都不允许留下只靠后续批次拆除的脚手架**。临时开关、临时适配层、临时双写必须在同批内有明确生命周期，不能靠"第 5 批会删"兜底。

### 17.9 两种容量失败分流（已确认）

> 更正：模式 A 的保护范围、遗漏记录及缓存结论以 §17.10 为准。本节当时的“八家都丢输入重试”“Kimi 的预收缩属于模式 B”“只有 gemini 检查缩小”均已被重新核对纠正，详见 03 §5.2；保留下面原文用于追踪讨论过程。

用户指出：**分清窗口为什么超了、采用对应策略，是关键。** 主代理查完 code-cli 下九个参考项目后确认，这确实是两种病：

| | 模式 A：摘要请求本身放不下 | 模式 B：压完之后仍放不下 |
| --- | --- | --- |
| 判据 | `完整上下文＋摘要输出额度＞窗口` | `system＋tools＋摘要＋保留段＞窗口` |
| 何时出现 | 单个巨大用户输入或工具结果一步跨过容量余量 | 小窗口下 `system＋tools` 占掉大半，压后仍无余量 |
| 手段 | 丢弃最老的 API 请求组后重试 | 向下收缩保留段 |
| 保留段有用吗 | 没用：摘要请求发的是完整上下文，保留段只是它的后缀 | 有用，是唯一杠杆 |
| 丢历史头有用吗 | 有用 | 没用：下一个普通请求的输入与摘要读过多少历史无关 |

主代理上一轮把两者混为一谈，只提了"缩保留段"，在模式 A 里是无效药，此处更正。

**模式 A**：按超出量算要丢多少组，**一次丢够**，后端内部重试，**占用已确认的两次实际请求总额度**，不另开 PTL 重试额度（用户选 A）。依据：claude-code 用 `getPromptTooLongTokenGap` 按超出量定丢弃量，一次即可，不必像它那样给 3 次。被丢弃的段摘要从未读过，**必须显式记录为"因容量限制未总结即丢弃"**，不混进已压缩——这里比 claude-code 严，它只插一条 `[earlier conversation truncated for compaction retry]`。该次必然 cache miss（缓存按前缀匹配，丢掉最老消息后只剩 `system＋tools` 共享），取舍成立的前提是它本来就发不出去：是"昂贵的摘要"对"根本没有摘要"。

**模式 B**：保留段从 20K 首选预算**向下收缩**直到装得下，仍守边界对齐规则，**摘要额度不动**，有下限（不能缩到没有原文尾段）。收缩是事后决定留多少原文，摘要请求体不变，**因此不影响缓存命中**。

九家参考：八家在摘要输入放不下时都丢输入重试，只有 opencode V2 直接放弃（`return false`）。模式 B 的收缩也不是 ohbaby 发明——Reasonix 的 `planCompaction` 重测量循环缩的就是保留段，kimi 的 `preShrinkHistoryToWindowBudget` 同理；两家保留段预算都按窗口比例，天然不会卡死。ohbaby 选固定 20K（对齐 Pi 的 `keepRecentTokens: 20000`）是为了规则简单可预期，代价就是需要模式 B 兜底。

另确认：**"占用必须下降"是硬门槛**。它兜的正是"摘要比它替换掉的旧段还大"（旧段小、保留段大时，16K 摘要可能比被折叠的历史还长）。九家里只有 gemini 显式检查这个（重算真实 token 后拒绝），ohbaby 保留该门槛但**不学 gemini 的 `hasFailedCompressionAttempt` 闩锁**，与已确认的"不增加永久失败锁"一致。

落点：[00 §3／§6](./00-discussion.md)、[02 §4.3／§5.1／§5.3／§5.4／§7](./02-optimization-plan-and-change-scope.md)、[03 §5.2](./03-reference-projects.md)、[04 E7／E8](./04-test-and-acceptance.md)、context-design/02、03。


### 17.10 问题一：模式 A 保护旧摘要，复用退场机制并记录遗漏（已确认）

用户确认：“允许模式 A 放弃部分较早原文来继续任务，但保住旧摘要和必须留下的近期内容；用现有退场机制加遗漏记录实现。”并要求逐项确认后更新文档，全部讨论完再自检和启动子代理审查；讨论中明确给出建议，保持 KISS，不作过度设计。

落实规则：

1. 只裁摘要请求的临时副本，从较老原文的完整交互组开始；保护全部活动旧摘要、受保护的新输入、未闭合依赖及必须留下的近期内容，不拆工具配对。保护的是旧摘要参与本次生成，成功后仍由新摘要接替。可裁内容耗尽仍放不下则失败，重试仍受已确认的两次实际请求总额度约束。
2. “没送进摘要”不等于“最终遗漏”。遗漏是未进入成功摘要请求、压后也未原样留下的原文；成功请求读取范围、保留范围和退场范围分别表达，不再静默扩大摘要覆盖。
3. 复用 `time.compacted` 管活动上下文退场。现有 `pruneHistory()` 未生成摘要也通过 `commitCompaction()` 写该字段，证明它不是“模型已总结”的凭证。撤回上一轮新增 `time.dropped` 的建议。遗漏的精确 part IDs 与容量原因挂在新摘要正文 TextPart 的现有 metadata，不新建表或第二套状态。
4. 摘要成功、压后请求及覆盖检查通过，才同事务保存新摘要、遗漏记录并退场精确 parts。失败、取消或提交冲突不应用裁剪；原记录留库。宿主附加简短遗漏说明并计入正文上限，完成提示也告知，不承诺尚未建设的历史召回能力。
5. 未变的 system／tools 与旧摘要前缀仍可能命中缓存，不再写“必然全部 cache miss”，按实际 usage 记录。

参考核查更正：DSH、Pi、OpenCode 新旧路径都没有内置的“摘要超窗后丢最老输入重试”；Kimi 和 Codex local 有，Codex remote-v2 需另论。Kimi 记录 `droppedCount` 并提供原日志回查位置；Codex local 从未裁剪的历史重选近期用户消息，无精确遗漏清单。DSH 同样有摘要必须变小的检查。Kimi 的 `preShrinkHistoryToWindowBudget` 属于摘要输入裁剪，不能作为模式 B 证据。详细路径与本地版本见 03 §5.2。

同步：00 §2／§3／§6，02 §1／§5.4／§6／§6.4／§9，03 §5.2，04 A5／E7，context-design/02、03。第 1 批仍先移除危险恢复分支，模式 A 的显式遗漏例外在第 4 批随原子切换落地，第 5 批贯通入口。问题二及其后的建议尚待逐项确认，本条不改变那些批次安排或预算规则。


### 17.11 问题二：失败终止与删除旧限制在第 4 批同批完成（已确认）

用户确认：将“自动压缩最终失败就结束本次运行”从 improve-5 提前到 improve-4，与删除每次运行的压缩次数上限、无收益抖动锁一起交付。不新增锁、计数器或开关。

原因：先删旧限制、后补失败终止，会留下“摘要失败后普通流程继续，下一步再次触发摘要”的空档。失败终止复用现有运行结束机制即可，不为替代旧限制另建状态系统。

- 成功提交且容量检查通过：继续任务；后续再次需要压缩时仍可正常压缩，不设成功次数总帽。
- 允许的内部重试结束后最终失败，或压后无收益：结束本次自动运行，保留会话、原历史和已完成工具结果；自动／overflow／force 不得在同一运行另开摘要额度，也不继续发送装不下的普通请求。
- 用户明确重试或继续：进入新的运行，重新判断是否需要压缩，不留下会话级永久失败标记，不重跑已完成工具。

批次调整：improve-4 同批接上失败终止、删旧次数限制与抖动锁，验证连续三次成功压缩能继续、一次最终失败后本次运行不再请求摘要或发送装不下的普通请求。improve-5 保留各入口贯通和旧代码清扫，对上述行为做完整回归，不再首次补上失败终止。

同步：00 §6，02 §7／§9／§9.1，04 C4／D1／E3／E4 及第 4 批验证说明，context-design/02、03。问题三及后续建议仍待逐项确认。

### 17.12 问题三：improve-3 取消前置 prune，失用代码同批清理（已确认）

用户确认：improve-3 接入完整摘要请求时不能继续先 prune；失去用途的代码同批清理，不留临时开关，按 SWE 原则安全清理到位。并要求核查 code-cli 参考项目是否也有工具消息裁剪，再继续讨论。

决定：

1. 第 3 批取消共用压缩入口的前置 prune 及 prune-only 返回，不复制手动专用旧分支。普通与摘要请求保留同源完整材料，已发送的旧工具正文不为摘要预先删改。模式 A 仅在摘要请求确实放不下时裁临时副本，依旧要成功后原子提交，不能混成常规 prune。
2. 失去用途的专属实现、配置／常量／再导出、事件／结果状态、SDK／CLI／Web 消费处及旧策略测试同批清理，不留临时开关或无操作壳。清理按真实引用关系判断；保留共用 `time.compacted`／`commitCompaction`、工具配对与原生依赖、旧会话读取及仍有效的失败回归，不物理删除历史或复活旧退场记录。第 5 批复核剩余机制，不补做本批应完成的清理。
3. C1 不只比较两份可能已经裁过的请求，还要覆盖原先能触发 prune 的样本，证明准备到摘要发送之间旧正文和退场标记未被提前改动；摘要失败／提交前 Stop 不留下 prune 退场。类型、契约及受影响回归检查也在本批完成。
4. 缓存措辞纠正：裁剪改变第一处差异之后的前缀，之前未变的部分仍可能命中，不等于整份请求必然无法命中。工具首次返回时的稳定分页／必要限长继续保留，不混同于后来改写已发送历史。

参考核查：并非其他项目都不裁剪。DSH 的 base bundle 默认装载 pruner，Reasonix 压力／超窗维护也先 prune，且摘要失败后已提交的裁剪仍留存。OpenCode 旧路径有默认关闭的 prune，写标记后投影占位，原正文仍存库；新 core 未接 prune 实现。Pi 和 OpenCode 的摘要序列化还有 2000 字符正文限长；Gemini 在摘要前裁工具响应；Codex remote-v2 超窗时改请求副本的工具正文。ZCode 与本地 claude-code 重建版有默认关闭／受门控的 microcompact。具体路径、触发时机与数据层区别见 03 §5.3。ohbaby 选择取消前置裁剪，依据是本轮对前缀稳定、信息保留及提交原子性的要求，不是行业统一做法；实际费用仍待实网验证。

同步：00 §2，02 §3.1／§9／§9.1／新增 §9.2，03 新增 §5.3，04 C1／E5／清扫要求，context-design/02、03。只更新规划，未改业务代码；问题四及后续预算／成功条件仍待确认。
