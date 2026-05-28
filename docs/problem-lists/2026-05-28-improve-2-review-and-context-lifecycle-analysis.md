# improve-2 暂存区文档审阅 & context/lifecycle 模块分析

> 分析日期：2026-05-28
> 分支：mvp
> 对象：暂存区新增的三个文档 + `core/context/` 模块 + `core/lifecycle/` 模块实现
> 框架：learn-swe-before-implement 审阅模式

---

## 零、核心判断：文档描述的内容是待实施还是已实施？

**结论：三个文档描述的内容全部处于"待实施"状态。**

暂存区新增文件及其实施状态：

| 文件 | 性质 | 描述内容 | 实施状态 |
|------|------|----------|----------|
| `docs/core/context/improve-2/problem-analysis.md` | 问题分析 | 11 个工程深度缺口 (PC-14 ~ PC-24) | **均未实施**。经代码扫描确认，Per-step 压缩、事件溯源、Origin 追踪、注入系统、溢出恢复、动态 budget、后台通知、跨压缩文件追踪、跨会话摘要复用、hooks、undo safety 全部不存在于当前代码中 |
| `docs/core/context/improve-2/README.md` | 总览文档 | improve-2 范围声明、协作面、参考材料 | **文档本身已编写完成**，引用的 `implementation-plan.md` 和 `acceptance.md` 尚未创建 |
| `docs/core/lifecycle/improve-2/README.md` | 总览文档 | 跨模块执行总览，RunWorker/primary 统一化 | **文档本身已编写完成**（标记为"前瞻性草案"），引用的三份 module plan 均未创建 |

每项缺口与代码的对照证据详见下文。

---

## 一、学习启发

### 1.1 对本项目有直接指导意义的原则

**依赖方向规则**（来自 references/05 架构模式 + 02 基础受力）

- 本项目对应场景：`agents/service.ts` -> `core/agents/runner.ts` -> `core/lifecycle/lifecycle.ts` -> `core/context/context-manager.ts` 已形成清晰的依赖链，外向内
- 启发：当前架构方向正确。improve-2 文档中跨模块协作表（context README 第 93-102 行）显示的依赖关系遵循了"稳定抽象在内，易变细节在外"
- 优先级：高

**DRY 的真义是"知识不重复"，不是"代码不重复"**（来自 references/03 DRY + 护栏）

- 本项目对应场景：`decideCompactAction`（`context-manager.ts:95`）和 `getContextUsage`（`:55`）各自独立判断是否压缩——这两个是不同的知识（"当前应该压缩吗" vs "当前用量是多少"），分开合理
- 启发：improve-2 文档将"Per-step 压缩"（PC-17）与"溢出自动恢复"（PC-18）拆为独立问题，而非试图用一个"智能压缩器"解决所有问题，是正确的 DRY 实践
- 优先级：高

**KISS/YAGNI：不要在还不了解全貌时过早抽象**（来自 references/03 护栏）

- 本项目对应场景：当前 `serializeForLlm` 的组装流程是硬编码的线性流程（`serializer.ts:45-65`），improve-2 文档将其列为 PC-16（注入系统缺失，P2），而不是 P0——说明团队有意识地推迟了抽象
- 启发：注入系统确实值得做（P2），但当前阶段不强求引入完整 middleware pipeline 是正确的
- 优先级：中

### 1.2 SWE 指南中的反例恰好是项目正在犯的错误

**"错误的抽象比重复的代码代价更高"**（references/03 护栏）

- 项目对应位置：`lifecycle.ts` 中的 `run()`（message mode）和 `runSession()`（session mode）是两个独立方法，有大量重复逻辑（tool loop、事件生成、错误处理），但它们分别服务于不同的执行场景（RunWorker vs AgentService）
- 为什么是问题：如果改善文档（lifecycle improve-2 README）建议让 RunWorker 切到 `runSession`，那么 `run()` 会变成纯 legacy——此时两份实现不再是两个独立知识，而是"一个知识两个实现"，违反了 DRY
- 建议：improve-2 交付后应删除旧的 `run()` 入口，避免双路径并存

