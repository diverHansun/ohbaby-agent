# 现状与问题分析

2026-11-11。浏览器走查时基线为 `6f4a75cc`；本轮源码勘测基线为 `codex/session-actions-frontend` / `30965c23`。两者之间是侧栏改动，与下述请求和错误链路无交集。本轮没有实施修复。

## 1. 实际证据

| 检查                               | 结果与证据边界                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Zenmux 主会话、Side Chat 短提问    | 分别约 21 秒、23 秒失败；主会话顶部有通用错误，侧聊只有 `failed` 和总耗时。                                  |
| 后端请求记录                       | 失败轮次共 6 次请求，即首次加 5 次重试；没有首正文时间，没有回答正文。                                       |
| 独立请求同一个模型，关闭重试       | 约 1.18 秒返回 HTTP 429，经过安全核对的上游类型为 `rate_limit`；不能再细分为账户 RPM、TPM 或供应商内部限制。 |
| 测试副本改用已配置的 gpt-6.1-terra | 主会话和 Side Chat 在约 2～3 秒内正常显示回答。                                                              |
| Web 功能回归走查                   | 回答下及会话菜单 Fork、Edit 取消和重发、刷新、侧聊继承上下文及恢复、选择引用、停止生成通过。                 |
| 视觉与 TUI                         | 1024px 下编辑框和侧聊未溢出。TUI 仅核查源码，未进行真实终端交互验收。                                        |
| daemon 断线后持续转圈              | 用户补充报告；源码确认已建立连接后的重试没有展示期限。本次只读核查，没有停止用户的 daemon 来重现。           |

因此存在两个独立原因：上游确实拒绝请求，应用也确实缺少连续等待和完整失败反馈。换模型成功只能证明成功链路可用，不能替代对失败路径的修复。

## 2. 承重问题

### P1：重试等待没有进入可恢复的 UI 投影

现有链路是 `streamResponse → lifecycle → worker → stream bridge → UI adapter`。下层已经产生重试事实，但展示只跟随单个请求：

- [worker.ts](../../../../packages/ohbaby-agent/src/runtime/run-manager/worker.ts) 的 `publishLifecycleEvent` 对应分支在约 L479 发布 `run.llm.retrying`。
- [run-stream-adapter.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts) 的 `handleEvent`（约 L725）只消费请求开始、首正文、请求结束，没有处理重试等待。
- [execution.ts](../../../../packages/ohbaby-sdk/src/contract/execution.ts) 的 `projectModelActivity`（L51）只选未结束的请求；失败等待期间返回空。
- [ExecutionProgress.tsx](../../../../apps/ohbaby-web/src/ui/conversation/ExecutionProgress.tsx) 的 `ModelWaiting`（L8）随之卸载，下一次请求重新挂载并从零计时。[working-spinner.tsx](../../../../packages/ohbaby-cli/src/tui/components/working-spinner.tsx) 的 TUI 条件相同。

纯内存补一个重试标记也不够：持久快照和 Side Chat 的 source projection 都会重新用请求记录计算活动状态，刷新仍会丢掉重试等待。源码落点是 [persistent-store.ts](../../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts) 的 `readSnapshot` 和 [source-session-projection.ts](../../../../packages/ohbaby-agent/src/adapters/ui-state/source-session-projection.ts) 的运行投影。

流中的 reasoning 另有当前显示视图，尚未全部落库。[ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) 的 `readSnapshotWithPermission` 会将 source 消息覆盖到最终 sessions，但 runs 仍沿用先前投影；若用 reasoning 判断请求是否恢复，也必须在这次覆盖后重算活动，不能只修数据库快照。

### P2：终态错误归一化丢失原因，几个对象含义不一致

本次 prompt/run 的结构化终态记录保留了 `PROVIDER_RETRY_EXHAUSTED`、`source: provider`、`statusCode: 429`、`attempts: 5` 和 `retryable: true`。

[error-detail.ts](../../../../packages/ohbaby-agent/src/runtime/run-manager/error-detail.ts) 的 `providerMessage`（L93）遇到重试耗尽先返回通用文本，绕过后面的 HTTP 原因分类。[lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) 的 `markAssistantMessageError`（约 L316）又直接从包装错误读取状态，且 `providerFailure` 使用另一套连接恢复文案。于是同一失败可以拥有不同说明。

