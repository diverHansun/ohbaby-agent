# 讨论记录与已确认要点

> 2026-08-24 基于 improve-4、improve-4.1、improve-5 的实施结果整理；2026-08-25 吸收六项目源码调研、OpenCode 独立审查及用户确认。正式诊断与方案见 01～04。

## 1. 背景与动机

三阶段已经分别解决或改善：

- Context 窗口占用、压缩梯级与 UI 观测；
- tools-aware measurement、主/子代理 scope 和请求期消息计量；
- LLM 请求结构、TokenUsage/cache 语义、稳定前缀、动态 MCP 工具顺序、scoped cache key，以及 `PreparedModelRequest` 单一请求快照。

阶段验收主要验证各自改动接口，没有覆盖 improve-4～5 作为一个状态系统时的长序列、故障恢复和架构鲁棒性。因此需要单独开展联合回归。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 核心目标 | 验证 Context 的可靠性、鲁棒性、状态隔离、恢复语义和设计架构，而不只统计测试数量 |
| 测试姿态 | 先测现状；对“疑似风险”写能失败的测试；只有失败证据成立后才修生产代码 |
| SWE 约束 | 测试必须服务正确性、可靠性、可测试性、可维护性与简单性；避免为参考项目的形式做货物崇拜式重写 |
| 主/子代理 | 同一套 Context 质量契约同时适用于 primary 与 subagent；二者都是 Agent 实例，但 `contextScopeId` 隔离 |
| Memory | 本轮只验证既有只读 `OHBABY.md` 契约；主动/自动长期记忆另开架构阶段 |
| Cache | 验证 cache usage 语义、scoped key、稳定前缀和真实命中；缓存 token 仍属于输入窗口占用 |
| 外部验证 | 真实 OpenAI-compatible、Anthropic 和 compiled Web 是最后一层门禁，不替代单元/集成/故障测试 |
| 文档优先 | 先完成本目录规划，经用户及其子代理审查确认后再进入实施 |
| 实施纪律 | 后续按批次实施；每批完成定向测试、仓库门禁和独立审查，再进入下一批 |
| 摘要自溢出 | summary 请求自身 context overflow 定为 P0；必须按完整 turn/tool pairing 有界缩小，不能直接失败回到仍超限的原请求 |
| 压缩提交 | failpoint 先行；若证实部分写损坏，优先窄原子提交端口，durable marker 仅作存储能力不足时的后备 |
| 并发契约 | 同 scope 的 auto/manual compact 与 prompt Context durable mutation 共用 exclusive lane，并在提交前复核快照/版本；异 scope 保持并发 |
| 事件契约 | 所有 Context event 携带 session/scope；compaction progress/terminal 另带 attempt 与唯一终态；durable store 是事实源，事件失败不回滚已提交状态 |

## 3. 已确认：重点测试方向

### 3.1 已有能力的可靠性证明

- `PreparedModelRequest.messages/tools` 的测量与发送深等价，正常、final-step、overflow retry、force prepare 均无旁路。
- input token、cache read/write/uncached 的 inclusive 语义在所有 Provider 归一化路径保持一致。
- 主代理和子代理的 history、calibration、mask、compaction、tool menu 与 cache key 按 `sessionId + contextScopeId` 隔离。
- runtime model context 只附着 initiating user message；同一 run 的 system/memory 快照稳定。
- tool schemas 的顺序在同一 epoch 内稳定；lazy MCP load 只影响下一次请求。
- summary/title/export/UI 不泄漏 runtime metadata，模型可见投影不被 UI 隐藏规则误删。

### 3.2 需要测试证实的风险

- summary 创建、summary part 写入、旧 part 标记是多次持久化写；中途失败是否会形成 summary 与原文双可见。
- summary 请求把待压缩历史一次性发送；Provider 若报告 context overflow，当前是否会直接失败且无法自救。
- prune 逐 part 更新时中途失败，是否会留下不可解释的部分裁剪状态。
- 相同 initiating user message 被并发启动时，runtime model context 是否可能重复追加。
- 同 scope 的 auto+auto、manual+auto、manual+manual，以及 manual compact+prompt 是否会交叉写 history/summary。
- manual `compact()` 与 automatic `prepareTurn()` 在 mask/usage projection 下是否产生不同的 `usageAfter` 和下一请求视图。
- Context events 当前只有 `sessionId`，且 summary generation failure 没有对应 Context terminal event，是否会造成 child scope 观测串线或 attempt 悬挂。
- Manager/进程重建后，durable 与 ephemeral 状态的恢复边界是否明确且可预测。
- 现有大量阶段内用例能否组合证明长工具循环、重复压缩、重试、abort、子代理并发等状态演化不变量。

