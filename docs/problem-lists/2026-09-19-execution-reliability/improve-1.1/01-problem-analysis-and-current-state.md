# 01 现状与问题分析

> 2026-09-22，调查基线 `7cdd4a93`，分支 `codex/execution-reliability`。improve-1～4 均是规划，不能把其待建接口当作现有能力。本文为源码调查，未运行本轮产品测试。行号仅是基线定位，符号为准。

## 1.1 核心问题

| ID | 现状与源码证据（agent 下路径相对 packages/ohbaby-agent/src） | 用户可见风险 | 02 回应 |
|---|---|---|---|
| P1 | `adapters/ui-state/persistent-store.ts` 的 readSnapshot 先读会话/run，再异步读各会话消息；server `app/create-app.ts` 的 `/v1/snapshot` 在读取结束后取得 eventBus.latestSeqNum | 较早数据贴较新序号，客户端会跳过快照中实际上没有的更新 | §2.1、§2.2 |
| P2 | `adapters/ui-inprocess.ts:2173` 创建展示用 assistantMessageId；`core/lifecycle/lifecycle.ts` 每个模型步骤创建真实 assistant message。llm:delta 不携带真实 messageId；`adapters/ui-runtime/run-stream-adapter.ts` 正文使用展示 ID，reasoning 使用核心事件 ID | 正文与思考归属不一致，历史无法可靠替换实时消息，多步调用尤其明显 | §2.2 来源身份 |
| P3 | lifecycle 的 activeReasoningByMessageId 为内存 Map；生产路径不写 reasoning part，unit test 有不追加该 part 的断言。persistent-store 支持读取此类型不等于生产路径已持久化 | 仅重新查询数据库无法恢复当前完整思考 | §2.2 保留策略 |
| P4 | `apps/ohbaby-web/src/api/daemon/client.ts` 将全量 snapshot、model 查询与 SSE 恢复放在同一失败链；eventReducer.ts 的 replaceSnapshot 重置 reasoning，全局 seq 先过滤 | 模型说明失败也可能关闭流；历史失败拖住审批；旧快照覆盖新内容 | §2.3、§2.5 |
| P5 | persistent-store 的 readUiSession 对每个会话调用 messageManager.listBySession；`core/message/database-store.ts:504` 全量读取，按 created_at、rowid 排序；prompt store listVisible 也读取全 workspace 数据 | 任意长历史都拖慢恢复；前端 slice 不减少数据库读取量 | §2.2、§2.5 分页 |
| P6 | `apps/ohbaby-web/src/ui/selectors.ts:102` 将发送、Stop、输入框禁用绑定全局连接状态；abort 从旧 snapshot 找 active run | 恢复时不能写草稿；历史读取失败就失去 Stop；若按 session 重新找 run，可能停止后来的任务 | §2.3 |
| P7 | ui-inprocess 的 readSnapshotWithPermission 调用 promptScheduler.init、goal 同步；scheduler.init 请求 drain；goal 持久层 rebuild 会正规化 active 为 paused 并写回 | 读页面与启动/修复执行混在一起，反复恢复读不是纯查询 | §2.2 初始化 |
| P8 | server `coordination/event-bus.ts` 是全局有限环形缓冲；`adapters/ui-inprocess/event-router.ts` 吞订阅者异常；run-stream-adapter 的 pump 只保证单 run 顺序 | 多来源缺共同提交点；普通监听者失败可能被掩盖，客户端继续误报健康 | §2.2、§2.6 |

### 思考不落盘的历史原因与新目标

[2026-06-24 方案](../../2026-06-24-reasoning-display/02-design-and-implementation.md)明确采用 B+：实时展示、同轮工具回传，不写 reasoning part，接受重载后不重现；当时否决落盘方案，理由包括数据库膨胀及误回灌 context。实现提交为 `acdb47f0`。因此 P3 是旧目标与新恢复要求之间的差距，不能描述为忘记调用 appendPart。

本次用户 D8/D9 已允许保存展示思考及其结束状态，仍保留模型上下文边界。旧方案中的长期内存保留也随之被替换；目前代码没有因此改变。message 的 ReasoningPart 已有 text/metadata，但尚无本轮所需的结束原因约定；lifecycle 正常、异常、取消/无终态 EOF 的收尾需统一。不能直接把 UI reasoning-end 当作整个模型请求成功。

