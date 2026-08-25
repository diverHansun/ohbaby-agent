我已经收集到了所有必要的证据。以下是完整的调研报告。

---

# Codex CLI (codex-rs) 上下文管理机制调研报告

研究对象：`/Users/hansunwork26/workspace/projects/code-cli/codex/codex-rs/`（只读调研，未写任何文件）

## 断言核实表

| # | 断言 | 结论 | 证据 |
|---|------|------|------|
| 1 | `history.rs:45-64` ConversationHistory 维护 raw items、history_version、world-state baseline | **部分属实** | `core/src/context_manager/history.rs:45-64`：该结构体实际名为 **`ContextManager`**（doc 注释 "Transcript of thread history"），非 `ConversationHistory`。字段确实齐全：`items: Arc<Vec<ResponseItemEnvelope>>`(:48)、`history_version: u64`(:50)、`world_state_baseline: Option<WorldStateSnapshot>`(:64)，另有 `token_info`、`reference_context_item`。`ConversationHistorySnapshot` 是另一个 trait（:71 由 `SharedConversationHistory` 实现）。行号与内容对应，仅类型名不符 |
| 2 | 同文件 `:101-143` copy-on-write snapshot 和 world state diff | **属实** | `:101-105` `conversation_history_snapshot()` 用 `Arc::clone(&self.items)` 共享向量（读快照零拷贝）；`:123-140` `update_world_state()` 调 `render_history_diff(baseline, raw_items)` 产出模型可见 diff，并用 `merge_patch_from(previous)` 生成 RFC 7386 patch；`:142-144` `set_world_state_baseline` |
| 3 | 同文件 `:207-242` raw/normalized/snapshot 消费边界 | **属实** | `:207-214` `for_prompt_annotated()`（normalize 后消费、保留元数据）；`:216-221` `raw_items()`（原始只读）；`:223-226` `annotated_items()`；`:228-239` `into_raw_items/into_annotated_items`（消耗性）；`:241-243` `history_version()` |
| 4 | 同文件 `:444-457` normalize 补 call outputs、删 orphan outputs、按模型能力过滤 | **属实** | `:444-458` `normalize_history()`：`ensure_call_outputs_present`(:448)、`remove_orphan_outputs`(:451)、`strip_images_when_unsupported`(:454)、`strip_audio_when_unsupported`(:457)（按 `input_modalities` 过滤） |
| 5 | `memories/README.md:31-38` 仅 root、非 ephemeral、memory enabled、DB 可用才启动；subagent 不启动 | **属实** | README `:29-38` 原文一致。代码佐证 `memories/write/src/start.rs:33-38`（`config.ephemeral || !Feature::MemoryTool || source.is_non_root_agent()` 即返回）+ `start.rs:49-52`（state_db 缺失跳过） |
| 6 | 同文档 `:40-77` Phase 1 按 thread claim/lease/backoff 并行提取且 redacts secrets | **属实** | README `:40-77` 一致。代码佐证 `memories/write/src/phase1.rs`：`claim_startup_jobs` 带 `lease_seconds: JOB_LEASE_SECONDS(3600)`(:174)；并行 `buffer_unordered(CONCURRENCY_LIMIT=8)`(:219)；`redact_secrets` 应用于 raw_memory/rollout_summary/rollout_slug(:320-322)；失败 job 由 DB 记 backoff 重试 |
| 7 | 同文档 `:79-116` Phase 2 全局锁、bounded top-N、workspace diff、受限 consolidation subagent | **属实** | README `:79-120` 一致。代码佐证 `memories/write/src/phase2.rs`：全局锁 `:64-71`；bounded top-N 由 `state/src/runtime/memories.rs:449-478`（`usage_count DESC, COALESCE(last_usage,...) DESC ... LIMIT`）；`phase2_workspace_diff.md` 生成 + git baseline；受限 agent 配置 `:328-350`（approval=Never、WorkspaceWrite sandbox、`network_access:false`）+ `:330-333` 禁用 Collab/MemoryTool/Apps/Plugins 特性 + heartbeat(:496-548) |

> 附注（对 ohbaby 审核有用）：README 说运行时编排在 `codex-rs/core/src/memories/`，**实际已迁至 `codex-rs/memories/write/src/`**（README 略滞后），断言语义不受影响。

---

## A. 压缩（truncation / auto-compact）完整机制

**两级机制：写入时截断（truncate）+ 历史级压缩（compaction/summarize）**

