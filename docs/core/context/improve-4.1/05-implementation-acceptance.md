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
| **结论** | **通过（有保留项）**。三个 Phase 全部落地，最高风险项（final step prompt 工具名）实现正确且有集成级行为断言；无生产代码越界。保留项已校准为下一轮设计决策与可选测试增强，均不阻塞合并 |

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
| 实际 | 改为仅请求期 `additionalMessages`，在 `renderForModel` 中追加，贯穿全部相关请求期计量路径并进入 `prepared.messages` |
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

1. **当前数据流完整，但 `additionalMessages` 仍靠手工透传。** `tools` 已是必填属性，遗漏会在编译期暴露；`additionalMessages` 仍为可选属性，新增请求期重测路径时若忘记透传，才可能静默重现 D1 的不同量纲问题。若后续压缩批次要动这条链，建议把完整 measurement request 一次构造，或把 `additionalMessages` 改为“属性必填、值可空”。
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
| `manager` / `lifecycle` / `composition` / `service` 四个 unit 文件 | **通过**（152 passed） |
| `ui-inprocess.contract.test.ts` | **通过**（107 passed） |
| `tests/integration/core/context-improve-4-1` + `context-subagent-scope` | **通过**（3 passed） |
| `pnpm run test:integration` | 44 文件中 42 通过；**2 个失败与本批无关**：`project.integration.test.ts`（`git init` 权限）与 `cli/packaging-smoke`（npm 安装超时），均为验收环境沙箱限制，去沙箱后相关用例通过 |

实施记录中的 `pnpm test` 全量（2515 passed）、`lint`、`build` 与 Prettier 基线例外（43 个既有未改文件不合规、与本批 diff 交集为 0）未由验收方重跑，采信实施记录。

### 5.5.2 验收项结果

| ID | 结果 | 证据 |
|----|------|------|
| TC-1 | 通过 | `manager.unit.test.ts:374` 断言含 tools 的 `currentTokens` 严格更大；`:345` 断言 `tools:[]` 与无 tools 等价；`tools` 属性必填由 TypeScript 契约保证 |
| TC-2 | **通过（强）** | `manager.unit.test.ts:374` 用 factor≈1.5（非 1，能区分两种公式）断言 `currentTokens === round(sentHeuristic × 1.5)`，而 `sentHeuristic` 已含 tools。若实现为「先算 messages 再加一遍 tools」会失败 |
| TC-3 | 通过（contract + rg） | `provider.test.ts:13` 正向验证 `build({ toolNames })` 输出工具列表；移除 `toolsProvider` 属结构性约束，使用 rg 验证合适 |
| TC-4 | **通过（强）** | `lifecycle.unit.test.ts:315` + 集成 `context-improve-4-1:90`：prompt names、measurement schemas、provider schemas 同源 |
| TC-5 | **通过（强，本批最高风险项）** | `lifecycle.unit.test.ts:972, 1095` + 集成 `:90`：final step `toolNames: ["read_file"]` **非空**、measurement/provider `tools: []`、system prompt 仍含 `Available tools: read_file` |
| TC-6 | 通过 | `manager.unit.test.ts:654` 同 child session 的 scope A/B 各用自己的 factor |
| TC-7 | 通过 | `context-subagent-scope.integration.test.ts:26` scope A 压缩不污染 B；`generateSummary` 仅 1 次 |
| TC-8 | 通过 | `manager.unit.test.ts:1980` 观测四个内部计量阶段均使用同一 tools，并同时断言 `usageAfter < usageBefore`；阶段观察与行为结果互相补足 |
| TC-9 | 通过 | `composition.unit.test.ts:544` primary 自定义 `agentName:"plan"` 决定 names/schemas 并分别下发 |
| TC-10 | 通过 | `ui-inprocess.contract.test.ts:2159` 先以 primary 查询得到非空结果并写入 tracker，再把同一 session 转为 child，确认仍返回 `null`，覆盖 cache 命中前的 child guard |
| TC-11 | 通过（contract + rg） | `packages/ohbaby-sdk/src/context-window.contract.test.ts:76` 固定 SDK 参数仅含 `sessionId`；无身份字段属于协议形状约束，使用 contract + rg 验证合适 |
| TC-12 | 通过 | `service.unit.test.ts:797, 888`：只调 `getContextWindowUsage`，`data` 无 `context` |
| TC-13 | 通过 | 集成 `:220`：compact 后追加大量未测 history，`/status` 仍返回 `usageAfter`，无二次计算 |
| TC-14 / TC-15 | 通过 | `ui-inprocess.contract.test.ts:2477, 2570` + 集成 `:220`：tracker 值来自 `usageAfter`；`context.window.updated` 恰好 1 次且同值 |
| TC-16 | 通过（按计划为 rg/review） | 04 §4.7 将其定义为范围审计，验收方复跑 rg 确认干净（`toolsProvider`/`RequestPayload`/cache 字段/`breakdown`/commands 内 `getContextUsage` 均 0 命中）。这些边界未来会被 improve-5 与阈值审查合法改变，不设置永久负向 CI 锁 |
| I-1 | 通过（有偏差） | 落在 `context-improve-4-1.integration.test.ts:90`，**不是** 04 §4.3 指定的 `lifecycle-tool-scheduler.integration.test.ts`；`resolveTools` 为 mock（非真实 scheduler），工具数 1 个（文档要求 2 个） |
| I-2 | 通过 | 完整闭环：static 含 schemas → compact → `usageAfter < usageBefore` → status 读 tracker |
| I-3 | 通过（微偏差） | 两 scope 的 `agentName` 均为 `"explore"`，未按文档用不同 role；scope 隔离断言仍有效 |