**货物崇拜——"因为某项目用了 X 所以我也要用 X"**（references/00 认知陷阱）

- 项目对应位置：改善文档（problem-analysis.md 第四章）详细列举了 kimi-code 的架构亮点（Record/Replay、Origin 追踪、注入系统、Background Task 等）——这是优秀的对比分析，不是盲目照搬
- 但有一个值得警惕的点：PC-14（事件溯源 P1）的动机写的是"因为 kimi-code 有 wire.jsonl"，但 ohbaby-agent 当前是单进程同步架构，崩溃恢复的场景不同——事件溯源在这个项目中的真实收益需要更审慎地评估
- 建议：不是说不要做，而是提醒评估标准应聚焦**本项目实际场景**（如：Worker 崩溃后 session 状态丢失是否真的是当前用户的真实痛点？），而非对标竞品

### 1.3 有意识的合理权衡

**违背 DIP 但理由充分**

- 上下文：`ContextManager` 直接依赖 `MessageManager`（`context-manager.ts` 第 287 行注入），而非通过接口抽象。`MessageManager` 定义在 `core/message/types.ts:195`
- 说明了什么：项目处于 MVP 阶段，消息持久化层只有 SQLite 一个实现，引入 `MessageRepository` 接口会制造不必要的间接层
- 需要注意：当需要切换持久化后端或多实现并存时，这个耦合会变成架构级障碍。建议在 improve-3 或 memory improve-1 时评估是否需要接口隔离

---

## 二、项目健康度分层评估

### 2.1 哲学/价值观层 -- 复杂度管理意识、代码为人而写的程度

- 做得好：improve-1/improve-2 分轮迭代文档体系展示了显式的复杂度管理——每次只解决一个维度的核心矛盾，不试图一步到位
- 做得好：`problem-analysis.md` 中"根因归纳"（RC-1~RC-4）从现象归纳根因，再映射优化目标——这是"对抗复杂度"的标准思维框架
- 做得不好：`coding_guide.md` 被删除（git diff 显示 -41 行），但代码库中未见替代的编码规范文档
- 评价：4/5（5=非常健康，1=问题严重，下同）

### 2.2 设计目标层 -- 质量属性是否明确、优先级是否清晰

- 做得好：improve-2 文档明确声明"零 API 破坏"（S1~S8 全部保留），说明团队在"可演进性"与"稳定性"之间做了有意识的优先级排序
- 做得好：`ContextManagerOptions` 中 `compressionThreshold`、`pruneProtectTokens` 等参数全部可配置，但不暴露内部实现细节
- 做得不好：缺少对"可测试性"作为一等质量属性的显式声明。`context-manager.ts` 中大量内部函数（如 `pruneHistory`、`summarizeHistory`）未独立导出，只能通过 `compact`/`prepareTurn` 间接测试
- 评价：3/5

### 2.3 基础受力层 -- 耦合度、内聚度、抽象一致性

- 做得好：`context-manager.ts` 的内聚度很高——所有方法围绕"管理 LLM 上下文生命周期"这一件事。文件 824 行但职责清晰
- 做得好：通过 Bus 事件解耦了 context 模块与 UI 的依赖（`events.ts` 定义了 4 个 Zod-typed 事件）
- 做得不好：`serializer.ts` 与 `context-manager.ts` 之间存在隐式耦合——`prepareTurn` 先组装上下文，再调用 `serializeForLlm`，但 `serializeForLlm` 又自己调用 `loadMemoryForPrompt` 进行安全扫描，流程分叉在两个文件中，阅读心智负担重
- 做得不好：`RunWorker.createLifecycleLoop()`（`worker.ts:211`）直接判断 `this.context.messages` 是否存在来选择 `run()` vs `runSession()`——这是控制耦合的典型表现（调用方靠数据是否存在而非显式意图来决定行为）
- 评价：3/5

### 2.4 设计原则层 -- SOLID/DRY/KISS/YAGNI 遵循度