### A1. 写入时截断（per-item）
- `core/src/context_manager/history.rs:460-503` `process_item()`：每次 record item 时对 `FunctionCallOutput`/`CustomToolCallOutput` 应用 `TruncationPolicy`（`policy * 1.2` 序列化预算，:461）；`record_items_with_metadata`(:178-195) 统一走此路径。
- 工具输出截断实现在 `codex_utils_output_truncation` crate（`truncate_text`、`approx_token_count`、字节/token 近似换算）。

### A2. 决策点（何时压缩）
核心状态计算在 `core/src/session/context_window.rs:23-91` `context_window_token_status()`：
- `auto_compact_token_limit` 来自 model_info 或 config；两种 scope：`Total`（全部活跃 token）与 `BodyAfterPrefix`（扣除窗口 prefill 基线，:37-50，基线优先用 server 观测的 `input_tokens`，见 `state/auto_compact_window.rs:108-119`）。
- `:66-79` 触发条件：`token_limit_reached = (scope_tokens >= scope_limit + fallback_buffer) || (active_tokens >= full_context_window)`。模型全窗口是硬上限。

触发路径（`core/src/session/turn.rs`）：
1. **Pre-turn**：`:1014-1043` `run_pre_sampling_compact`（在 :169 每轮采样前调用）——超限则 `CompactionPhase::PreTurn`、`DoNotInject`。
2. **Mid-turn**：`:460-500` `should_roll_over = needs_follow_up && (new_context_window请求 || token_limit_reached)` → MidTurn 压缩 + `InitialContextInjection::BeforeLastUserMessage`（:478-481）。
3. **模型切换**：`:1082-1173` `maybe_run_previous_model_inline_compact`——comp_hash 变化(:1091)或切到更小窗口模型(:1126-1149)触发，含 fallback 到当前模型重试。
4. **Manual /compact**：`compact.rs:143-167` `run_compact_task`（`Op::Compact` → `handlers.rs:635`）。
5. **TokenBudget feature**：`compact_token_budget.rs:52-93` —— 跳过摘要，直接装新窗口（`start_new_context_window`，session/mod.rs:3755-3804），但仍走完整 compact hook + `ContextCompaction` 生命周期。
6. **模型主动请求新窗口**：`new_context_window` 工具（`tools/handlers/new_context_window.rs:35`）置 flag，下轮 roll over（不摘要）。

### A3. 截断点选择与摘要生成（本地路径 `core/src/compact.rs`）
- **摘要生成**：`:111-141` 把 `SUMMARIZATION_PROMPT`（`prompts/templates/compact/prompt.md`，"CONTEXT CHECKPOINT COMPACTION" 提示词）作为合成 user input 连同**整个 normalize 后历史**发给模型（:252-289）；失败重试含 backoff(:325-343)；**ContextWindowExceeded 时从最头部删 item 重试（"Trim from the beginning to preserve cache (prefix-based)"，:309-318）**。
- **保留哪些**：`:347-359` 摘要 = 最后一条 assistant message + `SUMMARY_PREFIX`（summary_prefix.md："Another language model started to solve this problem..."）。`:639-717` `build_compacted_history`：从旧到新保留 user 消息（跳过历史 summary 消息），**倒序装填、预算 `COMPACT_USER_MESSAGE_MAX_TOKENS=20_000` token**（:57），超预算单条截断；最后追加 summary user message。其他类型（assistant/reasoning/tool call 等）全部丢弃。
- **初始上下文回注**：`:581-637` `insert_initial_context_before_last_real_user_or_summary` —— 优先插在最后一条真实 user 消息前，否则 summary/compaction item 前，保证 compaction item 位于最后。
- **Mid-turn vs pre-turn 差异**：`:59-74` `InitialContextInjection` 枚举注释——pre-turn/manual 用 `DoNotInject` 并清 `reference_context_item`（下轮全量重注入）；mid-turn 必须 `BeforeLastUserMessage`（模型被训练为压缩后 summary 是最后一条）。

### A4. 远程压缩
`compact_remote.rs` / `compact_remote_v2.rs`（服务端 `/responses/compact` 端点）：`RETAINED_MESSAGE_TOKEN_BUDGET=64_000`、`MAX_RETAINED_AGENT_MESSAGE_TOKENS=10_000`（compact_remote_v2.rs:65-66）；按 provider 能力 `RemoteCompactionSupport::{V2,V1,Unsupported}` 分派（turn.rs:1203-1258），Unsupported 回落本地。