### 5.5.3 回归

`AssembledContext` 无 tools；`measureUsage` 仍是唯一占用算法入口；EMA α/clamp/scope key 未变；`COMPRESSION_THRESHOLD` 仍 0.95；prune/summary/mask 算法未改；SDK shape 未变；无 migration；primary 加载 memory、subagent 不加载；status panel 与占用条继续消费 `contextWindow`。**均通过。**

`/status.data.context` 与 `CommandServiceOptions.getContextUsage` 删除后全仓无残留消费者（TUI `status-panel.ts`、`command-panel-manager.tsx`、Web `slashCommands.ts` 均读 `contextWindow`）——**无 dangling consumer**。

### 5.5.4 残余风险与保留项

| ID | 发现 | 严重性 | SWE 依据 | 建议 |
|----|------|--------|----------|------|
| F1 | 当前数据流完整；仅可选的 `additionalMessages` 仍由相关请求期计量路径手工透传 | minor（设计债） | `tools` 在 `CompactOptions`、`PrepareTurnInput`、`getUsage` 与 `measureContext` 均为必填，遗漏会编译失败；未来新增路径时只有可选消息仍可能被静默漏传 | 下一轮压缩审查时把 measurement request 收成一次构造的对象，或令 `additionalMessages` 属性必填、值可空 |
| F3 | I-1 未按 04 接真实 scheduler，且只用 1 个工具 | minor | mock 掉 `resolveTools` 后，「同源」验证的是接线而非真实解析 | 在 `lifecycle-tool-scheduler.integration.test.ts` 用 2 个真实 builtin 工具重做 I-1 |
| F4 | 产品目标 85% 与当前实现 95% 尚未正式统一 | minor（待决策） | `goals-duty.md` 保留产品目标，代码与 `architecture.md` 记录当前实现；这是待决策差异，不应直接用现状覆盖目标 | 已在 `architecture.md` 显式标注；下一轮压缩闭环审查中决定改代码还是修订目标 |
| F6 | 同一产品规则三处实现、两种失败形态 | minor | 分层理由成立，但语义分叉 | 不再新增第四处；如需扩散，先抽 primary-session helper |
| F7 | tracker 命中仍先做两次 session 查询 | 极低 | 与 cache-first 初衷有张力 | 当前无需处理，占用 UI 批次若上高频轮询再看 |

原 F2（TC-16 未固化为 CI）不再保留：TC-16 本就按 04 设计为 rg/review，且 improve-5 与阈值审查会合法改变其中部分负向条件。原 F5（若干证据“偏弱”）也不再保留：TC-8/TC-10 同时具备行为结果，TC-3/TC-11 的结构性约束使用 contract + rg 合理。

**无 blocker、无 critical/major 保留项。** 当前行为与数据流正确；F1/F4 是下一轮压缩闭环应处理的设计议题，其余为可选增强或观察项。

### 5.5.5 SWE 层面评估（聚焦改动面）

大白话结论：**这批改得比规划更狠、也更对。** 三个地方值得肯定。

第一，它没有掉进规划期红队标记的那个坑。`toolNames` 从**完整**解析结果派生，`tools` 才在 final step 清空（`lifecycle.ts:396-407`），而且 Lifecycle 的 `resolveTools` 直接包了 composition 的同一个 `resolvePromptTools`——所以「一次解析、两处派生」是真的同源，不是文档里的说法。这条路径一旦写错就会静默清空 system prompt 的工具列表，是本批唯一能造成用户可见损坏的地方，它有集成级行为断言守着。

第二，`additionalMessages` 这个规划里没有的改动，方向上比规划更彻底。原来 finalization message 在计量之后才追加，等于 provider 收到的载荷比校准分母多一条消息——本批主旨就是「口径统一」，这属于同一个 bug 家族里规划漏掉的一员。发现它并沿全部相关请求期计量路径补齐，是扎实的活。

