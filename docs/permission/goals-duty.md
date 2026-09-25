# permission 模块 goals-duty.md

本文档描述当前 `packages/ohbaby-agent/src/permission/` 的职责。执行可靠性契约见 [improve-1 实施契约](../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)。

## 一、模块定位

permission 负责运行时权限求值、会话规则和独立审批请求的生命周期。`evaluatePermission()` 给出 allow/deny/ask；`PermissionManager` 管理需要交互确认的请求。它是 pending 的业务权威，UI 列表、事件缓存和审批投影均为派生视图。

## 二、设计目标

| 目标           | 当前约束                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 独立请求       | 每次登记生成独立 permissionId，保存到 `Map<permissionId, PendingRequest>`；任何 pending ID 都能直接回答，显示顺序不限制决议 |
| 一次决议       | 回答、signal abort 和撤销共用同步结算入口；只有首个合法终态生效                                                             |
| 真实身份       | 显式携带真实 sessionId/runId/callId/messageId、冻结来源和调用 signal，不以当前主代理 run 或 callId 推断 runId               |
| 有限授权       | always 只写入实际来源 session 的规则，不扩大到根会话、兄弟或后代                                                            |
| 可结束等待     | 执行结束按真实 runId 撤销；来源失效、会话删除和 backend dispose 均完成相关等待                                              |
| 提交与通知分离 | 同步关键提交成功后才通知观察者；普通通知失败不回滚合法决议                                                                  |
| 故障隔离       | 严重内部一致性故障冻结可信 root；其他 root 保持可用，清理不依赖已经损坏的投影                                               |

## 三、职责

1. `classifier`、`evaluator` 和 `state` 管理分类、权限求值、mode/level 与会话规则。mode 为 `plan | auto`，level 为 `default | full-access`。
2. `ask()` 校验执行上下文、健康状态和 signal；已有合法规则或 Full Access 直接放行时不登记 pending、不发布审批 requested/resolved。
3. 每条需确认的请求独立登记并提交 requested；用户可回答任意待批 ID，不存在 current 或队首门槛。
4. `respond()` 校验实际来源 session、choice、signal 和最新 deny。once 本次允许；always 保存规则；reject 拒绝；suggest 拒绝并携带建议。外部 cancel 是非法 choice。
5. always 对同一来源 session 中已经登记、可记忆且匹配规则的请求逐项重新检查并自动结算，每项保留独立终态。
6. 通过 `revokeByRun()` 精确结束一个 run 的等待；通过 `revokeBySession()` 撤销来源、根或冻结祖先链经过目标节点的请求。`clearSession()` 另清理目标 session 的规则。
7. 保存有界近期终态身份，区分安全重复、撤销和未知 ID。默认最多 1024 条，不保留工具参数或正文。

## 四、Full Access

主、子代理按相同运行时 level 求值。Full Access 下，新请求不再因敏感路径、显式工具/MCP 批准或外部目录访问进入人工 ask；已有明确 deny 仍优先，工具自身路径/命令限制、参数校验和资源保护继续生效。Full Access 不生成 always 规则，不跨 session 写授权；切换 level 只影响后续准入，不自动处理已经登记的 pending。

## 五、非职责与边界

- 不查询会话数据库或解析父子树。application wrapper 验证 workspace 和父链，把不可变 `PermissionSource` 传入 manager。
- 不渲染 UI，不管理浏览器连接、clientId 或认证。adapter/server 校验根范围和传输绑定；UI 使用独立审批快照及事件恢复。
- 不执行工具，不把一次拒绝扩大为整棵代理树 Stop。调用 signal 和 run 终态由执行生命周期提供。
- 不新增审批墙钟期限。执行已有期限仍可通过 signal 或 run 撤销结束等待；关闭页面或连接断开本身不撤销请求。
- 不持久化 pending、Promise 或近期终态，不恢复旧 runtime 的请求 ID；会话规则也仅在当前运行时内存中保存。
- 不处理 Ctrl+C。运行中断属于独立的 CLI/runtime 控制，审批卡片提供允许/拒绝，不提供 Cancel run。

## 六、协作模块

| 模块                       | 边界                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| lifecycle / scheduler      | 传递真实执行身份和调用 signal，批准后继续检查取消，run 结束调用精确撤销 |
| application source wrapper | 校验并冻结来源到 root 的完整祖先链                                      |
| approval projection        | 通过同步 `criticalCommit` 接收权威变化，提供同一版本的集合和 revision   |
| Bus                        | 在提交后发布兼容领域通知及 mode/level/rule 变化                         |
| SDK / server / UI          | 独立同步审批、校验根范围与绑定、展示来源、允许选择非首项                |