### A5. 压缩后持久化标记（有，且很完整）
`core/src/session/mod.rs:3353-3402` `replace_compacted_history()`：
- 补齐 item ID → 构造 `RolloutItem::Compacted(CompactedItem { message, replacement_history, mcp_resource_origins, window_number, first_window_id, previous_window_id, window_id })`（:3363-3374）——**replacement history 全量持久化**；
- 随后持久化 `RolloutItem::WorldState(WorldStateItem::full(...))`（新窗口基线必须是 full，:3375-3393）与 `RolloutItem::TurnContext`；
- 队列 `SessionStartSource::Compact` 触发 session-start hook(:3398-3401)。
- 窗口推进：`state/auto_compact_window.rs:77-85` `advance()`——window_number+1、新 UUIDv7 window_id、previous_window_id 保留。
- 内存态：`replace_annotated`（history.rs:292-296）替换 items、`history_version += 1`、清 world_state_baseline；随后 `recompute_token_usage`（session/mod.rs:3949-3980）基于新历史重估 token。
- `ResponseItem::CompactionTrigger` 不算 API message 不入历史（history.rs:592）；`Compaction`/`ContextCompaction` 是模型生成 item 可入历史（:590-591）。

---

## B. History snapshot 的 copy-on-write 实现

- **数据结构**：`items: Arc<Vec<ResponseItemEnvelope>>`（history.rs:48），doc 注释明确"snapshots share the vector until a caller needs to mutate it"（:46-47）。
- **写时复制**：所有 push 走 `Arc::make_mut(&mut self.items)`（:193）；`Session::clone_history()`（session/mod.rs:3721-3724）只是 `ContextManager` 的 `Clone`（`#[derive(Clone)]`，:44）——共享 Arc 直到任一克隆变异。
- **只读快照出口**：`:101-105` `conversation_history_snapshot()` → `Arc<dyn ConversationHistorySnapshot>`，实现于 `SharedConversationHistory`（:71-86），遍历时**过滤掉 contextual user 消息**（环境上下文类合成消息），供扩展（`ext/extension-api/src/capabilities/conversation_history.rs`）消费。
- **版本递增**：仅 `replace_annotated()`（:292-296）`history_version = history_version.saturating_add(1)` 并清 `world_state_baseline = None`。doc（:49-50）："Bumped whenever history is rewritten, such as compaction or rollback"。**消费者**：Guardian 审查会话的 reuse key（`guardian/review_session.rs:436`、:525、:665）——父历史被 compaction/rollback 重写后版本变化，审查会话据此判定需重建而非复用。
- **world state diff**：`update_world_state`（:123-140）→ `WorldState::render_history_diff`（`context/world_state/mod.rs:399-419`）：三分支 `PreviousSectionState::{Known(精确持久化快照), Unknown(历史里有 legacy fragment 但无快照), Absent}`，其中 `has_retained_fragment` 会**扫历史确认该 section 的渲染片段仍在保留历史中**，被 rollback 截掉则按 Absent 全量重渲染；持久化侧 `merge_patch_from`（mod.rs:298-316）产出 RFC 7386 merge patch（删除=null 先输出），`WorldStateItem::full/patch` 两形态。各 section（model/permissions/AGENTS.md/tools/environment 等，mod.rs:36-50）实现 `WorldStateSection` trait（:211-245），`ID` 持久稳定。
- **清除时机**：`remove_first_item`(:283)、`replace_annotated`(:295)、rollback 的 `trim_pre_turn_context_updates` 还会因混合 developer bundle 清 `reference_context_item`（:522-550）。

---

## C. normalize / repair 具体逻辑

`core/src/context_manager/normalize.rs`（仅 prompt 构造时调用，不落盘——`for_prompt*` 内 `normalize_history` 后 `Arc::unwrap_or_clone`）：

- **补 call outputs**：`ensure_call_outputs_present`（:21-131）——为每个无 output 的 `FunctionCall`/`CustomToolCall`/`ToolSearchCall`/`LocalShellCall` 在紧随其后插入合成 output（文本 "aborted"，倒序插入防索引漂移:127-130）。**合成 ID 用 UUIDv5 固定 namespace 派生**（:14-19 注释："Changing this value would change model-visible IDs and invalidate prompt caches"；:133-146 `synthetic_output_id`）——保证跨重试/重放稳定以保 prompt cache。
- **删 orphan outputs**：`remove_orphan_outputs`（:148-217）——无对应 call 的 `FunctionCallOutput`/`CustomToolCallOutput`/client 端 `ToolSearchOutput` 被移除（server 执行的 ToolSearchOutput 豁免，:197）；debug 构建 `error_or_panic`。
- **按模型能力过滤**：`strip_images_when_unsupported`（:317-367）/`strip_audio_when_unsupported`（:371-408）——`input_modalities` 不含 Image/Audio 时，把消息与工具输出中的图片/音频内容替换为占位文本（"image content omitted because you do not support image input"），并清空 `ImageGenerationCall` 结果。
- **配对维护**：`remove_corresponding_for`（:219-304）——`remove_first_item` 删除头部时同步删除配对 call/output，免整轮 normalize（history.rs:273-285）。
- **入口过滤**：`is_api_message`（history.rs:575-595）——system 消息、`CompactionTrigger`、`Other` 不入历史。

