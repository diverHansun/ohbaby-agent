# 第 6 批：现状与缺口分析

> 诊断对象是 improve-1～5 实施完毕后的代码（基线 `16737a72`）。本文只描述**现状与缺口**，不给方案；方案见 [02](./02-optimization-plan-and-change-scope.md)。
> 所有锚点均由主代理在 `16737a72` 上复核过。路径相对仓库根。

## 1. 实例与状态

### 1.1 身份模型

| 事实 | 锚点 |
| --- | --- |
| 主代理禁止 `contextScopeId`，子代理必须带；两者都硬校验 | `packages/ohbaby-agent/src/core/agents/context-scope.ts:22-43` |
| 子代理身份在建在 child session 上，`contextScopeId = subagentId` | `packages/ohbaby-agent/src/agents/subagent-host.ts:1551-1565` |
| **兄弟子代理共用一个 child session** | `packages/ohbaby-agent/src/agents/subagent-host.ts:858-868` |
| 普通入口的子代理继承主模型；自定义运行时可注入不同 `modelId`，但不会同时切换客户端路由 | `packages/ohbaby-agent/src/agents/subagent-host.ts:1556`；可达性与路由见 §2.3 |

### 1.2 进程内状态的分键

Context 当前的标定系数与成功占用地板两张状态表统一走 `scopedSessionKey`，键形如 `session` 或 `session::scope`，两段都做 `encodeURIComponent`（`packages/ohbaby-agent/src/utils/scoped-session.ts:14-19`）。mask 切点已在 improve-5 删除。地板记录成功压缩后的占用，用于避免内容未增长时反复自动压缩，不是失败次数限制。

现有分键实现正确，S3 要补能发现作用域丢失的测试。UI 占用缓存另见 §2.5。

## 2. 子代理那条路上的现状

### 2.1 已经接好的（本批不动）

- 摘要请求复用子代理自己的 prepared 材料，缓存身份按 session + scope 生成。
- 模式 A/B、20K 尾段、单滚动摘要、原子提交、遗漏记录与 scope 无关，没有 `isSubagent` 旁路。
- `commitCompaction` 对 `expectedMessages`／`expectedParts` 强制 sessionId + scope 全等。
- 占用只由本 run 的 `run.context.prepared` 驱动，父会话不会被子代理刷新。
- 子代理用量被排除出父会话的 prompt cache 统计。

### 2.2 缺口一：压缩边界标记在子代理会话里重开即丢（S1）

**现象**：子代理会话实时显示的 `Compacted (estimated): 120,000 → 45,000 tokens`，重开或重新 seed 后消失。摘要仍在数据库中，问题是历史读取漏掉了它；不是压缩数据丢失。

**机制与两个消费者**：

1. 摘要消息持久化时带 `contextScopeId`，不带 `runId`（`packages/ohbaby-agent/src/core/message/manager.ts:261`）。手动压缩本来就没有 run，不伪造 `runId` 是既有契约。
2. Web 子代理会话在实时变更时能通过 `listByIds` 补入摘要；重新 seed 和翻页却走 `subagent-conversation-history.ts:381` 的 `listPageByRun`，从而漏掉摘要（实时投影见 `adapters/ui-inprocess/subagent-conversation.ts:180/339`）。
3. CLI 使用的 execution reader 经 `ohbaby-sdk/src/subagent-reader.ts:54` → `adapters/ui-inprocess/subagent-views.ts:122` → `adapters/ui-state/source-session-projection.ts:541`，也按 run 读取。只改 Web 会话的 history 文件不能修好这条路径。
4. 根会话的 source seed 按 session 和主 scope 读取（`adapters/ui-state/source-session-projection.ts:148`）。共用标记投影在 `adapters/ui-state/persistent-store.ts:190`，隐藏摘要正文，仍保留已退场旧摘要的压缩标记。

**本轮复现实证**：合成 SQLite 中同一 scope 的两条摘要在关闭重开后都仍存在，另一个 scope 的摘要独立；conversation reader 和 run 页均未读出标记。再加入 220 条后续消息，session 第一页取满 200 条时仍没有标记，且 `hasMore=true`。因此“额外补第一页”不能保证完整回放。探针只访问临时合成数据，不使用用户会话或真实 API。

