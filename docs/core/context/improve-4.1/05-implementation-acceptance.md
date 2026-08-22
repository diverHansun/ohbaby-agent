# 5. 实施验收文档

> 由 `plan-code-improvement` **验收模式**独立检查后撰写。验收方未修改代码；发现项只记录，不自动修复。

---

## 5.1 元信息

| 项 | 值 |
|----|----|
| 议题 / 批次 | context 静态/手动路径 tools 计量与占用口径统一 · `improve-4.1` |
| 规划文档版本 | `6436c152`（规划模式定稿）→ `97e02eb0`（实施前第二轮讨论后**重写契约**，见 §5.3 D0） |
| 实施范围 | `fb67033`、`3f0886d`、`190a284`、`b222d45`（代码）；基线 `84006096` |
| 验收日期 | 2026-08-22 |
| 验收方式 | 独立 diff 检查 + 三个只读子代理并行核对 + 本地重跑发布门 |
| **结论** | **通过（有保留项）**。三个 Phase 全部落地，最高风险项（final step prompt 工具名）实现正确且有集成级行为断言；无生产代码越界。保留项为测试证据强度与文档一致性，均不阻塞合并 |

---

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施 | 证据 |
|---------|------|----------|------|
| Phase 1-1/2/3：`ContextMeasurementPayload`，`tools` 属性必填 | 完成 | `types.ts` 定义 `{ messages, tools }`；`measureUsage(payload, {modelId, sessionId, contextScopeId})` 把计量数据与校准元数据分离 | `core/context/types.ts:75-78`、`context-manager.ts:548-573` |
| Phase 1-4：`CompactOptions.tools` 必填，同一 schemas 贯穿全部重测 | 完成 | `usageBefore`、afterPrune、projected、usageAfter 四处共用 `req.tools` | `context-manager.ts:1309-1326, 1127-1134, 1192-1199, 1255-1262` |
| Phase 1-5：`assemble` 改 options；`toolNames` 必填 | 完成 | `assemble(sessionId, directory, options)`；`CompactOptions` 同时补回 `agentName`（原 P6 的位置参数漏传彻底消除） | `types.ts:66-71, 119-126`、`context-manager.ts:1303-1308` |
| Phase 1-6：删除 `toolsProvider` | 完成 | composition 生产接线已删；全仓 `rg toolsProvider packages/ohbaby-agent/src` 为 0 命中 | `composition.ts`（删除 `toolsProvider`）、`assembler.ts` |
| Phase 1-7/8：final step 先解析完整 tools 再清 outbound | **完成（本批最高风险项，实现正确）** | `resolvedTools` 先取全量 → `toolNames = toolNamesFromSchemas(resolvedTools)` → `tools = isFinalStep ? [] : resolvedTools`。**名字不从空 schema 派生** | `lifecycle.ts:396-407` |
| Phase 2-1/2：primary 静态/手动解析 tools，subagent 拒绝 | 完成 | 新增 `resolvePrimaryContextTools`：读 Session → subagent 抛错 → 解析一次 → names 给 assemble、schemas 给 getUsage/compact | `composition.ts:377-402, 887-928` |
| Phase 2-3：child 检查在读 tracker **之前** | 完成 | `getContextWindowUsageInternal` 先取 session 判 `isSubagent` 才读 cache | `ui-inprocess.ts:1777-1786` |
| Phase 2-4：primary guard 错误文案不再只写 "submit prompt" | 完成 | `assertCanUseAsPrimarySession(sessionId, "compact" \| "prompt")` 按操作区分文案 | `ui-inprocess.ts:1539-1553` |
| Phase 3-1/2：status 单源，删 `context` 与 `getContextUsage` | 完成 | `handleStatus` 只取 `getContextWindowUsage`；`CommandServiceOptions` 与 ui-inprocess 装配均已删 | `commands/builtin.ts:240-254`、`commands/types.ts`、`ui-inprocess.ts:2444` |
| Phase 3-3：compact 后更新 tracker 并发事件 | 完成 | `updateFromContextUsage(sessionId, result.usageAfter)`，有 projection 才 `publish` | `ui-inprocess.ts:1763-1769` |
| §2.4 禁止顺带修改 | 基本遵守 | 生产代码零越界；文档/测试有 3 处轻微越界（§5.3 D4） | 见 §5.3 |

