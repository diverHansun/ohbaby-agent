# 记忆模块体系分析报告

> 分析日期：2026-05-28
> 分支：mvp
> 对象：`context`（短期记忆） + `memory`（中期记忆） + `storage`/`database`（持久化） + `lifecycle`（编排） + `system-prompt`（注入）
> 参考项目：kimi-code、opencode
> 框架：learn-swe-before-implement 审阅模式

---

## 零、项目阶段判定

项目处于 **MVP -- 成长中的产品** 阶段。核心架构已经确立，关键路径有测试覆盖，设计文档体系完善。分析重点：识别当前阶段必须修复的缺口 vs 可以推迟的优化。

---

## 一、学习启发

### 1.1 对本项目有直接指导意义的原则

- **低耦合 + DIP**（来自 references/02 基础受力 + 03 设计原则）
  - 本项目对应场景：`ContextManager` 通过 `ContextManagerOptions` 注入全部依赖（`context/types.ts:155-168`），与 kimi-code 的 Agent 构造函数注入模式一致
  - 启发：当前 DI 模式是正确的，MVP 阶段不应为了"更灵活"引入 IoC 容器或 Effect-TS。但要警惕 `serializer.ts` 绕过 DI 直接 import `isActivePart` 等函数——它形成了第二条隐式组装路径
  - 优先级：高

- **错误的抽象比重复更糟**（来自 references/03 护栏 2）
  - 本项目对应场景：kimi-code 的 `DynamicInjector` + `InjectionManager`（注入系统）很好，但 ohbaby-agent 当前的硬编码 `serializeForLlm` 只有 65 行，没有引入这套抽象的紧迫性。improve-2 文档将注入系统列为 P2 的判断是正确的
  - 启发：不要在 MVP 阶段为"以后可能需要"的中间件 pipeline 买单
  - 优先级：高

- **可测试性是设计探针**（来自 references/01 设计目标）
  - 本项目对应场景：`context-manager.ts` 的 `pruneHistory` 和 `summarizeHistory`（第 46-516 行）是内部闭包函数，只能通过 `compact`/`prepareTurn` 间接测试。`manager.unit.test.ts` 通过端到端路径覆盖了这些逻辑，但测试 setup 很重——需要创建完整的 MessageManager fixture、mock LLM client
  - 启发：将 `pruneHistory` 和 `summarizeHistory` 导出为独立可测的函数，能大幅降低测试成本。kimi-code 的 `FullCompaction` 类就是独立可测的
  - 优先级：中

### 1.2 参考项目反例与对照

- **kimi-code：WAL（Record/Replay）的完整度 vs 成本**
  - kimi-code 的 `AgentRecords` 系统（7 类事件、20+ 种 action type）提供了崩溃恢复和完整审计能力，但 a) kimi-code 是多进程架构（有崩溃恢复的真实需求），b) 引入约 1500+ 行持久化代码
  - ohbaby-agent 是单进程同步架构，SQLite + Bus 事件已覆盖基本状态恢复。improve-2 文档将事件溯源列为 P1 但建议"从最小可行集开始"——这个判断是正确的
  - 需要警惕：不要因为"kimi-code 有"就全量照搬。先从记录 compaction 事件开始（约 50 行），验证真实需求后再扩展

- **opencode：AGENTS.md 的多级加载 + nearby discovery**
  - opencode 的 `instruction.ts` 实现了 `findUp`（从文件位置向上查 AGENTS.md） + `claims` 去重机制。ohbaby-agent 当前只有 `memory-discovery.ts` 的向上查找（从 dir 到 projectRoot），但只会找到第一个 OHBABY.md
  - 这本身不是问题——OHBABY.md 的定位（项目根目录一个文件）和 AGENTS.md（可在任意子目录存在多个）的设计意图不同。但 opencode 的 `nearby instruction` 模式（读到文件 `src/foo/bar.ts` 时自动加载 `src/foo/AGENTS.md`）是一个值得关注的差异化思路——它让"目录级规则"成为可能
  - 建议：如果未来用户有"不同子目录不同规则"的需求，可参考 opencode 的 nearby discovery 模式

### 1.3 有意识的合理权衡