**分页约束**：游标绑定 session、scope 和 run（`core/message/pagination.ts:45`），run 游标不能直接用于 session 分页。Web 历史先按 execution 分段，再在段内翻页；同一 scope 可能包含多个 run。每段都追加全部摘要会产生跨轮重复或归属错误。兄弟隔离、执行边界和消息去重是不同要求，都需要保持；没有 child run 的旧 execution 也不能吸入同 scope 的其他 run 消息。

**已确认处理范围**：2026-10-13 用户确认 Web／CLI 一起修，保留每次压缩的历史标记；方案见 [02 Stage 1](./02-optimization-plan-and-change-scope.md)。

### 2.3 条件缺陷：子代理异模型预算与请求路由（S2，已移出本批）

**当前普通入口不可按初稿所述触发**：`subagent_run` 的 schema 与运行时校验只接受 `generic / explore / research`（`packages/ohbaby-agent/src/tools/subagent.ts:178`、`tools/utils/subagent-role.ts:34`）。这三个内置角色都没有 `model`，Registry 禁止用户覆盖保留角色（`packages/ohbaby-agent/src/agents/registry.ts:68`）。用户新增其他角色虽能被 Registry 读取，工具入口却不能选择它。普通 Web／CLI 子代理因此继承主模型。

**条件缺陷仍存在**：通过自定义 `AgentManager`／`builtinAgents` 或直接构造实例传入不同模型时，`subagent-host.ts:1556` 只覆盖 `modelId`。tokenCounter 只注册活跃路由档案（`adapters/ui-runtime/composition.ts:658`、`config/llm/model-profile.ts:42`），未命中时 fallback 到共享客户端的窗口和输出偏好（`services/llm-model/modelProfiles.ts:107`）。实际模型窗口更小或更大时，这个值都不保证合适，不能称为一定保守。

**请求路由也没有完整接通**：Context 摘要与 Lifecycle 共用同一个 `llmClient`（`adapters/ui-runtime/composition.ts:642/668`）。客户端按主配置的 provider、地址和协议构造（`core/llm-client/client.ts:62`）；子模型字符串作为请求的 `model` 字段传入，客户端本身不会随它切换。因此只能证实“请求带了该模型字符串”，不能据此断言“已正确请求另一个 provider 的模型”。本轮未对这个条件场景执行真实 API 请求。

`activeModelBudgetProfiles` 的过滤还承担地址与协议匹配；旧预算 Registry 不保留这些路由约束。简单注册全部档案不能同时解决请求路由与预算问题，还可能破坏现有档案选择。普通输出额度应继续与实际请求设置同源，不能直接把模型档案的输出上限当成另一套硬限制。

