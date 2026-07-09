# 04 · 测试与验收标准（agents 服务层视角）

本文定义 `agents` 服务层本轮改造的测试项与验收标准。范围限定为 subagent context/instance 化、工具面收敛与重启 `interrupted` 语义；primary root instance 不作为本轮 AC。

---

## 一、验收标准（AC）

| 编号 | 验收标准 | 验证方式 |
|------|----------|----------|
| AC-1 | `SessionSubagentHost.run(mode:"foreground")` 与旧 `AgentService.executeTask` 语义等价：输出、错误、超时、取消、并发上限、继续同一 `subagent_id` | host 单测 |
| AC-2 | `SessionSubagentHost.run(mode:"background")` 覆盖旧后台能力：立即返回、排队、interrupt、容量、超时、close | host 单测 |
| AC-3 | `DatabaseSubagentInstanceStore` 正确持久化 `subagent_instance`；真实 SQLite 往返与 cascade 正常 | 集成测试 |
| AC-4 | 重启/恢复时按 owner 语义把当前 owner、同 PID 旧 owner、死 owner 或 legacy unknown-owner 的 `pending/running -> interrupted`，不自动续跑；显式 `subagent_run({ subagent_id })` 后继续同一 subagent instance/context scope | 集成测试 |
| AC-5 | 工具 registry 只向主 agent 暴露 `subagent_run/status/close`，不再暴露 `task`、`agent_open`、`agent_eval` | 工具契约测试 |
| AC-6 | foreground 与 background 都通过同一个 child `AgentInstance` 执行，`isSubagent` 由 instance/scope identity 派生；`subagent_id` 不等于 child `session_id` | host + core mock 测试 |
| AC-7 | 长 subagent 任务采用两段测试：先记录现状基线，再验证改造后多步执行不溢出且不串 scope | 集成测试 |
| AC-8 | 只剩一套 subagent envelope 编排，不再有 `executeTask` 与后台 manager 两处重复 `runAgent` 编排 | 代码审查 |
| AC-9 | 依赖方向仍为 `agents -> core/agents`，无反向依赖 | lint/依赖测试 |

---

## 二、单元测试

### 2.1 `agents/subagent-host.unit.test.ts`

- foreground：成功、失败、timeout 文案、取消、并发上限、继续已有 `subagent_id` 时 parent 归属校验。
- background：立即返回 `pending/running`、完成后 `completed`、失败后 `failed`、timeout 后 `timed_out`。
- queue：同一 `subagent_id` 的第二轮输入排队；`interrupt` 取消当前 turn 并改跑新 prompt。
- close：运行中 close 触发 abort 并置 `cancelled`；已完成 close 幂等。
- identity：创建/恢复 instance 时传入同一个 `subagentId/contextScopeId/sessionId/parentSessionId`、role/name；非法 parent 被拒绝。

### 2.2 `agents/subagents/database-store.integration.test.ts`

- 使用真实 SQLite 与迁移夹具。
- `create/get/update/listByParent/markInterrupted` 往返。
- `markInterrupted` 覆盖 owner 语义：当前 owner 命中、同 PID 旧 owner 命中、死 PID 命中、活着的其他 owner 不命中。
- `pending_queue` JSON 编解码。
- 同一 `session_id` 下可创建多个不同 `subagent_id`；`(session_id, context_scope_id)` 唯一。
- 删除 child session 后 `subagent_instance` 级联删除。
- 迁移 `008_subagent_instance` 应用后表与索引存在。

### 2.3 `tools/subagent.unit.test.ts`

- `subagent_run` schema 支持创建与继续：`role + prompt`、`subagent_id + prompt`。
- `subagent_status` 能按 `subagent_id` 查，也能按 parent 列表查。
- `subagent_close` 返回关闭状态。
- 快照断言 builtin 工具集合不包含旧 `task`、`agent_open`、`agent_eval`。

### 2.4 `agents/service.unit.test.ts`

- 保留 primary `startSession` 当前测试，断言本轮未改 stream 路径。
- 旧 `executeTask` 用例迁移到 `subagent-host.unit.test.ts`；如果代码保留薄委托，只测委托，不再测重复编排。

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
- 分别写入一轮消息并触发 prepare/compact。
- 断言 A 的 context 不包含 B 的消息，B 的 context 不包含 A 的消息。
- 断言 `subagent_status` 统一返回 `items[]`，其中两个 item 可按 `subagent_id` 区分。

### 3.3 长任务不溢出（AC-7）

AC-7 拆成两段：

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

- `adapters/ui-runtime/composition.unit.test.ts` 与 `adapters/ui-inprocess.contract.test.ts` 中 primary stream 契约应保持现状。
- 本轮不要求 primary root instance 等价测试。

---

## 四、回归与不破坏

| 项 | 要求 |
|----|------|
| child session durable 归属 | `session.parent_id` 继续存在并被校验 |
| subagent memory 策略 | 继续不加载 primary memory |
| `SUBAGENT_DISABLED_TOOLS` | 继续生效 |
| 描述符子层 | registry/manager/roles/builtin 不做行为性重构 |
| DB 迁移 | 001 至 007 幂等，新增 008 不破坏旧库升级 |
| primary stream | 本轮不改变返回 envelope |

---

## 五、验收清单（Definition of Done）

- [ ] `SessionSubagentHost` 实现 `run/status/close/recoverInterrupted`。
- [ ] `subagent_instance` 表迁移与 schema 定义完成。
- [ ] `DatabaseSubagentInstanceStore` 实现并通过真实 SQLite 集成测试。
- [ ] `subagent_run/status/close` 工具接入 builtin registry。
- [ ] 旧 `task`、`agent_open`、`agent_eval` 不再暴露给主 agent。
- [ ] 重启后的 `pending/running` 记录置为 `interrupted`，且无自动续跑。
- [ ] owner-aware recovery 覆盖当前 owner、同 PID 旧 owner、死 owner、活着的其他 owner 四类记录。
- [ ] foreground/background 都通过同一个 `AgentInstance` 路径执行。
- [ ] AC-1 至 AC-9 全部通过。
- [ ] `docs/agents/goals-duty.md` 按 02 文档第七节更新。
- [ ] 与 `docs/core/agents/2026-07-09-subagent-context` 的接口契约一致。
