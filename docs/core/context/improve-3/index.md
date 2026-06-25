# context improve-3 · 术语与符号自查索引（通俗版）

> 用途：把五层（编排层 / usage 估算 / 投影层 / origin / 压缩多策略）里出现的术语、函数、对象、方法，用大白话讲清"它是干嘛的、为了什么目的、对应哪条 SWE 原则"，方便随时自查。
>
> 一条主线贯穿全部：**软件工程的本质是管理复杂度**。下面每个东西，归根结底都在回答"它怎么帮我们把上下文这摊复杂度管住"。

## 怎么读这张表

- 状态标记：🟢 **现有**（代码里已有）｜🔵 **拟新增**（improve-3 提议）｜⚪ **推迟/参考**（暂不做，或来自 kimi/gemini 的参照）。
- SWE 依据指向 `learn-swe-before-implement/references/` 的章节：00 哲学 · 01 目标 · 02 受力 · 03 原则 · 05 架构 · 06 工艺。

---

## 零、跨层地基概念（先懂这些，五层都用）

| 术语/符号 | 状态 | 大白话 | 目的（Goal/Duty） | SWE 依据 |
|---|---|---|---|---|
| **存储态 vs 推理态** | 🟢 | "存储态"=SQLite 里存的完整消息（`MessageWithParts`）；"推理态"=真正发给大模型的消息（`ChatCompletionMessage`）。两者不是一回事 | 存全量便于回溯，发子集便于省 token——存储/推理分离 | 02 信息隐藏 · 05 分层 |
| **`MessageWithParts`** | 🟢 | 一条消息 + 它的若干"零件"（文本/推理/工具调用）。是存储态的基本单位，也是五层之间传递的"工作集"类型 | 统一的领域类型，让各层用同一种货币对话 | 02 内聚 |
| **`Part` / `TextPart` / `ReasoningPart` / `ToolPart`** | 🟢 | 消息的零件：纯文本、模型思考、工具调用三种 | 把一条消息拆成可单独处理的小块（如单独修剪某个工具输出） | 02 关注点分离 |
| **`PartMetadata`（`{ tokenUsage?, [key]: unknown }`）** | 🟢 | 挂在零件上的可扩展元数据袋子。已用于标记 `kind: "context-summary"` | 提供向后兼容的扩展点，不动表结构就能加信息 | 03 OCP（对扩展开放） |
| **`time.compacted`** | 🟢 | 零件上的一个时间戳；一旦有值，就表示"这块已被压缩、不再进 active history" | 用"标记"代替"删除"，保留数据又能排除出上下文 | 00 经济视角（可逆性） |
| **`isActivePart(part)`** | 🟢 | 判断一个零件是否"还活着"（没被 compacted）。模型投影和 UI 投影都用它 | 一处定义"什么算活跃"，避免各处口径不一 | 03 DRY · 02 内聚 |
| **`ContextUsage` / `usageRatio`** | 🟢→🔵 | "现在用了多少 token、占 inputBudget 百分之几"。improve-3 后控制信号由 `decideCompactionRung` 基于 `usageRatio` 对 `thresholds.summary`(0.95) 统一决策（[G9](./gaps-and-decisions.md#g9prune-summary-阈值-085--095)）。`shouldCompress` 在 usage-估算批次退休（F3） | 把"用量判断"做成一个明确对象，供各处复用 | 01 可测 · 02 内聚 |
| **`COMPRESSION_THRESHOLD`（0.85→0.95）** | 🟢→🔵 | 触发压缩的水位线（[G9](./gaps-and-decisions.md#g9prune-summary-阈值-085--095)：原 0.85→0.95，充分利用 context window）。编排层批次只预留接缝，默认值在 usage 标定后随压缩多策略批次切换 | 单一常量定义"满了"的标准 | 03 DRY |
| **token 锚点估算（`estimateContextTokens`）** | 🟢→🔵 | 用最近一次真实 token 用量当"锚"，只加后面新增部分。**本轮改为标定式估算**（[G12](./gaps-and-decisions.md#g12锚点估算器看不见-mask--改标定式估算)）——锚点看不见 mask，改为 `heuristic(wire) × factor` | 性能 + 精度：标定式让 mask 天然可见，factor 纠偏 heuristic 偏差 | 00 性能 · 02 解耦 |
| **标定因子（factor）** | 🔵 | `factor = EMA(realPromptTokens / sentHeuristic)`，每次 API 响应更新（F5: EMA α=0.5 + 夹值 [0.5,3.0]）。`sentHeuristic` 随 `PreparedTurn` 带出（F1） | 用真实数纠偏 heuristic，吸收 char 权重/信封开销/tokenizer 差异 | 00 性能（有据优化） |
| **双投影（controlRatio / displayRatio）** | 🔵 | 同一个 `currentTokens` 两种分母：压缩控制用 `usedInput/inputBudget`，UI 显示用 `currentTokens/contextWindow`。`displayRatio <= usageRatio`（F4） | 一个估算机制、两种消费——与模型投影/UI 投影同构 | 05 分层 |
| **`decideCompactionRung`** | 🔵 | 升级版纯决策函数，返回档位 `none/mask/prune-summary/force`（取代 `decideCompactAction`，[G8](./gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)） | 一处决定升到哪一级，取代散在两层的阈值 | 03 SRP · 02 内聚 |

---

## 一、编排层（runCompaction · "永久删多少"）

> 职责：决定并执行"为腾出空间，永久修剪 + 摘要多少历史"。本轮把三个重复方法收成一条脊椎。

| 术语/符号 | 状态 | 大白话 | 目的（Goal/Duty） | SWE 依据 |
|---|---|---|---|---|
| **`prepareTurn`** | 🟢 | 每个对话步开头都调：装配上下文 → 必要时压缩 → 产出发给模型的 messages。热路径 | 一站式准备好"这一步发什么给模型" | 02 内聚 |
| **`compact`** | 🟢 | UI 手动 `/compact` 走的入口：装配 → 压缩 → 返回压缩结果 | 给用户主动压缩的能力 | 01 目标 G3 |
| **`compress`** | 🟢→🗑️ | 只关心 token 的压缩入口，**无生产调用方**（僵尸），本轮删除 | 删死代码，降复杂度 | 06 代码异味（死代码） |
| **`runCompaction`（脊椎）** | 🔵 | 把上面三者重复的"判断→prune→摘要候选→投影评估→提交/拒绝"收成的**唯一内部函数** | 一处实现、多处复用，消除三重重复 | 03 DRY（知识不重复） |
| **`CompactionRequest` / `CompactionOutcome`** | 🔵 | 喂给脊椎的输入 / 脊椎吐出的富结果（状态+用量+投影后历史+是否提交了摘要） | 用明确的输入输出契约取代散落的分支变量 | 02 抽象 · 01 可测 |
| **`decideCompactAction`** | 🟢→🔵 | 纯函数：返回 `skip / prune-only / compact`。**本轮升级为 `decideCompactionRung`**（返回 `none/mask/prune-summary/force`，[G8](./gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)） | 把"决策"从"执行"里剥出来，可单测 | 03 SRP · 01 可测 |
| **`prune` / `pruneHistory`** | 🟢 | 扫描已完成的工具输出，把超出保护窗口的旧输出标 `compacted`（**写库**、永久） | 先丢体量最大的旧工具输出腾空间 | 01 目标 G4 |
| **`generateSummaryCandidate`** | 🟢 | 叫 LLM 把一段旧历史浓缩成摘要"候选"（还没提交） | 把"生成"与"提交"分两步，便于先评估再落库 | 03 SRP |
| **`projectSummaryCandidate`** | 🟢 | 在内存里"假装"摘要已生效，算出投影后的历史，用来评估值不值得提交 | 提交前先试算，避免越压越大 | 00 可逆决策 |
| **`commitSummaryCandidate`** | 🟢 | 真正把摘要写库 + 把被摘要的零件标 `compacted` | 落库这一步单独成函数，职责清晰 | 03 SRP |
| **`evaluateProjection`（反膨胀判断）** | 🔵 | 把三处重复的"投影后反而更大就拒绝"收成一个 helper | 消除重复 + 统一 token 口径 | 03 DRY |
| **`assemble` / `assembleFromRawHistory` / `getActiveHistory`** | 🟢 | 从 memory + systemPrompt + 消息历史装配出 `AssembledContext`；`getActiveHistory` 负责滤 compacted + 摘要提前 | 统一上下文入口，屏蔽数据源差异 | 01 目标 G1 · 02 内聚 |
| **内存工作集 + commit-once** | 🔵 | 历史在内存里以投影形式流转，DB 只在两个提交点（prune 标记、摘要消息）写，读库最多在"真提交"分支回读一次 | 砍掉一个 turn 内 3–5 次冗余装配/读库 | 00 偶然复杂度 · 性能 |
| **`findCutPoint` / `getHistoryToCompress`** | 🟢 | 算"从哪刀切"：哪些进摘要、哪些保留为最近消息，且切口必须落在合法边界（不切断工具配对） | 保证压缩不破坏对话/协议结构 | 01 正确性 |
| **`CompactResult` / `CompressionResult` / `PruneResult`** | 🟢 | 各操作的结构化结果（状态 + 前后 token + 释放量等），用 discriminated union 而非 boolean | 让调用方能精确分支处理 | 06 类型表达力 |
| **`statusForUncommittedCompression`** | 🟢 | 当没真正提交摘要时，根据 prune 是否见效，算出对外该报的状态 | 把易错的状态拼装收口到一处 | 03 SRP |

---

## 二、投影层（storage → inference · "这次构建临时藏多少 + 怎么变 wire"）

> 职责：把存储态历史变成发给模型的 wire 消息。本轮收成命名链，拆"削减段 / 渲染段"，并新增可逆 mask。

| 术语/符号 | 状态 | 大白话 | 目的（Goal/Duty） | SWE 依据 |
|---|---|---|---|---|
| **投影（projection）** | 🟢概念 | "把存的东西变成发给模型的东西"这个动作的统称 | 给"发什么给模型"一个明确的名字和归口 | 05 分层 |
| **削减段 `reduceForModel`** | 🔵 | 投影的前半截：在压缩门限**之前**，对历史做可逆削减（mask）。操作 domain 类型 | 让 mask 影响 usage 测量，从而降低摘要频率 | 02 关注点分离 |
| **渲染段 `renderForModel` / `serializeForLlm`** | 🟢 | 投影的后半截：把（削减后的）历史翻译成 `ChatCompletionMessage[]`，含 summary→`<context_summary>`、assistant→tool_calls 拆分 | 终端适配，唯一碰 wire 格式的地方 | 05 边界 DTO |
| **`maskOldToolOutputs`（mask 阶段）** | 🔵 | 构建时把"老的、体量大的工具输出"换成占位符 `[Old tool result content cleared]`，**不写库、可逆** | 便宜的第一道防线：摘要前先削，省钱又保住动作痕迹 | 00 经济视角 |
| **占位符 vs 消失** | 🔵概念 | mask 留"我做过此动作"的占位（保留 call+result 配对）；prune 让整对消失 | 保住 agent 不重复已做的工作 | 01 正确性 |
| **保护窗口 / 豁免清单 / 批量阈值** | 🔵 | 最近一轮 + 尾部 ~40k 不动；`write/edit/skill/subagent` 即使在窗外也不动；可削总量不够就不削 | 只削"可重新获取且确实占地方"的输出 | 03 KISS |
| **cutoff（单调游标）** | 🔵 | mask 的 exclusive boundary：cutoff 之前可遮罩；`0` 表示无历史进入遮罩范围，只增不减，存内存不写库 | 防缓存抖动（前缀稳定，prefix cache 才命中） | 00 性能 · 02 信息隐藏 |
| **`partitionSummary` / `isSummaryMessage`** | 🟢 | 把摘要消息挑出来、提到最前；用 `metadata.kind === "context-summary"` 识别 | 摘要要排在历史最前，模型才正确理解 | 01 正确性 |
| **`projectToolMetadataForModel` / `formatToolResultContentForModel`（白名单投影）** | 🟢 | 工具结果元数据按工具类型只放白名单字段（bash 只留 exitCode、read 只留 mtimeMs…），其余不给模型 | 模型只看必要事实，不泄露内部字段；这是 2.5 的精细体现 | 02 信息隐藏 |
| **两条兄弟投影（模型投影 / UI 投影）** | 🟢澄清 | message store 有两条独立投影：`serializeForLlm`（给模型）和 `persistent-store.messageToUiMessage`（给 CLI UI），都各自滤 active part | 模型与 UI 解耦，各自决定"展示/发送什么" | 05 分层 |
| **`activeReasoningByMessageId`（reasoning 注入）** | 🟢 | 一张临时表，存当前活跃消息的思考内容；只在渲染时注入当前轮，历史 reasoning 不回传 | reasoning 不持久化进上下文，省 token | 00 经济视角 |

---

## 三、origin（来源追踪 · 推迟，仅做收口接缝）

> 职责：标记"一条消息为什么存在"。本轮判定为过早，仅做收口访问器，taxonomy 推迟。详见 [origin/README.md](./origin/README.md) ADR。

| 术语/符号 | 状态 | 大白话 | 目的（Goal/Duty） | SWE 依据 |
|---|---|---|---|---|
| **`PromptOrigin`（kimi）** | ⚪参考 | kimi 的来源枚举（user/skill/injection/background/cron/hook/retry…10 种） | 区分注入/后台等非用户消息，驱动投影与压缩决策 | —（kimi 有真实消费方） |
| **为何推迟** | ⚪结论 | ohbaby 这些消息源（注入/后台/cron/hooks）一个都没有，现在定 taxonomy 必定定错 | 不为想象中的未来买单 | 00 过早抽象 · 03 YAGNI |
| **`metadata.kind: "context-summary"`** | 🟢 | 目前唯一的 de-facto 来源标记：标识"这是摘要消息" | 已满足"区分摘要"这个唯一现实需求 | 03 KISS |
| **`getMessageOrigin(message)`（收口接缝）** | 🔵 | 一个纯派生函数，今天只返回 `user/assistant/tool/summary`，把散在 4 处的 `metadata.kind` 判断收口 | 封装"来源从哪读"，将来升级不波及消费方 | 03 DIP（依赖抽象） |
| **重启条件** | ⚪结论 | 注入/后台系统立项、或 SQLite 查询接口要按来源检索时，再与消费方共同设计 taxonomy | 与首个真实消费方共同设计，避免返工 | 00 可逆决策 |

---

## 四、压缩多策略（升级阶梯 + 护栏 · "哪个水位触发哪一级 + 别抖动"）

> 职责：把编排层、投影层的触发阈值归一成一道升级阶梯，并补两个护栏。判定为**不建插件接口**。

| 术语/符号 | 状态 | 大白话 | 目的（Goal/Duty） | SWE 依据 |
|---|---|---|---|---|
| **升级阶梯（escalation ladder）** | 🔵概念 | 一道分级防线：`0.5 mask → 0.95 prune+summary → overflow force`（[G9](./gaps-and-decisions.md#g9prune-summary-阈值-085--095)/[G10](./gaps-and-decisions.md#g10去除-095-预防性-force)） | 把"何时用哪招"显式串成一条可解释的链 | 02 内聚 |
| **`decideCompactionRung`** | 🔵 | 升级版纯决策函数，返回档位 `none/mask/prune-summary/force` | 一处决定升到哪一级，取代散在两层的阈值 | 03 SRP · 02 内聚 |
| **`CompactionThresholds`（mask / summary）** | 🔵 | 两个阈值（0.5 / 0.95）**同处定义**（[G9](./gaps-and-decisions.md#g9prune-summary-阈值-085--095)） | 单一真相，防跨层漂移 | 03 DRY |
| **反抖动锁 / `ThrashLockState`** | 🔵 | 连续几次压缩都省得太少（<10%）就锁住、不再叫 LLM，直到用量显著上升或用户重置 | 防"每步都昂贵摘要却省不了多少"的抖动 | 00 经济视角 |
| **`MAX_COMPACTION_PER_TURN`** | 🔵 | 单个 turn 内自动压缩次数封顶（默认 2） | 防一个 turn 内反复摘要 | 00 性能 |
| **`CompactionStrategy`（kimi 接口）** | ⚪参考/推迟 | kimi 把"何时压/压多少/溢出降级"做成可替换策略接口 | 多策略可插拔 | —（ohbaby 只有一种策略，套接口属过早） |
| **`minOverflowReductionRatio`（kimi）** | ⚪参考 | kimi 的反抖动比例（0.05） | 反抖动锁的参照值 | — |
| **compress 暴露给模型（2.4）定位** | ⚪结论 | 它是"多一个触发入口"（给模型一个工具调 `compact(force)`），不是策略框架需求 | 别把触发入口误当抽象需求 | 00 货物崇拜（先问解决什么问题） |

---

## 五、五层怎么咬合（一句话回顾）

```
编排层  →  "为腾空间，永久删多少"（runCompaction 脊椎）
            产出 MessageWithParts[] 工作集
usage-估算 → "用多少 token"（标定式估算，heuristic × factor）
            mask 天然可见，双投影供压缩控制 + UI 显示
投影层  →  "这次构建临时藏多少（mask）+ 怎么翻成 wire（serialize）"
            mask 在压缩门限前，影响 usage
压缩多策略 → "哪个水位触发哪一级（阶梯）+ 别抖动（护栏）"
            把上面两层的阈值归一
origin  →  旁路：只做 getMessageOrigin 收口，taxonomy 推迟
```

它们共享同一种"货币"——`MessageWithParts[]` 工作集；靠纯函数决策 + 内存态状态（cutoff / 反抖动锁 / factor）协作，不写多余的库，不建没有第二实现的抽象。**这就是用 SWE 原则把"上下文生命周期"这摊复杂度，管成一套可读、可测、可演进的分层结构。**
