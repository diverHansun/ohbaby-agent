# 参考项目与取舍

> 调查更新：2026-10-11。本地参考根目录：`/Users/hansun025/Projects/code-cli/`。
> 本文说明实现差异，不宣称这些项目存在统一最佳参数。ohbaby 的规则由[00](./00-discussion.md)和[02](./02-optimization-plan-and-change-scope.md)确定。

## 1. 参考范围

| 项目 | 主要源码位置 | 借鉴主题 |
| --- | --- | --- |
| Pi | `pi/packages/coding-agent/src/core/compaction/compaction.ts`；`pi/packages/ai/src/api/simple-options.ts` | 长用户轮内部切分、旧摘要继承、fixed thinking 输出加法 |
| Codex | `codex/codex-rs/core/src/compact.rs`、`compact_remote_v2.rs`、`session/reasoning_effort.rs` | 当前窗口 effort 稳定、手动忙时交互、活动历史替换 |
| Kimi | `kimi-code/packages/agent-core-v2/src/agent/fullCompaction/` | 完整交接内容、手动独占、请求／usage 接线 |
| ZCode | `ZCode/apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`及相邻 helpers | 历史末尾加指令、历史边界 cache 标记、独立摘要输出选项 |
| Reasonix | `DeepSeek-Reasonix/internal/agent/compact.go`、`compact_fold_input.go`、`output_budget.go` | 摘要独立额度与统一容量检查、滚动摘要 |
| deepseek-harness | `deepseek-harness/packages/compaction/compaction-basic/src/index.ts` | 忙时限制、工具配对与已有压力处理的取舍 |
| OpenCode | `opencode/packages/core/src/session/compaction.ts`；旧`packages/opencode/src/session/compaction.ts` | 旧摘要继承、长轮次切分；两套路径分别判断 |
| 本地 claude-code | `claude-code/src/services/compact/compact.ts`、`prompt.ts` | 保持缓存相关配置的分叉及摘要内容规则 |

本地 claude-code 是非官方重建项目，不能作为官方实现保证。Codex local、remote-v2 与服务端未公开逻辑也不能混称。

## 2. 请求与缓存

ZCode 在原消息后追加摘要指令，并为适用端点将 cache 标记留在指令前的历史边界。位置：`core/src/runtime/methods/compact-active-helpers.ts:80`、`core/src/runtime/helpers/provider-request-messages.ts:292`，均位于上述 ZCode packages 目录。

本地 claude-code 的 fork 路径明确避免输出 override 经底层顺便压低 thinking 而破坏缓存；短 system 兜底另有 20K 输出和关闭 thinking。位置：`src/services/compact/compact.ts:1215`、`:1345`、`:1357`。ohbaby 借前者保持配置的理由，不采用后者。

Kimi 复用 requester，但可能重新计算部分工具配置和继承输出 override。ohbaby 只借复用与 usage 接线思路，仍要以最终请求体证明共享部分没变。

Pi 拍平历史、Reasonix 部分路径只给待压段，以及 deepseek-harness 先剪枝再判断的做法，不适合本轮已确认的完整前缀与无 prune-first 方向。不能因为借了某项目的切点或预算函数，就连其请求形状一起照搬。

## 3. 摘要总输出：不存在共同的 32K 硬帽