`AssembledContext` 仍无 tools 字段；ContextManager 无 scheduler/MCP import——两条 DoD 均成立。

---

## 5.3 规划 vs 实际差异

### D0（**最重要**）：实施前重写了规划契约，并推翻了一条已冻结决策

规划模式定稿的 00 冻结的是：「让 `isSubagent`/`agentName` 从 `Session` 传到 `assemble`，**任何 agent 都能被同一套逻辑正确测量**，**不加守卫**」（用户当时明确收回了加守卫的提议）。

实施会话在 `97e02eb0` 中重写 00/01/02/03/04，改为**方案 A**：静态查询与手动 compact **只面向主代理**，child session 返回 `null` / 抛错。

| 维度 | 判定 |
|------|------|
| 是否经用户确认 | **是**。00 §8 记有「确认采用方案 A」「子代理也需要占用监控，但只用于自动 compression，不做 UI」 |
| 技术论据是否成立 | **是，已独立核实**。论据是「多个 subagent record 共享同一 child session，`contextScopeId`/`role` 在 record 上而非 Session 上」，因此只读 Session 无法还原某个子代理实例的上下文 |
| 核实证据 | `agents/subagent-host.ts:366-375`（已有 record 时复用 `existing[0].sessionId`）；`subagent-host.unit.test.ts:1808-1842`（并发创建 `explore`+`research` 只建一次 session、两 record 同 `sessionId`）；`migrations.ts:225-228`（唯一索引是 `(session_id, context_scope_id)`）；`message/store.ts:121-131`（无 scope 则不过滤，聚合兄弟 scope）；`utils/scoped-session.ts:14-18`（factor key 含 scope，缺省回落 session 级） |

**结论：这不是实施跑偏，是规划期的事实性错误被实施期修正。** 原方案「从 Session 补参即可正确测量任意 agent」在本代码库不成立——省略 `contextScopeId` 会同时污染 history、MCP loaded tools、calibration factor 与 prompt role 四条路径。

需要如实记录的**两点保留**：

1. 措辞略微夸大。`contextScopeId` 并非「只在 record 上」——message/part 也携带它（`core/message/types.ts:15-18`）。record 是实例身份源，message 是持久化过滤键。
2. 该 guard 目前**主要是防御性**，而非在修一个正在发生的线上错误。静态占用 API 只收 `sessionId`；UI 会话列表按 `!isSubagent` 过滤（`ui-inprocess.ts:1376-1379`），TUI 只用 primary session（`app.tsx:597`）。它防的是「SDK 或未来调用方传入 child sessionId，拿到看似精确实则跨 scope 聚合的数字」。方向正确，不算过度防御。

> **流程偏差**：契约文档被实施会话重写，意味着「实施符合 02」有一定循环论证成分。本次验收因此把判据放在**用户确认记录 + 独立代码核实**上，而非仅比对 02。此外，原 `05` 由实施会话自行撰写；按 skill 约定 05 是验收模式的交付物，本文已独立重写替换。

### D1：新增 `PrepareTurnInput.additionalMessages`（规划中没有）

| 项 | 内容 |
|----|------|
| 规划 | 02 未提及。原代码 `messagesForStep()` 在**计量完成后**才把 maxSteps finalization message 追加进发送列表 |
| 实际 | 改为仅请求期 `additionalMessages`，在 `renderForModel` 中追加，贯穿全部 7 处 `measureContext` 并进入 `prepared.messages` |
| 原因 | 实施会话的 Reviewer A 发现：provider 的 `prompt_tokens` 含该消息，而 calibration 分母不含 → 校准分子分母不同量纲 |
| 影响 | **正向且必要**。这与本批「口径统一」的主旨同源；不修则 factor 会被 finalization message 系统性拉偏。经核实该消息不写入 history（history 变更走 `rawHistory`），仅计量 + 发送 |
| 证据 | `lifecycle.ts:399-407`、`context-manager.ts:530-546, 1341-1418` |

### D2：`getUsage` 由位置参数改为对象参数

规划写 `getUsage(context, modelId, tools?)`；实际为 `getUsage({ context, modelId, tools })`。理由与 `assemble` 改 options 一致（防止参数继续漏传），方向一致，属改进。

### D3：TC 编号与数量变化

