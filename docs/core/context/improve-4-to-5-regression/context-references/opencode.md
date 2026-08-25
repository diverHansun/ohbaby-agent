调研完成。以下为完整报告。

# opencode session context / compaction / agent 隔离机制调研报告

根目录：`/Users/hansunwork26/workspace/projects/code-cli/opencode`（下文锚点省略此前缀；`core` = `packages/core/src`，`app` = `packages/opencode/src`）

## 断言核实表

| # | 断言 | 结论 | 证据 |
|---|------|------|------|
| 1 | `app/session/compaction.ts:115-170` preserve recent token budget，可在预算内 split turn | **属实** | `:115-120` `preserveRecentBudget`（config `preserve_recent_tokens` 覆盖，默认 `min(15_000, max(2_000, floor(usable*0.25)))`，常量在 `:32-33`）；`:140-163` `splitTurn` 在 turn 内从前往后找能塞进剩余预算的后缀起点 |
| 2 | 同文件 `:230-259` 按预算从尾部选保留边界 | **属实** | `select()` 内：`:230` 取 budget，`:237-262` 从最近 turn 向前累加 `estimate`（懒估算，成本只与保留尾成比例，见 `:239` 注释），放得下则推进 `keep`；放不下则 `:250` `splitTurn(remaining)`；`:258-260` 无法保留时 log `tail fallback`；`keep.start===0` 则全量摘要 `:264` |
| 3 | 同文件 `:271-315` 保护最近 tool result，裁剪更旧输出 | **属实（注意是软标记）** | `:271-272` 注释明说；`:288-305` 从尾部反向扫：`turns<2` 的最近 2 个 turn 保护（`:290-291`）、遇 summary 停（`:292`）、`PRUNE_PROTECTED_TOOLS=["skill"]`（`:31,297`）、遇已 compacted 停；累计超 `PRUNE_PROTECT=40k`（`:29`）且 `pruned>PRUNE_MINIMUM=20k`（`:28,308`）才生效；`:311` 仅设 `part.state.time.compacted = Date.now()` 并 updatePart——**不物理删除 output**，读取时替换为占位符（见 B 节） |
| 4 | `app/session/instruction.ts:74,201-204` 以 message ID 建 claims set 避免重复注入 | **属实** | `:70-77`（`:74` `claims: new Map<MessageID, Set<string>>()`，注释 "Track which instruction files have already been attached for a given assistant message"）；`:201-211` get/create set、`set.has(found)` 跳过、`set.add(found)`。失效机制见 D 节 |
| 5 | `app/../test/session/snapshot-tool-race.test.ts:2-12,126` 把真实 timing race 固化为命名回归 | **属实** | `:2-13` 文档注释完整描述 race（AI SDK 在 start-step 事件前内部执行 tool，导致 before/after snapshot 相同、diff 为空）；`:126` `it.live("tool execution produces non-empty session diff (snapshot race)")`。对应产品修复锚点：`app/session/processor.ts:98-109`（在 LLM 流开始前预拍 snapshot，注释明说原因） |

---

## A. Compaction 完整机制

**触发路径（4 条）：**
1. **阈值自动（step 内）**：`app/session/processor.ts:477-482` — step-finish 时 `isOverflow(usage.tokens)` 且非 summary 消息 → `ctx.needsCompaction=true`；`:644` `Stream.takeUntil(needsCompaction)` 提前断流；`:679` process 返回 `"compact"` → `app/session/prompt.ts:1320-1328` `compaction.create({auto:true, overflow:!finish})`。
2. **阈值自动（loop 级）**：`prompt.ts:1161-1168` — 上一条完成且 `summary!==true` 的 assistant 消息 tokens 溢出 → `create({auto:true})`。`overflow.ts:22-34` `isOverflow`：`count = total || input+output+cache.read+cache.write`，与 `usable()` 比较；`usable = limit.input ? input-reserved : context-maxOutput`（`overflow.ts:10-20`，`reserved` 默认 `min(20_000, maxOutput)`，可配 `compaction.reserved`）。`compaction.auto===false` 直接 false。
3. **溢出错误自动**：`processor.ts:607-618` — 流中 `ContextOverflowError` → `needsCompaction=true`（`auto===false` 且非 summary 则直接落错误）；重试策略见 `:660-674`。
4. **手动**：HTTP API `summarize` handler（`app/server/routes/instance/httpapi/handlers/session.ts:273-293`，`create({auto:false})` 后 `promptSvc.loop`）、TUI `session_compact`（`handlers/tui.ts:15`）、ACP `compact` 命令（`acp/service.ts:555`）。