`UiPromptError` 已满足大部分需要，但 `providerId` 在本次记录未填。`UiRun` 本身尚未暴露 ledger 的结构化 `errorData`，只在 `status` 中带字符串。无 prompt 的轮次若要采用相同的错误展示，不能凭前端字符串猜原因。

### P3：主会话只显示最新错误，Side Chat 遗漏该入口

[prompt-projection.ts](../../../../apps/ohbaby-web/src/ui/session/prompt-projection.ts) 的 `selectPersistedPromptError`（L210）只选当前会话的最新 prompt，并在新轮开始时隐藏错误。[SessionScreen.tsx](../../../../apps/ohbaby-web/src/ui/session/SessionScreen.tsx) 把它放在主区域顶部。

[SideChatPage.tsx](../../../../apps/ohbaby-web/src/ui/side-chat/SideChatPage.tsx) 的 Banner 只消费操作错误和同步错误。正式用户消息写入后，临时 prompt 行又会退出，因此运行后失败只剩耗时行。

后端普通 LLM 失败走 `run.updated / prompt.updated`，不会另发全局 notice；这是会话隔离设计。Web 的 `notice.emitted` 处理目前还是 no-op，右上角 NoticeStack 来自本地操作错误。不能把这两条通道当成已经打通，也不应为了侧聊错误新接一条全局通道。

### P4：关闭记忆及可见进展的语义不完整

主会话用组件局部 `dismissedPromptErrorId` 记关闭；刷新后提示恢复。现有 [draft-storage.ts](../../../../apps/ohbaby-web/src/ui/composer/draft-storage.ts) 已有容错的 sessionStorage 读写辅助，可复用存储方式。

`ModelWaiting` 只看 `firstTextAt`。但当前 Thought 正文已经展示时，第一条回答正文可能还没到，所以 Thought 与 Thinking 可能同时出现。这里要区分“用户已看到进展”和“后端是否允许重试”：[request-observation.ts](../../../../packages/ohbaby-llm/src/client/request-observation.ts) 的首正文指标只记录 `textDelta`，不能改成通用输出指标。

减少动态效果规则还排除了 `.ohb-send-spinner`，编辑发送图标仍会循环旋转。此项是小范围一致性问题，与重试期间整行消失无关。

### P5：现有诊断不能还原每次失败的上游原因

`modelRequests` 已有请求 ID、attempt、起止时间、首正文时间、outcome 和可选 usage。它没有每次失败的 HTTP 状态、上游错误类型或供应商 request ID；当前终态数据也不能代表前面每次失败的原因。

现有记录可以关联时间和归属，无须在每个 error 中复制全部历史。缺口是按现有 request ID 保存经过筛选的失败摘要，而不是建立另一个错误数据库。

### P6：连接重试与界面等待没有分开

[events.ts](../../../../apps/ohbaby-web/src/api/daemon/events.ts) 的 `FetchDaemonEventStream.runLoop`（L160）在已建立的 SSE 断开后持续重试，退避上限为 5 秒；每轮仍报告 reconnecting，没有持续失败后改为静态提示的条件。`openOnce` 把 HTTP 状态压成普通 Error，认证拒绝也走同一循环。首次连接失败则不同：[client-sync.ts](../../../../apps/ohbaby-web/src/api/daemon/client-sync.ts) 的 `doConnect`（L179）会关闭 stream 并设 disconnected，不能误写成所有首次失败都会自动重连。

界面已有可复用的 disconnected 状态，但显示不一致：[MainHeader.tsx](../../../../apps/ohbaby-web/src/ui/shell/MainHeader.tsx) 显示静态 Offline；[SideChatPage.tsx](../../../../apps/ohbaby-web/src/ui/side-chat/SideChatPage.tsx)（L178）把所有异常连接统一写成 Reconnecting；[Composer.tsx](../../../../apps/ohbaby-web/src/ui/composer/Composer.tsx) 的 `composerPlaceholder`（L471）也把 disconnected 写成 Draft while reconnecting。

daemon 正常关闭时，[sse-hub.ts](../../../../packages/ohbaby-server/src/app/sse-hub.ts) 的 `dispose`（L121）直接关闭流，没有可靠的“进程已停止”通知。新进程启动还可能生成新凭据；旧页面无法仅靠同一 token 无限重试完成恢复。因此“联系不上”“认证不再有效”“会话正在同步”要分别表达，不能由浏览器猜进程死活。

