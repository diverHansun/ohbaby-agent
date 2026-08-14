# 4. 测试与验收标准

> 本轮沿用仓库现有 root Vitest、共置 `*.unit.test.ts` / `*.contract.test.ts` / `*.integration.test.ts` / `*.smoke.test.ts` 约定。测试必须验证数据语义和真实数据流，不为改接口只做快照更新。

## 4.1 前置门

| ID | 验证 | 通过标准 |
|----|------|----------|
| G0.1 | improve-1 completion contract | 四终态、endedAt、error 约束和 resolve/reject 语义全绿 |
| G0.2 | scheduler wait lifecycle | close/abort/race 无悬空 waiter |
| G0.3 | client contract | in-process、persistent、remote 满足新 UiBackendClient |
| G0.4 | command record | 脱敏、fail-open、三入口唯一记录通过 |
| G0.5 | compatibility inventory | 旧符号只存在于 improve-2 明确迁移清单 |

任一前置门不通过，不开始本轮 surface 迁移。

## 4.2 CLI 与 TUI

| ID | 场景 | 类型 | 验证点 | Phase |
|----|------|------|--------|-------|
| T1 | CLI succeeded | unit/integration | 使用 andWait；完成后才 dispose；沿用成功退出码 | 1 |
| T2 | CLI failed | unit/integration | completion resolve 后由 CLI 映射非成功，不依赖普通 reject | 1 |
| T3 | CLI interrupted | unit/integration | 显示安全结构化摘要，使用现有中断/非成功策略 | 1 |
| T4 | CLI cancelled | unit/integration | 不误报 succeeded；若由进程信号触发则保留现有信号退出语义 | 1 |
| T5 | CLI 技术 reject | unit | 查询/权限/传输/存储/等待中止错误仍走异常路径 | 1 |
| T6 | TUI accepted | contract | receipt 到达后输入/UI 不等待模型完成 | 1 |
| T7 | TUI accepted reject | contract | 技术提交失败立即显示一次，不生成虚假 pending | 1 |
| T8 | TUI 终态 | contract | succeeded/failed/cancelled/interrupted 都由 prompt event 更新 store/UI | 1 |
| T9 | TUI 无额外 wait | unit | 一次 submit 不创建每-prompt wait 调用或第二状态源 | 1 |
| T10 | TUI event 类型 | typecheck | store/client 直接使用 SDK UiEvent；无重复字段重声明 | 1/5 |
| T11 | queue 必选 | contract | TUI queue edit/cancel/lease 不用 Partial/feature detect | 1/5 |

CLI 具体数值退出码遵循仓库现有集中策略，不在本重构顺便发明一套新码表；验收只要求非成功终态不被当成成功，信号语义不退化。

## 4.3 Server REST 与 JSON-RPC

| ID | 场景 | 类型 | 验证点 | Phase |
|----|------|------|--------|-------|
| T12 | REST wait 四终态 | integration | 合法所属 prompt 返回严格 UiPromptCompletion，四种均正常 HTTP 成功 | 2 |
| T13 | REST wait 未知/越权 | integration | unknown、跨 client/session/workspace 明确拒绝，不泄露存在性细节 | 2 |
| T14 | REST wait abort | integration | client 断开/AbortSignal 结束 waiter；Prompt 本身继续 | 2 |
| T15 | Server shutdown wait | integration | 长等待被技术错误 settle，无悬空请求 | 2 |
| T16 | respondInteraction | contract/integration | requested 时建 interactionId→clientId；REST/RPC 共用原子 authorize-and-claim；resolved/abort/timeout/client removal/shutdown 清理 | 2 |
| T17 | queue 必选 | type/integration | production backend 直接走 accepted/queue；无 legacy fallback | 2/5 |
| T18 | JSON-RPC composition | unit/integration | andWait 只发 accepted + wait 两个 primitive request | 2 |
| T19 | JSON-RPC old method | static/type | protocol method union、route、client 无 `submitPrompt` | 5 |
| T20 | wire projection | contract | `{ ok }`、HTTP wrapper、seqNum 不泄漏到 SDK 返回 DTO | 2/3 |
| T20a | interaction 越权/未知/重复 | adversarial integration | 统一拒绝且不泄露存在性；未执行 backend、不生成 started record | 2 |
| T20b | interaction 并发响应 | race integration | 同一 interaction 只有一个 client/response claim 成功；backend 技术失败按 broker pending 状态安全处理 | 2 |
| T20c | lease owner spoof | adversarial integration | Server 只信认证 clientId；伪造 owner 不能 acquire/renew/release 他人租约 | 2 |

长等待 route 若采用 GET 或 POST 均可，但 contract test 必须覆盖 abort、关闭、所有权和四终态；不能只测试 happy path。

## 4.4 Web client 与 façade