- 做得好：SRP 在模块级别体现好——`file-ops.ts`、`filters.ts`、`summary.ts`、`token-estimation.ts` 各管一件事
- 做得好：`CompressionResult.status` 使用 discriminated union（`"compressed" | "skipped" | "failed" | "inflated"`）而非 boolean，调用方可以精确定义行为
- 做得不好：`run()` 和 `runSession()` 中 tool loop 逻辑几乎完全重复（`lifecycle.ts` 第 362-485 行 vs 621-744 行）——这是 DRY 违反，且两个方法的不同点（是否调用 `prepareTurn`、是否 yield `turn:start/turn:end`）完全可以在一个统一方法中用参数或策略模式控制
- 做得不好：`ContextManager` 接口（`types.ts:133-149`）定义了 7 个方法，但实际调用方各自只用其中 2-3 个——有接口隔离原则轻微违反的趋势，但当前规模不算严重
- 评价：3/5

### 2.5 架构模式层 -- 架构选择与问题域匹配度

- 做得好：整体架构遵循"业务内核 + 外围适配器"的依赖内向原则：`core/context`（稳定内核）、`services/llm-model`（外围适配器）
- 做得好：`ContextManagerOptions` 注入所有依赖（messageManager、memory、tokenCounter、llmClient、bus）而非自己创建——这是依赖注入的正确实践
- 做得好：`core/agents/` 作为"执行基础"被 `agents/` 作为"服务层"消费的架构分层，清晰且符合 SDP
- 做得不好：缺少明确的分层声明文档。`core/context`、`core/lifecycle`、`core/agents`、`services/` 之间的边界虽然在代码中体现，但没有 `architecture.md` 等文档来显式说明"什么可以依赖什么"
- 评价：4/5

### 2.6 代码工艺层 -- 命名、函数设计、注释、错误处理

- 做得好：命名风格一致性强——`createContextManager`、`serializeForLlm`、`decideCompactAction`——动词+名词的可预测模式
- 做得好：类型系统健全，`ContextUsage`、`CompressionResult`、`PruneResult` 等都有完整的字段和语义清晰度
- 做得不好：`summarizeHistory`（`context-manager.ts:418-516`）接近 100 行，包含 LLM 调用、结果处理、文件操作附加、part 标记、事件发布等 5 个不同的职责层——虽然它们都在"压缩"这个大主题下，但抽取 2-3 个内部函数会显著提高可读性
- 做得不好：`runSession`（`lifecycle.ts:497-803`）306 行，包含了 prepareTurn、tool loop、事件生成、错误处理、shouldStopAfterTurn 等至少 4 个关注点
- 评价：3/5

### 2.7 工程实践层 -- 测试、评审、CI、版本管理

- 做得好：存在单元测试文件——`context/manager.unit.test.ts`（1137 行）、`lifecycle/lifecycle.unit.test.ts`（1230 行）
- 做得不好：无法确认测试覆盖率数据，improve-2 文档中也未提及测试验收标准（acceptance.md 尚未创建）
- 做得不好：`coding_guide.md` 已被删除，团队编码规范可能已失传
- 评价：2/5

### 2.8 语言惯用法层 -- 是否顺着语言纹理写、是否混用不同风格的惯用法

- 做得好：大量使用 discriminated unions（`CompressionStatus`、`CompactStatus`、`LifecycleEvent`）
- 做得好：函数式工厂模式（`createContextManager`）而非 class——符合 TypeScript 生态中"组合优于继承"的惯用法
- 做得好：async generator（`run()`、`runSession()`）——优雅的流式事件模型
- 做得不好：`runAgent` 中 `waitMode === "stream"` 分支使用 `.finally()` 做异步清理（`runner.ts:196`），这在 TypeScript 中是反模式——promise chain 的错误处理链会变得难以追踪，应该用显式的 `try/finally`
- 评价：4/5

---

## 三、风险与债务地图

### 3.1 风险地图

