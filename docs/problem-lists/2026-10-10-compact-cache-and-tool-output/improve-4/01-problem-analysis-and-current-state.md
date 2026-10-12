# 第 4 批现状、问题与证据

> 调查基线 `24c70034`（plan 快照），2026-10-12 复核；编写时 HEAD `c5cfda26`。本批**尚未实施**。
> 代码路径相对 `packages/ohbaby-agent/src/`，行号是调查快照，定位以函数名为准。需求见 [00](./00-discussion.md)，方案见 [02](./02-optimization-plan-and-change-scope.md)。

## 1. 核心问题

| ID | 当前事实与影响 | 代码证据 |
| --- | --- | --- |
| P4-1 | 活动视图把**所有**有效摘要排在普通历史之前，生成新摘要时又**过滤掉旧摘要**，新摘要不继承旧摘要 → 摘要总量累积、旧约束与后修并存 | `core/context/context-manager.ts:208`（`getActiveHistory`）、`:823`（`generateSummaryCandidate` 里 `.filter(!isSummaryMessage)`） |
| P4-2 | 超窗恢复缩小 `summaryHistory` 重试，成功后候选仍按**原始** `historyToCompress` 提交 → 没进成功请求的历史也被标为已压缩 | `core/context/context-manager.ts:925`（`shrinkSummaryHistory`）、`:967`、`:988` |
| P4-3 | 尾段只有 20K／0.3 两个口径：历史较大时用固定 `KEEP_RECENT_TOKENS`，历史小时走 `fullTokens × 0.3`；切点按消息粒度，没有“最新不可拆交互整组保留”的显式规则 | `core/context/compaction-policy.ts:214`（`getHistoryToCompress`）、`:126`（`findCutPoint`）、`core/context/constants.ts:2`（`COMPRESSION_PRESERVE_RATIO`） |
| P4-4 | 没有两种容量失败的分流：只有“缩 `summaryHistory` 再试”，既没保住全部活动旧摘要，也没记录“未读且未保留”的遗漏 | `core/context/context-manager.ts:866`（`droppedRounds`）、`core/context/summary-overflow.ts:47`（`shrinkSummaryHistory`） |
| P4-5 | 文件操作信息是模型写完后**事后追加**（`appendFileOpsSummary`），不是生成前预扣 16K 额度；也没有遗漏说明的位置 | `core/context/context-manager.ts:947`、`:952` |
| P4-6 | 用**每次运行的进入次数帽**（`MAX_COMPACTION_PER_TURN`）和**无收益抖动锁**（`THRASH_*`）代替失败终止；没有“最终失败结束本次运行”的机制 | `core/context/context-manager.ts:1185`（`thrashLocked`）、`:1196`（`perTurnCapped`）、`core/context/constants.ts:18-21` |
| P4-7 | 摘要候选不带 requestId／usage，`ModelRequestRecord` 也没有 usage 字段 → 成功摘要的请求记录无法随摘要消息落库 | `core/context/context-manager.ts:967`（candidate）、`core/llm-client/types.ts:257`（`ModelRequestRecord`） |
| P4-8 | 压缩完成没有“压前／压后占用”单行；占用刷新由 `data.composition` 驱动，提交后没有主动按新投影再刷一次 | `adapters/ui-runtime/run-stream-adapter.ts:569`、`packages/ohbaby-cli/src/tui/store/events.ts:1163` |

缓存从改动位置之后失配，不等于整份请求必然归零；提供商命中率不能由本地源码直接证明。

## 2. Context 职责、数据流与接口（模块视角）

**职责边界**。Context 负责：装配模型输入、计量、选择上下文维护动作、决定保留哪些历史、验证压后容量、原子切换活动历史。它**不**负责：计费服务、工具执行策略、历史召回、通用工作流。现状里“选择范围”散在 `getHistoryToCompress`／`findCutPoint`，而“退场范围”在 `generateSummaryCandidate` 返回的候选里——两处不总是同一份，正是 P4-2 的根。

**数据流（现状）**：

```text
rawHistory → getActiveHistory（旧摘要 + 非摘要）→ generateSummaryCandidate
   过滤掉旧摘要 → getHistoryToCompress（20K 或 0.3）→ 摘要请求（最多 4 次尝试 / 2 套提示词）
   超窗 → shrinkSummaryHistory（丢最早轮次）重试
   → 返回 candidate{historyToCompress, snapshot}（范围仍是原始 historyToCompress）
→ commitSummaryCandidate → commitCompaction 事务（parts 比较 + 写摘要 + 退场）
```

**接口方向（现状）**：`PreparedModelRequest` 只固定 `inputIds／messages／tools`；`llmClient.generateSummary` 返回字符串；`commitCompaction(input)` 携带 `expectedParts` 与 `summary{agent,text}`。摘要请求**没有**回传 requestId／usage，提交时也**没有**遗漏记录的位置。