**2026-10-13 已确认范围**：子代理独立选模型与跨 provider 另开议题，improve-6 不实现上述能力。X1 将移除静态 `AgentConfig.model` 及其覆盖入口，并明确拒绝旧配置和自定义接入中的该字段；这会关闭上述一种触发入口，不等于完成异模型路由。运行时 `modelId` 保留。后续议题登记见 [02 §2.8](./02-optimization-plan-and-change-scope.md#28-后续独立议题)。

### 2.4 缺口三：测试兜底不对称（S3）

此前 Claude Code 故障注入报告见 [00 §5](./00-discussion.md)。本轮没有重跑其注入实验，以下结论来自代码、现有测试核查和定向测试：

- **普通请求恢复缺少子代理变体**：Lifecycle 的普通模型请求 overflow → force → 重发和再次溢出终止用例，没有同时使用真实子代理身份及 scope。摘要请求两次 overflow 则已有 child 用例（`core/context/manager.unit.test.ts:2856`），它不能证明普通请求恢复链路。
- **地板隔离缺少有效断言**：`core/context/compaction-plan.integration.test.ts` 使用无 scope 的 fixture。已有子代理集成中，B 本来低于触发阈值；它没有压缩，不能证明 A 的地板没影响 B。应让 B 同样需要压缩，且占用处于 A 地板以下，再验证 B 仍执行压缩。
- **持续压缩与手动豁免缺少子代理边界验证**：已有三次自动成功及容量条件变化用例（`compaction-plan.integration.test.ts:550/580`），需要验证带 scope 的长任务及手动绕过地板。
- **保留内容需要独立预期**：现有 child 集成能证明历史与缓存身份隔离、A 压缩不修改 B、父子摘要独立；尚未充分断言 Mode A 的遗漏集合、Mode B 的保留段调整和合法切点。状态机测试虽执行 child manual／force，但只有单 scope，且部分预期取自实际提交，不能替代这些断言。

20K 是固定首选预算，不是硬上限；最新完整组超出预算或保护未闭合工具依赖时允许超出，见 [discussion-notes §17.4](../plan/discussion-notes.md)。初稿 C5 的“尾段不超过 20K”与该决策冲突，已纠正。

2026-10-13 用户确认 S3：围绕上述行为补测试，只有测试暴露真实缺陷时才最小修复；不扩展压缩策略。

### 2.5 潜在项：子代理占用视图及缓存扩展（S4，已确认本批不做）

`packages/ohbaby-agent/src/core/context/context-window-usage.ts:51` 的 `usages` 是 `Map<string, UiContextWindowUsage>`，键是**裸 sessionId**（读 `:60`、写 `:79`）。这是全仓唯一按 sessionId 单键的 context 缓存。

**当前不构成 bug**：读路径对子代理会话直接返回 `null`（`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:2870-2883`）。写入来自主会话的手动压缩、占用查询和主 run 的流式更新（`adapters/ui-inprocess.ts:2847/2907`、`adapters/ui-runtime/run-stream-adapter.ts:569`）；当前没有子代理占用写入。初稿只列了前两个写入口，此处补齐事实，不扩大 S4 范围。

**风险**：哪天要给子代理显示上下文占用，兄弟 scope 共用 child session 会互相覆盖；Web 侧按 sessionId 查（`apps/ohbaby-web/src/ui/session/selectors.ts:316-330`）会显示错的模型与占用。

**改动面复核**：当前 tracker 的输入、查询及 `UiContextWindowUsage` 都没有 scope。只把 Map 的三处读写换成 `scopedSessionKey` 不会得到子代理隔离，还需贯通占用查询与 UI 身份。这是显示占用的缓存，不是 §1.2 已按 scope 隔离的标定系数和压缩地板。

**2026-10-13 已确认范围**：当前 UI 显示主会话的上下文窗口占用，本批保持现状。将来考虑子代理占用视图时，再把查询、缓存和显示一起接通；本批不预先扩展接口或缓存键。

### 2.6 行为取舍：沿用通用子代理失败处理（S5，已确认）

初稿“父级没有任何 UI 提示”不准确。现有 Web 父聊天委派行与子视图已显示 `Failed`（`apps/ohbaby-web/src/ui/session/DelegationRow.tsx:115`、`SubagentView.tsx:110`）；CLI 执行详情显示状态、终止原因和错误内容（`packages/ohbaby-cli/src/tui/components/subagent-browser.tsx:35/75`）。

错误结果也会交给父模型：前景路径通过工具结果带回 `terminal_reason` 与错误文本（`packages/ohbaby-agent/src/tools/subagent.ts:112`）；后台终态经结果文件和 continuation 交付，不只交付成功结果（`agents/subagents/result-artifacts.ts:36`、`continuation-coordinator.ts:135`）。后台结果属于模型运行输入，两端聊天正文会隐藏它；父模型收到错误，不等于父聊天自动展开失败原因。

缺少的是额外的压缩专用主动通知，不能因此判定子代理失败通路未接入。2026-10-13 用户确认本批沿用通用失败处理，不加压缩专用通知；回归验证现有状态与错误传递即可。

## 3. 跨模块小尾巴

### 3.1 静态 agent 模型字段职责混杂（X1，四字段删除已确认）

`packages/ohbaby-agent/src/agents/types.ts:33-35` 与 `config/agents/types.ts:132-134` 声明并接受 `temperature`／`topP`／`maxTokens`。配置加载可以保存这些值，但它们没有进入实际 LLM 请求设置；创建实例时传入的角色参数主要是 `maxSteps`，子代理另有 `model` 覆盖（`agents/service.ts:42`、`agents/subagent-host.ts:1555-1556`）。

因此 agent 配置中的 `maxTokens: 4000` 不会改变输出额度，请求仍使用共享 LLM 客户端的设置，Context 预留额度与该实际请求同源。主、子代理都受这个配置误导影响。`docs/agents/data-model.md` 和 `docs/config/agents/data-model.md` 等文档还保留了按 agent 覆盖模型参数的示例，与实际接线不符。

静态 `AgentConfig` 还声明了 `model`：主代理忽略它，子代理存在覆盖模型字符串的消费者，详见 §2.3。因此四个字段的现状不同，不能一概称为“完全没有消费者”。

2026-10-13 用户已确认删除这四个静态 agent 字段。文件配置和自定义接入使用旧字段时明确报错，保留 LLM 层配置以及运行时 `modelId`、reasoning。文件配置经 `AgentConfigSchema.strict()`，已有错误格式可指出来源和未知字段；这项清理不移除全局 LLM 的有效设置。

程序化 `AgentRegistry.configLoader`／`builtinAgents` 只经过 `validateAgent` 的有限检查，不经过完整 schema（`agents/registry.ts:52/88/95`）；自定义 `AgentManager` 还能绕过 Registry。因此仅删除 schema 和 TypeScript 字段，不能保证旧注入值在运行时被拒绝。实施应在现有配置消费入口补齐拒绝，在发出模型请求前指出 agent 和旧字段，而非静默保留或回退。不需要新增兼容转换层或重做所有 SDK 配置校验。

**配置职责检查结果**：静态 `AgentConfig` 中属于模型配置的字段就是这四项。`prompt`、工具、权限、`maxSteps`、`timeout` 等属于角色与执行约束；`StartSessionParams.reasoning`、实例 `modelId` 属于运行时输入，不等于在静态 agent 配置中另设一套模型配置。

### 3.2 归档后的 Context 状态保留（X2，已确认本批不做）

`packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:936` 订阅 `SessionEvent.Removed` 来释放 Context 的两张表；事件的唯一发送点在 `packages/ohbaby-agent/src/services/session/manager.ts:300`，而 `SessionManager.remove` 在生产代码里**没有调用方**。

生产 UI 的 `archiveSession`（`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:2513-2534`）将会话状态改为 `archived`，再从 UI 投影中移除；核心会话与消息仍保留。这是归档，不是删除。`SessionManager.remove` 则删除存储记录后发布 `Removed`。初稿把二者混为一谈，已纠正。

归档路径没有取消正在运行的任务。既有契约测试在模型请求尚未结束时归档，随后释放模型响应并等待任务完成（`adapters/ui-inprocess.contract.test.ts:9489-9578`）。`Removed` 的订阅者却会取消 run、打断子代理、删除结果文件并清理 shell／sandbox 等资源（`adapters/ui-runtime/composition.ts:936-975`）。因此不能为了释放两张 Context 状态表就在归档时补发删除事件。

后果：常驻 daemon 里主代理会话的这两张表不随归档释放（每会话少量记录，不跨实例串味）；长期大量归档会话时，进程内记录会累积。本轮没有量化长期内存占用，不能宣称完全无成本。

**2026-10-13 已确认范围**：X2 本批不做，保留现有归档、删除与资源清理行为。后续处理会话资源回收时，再统一考虑运行结束、后续状态回写和释放时机。

## 4. 已经顺手清掉的（记录备查，本批不用做）

| 事项 | 现状 |
| --- | --- |
| 死 API `ContextCutPoint.messagesToSummarize`／`turnPrefixMessages` | improve-5 已清除，全仓 0 命中 |
| 摘要「部分正文 + 传输中断」的分类分支缺 streaming 层测试 | `84b9a71e` 已补，覆盖有／无部分正文两种情形（`packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts:886-921`） |
| `core/context/serializer.integration.test.ts` 引入 mcp 模块 | 仅测试文件，生产依赖方向未变，维持现状 |

## 5. 文档侧的调查起点与更新范围

- 调查时，`docs/core/context/improve-7/README.md` 仍保留 improve-4 验收时点的表述（「mask 与全入口贯通留到第 5 批」）。本轮规划已补齐 improve-5／6 索引和实际状态，实施后再补 improve-6 验收链接。
- `docs/core/context/data-model.md:277` 等**历史章节**里保留了现在时表述（「`usageRatio` 仍表示输入预算占用，供 mask／thrash 等已有规则使用」）。这些段落标题带「（历史记录）」，按仓库惯例可保留，但句子本身读起来像是当前规则。
- 调查时，议题 [README](../README.md) 的批次表停在 improve-5；本轮规划已补第 6 批及最终确认边界。
