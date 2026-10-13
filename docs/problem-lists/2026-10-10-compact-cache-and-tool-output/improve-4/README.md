# improve-4：滚动摘要、保留段与原子切换

> 状态：代码已实施，验收见 [05](./05-implementation-acceptance.md)；仅本地分支，待用户审查。
> 编写日期：2026-10-12。代码调查基线 `24c70034`（沿用 [plan](../plan/README.md) 快照），编写时仓库 HEAD `c5cfda26`。
> 上游规划是 [plan/](../plan/README.md)。本目录把 plan 第四批细化成可施工的规划，规则以 plan [00](../plan/00-discussion.md)、[02](../plan/02-optimization-plan-and-change-scope.md)、[04](../plan/04-test-and-acceptance.md) 和 [context-design/02](../plan/context-design/02-change-spec.md) 的最新结论为准，不新增也不改动已确认的预算、尾段和缓存规则。

第 4 批 / 共 5 批。分批按“错法”切：本批对应**本地切错**——要跑故障注入、崩进程、连续压缩才现形，和第 3 批“抓 wire 就能验”的请求发错分开，也不和第 1 批的计量算错、第 2 批的投影不稳混批。

## 本批交付（一句话）

| 交付 | 一句话 |
| --- | --- |
| 一次临时计划 | 一次压缩只选一次范围，生成、压后检查、提交都消费同一份选择 |
| 单滚动摘要 | 继承全部活动旧摘要，模型视图只留一份；旧摘要和原文留库 |
| 固定 20K 尾段 | 对齐合法边界；最新不可拆组超 20K 时整组保留 |
| 模式 A／B | 放不下分两种病因：裁临时副本（保旧摘要与近期、记遗漏）／一次收缩保留段 |
| 原子切换 | 新摘要、它的请求记录、遗漏记录与旧 parts 退场同一事务 |
| 失败保护 | 同批完成最终失败终止、force 一次与 Stop 基本链路，再删除次数上限和抖动锁；成功后用无进展地板抑制重复 |
| 轻量界面 | 进行中 `Compacting`；完成给压前／压后占用；提交后立即刷新 footer 与 composition |

## 依赖与顺序

- 上游依赖：improve-1（计数、预算、用量与模型能力来源）、improve-2（工具结果稳定投影）、improve-3（prepared 摘要请求、缓存接通、独立输出、一个有界重试、90% 默认线与必要容量保护）先落地。
- 本批**同批**接上“自动摘要最终失败结束本次运行”，并删除每次运行的压缩次数上限（`MAX_COMPACTION_PER_TURN`）与无收益抖动锁（`THRASH_*`）。三者不可拆开交付，也不留脚手架。
- improve-5 做手动／自动入口贯通与旧机制清扫，并对本批失败终止行为做跨入口回归，不再首次补失败终止。
- 实网测试不是本批交付物，而是每批的收尾动作：每批完成时由 agent 启动独立 ohbaby 服务，用 [tests/models-4-tests.md](../../../../tests/models-4-tests.md) 的模型和真实 api-key 做本批相关的字段、usage 与 cache 探测；凭据不写进文档。

## 文档地图

| 文档 | 职责 |
| --- | --- |
| [00-discussion.md](./00-discussion.md) | 本批已确认结论与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | Context 相关现状、问题与代码锚点 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 改动契约：阶段、改动面、契约、风险（最详） |
| [03-reference-projects.md](./03-reference-projects.md) | 借鉴 pi／kimi／ZCode 等，写清不照搬的部分 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收，映射 plan 用例 ID |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实施、测试、真实服务、独立审查与本地提交记录 |

## 明确不在本批

- 不新建用量表、不写 SQL、不建召回系统、不做历史版本树或 `activeSummaryId`。摘要用量复用第 1 批补好的可选 usage 与第 3 批的摘要所有权；本批将 record 保存到摘要消息已有的 `modelRequests`。
- 不引入第二套目录预算（40K／窗口 30%）或“尾段为空”的例外。
- 不做溢出学习窗口、缓存预热、服务端 compact、自动升额重试。
- 不把“失败终止”延后到第 5 批——它在本批和删旧限制同时完成。

## 与 plan 的关系

本目录是 plan 第四批的投影，不是独立方案。凡本目录与 plan 冲突，以 plan 最新结论为准并回改本目录。旧 raw 讨论里已撤回的 20／40K、零尾段等表述**不复活**。
