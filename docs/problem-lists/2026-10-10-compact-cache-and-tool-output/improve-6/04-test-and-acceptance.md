# 第 6 批：测试与验收标准

> 依据 [00](./00-discussion.md) §5、[01](./01-problem-analysis-and-current-state.md)、[02](./02-optimization-plan-and-change-scope.md)。
> 本文是**待执行的验收契约**，不是已通过结果。沿用仓库既有 Vitest 与项目级测试规则，不新建测试框架，不以覆盖率数字代替风险验证。
> 验收包含现有回归与关键行为的定向故障注入；证明改坏会变红，不对每条测试机械重复注入。此前审查报告与本轮复核的区别见 [00](./00-discussion.md) §5。
> 2026-10-13 已确认 S1 的 A 组、S3 的 C 组、X1 的 D1 配置拒绝和 S5 的 D4 通用失败回归；S2、S4、X2 不在本批，对应新能力验收已移除。

## 4.1 测试范围

- **单元／契约**：当前主、子代理继承同一模型的预算回归；四个静态 agent 模型字段删除，文件配置和自定义接入明确拒绝旧字段；保留 LLM 层设置及运行时 `modelId`、reasoning。`contextWindowUsage` 保持现状，沿用既有主会话占用回归。
- **集成**：Web／CLI 标记回放与分页隔离；子代理普通请求的 force 恢复、成功占用地板隔离、持续压缩和实际保留内容。
- **回归**：第 5 批的入口准入、取消、mask 清扫成果不回退；根会话的标记、地板及既有占用显示行为不变；S5 通用失败状态和结果交付正常；保留现有归档与删除行为。
- **有界实网**：只验证本批确认的同模型子代理场景，不以异模型能力是否落地为执行条件（§4.8）。

可直接扩展的位置：

