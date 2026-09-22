# 03 六个参考项目与明确取舍

> 2026-09-19 对用户提供的本地仓库只读调查。以下是代码证据，不宣称运行过它们的 E2E。路径以 `/Users/hansun025/Projects/code-cli/` 为根；revision 固定，未来轮次重新核对相关实现。行号为本次阅读快照。

## 3.1 版本与整体架构

| 项目 | 本地 revision | 与本轮相关的架构 |
|---|---|---|
| kimi-code | `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` | server approval broker + 会话快照 + Web 增量事件；本地交互与 server 分层 |
| opencode | `d4ad650f738aaa986cee5879c581bd4834277577` | core pending registry、schema 明确身份、server reply、app 会话树聚合 |
| pi | `57cde86906679fd0581b277a179ab46fa2a09ab6` | 核心保持轻量，审批与子代理由扩展提供；RPC 可承载扩展 UI 请求 |
| claude-code（本地 CCB） | `987e55034c38497e1081367fdbe2056a6603ebc7` | README 标明 Claude Code Best V5 社区复原扩展项目；swarm worker/leader 审批桥接，不是官方内部源码证明 |
| codex | `5c19155cbd93bfa099016e7487259f61669823ff` | app-server 持有 thread 关联 pending callback，向订阅连接发送并恢复重放 |
| deepseek-harness | `47f943859bef60e4160492346772ded9b24f765a` | Cordis 审批服务 + host gateway pending + client runtime 重建待办 |

## 3.2 Kimi：会话待办与多页面收口

来源：`kimi-code/packages/server/src/services/approval/approvalService.ts:22,74,207`；`packages/server/src/routes/snapshot.ts:166`；`routes/approvals.ts:127`；`apps/kimi-web/src/composables/client/useWorkspaceState.ts:1489`。

- 采用：approval/session/toolCall 身份分开；snapshot 包含 pending_approvals；其他页面抢先回答是正常终态。
- 调整：broker 取消时监听 turn.ended 的 session 清理是桥接丢 signal 后的补救；ohbaby 直接连接 call signal，加 run 级终态兜底，不用 session 广撒网。
- 不照搬：此处 reply 路由只凭 approvalId，不作为完整会话范围检查模板；request 的 publish 与 pending 创建顺序需避免同步重入。`packages/agent-core/src/agent/permission/index.ts:73` 存在父 pattern 继承，与本轮真实来源会话独立授权不一致。
- 限制：pending 为内存，expires_at 字段不等于真正执行超时；没有证明它的全部子会话聚合路径。

## 3.3 OpenCode：树状汇总、真实来源、独立回答

来源：`opencode/packages/schema/src/permission.ts:18`；`packages/core/src/permission.ts:177,220`；`packages/server/src/handlers/permission.ts:73`；`packages/app/src/pages/session/composer/session-request-tree.ts:3`、`session-composer-state.ts:40,85`；`packages/app/src/context/global-sync/bootstrap.ts:439`。

- 采用：pending.set 后再发 asked；按 request ID 找请求；父页面遍历后代，但 respond 使用真实子 sessionID；初始化拉 pending 后以 sessionID 分组。
- 采用其测试思路：`session-composer-state.test.ts:35` 覆盖孙会话与排除其他树。
- 调整：ohbaby 在后台解析 root，不依赖 Web 的 sessions 列表已经包含隐藏子会话；审批只从根主会话入口处理，未来子页只读。
- 明确不采用：reject 连带拒绝同 session 其他 pending；always 保存 project 规则并重评其他会话。用户已确认拒绝单项、授权只在真实来源 session。
- 限制：Effect uninterruptible 不是互斥锁；不能据它声称争答绝对原子。assert finalizer 删除 pending 不等于一定广播撤销，ohbaby 必须完整处理 resolved。NotFound 不应在多页面正常争答时变成永久错误卡。

## 3.4 Codex：请求与连接分离、一次消费

2026-09-21 身份传递补充：`codex/codex-rs/core/src/tools/context.rs:60` 的 `ToolInvocation` 显式携带 session、turn/step_context、cancellation_token 和 call_id。借鉴其“调用发生时携带执行上下文”的原则，落实为本项目真实 runId 从入口传至 scheduler/permission；不声称 Codex 使用本项目同名 runId，也不向 scheduler 引入完整 session 对象或数据库查询。用户已确认，见 [00 D13](00-discussion.md)。

来源：`codex/codex-rs/app-server/src/outgoing_message.rs:114,286,352,445`；`request_processors/thread_lifecycle.rs:322,691`；`message_processor.rs:740`。