即使凭据不变，重启也会丢失内存中的客户端注册。[routes/events.ts](../../../../packages/ohbaby-server/src/protocols/web/routes/events.ts) 的 `/v1/events` 对未注册客户端返回 409；当前 Web 只在 `doConnect` 首次连接时注册，SSE 重连不会重新注册。因此自动重连不能保证跨 daemon 重启恢复，明确的注册失效也需要提示刷新。

远程 TUI 已有自己的持续重连循环：[jsonrpc/client.ts](../../../../packages/ohbaby-server/src/protocols/jsonrpc/client.ts) 的 `runSseReconnectLoop`（L835）按 1、2、5、10、30 秒退避；[session-recovery.ts](../../../../packages/ohbaby-cli/src/tui/session-recovery.ts) 接收 `session.resync-required` 更新 connected；[app.tsx](../../../../packages/ohbaby-cli/src/tui/app.tsx) 目前一直显示 Reconnecting。可以改显示期限，无需为独立进程内 TUI 增加连接系统。

这些连接读取没有“无事件即断开”的约定。正常模型长时间未输出也可能没有事件，不能把 10 秒显示期限写成无消息超时。断线后残留的运行快照也不能继续充当正在生成的证据。

## 3. 按职责检查现状

| 维度       | 现状与影响                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 目标与职责 | LLM 包决定是否重试；agent 持久化运行事实；SDK 投影；Web/TUI 展示。边界合理，缺口集中在事实传递和展示。                                   |
| 架构       | core/lifecycle 与 runtime 都需要安全 provider 原因，不能为复用让 core 反向依赖 runtime。                                                 |
| 数据模型   | request 结束后不可改；run/prompt 保存终态；关闭目前只在组件内。重试安排没有可恢复落点。                                                  |
| 数据流     | 实时 adapter、持久 snapshot、source session projection 及 legacy snapshot 合并后的最终消息视图必须使用同一套活动推导，不能只修其中一条。 |
| 用例       | 成功问答及三项会话操作已走通；失败、重试、刷新和 daemon 持续断开仍需准确说明状态。                                                       |
| 非功能性   | provider 重试不能掩盖持久化失败；诊断不能泄露凭据；等待与错误不得串会话或复活旧运行。                                                    |
| 测试       | 已有请求观测、投影、错误归一化和 App 测试可扩展。现有 App 测试还明确断言新 attempt 重置计时，需要按新语义调整。                          |

`applyMessagePatch` 和 `mergeModelRequests` 都拒绝改写已结束的 attempt。P1 的方案必须保留这个不变量，而不能收到稍后的 retry 事件再回填已结束记录。

## 4. 文档与实现的关系

| 既有约定                                                                                                                          | 当前代码 / 新要求                      | 本轮处理                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| [LLM 数据模型](../../../core/llm-client/data-model.md)：首正文、真实时间、部分输出不重放                                          | 当前代码基本遵循，等待重试缺投影       | 保留指标和重试策略，补可恢复事实。                      |
| [执行观测 improve-2](../../2026-09-19-execution-reliability/improve-2/02-optimization-plan-and-change-scope.md)：单次请求等待展示 | 重试间隔没有活动请求                   | 本轮 02 明确扩展等待语义，不回改历史验收结论。          |
| [旧 TUI spinner 设计](../../../ohbaby-cli/tui-spinner/02-design.md)：全轮运行即显示                                               | 实现已改成请求等待，旧文档不是当前事实 | 实施时同步其有效性说明，避免按旧设计退回全轮 Thinking。 |
| [错误展示约定](../../2026-09-17-connect-reasoning-errors/improve-1/00-discussion.md)：Web/TUI 同一份运行错误含义                  | 文案分叉，侧聊缺入口                   | 统一原因归一化与轮次展示。                              |

## 5. SWE 判断

本轮需要管理的是已有状态的缺口。复用请求 JSON、轮次投影和轻量提示组件，比新增事件表或通知系统更直接。请求重试资格继续由后端决定；前端不从 `retryable`、没有正文或计时器推断执行行为。P1～P5 的回应分别落在 02 的等待事实、错误归一化、轮次展示、关闭记忆和诊断安排中；P6 复用现有连接循环，补显示期限与恢复就绪条件。