| 问题简述 | 严重性 | 可优化性 | 位置 | SWE依据 | 建议 |
|----------|--------|----------|------|---------|------|
| `prepareTurn` 每 session 只调用一次，长 tool 链可能溢出 | 架构级 | 战略投资 | `lifecycle.ts:533` | 02 协议正确性 | 即 PC-17，per-step 触发二次 prepareTurn |
| 无溢出自动恢复，用户直接面对 API 错误 | 架构级 | 战略投资 | `lifecycle.ts:836` | 07 弹性 | 即 PC-18，捕获+压缩+重试 |
| `run()` 与 `runSession()` 大量重复逻辑 | 设计级 | 低垂果实 | `lifecycle.ts:362/621` | 03 DRY | 统一为一个方法，用参数区分模式 |
| 无消息 Origin 追踪 | 设计级 | 低垂果实 | `message/types.ts:137` | 02 可观测性 | 新增 `origin` 字段，成本极低 |
| 文件操作不跨压缩累积 | 设计级 | 低垂果实 | `file-ops.ts:18` | 03 关键状态保留 | 改进 `CompressionResult` 继承前序状态 |
| `serializer.ts` 与 `context-manager.ts` 流程分叉 | 代码级 | 锦上添花 | `serializer.ts:45` | 02 内聚 | 将序列化逻辑与 assembly 合并或在 contract 中显式声明 |
| `RunWorker.createLifecycleLoop` 的控制耦合 | 代码级 | 锦上添花 | `worker.ts:211` | 02 控制耦合 | 用显式的 `mode` 参数替代隐式判断 |
| `summarizeHistory` 函数过长（98行） | 代码级 | 锦上添花 | `context-manager.ts:418` | 06 函数设计 | 拆分 LLM 调用、结果处理、事件发布 |
| `runAgent` 中 `finally()` 的异步清理 | 代码级 | 低垂果实 | `runner.ts:196` | 08 惯用法 | 改用显式 try/finally |
| coding_guide.md 被删除无替代 | 风格级 | 锦上添花 | 根目录 | 07 工程实践 | 后续补充编码规范 |

### 3.2 关键发现

- 最值得马上修的是：`run()` 与 `runSession()` 的 DRY 违反——因为 improve-2 必然要改动生命周期循环（加入 per-step 压缩），在改动前先统一两个方法的代码路径，会大幅降低 improve-2 的 bug 引入风险
- 最大的定时炸弹是：Per-step 压缩缺失（PC-17）——当前代码假设"单轮 tool 调用量必然在 context window 内"，这在大量文件操作场景下不成立，一旦触发会导致 LLM API 错误直接暴露给用户
- 技术债最密集的区域是：`lifecycle.ts`——单文件 1059 行，两个高度重复的方法，缺少错误恢复层，per-step 压缩挂载点缺失

---

## 四、行动建议

### 4.1 低垂果实（本轮即可完成）

**1. 统一 `run()` 和 `runSession()` 的 tool loop**

- 当前问题：两个方法中 tool 调用循环（约 120 行 x 2）几乎完全重复
- 具体做法：抽取私有方法 `runToolLoop(step, conversationMessages, params)`，两个公共方法各自注入差异化逻辑（prepareTurn vs 直接使用 messages，turn:start/turn:end 事件）
- 预计工作量：4-6 人时
- 预期收益：为 improve-2 的 per-step 压缩改造扫清障碍，减少约 120 行重复代码
- 注意事项：确保 `run()` 的现有行为（不 emit turn:start/turn:end）完全保留，不要引入回归

**2. 为消息类型预留 `origin` 字段**

- 当前问题：消息无来源追踪（PC-15），当前只需扩展类型
- 具体做法：在 `PartMetadata`（`message/types.ts:81`，已有 `[key: string]: unknown`）中开始写入 `origin` 字段，先定义类型常量，不改变运行时逻辑；后续逐步在压缩决策和 UI 中消费
- 预计工作量：2-3 人时
- 预期收益：为 P1 目标 G3 铺路，类型层面的改动零运行时风险
- 注意事项：使用 `PartMetadata` 的 `[key: string]: unknown` 而非修改 `Message` 核心类型，保持向后兼容

**3. 修复 `runAgent` 中的 `.finally()` 反模式**

- 当前问题：`runner.ts:196` 使用 `finally()` 做异步清理，TypeScript 反模式
- 具体做法：用 `try { ... } finally { await cleanupSessionEnvironment(...) }` 替换
- 预计工作量：0.5 人时
- 预期收益：消除隐式错误吞并风险

### 4.2 战略投资（排入下轮迭代）