| 实际路径 | 读到的行为 | 对 ohbaby 的取舍 |
| --- | --- | --- |
| Pi 摘要入口 | `min(floor(reserveTokens×0.8),model.maxTokens)`；默认 reserve16384，基础 13107。`compaction.ts:712`、`settings-defaults.ts:8` | 不直接照抄数字；区分基础额度和最终总额 |
| Pi Anthropic fixed | 在基础上加既有 B，再受模型与剩余窗口限制。`simple-options.ts:92`；`anthropic-messages.ts:959` | 采用“正文基础+B”；不采用`:974`不足时降低 B 的分支 |
| Pi adaptive／Responses | 保持 effort，不加虚构 B；Responses 还按兼容设置决定是否发送输出字段。`anthropic-messages.ts:948`；`openai-responses.ts:238`、`:340` | 不把 effort 档位换算成固定 token 数 |
| Reasonix | 摘要独立 8192，小共享窗口调整，admission 再核对模型／剩余容量。`compact.go:23`、`:423`；`compact_fold_input.go:15`；`output_budget.go:512` | 借用途专用额度和发送前统一检查，不照搬 8192 |
| ZCode | core 选`min(模型输出能力,20000)`；输出与 reasoning 选项各自通过模型 map 落到 JSON。`compact-active.ts:716`；`compact-summary-model-request.ts:311` | 不把 core 的 option 无条件说成所有协议最终同一字段／额度 |
| Kimi full compact | 优先 resolved.maxOutputSize，否则`min(窗口,128×1024)`；全局 maxCompletionTokens 还可能覆盖。`fullCompactionService.ts:633`；`llmRequesterService.ts:695`；`llm-adapter/model/completion-budget.ts:11` | 不照搬普通偏好继承；这不是独立固定 128K，更不是 32K |
| Codex local／remote-v2 | 调用 Responses stream，所查`ResponsesApiRequest`没有 max_output_tokens 字段。`core/src/compact.rs:779`；`core/src/compact_remote_v2.rs:391`；`codex-api/src/common.rs:279` | 只说明客户端没有显式设置；不能推断无限输出或无容量边界 |
| OpenCode 新 core | 普通 generation.maxTokens 或模型默认，再与 4096 取小。`packages/core/src/session/compaction.ts:181`、`:189` | 不照搬 4096 或普通偏好继承，也不与旧实现混称 |

Pi 默认 high 的 fixed 示例为 13107＋16384＝29491，B 更大时总额可以更大。Kimi 某些 Anthropic fixed high 映射为 32000，这是 thinking 预算，不是摘要总额，见`packages/agent-core-v2/src/human/llm/requester/bases/anthropic/profile.ts:252`。

ohbaby 最终选择：正文基础 16K；fixed 加已有 B；effort／adaptive 采用`16K 正文＋试行 thinking 预留`、合计 32K。三者都是发送时的输出上限，不是目标长度，摘要实际写多长由模型自行决定。32K 是本项目的工程选择，不带“参考项目证明最优”的含义。所有分支复用实际预算解析和模型能力检查，不人为添加跨协议 32K 硬帽。

## 4. 摘要内容与保留边界

| 参考 | 可借内容 | 边界 |
| --- | --- | --- |
| Kimi `fullCompaction/compaction-instruction.md:10` | 自足交接、旧要求、已定／未定、真实命令结果和未知项 | 不复制其日志召回／TODO 能力的承诺 |
| Codex `codex-rs/prompts/templates/compact/prompt.md:1` | 进展、决策、约束、下一步、关键引用 | 不是 remote-v2 服务端完整提示词 |
| 本地 claude-code `src/services/compact/prompt.ts:62` | 用户纠正、文件与决策、未完成任务、授权来源区别 | 不照搬长篇复述或无条件不再提问 |
| ZCode `core/src/compact/prompt.ts:14` | 全对话目标与限制、错误修复、当前工作 | 不为 ohbaby 另造九节强制校验协议 |
| Pi `compaction.ts:431`、`:880` | 长用户轮内合法切分、旧摘要更新 | 不照搬额外轮次摘要；它没有 ohbaby 的固定 20K 预算 |
| Reasonix `internal/agent/compact_incremental_test.go:65` | 连续压缩后仅一份主摘要 | 只作参考测试，不等于 ohbaby 已满足 |

保留完整调用与结果是可借的不变量，参考项目对保留哪些消息、是否允许超预算并不统一。ohbaby 采用固定 20K 预算、切点对齐合法边界、最新超大组整组保留的做法，不声称这些数字来自行业共识。

## 5. 手动行为与工具结果