- **Memory 模块不缓存、不自动刷新（N5 + N8 of goals-duty.md）**
  - 上下文：每次 `load()` 重新读文件；会话中途 add/update 不自动刷新当前会话
  - 说明了什么：MVP 阶段优先简单性和可预测性。文件始终是 source of truth，不会出现"缓存过期"类 bug
  - 需要注意：长期看，当会话很长时（如 2 小时+），用户通过 `/memory add` 新增的记忆在当前会话中不可见，这可能引发困惑。需要在 UI 层告知用户"新记忆将在下次会话生效"

- **ContextManager 直接依赖具体 MessageManager 而非接口**
  - 上下文：`context/types.ts:155` 直接 import `MessageManager` 类型（非泛化 interface）
  - 说明了什么：MVP 阶段只有一个 SQLite 实现，引入 Repository 接口是过度设计
  - 需要注意：已在上一次审阅中标记为"值得在 improve-3 评估是否需要接口隔离"

---

## 二、项目健康度分层评估

### 2.1 哲学/价值观层 -- 复杂度管理意识、代码为人而写的程度

- 做得好：`goals-duty.md` 中 "Non-Duties"（N1-N8）明确标注了什么不该做——这是复杂度管理的最强信号。例如 N5"不维护内存缓存"、N6"不支持 @import"、N7"不处理并发写入"都遵循 YAGNI
- 做得好：improve-1/improve-2 分轮迭代文档体系展示了显式的技术债管理——每次只解决一个维度的核心矛盾
- 做得不好：`decideCompactAction` 的"先 pruned -> 再 pruned-only -> 再 compact"的判断逻辑（`context-manager.ts:95-107`）混合了"状态判断"和"策略选择"两个关注点。`compact()` 和 `prepareTurn()` 各自独立实现了类似的判断链
- 评价：4/5（5=非常健康，1=问题严重，下同）

### 2.2 设计目标层 -- 质量属性是否明确、优先级是否清晰

- 做得好：`goals-duty.md` 中 G1-G6 明确了"统一组装"、"自动压缩"、"简单可靠"等优先级，且"简单可靠"排在"可扩展"之前
- 做得好：kimi-code 对比分析（improve-2 problem-analysis.md）逐项评估了每个 gap 的优先级（P0-P3），并给出了清晰的理由矩阵
- 做得不好：缺少对"session 恢复时间"这一用户可感知质量属性的度量。SQLite 全量查询所有 message + re-assemble 的开销在 1000+ 条消息后是否可控，尚无数据
- 评价：4/5

### 2.3 基础受力层 -- 耦合度、内聚度、抽象一致性

- 做得好：context 与 memory 耦合通过 `MemoryReader` 接口（`context/types.ts:12-14`）隔离，符合 DIP
- 做得好：`file-ops.ts`、`filters.ts`、`summary.ts`、`token-estimation.ts` 各自高内聚，单一职责
- 做得不好：`serializer.ts` 和 `context-manager.ts` 之间的流程分叉——`prepareTurn` 先组装上下文（包括 memory），再调用 `serializeForLlm`，但 `serializeForLlm` 又自己调用 `loadMemoryForPrompt` 做安全扫描。两次 memory 处理形成了隐式耦合。kimi-code 的做法是让 `projector.ts` 纯函数只做投影，不做安全检查
- 做得不好：`Lifecycle.runSession` 和 `Lifecycle.run` 中 tool loop 逻辑几乎完全重复（约 120 行 × 2）
- 评价：3/5

### 2.4 设计原则层 -- SOLID/DRY/KISS/YAGNI 遵循度

- 做得好：SRP 在模块级别体现好——memory 只管文件 CRUD，context 只管组装和压缩
- 做得好：`CompressionResult.status` 用 discriminated union（`"compressed" | "skipped" | "failed" | "inflated"`）——调用方可以精确匹配状态
- 做得好：ohbaby-agent 当前用简单的 `SystemPromptProvider` interface，比 kimi-code 的 Profile YAML 继承系统更符合 KISS
- 做得不好：`run()` 和 `runSession()` 的 DRY 违反——两份代码本质上是"同一知识"（tool loop），但因为历史原因分成两个方法
- 做得不好：`summarizeHistory`（`context-manager.ts:418-516`）98 行包含了 LLM 调用、结果处理、file ops 附加、part 标记、事件发布 5 个关注点
- 评价：3/5

### 2.5 架构模式层 -- 架构选择与问题域匹配度