| ID | 场景 | 类型 | 验证点 | Phase |
|----|------|------|--------|-------|
| T21 | 类型权威 | type/contract | BrowserDaemonClient 可赋值给 UiBackendClient，无手写业务接口补洞 | 3 |
| T22 | client 数量 | integration/static | 任一时刻只有当前 workspace 的一个 BrowserDaemonClient 处于活动/连接状态；切换可构造替代实例，但旧实例先失效 | 3 |
| T23 | SDK snapshot | contract | 有活动 workspace 时，非空 `runtime.client.getSnapshot()` 异步返回 UiSnapshot | 3 |
| T24 | store snapshot | unit/type | `runtime.store.getSnapshot()` 同步返回 StoreSnapshot；两者无 overload/union | 3 |
| T25 | Prompt accepted | UI/integration | App 调 SDK 参数形状，receipt 到达即清 pending submit 状态 | 3 |
| T26 | queue mappings | contract | 输入对象、lease owner/context 和 SDK 返回值无 wire wrapper | 3 |
| T27 | model/search/permission | contract | 使用 SDK DTO；API key 不进入错误日志/command record | 3 |
| T28 | runtime workspace façade | integration | open/switch/hide 管 client 生命周期但不逐方法代理 backend | 3 |
| T29 | create/select session | UI/integration | 应用编排保持原行为，完成后 snapshot/navigation 一致 | 3 |
| T30 | abortSession | unit/integration | 解析正确 runId 后只调用一次 abortRun；无 run 时行为明确 | 3 |
| T31 | slash command helper | unit | 文本只解析一次，最终调用 SDK executeCommand invocation | 3 |
| T32 | HTTP helper 边界 | type/static | DaemonHttpClient 不被 UI 直接依赖，不实现 UiBackendClient | 3 |
| T32a | 无活动 workspace | UI/integration | client 为 null，页面进入 empty state；隐藏最后一个 workspace 和初始化无 scope 不抛 getter 异常 | 3 |
| T32b | 切换失败回滚 | integration | client 状态在 switching/active/empty 间类型一致，旧或恢复 client 至多一个 active | 3 |

## 4.5 SSE、snapshot 与事件顺序

| ID | 场景 | 类型 | 验证点 | Phase |
|----|------|------|--------|-------|
| T33 | 单一逻辑订阅 | integration | 一个活动 workspace 无第二 EventSource/fetch stream；多个 SDK subscriber 共用它 | 4 |
| T34 | ui.event 一次解包 | unit/integration | 一个有效 frame 只 dispatch 一次、store apply 一次、每 handler 一次 | 4 |
| T35 | 分发顺序 | unit | handler 执行时 store 已包含该 event 的结果 | 4 |
| T36 | subscriber throw | unit | 一个 handler 异常不阻断其他 handler、连接或 store | 4 |
| T36a | store listener throw | unit | 一个 store listener 异常不阻断其他 store listener、SDK handler 或 SSE callback | 4 |
| T37 | invalid/missing seq | unit | 不更新 store、不通知 handler，产生有界连接诊断 | 4 |
| T38 | duplicate/old seq | unit | reducer 拒绝后 handler 也不收到 | 4 |
| T39 | initial snapshot | integration | seq=0 也能本地构造并应用一次 snapshot.replaced，经统一 dispatch 后再 replay 新 buffer | 4 |
| T40 | resync snapshot | integration | snapshot.replaced 一次；same-seq 权威投影可替换，旧 buffer 丢弃、新事件有序 replay | 4 |
| T40a | same-seq SSE snapshot | integration | 即使 type=snapshot.replaced，只要来源是 SSE incremental 就拒绝，不重复 apply/notify | 4 |
| T40b | local same-seq barrier | integration | 只有 connect/resync/HTTP refresh 本地 barrier 可按 generation 接受并 apply/notify 一次 | 4 |
| T41 | reconnect | integration | 可替换物理连接，但同一时刻只有一个活动 generation | 4 |
| T42 | workspace switch | integration | 旧 client 关闭；迟到 event/snapshot/resync 不污染新 store | 4 |
| T43 | transport control | unit | hello/error/resync-required 不通知 SDK UiEvent subscriber | 4 |
| T44 | catalog invalidation | unit | 由同一 command.catalog.updated 投影触发，无平行 event bus | 4 |

## 4.6 命令记录所有权复验

| ID | 真实链路 | 通过标准 | Phase |
|----|----------|----------|-------|
| T45 | Web → REST → raw Agent backend | 只由 server-rest 产生同 operationId 的 started/completed 两条 | 2–4 |
| T46 | remote CLI → JSON-RPC → raw Agent backend | 只由 server-rpc 产生两条，含 transportRequestId | 2 |
| T47 | local CLI/TUI → Agent host → raw backend | 只由 agent-host 产生两条 | 1 |
| T48 | submitPromptAndWait | 只记录 accepted 原子写；wait 和组合方法无额外记录 | 1–3 |
| T49 | Browser client | 无 UiCommandRecord；Server 记录结果不受 browser subscriber 影响 | 3–4 |
| T50 | recorder 故障 | 三条链路业务结果与 recorder 正常/无 recorder 时一致，诊断有界 | 1–4 |

这里必须使用真实 composition root 或接近真实装配的集成测试；仅用“某 mock recorder 被调用两次”不能证明 Server 与 Agent 不会双记。

