# improve-1 讨论结论与已确认边界

> 更新：2026-10-12。本批的确认结论来自整体议题 `../plan/`，不是本目录新开的对话。
> 本文只归纳与第 1 批相关的**已确认要点**及其来源，不代写讨论过程，不编造原话。
> 过程记录见 [`../plan/discussion-notes.md`](../plan/discussion-notes.md)，整体需求见 [`../plan/00-discussion.md`](../plan/00-discussion.md)，五批边界见 [`../plan/02-optimization-plan-and-change-scope.md`](../plan/02-optimization-plan-and-change-scope.md) §9。

## 1. 本批在五批里的定位

- 五批按“错法”分，第 1 批是**修 bug ＋ 计量**，可以最快单独合入，不受其他批次阻塞。来源：[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §9 表与表下说明。
- 第 1 批的完成定义：发送与预留一致；兼容 reasoning 不漏计；未知用量不伪造；普通偏好不限制摘要；探测／默认值不被前缀表覆盖；模式 A 尚未接入时没有未读历史退场。来源：同上 §9 improve-1 行。
- 每批共同纪律：不允许留下只能靠后续批次拆除的脚手架。来源：同上 §9 末、讨论记录 §17.8。

## 2. 预算、能力与偏好

- 分清三个含义：模型真实能力、普通 `/connect` 输出偏好、本次摘要额度；最终发送额度与容量预留必须来自同一结果。来源：讨论记录 §8.4、§13.2、[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.1。
- 普通请求输出上限 = `/connect` 的 maxTokens；不设时默认 **8192**。官网核实 Anthropic Messages 与百炼 Anthropic 兼容端点的 `max_tokens` 必填，不能省略字段让服务端兜底，所以保留字段、默认 8192、用户可覆盖。来源：讨论记录 §17.15、[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.1。
- 摘要容量检查把 `requestedOutputTokens` **显式**传给预算解析，不取 `profile.maxOutputTokens`（普通偏好），避免“普通配置 4K、摘要却要预留 16K”的错配。来源：讨论记录 §17.15、[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.1。
- 不因 B 达到 32K 就拒绝请求，也不默默降低 B：实际能力不大于 B 时，发送前报告不兼容。来源：讨论记录 §14.2 C、§13.2。
- 50% 预留帽的去向：带 `maxOutputReservation` 的 `usageRatio` 只服务于 mask 触发，随 mask 在第 5 批删除；**它不进模式 A／B 的容量检查**，容量检查里的普通请求输出预留取全量 `config.maxTokens`，发送与预留同源、不套半窗帽子。自动摘要触发沿用完整窗口占用 `currentTokens / contextLimit`，不含输出帽。来源：讨论记录 §17.15、[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.3（以磁盘最新为准）。

## 3. 内置模型档位表

- 删除 `BUILTIN_PROFILE_RULES` 前缀匹配及只为其服务的 `findBuiltinProfile`、`modelKeyCandidates`、`inferProvider`；`resolve` 优先级改为 user > fallback。来源：讨论记录 §17.13，[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §9.3。
- `maxOutputTokens` 只来自 `llmParams.maxTokens`；`apply-active-model-config.ts` 的 builtin 回填删除；writer 的 4096 与 modelProfiles 的 8192 统一为 8192。来源：同上。
- 模型能力三层：用户显式配置 > provider 探测（`probeContextWindow`）> 默认值兜底；未知模型不猜前缀。来源：同上，参考对照见 [`../plan/03`](../plan/03-reference-projects.md) §5.4。
- 引入时间：`BUILTIN_PROFILE_RULES` 于 2026-05-25 随 `66902371` 引入，与探测机制平行且优先级排反，属演化遗留。来源：讨论记录 §17.13。

## 4. 计数与用量

- reasoning 与正文复用现有计数模块，按实际会回传的内容计数；显示用 reasoning 不重复算，兼容内存图文路径不漏计，opaque 代理值要有来源、不冒充精确值。来源：讨论记录 §8.5、§8.6，[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.2。
- reasoning 是 output 子项，cache 是 input 分类；缺失保持缺失，不能填 0 或与总量重复相加。来源：讨论记录 §8.6，[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.2。
- 摘要用量不新建表：成功的摘要就是一条已有 `AssistantMessage`，复用它已有的 `modelRequests` 记录 `context-summary` 请求；现有 `ModelRequestRecord` 没有 usage 字段，**确需时只在既有记录类型上补一个可选 usage**。来源：讨论记录 §17.5。
- 本批只做“可选 usage 结构 ＋ reasoning 子项可选传递 ＋ 缺失≠0”，不填充摘要用量（第 3／4 批接）。

## 5. 危险恢复分支

- 现状：超窗恢复缩小 `summaryHistory`，成功后的候选却仍按原 `historyToCompress` 提交，未读历史被错误退场（问题 P4）。来源：[`../plan/01`](../plan/01-problem-analysis-and-current-state.md) §1、讨论记录 §3.2。
- 确认：摘要覆盖范围与退出活动视图的范围必须一致；失败或缩小输入不能暗中扩大移除范围。来源：讨论记录 §3.2、§17.10。
- 本批处理：模式 A 的显式遗漏记录在第 4 批才接入，本批先移除这条“缩水输入却扩大退场范围”的危险分支，保证未读且无遗漏记录的 parts 始终不退场。来源：[`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §9 improve-1 行、§9 表下说明，[`../plan/04`](../plan/04-test-and-acceptance.md) A5。

## 6. 本批验收目标（源）

- 整体议题的 A1～A5 是第 1 批的验收项，映射见 [`../plan/04`](../plan/04-test-and-acceptance.md) §2。本批按当时真实代码细化成可执行用例，写进 [04](./04-test-and-acceptance.md)。
- 实网收尾：每批完成时用 `tests/models-4-tests.md` 里的模型与真实 api-key，在独立 ohbaby 服务进程核对本批实际字段与 usage；凭据不写进规划、命令行参数或审查提示。本批尚未执行。来源：讨论记录 §17.8、[`../plan/04`](../plan/04-test-and-acceptance.md) §4。