- 做得好：整体遵循"业务内核 + 外围适配器"：`core/context`（内核）通过接口依赖 `services/database`（外围）
- 做得好：两段式压缩（Prune + Compress）是行业标准模式，kimi-code 和 opencode 均采用此方案
- 做得好：kimi-code 的"Steer buffer + 延迟刷新"模式在 tool 执行期间保护了消息完整性——ohbaby-agent 的 `RunWorker` 虽然没有显式实现但受益于单进程同步模型的天然原子性
- 做得不好：缺少 per-step compaction——当前一次 `prepareTurn` 后 tool loop 可能产生无限量消息追加，kimi-code 和 opencode 的 per-step 检查是"可用性"维度的架构决策
- 做得不好：缺少明确的分层声明。`core/context`、`core/lifecycle`、`core/agents`、`services/` 的依赖规则虽在代码中体现，但没有在 `architecture.md` 中显式声明
- 评价：4/5

### 2.6 代码工艺层 -- 命名、函数设计、注释、错误处理

- 做得好：命名风格一致——`createContextManager`、`decideCompactAction`、`findCutPoint`、`getActiveHistory`——动词+名词模式可预测
- 做得好：类型系统健全——`ContextUsage`、`CompressionResult`、`PruneResult` 字段语义清晰
- 做得好：`compression-prompt.ts` 中的结构化压缩提示词设计精良：Goal、Constraints、Progress（Done/In Progress/Blocked）、Key Decisions、Next Steps、Critical Context——与 kimi-code 的 `compaction-instruction.md` 结构类似
- 做得不好：`summarizeHistory` 98 行，`runSession` 306 行——两个长函数存在但都不是"坏"的长（逻辑本身复杂），而是"可以更清晰"
- 评价：4/5

### 2.7 工程实践层 -- 测试、评审、CI、版本管理

- 做得好：`manager.unit.test.ts`（1137 行）覆盖了 assemble、compress、compact、prune、prepareTurn 的核心路径
- 做得好：`memory/parser.unit.test.ts` 和 `memory/manager.integration.test.ts` 覆盖了 CRUD 路径
- 做得好：`lifecycle.unit.test.ts`（1230 行）覆盖了 run、runSession、tool calls、error handling
- 做得好：文档体系完善——每个模块都有 goals-duty.md、architecture.md、dfd-interface.md、data-model.md、test.md
- 做得不好：`pruneHistory` 和 `summarizeHistory` 是闭包函数，没有独立单元测试——只能通过重量的集成测试路径覆盖
- 做得不好：缺少压缩耐久性测试——连续 10 轮压缩后的 token 精度漂移没有人关注
- 评价：4/5

### 2.8 语言惯用法层 -- 是否顺着语言纹理写

- 做得好：大量使用 discriminated unions + Zod schema——这是 TypeScript 生态的惯用法
- 做得好：工厂函数模式（`createContextManager`）而非 class——符合"组合优于继承"
- 做得好：async generator（`Lifecycle.run()`、`runSession()`）——优雅的流式事件模型
- 做得好：`MergedMemory` 同时暴露 `global`、`project` 和 `merged`——调用方可以自行选择用哪个粒度
- 评价：5/5

---

## 三、风险与债务地图

### 风险地图

| 问题简述 | 严重性 | 可优化性 | 位置 | SWE依据 | 建议 |
|----------|--------|----------|------|---------|------|
| Per-step 压缩缺失，长 tool 链可能溢出 | 架构级 | 战略投资 | `lifecycle.ts:533` | 02 基础受力（协议正确性） | 每 step 前检查 usage，超阈值触发 prepareTurn |
| `run()`/`runSession()` 重复 tool loop | 设计级 | 低垂果实 | `lifecycle.ts:362/621` | 03 DRY | 抽取私有 `runToolLoop` 方法 |
| 无 Origin 追踪，消息来源不可知 | 设计级 | 低垂果实 | `message/types.ts:137` | 02 可观测性 | 在 PartMetadata 中加入 origin 字段 |
| File ops 不跨压缩累积 | 设计级 | 低垂果实 | `file-ops.ts:18` | 03 关键状态保留 | CompressionResult 继承前序 file ops |
| serializer 与 context-manager 隐式耦合 | 设计级 | 锦上添花 | `serializer.ts:45` | 02 内聚 | 将安全扫描移入 prepareTurn 主流程 |
| summarizeHistory 函数 98 行 | 代码级 | 锦上添花 | `context-manager.ts:418` | 06 函数设计 | 抽取 buildSnapshot/markParts 子函数 |
| Memory 不自动刷新会话中记忆 | 设计级 | 战略投资 | `memory/manager.ts` | 01 正确性 | 会话中途 add 后 reload 到当前 session |
| 无压缩耐久性测试 | 工程级 | 锦上添花 | 测试文件 | 07 测试 | 补充 10 轮连续压缩的回归测试 |
| Database 单例全局连接（`currentConnection`） | 设计级 | 锦上添花 | `database/index.ts:48` | 02 公共耦合 | 当前可接受（单进程），异步压缩时需重审 |
| OHBABY.md 无多级路径支持 | 工程级 | 锦上添花 | `memory-discovery.ts:31` | 05 DDD | 当前 YAGNI，等用户反馈 |