Kimi、Reasonix 与 deepseek-harness 存在忙时拒绝手动 compact 的路径；Pi 手动入口会先 abort 当前任务；Codex TUI 禁止 busy compact，但 core 直接收到 Compact 可以中止旧任务；ZCode 有既有队列。ohbaby 选择忙时提示、空闲执行，不引入队列或隐式停止工具。

依据：`kimi-code/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:333`、`:538`；`DeepSeek-Reasonix/internal/control/maintenance.go:70`；`deepseek-harness/packages/compaction/compaction-basic/src/index.ts:375`；`pi/packages/coding-agent/src/core/agent-session.ts:2749`；`codex/codex-rs/tui/src/slash_command.rs:240`、`core/src/session/handlers.rs:247`。

其他项目的截断／落盘实现提供了可读引用的思路，但不要求 ohbaby 给所有工具增加一套配额。现有 ToolPart、Read 分页和子代理结果引用足以成为当前改造的基础；只修实测或源码证实的缺口。

## 5.1 压缩后的界面提示

本地 claude-code 分两条路径：

- 手动`/compact`完成（`src/commands/compact/compact.ts:241-265`的`buildDisplayText()`）：往对话流永久插入一条`Compacted`输出块，内含`(ctrl+o to see full summary)`和`Context: ~X → ~Y tokens`。渲染为带`⎿`前缀的普通命令输出（`components/messages/UserLocalCommandOutputMessage.tsx:40`）。
- 自动压缩完成：`components/messages/CompactBoundaryMessage.tsx:10`插一条暗色`✻ Conversation compacted (ctrl+o for history)`，另有摘要消息`Conversation summarized to free up context`（`components/CompactSummary.tsx:74-95`）。
- 进行中：`screens/REPL.tsx:3013`把 spinner 文案设为`Compacting conversation`，`SpinnerAnimationRow.tsx:289-328`同时画一个渐近曲线进度条（`1 - exp(-tokens/1200)`，永不到 100%）。手动和自动走同一个`onCompactProgress`，显示一致。

OpenCode：完成提示是消息流里的一个分隔框，TUI 渲染带标题的` Compaction `边框（`packages/tui/src/routes/session/index.tsx:1456-1462`），Web／App 是`Session compacted`分隔线（`packages/ui/src/i18n/en.ts:104`）。**没有进行中文字提示，也没有完成 toast**；`packages/core/src/session/compaction.ts:46`的摘要指令还明确要求模型`Do not mention the summary process or that context was compacted`。手动与自动的完成显示不区分。

占用刷新的时机：**两个参考项目压缩后都不立即重算**。claude-code 只统计 compact 边界之后的最近一条带 usage 的响应（`components/PromptInput/Notifications.tsx:71-74`、`utils/tokens.ts:67-78`），边界后没有带 usage 的消息，计数直接归零，等下一轮 API 响应回来才重新用真实 usage 计算。opencode 取最后一条`tokens`非零的 assistant 消息（`packages/app/src/components/session/session-context-metrics.ts:41-61`），而压缩产生的那条摘要 assistant 的 tokens 是 0（`packages/opencode/src/session/compaction.ts:393-418`），会被过滤掉，同样要等下一轮。原因一致：两家的占用显示都只认真实 usage，不认本地估算。

ohbaby 的差异：`UiContextWindowUsage`本来就是本地估算口径，所以可以在提交后立即刷新 footer／面板，不必等下一轮。要写明这是估算值而非真实 usage，下一轮真实响应回来后按既有路径校正。一致的部分是：都复用既有占用显示，都不为摘要用量新建界面或存储。

## 5.2 两种容量失败：参考项目怎么做

### 压完没有变小