**1. Per-step 压缩 + 溢出自动恢复（PC-17 + PC-18）**

- 当前问题：`runSession` 只在第一步调用一次 `prepareTurn`，之后 `conversationMessages` 持续追加 tool 消息但不再压缩
- 具体做法：在 tool loop 的每次迭代前，动态检查 context usage；若超过阈值，重新调用 `prepareTurn`（可选 force:true）；溢出错误捕获后自动触发压缩+重试
- 预计工作量：2-3 人天
- 预期收益：解决改善文档中标记的 P0 问题，使长 tool 链场景不再溢出
- 注意事项：需要与 lifecycle improve-2（RunWorker 切到 runSession）协调；per-step 压缩实现后必须回归测试以下场景：空 tool 循环（不触发）、少量 tool 调用（不触发）、大量 tool 调用（触发）、单轮内多次触发（极限压力）

**2. 事件溯源基础（PC-14）**

- 当前问题：context 非 message 状态（compaction 决策、memory 快照、系统 prompt 变更）无持久化记录
- 具体做法：参考改善文档中的建议，定义 context 状态变更事件类型，在关键变更点记录到 jsonl
- 预计工作量：3-5 人天
- 预期收益：支持崩溃恢复、可审计性
- 注意事项：审慎评估——当前单进程同步架构是否真的需要完整的 CRDT 级事件溯源？可以从最小可行集（只记录 compaction 事件）开始，不急于对标 kimi-code 的完整 `AgentRecords`

### 4.3 锦上添花（有空再做）

1. 清理 `serializer.ts` 与 `context-manager.ts` 的流程分叉——将序列化逻辑与 assembly 明确分界
2. 拆分 `summarizeHistory` 长函数——抽取 LLM 调用、结果处理、事件发布等子函数
3. 补充缺失的 `implementation-plan.md` 和 `acceptance.md`（context improve-2 和 lifecycle improve-2 各模块）
4. 修复 `RunWorker.createLifecycleLoop` 的控制耦合——用显式的 `mode` 参数替代对 `this.context.messages` 的隐式判断

### 4.4 暂缓项（当前不值得做，但记录在案）

- PC-22（压缩摘要跨会话复用）：需要 memory 模块扩展，当前阶段收益不明确
- PC-23（Hooks 系统）：当前 Bus 事件已覆盖可观测性需求，hooks 在没有真实消费方时是过度设计
- PC-24（Undo safety）：当前同步架构不触发并发问题，等异步压缩立项时再补充

---

## 五、注意事项与反教条警告

### 5.1 本项目特有的陷阱

- **不要在 per-step 压缩中引入过度的"智能决策"**——当前 `decideCompactAction`（`context-manager.ts:95`）的判断逻辑（usage ratio + history length）已经足够好，不要因为 PC-17 就加一堆启发式规则（如"连续 3 个 tool 调用后自动压缩"）。保持简单：每步查 usage -> 超阈值就 prepareTurn -> 就这么简单
- **不要为了"对标 kimi-code"而照搬 Record/Replay 的完整实现**——ohbaby-agent 的 SQLite 持久化 + Bus 事件已经覆盖了核心的状态恢复需求。从最小可行的事件记录（只记录 compaction/memory 变更）开始，再根据真实需求迭代
- **不要在 RunWorker 切到 `runSession` 之前删除旧的 `run()` 方法**——虽然 improve-2 的目标包括删除旧入口，但在验收完成前保留是合理的安全网

### 5.2 哪些 SWE 原则不适合（或需要打折执行）本项目

- **DIP 在 ContextManager 中可暂缓**：当前 `ContextManager` 直接依赖具体 `MessageManager` 而非接口。原因：消息持久化层只有一个实现（SQLite），引入 `MessageRepository` 接口在当前阶段属于"为想象中的未来买单"。等到项目确实需要切换持久化后端时再抽象
- **"函数不能超过 N 行"不应机械套用**：`runSession` 306 行、`summarizeHistory` 98 行都是"长但内聚"的函数。它们的问题不是"行数太多"，而是"嵌套了太多不同的职责层"。重构目标是职责分离，不是机械切分
- **测试覆盖率不应在此阶段追求 80%+**：项目是成长中的产品，核心逻辑有单元测试（1137 + 1230 行），这已经足够。improve-2 带来的新功能（per-step 压缩、溢出恢复）应该测试，但不应因为"context-manager.ts 中 pruneHistory 没有独立测试"就卡住发布

