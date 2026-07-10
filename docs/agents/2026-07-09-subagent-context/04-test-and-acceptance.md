# 04 · 测试与验收标准（agents 服务层视角）

本文定义 `agents` 服务层本轮改造的测试项与验收标准。范围包括 subagent context/instance 化、单一工具面、durable queue、重启 `interrupted` 语义，以及 primary root 的基础 `AgentInstance` 入口。primary 物理 `contextScopeId` 迁移仍属后续批次。

---

## 一、验收标准（AC）

| 编号 | 验收标准 | 验证方式 |
|------|----------|----------|
| AC-1 | `SessionSubagentHost.run(mode:"foreground")` 支持创建/继续、等待自己的排队轮次，并返回该轮 output/error；`mode` 只决定返回时机 | host 单测 |
| AC-2 | `SessionSubagentHost.run(mode:"background")` 立即返回；所有新 prompt 进入同一 durable FIFO queue，`interrupt` 不清空旧队列；仅在旧 turn 已 settle 时自动续排 | host 单测 |
| AC-3 | `DatabaseSubagentInstanceStore` 正确持久化 `subagent_instance`；真实 SQLite 往返与 cascade 正常 | 集成测试 |
| AC-4 | 重启/恢复时按 owner 语义把当前 owner、死 owner 或显式允许的 legacy unknown-owner 的 `pending/running -> interrupted`，同 PID 不同 owner 不被误伤，不自动续跑；显式 `subagent_run({ subagent_id })` 后继续同一 subagent instance/context scope | 集成测试 |
| AC-5 | 工具 registry 只向主 agent 暴露 `subagent_run/status/close`，不再暴露 `task`、`agent_open`、`agent_eval` | 工具契约测试 |
| AC-6 | 长 subagent 任务采用两段测试：先记录现状基线，再验证改造后 50+ tool step 多次 prepare/compact、不溢出且不串 scope | 集成测试 |
| AC-7 | foreground 与 background 都通过同一个 child `AgentInstance` 执行，`isSubagent` 由 instance/scope identity 派生；`subagent_id` 不等于 child `session_id` | host + core mock 测试 |
| AC-8 | 只剩一套 subagent envelope 编排，不再有 `executeTask` 与后台 manager 两处重复 `runAgent` 编排 | 代码审查 |
| AC-9 | primary `startSession` 通过 `AgentInstance.turn({ waitMode:"stream" })`，且不写 primary `contextScopeId` | service 单测/契约测试 |
| AC-10 | 依赖方向仍为 `agents -> core/agents`，无反向依赖 | lint/依赖测试 |
| AC-11 | 用户 `abortRun` 以 parent session 为边界中断 primary 与全部 active background/foreground subagent；pending queue 保留且不自动续跑 | host + composition + UI 契约测试 |
| AC-12 | `subagent_close` 在 active run lease settle 后只销毁自己的 scoped sandbox；session remove/runtime dispose 能批量回收 context且不影响 sibling scope | sandbox + composition 测试 |

---

## 二、单元测试

### 2.1 `agents/subagent-host.unit.test.ts`

- foreground：成功、失败、timeout 文案、取消、继续已有 `subagent_id` 时 parent 归属校验；运行中收到 foreground prompt 时入队并等待自己的轮次。
- background：立即返回 `pending/running`、完成后 `completed`、失败后 `failed`、timeout 后 `timed_out`。
- queue：首个 prompt 随实例记录原子持久化；claim 用一次写入把队首转为 `currentInput/currentRunId/running`；后续 prompt 追加队尾；`failed/timed_out/interrupted` 暂停，新的 `subagent_run` 才按旧队列到新 prompt 的顺序恢复。
- foreground pause/caller abort：前序失败或 caller 不再等待时解除 foreground waiter/signal，但 prompt 仍持久化，显式 resume 后按 FIFO 执行。
- owner admission：无本地 active state 且 durable record 正在由别的 runtime 执行时明确拒绝，不留下无人消费的 pending prompt；background 只有首次 claim 成功后才返回。
- interrupt：`interrupt:true` abort 当前 turn并保留已经排队的输入；合作式退出后继续 drain，旧 turn 不响应 abort 时暂停为 `interrupted`，不得启动 replacement。后续显式 resume 的 prompt 先入 durable queue，必须等旧 turn 真正 settle 后才 drain；parent run-tree interrupt 中断该 parent 全部 active turn、保留 queue并强制暂停，不自动续排。
- close：运行中 close 触发 abort、清空 queue/currentInput、把 current run 转为 last run、完成等待者并置 `cancelled`；close 后不可复活。
- timeout/owner：单次 timeout 覆盖不修改实例默认值；host 的 hard deadline 能收口不响应 abort 的 turn；scheduler 不另设固定墙钟 guard；每轮原子 claim 都刷新 active owner。
- CAS：两个 host 只能有一个 claim 成功；close 后旧 run 的迟到 finish 不得覆盖 `cancelled`。
- identity：创建/恢复 instance 时传入同一个 `subagentId/contextScopeId/sessionId/parentSessionId`、role/name；非法 parent 被拒绝。