这里使用“需要测试证实”，不把源码推断提前写成已发生缺陷。

## 4. 已确认：Design Goals 解释

测试不是为了达到某个 coverage 数字，而是用于验证以下质量属性场景：

| Design Goal | 可观察场景 |
|---|---|
| 正确性 | 计量请求与发送请求相同；模型可见历史合法且不重复 |
| 可靠性/鲁棒性 | 任意一步失败、abort、overflow、retry、restart 后仍有唯一可解释状态 |
| 隔离性 | scope A 的历史、工具、校准、压缩和清理不改变 scope B |
| 可测试性 | 时钟、TokenCounter、Provider、存储故障和调度时序可受控；失败可由 seed 复现 |
| 可观测性 | 事件携带正确 session/scope；cache miss、压缩失败和恢复原因可以解释 |
| 可维护性 | 状态所有权和模块职责写入权威文档；测试断言行为而非私有调用次数 |
| 简单性 | 不做全量事件溯源重写；只抽取被真实测试压力证明的窄边界 |
| 缓存效率 | 稳定输入产生稳定 Provider-relevant prefix；有意变化只失效一次后重新稳定 |

## 5. 已确认：边界与不做的事

| 项 | 本轮处理 |
|---|---|
| 新增 Memory CRUD/检索/embedding | 不做；另开 Memory 阶段 |
| primary 与 subagent 分叉成两套请求链 | 不做；共享 Agent/Context 契约，仅 scope 隔离 |
| 全量事件溯源 | 不预设；当前不做 |
| 无证据重构 `ContextManager` | 不做；先让测试暴露真实变化原因 |
| 用 E2E 覆盖全部组合 | 不做；E2E 只守关键真实路径 |
| 真实凭据入库 | 禁止；仅环境变量，缺失时只允许外部门禁 skip |
| improve-4～5 之外的全面产品回归 | 不做；不属于本批范围 |
| Provider observed-window 自适应 | 本轮只记录为 P2 已知限制；不新增持久化/过期/Provider 特化策略 |

## 6. 与已有阶段文档的关系

- improve-4 `04/05` 证明窗口占用与自动压缩定向能力。
- improve-4.1 `04/05` 证明 tools-aware measurement、manual/static 路径和 scoped subagent 自动保护。
- improve-5 `04/05` 证明 Provider 协议、`PreparedModelRequest`、稳定 prefix/cache 和主/子代理同链路。
- improve-5 明确把 improve-4～5 全方位联合回归留给后续工作；本目录承接该范围。

## 7. 已确认的工程取舍

1. 属性测试使用 `fast-check` 的 seed/shrinking，但先建立核心动作模型；MCP、permission、session switching、memory 与 scope lifecycle 分到后续专门 suite，避免一个 generator 同时承担全部偶然复杂度。
2. 压缩决策以当前 `summary=0.95`、`minRemainingInputTokens=4096` 为行为基线；旧 85% 只作为历史目标，不在回归阶段调参。
3. Summary 语义评测进入 nightly/release；确定性结构、隐私、请求身份和恢复不变量仍是硬门。
4. 压缩提交先做 failpoint；若红，SQLite/in-memory store 优先实现同语义的窄原子 commit。只有原子事务不能覆盖真实介质时才引入 durable marker；marker 必须有 lifecycle epoch，能区分 active/busy 与 stale/orphan。
5. Summary 请求自身 overflow 按最旧完整 turn 逐步缩小，并清理前导孤儿 tool result；重试次数和最小进展量必须有硬上限，保留最近用户边界和 tool pairing。
6. 同 scope 使用 exclusive Context mutation lane，并在摘要生成后、提交前复核 durable revision；不同 scope 不使用全局锁。UI prompt 可先 accepted，但实际 Context 写排在 manual compact 之后。
7. 任意 synthetic tool repair 的 ID、文本和状态必须是 durable call identity/status/schema version 的确定性函数；真实 result 到达时覆盖 synthetic，禁止时间戳/随机文案扰动稳定前缀。
8. 所有 Context event 补齐 scoped identity；compaction progress/terminal 另带 `attemptId` 与 success/failed/inflated/skipped/aborted 唯一终态；重放不得重新发 observable event，也不得为恢复偷偷调用 LLM。
9. Provider observed-window 自适应保持 P2/out of scope；当前只通过错误分类、校准与真实 Provider 证据记录限制。
10. `02` 不提供符号/行号级关键改动清单；包/文件级改动面足以指导后续实施。