## 4.7 删除与静态检查

实现完成后，源码（不含历史规划/迁移说明）应满足：

```text
无 UiBackendClient.submitPrompt
无 JSON-RPC method "submitPrompt"
无 UiPromptQueueClient
无 supportsPromptQueue
无完整 OhbabyWebClient 业务接口
无 TuiEvent 对 UiEvent 的重复联合
无 Partial<...PromptQueue...>
无 client.getSnapshot(): StoreSnapshot
无 RPC seam 的逐方法手抄签名（允许 derived alias）
```

允许 changelog、deprecation migration note 和本规划文档提及旧名称；静态检查不能机械扫描整个仓库后误报历史记录。

## 4.8 建议测试落点

- CLI：扩充 `packages/ohbaby-cli/src/cli/commands/run.unit.test.ts` 与 root CLI integration。
- TUI：扩充 `packages/ohbaby-cli/src/tui/app.contract.test.tsx`、prompt component 和 store tests。
- Server REST：扩充 `packages/ohbaby-server/src/app/create-app.unit.test.ts`，新增 wait/interaction/abort/ownership cases。
- Server RPC：扩充 `packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts` 与 daemon integration。
- Web client：迁移 `apps/ohbaby-web/src/api/daemon/{client,server-client,workspace-switch}.integration.test.ts`。
- Web reducer/stream：扩充 `eventReducer.unit.test.ts` 与 event stream tests，增加 subscriber/order/generation cases。
- Web UI：迁移 `apps/ohbaby-web/src/ui/App.unit.test.tsx` 的 fake，分别注入 runtime/store/SDK client。
- SDK：contract driver 覆盖 Browser/remote/in-process，实现级测试不复制合同断言。

## 4.9 每阶段发布门

| Gate | 时机 | 标准/命令 |
|------|------|-----------|
| G1 | Phase 1 后 | CLI/TUI 定向 unit+contract；`pnpm run typecheck` |
| G2 | Phase 2 后 | Server unit+integration；remote contract；记录 T45–T48 |
| G3 | Phase 3 后 | Web unit+client integration；Browser contract；`pnpm run typecheck` |
| G4 | Phase 4 后 | SSE/resync/workspace-switch integration 全绿 |
| G5 | Phase 5 后 | `pnpm run test:unit && pnpm run test:contract && pnpm run test:integration` |
| G6 | 整轮 | `pnpm test && pnpm run build` |
| G7 | 整轮 | 文档/源码静态删除检查与 4.6 真实链路计数 |
| G8 | 整轮 | `pnpm run preflight`（若环境所需外部依赖可用）；否则逐项记录未运行原因 |

不把真实模型 smoke 设为强制门，除非当前 CI/发布流程本来要求；不得为测试输出真实 API key。

## 4.10 对抗性验收

| 失败模式 | 必须证明 |
|----------|----------|
| CLI 把业务 failed 当 throw，或把 cancelled 当成功 | completion 分支测试直接覆盖四终态 |
| TUI accepted 后又启动 wait，形成双状态源 | 调用计数与事件驱动 contract 证明无 wait |
| runtime 只是逐方法代理 client | 类型/静态审查显示 runtime 仅保留浏览器编排 |
| 为了实现 subscribeEvents 新开第二 SSE | 多 subscriber integration 仍只有一个 stream factory 调用 |
| resync 直接 replace store，subscriber 不知情 | snapshot.replaced 顺序断言 |
| 旧 workspace 的慢 HTTP snapshot 覆盖新 workspace | generation race test 人工延迟旧响应 |
| 初始 seq=0 snapshot 被 reducer 当重复丢弃 | 空 event bus bootstrap test 明确断言 snapshot 已落 store |
| interactionId 被另一 client 回答 | REST/RPC 跨 client、未知、重复和并发 claim 测试 |
| remote lease 伪造 ownerClientId | Server 认证身份覆盖/校验测试 |
| Server 与 Agent 双记 | 真实装配计数严格为两条，不是四条 |
| recorder fail-open 变成静默无限积压 | 故障测试证明无 unbounded retry/queue，诊断有上限 |
| 删除旧符号后文档仍教旧 API | 权威文档链接与 grep 审查纳入发布门 |

## 4.11 完成判定

只有以下条件同时满足，improve-2 才完成：

1. 所有 surface 使用明确 Prompt 方法，Promise 时机与 UI/CLI 生命周期匹配。
2. BrowserDaemonClient 是唯一 Web SDK backend client；runtime 是 façade，不是第二 client。
3. `getSnapshot` 两种语义在类型和调用点上完全分离。
4. 每个活动 workspace 一条逻辑 SSE，UiEvent 单点分发，snapshot/resync/切换顺序已测试。
5. Server transport 覆盖完整必选能力，旧 fallback 与 method 已删除。
6. 三类写入口无重复记录，recorder 故障不影响业务。
7. 旧类型、旧调用、旧测试 fake 和旧权威文档已清理。
8. 各阶段测试、整轮回归与构建通过，并保存可复核证据。