---

## D. 主代理 / 子代理上下文隔离机制

- **完全线程级隔离**：每个 subagent 是独立 `Thread`（独立 `Session`、独立 `ContextManager`、独立 rollout 文件、独立 thread_id）。spawn 链路：`tools/handlers/multi_agents_v2/spawn.rs:41-203` `spawn_agent` 工具 → `agent/control/spawn.rs:393-597` `spawn_agent_internal`（容量/深度限制 `ensure_execution_capacity`、`reserve_spawn_slot`、`next_thread_spawn_depth`）。
- **fork 模式**（`agent/control.rs:70-78` `SpawnAgentForkMode`，spawn.rs:599-863 `spawn_forked_thread`）：`FullHistory`（fork_turns="all"）/ `LastNTurns(n)` / 无（fresh）。fork 时：读父 rollout 前**先 flush（:662-665）**；`truncate_rollout_to_last_n_fork_turns` 截尾；**清洗**——丢弃 `AgentMessage`、父 multi-agent usage hints、SecurityRiskScore，替换父 developer instructions 为子代理的（:723-762）；从 world state 移除 `multi_agent_usage_hint`（:796-799）；**FullHistory fork 保留父 `reference_context_item`（cached prompt prefix 可复用），截断 fork 必须重建上下文**（:704-718、:80-83 注释）；legacy 无 replacement_history 的 compaction checkpoint 强制子代重建（:706-718）。
- **会话源标记**：`SessionSource::SubAgent(SubAgentSource::ThreadSpawn{parent_thread_id, depth, agent_path, agent_role,...})`；请求带 `x-openai-subagent` header（`responses_metadata.rs:392-415`）。
- **子代理不启动 memories pipeline**（`memories/write/src/start.rs:35` `is_non_root_agent`）。
- **结果回传**：spawn 时任务经 `InterAgentCommunication` 发给子线程（`Op::InterAgentCommunication` → `input_queue.enqueue_mailbox_communication`，handlers.rs:82-102）。完成时 `maybe_start_completion_watcher`（`agent/control.rs:513-602`）订阅子状态，终态后：V2 走 `format_inter_agent_completion_message`（`session_prefix.rs:27-44`，"Message Type: FINAL_ANSWER" 格式，**payload 上限 1000 token**、错误信息截断+下一步建议）作为 InterAgentCommunication 发回父线程；V1 注入 `<subagent_notification>` user 消息（`context/subagent_notification.rs:30`）。父线程通过 `wait_agent` 工具（`multi_agents_v2/wait.rs`）阻塞等待 activity。
- **其他子代理类型**：Guardian 审查会话（fork 父历史 + **prompt cache key 覆盖 `guardian:{parent_thread_id}`**，`guardian/review_session.rs:299-311`）；memory consolidation subagent（见断言 7）。父线程 world state 的 environment section 会列出活跃 subagents（`session/world_state.rs:69-76`）。

---

## E. Prompt cache 意识

Codex 有多层 cache 稳定化设计：

1. **`prompt_cache_key`**：每个 Responses 请求都带（`core/src/client.rs:922,937`），默认 = `session_id`（:485-489 `prompt_cache_key()`），可 override（Guardian 用 `guardian:{parent_thread_id}` 使审查会话与父线程共享 cache key）。
2. **WebSocket 增量请求**：`client.rs:1272-1298` `prepare_websocket_request` + `:1222-1262` `get_incremental_items` —— 当所有非 input 字段（model/instructions/tools/reasoning/prompt_cache_key 等，`responses_request_properties_match` :309-362）匹配且新 input 是上次的**严格前缀扩展**时，只发送 delta 并复用 `previous_response_id`（:1689-1716），服务端返回项并入基线不重发。
3. **normalize 的稳定 ID**：合成 output ID 用 UUIDv5 固定 namespace（normalize.rs:18-19），重复 normalize 不破坏前缀。
4. **压缩时前缀保护**：compact 期间 context window 超限从最旧删起以"preserve cache (prefix-based)"（compact.rs:311）；full-history fork 保留 cached prompt prefix（agent/control/spawn.rs:80-83）。
5. **item ID 规整**：`prepare_response_items_for_request`（client.rs:944-950）剥掉非 prefixed 的 ID。
6. **comp_hash**：模型压缩兼容哈希变化触发预压缩（turn.rs:1045-1051）——保证切换后摘要形态与模型训练一致（间接保 cache/质量）。