### 5.3 给后续开发的护栏建议

- 新增 context 模块的公共 API 必须先更新 `types.ts` 中的 `ContextManager` interface——保持接口驱动的开发节奏
- 修改 `prepareTurn` 的行为必须同步更新 `Lifecycle.runSession` 中的调用点——这两个模块通过"契约"而非"框架"协作，容易因口头约定而出错
- 改进 `ContextUsage` 或 `CompressionResult` 类型时，先检查 `events.ts` 中的 Zod schema 是否需要同步更新——类型不一致会导致运行时事件校验失败但不报编译错误
- Per-step 压缩实现后必须回归测试以下场景：空 tool 循环（不触发压缩）、少量 tool 调用（不触发压缩）、大量 tool 调用（触发压缩）、单轮内多次触发压缩（极限压力）
- 不要在实现 `runAgent` 的 `waitMode: "stream"` 分支时引入新的后台线程——保持单进程同步架构，等 improve-3 再评估异步压缩/异步通知的架构影响

---

## 六、文档交叉验证：改善文档中的一处事实偏差

**问题位置**：`docs/core/lifecycle/improve-2/README.md` 第一节

**文档宣称**：

> "primary 路径未切换；兼容 shim 未删除"

**实际代码状态**：

`AgentService.startSession()` 已在 `service.ts:87` 使用 `runAgent(waitMode: "stream")`。即 primary agent 的 session 启动路径**已经**切换到 `runAgent`。

**更准确的表述应为**：

RunWorker 仍直接调用 `lifecycle.run()`/`lifecycle.runSession()`（`worker.ts:211-213`），而非通过 `runAgent`。这是 runtime 层的执行路径，不是 agent 层。`improve-2` 的核心任务应是让 RunWorker 也走到统一的执行路径上，但需要明确区分"agent 层的 primary 路径"（已切换）和"runtime 层的 RunWorker 路径"（未切换）。

**建议**：更新 lifecycle improve-2 README 中的表述，明确两个维度的切换状态。

---

## 七、改善文档总体评价

| 文档 | 评价 | 问题 |
|------|------|------|
| `context/improve-2/problem-analysis.md` | 优秀。问题识别准确、证据充分（具体到文件+行号）、优先级矩阵合理、根因归纳有层次。这是工程分析文档的范本。 | 无实质问题 |
| `context/improve-2/README.md` | 良好。清晰说明了 improve-2 的定位（"不质疑架构方向，只是最后一公里工程"）、跨模块协作面、范围声明。 | 引用的 `implementation-plan.md` 和 `acceptance.md` 尚未创建 |
| `lifecycle/improve-2/README.md` | 中等偏上。跨度大（三个模块的跨模块执行总览），前瞻性草案定位合理。 | 存在上述事实偏差（primary 切换状态描述不准确） |

**未来开发方向的合理性判断**：合理。improve-2 聚焦的三个方向——per-step 压缩（P0）、事件溯源/Origin 追踪（P1）、注入系统/动态 budget（P2）——形成了从"生产可用性"到"调试可观测性"到"扩展性"的合理递进。优先级矩阵（P0->P3）经得起推敲。

**一个架构边界修正建议**：改善文档将"RunWorker 切到 runSession"列为 lifecycle improve-2 的核心任务，但 RunWorker 调用 lifecycle 是 runtime 层的设计决策，不应由 lifecycle improve-2 来驱动。这个任务更适合归入 agents improve-2 或单独的 runtime 改造计划。建议重新划定模块边界。

---

## 附录：代码实施状态逐项对照表

### context 模块 (packages/ohbaby-agent/src/core/context/)