## 1.2 控制依赖已核实

runtime controller 的 active-run 映射、prompt scheduler 的 accepted/queued/running 记录决定当前执行与输入去向；goal 的驱动归属参与自动推进，属于控制基础。goal 卡片正文、模型说明等展示字段不因此成为发送或 Stop 的必需条件。

todo 当前是按 session/context/workScope 投影的展示列表，ui-inprocess 的 todo onWrite 检查范围；执行驱动不以这份 UI 列表作为准入依据。本轮可将 todo 内容设为附加读取，但必须保留来源范围及 unavailable 状态，不能把读取失败伪装成空列表。未来若加入控制作用，必须重新审查依赖。

prompt 已有 clientRequestId 去重及 promptId/runId/userMessageId 关联；恢复可以识别“已接受但响应丢失”，不能把草稿再发送一遍。第二轮还需要终态 prompt 的时间及消息归属，分页不能只留下活动 prompt。

### 初始化与旧事件补查（2026-09-23）

`adapters/ui-persistent.ts` 已有 startupRecovery/startupReady 和 withStartupRecovery；可迁移一次调度启动，不必另造初始化框架。`WorkspacePromptScheduler.init` 实际调用 requestDrain，并非等待已存在的初始化。`GoalService.storeFor` 有会话缓存，而 snapshot 在 runtime 尚未创建时直接 `GoalStore.rebuild`，其 normalizeAfterReplay 会写 active→paused 等状态。模型 `getRuntime` 还关联子代理恢复，因此不能用创建模型 runtime 来实现纯读取。

旧全量事件有两类生产者：ui-inprocess 的新建/归档/选择和模型配置/发现回调，经 publishSnapshotReplacement 发布；Web client 首次/重连及 JSON-RPC client 的 resync-required 自行读取并生成 replacement。TUI app 初始化/选择使用 getSnapshot，store/events 与 Web eventReducer 的 replacement 会全替换内容。只改服务端一条广播，不能消除旧值覆盖新视图的风险。

## 1.3 七维检查与既有设计关系

| 维度 | 原设计/既有规划 | 差距与本轮关注 |
|---|---|---|
| 职责 | SDK 查询和事件；server 传输；runtime 执行 | 读取夹带初始化，状态和版本共同提交的责任缺失 |
| 架构 | TUI in-process，Web 经 serve，共享 SDK 语义 | 需要 agent 应用读模型，不能只在 server 另攒副本 |
| 数据模型 | 消息/part 为正文与工具事实归属单位 | 实时替身 ID、持久 ID 不同，reasoning 仅内存 |
| 数据流 | snapshot 配合 events 驱动 UI | 全局 seq 是传输顺序，不能为异步状态读取证明一致性 |
| 用例 | 刷新、切会话、继续执行 | 未完成输出、迟到响应及离线期间终态缺完整保证 |
| 非功能 | 长会话、多客户端独立使用 | 全项目历史放大延迟，不能无限缓存事件补洞 |
| 测试 | adapter、reducer、server、SDK contract 已有测试 | reducer 幂等不证明源端切点正确，缺来源身份与 DB/投影交错的组合证据 |

原设计入口：[SDK](../../../ohbaby-sdk/architecture.md)、[server](../../../ohbaby-server/architecture.md)、[Web](../../../ohbaby-web/architecture.md)、[message](../../../core/message/data-model.md)、[lifecycle](../../../core/lifecycle/dfd-interface.md)、[session](../../../services/session/architecture.md)。本批不直接改写，目标差异进入各模块新增 improve 文档。

## 1.4 范围与复杂度

需要按会话维护的应用读模型及明确提交顺序，不需要每个组件一套同步框架。审批版本、当前对话版本和全局 SSE cursor 各司其职。统一消息身份、短事务边界、只读查询不能推给 improve-2；新工具阶段、后台交付、整树 Stop 与冷恢复不在本轮提前实现。

返回：[README](README.md) · [方案](02-optimization-plan-and-change-scope.md) · [验收](04-test-and-acceptance.md)。