### 2.2 `agents/subagents/database-store.integration.test.ts`

- 使用真实 SQLite 与迁移夹具。
- `create/get/update/listByParent/markInterrupted` 往返。
- `claim` 只允许一个 owner 原子认领；`finishRun` 必须匹配 `current_run_id`，并拒绝覆盖 closed 记录。
- SQLite `claim/finishRun` 用条件 `UPDATE ... RETURNING` 原子返回本次结果；内存/数据库 store 都拒绝 required mutable 字段显式 `undefined`。
- `markInterrupted` 覆盖 owner 语义：当前 owner命中、死 PID 命中、同 PID 不同 owner与活着的其他 owner不命中。
- `pending_queue` JSON 编解码。
- 同一 `session_id` 下可创建多个不同 `subagent_id`；`(session_id, context_scope_id)` 唯一。
- `current_input` JSON 往返；恢复时保留 input、清空 current run 并转存 last run。
- 删除 child session 后 `subagent_instance` 级联删除。
- 迁移 `008_subagent_instance` 应用后表与索引存在。

### 2.3 `tools/subagent.unit.test.ts`

- `subagent_run` schema 支持创建与继续：`role + prompt`、`subagent_id + prompt`。
- `subagent_status` 能按 `subagent_id` 查，也能按 parent 列表查。
- `subagent_close` 返回关闭状态。
- 快照断言 builtin 工具集合不包含旧 `task`、`agent_open`、`agent_eval`。

### 2.4 `agents/service.unit.test.ts`

- primary `startSession` 通过同一个 `AgentInstanceFactory` 创建 `type:"primary"` 实例并执行 `turn(stream)`。
- 断言 `RunManager.create` 不带 primary `contextScopeId`；旧 subagent 编排用例全部迁移到 `subagent-host.unit.test.ts`。

---

## 三、集成 / 契约测试

### 3.1 重启恢复（AC-4）

1. 造一个 parent session、child session 与 `subagent_instance` 记录。
2. 将记录置为 `pending` 或 `running`。
3. 新建 host 模拟进程重启。
4. 调 `recoverInterrupted({ parentSessionId, ownerId, ownerPid })` 后断言命中的记录 status 为 `interrupted`，活着的其他 owner 不被改动，且没有启动新 run。
5. 调 `subagent_run({ subagent_id, prompt, mode })` 后，断言同一 subagent context scope 追加 message，context 含此前历史。

### 3.2 同 session 多 subagent 隔离

- 在同一 child session 下创建两个 `subagent_instance`，分别使用不同 `subagent_id/context_scope_id`。
- 两个实例使用不同 role，断言 system prompt 取当前 run 的 role，不取共享 `Session.agentName`。
- 分别写入一轮消息并触发 prepare/compact。
- 断言 A 的 context 不包含 B 的消息，B 的 context 不包含 A 的消息。
- 断言 `subagent_status` 统一返回 `items[]`，其中两个 item 可按 `subagent_id` 区分。

### 3.3 长任务不溢出（AC-6）

AC-6 拆成两段：

**阶段 A：现状基线**

- 在改造前或旧路径夹具中跑同一个 50+ tool step 场景。
- 记录是否溢出、`prepareTurn` 次数、压缩触发情况、最终 token 规模。
- 这个阶段不强行要求失败；它用于区分“已存在缺陷复现”和“行为基线”。

**阶段 B：改造后回归**

- 用 mock LLM 与 mock tools 模拟 50+ tool step。
- 断言每步都经过 core lifecycle prepare。
- 断言最终不抛 context overflow，并能完成或进入可观测失败态。
- 若同一 child session 下有多个 subagent，断言长任务压缩只作用于当前 `context_scope_id`。

### 3.4 端到端（AC-5/AC-8）

- primary 会话中调用 `subagent_run(mode:"foreground")`，阻塞拿结果。
- primary 会话中调用 `subagent_run(mode:"background")`，立即拿 `subagent_id`。
- 使用 `subagent_status` 观察完成。
- 使用 `subagent_run({ subagent_id, prompt })` 继续同一 child。
- 使用 `subagent_close` 关闭后台 child。