**Summarize prompt**：`app/session/compaction.ts:381-391` 用 `buildPrompt`（`core/session/compaction.ts:160-174`）：`<conversation>` 包序列化历史 + "Create a new anchored summary..." + `SUMMARY_TEMPLATE`（`:16-46`，固定 Markdown 结构：Objective / Important Details / Work State{Completed,Active,Blocked} / Next Move / Relevant Files）；有前次摘要时追加 `<prior-summary>` + `SUMMARY_UPDATE_INSTRUCTIONS`（`:47-55`，旧摘要作废、冲突以新对话为准）。执行者是隐藏 `compaction` agent（`app/agent/agent.ts:219-233`，全部工具 deny，系统提示 `agent/prompt/compaction.txt`）。插件可替换 prompt / 注入 context：`compaction.ts:373-391`（`experimental.session.compacting`、`experimental.chat.messages.transform`）。

**序列化与预算算法**：
- `serialize()`（`compaction.ts:54-85`）：user 文本/附件占位符；assistant 文本/reasoning/工具调用（含 input JSON）；tool result 截断至 `TOOL_OUTPUT_MAX_CHARS=2000`（`:30,51-52`），已 prune 的输出显示 `[Old tool result content cleared]`（`:76-78`）。
- `preserveRecentBudget`（`:115-120`）：`compaction.preserve_recent_tokens` ?? `min(15000, max(2000, floor(usable*0.25)))`。
- `select()`（`:223-269`）：`compaction.tail_turns`（config，`core/v1/config/config.ts:157-160`）限制候选 turn 数（默认不限）；从最近 turn 反向累加 `Token.estimate`（4 字符/token，`compaction.test.ts:1666-1674`），超预算时 `splitTurn` 找 turn 内可保留后缀；都放不下则整体摘要（无 tail）。
- 溢出场景的 replay：`:340-356` 找前一条非 compaction user 消息切历史，`:469-495` 压缩后把它重放为新 user 消息（媒体转文本占位符）；`:497-548` 无可 replay 时注入 synthetic "Continue if you have next steps..."（metadata `compaction_continue:true`，`:540`），受插件 `experimental.compaction.autocontinue` 开关（`:500-518`）。

另有 **core 包新实现**（事件溯源版）：`core/session/compaction.ts:176-247` `compactIfNeeded` 在发请求前估算 `system+messages+tools` 是否超过 `context - max(output, buffer)`（`DEFAULT_BUFFER=20k`，`keep.tokens=8k`，`SUMMARY_OUTPUT_TOKENS=4096`），由 `core/session/runner/llm.ts:222-223` pre-flight 调用并 `Effect.die(continueAfterCompaction)` 重启循环。两套并存（app v1 在用，core 为重写方向）。

## B. Compaction 持久化

**写入次数（无事务，分步写）**：
- `create()`（`compaction.ts:559-582`）：2 次写——compaction user 消息 + `compaction` part（含 `auto`/`overflow`/`tail_start_id`）。
- `process()`：summary assistant 消息写入（`:393-419`，`mode/agent="compaction"`、`summary:true`、`parentID`=compaction user）→ processor 流式逐步写 parts → `:461-466` 若 tail 边界变化再 updatePart `tail_start_id`（1 次）→ 可选 replay user 消息+parts（`:471-494`，逐 part 写）→ 可选 continue user 消息+part（`:519-547`）。共 2~N 次独立写，**没有事务/原子性**。

**部分失败处理**：
- summary 自身溢出（`result==="compact"`）：`:450-459` 把 summary assistant 标 `ContextOverflowError` + `finish:"error"`，返回 `"stop"`。
- summary 出错：`:552` `processor.message.error` → stop；成功才发 `Event.Compacted`（`:553-555`）。
- 中断：测试固化了两条——retry backoff 中断须 <250ms 退出（`compaction.test.ts:1202-1265`）；processor 建立**前**中断不得残留 summary assistant（`:1267-1297`，用阻塞在 `experimental.session.compacting` 的 mock plugin 卡在 `:373`、早于 `:419` 的消息写入）。

**旧消息标记方式（不删除）**：旧消息全部留在 DB。读取侧 `MessageV2.filterCompacted`（`app/session/message-v2.ts:521-572`）从尾部回溯，遇带 `tail_start_id` 的 compaction user 则保留其后 tail 并**重排**为 `[compaction-user, summary, ...tail..., 其余]`（`:564-570`，注释 `:578-580`）；无 tail 则在 compaction 处截断。prune 的 tool part 只软标记 `state.time.compacted`，`toModelMessagesEffect` 读取时替换：`message-v2.ts:293-296` output→`"[Old tool result content cleared]"`、attachments 清空；`toolOutputMaxChars` 截断带 omitted 计数（`:49-53`）。compaction part 本身在发给模型时变成文本 `"What did we do so far?"`（`:228-233`）。session fork 会 remap `tail_start_id`（`app/session/session.ts:725-727`）。

