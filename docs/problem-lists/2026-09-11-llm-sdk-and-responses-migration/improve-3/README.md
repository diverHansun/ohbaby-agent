# improve-3 · LLM 请求与结果契约去 Chat 耦合

> 开启日期：2026-09-13。状态：improve-2前置验收与本地合入已完成；A批请求纵切已通过测试与独立审查，继续B批结果接口迁移。
> 调研代码：`codex/improve-2-responses-migration@a18290f3`。本轮实施分支：`codex/improve-3-model-contract`，起点为集成分支`b43a0921`；main不动。

本轮承接improve-2 §2.8主动切出的内部契约问题。精确设计和分批实施已获用户批准。2026-09-13 improve-2最新全量preflight与生产lifecycle Grok T12通过，详见improve-2/05 §5.12。按用户授权完成收尾并合入openai-responses-migration，再从该集成分支建立本轮临时分支实施。不得合入main；本轮改造后须重新运行全部矩阵。

## 范围

只重新定义 LLM 请求/结果、迁移调用方及公开入口、适配现有 adapter/context/lifecycle/估算输入。不重建 SQLite 消息模型，不改 cache 策略和统计，不开启原生续接，不翻转默认协议。KISS：保留通用名称与现有流程，不新增管理器、服务、包或通用供应商扩展袋。

## 阅读顺序与权威来源

1. [00 已确认讨论](./00-discussion.md)
2. [01 现状与风险](./01-problem-analysis-and-current-state.md)
3. design： [目标](./design/goals-duty.md) → [架构](./design/architecture.md) → [数据语义与唯一字段表](./design/data-model.md) → [接口数据流](./design/dfd-interface.md) → [模块测试](./design/test.md)
4. [02 迁移范围与关键改动条目](./02-optimization-plan-and-change-scope.md)
5. [03 六项目参考](./03-reference-projects.md)
6. [04 本轮验收门槛](./04-test-and-acceptance.md)
7. [事件与公开接口调查](./01a-event-and-public-api-exposure.md)
8. [跨模块旧接口与批次依赖清单](./02a-cross-module-interface-migration.md)
9. [improve-4 候选范围与后续顺序](./next-stage-candidates.md)

`05-implementation-acceptance.md` 仅在实施后创建。design 定义目标契约；02 引用字段 ID，不复制另一份命名表。用例及非功能要求已收进接口、目标与测试，不新增空壳文件。`docs/core/llm-client/` 暂保留当前实现描述，实施时再同步权威文档。

## 批准与开工门

2026-09-13用户已批准design/data-model.md §5–6精确契约及公开入口建议，并指定ZenMux真实测试矩阵，见04 §4.6。U表保留为决策索引，不再作为重复询问的理由。真正开工仍须先通过improve-2最新live门并合回集成分支。improve-3验收后停在临时分支，等待用户审查并确认improve-4计划；不自动merge。

2026-09-13子代理复核发现Anthropic空文本工具结果存在JSON fallback，已补旧字段恢复及三类wire回归；复核确认该问题在规划层解决，下一轮候选未发现与context improve-5/6职责的实质冲突。这是文档审查，不是新代码通过测试的证明。

## A批执行记录（2026-09-13）

请求消息/工具已改自有类型，三个adapter直接投影；旧估算总量与七桶维持批准基线，快照最终内层及安全多轮回传已适配。外层completeMessage、reasoning及streamChatCompletion等名称按计划留B，不是最终公开API。

冻结后typecheck、lint通过；定向provider五文件254项通过；完整unit为235文件2457项通过、2项既有跳过，contract为17文件309项通过，integration为52文件349项通过（含CLI打包及进程检查）。独立子代理未发现A批阻断问题。尚未运行本轮最终真实LLM矩阵，不沿用improve-2成功结果。

失败记录保留：编辑中误触发一次CLI构建，读到临时类型断裂；最终冻结后完整integration通过。完整unit曾三次在未改动daemon启动诊断用例达到10秒超时，单独复跑及最后完整复跑通过，根因未确定，未改server源码或测试超时。尝试的VITEST_MAX_THREADS/MIN_THREADS不控制当前默认forks池，不能把最后通过归因于“单worker修复”。最终通过的测试数来自实际退出结果，不把失败运行计入通过。
