研究完成。以下为完整报告。

---

# claude-code-best 上下文管理/压缩/缓存/会话记忆/子代理隔离 调研报告

## 断言核实表

| # | 断言 | 结论 | 证据 |
|---|------|------|------|
| 1 | `autoCompact.ts:28` 为 compaction/output 预留 token | **属实** | `src/services/compact/autoCompact.ts:28-30`：注释 "Reserve this many tokens for output during compaction" + `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`（基于 p99.99 压缩输出 17,387 tokens 的观测）。实际扣减发生在 `getEffectiveContextWindowSize()`（:33-49）：`contextWindow - Math.min(getMaxOutputTokensForModel(model), 20_000)` |
| 2 | `autoCompact.ts:96-99,286-291` 连续三次自动压缩失败后 circuit breaker | **属实** | :96-99 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（注释：BQ 2026-03-10 曾有 1,279 个 session 累计 50+ 次连续失败、最高 3,272 次，全局浪费 ~25 万次 API 调用/天）；:289-294 到达阈值直接返回不压缩；失败计数 :363-378 递增、成功 :361 归零，经 `query.ts:734-741` 线程化传回 tracking |
| 3 | `sessionMemory.ts:136-168` extraction 有 token/tool thresholds | **属实** | `shouldExtractMemory()`（:135-182）：初始化阈值（总 context ≥10K tokens）、更新阈值（自上次提取增长 ≥5K，**永远必需**）、工具调用阈值（≥3 次）；触发条件 = (token∧tool) ∨ (token∧最后一个 assistant 无工具调用)。默认值在 `sessionMemoryUtils.ts:32-36` |
| 4 | `promptCacheBreakDetection.ts:101,149` 按 query source/agent 跟踪 cache baseline | **属实** | :101 `previousStateBySource = new Map<string, PreviousState>()`（baseline 字段 `prevCacheReadTokens`:64）；:149-158 `getTrackingKey()`：`compact` 映射到 `repl_main_thread` 共享跟踪，白名单前缀（repl_main_thread/sdk/agent:custom/agent:default/agent:builtin）内按 `agentId` 隔离（防同类型多子代理并发误报） |
| 5 | 同文件 `:191-195,264-303` 对 tools/system/cache-relevant input 哈希并限制跟踪来源数量 | **属实** | :187-196 `computePerToolHashes`（逐工具 schema 哈希，用于指出哪个工具描述变了）；:264-292 `getTrackingKey` → `stripCacheControl` → `systemHash`/`toolsHash`/`cacheControlHash`(含 cache_control 的 scope/TTL 翻转)/`extraBodyHash`；:107 `MAX_TRACKED_SOURCES = 10` + :297-301 FIFO 驱逐（每条 ~300KB+ diffableContent，防子代理撑爆内存） |
| 6 | 同文件 `:469-486,684-699` microcompact/compaction 后重置 baseline | **属实** | :469-480 `cacheDeletionsPending` 分支：cached microcompact 发 `cache_edits` 删除后 cache read 合法下降，消费一次后清标志+清 pendingChanges+不判 break；:688-697 `notifyCompaction()`：`state.prevCacheReadTokens = null`（下次跳过首调无对比值的检查 :464-465）。调用方：`compact.ts:727-732`、`autoCompact.ts:331-333`（SM 压缩路径，注释：漏掉曾造成 20% 的 break 事件误报）、`microCompact.ts:366-371`（notifyCacheDeletion） |
| 7 | `contextCollapse/index.ts:1` 是 auto-generated stub、函数基本 no-op | **属实** | :1 即 "// Auto-generated stub — replace with real implementation"；`getStats` 全零（:30-41）、`applyCollapsesIfNeeded` 恒等返回（:52-56）、`isWithheldPromptTooLong` 恒 false（:58-62）、`recoverFromOverflow` 恒 `{committed:0}`（:64-67）、`subscribe` 返回 no-op 退订（:49-50）、`reset/initContextCollapse` 仅翻转布尔（:69-75）。`persist.ts`、`operations.ts` 同为 stub（各 3/5 行） |

---

## A. Auto compact 完整决策链