## C. 主代理/子代理上下文隔离

- **Agent 分类**：`app/agent/agent.ts:35-55` `mode: "subagent" | "primary" | "all"`。primary（build `:141-155`、plan `:156-181`）；subagent（general `:182-195`、explore `:196-218`）；隐藏工具型 primary（compaction/title/summary `:219-264`）。
- **session 与 agent 的关系**：消息集合按 **sessionID** 隔离（`MessageTable` 按 session_id 查询，`message-v2.ts:506-519`）。**同一 session 内切 primary agent（build↔plan）不隔离消息**——runLoop 每 step 取 `lastUser.agent`（`prompt.ts:1170`）并用全量 `filterCompactedEffect(sessionID)`；session 记录当前 agent/model（`prompt.ts:672-689` `setAgentModel`）。真正的上下文隔离单位是 **session**。
- **子代理 = 独立 child session**：`app/tool/task.ts:156-172` `sessions.create({parentID: ctx.sessionID, agent: next.name, permission: derived})`；深度限制 `cfg.subagent_depth ?? 1`（`:104-117`）；`task_id` 可续用同一子代理 session（`:136-138`）；权限派生 `deriveSubagentSessionPermission` + 默认 deny `todowrite`/`task`（`:139-155`）。
- **上下文如何拿到**：子代理**只通过 prompt 文本**获得任务（`:200-214` `ops.resolvePromptParts(params.prompt)` → 对 nextSession 调 `ops.prompt`），父会话消息不进子代理上下文。
- **结果如何回传**：前台——task tool 的 output 即 `renderOutput` XML（`<task id=... state=...><task_result>text</task_result></task>`，`:64-79,330-334`），text 取子代理最终 assistant 消息最后一个 text part（`:213`）；后台——完成后向**父 session** 注入 synthetic user 消息（`:216-243` `inject` + `:245-254` `notify`）。父侧另有 `subtask` part 类型走 `handleSubtask`（`prompt.ts:255-374`，task 工具结果落回父 session 的 assistant tool part）。
- **子代理独立压缩？是**：每个 session 有自己的 runLoop（`prompt.loop` → `state.ensureRunning(sessionID)`，`run-state.ts:52-69,88-94`，Runner 每 session 单实例、busy 互斥），子代理 session 走完全相同的 compaction 触发链。请求头带 `x-parent-session-id`（`llm/request.ts:199`）与 `x-session-affinity`/`X-Session-Id`（`:197-198`）供网关侧识别层级。

## D. 动态 instruction claims 机制

- **注入路径**：`read` 工具读文件时调 `instruction.resolve(ctx.messages, filepath, ctx.messageID)`（`app/tool/read.ts:300`），`ctx.messageID` = 当前 assistant 消息 ID（`app/session/tools.ts:62`）。resolve 从目标文件目录向上找 AGENTS.md/CLAUDE.md/CONTEXT.md（`instruction.ts:64-68,190-218`），命中的内容以 `"Instructions from: <path>"` 附加进 read 工具结果。
- **三层去重**：(1) **system 级**：`systemPaths()` 只取 project 第一个匹配（`:122-133`），根级已在 system prompt；(2) **跨消息持久层**：`extract(messages)`（`:17-32,185`）扫描历史 read part 的 `metadata.loaded`（由 `read.ts:287,315` 写入 DB），跳过已注入路径，且**跳过已 compacted 的 read part**（`:22`——prune 后可重新注入）；(3) **同消息层**：claims set（`:201-211`）。
- **失效**：`clear(messageID)` 删除整个 entry（`:105-108`）；每 step 结束 `Effect.ensuring(instruction.clear(handle.message.id))`（`prompt.ts:1331`）；prompt scope finalizer `clear(info.id)`（`prompt.ts:691`）。即 claims 生命周期 = 单个 assistant step（内存态、实例级 `InstanceState`，不持久化）。
- 测试锚点：`test/session/instruction.test.ts:160-207`（同消息不重复注入 / clear 后可重注入 / 跳过 loaded 元数据）。

## E. Prompt 缓存

