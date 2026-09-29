# 01 现状、证据与问题

> 基线：`93d4482c`，2026-09-19。本文描述尚未改造的实现。真实复现证据见[诊断报告](../evidence/2026-09-19-serve-stalled-tools.md)。本次新增调查为源码分析，未把推导风险写成已完成 E2E。

## 1.1 问题登记

| ID | 现状 / 证据强度 | 代码锚点（定位以符号为准） | 影响 |
|---|---|---|---|
| P1 | 已真实复现：子代理审批刷新后消失 | `adapters/app-events/permission-projection.ts` 的 getActiveRunId ?? callId；server `coordination/client-view.ts` permissionsForClientSnapshot | 子 run 不在 primary runs 中，callId 又被当 runId，恢复时过滤掉 |
| P2 | 已真实复现：主代理审批刷新后因旧页面归属丢失 | server `app/create-app.ts` bootstrap randomUUID、scheduleClientRoutingCleanup；`permission-router.ts` | 旧 owner 保留 5 秒，新页没有请求；清理后无重新同步事件 |
| P3 | 源码确认：manager 范围的单队首阻塞 | agent `permission/manager.ts` current/queue、publishCurrent、respond | 非队首不发布也不能回答，独立会话/子代理互相挡住 |
| P4 | 源码确认缺少取消连接；具体竞态需新测试 | scheduler `confirmPermission/askPermission`；permission `PermissionAskInput` 无 signal | 外层停止等待不等于请求撤销；迟到 always 可能修改授权 |
| P5 | 源码推导：新增与终态投影可乱序 | `permission-projection.ts` runAsyncProjection；Updated 先 await 两步再 publish | resolved 先发布、requested 后发布可导致卡片复活 |
| P6 | 源码推导：快照状态与序号有窗口 | server getSnapshot 后读取 latestSeqNum；persistent-store readSnapshot 复制权限后仍 await 会话读取 | 快照包含旧请求却带新水位，前端丢弃 resolved 后卡片残留 |
| P7 | 身份、显示和控制职责混杂 | SDK `snapshot.ts` UiPermissionRequest 仅 runId；ui-inprocess respondPermission cancel 分支 | 不能可靠标注来源或限定根会话，Cancel run 对象不明 |
| P8 | 源码确认公共清理粒度不足 | ui-inprocess clearPendingPermissionsForRun 从 UI 快照反查后 cancelPending(sessionId) | 新旧 run 同 session 时可能过度清理；尚未投影的 pending 又可能遗漏 |

