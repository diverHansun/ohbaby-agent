# 05 · 实施前决策与检查门禁（agents 服务层视角）

本文把服务层要遵守的决策写成实施门禁。后续编码先对齐这里，再动 host、store、tools。

---

## 一、已经确认的服务层语义

1. 主 agent 只有一个召唤/继续 subagent 的入口：`subagent_run`。
2. `foreground` 和 `background` 只是等待方式不同，不是两套执行管线。
3. `subagent_status` 统一返回 `{ items: [...] }`，即使只查一个 `subagent_id` 也走同一种结果形状。
4. 重启后按 owner 语义把应恢复的 `pending/running` 改成 `interrupted`，不自动续跑，不自动 drain queue。
5. 显式继续必须调用 `subagent_run({ subagent_id, prompt, mode })`。
6. 一个 child session 可以有多个 subagent instance；child session 不是 context。
7. 用户中断 primary run 时，以 parent session 为 run-tree 边界中断全部 active subagent；pending queue 保留并暂停。
8. caller signal 只控制 foreground waiter，不删除已经持久化的 prompt；只有 `subagent_close` 清空 queue。

---

## 二、ID 语义门禁

| ID | 含义 | 是否唯一 | 用途 |
|----|------|----------|------|
| `session_id` | child session / 线程容器 | session 表内唯一 | message durable 容器、parent 归属 |
| `subagent_id` | 主 agent 可见的 subagent instance handle | subagent_instance 表内唯一 | run/status/close/continue |
| `context_scope_id` | context/message 隔离键 | 同一 `session_id` 下唯一 | context prepare/compact、message 读写过滤 |

默认实现可以让 `context_scope_id = subagent_id`，但不要把 `subagent_id` 写成 `session_id` 的别名。

---

## 三、`SessionSubagentHost` 门禁

- 新建 subagent 时：创建或选择 child `session_id`，再创建独立 `subagent_id/context_scope_id`。
- 继续 subagent 时：按 `subagent_id` 找记录，并校验 `parent_session_id` 属于当前主 agent。
- 创建 `AgentInstance` 时：传入 `instanceId=subagentId`、`contextScopeId`、`sessionId`、`parentSessionId`。
- 任何 message/context 调用：不能只传 `sessionId`，必须能带上 `contextScopeId`。
- background active map 的 key 使用 `subagent_id`，不是 `session_id`。
- 并发新建 subagent 时：选择/创建 child session 的过程必须按 parent 串行化，避免两个并发请求各自创建一个 child session。
- 同一 child session 下多个 subagent 并发运行时：run active 判断必须按 `session_id + context_scope_id`，不能只按 `session_id`。
- sandbox 生命周期必须按 `{ sessionId, contextScopeId? }` lease 管理；释放一个 subagent 的 lease 不得销毁 sibling scope。
- queue 出队与 `current_input/current_run_id/running/owner` 写入必须由 store 原子 `claim` 完成；run 收口必须按 expected `current_run_id` 做 CAS。
- `interrupt:true` 只有在旧 turn 已 settle 时才能自动 drain；不响应 abort 的旧 turn 会使实例暂停为 `interrupted`。同进程内的后续显式 resume 只能追加 durable queue，必须等旧 turn settle 后才 claim 新 run。
- parent run-tree interrupt 必须令该 parent 下全部 active turn 进入 `interrupted`，保留 queue且不得自动 drain；sibling parent 不受影响。
- close 的逻辑终态与 sandbox 物理清理分层：host 关实例，composition 等 scoped lease settle 后销毁 context。
- runtime 热重建必须先 dispose 旧 composition，不允许同一进程残留两个 host 争抢同一 durable instance。
- child session 恢复时必须再次校验 `session.isSubagent` 与 `session.parentId`，不能只信 `subagent_instance.parent_session_id`。
- status/close 工具本身必须声明 `subagent-control`；builtin category 映射不能被工具对象上的旧 `subagent` 值覆盖。

---

## 四、重启语义门禁

“重启后”指进程内存态丢失后重新创建 host/store/controller，例如应用进程重启、服务重新装配、parent 会话首次恢复后台 subagent 状态。

重启恢复只做四件事：

1. 查询 durable store 中 `pending/running` 的 subagent。
2. 按 `owner_id + owner_pid` 判断恢复边界：当前 owner、owner PID 已死、显式允许的 legacy unknown-owner 可标记；同 PID 不同 owner与活着的其他 owner不动。
3. 标记为 `interrupted` 并写 `interrupted_at`；旧 `current_run_id` 转为 `last_run_id` 后清空。
4. 让 `subagent_status` 可观测这些 item。

它不做：

- 不自动创建 `AgentInstance`。
- 不自动调用 `turn()`。
- 不自动继续 `pending_queue`。

---

## 五、编码前检查

- [x] builtin registry 中不再暴露 `task`、`agent_open`、`agent_eval`。
- [x] `subagent_run` 同时覆盖创建与继续。
- [x] `subagent_status` 返回统一 `items[]`。
- [x] SQLite `subagent_instance.session_id` 不是 UNIQUE。
- [x] SQLite 有 `(session_id, context_scope_id)` 唯一约束。
- [x] run ledger 有 `context_scope_id`，并按 `(session_id, context_scope_id)` 判断 active run。
- [x] 同一 child session 多 subagent 的 host/store/context 测试已覆盖。
- [x] scoped sandbox 并发与独立释放测试已覆盖。
- [x] store claim/finish CAS、close 防迟到覆盖测试已覆盖。
- [x] cooperative/non-cooperative interrupt 两种续排语义已覆盖。
- [x] non-cooperative turn 后的显式 resume 保留 durable FIFO，并在旧 turn settle 前不启动 replacement。
- [x] scheduler control-plane 不被 subagent run 并发池阻塞，host 是 deadline 唯一 owner。
- [x] runtime reset 会 dispose 旧 composition。
- [x] backend dispose 会 await runtime dispose，replacement 受 reset barrier 保护。
- [x] foreground pause 保留 durable prompt，跨 owner active admission 明确拒绝。
- [x] SQLite claim/finish 使用 `UPDATE ... RETURNING`，两种 store 的 update 字段语义一致。
- [x] child parent 归属、scope lock、非协作写槽与 sandbox create/destroy 竞态测试已覆盖。
- [x] owner-aware recovery 测试覆盖当前 owner、死 owner、同 PID 不同 owner、活着的其他 owner。
- [x] parent `abortRun` 能级联 active foreground/background subagent，queue 保留且不自动 drain。
- [x] queued foreground caller abort 只解除 waiter，不删除 durable prompt。
- [x] close/session remove/runtime dispose 的 scoped sandbox cleanup 已接线并覆盖测试。
- [x] AC-6 按“两段测试”执行：先基线，后回归。