规划模式的 04 是 TC-1…TC-13；`97e02eb0` 重写为 TC-1…TC-16 + I-1/I-2/I-3。语义有对应关系但编号不可直接对照（例：原 TC-13「final step prompt 仍含工具名」→ 现 TC-5）。本文按**现行 04** 验收。

### D4：轻微越界（文档与测试面，无生产代码越界）

| 项 | 严重性 | 说明 |
|----|--------|------|
| `architecture.md` 把阈值示例 85%→95% | minor | 02 §2.4 禁止在该文件顺带改「压缩策略设计」。实际只改文档、未改代码常量（基线 `COMPRESSION_THRESHOLD` 本就是 0.95），属 doc-code 对齐；但见 §5.5 F4 的副作用 |
| `goals-duty.md` 改写 D1 子代理段 | minor | 02 §2.4 写明「D1 不变」。改后内容与 Phase 2 实现一致，但超出字面授权。G2/D3 的 85% **未被改动**，符合「禁止修订 85% 阈值」 |
| `goals/goal-compact.integration.test.ts` | minor | 不在 §2.4 允许目录。仅为适配 `CompactOptions.tools` 必填的机械补参，无行为扩展 |
| `improve-5/README.md`、`improve-5/00-discussion.md` | minor | §2.4 未授权该目录。内容是登记 4.1↔5 边界与路线，无代码影响 |

其余维度（数据流、协议、依赖、错误处理）与规划一致。SDK 无 shape 变更，`tokenCounting.ts` 未改，无 DB migration。

---

## 5.4 实施理由与注意事项

**关键取舍**

1. **`ContextMeasurementPayload` 而非 `RequestPayload`**：仓库已有真正的 `InterfaceProviderRequest`（含 model/temperature/maxTokens/signal）。用窄名避免让人误以为它是 transport request，也避免本批被拖成发送层重构。这个改名是对的。
2. **`tools` 属性必填、值可空**：强迫每个调用点显式承认「我这条路径有没有 schemas」。这正是本批要修的那类 bug（漏传即静默少算）的类型级防御。
3. **一次解析、两处派生**：Lifecycle 的 `resolveTools` 现在包的就是 composition 的同一个 `resolvePromptTools`（`composition.ts:498-506`），所以实时 prompt 的工具名与计量/发送的 schemas 严格同源。这是规划期红队标记的 F1/F2 blocker，已被正确规避。

**给后续维护者的注意项**

1. **`tools` / `additionalMessages` 目前靠手工透传到 7 处 `measureContext`。** 新增任何一条重测路径而忘记带上，就会**静默**重现 D1 刚修掉的那类不同量纲 bug——类型系统在这里帮不上忙（它们是可选/同型参数）。若后续压缩批次要动这条链，建议把三者收成一个显式的 measurement request 对象一次构造。
2. **同一条产品规则（子代理不可走静态/手动路径）现在有三处实现、两种失败形态**：`composition.resolvePrimaryContextTools` 抛错、`ui-inprocess.getContextWindowUsageInternal` 返回 `null`、`assertCanUseAsPrimarySession` 抛错。分层理由成立（适配层守 nullable 合同，编排层守内部不变量），但语义分叉需要留意，别再加第四处。
3. **`getContextWindowUsageInternal` 现在即使 tracker 命中也要先 await 两次 session 查询**（为了在读 cache 前判 child）。cache-first 的热路径多了一次 IO。当前无性能问题，但它与「cache-first」的初衷有轻微张力。
4. **manual `compact()` 不传 `projectForUsage`，`prepareTurn()` 传**。这是**存量**差异（本批未引入），意味着手动压缩的中间重测不做 mask/reduce 投影。留给第 3 批压缩闭环审查。
5. child window query 从「错误数字」变成 `null` 不可回滚成伪精度。将来若真要做子代理静态占用，必须传 `contextScopeId`（或 `subagentId`）并从 record 解析 role，不能只读 Session。

---

## 5.5 实施成果（对照 04）

### 5.5.1 发布门复跑（验收方本地独立执行）

| 命令 | 结果 |
|------|------|
| `pnpm run typecheck` | **通过** |
| `manager` / `lifecycle` / `composition` / `service` 四个 unit 文件 | **通过**（254 passed） |
| `ui-inprocess.contract.test.ts` | **通过**（107 passed） |
| `tests/integration/core/context-improve-4-1` + `context-subagent-scope` | **通过**（3 passed） |
| `pnpm run test:integration` | 44 文件中 42 通过；**2 个失败与本批无关**：`project.integration.test.ts`（`git init` 权限）与 `cli/packaging-smoke`（npm 安装超时），均为验收环境沙箱限制，去沙箱后相关用例通过 |