| 功能 | 状态 | 证据 |
|------|------|------|
| `createContextManager` 工厂 | 已实施 | `context-manager.ts:266` |
| `prepareTurn` 统一入口 | 已实施 | `context-manager.ts:658` |
| 两段式压缩（Prune + Compress） | 已实施 | `context-manager.ts:576` |
| 富类型 `ContextUsage` | 已实施 | `types.ts:60-70` |
| 模型级 budget（tokenCounter.getBudget） | 已实施 | `context-manager.ts:55-91` |
| Part 级 `time.compacted` 标记 | 已实施 | `part-time.ts:11-13` |
| Bus 事件（4 个 Zod-typed 事件） | 已实施 | `events.ts:38-72` |
| 文件操作追踪（单次压缩区间） | 已实施 | `file-ops.ts:18-43` |
| 摘要消息（metadata.kind = "context-summary"） | 已实施 | `summary.ts:3-8` |
| Token 锚点估算 | 已实施 | `token-estimation.ts:12-35` |
| 事件溯源（Record/Replay） | 未实施 | 无相关文件、类型或函数 |
| Origin 追踪 | 未实施 | `MessageWithParts` 仅有 `info` + `parts`，无 origin 字段 |
| 注入系统 | 未实施 | `serializer.ts:45` 组装流程硬编码，无扩展点 |
| Per-step 压缩 | 未实施 | `prepareTurn` 仅在 `runSession` 第一步调用一次 |
| 溢出自动恢复 | 未实施 | `runModelStep` 不捕获溢出错误 |
| 动态 completion budget | 未实施 | LLM 调用不传递动态 `max_tokens` |
| 后台异步通知 | 未实施 | 无后台任务通知机制 |
| 文件操作跨压缩累积 | 未实施 | `CompressionResult` 不继承前序压缩状态 |
| 压缩摘要跨会话复用 | 未实施 | 摘要仅存为当前会话的 synthetic part |
| Pre/Post compaction hooks | 未实施 | 压缩流程完全封闭 |
| Undo safety | 未实施 | 无并发状态校验 |

### lifecycle 模块 (packages/ohbaby-agent/src/core/lifecycle/)

| 功能 | 状态 | 证据 |
|------|------|------|
| `runSession` 入口 | 已实施 | `lifecycle.ts:497` |
| `prepareTurn` 集成 | 已实施 | `lifecycle.ts:533-550`（仅第一步调用） |
| Tool 调用循环 | 已实施 | `lifecycle.ts:621-744` |
| Tool scheduler 错误恢复 | 已实施 | `lifecycle.ts:1046-1057` |
| Abort signal 处理 | 已实施 | 多处检查点 |
| LifecycleConfig hooks | 已实施 | shouldStopAfterTurn, beforeToolCall, afterToolCall |
| Per-step prepareTurn 重调 | 未实施 | guard `if (!conversationMessages)` 确保只调一次 |
| 溢出检测/恢复 | 未实施 | `runModelStep` 捕获错误后直接 re-throw |
| 动态 completion budget | 未实施 | `streamChatCompletion` 不接收动态 `max_tokens` |
| 后台任务通知 | 未实施 | 无相关基础设施 |

### message 模块 (packages/ohbaby-agent/src/core/message/)

| 功能 | 状态 | 证据 |
|------|------|------|
| `MessageWithParts` 类型 | 已实施 | `types.ts:137-140` |
| `PartMetadata` 可扩展 | 已实施 | `types.ts:82`（`[key: string]: unknown`） |
| `origin` 字段 | 未实施 | 不存在于任何源代码文件中 |
| `PromptOrigin` 类型 | 未实施 | 仅存在于文档中作为 kimi-code 的引用 |

### agents 模块

| 功能 | 状态 | 证据 |
|------|------|------|
| `runAgent` 函数 | 已实施 | `runner.ts:125` |
| `waitMode: "stream"` | 已实施 | `runner.ts:174-206` |
| `waitMode: "waitForCompletion"` | 已实施 | `runner.ts:208-245` |
| Primary 通过 runAgent 启动 | 已实施 | `service.ts:87` |
| Subagent 通过 runAgent 执行 | 已实施 | `service.ts:131` |
| RunWorker 通过 runAgent 执行 | 未实施 | `worker.ts:211` 仍直接调用 lifecycle |