### 关键发现

- 最值得马上修的是：`run()`/`runSession()` 的 DRY 违反——因为 per-step 压缩改造必然要改动 tool loop，先统一路径能减少 bug 引入。预计 4-6 人时
- 最大的定时炸弹是：Per-step 压缩缺失——`prepareTurn` 只在第一步调用一次，tool loop 中追加 tool 消息后不再检查 context window。大量文件操作场景（如批量 grep + read）可能溢出
- 技术债最密集的区域是：`lifecycle.ts`——单文件 1059 行，两个高度重复的入口方法
- 最值得借鉴的设计（kimi-code）：Per-step compaction + auto-continue pattern；Origin tracking 的 `PromptOrigin` discriminated union
- 最不需要照搬的设计（kimi-code）：完整的 WAL Record/Replay——ohbaby-agent 的单进程 + SQLite 已覆盖恢复需求
- 最值得借鉴的设计（opencode）：nearby AGENTS.md discovery（从文件位置向上查规则）——这是 OHBABY.md 系统可以自然扩展的方向

---

## 四、行动建议

### 4.1 低垂果实（本轮即可完成）

**1. 统一 `run()` 和 `runSession()` 的 tool loop**

- 当前问题：tool 调用循环（约 120 行 x 2）重复
- 具体做法：抽取 `runToolLoop(step, conversationMessages, params, hooks)` 私有方法，`run()` 和 `runSession()` 各自注入差异化 hooks（是否调用 prepareTurn、是否 yield turn:* 事件）
- 预计工作量：4-6 人时
- 预期收益：为 per-step 压缩改造扫清障碍，减少约 120 行重复代码
- 注意事项：确保 `run()` 的现有行为（不 emit turn:start/turn:end）完全保留

**2. 为消息预留 `origin` 字段**

- 当前问题：消息无来源追踪
- 具体做法：在 `PartMetadata`（已有 `[key: string]: unknown` 扩展槽）中写入 `origin` 字段，先定义类型常量 `"user" | "compaction" | "tool-result" | "injection"`，不改变运行时逻辑
- 预计工作量：2-3 人时
- 预期收益：零运行时风险，为 P1 目标的 Origin 追踪铺路

**3. 文件操作跨压缩累积**

- 当前问题：每次 `compress` 的 file ops 独立计算，不继承前序压缩的累积文件列表
- 具体做法：`CompressionResult` 增加 `readFiles: string[]` 和 `modifiedFiles: string[]` 字段，`compact()` 在连续调用时合并前序结果
- 预计工作量：3-4 人时
- 预期收益：防止"压缩摘要丢失早期操作的文件上下文"

**4. Memory 会话中途自动刷新（UI 告知优先）**

- 当前问题：`memory/add` 后当前会话看不到新记忆（N8 of goals-duty.md 已声明）
- 具体做法：最低成本方案——在 `memory/add` 成功后，通过 Bus 事件通知 ContextManager 重新 `assemble`（可选 force reload）。如果这太重，至少确保 UI 显示"新记忆将在下次会话生效"
- 预计工作量：2-4 人时（UI 告知版）或 0.5-1 人天（自动刷新版）
- 注意事项：自动刷新需要评估对 compaction 状态的影响

### 4.2 战略投资（排入下轮迭代）

**1. Per-step 压缩 + 溢出自动恢复**

