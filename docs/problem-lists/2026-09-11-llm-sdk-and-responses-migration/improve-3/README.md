# improve-3 · LLM 请求与结果契约去 Chat 耦合

> 开启日期：2026-09-13。状态：**独立验收通过，等待用户审核后合入集成分支，不自动合并**。2026-09-14 对照 02/04 重写 [05](./05-implementation-acceptance.md)；定向 19 文件 / 415 tests 复跑绿。未在验收会话重跑全量 preflight 或真实 API。T10 用实施会话分次证据。Qwen 偶发未定因。
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
10. [公开API迁移说明](./public-api-migration.md)与[05实施验收](./05-implementation-acceptance.md)

05记录实际范围、通过证据及失败历史。design定义目标契约；02引用字段ID，不复制另一份命名表。按用户最新要求，上级llm-client五份旧文档保持不变，本轮说明位于[独立模块目录](../../../core/llm-client/openai-response-miagration-improve-3/README.md)。

## 批准与开工门

2026-09-13用户已批准design/data-model.md §5–6精确契约及公开入口建议，并指定ZenMux真实测试矩阵，见04 §4.6。U表保留为决策索引，不再作为重复询问的理由。真正开工仍须先通过improve-2最新live门并合回集成分支。improve-3验收后停在临时分支，等待用户审查并确认improve-4计划；不自动merge。

2026-09-13子代理复核发现Anthropic空文本工具结果存在JSON fallback，已补旧字段恢复及三类wire回归；复核确认该问题在规划层解决，下一轮候选未发现与context improve-5/6职责的实质冲突。这是文档审查，不是新代码通过测试的证明。

## A批执行记录（2026-09-13）

请求消息/工具已改自有类型，三个adapter直接投影；旧估算总量与七桶维持批准基线，快照最终内层及安全多轮回传已适配。外层completeMessage、reasoning及streamChatCompletion等名称按计划留B，不是最终公开API。

冻结后typecheck、lint通过；定向provider五文件254项通过；完整unit为235文件2457项通过、2项既有跳过，contract为17文件309项通过，integration为52文件349项通过（含CLI打包及进程检查）。独立子代理未发现A批阻断问题。尚未运行本轮最终真实LLM矩阵，不沿用improve-2成功结果。

失败记录保留：编辑中误触发一次CLI构建，读到临时类型断裂；最终冻结后完整integration通过。完整unit曾三次在未改动daemon启动诊断用例达到10秒超时，单独复跑及最后完整复跑通过，根因未确定，未改server源码或测试超时。尝试的VITEST_MAX_THREADS/MIN_THREADS不控制当前默认forks池，不能把最后通过归因于“单worker修复”。最终通过的测试数来自实际退出结果，不把失败运行计入通过。

## B批执行记录（2026-09-13）

外层结果已使用messageSnapshot、reasoningText/reasoningTextDelta及ParsedToolCall.callId；公开及provider入口统一为streamResponse，不留旧别名。观察complete没有正文时省略snapshot，delta仍由既有wire content重建；没有新增UI传输字段。canonical usage保留，三个公开蛇形别名删除，旧数据库metadata读取不动。

TDD先复现旧快照名、伪造空正文和隐藏usage别名三项失败，再修改实现。冻结后定向41文件801项、完整unit、contract 17文件309项、integration 53文件352项均exit 0；lint/typecheck/格式检查通过。完整integration包含CLI打包安装与实际Lifecycle→worker→bridge新增三例。独立子代理未发现实质阻塞。新测试证实不完整工具参数及完成信号后EOF前取消都不执行工具；观察事件不提供parsed调用授权。

## C批与当前停止点（2026-09-13）

SQLite两次真实reopen/UI恢复、公开构建消费者及本地三协议HTTP/SSE已通过；C独立审查未发现实质问题。最终preflight复验exit 0，317文件3229项通过、5文件16项既有跳过，所有build通过。此前一次全量及一次隔离CLI包装安装超时保留在05；未改测试或超时，不能声称稳定性问题已修复。

真实ZenMux前两轮均在连接阶段失败。TUN下17:54复跑Responses/Chat通过，Qwen工具执行次数为0；随后21:59 Qwen定向诊断与清理后的原runner均完整通过。各次失败、诊断干扰、请求数和成功证据保留在05；不将分次补证写成同次矩阵全绿，也不声称原偶发问题已修复。

当前 HEAD 为 `734f2ef6`。main 与集成分支不动。improve-4 仍只是候选，须用户确认范围后再写正式 00–04。