**已可复用的结构**：`commitCompaction` 的 parts 比较与单事务（`core/message/database-store.ts:526`）、`time.compacted` 退场标记（`markCompactedParts`）、`AssistantMessage.modelRequests`（`core/message/types.ts:47`）、受保护输入机制（`prepareTurn`，`context-manager.ts:1699`）、现有容量估算与事件（`CompactionStarted／Finished／Compressed`）。

## 3. 数据模型与持久化

- 摘要用 `kind=context-summary` 消息保存；活动视图由 part 的 `time.compacted` 标记决定。退场是模型视图变化，不是物理删除。
- `commitCompaction`（`core/message/database-store.ts:526`）在一个事务里比较 `expectedParts` 的 id、插入摘要消息与其 part、更新退场标记。**这是本批原子提交的落点**。
- `CommitCompactionInput`（`core/message/types.ts:232`）目前只有 `compactedAt／expectedParts／contextScopeId?／sessionId／summary?{agent,text}`——要容纳遗漏 metadata，需要扩展摘要 part 的 `data`。
- 调查基线的 `ModelRequestRecord`（`core/llm-client/types.ts:257`）没有 usage，`AssistantMessage.modelRequests` 已有记录数组。按批次分工，第 1 批补可选 usage，第 3 批完成摘要所有权与返回记录，第 4 批只负责和摘要同事务保存，不新建表或 SQL。

## 4. 触发、失败与停止（现状）

- 触发：`needsSummaryCompaction` 用 `currentTokens / contextLimit >= COMPRESSION_THRESHOLD`（现状 0.95）。`decideCompactionRung` 在达到次数帽时从 `prune-summary` 降为 `mask`；`thrashLocked` 直接返回 `none`。
- 流量：`runCompactionCore` 先 `pruneHistory`，再决定要不要摘要；`afterPruneRung !== "prune-summary"` 时可在 prune 后提前返回（“清一点就停”）。
- 收益：`projectedUsage.currentTokens >= usageAfterPrune.currentTokens` 时把候选标为 `inflated` 并丢弃（这正是本批“占用必须下降”的雏形）。
- 停止与新输入：`prepareTurn` 把 run 的持久输入序列化进 `tailDirectives`，不并入可压缩历史；`compact` 走 `mutationLane` 串行。`lifecycle.ts:483` 在 run 开始重置次数帽；`:675` 在普通请求超窗后带 `force:true` 重发；`:738-758` 重发仍超窗则结束运行（`context_overflow`）。
- 缺口：次数帽与抖动锁只“少压几次”，不能表达“最终失败结束运行”；摘要失败后普通流程仍可能继续，下一步再次触发摘要。

## 5. 非功能与测试现状

- 主要风险：未读历史被错误退场（数据完整性，优先级高于命中率）、摘要信息遗失、多份摘要并存、失败留下半次历史替换、压前压后占用不一致。
- 现有相关测试文件（均在 `packages/ohbaby-agent/src/core/`）：`context/compaction-atomic.integration.test.ts`、`compaction-hard-crash.integration.test.ts`（原子与崩进程）、`context/compression-prompt.test.ts`、`context/summary-serialization.unit.test.ts`、`context/context-window-usage.unit.test.ts`、`context/manager.unit.test.ts`、`message/database-store.integration.test.ts`。
- 这些用例证明部分现有事务、投影与估算行为，**不等于本批新行为已实现**。本批新增行为的验收见 [04](./04-test-and-acceptance.md)。

## 6. 文档 vs 实现对照

| 文档说法 | 代码实际 | gap |
| --- | --- | --- |
| `docs/core/context/goals-duty.md`、`dfd-interface.md`、`test.md` 描述 95% 线、prune／mask | 基线实现仍是 95%＋prune-first＋mask | 随本议题各批实施同步更新，不提前宣称已实施 |
| plan 早期版本曾提 20%＋40K／30%＋零尾段 | 代码只有 20K＋0.3 分支 | 已确认收敛为固定 20K；0.3 分支删除 |
| plan 早期曾提“小型摘要尝试表” | `ModelRequestRecord` 无 usage、无表 | 已确认复用 `modelRequests`，不建表 |

## 7. SWE 原则审视

主要复杂度来自“同一事实有多个口径、多个历史修改入口、多个重试所有者”。本批的减法方向：把“选范围”收敛到一份临时计划，把“失败动作”从次数帽／抖动锁换成地板＋失败终止，把用量归属挂回已有 `modelRequests`。**不**引入的过度设计：历史版本树、摘要链表、第二套目录预算、计费服务、召回系统。
