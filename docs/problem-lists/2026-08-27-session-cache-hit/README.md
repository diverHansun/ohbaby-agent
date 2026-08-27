# session prompt-cache hit · `/status` 观测通道

> 状态：**规划已按开发前讨论修订，待用户审查；本目录只含规划文档，不改生产代码。**
> 日期：2026-08-27
> 规划基线：`5774fe4`（`main`）
> 落点：`docs/problem-lists/2026-08-27-session-cache-hit/`
>
> 前序：[context improve-5](../../core/context/improve-5/README.md) 已冻结 provider-neutral usage 与 `observed`；[context improve-6](../../core/context/improve-6/README.md) 已落地占用七类 UI，并把 cache 设计冻在 00 §2.4、实施留到本批。improve-6 不再承接本议题。

---

## 1. 一句话目标

让用户在 `/status` 看到**主代理整段 session** 的累计 Cache-Read Share（`Cache hit 61%` / `Cache hit —`）。命中率是独立记账通道，不进占用彩条，也不从窗口扣除。

术语：session 桶 = 内存累加器；命令字段正式名 `promptCacheUsage`；面板文案 `Cache hit`；配置项 `apiConfig.promptCache` 是请求策略，与本批无关。

- `cacheReadTokens`：进入本 session 账本的可信主代理请求中，厂商报告为“从 prompt cache 读取”的 token 累计数量。
- `cacheReadShare`：累计比例，等于 `cacheReadTokens / accountedInputTokens`；它不是另一批 token，也不是按请求次数计算的 hit rate。
- 累计域是 **session 内历次主代理 model request**，不是当前 step / turn / run，也不是“此刻仍留在上下文窗口里的 token 存量”。因此 compact 不回减，换模型不清空，进程重启归零。

## 2. 范围

### In scope

1. 主代理 session 级累加器：只收 `isSubagent !== true` 的 agent-step run；`usageComplete=false` 或无可信 `inputBreakdown`（缺 breakdown，或 `observed.cacheRead !== true`）的轮跳过。
2. Cache-Read Share helper：分母含 `cacheWrite`；无可信数据 → `null`（UI `—`），不得伪装成 `0%`。
3. `/status` 增加独立 `promptCacheUsage` 字段与 Web / TUI 单行文案；DTO 使用 `sessionId / accountedInputTokens / cacheReadTokens / cacheReadShare`；两个 UI 沿用各自现有的 unknown-payload adapter，非法值失败关闭。
4. 权威文档把「cache 下一轮」改成本目录指针；improve-6 README 加一句移交说明。

### Out of scope

- 改 prompt cache **请求**策略、稳定前缀、scoped key（llm-client / improve-5）。
- 改占用 composition、压缩阈值、inclusive occupancy。
- 子代理命中率进用户 `/status`；顶栏小环 / hover / click 面板画 cache。
- 换模型或 compact（手动/自动）时清桶；持久化跨进程重放。
- 计费 / 单价 / last-step 百分比双显示。
- TUI 七类占用详情。

## 3. 文档地图

阅读顺序：README → 00 → 01 → 02 → 03 → 04。实施以 **02 + 04** 为准；与 00 冲突时先改文档。

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 跨模块现状与缺口 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约 |
| [03-reference-projects.md](./03-reference-projects.md) | dsh 可验证源码 / improve-6 UI 契约 / 明确不抄的设计 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与发布门 |
| `05-implementation-acceptance.md` | 实施完成后由验收模式写入（规划期不存在） |

02 不含关键改动清单（本规划会话用户未要求）。

## 4. 与既有文档关系

| 文档 | 关系 |
|------|------|
| [improve-6 00 §2.4](../../core/context/improve-6/00-discussion.md) | 显示口径与文案的来源；本批继承并补「主代理-only、compact/换模型不清」 |
| [improve-6 02 Phase C / N 表](../../core/context/improve-6/02-optimization-plan-and-change-scope.md) | 被本目录 **supersede** 为实施契约；行号快照过时，不再当执行清单 |
| [improve-6 04 §4.7](../../core/context/improve-6/04-test-and-acceptance.md) | 被本目录 04 **supersede** |
| [context/goals-duty.md](../../core/context/goals-duty.md) | cache 不是 Context 职责；本批遵守 |
| [llm-client/goals-duty.md](../../core/llm-client/goals-duty.md) | llm-client 只透传 usage、不管 session 统计；本批不把累加器放进去 |
| [architecture.md §八](../../core/context/architecture.md) | 实施时改「命中率留给下一轮」为本目录 |

## 5. 实施入口

用户审查并明确允许后，再提交本分支文档并在**后续实施会话**按 02 + 04 改代码。当前阶段不提交、不实施。