| 用途 | 文件 |
| --- | --- |
| 子代理历史投影 | `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-conversation-history.integration.test.ts` |
| execution 详情 | `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-views.integration.test.ts` |
| seed 与实时合并 | `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-conversation.integration.test.ts` |
| 两种 SDK reader | `packages/ohbaby-sdk/src/subagent-conversation-reader.unit.test.ts`、`subagent-reader.unit.test.ts` |
| 根会话标记（对照） | `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts` |
| 子代理 scope 端到端 | `tests/integration/core/context-subagent-scope.integration.test.ts` |
| force 恢复 | `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts` |
| 地板与模式 A/B | `packages/ohbaby-agent/src/core/context/compaction-plan.integration.test.ts` |
| 当前模型预算回归 | `packages/ohbaby-agent/src/config/llm/` 与 `packages/ohbaby-agent/src/services/llm-model/` 下既有测试 |
| agent 配置校验与加载 | `packages/ohbaby-agent/src/config/agents/__tests__/validation.test.ts`、`loaders.test.ts` |
| 程序化配置与自定义消费入口 | `packages/ohbaby-agent/src/agents/registry.unit.test.ts`、`service.unit.test.ts`、`subagent-host.unit.test.ts` |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Stage |
| --- | --- | --- | --- | --- |
| A1 | 两种读取链路重开仍有标记 | 集成 | 实际持久化压缩摘要后关闭重开存储，分别经 conversation 与 execution reader 重建；对应历史中仍有标记，文案与根会话一致，摘要正文不显示 | 1 |
| A2 | 兄弟 scope 不串 | 集成 | 同一 child session 下两个 scope 各自压缩，两种读取链路中的 A 都不出现 B 的标记与摘要，反向同样成立 | 1 |
| A3 | 无重复项 | 集成 | 标记、既有父用户消息、普通消息按 ID 唯一；实时更新后重新读取或加载相邻页，不产生重复项 | 1 |
| A4 | 根会话不回退 | 契约 | 根会话仍走按 session 读取，标记、翻页、旧会话重开行为与第 5 批一致 | 1 |
| A5 | 标记在第一页之外 | 集成 | 构造多于单页上限的后续消息，使旧标记落在更早页；遍历各入口已支持的翻页方向，消息和标记无遗漏，页边界与更多历史标志正确，游标持续推进 | 1 |
| A6 | 多轮与多次压缩 | 集成 | 同一子代理跨多轮至少三次真实压缩提交；退场旧摘要仍有标记，完整会话找到三次记录，各 execution 只显示对应记录，摘要正文不泄漏 | 1 |
| A7 | 稳定边界与旧 execution | 契约／集成 | 同时间戳顺序稳定；跨 scope／run 的错误游标仍被拒绝；缺少 child run 的旧 execution 不吸入其他执行消息 | 1 |
| A8 | Web／CLI 消费结果一致 | 端到端／入口契约 | 在实际 Web 会话与 CLI 执行详情中确认首次打开、重开及加载更早记录可见对应标记；核对持久化消息 ID，不能只测内部查询函数 | 1 |
| B2 | 当前同模型路径不变 | 契约 | 主、子代理继承当前模型时，预算与实际请求输出设置一致，现有档案路由选择不回退 | 回归 |
| C1 | 普通请求 force 一次恢复 | 集成 | 子代理身份＋scope 下用假模型制造普通请求溢出；恢复机会调用前消耗、失败不返还，成功压缩后重发；断言请求与 force 次数及最终结果 | 3 |
| C2 | 同一步再次溢出与运行隔离 | 集成 | 再次溢出只结束该子代理这一轮，不再 force；在共享运行时实际继续父代理和兄弟运行，验证它们的历史及状态不受影响 | 3 |
| C3 | 地板隔离与持续压缩 | 集成 | A 压缩后，B 同样需要自动压缩且占用低于 A 地板，B 仍成功；同 scope 未增长时不重复自动压缩，随内容增长至少三次成功后仍能继续 | 3 |
| C4 | 手动豁免地板 | 集成 | 同一 scope 已有成功地板且占用未增长时，共用手动路径仍执行压缩；对应自动请求被地板抑制 | 3 |
| C5 | 子代理保留与遗漏内容 | 集成 | Mode A／B 的关键保留与遗漏 ID 集合符合独立预期，原记录留库；固定 20K 是预算，最新完整组或未闭合依赖允许超出，工具调用与结果不拆开 | 3 |
| C6 | 恢复机会按步隔离 | 契约／集成 | 同一步 snapshot 重入不刷新已消耗的恢复机会；进入新一步后可再次进行一次恢复 | 3 |
| D1 | 静态 agent 模型字段明确拒绝 | 契约 | 分别写入 `model`／`maxTokens`／`temperature`／`topP`，文件加载及程序化配置消费均在模型请求前报错，可定位来源或 agent 及字段；移除后正常运行；角色配置、LLM 层设置及运行时 `modelId`、reasoning 保留 | 4（已确认） |
| D4 | 通用子代理失败处理 | 集成／入口回归 | 压缩失败导致子代理结束时，Web 显示既有失败状态、CLI 详情可查原因；前景工具结果与后台交付分别能把错误交给父模型。沿用通用失败通路，不新增压缩专用通知 | 4（已确认） |

C 组复用既有测试设施和可控假模型，不依赖真实 API 随机触发错误。集合预期从合成输入与已确认规则独立写出，不能读取实际提交再将其当作期望值。保留现有子代理摘要请求连续溢出测试，不能用它替代 C1／C2 的普通请求场景。C5 沿用 [discussion-notes §17.4](../plan/discussion-notes.md) 的合法边界规则，不新增 20K 硬限制。

原 B1／B3 已随 S2 移出本批；保留 B2 编号避免既有引用失效。子代理独立选模型与跨 provider 的验收由后续独立议题制定。

原 D2／D3 已随 X2／S4 的“不在本批”决定移除，后续编号不重排。当前 UI 显示主会话的上下文窗口占用，归档与删除维持现有行为，均沿用已有回归。不新增归档回收、子代理占用查询、缓存分键或显示测试，也不做对应故障注入；未来做这些能力时，再制定验收标准。

D4 优先复用 S3 的失败场景与已有结果交付、UI 测试，只补没有覆盖的连接点，不为“不发专用通知”单独建立测试框架或重复整套失败测试。父模型收到错误与父聊天展示错误正文分开核对，不能混为同一个验收结果。