实施记录中的 `pnpm test` 全量（2515 passed）、`lint`、`build` 与 Prettier 基线例外（43 个既有未改文件不合规、与本批 diff 交集为 0）未由验收方重跑，采信实施记录。

### 5.5.2 验收项结果

| ID | 结果 | 证据 |
|----|------|------|
| TC-1 | 通过（证据偏弱） | `manager.unit.test.ts:374` 断言含 tools 的 `currentTokens` 严格更大；`:345` 断言 `tools:[]` 与无 tools 等价。未直接断言 payload 上 `tools` 键显式存在 |
| TC-2 | **通过（强）** | `manager.unit.test.ts:374` 用 factor≈1.5（非 1，能区分两种公式）断言 `currentTokens === round(sentHeuristic × 1.5)`，而 `sentHeuristic` 已含 tools。若实现为「先算 messages 再加一遍 tools」会失败 |
| TC-3 | 通过（证据偏弱） | `provider.test.ts:13` 正向验证 `build({ toolNames })` 输出工具列表；「不存在 `toolsProvider` 回落」靠 rg 而非测试 |
| TC-4 | **通过（强）** | `lifecycle.unit.test.ts:315` + 集成 `context-improve-4-1:90`：prompt names、measurement schemas、provider schemas 同源 |
| TC-5 | **通过（强，本批最高风险项）** | `lifecycle.unit.test.ts:972, 1095` + 集成 `:90`：final step `toolNames: ["read_file"]` **非空**、measurement/provider `tools: []`、system prompt 仍含 `Available tools: read_file` |
| TC-6 | 通过 | `manager.unit.test.ts:654` 同 child session 的 scope A/B 各用自己的 factor |
| TC-7 | 通过 | `context-subagent-scope.integration.test.ts:26` scope A 压缩不污染 B；`generateSummary` 仅 1 次 |
| TC-8 | 通过（证据偏弱） | `manager.unit.test.ts:1980` 观测 4 次重测且均以同一 `JSON.stringify(tools)` 结尾——是 spy 实现细节，非各阶段数值行为断言 |
| TC-9 | 通过 | `composition.unit.test.ts:544` primary 自定义 `agentName:"plan"` 决定 names/schemas 并分别下发 |
| TC-10 | 通过（证据偏弱） | `ui-inprocess.contract.test.ts:2159` 先以 primary 查询（写入 tracker）再转 child 返回 `null`；未断言 tracker 内确有非空 token 值 |
| TC-11 | 通过（证据偏弱） | `packages/ohbaby-sdk/src/context-window.contract.test.ts:76` 参数仅 `sessionId`；无身份字段靠 rg |
| TC-12 | 通过 | `service.unit.test.ts:797, 888`：只调 `getContextWindowUsage`，`data` 无 `context` |
| TC-13 | 通过 | 集成 `:220`：compact 后追加大量未测 history，`/status` 仍返回 `usageAfter`，无二次计算 |
| TC-14 / TC-15 | 通过 | `ui-inprocess.contract.test.ts:2477, 2570` + 集成 `:220`：tracker 值来自 `usageAfter`；`context.window.updated` 恰好 1 次且同值 |
| TC-16 | **未自动化** | 仅人工 rg + 双 reviewer。验收方复跑 rg 确认干净（`toolsProvider`/`RequestPayload`/cache 字段/`breakdown`/commands 内 `getContextUsage` 均 0 命中），但 CI 中无守卫 |
| I-1 | 通过（有偏差） | 落在 `context-improve-4-1.integration.test.ts:90`，**不是** 04 §4.3 指定的 `lifecycle-tool-scheduler.integration.test.ts`；`resolveTools` 为 mock（非真实 scheduler），工具数 1 个（文档要求 2 个） |
| I-2 | 通过 | 完整闭环：static 含 schemas → compact → `usageAfter < usageBefore` → status 读 tracker |
| I-3 | 通过（微偏差） | 两 scope 的 `agentName` 均为 `"explore"`，未按文档用不同 role；scope 隔离断言仍有效 |

### 5.5.3 回归