| 项目 | 是否检查 | 做法 |
| --- | --- | --- |
| gemini-cli | 显式检查 | 压完重算一遍真实 token，`newTokenCount > originalTokenCount` → 拒绝，`newHistory: null`，状态`COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`，旧历史保留。随后设`hasFailedCompressionAttempt`**闩锁**，之后非强制压缩不再调 LLM，只做截断。`packages/core/src/context/chatCompressionService.ts:696`、`src/core/client.ts:1248` |
| kimi | 替代方案 | 不查变大，查**没进展**：`tokenCountWithPending() <= lastCompactedTokenCount` 就直接跳过不再压。`fullCompaction/fullCompactionService.ts:520` |
| claude-code | 替代方案 | **连续失败熔断**`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。注释记录生产数据：1,279 个会话出现 50+ 次连续失败（最多 3,272 次），浪费约 25 万次 API 调用／天。`src/services/compact/autoCompact.ts:118` |
| codex | 否 | `active_context_tokens_before`／`compaction_summary_tokens` 只进**分析埋点**，不是闸门。`core/src/compact.rs:435` |
| deepseek-harness | 显式检查 | 包装后的摘要估算 token 若不小于被替换区间，直接失败；`packages/compaction/compaction-basic/src/region.ts:417-422`。 |
| pi、ZCode、opencode、Reasonix | 本次未新增核对 | 不据此宣称其他项目都没有收益检查。 |

DSH 也有基于估算的缩小检查，撤回“只有 gemini 检查”的说法；gemini 的上述路径使用真实 token 计数。ohbaby 保留“占用必须下降”作为提交门槛，但不采用 gemini 的闩锁：已确认不增加永久失败锁，压不下即失败、保留原历史，下次该触发照常触发。

### 摘要请求本身放不下（2026-10-11 重新核对）

本轮核对本地 DSH `5badb15009`、OpenCode `388406238b`、Kimi `5b9366976`、Codex `03b761dca9`、Pi `6fb2e78151`。以下区分摘要请求超窗与普通请求超窗，不把第三方扩展可能提供的恢复当成内置行为。

| 项目 | 摘要请求超窗 | 退场、留档与旧摘要 |
| --- | --- | --- |
| DSH | 没有内置的文本超窗删头重试。摘要错误交给恢复钩子，仓库内监听者只处理图片落盘，未处理则抛错。`compaction-basic/src/region.ts:397-409`、`compaction-image-offload/src/index.ts:33-40`（均在 `packages/compaction/` 下） | 成功后用摘要替换选中区间，记录 `shadowedSeqs`，原事件留档。区间内旧摘要参与合并。没有“模式 A 未读段”专用状态。`region.ts:491-509`、`compaction-basic/src/summarizer.ts:66`。此前已落地的工具 prune 是另一机制，不能视作摘要失败时也会回滚。 |
| OpenCode 旧路径 | 摘要超窗写入错误并返回 `stop`，不删头重试。`packages/opencode/src/session/compaction.ts:450-459` | 普通请求超窗时，可能先排除最新用户轮，成功后重放（`:340-356`、`:468-495`）；这不是放弃最老历史。旧摘要单独传入，成功边界才使旧原文退出活动上下文，原记录保留。 |
| OpenCode 新 core | 摘要输入估算放不下就 `return false`；provider 错误同样放弃本次压缩。`packages/core/src/session/compaction.ts:178-231` | 最新旧摘要参与容量检查，不为腾空间删掉它。只有成功的 compaction 行推进活动历史边界。主动路径返回 false 后仍可能发送原普通请求，不能把它表述为所有入口都立即结束运行。 |
| Kimi | `historyForModel` 副本先按预算取较近历史，超窗后再缩小重试；`preShrinkHistoryToWindowBudget` 位于 `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:818`，重试在 `:694-713`。 | `droppedCount` 记录摘要输入裁剪条数，无精确遗漏 IDs 或逐 part 状态；成功后重建活动上下文，原事件留在日志，并附回查路径与窗口行号（`:756-775`、`context-recovery-footer.md`）。旧摘要没有不可裁保护。压后用户消息的省略提示与摘要输入的 `droppedCount` 是两个口径。 |
| Codex local | 克隆历史，超窗后 `remove_first_item()` 并处理工具配对，再试。`codex-rs/core/src/compact.rs:338-350` | 成功后从未裁剪的实时历史重新选近期用户消息（`:370-386`），所以未进摘要不等于最终遗漏。无精确遗漏 IDs／条数；有日志、统一提示及 rollout 留档。旧摘要无不可裁保护。失败时不替换原历史，但部分输出可能已追加，不能声称所有状态完全不动。 |
| Codex remote-v2 | 客户端没有 local 的删头循环；有请求副本上的工具输出裁剪、模型回退及流重试。`codex-rs/core/src/compact_remote_history.rs:68-124`、`compact_remote_v2.rs:246-283` | 服务端如何生成不透明压缩结果，本地代码不可见，不能由 local 路径推断。 |
| Pi | 摘要失败直接抛错，没有内置的缩小待摘要区间重试。`packages/coding-agent/src/core/compaction/compaction.ts:728-761` | 旧摘要单独放入 `<previous-summary>`；成功才追加压缩记录，以保留边界重建上下文，原 entry 留档。普通超窗恢复可能事先省略最新失败尝试，这是独立动作，不是丢最老摘要输入。 |

撤回“八家丢输入重试，只有 OpenCode 新版放弃”的结论。Kimi 和 Codex local 明确接受减少摘要输入来恢复，DSH、Pi、OpenCode 没有相同的内置恢复。ohbaby 采用模式 A 是为了给长任务一次继续机会，是本项目对信息损失与可用性的取舍，不是行业统一规则。

### 模式 B 与模式 A 的区别

此前将 Kimi 的 `preShrinkHistoryToWindowBudget` 用作模式 B 的依据是错误的：它裁剪的是**发给摘要模型的输入副本**，属于模式 A。Reasonix 的 `planCompaction` 保留段重测量思路可参考，但不能由比例预算推出“小窗口天然不会卡死”。固定开销和不可拆组仍可能使请求无法发送。

### ohbaby 的采用方式与缓存代价

问题一已确认：模式 A 只裁请求副本中较老的完整原文组，保护全部活动旧摘要、受保护输入和必须留下的近期内容。成功且压后检查通过才原子切换；未进入成功摘要请求、压后也未原样保留的精确 part IDs 与容量原因，挂在新摘要正文 part 的现有 metadata。沿用 `time.compacted` 管退场，不新增 `time.dropped` 或表。原记录留库，宿主说明和完成提示体现遗漏，不承诺本轮建设召回能力。

从裁剪位置起，原来的对话前缀不再相同；此前未变的 system／tools、旧摘要仍可能命中缓存，结果以接口规则和真实 usage 为准。不能把“保住近期消息”解释成“删头后仍保住近期消息的前缀缓存”，也不能宣称整份请求必然 miss。

## 5.3 工具结果裁剪：发生在哪一步

2026-10-11 针对问题三重新核对。不能概括为“参考项目都不 prune”，也不能把以下三类行为混为一谈：工具首次返回时分页／限长；已经发送过的旧结果随压力变短；仅在摘要请求副本里截断正文。第一类若后续表示稳定，不会仅因首次限长就反复破坏缓存；后两类会改变相应请求的旧前缀。

| 项目与路径 | 实际行为与默认状态 | 源码依据 |
| --- | --- | --- |
| DSH | 有旧工具正文 prune。虽然是插件，base bundle 默认装载；压力／超窗触发维护时先裁长结果的中段，再决定是否摘要。修改持久模型投影，摘要失败后已提交的 prune 仍在；只改 result 正文，保留调用配对。 | `packages/bundle/base/cordis.patch.yml:418-423`；`packages/compaction/compaction-basic/src/index.ts:207-218`、`:294-326`；`compaction-tool-result-pruner/src/index.ts:158-170`（同一 compaction 目录） |
| Reasonix | 压力和超窗路径默认先 prune，无独立启停开关；工具正文超过 8192 字符量级时保留头尾，安装持久投影，原始 canonical 数据不改。摘要失败仍使用已经提交的裁剪投影。 | `internal/agent/context_manager.go:159-188`、`:315-322`；`internal/agent/prune.go:19-36`、`:65-104`；本地 `eca6834da` |
| OpenCode 旧路径 | prune 存在但默认关闭，主循环退出后才执行。给旧 tool part 写持久 `time.compacted`，模型投影显示占位符，数据库中的正文仍保留。摘要序列化另外将每条工具正文限至 2000 字符。 | `packages/opencode/src/session/compaction.ts:274-275`、`:308-315`、`:30-52`；`prompt.ts:1338`；`message-v2.ts:303-304`（同一 session 目录） |
| OpenCode 新 core | 有 prune 配置字段但未接实现；摘要序列化仍有每条 2000 字符限制。工具完成时的限长与落盘属于另一条路径。 | `packages/core/src/config/compaction.ts:12`；`src/session/compaction.ts:14`、`:85-86`；`src/tool/registry.ts:75`、`src/tool-output-store.ts:119-159`（后几项均在 core 下） |
| Pi | 未发现内置的压力驱动旧工具正文 prune；摘要序列化固定每条最多 2000 字符，只改摘要输入。工具首次返回的 2000 行／50KB 限长是另一件事。 | `packages/coding-agent/src/core/compaction/utils.ts:93-104`、`:149`；`src/core/tools/truncate.ts:1-11`（同一 coding-agent 包） |
| Gemini CLI | 传统压缩路径在切分摘要段之前，先按工具响应总预算缩短旧正文；不属于 OpenCode 那种持久标记投影。工具执行期也有独立限长；新的 contextManagement 蒸馏管线默认关闭，不能混称。 | `packages/core/src/context/chatCompressionService.ts:364-465`、`:521-526`；`src/config/config.ts:1207-1208`；本地 `2ce1a69` |
| Codex | local 超窗恢复裁完整历史项；remote-v2 另有工具正文替换：请求副本仍超窗时把可裁工具输出换成固定提示，保留 call ID。不能由 local 推断 remote，也不能据此声称所有请求都裁正文。 | `codex-rs/core/src/compact.rs:338-350`；`compact_remote_history.rs:68-124`、`:126-186`；`compact_remote_v2_attempt.rs:58-63`（后两项同属 core/src） |
| Kimi | 本次核对的 fullCompaction 恢复按完整消息缩小请求副本；未见这条链路中的旧工具正文 prune。这个结论不表示所有工具首次返回都无限长。 | `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:918-963` |
| ZCode／本地 claude-code 重建版 | 都有 microcompact，把旧工具正文变成占位符，当前配置默认关闭或受功能门控。ZCode 写回活动历史；重建版的本地路径改请求视图。不能据此声称官方 Claude Code 的默认行为。 | `ZCode/apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts:73-88`、`:105-111`；`claude-code/src/services/compact/timeBasedMCConfig.ts:34-38`、`microCompact.ts:444-525` |

ohbaby 选择取消前置 prune，是为了保持已发送工具正文稳定、尽量复用已有前缀，并避免摘要失败时留下先前裁剪已提交的半成品；不是因为参考项目都不裁剪。其他实现优先减少输入量，有各自的适用场景，未做同模型实网对照前不宣称哪种必然更省钱。保留工具首次返回时已有分页／必要限长，真正超窗走已确认的模式 A／B。

## 6. 调查与审查边界

本地源码调查和子代理交叉检查提供上述事实。Fable-5.1 medium 已复核关键设计，但其直接读取范围主要是 ohbaby，相邻仓库结论来自主代理提供的证据；不能把它的意见当作独立核实全部项目。

不采用参考代码中降低 thinking、固定次数成功帽、工具批次均分、为了字段统一而更换请求形状的行为。摘要输入在模式 A 下会按 §5.2 丢弃历史头重试，但**真正遗漏的原文必须有精确记录**；不允许缩小输入后仍把原范围静默当成摘要覆盖。真实缓存收益和摘要保真仍待阶段实网验收。