- **Anthropic 系显式断点**：`app/provider/transform.ts:359-408` `applyCaching`——对**前 2 条 system + 最后 2 条非 system 消息**打 `cacheControl/cachePoint: {type:"ephemeral"}`（anthropic/openrouter/bedrock/openaiCompatible/copilot/alibaba 各自键名 `:363-382`）；anthropic/bedrock 用 message-level，其余 content-level（`:385-405`）。入口条件与 `options.cacheControl`（Anthropic 自动缓存）互斥：`:466-485`。
- **OpenAI 系 cache key**：`app/session/llm/request.ts:1260-1277`——`promptCacheKey`/`prompt_cache_key` = **sessionID**（openai/azure/xai/mistral/deepinfra/cerebras/venice），gateway `caching:"auto"`。core 新实现同样：`core/session/runner/llm.ts:204-214`。
- **会话亲和头**：`request.ts:187-204` `x-session-affinity` / `X-Session-Id` / `x-parent-session-id`。
- **缓存计入溢出判定**：tokens 记录 `cache.read/write`（`compaction.test.ts:1696-1757`），`isOverflow` 把 cache.read/write 计入 count（`overflow.ts:31-33`，测试 `compaction.test.ts:407-417`）。

## F. 测试策略

- **运行器**：`bun test --timeout 30000 --only-failures`（`packages/opencode/package.json:10`）；Effect 测试基建 `testEffect` + `LayerNode`/`AppNodeBuilder` 组装**接近真实的 layer 栈**（替换个别 service），`provideTmpdirServer` 提供带 git 的临时实例（`snapshot-tool-race.test.ts:80-95,187`）。
- **snapshot-tool-race 的具体做法**：mock LLM 服务器返回**即时** bash tool call（`toolMatch`，`:140-143`）→ 真实 bash 工具在 tmpdir 写文件 → 断言 tool completed 且文件存在 → 对 fire-and-forget 的 `summary.diff` 做 50×100ms 轮询后断言 diff 非空（`:178-185`）。这是把"AI SDK 内部执行工具早于 start-step 事件"的真实 race 固化为命名回归，产品侧修复在 `processor.ts:98-109`（流开始前预拍 snapshot）。
- **故障注入**：`test/lib/llm-server.ts` 是可编程 SSE 假 LLM 服务器，原生支持 `streamError()`（流中错误）、`hang()`、`reset()`（mid-stream 连接重置，`:543-549,433-443`）、`error(status,body)`（HTTP 错误）、`pendingTool`+hang（半截工具调用）、`hold/wait`（时序控制）、`misses/hits` 断言（`:612-776`）。单元级另有 `llm()` 队列 stub（`compaction.test.ts:295-338`）、阻塞式 plugin mock（`:340-352`）、`Fiber.interrupt` 中断注入（`:1242-1261`）。
- **命名回归惯例**：大量以 issue 编号命名的回归——`message-v2.test.ts:1652-1672`（#27145 double auto-compaction：`filterCompacted` 重排后 `latest()` 按时间而非数组位置取 finished，防止二次 compaction）；`prompt.test.ts:2220-2251`；`httpapi-promptasync-context.test.ts:1`（#26526）；`server/negative-tokens-regression.test.ts`；`session-diff-missing-patch.test.ts:2`（#26574）；`cf-ai-gateway-e2e.test.ts:1`（#24432/#32051）；`run-process.test.ts:65-71`（#27371）；`tool-define.test.ts:110`（#28438）；`tool/registry.test.ts:224+`（#27451/#27630）。compaction 测试还固化了**已知未修 BUG**为显式 `BUG:` 前缀用例（`compaction.test.ts:455-533`，limit.input 无 headroom 不对称）。
- **无属性测试**：全测试目录 grep `fast-check|fc.assert` 无结果——策略是"边界值断言 + 命名回归 + 故障注入"，不是 property-based。
- 其他相关回归：`revert-compact.test.ts`（revert 后 compact 工作流）、`instruction.test.ts`（claims）、`prompt.test.ts:1171+`（processor creation race）。

## 对 ohbaby-agent 审核的关键提示（opencode 有、容易遗漏的机制）

1. **旧消息永不删除**——压缩是"读取窗口"（`filterCompacted` 重排）+ 软标记（`time.compacted`），fork/revert 依赖完整历史，回归测试应覆盖"压缩后 revert/fork 不破坏 compaction 锚点"。
2. **`latest()` 必须按时间而非数组位置**取 finished/user，否则重排后触发 double auto-compaction（#27145 有现成回归范式）。
3. **prune 的四重保护**（最近 2 turn、summary 边界、保护工具白名单、已 prune 即停）与"只标记不删库"语义。
4. **summary 生成失败的降级链**（错误标记 finish=error + stop，而非删除 compaction 标记）。
5. **子代理隔离=独立 session + prompt 文本传上下文 + XML 结果回传 + 独立压缩循环 + 深度限制**，且权限在 child session 派生。
6. **claims 类内存去重需与持久化 metadata.loaded 去重双轨**，且 prune 后允许重新注入。
7. **缓存感知**：cache 断点（头 2 system + 尾 2 消息）与 sessionID cache key、cache token 计入溢出阈值。