`AssembledContext` 无 tools；`measureUsage` 仍是唯一占用算法入口；EMA α/clamp/scope key 未变；`COMPRESSION_THRESHOLD` 仍 0.95；prune/summary/mask 算法未改；SDK shape 未变；无 migration；primary 加载 memory、subagent 不加载；status panel 与占用条继续消费 `contextWindow`。**均通过。**

`/status.data.context` 与 `CommandServiceOptions.getContextUsage` 删除后全仓无残留消费者（TUI `status-panel.ts`、`command-panel-manager.tsx`、Web `slashCommands.ts` 均读 `contextWindow`）——**无 dangling consumer**。

### 5.5.4 残余风险与保留项

| ID | 发现 | 严重性 | SWE 依据 | 建议 |
|----|------|--------|----------|------|
| F1 | `tools` / `additionalMessages` 手工透传 7 处重测，漏传即静默不同量纲 | major（可维护性） | 这是「同一决策散落多处」的典型；D1 修的正是这个 bug 类，机制未消除，只是当前全部补齐 | 第 3 批压缩审查时把 measurement request 收成一次构造的对象 |
| F2 | TC-16 无自动化守卫 | minor | 范围约束靠人工 rg，随时间失效 | 加一条测试或 CI 脚本断言 04 §4.7 的 rg 期望；对 `COMPRESSION_THRESHOLD` 加常量锁 |
| F3 | I-1 未按 04 接真实 scheduler，且只用 1 个工具 | minor | mock 掉 `resolveTools` 后，「同源」验证的是接线而非真实解析 | 在 `lifecycle-tool-scheduler.integration.test.ts` 用 2 个真实 builtin 工具重做 I-1 |
| F4 | 文档阈值出现**新的**交叉不一致 | minor | `architecture.md` 改为 95%、代码 0.95，但 `goals-duty.md` 仍写 85%（`:27`、`:84`、`:167`） | 本批消除了 doc-code 不一致却制造了 doc-doc 不一致。G2/D3 的 85% 修订被 02 明令禁止，故需单独一刀统一，别留着 |
| F5 | TC-8 / TC-10 / TC-3 / TC-11 证据为 spy 或 rg，非行为断言 | minor | 锁实现细节的测试在重构时既会误报也会漏报 | 见 §5.5.2 各条注 |
| F6 | 同一产品规则三处实现、两种失败形态 | minor | 分层理由成立，但语义分叉 | 不再新增第四处；如需扩散，先抽 primary-session helper |
| F7 | tracker 命中仍先做两次 session 查询 | 极低 | 与 cache-first 初衷有张力 | 当前无需处理，占用 UI 批次若上高频轮询再看 |

**无 blocker、无 major 行为缺陷。** F1 是唯一 major，且属可维护性而非正确性。

### 5.5.5 SWE 层面评估（聚焦改动面）

大白话结论：**这批改得比规划更狠、也更对。** 三个地方值得肯定。

第一，它没有掉进规划期红队标记的那个坑。`toolNames` 从**完整**解析结果派生，`tools` 才在 final step 清空（`lifecycle.ts:396-407`），而且 Lifecycle 的 `resolveTools` 直接包了 composition 的同一个 `resolvePromptTools`——所以「一次解析、两处派生」是真的同源，不是文档里的说法。这条路径一旦写错就会静默清空 system prompt 的工具列表，是本批唯一能造成用户可见损坏的地方，它有集成级行为断言守着。

第二，`additionalMessages` 这个规划里没有的改动，方向上比规划更彻底。原来 finalization message 在计量之后才追加，等于 provider 收到的载荷比校准分母多一条消息——本批主旨就是「口径统一」，这属于同一个 bug 家族里规划漏掉的一员。发现它并顺着 7 处重测全部补齐，是扎实的活。

第三，把 `assemble` / `getUsage` / `CompactOptions` 全部从位置参数改成 options，并让 `tools` 成为**必填但可空**的属性。这是在用类型系统防「漏传即静默少算」——正是 P1/P6 那类 bug 的成因（`compact()` 当初就是因为 `agentName` 排到第五个位置参数而被忘掉）。这是消除偶然复杂度，不是加抽象。