- 采用：pending 保存 requestId/threadId/原请求/callback；给 thread 订阅连接发送；resume 向新连接重放；mutex remove_entry 后只消费一次 callback。
- 调整：ohbaby 同进程同步 Map 决议可保证临界段不 await，不必机械增加锁库；工作区和根会话检查仍独立存在。
- `core/src/codex_delegate.rs:308,544` 证实 delegate 子请求转父 session 并保留 call/approval 身份及取消；不能推广成所有 spawn 路径都一样。
- 不采用：改变 ohbaby 默认 TUI 拓扑或引入隐式 attach。此处证明的是 app-server 订阅机制，不代表多人多租户授权。

## 3.5 DeepSeek Harness：断连存活、取消撤销、注册竞态

来源：`deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:1408–1487,3445,3696`；`packages/client/runtime/src/client/sessions/pending.ts:26`；`packages/host/apiproxy/tests/api-proxy-approval.spec.ts:107,112`；`docs/subsystems/approval.md:11`。

- 采用：approvalId/sessionId/callId 与 wire rpcId 分开；断连保留并向新 subscriber 重放；首个回答删除 pending 后广播 resolved；客户端不把 HTTP 回执当最终执行成功。
- 特别采用：answerer 真正注册前检查 signal 是否已 aborted，避免微任务间隙生成僵尸请求；请求自己的 abort 撤销 pending、拆 listener、通知终态。
- 调整：ohbaby 为审批增加独立版本与查询，修复自己的快照/增量窗口，不复制它当前未实现 since 增量、重开流和历史重建的全部结构。
- 不采用：从 audit 事件反查审批 ID；ohbaby 应源头直传。gateway 内存 Map 及 dispose cancelled 不等于重启恢复，也未证实完整父子聚合。

## 3.6 Pi：没有内置审批架构，作为边界对照

来源：`pi/packages/coding-agent/README.md:497,499`；`examples/extensions/permission-gate.ts:14–30`；`src/modes/rpc/rpc-mode.ts:79–128`（后两路径均相对 packages/coding-agent）。

Pi 明确不内置子代理和审批弹窗；扩展示例拦截 tool_call，无 UI 时 block，RPC 用进程内请求 Map 与 signal/timeout 管理扩展问答。借鉴其确定的请求结束路径和扩展边界，**不把它描述成成熟的多客户端审批恢复范例**。

其“无 UI 就拒绝”不用于 ohbaby serve：用户已确认所有页面关闭时 pending 保留。执行后端仍在与进程内没有 UI 能力不是同一个场景。

## 3.7 本地 CCB：来源保留及父入口桥接

来源：`claude-code/README.md:1`；`src/utils/swarm/permissionSync.ts:12,49,360`；`src/hooks/useSwarmPermissionPoller.ts:124`；`src/hooks/useReplBridge.tsx:413`。

采用思路：worker → leader UI → 用户 → worker，保留 worker/team/toolUseId；文件锁保护 pending 到 resolved 的一次决议。ohbaby 用本 runtime manager，不复制跨进程文件轮询，也不改变 TUI in-process。

限制：remote adapter `packages/remote-control-server/web/src/lib/rcs-chat-adapter.ts:142,454` 历史与事件分开，部分 permission/control response 被忽略，不能当作已验证完整刷新恢复的范例。

## 3.8 对本轮方案的直接影响

| 02 决策 | 参考与取舍 |
|---|---|
| 独立 pending 与真实来源 | OpenCode/Kimi 采用；拒绝/always 范围按 ohbaby 已确认规则 |
| 根树聚合、真实子 session 回答 | OpenCode 调整为后台 root 解析、根页控制 |
| 多页面与重放 | Codex/Kimi/DeepSeek；权限不归临时连接所有 |
| 一次决议、取消竞态 | Codex remove、DeepSeek abort 注册；不用 UI 按钮锁充当正确性保证 |
| 审批独立版本与同步提交 | 针对 ohbaby 已发现窗口单独设计，不声称某参考项目直接提供可复制实现 |
| 无页面仍待批、TUI 独立 | 用户决定优先于 Pi 无 UI block 和任何参考项目拓扑 |

## 3.9 故障影响范围复核（2026-09-21）

针对 [00 D19](00-discussion.md) 重新只读检查六个本地项目。以下支持分离连接故障、单请求错误和执行终止，但不声称六者都实现了“严重一致性故障 → 按审批范围停止 → 重启恢复”的完整机制，也未运行它们的故障注入测试。