P1 的传递断点需要按实际层次理解：主会话提交和子代理认领执行时都有真实 runId，core 的 agent runner 也已使用它；`RunWorker` 构造 `LifecycleSessionParams` 时没有带上，后续 `ModelStepParams`、`ToolCallRequest`、scheduler 的 `ToolCall` 与 PermissionAskInput 均没有该字段。显示层的“查当前 run，否则用 callId”是在补这条断链，并不表示整个 core 原本完全不知道 run。具体接线与验证见 [02 §2.2](02-optimization-plan-and-change-scope.md#22-身份契约)和 [04 T02/T10](04-test-and-acceptance.md)。

代码根：agent 为 `packages/ohbaby-agent/src/`；server 为 `packages/ohbaby-server/src/`；SDK 为 `packages/ohbaby-sdk/src/`。P1/P2 最迟 v0.1.12 存在；无全提交 bisect 结论。历史记录不能区分审批、排队或远端执行，因此不将每个历史卡顿都归入 P1–P8。

## 1.2 分层与七维检查

| 维度 | permission / scheduler / lifecycle | adapters / SDK / server | session / agents / clients |
|---|---|---|---|
| goals-duty | 权限应等待用户决定，但 current 把显示顺序变成全局处理资格 | 展示适配却推断 run 身份，server 再次推断归属 | 父子已有关系，但未用于统一审批汇总 |
| architecture | scheduler 的 Promise race 与 manager 生命周期分离 | 实时、快照、响应三个入口规则不同 | TUI 本地、serve 多页，不能混成一种连接模型 |
| data-model | PermissionInfo 有 session/message/call；无可靠 run/signal 传递 | UiPermissionRequest 无真实 source/root 身份 | Session.parentId 与 subagent record.parentSessionId 需一致校验 |
| dfd-interface | ask → pending → response，但 abort 未返回 pending | Bus → 异步投影 → store → SSE；snapshot 的水位不是同一时刻 | 父页应聚合，不应改写子请求 sessionId |
| use-case | 多请求独立回答不支持；拒绝单请求、always 同会话已有 | 刷新、跨页答复、切项目恢复有缺口 | 子代理工具等待对用户不透明 |
| non-functional | 单次生效和资源清理缺少跨层保证 | 有认证与工作区隔离，删除 owner 不能同时删掉隔离 | 不添加隐式 daemon，不复用旧 run 的批准 |
| test | manager 测试局部串行行为，缺少 signal 与晚回答组合 | fallback 单测保护了错误兼容；snapshot 单测只看序号 | 现有 49 个相关测试通过不证明刷新和主子链路完整 |

## 1.3 文档与代码对照

| 既有文档 | 原意 / 现状 | 本轮处理 |
|---|---|---|
| permission/goals-duty G3、D2；architecture 约束2 | 写同一会话串行，代码却是 manager 单 current | 用独立请求登记替代；UI 展示队列留在客户端 |
| ohbaby-web/test 的 snapshot/resync | 刷新后能重建 | 扩展到根/子审批与水位一致性，而非只有聊天消息 |
| global-single-daemon/00 | 默认 TUI 永久 in-process | 保持，不扩大远程 TUI 或跨进程控制 |
| agents/subagent-context 的 timeout/recover | 主子实例具有自己的 run/owner | 复用真实 run，补已结束调用的撤销，不宣称重启完整修复 |
| web chrome polish improve-3 | 审批四键回归与工具状态弱化 | 本轮明确撤销 Cancel run 这一界面合同；完整工具状态归第二轮 |

## 1.4 目前已知、但不应扩大承诺的缺口

`composition.interruptRunTree` 取消定位 run，再调用 `subagentHost.interruptByParent`；后者直接匹配 parentSessionId，不在此函数递归。`tools/bash.ts` background 提前返回，前台的 signal→registry.kill 监听没有同样注册。尚需查其他释放链路，不直接断言所有后台进程泄漏。全树停止和后台 job 归属是第四轮调查重点。

GPT 刷新恢复后旧按钮曾点击未释放等待，尚未独立稳定复现。第一轮响应结果与竞态测试应覆盖此类症状，但不能声称已经查明该次具体原因。

## 1.5 工程判断

按 SWE 基础受力与工程实践：这里优先修跨层身份和生命周期契约，而非再加一套 server pending 真相源。将显示排序与请求处理分离，减少隐含耦合；以跨层行为测试检验，不用局部 mock 通过代替恢复正确。无需求支撑的跨进程协调和持久审批重放留在范围外。

P1–P8 在 02 分阶段回应，在 04 的验收 ID 中逐项覆盖。模块职责路线由[总索引](../README.md)链接，原模块文档保持不变，新建模块 improve-x 说明目标修订，不把规划写成已实现。

## 1.6 讨论后复核：恢复入口与错误传播（2026-09-21）

本节是对第一版方案的补充审核；代码尚未改变，不能将方案漏洞误写成新引入的产品回归。P5/P6 的处理以修订后的 [02 §2.4](02-optimization-plan-and-change-scope.md#24-投影快照和客户端恢复) 为准。

| 复核发现 | 当前代码锚点 | 对方案的影响 |
|---|---|---|
| 第一版要求读快照前后全局 seqNum 不变；聊天 delta 也走同一总线 | server `coordination/event-bus.ts`（EventBus）；`app/create-app.ts` snapshot 路由；Web `eventReducer.ts` 全局水位过滤 | 持续输出可让重试耗尽，审批不能靠等待全局静止恢复；改为 root 审批独立版本，全页一致性放 improve-1.1 |
| client 注册与后端启动通过 getSnapshot 做额外初始化 | server `app/create-app.ts` start、POST /v1/clients；`coordination/client-view.ts` initializeClient | 必需初始化保留并拆出；注册只读会话元数据，不让历史加载阻断审批连接 |
| 会话选择走 resume command 并继续读完整状态 | server PATCH /v1/sessions/:id/select；agent `adapters/ui-inprocess.ts` selectSession/readSnapshotWithPermission | 抽出可信、轻量的选择与范围确认；不能只把前端刷新删除而忽略服务端路由仍未完成 |
| Web connect 的一个 try 同时负责 SSE、snapshot 和模型；hello 被忽略；审批复用 composer.disabled | Web `src/api/daemon/client.ts` doConnect/handleEvent、`events.ts` reader；`src/ui/App.tsx` PermissionModal | 拆审批就绪状态与恢复器，后续 hello 也重同步；UI 挂载不能等待完整快照 |
| 普通领域 Bus 和 UI event-router 捕获订阅者异常 | agent `bus/bus.ts` publish；`adapters/ui-inprocess/event-router.ts` emit | 审批关键提交必须有显式同步错误传播；普通通知失败则使接收端恢复，不能静默挂起，也不能无故撤销全部审批 |

这些是满足 D19/D20 所需的窄接线，不重做聊天/run/todo 的整页一致性，也不改变 TUI 的运行方式。新增测试分别落在 04 T11、T12a–h。