**阈值计算**（`src/services/compact/autoCompact.ts`）：
- 有效窗口：`getEffectiveContextWindowSize(model)` = context window − min(model max output, 20K)（:33-49）；可用 env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 收窄窗口（:40-46）
- 触发 buffer 按窗口分级：默认 13K；有效窗口 ≥400K → 30K；≥800K → 50K（`getAutocompactBufferTokens` :77-82）
- **触发阈值** = 有效窗口 − buffer（`getAutoCompactThreshold` :101-120，测试可用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`）
- 辅助阈值：warning/error = threshold − 20K（:63-64）；blocking limit = 有效窗口 − 3K（manual compact 预留，:65,151-165）
- 闸门：`DISABLE_COMPACT`/`DISABLE_AUTO_COMPACT`/用户配置 `autoCompactEnabled`（:176-187）；递归守卫排除 `session_memory`/`compact` fork 代理及 ctx-agent `marble_origami`（:200-212）

**触发时机**（`src/query.ts` while(true) 主循环 :460-2056，每迭代 = 一次 API round）：
1. 每轮 API 调用**前**依次执行：snip（:589-598）→ microcompact（:602-624）→ context collapse 投影（:638-645，stub）→ **proactive autocompact**（`deps.autocompact` :652-665）→ blocking-limit 预检（:826-846）→ **predictive autocompact**（:852-888，`currentTokens > 有效窗口 − estimateMaxTurnGrowth()`，其中增长估算 = min(maxOut,20K)+15K 工具结果增长，autoCompact.ts:88-94）→ API 调用
2. 即：压缩发生在 **round 边界**（turn 间的首轮前 + turn 内每个工具轮次前），不在流中；压缩产物 `buildPostCompactMessages` 立即替换 `messagesForQuery`（:726-733），**同一迭代内直接用压缩后消息发起本次 API 调用**
3. 第三条路径：**reactive compact**——API 返回 prompt-too-long（错误被扣留不进流）后 `tryReactiveCompact`（:1406-1452）压缩并 `continue` 重试，`hasAttemptedReactiveCompact` 防死循环
4. 优先级实验：auto compact 先试 session-memory compaction（autoCompact.ts:317-339，无 API 调用、保近保留段，详见 sessionMemoryCompact.ts:573-616 的 min 10K tokens/5 条文本消息/max 40K 保留规则），失败再走 `compactConversation`

## B. Manual /compact 与 auto compact 的关系

**共享核心路径**：两者最终都调 `compactConversation()`（`compact.ts:411-792`）——同一摘要生成、同一 `buildPostCompactMessages`（:336-343，顺序固定：boundaryMarker → summaryMessages → messagesToKeep(剥离 toolUseResult) → attachments → hookResults）、同一 PreCompact/PostCompact/SessionStart hooks（trigger 字段区分 auto/manual :437-443,619-621,752-758）。差异：
- `/compact` 命令（`commands/compact/compact.ts:42-145`）：先试 SM compaction（无自定义指令时）→ 先跑 `microcompactMessages` → `compactConversation(..., isAutoCompact=false)`，错误会以通知形式显示（compact.ts:778-784，auto 失败不显示）
- auto compact（`autoCompact.ts:341-350`）：microcompact 已在 query loop 前置完成；`isAutoCompact=true` 抑制追问
- manual 额外把 slash 命令消息并入 `messagesToKeep`（`processSlashCommand.tsx:880-913`）并 `resetMicrocompactState()`

**投影/测量一致**：token 计数统一 `tokenCountWithEstimation`；snip 释放量 `snipTokensFreed` 在两条路径都参与（query.ts:652-664, 836；commands/compact/compact.ts:48 先投影 compact boundary 之后的消息）

**并发隔离**：无显式互斥锁。串行化是结构性的——(a) auto compact 在 query 生成器循环内 await，天然与 API 调用串行；(b) manual /compact 在 REPL 输入处理路径内 `await mod.call()`（processSlashCommand.tsx:869），仅当无进行中 query 时执行（REPL isLoading 门控）；(c) REPL 收到 boundary 时一次性 `setMessages(() => [newMessage])` 原子替换消息数组（REPL.tsx:3157-3188）；(d) session memory 后台提取用 `sequential()` 队列包装防重入（sessionMemory.ts:273 + utils/sequential.ts:19-56）；(e) `trySessionMemoryCompaction` 会 `waitForSessionMemoryExtraction()`（15s 超时/1s stale 检测，sessionMemoryUtils.ts:89-105）等在途提取完成

## C. 压缩持久化写入顺序

**不删旧消息，append-only + 边界标记逻辑截断**：
1. 摘要 API 成功后（内存中）构造 CompactionResult；boundary 上可带 `compactMetadata.preservedSegment`（head/anchor/tail uuid，compact.ts:373-391）供 loader 重链
2. query loop 逐条 `yield` post-compact 消息（query.ts:728-730）；REPL `handleMessageFromStream` 收到 boundary 时替换数组（REPL.tsx:3157-3188）
3. 持久化由 `useLogMessages` 检测“首消息 uuid 变化 = 压缩”触发（useLogMessages.ts:27-29,40-47），调 `recordTranscript`（sessionStorage.ts:1445-1486）——**单次** `insertMessageChain` 批量追加“新消息”（boundary+summary+attachments+hooks），`messagesToKeep` 按 uuid 去重跳过（已在盘上）；**旧消息不删除**，boundary 的 `parentUuid=null` 在链上截断 `--continue`（:1442-1444 注释），读取侧 `getMessagesAfterCompactBoundary`（messages.ts:5083-5096，倒扫最近 boundary 切片）
4. 部分失败处理：写入 fire-and-forget（`void recordTranscript(...)`，useLogMessages.ts:69），失败即丢（无重试/事务）；压缩 API 自身失败有 PTL（prompt-too-long）重试：丢弃最老 API-round 组最多 3 次（compact.ts:231,474-515 `truncateHeadForPTLRetry`），streaming fallback 重试 2 次（:135,1291-1296）；SM compaction 失败返回 null 回退 legacy 路径（sessionMemoryCompact.ts:623-631）

## D. Prompt cache break detection 机制（`src/services/api/promptCacheBreakDetection.ts`）

- **两阶段**：Phase 1 pre-call `recordPromptState`（claude.ts:1546-1572 调用，排除 `defer_loading` 工具）记录并 diff 出 pendingChanges；Phase 2 post-call `checkResponseForCacheBreak`（claude.ts:2491-2501，用响应的 `usage.cache_read_input_tokens`）
- **baseline 维护**：per-key（source/agentId）`prevCacheReadTokens`；首调跳过（:464-465）；判 break = `cacheReadTokens < prev*0.95 && drop >= 2,000`（:120,484-491）
- **cache-relevant input（全部入哈希）**：system（剥 cache_control 后）、tools（聚合+逐工具）、含 cache_control 的 system 数组（抓 scope/TTL 翻转）、model、fastMode、globalCacheStrategy、betas 头、autoMode/overage/cachedMC 标志、effort、extraBodyParams（:267-292,330-344）
- **诊断输出**：`tengu_prompt_cache_break` 事件（全字段 :589-643）；`logForDebugging` 摘要（:656-659）；将 prev/new 的 system+tools 全文写 unified diff 到临时文件 `cache-break-XXXX.diff`（:707-726）；TTL 归因（距上一条 assistant 消息 >5min/>1h → "possible TTL expiry"；<5min 无变化 → "likely server-side" :564-587）
- **重置钩子**：`notifyCacheDeletion`（cached MC 删除）/`notifyCompaction`（压缩）/`cleanupAgentTracking`（子代理结束，runAgent.ts:854-856）；haiku 排除（:129-131）

## E. 主/子代理上下文隔离

- **上下文构造**（`packages/builtin-tools/src/tools/AgentTool/runAgent.ts`）：普通 Task/Agent 路径**不继承**父对话——`forkContextMessages: isForkPath ? toolUseContext.messages : undefined`（AgentTool.tsx:785）；子代理只拿 `[promptMessages]`（runAgent.ts:379-382）+ 自己的 agent 系统 prompt（:517-527,892-918）+ `resolveAgentTools` 解析的受限工具集（:509-511）+ 可选 agent model（:349-354）。read-only 代理（Explore/Plan）还会剥掉 CLAUDE.md（omitClaudeMd，:399-407）和 gitStatus（:413-419）省 token
- **隔离实现**：`createSubagentContext`（`src/utils/forkedAgent.ts:342-463`）——克隆 `readFileState`/`contentReplacementState`、新 agentId、独立 queryTracking chain（depth+1）、异步代理独立 AbortController、`setAppState` 等回调默认 no-op（sync 代理显式 opt-in 共享）、permission 上下文被包装（shouldAvoidPermissionPrompts / allowedTools 替换会话规则）
- **缓存共享 fork 路径**：`forkSubagent.ts`/`isForkPath` 时用父的 renderedSystemPrompt + `buildForkedMessages`（克隆父 assistant 的全部 tool_use + 占位 tool_result）+ `useExactTools` 继承 thinkingConfig，构造**逐字节相同前缀**打缓存（AgentTool.tsx:611-650, 769-786；runAgent.ts:318-323,688-693）。`CacheSafeParams` 类型即“缓存键五元组”定义（forkedAgent.ts:61-72）
- **结果回传**：子代理流式消息经 `finalizeAgentTool` 汇总，最终 assistant 文本 + `agentId`/`<usage>total_tokens/tool_uses/duration_ms</usage>` trailer 组成 tool_result 返回主代理（AgentTool.tsx:1429-1453,1545-1588）；空输出显式给 "(Subagent completed but returned no output.)"（:1550-1562）；一次性内置代理（Explore/Plan）去掉 trailer 省 token（:1563-1574）。异步代理经 `<task-notification>` 重新入队；子代理 transcript 写独立 sidechain 文件（runAgent.ts:744-751,820-828）
- **子代理会触发自己的 compact**：会——`shouldAutoCompact` 不排除 `agent:*` source；query.ts:564-566 按 `agent:` 前缀把 content-replacement 记录路由到 sidechain；runAgent.ts:697-703 注释明确“autocompact 会重写消息”（boundary 属可记录类型，isRecordableMessage :240-255）；`postCompactCleanup.ts:43-62` 对子代理压缩做专门防护：**仅主线程压缩才 reset 主线程 module-level 状态**（否则子代理压缩会摧毁主线程的 collapse store/CLAUDE.md 缓存）。但 cached microcompact 仅主线程可用（microCompact.ts:253-255,276-289）

## F. contextCollapse stub 状态

三个文件全部为占位（`index.ts` 75 行、`persist.ts` 3 行、`operations.ts` 5 行，首行均为 "// Auto-generated stub — replace with real implementation"）。证据：(1) `projectView` 恒等函数；(2) `recoverFromOverflow` 恒返回 `committed:0`；(3) `getStats` 全零；(4) `initContextCollapse` 仅置 `_contextCollapseEnabled = true`（setup.ts:300-306 调用），故 query.ts:816 的启用检查永远 false。但**接线完整保留**：query.ts:20-21,638-645,1055,1378-1404；autoCompact.ts:244-252 的 suppression 分支；postCompactCleanup.ts:54-62 的 reset；autoCompact.ts:204-212 注释还描述了上游真实实现的行为（collapse 的 90% commit / 95% blocking 阈值、模块级共享 committed log 被 fork 破坏的问题）——这是“真实现被剥离、外壳保留”的镜像状态

## G. Compact 测试覆盖（本镜像 tests/ + 各 __tests__）

- `src/services/compact/__tests__/cachedMicrocompact.test.ts`：cached MC 状态机——阈值上/下、最老优先删除、cache_edits 块结构、已删不重删、状态重置、模型支持判定（14 个用例）
- `snipCompact.test.ts`：snip 边界语义——无 boundary 不动、按 removedUuids 删、保留 boundary、多 boundary 取最后、tokensFreed 估算、空数组
- `snipProjection.test.ts` / `grouping.test.ts`（API-round 分组，PTL 重试的基础）/ `prompt.test.ts`（summary 格式化，`<analysis>`/`<summary>` 剥离）
- `src/components/__tests__/compactMessages.test.ts`：仅 UI 文案（错误提示/标题）
- `src/commands/summary/__tests__/summary.test.ts`：手动 SM 提取（含失败/空内容分支）
- `src/services/SessionMemory/__tests__/`：模板变量替换、multiStore
- `tests/integration/`（7 个文件）：**无 compact 场景**（message-pipeline 无 compact 关键字）
- **本镜像中不存在**：`autoCompact`（阈值/circuit breaker/predictive）、`promptCacheBreakDetection`、`sessionMemoryCompact`（保留段计算/adjustIndexToPreserveAPIInvariants）、`reactiveCompact`、`compactConversation` PTL 重试的直接单测——这些仅有内联注释引用的 BQ 数据佐证。若 ohbaby 回归测试要对标本仓库，compact 领域可对标的现成测试只有上述 cachedMicrocompact/snip/grouping/prompt 四组；断言 1-6 涉及的逻辑（circuit breaker、阈值分级、baseline 重置、MAX_TRACKED_SOURCES 驱逐）在本镜像**无测试覆盖**，需在 ohbaby 侧自建。

---

**给 ohbaby 对标审核的关键提示（本仓库有、易遗漏的机制）**：predictive autocompact（二次预估触发，query.ts:852-888）；SM-compaction-first 的分层压缩与 `waitForSessionMemoryExtraction` 等待；PTL 时压缩请求本身的截断重试（compact.ts:474-515）；compact 与 `repl_main_thread` 共享 cache 跟踪键（promptCacheBreakDetection.ts:153）；postCompactCleanup 的主线程/子代理状态隔离（postCompactCleanup.ts:43-62）；`tengu_compact` 事件的 `willRetriggerNextTurn` 自监控（compact.ts:685-687）；snip→microcompact→collapse→autocompact 的固定执行顺序与 `snipTokensFreed` 贯穿传递。