### 3.5 primary 回归

- `agents/service.unit.test.ts` 断言 primary 通过 `AgentInstance.turn(stream)`，且 run scope 不带 `contextScopeId`。
- `adapters/ui-runtime/composition.unit.test.ts` 与 `adapters/ui-inprocess.contract.test.ts` 继续验证 primary stream envelope 不变。

### 3.6 scoped sandbox 与 runtime 重建

- 同一 child session 的两个 `contextScopeId` 可以同时 acquire/run；释放 A 的 lease 后 B 的 context 仍然可查询和使用。
- runtime e2e 必须让 A 先完成而 B 仍保持 active，断言 A 只 release 自己的 scoped lease、没有触发 session/context destroy，并且 B 的 lease 仍可解析 workspace 内路径。
- child session 必须验证 `isSubagent + parentId` 与 durable record 一致；伪造/损坏归属不得进入 turn。
- runtime 热重建先调用旧 composition 的 `dispose()`；旧 run 被取消且 lease 释放后才能替换 runtime。
- `subagent_status/close` 使用 control-plane 并发类别，不被长时间运行的 `subagent_run` 占满执行池而饿死。
- SandboxManager 对同 scope 的 pending create/destroy 去重和串行收口；RunManager 的 scope lock 不阻塞 sibling；取消后的非协作写工具在 settle 前不释放写槽。

### 3.7 parent run-tree interrupt（AC-11）

- primary 同时启动 foreground 与 background subagent 后保持 run active。
- 调用 `abortRun(primaryRunId)`，断言 primary 与该 parent 下所有 active child signal 都被 abort；RunManager 已无该 record、但 run ledger 仍可定位 parent session 时，仍必须中断 child tree。
- sibling parent 的 subagent 不受影响；当前 child 状态为 `interrupted`，pending queue 原样保留且没有自动续跑。
- queued foreground caller 的 waiter 结束，但 durable prompt 不从 queue 删除。

### 3.8 scoped sandbox cleanup（AC-12）

- close running subagent 时先完成逻辑终态，等对应 RunManager lease settle 后销毁 `{sessionId, contextScopeId}`。
- sibling scope 仍可继续运行；单个 run completion 不触发 context destroy。
- runtime dispose 在 `cancelAll` settle 后销毁全部 context；session remove 销毁该 session 的 primary/scoped context。

---

## 四、回归与不破坏

| 项 | 要求 |
|----|------|
| child session durable 归属 | `session.parent_id` 继续存在并被校验 |
| subagent memory 策略 | 继续不加载 primary memory |
| `SUBAGENT_DISABLED_TOOLS` | 继续生效 |
| 描述符子层 | registry/manager/roles/builtin 不做行为性重构 |
| DB 迁移 | 既有迁移保持幂等；008 建表、011 owner、012 current_input 可从旧库顺序升级 |
| primary stream | 执行入口改为 `AgentInstance.turn(stream)`，返回 envelope 不变；物理 scope 延后 |

---

## 五、验收清单（Definition of Done）

- [x] `SessionSubagentHost` 实现 `run/status/close/recoverInterrupted/dispose`。
- [x] `subagent_instance` 表迁移与 schema 定义完成。
- [x] `DatabaseSubagentInstanceStore` 实现并通过真实 SQLite 集成测试。
- [x] `subagent_run/status/close` 工具接入 builtin registry。
- [x] 旧 `task`、`agent_open`、`agent_eval` 不再暴露给主 agent。
- [x] 重启后的 `pending/running` 记录置为 `interrupted`，且无自动续跑。
- [x] owner-aware recovery 覆盖当前 owner、死 owner、同 PID 不同 owner、活着的其他 owner 四类记录。
- [x] foreground/background 都通过同一个 `AgentInstance` 路径执行。
- [x] primary `startSession` 已接入 `AgentInstance.turn(stream)`，且不写物理 `contextScopeId`。
- [x] scoped sandbox、host deadline、queue/CAS、close、runtime dispose 的竞态测试通过。
- [x] primary abort 对 foreground/background subagent 的 parent-session 级联已覆盖。
- [x] caller abort 只解除 waiter、保留 durable prompt 已覆盖。
- [x] AC-1 至 AC-12 全部通过。
- [x] `docs/agents/goals-duty.md` 与 `dfd-interface.md` 已更新。
- [x] 与 `docs/core/agents/2026-07-09-subagent-context` 的接口契约一致。