| 项目 | 已核实的处理 | 借鉴边界与源码 |
|---|---|---|
| Kimi | 断连清连接和订阅，send 失败记录 warning；广播失败捕获并记录；failed/cancelled/filtered turn 才触发 session 审批清理 | `packages/server/src/ws/connection.ts:677,708`、`services/gateway/wsBroadcastService.ts:74`、`services/approval/approvalService.ts:82`。不误撤销不等于已经证明投影出错后仍一致；session 清理不能替代本项目 run 精确清理 |
| OpenCode | Asked 发布失败只删除当前请求，assert 结束清当前请求；事件订阅失败清自身订阅；permission service 销毁才清其全部 pending | `packages/core/src/permission.ts:119,177,207`、`event.ts:153`。用户 reject 连带拒绝同 session 的行为在 `permission.ts:231`，与技术错误是两回事，本项目不采用；不能声称所有事件 listener 都隔离异常 |
| Codex | 普通通知入队失败只 warn；断连接移除该连接上下文/订阅；单请求入队失败或 client error 只移除对应 callback；runtime shutdown 清全部等待 | `codex-rs/app-server/src/outgoing_message.rs:233,344,395,593`、`request_processors/thread_processor.rs:2613`、`in_process.rs:700`。`lib.rs:972` 存在 shutdown_when_no_connections 配置，不能泛称所有运行模式断尽连接仍保留；内部通道失败不等于浏览器断线 |
| DeepSeek Harness | mux 断连仅移除订阅；新订阅重放 pending；展示器异常降级通用展示；单审批 answerer 异常/非法结果返回 unavailable；gateway dispose 清自身 pending | `packages/host/apiproxy/src/api-proxy.ts:740,1415,3445,3528`、`packages/interaction/user-approval/src/index.ts:304`。展示器降级不是审批权威记录损坏时可忽略的证据；`packages/core/session/src/index.ts:381,589,1022` 分开处理提交后观察者错误、提交前校验和持久化失败 |
| 本地 CCB | 先建立本地审批入口；channel 通知失败只记录错误，本地仍可用；swarm 单请求 resolve 失败返回 false；bridge epoch 失效恢复传输，避免杀掉本地 REPL | `src/hooks/toolPermission/handlers/interactiveHandler.ts:331,389,510`、`src/utils/swarm/permissionSync.ts:434`、`src/bridge/replBridgeTransport.ts:206`。这是社区复原扩展版，不代表官方 Claude Code；部分 bridge 写入为 fire-and-forget，不能据此证明完整失败恢复 |
| Pi | 无内置审批系统；扩展示例在无 UI 时阻止当前工具，RPC 扩展 dialog 按请求 signal/timeout 清理 | `packages/coding-agent/README.md:497`、`examples/extensions/permission-gate.ts:20`、`src/modes/rpc/rpc-mode.ts:91`。不适合作为多页面审批恢复或严重一致性机制的直接范例 |

ohbaby 采用已有实践支持的边界：页面发送/展示异常不能改变权威审批决定，单请求失败不能无故清空其他请求，执行结束必须明确完成等待。D19 的严重一致性故障规则是针对本项目制定的保底要求；具体故障判据、同步关键提交和按 root 隔离见 [02 §2.4](02-optimization-plan-and-change-scope.md#24-投影快照和客户端恢复)，并由 [04 T11](04-test-and-acceptance.md) 故障注入验证，不能用参考项目名称代替实现与测试证据。

## 3.10 独立恢复接线的补充取舍（2026-09-21）

- OpenCode `packages/server/src/handlers/event.ts` 先安装有界事件订阅再发 connected，`packages/app/src/context/global-sync/bootstrap.ts` 单独拉取权限待办。采用订阅确认与审批单独读取的思路；本项目 root 连续 revision、epoch 和 bindingGeneration 是针对自身协议设计，不声称 OpenCode 提供同款事务快照。
- Kimi `packages/server/src/services/gateway/wsBroadcastService.ts` 的快照/排空处理体现对订阅窗口的关注；其前端仍有整页快照耦合，不能直接作为 D20 的实现模板。
- Codex 的独立请求 callback 和通知失败 warning 支持“决定与送达分开”；ohbaby 额外规定失败连接重新同步，避免只记录错误后页面永久漏待办。root 级健康冻结是本项目保底，不是六个参考项目的共同机制。

这次借鉴用来补齐注册、自动重连、根范围切换、关键错误传播和故障测试，不扩大到整页恢复方案。参考项目代码仅作设计证据，验收仍以本项目 [04](04-test-and-acceptance.md) 为准。