- 当前问题：tool loop 中持续追加消息但不压缩
- 具体做法：在 `runSession` 的 tool loop 每轮迭代前，动态检查 context usage；若超过阈值，调用 `prepareTurn({ force: true })` 重新组装上下文；溢出错误捕获后自动触发 compact + 重试
- 预计工作量：2-3 人天
- 预期收益：解决 P0 生产可用性风险
- 注意事项：回归测试以下场景——空 tool 循环（不触发压缩）、少量 tool 调用（不触发）、大量 tool 调用（触发）、单轮内多次触发（极限压力）

**2. Token 估算精度改进**

- 当前问题：没有使用实际 LLM API 返回的 token count 做校准。`estimateContextTokens` 用字符长度估算，在混合中英文场景误差大
- 具体做法：在 LLM response 的 `tokenUsage` metadata 中写回实际 token 数，`estimateContextTokens` 优先使用最近一次 API 返回的 token count 作为 anchor（已有 `findLatestUsageAnchor`，但依赖 metadata 中写入了 tokenUsage）
- 预计工作量：1-2 人天
- 说明：kimi-code 也是这样做的——实际 LLM usage 做 anchor，字符估算做 tail 估算

### 4.3 锦上添花（有空再做）

1. **`summarizeHistory` 拆分为子函数**：LLM 调用、结果后处理、part 标记三个职责独立
2. **修复 `RunWorker.createLifecycleLoop` 的控制耦合**：用显式 mode 参数替代对 context.messages 的隐式判断（`worker.ts:211`）
3. **补充压缩耐久性测试**：10 轮连续压缩 -> token 精度漂移测试
4. **OHBABY.md 多级路径支持**：参考 opencode 的 nearby AGENTS.md discovery（`findUp` from file location）

### 4.4 暂缓项（当前不值得做，但记录在案）

- **完整 Record/Replay（WAL）**：单进程同步架构下收益不明确，先观察 per-step 压缩上线后的崩溃率
- **注入系统（InjectionManager）**：当前硬编码流程可工作，等真实需要动态注入时再抽象
- **OHBABY.md 大小预算**：当前 <1MB 假设成立，等遇到大文件案例再引入截取策略
- **跨会话压缩摘要复用**：需要 memory 模块扩展 + 关联多 session 的查找能力，当前 YAGNI

---

## 五、注意事项与反教条警告

### 5.1 本项目特有的陷阱

- **不要为"对标 kimi-code"而照搬 WAL**——ohbaby-agent 是单进程同步架构，kimi-code 有真实的多进程崩溃恢复需求。SQLite 持久化 + Bus 事件已覆盖核心恢复需求。如果做事件溯源，从最小可行集（只记录 compaction/memory 事件）开始，别一上来就定义 20+ 种 event type
- **不要在 per-step 压缩中引入启发式决策**——当前 `decideCompactAction` 的判断逻辑（usage ratio）已经足够。不要加"连续 3 个 tool 调用后自动压缩"之类的额外规则。简单法则：每步查 usage -> 超阈值就 prepareTurn -> done
- **不要在 MVP 阶段引入 IoC 容器或 Effect-TS**——当前工厂函数 DI 模式已经正确。为了一致性引入框架级依赖是典型的"为复杂而复杂"
- **不要为了"未来可能需要"而拆分 `ContextStorage` 接口**——当前 Memory 用 fs 直读写、Message 用 SQLite 直写。如果将来真有第二个存储后端（如 IndexedDB for browser），那才是抽象的时候。参考"三次法则"（03 护栏 3）

### 5.2 哪些 SWE 原则不适合（或需要打折执行）本项目

- **DIP 在 ContextManager 中可暂缓**：直接依赖具体 `MessageManager` 而非接口。原因：只有一个 SQLite 实现，引入 `MessageRepository` 接口是"为想象的未来买单"
- **函数行数限制不应机械套用**：`runSession` 306 行、`summarizeHistory` 98 行——问题不是"行数多"，而是"嵌套了不同职责层"。重构目标是职责分离，不是按 50 行一刀切
- **DRY 在 compression prompt 上不要过度**：ohbaby-agent 的 `compression-prompt.ts` 和 kimi-code 的 `compaction-instruction.md` 结构相似但意图不同——前者是 XML-style snapshot，后者是 prose-style summary。保持分离是正确的，不要为了共享模板而强行合并
- **测试覆盖率不应在 MVP 追 80%+**：核心模块已有 1137 + 1230 + 其他测试行，足够。新增的 per-step 压缩应该测，但不要因为"pruneHistory 没有独立测试"就延迟发布