D1 用现有配置测试参数化覆盖四个字段及错误定位，保留配置来源的加载回归。程序化入口覆盖 Registry 的 `configLoader`／`builtinAgents` 和绕过 Registry 的自定义 `AgentManager`，其中旧 `model` 不能再覆盖模型字符串，也不能被主代理静默忽略；断言失败发生在模型请求前。复用已有 fixture，不为每个字段重复启动完整服务，也不以类型检查代替运行时断言。

移除旧字段后，主、子代理仍使用当前 LLM 配置确定的模型；运行时 `modelId` 和 reasoning 继续传递，角色、提示词、工具权限、`maxSteps` 等有效配置保留。LLM 层设置沿用现有配置测试与 B2 回归。不将 agent 级值自动迁到全局，产品不自动改写用户文件；本次用户授权的本机清理另见 00，不作为自动迁移功能。

## 4.3 故障注入（本批的验收方式）

对下表中已纳入本批的关键行为做定向注入：先确认正常实现通过，再改坏对应行为并确认预期断言失败，恢复后重跑通过。一次注入可验证同一行为的多条测试，不必逐条重复；不引入全仓突变测试框架。编译失败或无关用例失败不算抓住目标问题。注入改动不提交，实际结果写入 `05-implementation-acceptance.md`。

| 故意改坏 | 此前报告或已知风险 | 改坏后必须 |
| --- | --- | --- |
| 子代理 force 恢复停用 | Claude 报告全量 6016 条零新增红，本轮未重跑该注入 | C1／C2 对应断言变红 |
| 地板 key 去掉 scope | Claude 报告零红，本轮未重跑该注入 | C3 变红 |
| 同一步重入重置恢复机会，或让机会按整个任务耗尽 | 同一步与新一步边界需要子代理变体 | C6 对应断言变红 |
| 只修 conversation 或 execution 其中一条，另一条仍过滤摘要 | 两条读取路径均漏标记 | A1 的对应变体变红 |
| 补页去掉 scope 过滤 | — | A2 变红 |
| 补页与既有放行叠加不做去重 | — | A3 变红 |
| 只从第一页补标记，漏掉更早摘要 | 本轮合成数据探针已复现第一页无标记 | A5 变红 |
| 每轮追加同 scope 的全部标记，不限定执行边界 | — | A6 变红 |
| 手动入口加回地板限制 | — | C4 变红 |
| 恢复接受一个已移除的 agent 参数，或将未知字段静默丢弃 | 旧配置必须明确报错 | D1 对应断言变红；复用严格校验，无需对四个同类字段重复注入 |

上述旧报告数字仅保留来源，不替代本批实测。本批记录哪项行为被改坏、哪条预期断言失败，以及恢复后的结果，不以红数多少评价质量。

## 4.4 集成边界

- Context ↔ MessageStore：`commitCompaction` 的 scope 围栏与省略集合（保留能力，不改事务语义）。
- Context ↔ Lifecycle：溢出捕获、force 一次性标志、失败终止（父代理与子代理各一条链路）。
- Context ↔ UI 读取：压缩提交后的持久化摘要经 Web conversation 与 CLI execution 两条链路回放，覆盖 seed、分页和实时合并；以根会话投影作对照。
- Context ↔ 配置：回归当前活跃路由的预算与实际请求设置；本批不扩展模型档案注册或模型标识解析。

## 4.5 回归清单（改造不能破坏什么）

- **保留的能力**：`time.compacted` 退场标记、`commitCompaction` 共用事务、工具调用与结果配对、旧摘要与原文读取、第 5 批的忙时拒绝与取消贯通、mask 清扫结果。
- **不动的行为**：根会话的标记投影与翻页；活跃模型路径的预算数值；兄弟子代理共用一个 child session 的结构。
- **前批不动**：第 5 批的入口准入与前端反馈，本批只跑回归，不重做。
- **通用失败处理保留**：子代理压缩失败沿用既有状态、详情与错误结果交付，不增加压缩专用通知；主会话现有压缩反馈不受此决定影响。
- **占用显示保持现状**：UI 继续显示主会话的上下文窗口占用，既有查询、缓存与显示回归通过；子代理占用视图不纳入本批。
- **归档与删除保持现状**：不改变运行中归档的行为，不在归档时补发 `Removed`，不删除既有清理订阅；本批不新增资源回收逻辑。