第三，把 `assemble` / `getUsage` / `CompactOptions` 全部从位置参数改成 options，并让 `tools` 成为**必填但可空**的属性。这是在用类型系统防「漏传即静默少算」——正是 P1/P6 那类 bug 的成因（`compact()` 当初就是因为 `agentName` 排到第五个位置参数而被忘掉）。这是消除偶然复杂度，不是加抽象。

需要如实指出的一处：**F1 只剩 `additionalMessages` 的可选透传风险。** `tools` 在相关 options、公开计量入口与内部 `measureContext` 上都是必填属性，遗漏会编译失败；当前所有数据流也已补齐。可选的 `additionalMessages` 仍可能在未来新增请求期计量路径时被漏传。不必现在返工（改动面会溢出到压缩逻辑），但下一轮压缩审查应通过一次构造 measurement request，或“属性必填、值可空”的契约把它收口。

范围纪律良好：生产代码零越界，cache/breakdown/threshold/tokenizer/mask/SDK/migration 全部未动。越界仅在文档与一处测试补参，都是 minor。F4 不是可以机械“统一”的文字错误：`goals-duty.md` 的 85% 是产品目标，0.95 是当前实现。`architecture.md` 现已明确区分两者；最终选择留给下一轮压缩闭环审查，避免用代码现状反向覆盖尚未决策的目标。

---

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|------|----------|------|
| [../../../../packages/ohbaby-agent/src/core/context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) | 新增 `ContextMeasurementPayload`、`ContextAssemblyOptions`；`CompactOptions` 补 `agentName`/`toolNames`/`tools`；`PrepareTurnInput` 补 `toolNames`/`additionalMessages` 且 `tools` 转必填；`assemble`/`getUsage` 改对象参数 | 修改 |
| [../../../../packages/ohbaby-agent/src/core/context/context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts) | `measureUsage` 收 payload；`renderForModel` 追加 `additionalMessages`；全部相关请求期计量路径统一带 tools；`compact()` 补传 `agentName`/`toolNames`/`tools` | 修改 |
| [../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) | 每步先解析完整 tools 再派生 names；final step 仅清 outbound schemas；`messagesForStep` 改为仅请求期 `additionalMessages` | 修改 |
| [../../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/assembler.ts) | 删除 `toolsProvider`，改为必填 `toolNames` 入参 | 修改 |
| [../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) | 新增 `resolvePrimaryContextTools`；删除 `toolsProvider` 接线；`getContextUsage`/`compactSession` 下发 names+schemas | 修改 |
| [../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) | child 检查前置于 tracker；compact 后更新 tracker 并发布 window 事件；删除 `getContextUsage`；guard 文案按操作区分 | 修改 |
| [../../../../packages/ohbaby-agent/src/commands/builtin.ts](../../../../packages/ohbaby-agent/src/commands/builtin.ts) | `/status` 只输出 `contextWindow` | 修改 |
| [../../../../packages/ohbaby-agent/src/commands/types.ts](../../../../packages/ohbaby-agent/src/commands/types.ts) | 删除 `CommandServiceOptions.getContextUsage` | 修改 |
| [../../../../tests/integration/core/context-improve-4-1.integration.test.ts](../../../../tests/integration/core/context-improve-4-1.integration.test.ts) | I-1 工具数据流 + I-2 compact→status 闭环 | 新增 |
| [../../../../tests/integration/core/context-subagent-scope.integration.test.ts](../../../../tests/integration/core/context-subagent-scope.integration.test.ts) | I-3 共享 child session 的 scope 隔离自动压缩 | 新增 |
| [../architecture.md](../architecture.md) | measurement/transport 与 primary/scoped 分界；阈值示例 85%→95%（见 F4） | 修改 |
| [../goals-duty.md](../goals-duty.md) | D2 补 tools-aware measurement；D1 子代理段扩展（超授权，见 D4） | 修改 |

---

## 5.7 后续建议顺序

不阻塞本批合并；F1/F3/F4 建议按下列时机处理，而非现在返工。

1. **下一轮 context 压缩闭环审查**：正式决定自动压缩阈值采用 85% 产品目标还是 95% 当前实现（F4）；把 measurement request 收成一次构造的对象（F1）；顺带处理 manual compact 缺 `projectForUsage` 的存量差异。
2. **可选测试增强**：若下一轮认为收益足够，再在 `lifecycle-tool-scheduler.integration.test.ts` 以真实 scheduler + 2 个工具增强 I-1（F3）。TC-16 维持 rg/review，不建立会阻碍 improve-5 与阈值决策的永久负向锁。
3. improve-5：prompt cache 观测与计费。**占用分母以本批的 `measureUsage({messages, tools})` 为准，不得改成「仅 uncached」。**
4. cache 完成后复核压缩闭环，再进入主代理占用监测与 UI，最后 memory / 长期记忆。