### 5.3 给后续开发的护栏建议

- 修改 `prepareTurn` 行为必须同步更新 `Lifecycle.runSession` 的调用点——这两个模块通过"契约"协作，容易因口头约定出错
- 新增 `ContextUsage` 或 `CompressionResult` 字段时，先检查 `events.ts` 的 Zod schema——类型不一致会导致运行时事件校验失败但不报编译错误
- Per-step 压缩上线后必须回归测试 4 个场景：空 tool 循环（不触发）、少量 tool 调用（不触发）、大量 tool 调用（触发）、单轮内多次触发
- 不要在实现 waitMode stream 分支时引入后台线程——保持单进程同步架构，等 improve-3 再评估异步压缩的架构影响
- 引入任何新项目（OHBABY.md 的 @import、多级路径、语义分析）前，先收集 MVP 用户反馈——只有真实需求才能指导正确的抽象方向

---

## 六、参考项目对照表

### 6.1 ohbaby-agent vs kimi-code

| 维度 | ohbaby-agent | kimi-code | 评估 |
|------|-------------|-----------|------|
| 压缩策略 | Prune（保护 40k）+ LLM summary（结构化模板） | 相同模式 + per-step + auto-continue | ohbaby 缺少 per-step 和 auto-continue |
| 记忆/项目文件 | OHBABY.md（global + project，单文件） | AGENTS.md（多级，32KB budget） | kimi-code 的多级方案更灵活 |
| Record/Replay | 无 | 完整 WAL（wire.jsonl） | kimi-code 在有真实崩溃恢复需求的场景下更强 |
| Origin 追踪 | 无 | PromptOrigin discriminated union | ohbaby 缺失 |
| 系统提示词 | SystemPromptProvider interface | Nunjucks 模板 + profile 继承（extends） | kimi-code 继承系统更灵活，但 ohbaby 方案更 KISS |
| Per-step 压缩 | 仅第一步 | 每一步，带 block 机制 | ohbaby 的关键缺口 |
| 会话存储 | SQLite via MessageManager | WAL + jsonl 文件 | 各有优势：SQL 可查询，WAL 更简单可回放 |

### 6.2 ohbaby-agent vs opencode

| 维度 | ohbaby-agent | opencode | 评估 |
|------|-------------|---------|------|
| 压缩策略 | Prune + LLM summary | 相同模式 + overflow replay | 非常相似，opencode 多了自动重试 |
| 规则文件 | OHBABY.md（global + project） | AGENTS.md/CLAUDE.md（findUp + nearby） | opencode 的 nearby discovery 值得借鉴 |
| 指令加载 | 单一项目级 | 多源：global、config、URLs、nearby files | opencode 更全面 |
| 框架 | 纯 TS + DI 工厂函数 | Effect-TS（函数式、类型化 effects） | 不同哲学路径 |
| 技能系统 | Skill 模块存在 | 技能描述注入系统提示词 | 相似模式 |
| 会话存储 | SQLite + MessageManager | SQLite + Drizzle ORM | 均为 SQLite |

### 6.3 核心判断

架构方向正确，需要的是"填坑"而非"改方向"。

| 维度 | 状态 | 说明 |
|------|------|------|
| 短期记忆（context） | 良好，缺 per-step | 两段式压缩方案成熟。唯一致命缺口是 per-step 不触发 |
| 中期记忆（memory） | 良好 | OHBABY.md 模式简单正确。会话中途不刷新是已声明的痛点 |
| 长期记忆（OHBABY.md + session storage） | 良好 | SQLite + 文件双轨设计合理 |
| 编排（lifecycle） | 需清理 | run/runSession 双路径是历史债 |
| 存储（storage + database） | 良好 | 原子写入、锁管理、迁移系统均已就位 |
| 系统提示词（system-prompt） | 良好 | SystemPromptProvider 接口 + 安全扫描有层次感 |

最优先要做的事（按投入产出比排序）：

1. 统一 run/runSession（4-6 人时）
2. 预留 origin 字段（2-3 人时）
3. Per-step 压缩（2-3 人天）
4. Memory 会话刷新（2-4 人时 UI 告知，或 0.5-1 人天自动刷新）

这些做完后，记忆体系即可达到"成长中的产品"阶段的可维护性标准。更多高级特性（WAL、注入系统、跨会话摘要复用）应等 MVP 用户反馈后再评估。