## 4.6 验收标准（发布门）

| 项 | 标准 | 如何验证 |
| --- | --- | --- |
| 两端子代理看得到 | Web 会话和 CLI 执行详情重开、翻页均保留每次压缩标记，不重复、不串 scope 或执行，内部摘要正文不显示 | A1～A8 |
| 当前模型预算不回退 | 主、子代理继承当前模型时，预算与实际请求设置保持一致 | B2 |
| 通用失败可感知 | 子代理失败状态与原因按既有通路可查，前景／后台错误结果可交付父模型 | D4 |
| 配置职责清楚 | 四个静态 agent 模型字段明确拒绝；文件配置与自定义接入均覆盖，LLM 层配置及运行时 `modelId`、reasoning 保留 | D1／B2 |
| 兜底是真的 | 已确认范围内的关键行为完成「正常通过 → 改坏变红 → 恢复通过」 | 4.3 对应项与实际结果记录 |
| 根会话不动 | 标记、翻页、地板、预算与第 5 批一致 | A4／B2／C 组回归 |
| 边界没扩大 | 无数据库 schema 迁移、无新事件类型，不新增第二套压缩流程或执行状态框架 | `git diff` 核对 02 §2.4／§2.6 |
| 文档一致 | 议题 README、模块索引、历史章节与 agent 配置文档同步；本批 05 如实记录验证结果和延期边界 | 02 Stage 4 文档项与 Stage 5 |

示例定向命令（仓库根执行）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-conversation-history.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/context/compaction-plan.integration.test.ts
pnpm exec vitest run tests/integration/core/context-subagent-scope.integration.test.ts
pnpm test:unit && pnpm test:contract && pnpm test:integration
pnpm run typecheck
```

## 4.7 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
| --- | --- | --- |
| 补页把兄弟 scope 的摘要混进视图 | A2 用两个 scope 各自压缩后互查 | 兄弟同时压缩的时序组合未必全覆盖，至少覆盖「A 压完 B 查」 |
| 补页导致消息重复、遗漏或顺序错乱 | A3／A5／A6／A7 断言唯一性、完整集合、执行归属与稳定顺序 | 实时更新和历史翻页交错需通过既有合并链路验证 |
| 只修一端，另一端仍过滤摘要 | A1 分别覆盖两条 reader；A8 验证实际消费入口 | 不能用 Web 会话的通过结果代替 CLI 验收 |
| 补测写成「跟着实现走」的空断言 | 独立预期＋关键行为定向故障注入 | 只认可目标行为断言失败，不能把编译或无关错误当作有效结果 |
| 收尾改动误改模型路由或预算 | B2 回归现有同模型路径；核对 diff 未扩大档案注册与模型路由范围 | 异模型能力不由本批验收证明 |
| 已移出的条目被「顺手实现」 | 核对 diff 不引入 S2 异模型能力、S4 占用扩展或 X2 归档回收 | 清理时误改原有会话生命周期，或为未来需求提前扩展接口 |

## 4.8 真实 API（每批收尾）

已确认用少量完整流程作实网验证，限定当前主、子代理共用模型的支持范围。沿用 `tests/models-4-tests.md` 的测试端点，至少观察一条真实子代理压缩后继续运行的流程，核对请求组装、上下文占用与 provider 返回的缓存用量，再验证 S1 的 Web／CLI 重开回放。不要求靠实网反复制造溢出或穷举模型组合；错误边界由可控假模型验证。

使用独立数据目录和会话，测试前设定请求次数上限。复用服务前确认运行的是本批代码，否则启动隔离服务；实际代码版本、入口地址和结果记录到 05。凭据只在进程内读取，不写进参数、日志、文档或审查提示。本规划阶段未执行真实 API 请求。