---

## F. Context 相关测试覆盖

- **CoW 快照/竞态**：`core/src/context_manager/history_tests.rs:116` `conversation_history_snapshot_shares_response_items_until_history_changes`、`:503` `cloned_history_shares_items_until_mutated`、`:140` snapshot 排除 contextual user 消息、`:197/:221` world state baseline 去重与 legacy 重建。
- **normalize 边界**（同文件）：`:1551-1948` 补 function/custom/local-shell/tool-search 缺失 output；`:1674-2057` 删 orphan（含 debug panic 与 server tool-search 豁免）；`:1707` 混合插入+删除；`:1848` 合成 output 稳定 ID 不重排；`:653-953` 图片/音频按 modality 剥离；`:2103-2583` 图片/音频/加密内容 token 估算。
- **compact 生命周期**（`core/tests/suite/compact.rs`）：auto_compact_runs_after_token_limit_hit(:1582)、multiple_auto_compact_per_task(:1038)、resume 后超限压缩(:1930)、模型切换/comp_hash 变化/fallback 系列(:2035-3251)、body_after_prefix scope(:4175-4347)、加密 reasoning 计数(:4406)、pre-turn/mid-turn 请求形状快照(:4014,4618-4831)、hooks（pre/post compact、matcher、阻断决策 :692-820）、context window 超限重试(:3502)、多次压缩保留最新 user 消息(:3672)、与其他 turn 事件交错的多轮压缩(:3905)。
- **compact + resume + fork + rollback**（`core/tests/suite/compact_resume_fork.rs`）：`:207` 压缩-恢复-fork 后模型历史视图一致、`:363` 二次压缩、`:512` rollback 跨压缩点重放 append-only 历史、`:602` rollback 后续轮裁剪 context updates。
- **远程压缩 parity**：`core/tests/suite/compact_remote_parity.rs:120-201`（manual/pre-turn/mid-turn，v1 vs v2 请求等价性）。
- **子代理 fork 边界**（`core/src/agent/control_tests.rs`）：`:1008` 分页父 fork 用模型上下文前缀、`:1231` 数字 fork 截断到可证明 turns、`:1308` fork 清洗、`:1588` fork 从压缩历史剥离父 usage hints、`:1778` 压缩丢弃父 fragment 后恢复 instructions、`:2081` fork 前强制 flush 父 rollout、`:2142-2395` last-N fork 只留近期 turns / 丢弃父 startup prefix。
- **rollback/reference context**（`core/src/session/tests.rs`）：`:3729` rollback 重算 previous_turn_settings 与 reference_context、`:3855` 压缩后恢复被清的 reference_context_item、`:9646-9862` context updates 全量重注入/基线持久化边界。
- **auto-compact window 记账**（`state/auto_compact_window.rs:150-236`、`state/session_tests.rs:69`）：window 边界、prefill server 观测 vs 估算优先级、replace_history 清 prefill。
- **guardian prompt cache**（`guardian/tests.rs:2125,3254`）：审查会话复用/重试保持同一 prompt_cache_key、fork 的 ephemeral review 复用 trunk key。

---

## 对 ohbaby-agent 回归测试方案的差异提示（调研中发现的易遗漏机制）

1. **压缩持久化不止一个 marker**：`CompactedItem`（含全量 replacement_history + window 三元组 first/previous/current window_id + window_number）之后还追加 `WorldStateItem::full` 和 `TurnContextItem`，以及 `SessionStartSource::Compact` hook 队列——回归测试需校验持久化顺序。
2. **压缩有两种注入模式**（`DoNotInject` vs `BeforeLastUserMessage`），mid-turn 压缩后 summary 必须是最后一条、初始上下文插在最后真实 user 消息之前。
3. **压缩内部也有 context-window-exceeded 重试路径**（从头删 item 保前缀缓存）。
4. **history_version 的真实消费者是 Guardian 审查会话 reuse key**——版本不变则复用、变则重建。
5. **normalize 合成 ID 的 UUIDv5 稳定性**是 prompt-cache 相关回归点。
6. **fork 清洗规则**（剥离 AgentMessage/usage hints/替换 developer instructions/legacy compaction checkpoint 强制重建）是子代理上下文隔离最易出错的部分。
7. **回传消息有 1000 token 上限与错误模板**（session_prefix.rs:10-14）。
8. **token 计量双 scope**（Total vs BodyAfterPrefix，prefill 基线 server 观测优先于估算）影响触发阈值断言。