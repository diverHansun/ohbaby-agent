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

来源：`codex/codex-rs/app-server/src/outgoing_message.rs:114,286,352,445`；`request_processors/thread_lifecycle.rs:322,691`；`message_processor.rs:740`。

- 采用：pending 保存 requestId/threadId/原请求/callback；给 thread 订阅连接发送；resume 向新连接重放；mutex remove_entry 后只消费一次 callback。
- 调整：ohbaby 同进程同步 Map 决议可保证临界段不 await，不必机械增加锁库；工作区和根会话检查仍独立存在。
- `core/src/codex_delegate.rs:308,544` 证实 delegate 子请求转父 session 并保留 call/approval 身份及取消；不能推广成所有 spawn 路径都一样。
- 不采用：改变 ohbaby 默认 TUI 拓扑或引入隐式 attach。此处证明的是 app-server 订阅机制，不代表多人多租户授权。

## 3.5 DeepSeek Harness：断连存活、取消撤销、注册竞态

来源：`deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:1408–1487,3445,3696`；`packages/client/runtime/src/client/sessions/pending.ts:26`；`packages/host/apiproxy/tests/api-proxy-approval.spec.ts:107,112`；`docs/subsystems/approval.md:11`。

- 采用：approvalId/sessionId/callId 与 wire rpcId 分开；断连保留并向新 subscriber 重放；首个回答删除 pending 后广播 resolved；客户端不把 HTTP 回执当最终执行成功。
- 特别采用：answerer 真正注册前检查 signal 是否已 aborted，避免微任务间隙生成僵尸请求；请求自己的 abort 撤销 pending、拆 listener、通知终态。
- 调整：ohbaby 已有 snapshot/seq，应修好自己的稳定水位，不复制它当前未实现 since 增量、重开流和历史重建的全部结构。
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
| 快照水位与投影 fence | 针对 ohbaby 已发现窗口单独设计，不声称某参考项目直接提供可复制实现 |
| 无页面仍待批、TUI 独立 | 用户决定优先于 Pi 无 UI block 和任何参考项目拓扑 |