需要如实指出的一处：**F1 的机制没有被消除。** `tools` 和 `additionalMessages` 现在靠人工透传到 7 处 `measureContext`，全靠这次逐一补齐。类型系统在这里帮不上忙——两个都是可选/同型参数，漏一处不会编译失败，只会让某条路径的数字悄悄偏掉。这批修的就是这个 bug，机制却仍在。不必现在返工（改动面会溢出到压缩逻辑），但第 3 批压缩审查必须把它收口。

范围纪律良好：生产代码零越界，cache/breakdown/threshold/tokenizer/mask/SDK/migration 全部未动。越界仅在文档与一处测试补参，都是 minor。唯一值得吐槽的是 F4——为了消灭 `architecture.md` 与代码的阈值不一致，却因为 02 禁止改 `goals-duty.md` 的 85% 而制造了文档之间的新矛盾。这种「修一半」的一致性比原来的不一致更容易误导人，应当单独一刀补完。

---

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|------|----------|------|
| [../../../packages/ohbaby-agent/src/core/context/types.ts](../../../packages/ohbaby-agent/src/core/context/types.ts) | 新增 `ContextMeasurementPayload`、`ContextAssemblyOptions`；`CompactOptions` 补 `agentName`/`toolNames`/`tools`；`PrepareTurnInput` 补 `toolNames`/`additionalMessages` 且 `tools` 转必填；`assemble`/`getUsage` 改对象参数 | 修改 |
| [../../../packages/ohbaby-agent/src/core/context/context-manager.ts](../../../packages/ohbaby-agent/src/core/context/context-manager.ts) | `measureUsage` 收 payload；`renderForModel` 追加 `additionalMessages`；7 处重测统一带 tools；`compact()` 补传 `agentName`/`toolNames`/`tools` | 修改 |
| [../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts](../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) | 每步先解析完整 tools 再派生 names；final step 仅清 outbound schemas；`messagesForStep` 改为仅请求期 `additionalMessages` | 修改 |
| [../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts](../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts) | 删除 `toolsProvider`，改为必填 `toolNames` 入参 | 修改 |
| [../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) | 新增 `resolvePrimaryContextTools`；删除 `toolsProvider` 接线；`getContextUsage`/`compactSession` 下发 names+schemas | 修改 |
| [../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts](../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) | child 检查前置于 tracker；compact 后更新 tracker 并发布 window 事件；删除 `getContextUsage`；guard 文案按操作区分 | 修改 |
| [../../../packages/ohbaby-agent/src/commands/builtin.ts](../../../packages/ohbaby-agent/src/commands/builtin.ts) | `/status` 只输出 `contextWindow` | 修改 |
| [../../../packages/ohbaby-agent/src/commands/types.ts](../../../packages/ohbaby-agent/src/commands/types.ts) | 删除 `CommandServiceOptions.getContextUsage` | 修改 |
| [../../../tests/integration/core/context-improve-4-1.integration.test.ts](../../../tests/integration/core/context-improve-4-1.integration.test.ts) | I-1 工具数据流 + I-2 compact→status 闭环 | 新增 |
| [../../../tests/integration/core/context-subagent-scope.integration.test.ts](../../../tests/integration/core/context-subagent-scope.integration.test.ts) | I-3 共享 child session 的 scope 隔离自动压缩 | 新增 |
| [../architecture.md](../architecture.md) | measurement/transport 与 primary/scoped 分界；阈值示例 85%→95%（见 F4） | 修改 |
| [../goals-duty.md](../goals-duty.md) | D2 补 tools-aware measurement；D1 子代理段扩展（超授权，见 D4） | 修改 |

---

## 5.7 后续建议顺序

不阻塞本批合并；F1/F2/F3/F4 建议按下列时机处理，而非现在返工。

1. **单独一小刀**：统一 `goals-duty.md` 的 85% 与代码 0.95（F4）。它现在是文档间互相矛盾，比原来的 doc-code 不一致更误导人。
2. **第 3 批 context 压缩闭环审查**：把 measurement request 收成一次构造的对象（F1）；顺带处理 manual compact 缺 `projectForUsage` 的存量差异。
3. **补测试**：I-1 接真实 scheduler + 2 个工具（F3）；TC-16 加自动化范围守卫（F2）。可并入第 3 批。
4. improve-5：prompt cache 观测与计费。**占用分母以本批的 `measureUsage({messages, tools})` 为准，不得改成「仅 uncached」。**
5. cache 完成后复核压缩闭环，再进入主代理占用监测与 UI，最后 memory / 长期记忆。
