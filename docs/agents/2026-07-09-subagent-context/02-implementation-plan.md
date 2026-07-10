# 02 · 实施方案与改动面（agents 服务层视角）

本文给出 `agents` 服务层的目标结构、`SessionSubagentHost` 设计、持久化方案，以及实施前的文件级改动面。当前决策是：完成 subagent context/instance 化与工具面收敛；primary `startSession` 已接入 `AgentInstance.turn(stream)`，但 primary 物理 `contextScopeId` 后续单独实施。

---

## 一、目标结构

```
agents/
├── registry.ts / roles.ts / builtin/*       （保留）agent 描述符子层
├── manager.ts                               （保留）getRuntimeAgent / 描述符解析
├── subagent-host.ts                         （新增）SessionSubagentHost，统一 run/status/close
├── subagents/
│   ├── types.ts                             SubagentInstanceRecord / Store 契约
│   ├── database-store.ts                    DatabaseSubagentInstanceStore
│   └── in-memory-store.ts                   （测试/回退）InMemorySubagentInstanceStore
├── service.ts                               primary startSession 走 AgentInstance.turn
└── types.ts                                 （微调）Subagent 相关参数名收敛
```

> 旧 `agents/tasks/*`、`AgentTaskManager` 与 `AgentService.executeTask` 已删除；当前实现与测试只使用 `SubagentInstance` / `SessionSubagentHost` 领域名。

---

## 二、SessionSubagentHost 设计

### 2.1 职责

`SessionSubagentHost` 是 subagent 生命周期的唯一 owner，负责：

1. 创建或恢复 child `AgentInstance`。
2. 维护前台/后台执行的并发、timeout、取消与队列。
3. 持久化后台 subagent 实例态。
4. 向工具层提供 `subagent_run/status/close` 的后端。
5. 在进程重启后把未完成实例标记为 `interrupted`，但不自动续跑。

```typescript
export type SubagentRunMode = "foreground" | "background";

export interface SubagentRunInput {
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly mode: SubagentRunMode;
  readonly role?: SubagentRole;          // 创建新 subagent 时必填
  readonly subagentId?: string;          // 继续既有 subagent 时必填
  readonly name?: string;
  readonly description?: string;
  readonly interrupt?: boolean;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
}

export interface SubagentLookupInput {
  readonly parentSessionId: string;
  readonly subagentId: string;
}

export interface SubagentStatusInput {
  readonly parentSessionId: string;
  readonly subagentId?: string;          // 为空时列出 parent 下所有 subagent
}

export interface SubagentStatusResult {
  readonly items: readonly SubagentInstanceRecord[];
}

export interface SessionSubagentHost {
  run(input: SubagentRunInput): Promise<SubagentRunResult>;
  status(input: SubagentStatusInput): Promise<SubagentStatusResult>;
  close(input: SubagentLookupInput): Promise<SubagentCloseResult>;
  recoverInterrupted(
    input?: MarkSubagentsInterruptedInput,
  ): Promise<readonly SubagentInstanceRecord[]>;
  dispose(): Promise<void>;
}
```

约束：

- 新建 subagent：必须有 `role`、`parentSessionId`、`prompt`，不能传 `subagentId`。
- 继续 subagent：必须有 `subagentId`、`parentSessionId`、`prompt`，`SessionSubagentHost` 校验 parent 归属。
- `mode` 只决定返回时机，不决定是否创建另一套执行路径。
- foreground/background prompt 都进入同一 durable FIFO queue。foreground 等待自己的队列项，background 在持久化成功后立即返回。
- 若当前 turn 正在运行，新的 prompt 一律入队尾；`interrupt:true` 只 abort 当前 turn，不清空既有输入。只有旧 turn 已确认 settle，host 才能在同一 drain 中继续；旧执行体不响应 abort 时状态转为 `interrupted` 并暂停。后续显式 `subagent_run` 仍会把新 prompt 入队，但 host 保留仅进程内的 settlement barrier，直到旧 `AgentInstance.turn()` 真正 settle 后才 claim/drain，避免两个 run 共用同一 scope。
- `failed` / `timed_out` / 普通 `interrupted` 会暂停；只有新的 `subagent_run({ subagent_id, prompt })` 触发恢复，旧 queue 先执行，新 prompt 最后执行。
- 前序 turn 进入暂停态时，排队中的 foreground 调用不能无限占住主 agent：其 waiter 返回当前失败/中断 item，但 prompt 会去掉进程内 waiter/signal 后继续保留在 durable queue；下次显式继续仍会执行它。
- caller signal 在 prompt 被 claim 前 abort 时，只表示调用方不再等待：host 必须解除 waiter/signal，但已持久化 prompt 继续留在 durable queue。传输层取消无权删除 durable 输入，只有 `subagent_close` 可以清空 queue。
- 用户中断 primary run 时，runtime 以该 run 的 `sessionId` 为 parent 边界，中断该 parent 下所有 active subagent turn；当前输入置为 `interrupted`，pending queue 原样保留且不自动 drain。当前数据模型不区分“由哪一次 primary run spawn”，因此这是 parent-session run-tree 语义。
- 若 durable record 显示另一个 runtime 正在持有 `currentRunId/running`，本 host 明确拒绝新输入并要求稍后重试，不把 prompt 写成无人消费的 pending item。当前不是跨进程分布式队列。
- `subagent_id` 是主 agent 可见的 agent instance handle，不能等同于 child `session.id`。一个 child session 下可以有多个 subagent instance。

### 2.2 内部执行模型

每个 subagent 对应一个 `AgentInstance`：

| 场景 | Host 行为 | 返回 |
|------|-----------|------|
| `subagent_run(mode:"foreground")` 新建 | 创建/选择 child session + `AgentInstance.turn(waitForCompletion)` | 完成后返回 output / error |
| `subagent_run(mode:"background")` 新建 | 创建/选择 child session + `subagent_instance` row + 异步调度 `turn()` | 立即返回 `subagent_id` 与 status |
| `subagent_run(subagent_id, mode:"foreground")` | 恢复同一 instance，追加一轮 `turn()`，调用方阻塞 | 完成后返回 output / error |
| `subagent_run(subagent_id, mode:"background")` | 恢复同一 instance，入队或 interrupt 后调度 | 立即返回当前 status |

`runAgent`、deadline、结果收口和状态机只在 host 内写一套。前台和后台不是两个类，而是同一个 instance turn 的两种等待策略。

### 2.3 与 `AgentContextScope` 的连接

`SessionSubagentHost` 不直接拼 `isSubagent` 参数，而是通过 core/agents 的 `AgentInstanceFactory` 创建：

```typescript
const instance = instanceFactory.create({
  instanceId: subagentId,
  contextScopeId: subagentId,
  sessionId,
  type: "sub",
  agentName: role,
  parentSessionId,
  projectRoot,
  modelId,
  maxSteps,
});

await instance.turn({
  prompt,
  waitMode: "waitForCompletion",
  signal,
  environment,
});
```

`AgentContextScope` 负责校验 identity、生成 `runAgent` options、`context` 查询条件与 `message` 写入/读取 scope。压缩执行仍在 lifecycle/context manager 中完成，但每轮 prepare/compact 必须使用同一个 subagent identity 派生出的 `sessionId + contextScopeId`。当前 run 的 `agentName` 也必须透传给 system prompt provider；共享 child session 的 `Session.agentName` 不能作为 subagent role 真相源。数据库继续负责 durable session/message。

`subagentId` 不等于 child `sessionId`。`subagentId` 是 agent instance handle；`sessionId` 是会话/线程容器。若一个 child session 下存在多个 subagent，message/context 读写必须使用 `sessionId + contextScopeId(subagentId)` 隔离。大白话：child session 像一个文件夹，subagent instance 才是一份具体档案，不能只按文件夹名找内容。

---

## 三、持久化方案

### 3.1 新增 `subagent_instance` 表

迁移文件追加到 `services/database/migrations.ts`。本轮实际拆成三步：`008_subagent_instance` 建表，`011_subagent_instance_owner` 补 `owner_id/owner_pid` 与 owner 状态索引，`012_subagent_instance_current_input` 增加 durable in-flight claim。

```sql
CREATE TABLE IF NOT EXISTS subagent_instance (
  subagent_id        TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  context_scope_id   TEXT NOT NULL,
  parent_session_id  TEXT NOT NULL,
  role               TEXT NOT NULL,
  name               TEXT,
  description        TEXT,
  initial_prompt     TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  output             TEXT,
  error              TEXT,
  pending_queue      TEXT NOT NULL DEFAULT '[]',
  current_input      TEXT,
  current_run_id     TEXT,
  last_run_id        TEXT,
  timeout_ms         INTEGER,
  owner_id           TEXT,
  owner_pid          INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER,
  interrupted_at     INTEGER,
  closed_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subagent_instance_parent
  ON subagent_instance(parent_session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_subagent_instance_status
  ON subagent_instance(status);
CREATE INDEX IF NOT EXISTS idx_subagent_instance_session
  ON subagent_instance(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_instance_scope
  ON subagent_instance(session_id, context_scope_id);
CREATE INDEX IF NOT EXISTS idx_subagent_instance_owner_status
  ON subagent_instance(owner_id, owner_pid, status, updated_at);
```

同步在 `services/database/schema.ts` 追加 `subagentInstance: table("subagent_instance", {...})`。

### 3.2 状态枚举

| status | 含义 |
|--------|------|
| `pending` | 已创建或已入队，尚未开始当前 turn |
| `running` | 当前 turn 正在执行 |
| `completed` | foreground 或 background 当前任务完成 |
| `failed` | 当前 turn 失败；暂停 queue，等待显式继续 |
| `timed_out` | 当前 turn 超时；暂停 queue，等待显式继续 |
| `interrupted` | 进程重启或运行中断，必须由主 agent 显式继续 |
| `cancelled` | 用户显式 close；终态，不可继续 |

重启恢复或 parent run-tree interrupt 只把受影响的 active turn 转成 `interrupted`。`failed` / `timed_out` / `interrupted` 都不自动 drain queue；只有新的 `subagent_run({ subagent_id, prompt })` 会恢复，且新 prompt 入队尾。`close` 是唯一清空 queue 的终态。

### 3.3 运行字段语义

| 字段 | 唯一语义 |
|------|----------|
| `initialPrompt` | 创建实例时的不可变审计快照，不作为恢复队列的隐式后备 |
| `pendingQueue` | durable 未开始输入的唯一恢复事实来源；新建时已包含首个 prompt，只存 `prompt/timeoutMs/workdir` 等可序列化描述 |
| `currentInput` | 已从 queue claim、正在执行或因进程退出而中断的 durable 输入；与 `currentRunId` 同一次写入 |
| `currentRunId` | 当前 owner 正在执行的唯一 run；终态或恢复时必须清空 |
| `lastRunId` | 最近一次已收口 run；重启恢复时接收旧 `currentRunId` |
| `timeoutMs` | 实例默认 deadline，创建后不被单次输入覆盖；host 默认 2h |
| `startedAt` | 最近一次 turn 开始时间 |
| `completedAt` | 最近一次 turn 在本进程内完成/失败/超时/中断的收口时间 |
| `interruptedAt` | 重启恢复或运行中断的专用时间；不代表自动续跑 |
| `closedAt` | close 终态时间；存在时任何后续 run 都必须拒绝 |
| `ownerId/ownerPid` | 最近一次 claim 当前 turn 的运行时 owner；每轮开始时重新认领 |

claim 必须用一次带前置条件的 store update 同时完成：`pendingQueue` 移除队首、写 `currentInput/currentRunId/status=running/owner`，且仅允许未关闭、当前非 running 的记录认领成功。SQLite 实现使用同一条 `UPDATE ... RETURNING` 返回本次写入的记录，不能在 update 后另做可被并发穿插的 select。这样既不会出现 prompt 已出队但没有 durable in-flight 记录的空窗，也不会让两个 host 同时执行一个 subagent。

新增 prompt 不能读出整条 `pendingQueue` 后再覆盖写回。store 必须提供原子 `appendPendingQueue()`：SQLite 用单条 JSON append `UPDATE ... RETURNING` 追加可序列化输入；host 只有在 append 成功后才把它投影到内存 active queue。host 对同一 `subagentId` 的 append、claim、暂停收口和 close 使用同一临界区，避免本进程内 append 与整队列 claim snapshot 交叉覆盖。这个串行保证仅覆盖同一个 host 实例；当前不是跨进程分布式队列，不能承诺多个 host 同时修改同一实例的严格线性化。另一个 runtime 已持有 `running/currentRunId` 时仍明确拒绝新输入。

run 收口必须调用 `finishRun(subagentId, expectedCurrentRunId, update)` 做 compare-and-set。只有 durable `current_run_id` 仍等于本轮 run id 且记录未 close 时，成功/失败/timeout 才能落库；否则拒绝迟到结果，保证 close 或其他 owner 的新 claim 不被旧 run 覆盖。

重启恢复会保留 `currentInput` 用于观测，把旧 `currentRunId` 转存为 `lastRunId` 并清空 `currentRunId`；`pendingQueue` 原样保留。中断的 `currentInput` 不自动重放，避免重复执行已有副作用；新的 `subagent_run` 只触发剩余 pending queue 与新 prompt。`ToolExecutionEnvironment` 含函数，禁止写入 queue；host 只持久化 `workdir`，恢复执行时由 run manager 重新申请 `sessionId + contextScopeId` 对应的 sandbox lease。内存 `active.queue` 是 durable queue 的当前进程投影，用于附加 `AbortSignal`、foreground waiter 与 environment；它不是恢复或跨 runtime 的事实来源，且必须在 durable 写成功后才更新。

### 3.4 Store

目标 store：

```typescript
export interface SubagentInstanceStore {
  appendPendingQueue(
    subagentId: string,
    input: QueuedSubagentInput,
    updatedAt: number,
  ): Promise<SubagentInstanceRecord | null>;
  create(record: SubagentInstanceRecord): Promise<void>;
  claim(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord | null>;
  finishRun(
    subagentId: string,
    currentRunId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord>;
  get(input: SubagentLookupInput): Promise<SubagentInstanceRecord | null>;
  update(subagentId: string, update: SubagentInstanceUpdate): Promise<SubagentInstanceRecord>;
  listByParent(parentSessionId: string): Promise<readonly SubagentInstanceRecord[]>;
  markInterrupted(input?: {
    readonly parentSessionId?: string;
    readonly interruptedAt?: number;
    readonly ownerId?: string;
    readonly ownerPid?: number;
    readonly recoverUnknownOwner?: boolean;
  }): Promise<readonly SubagentInstanceRecord[]>;
}
```

实现路径建议：

- `agents/subagents/database-store.ts`：真实 SQLite store。
- `agents/subagents/in-memory-store.ts`：单测与过渡。
- 旧 `AgentTaskStore` 可在迁移期适配，但最终不应继续暴露 `task` 领域名。

### 3.5 重启语义

进程启动或 parent 首次访问时：

1. host 调 `recoverInterrupted({ parentSessionId?, ownerId, ownerPid, recoverUnknownOwner })`；composition 启动时会注入当前 backend owner。
2. store 只处理中断当前 `ownerId`、owner PID 已死或显式允许的 legacy unknown-owner `pending/running` 记录；同 PID 不同 owner 默认视为仍活着，不能仅凭 PID 相同抢占。
3. 被恢复命中的记录置为 `interrupted`，写 `interrupted_at` 与 `updated_at`。
4. host 不创建新 `AgentInstance`，不自动发起 `turn()`。
5. 主 agent 可通过 `subagent_status` 看见 `interrupted` item。
6. 主 agent 如需继续，显式调用 `subagent_run({ subagent_id, prompt, mode })`，host 从该 `subagent_id` 对应的 child session + context scope 重建 instance；若 `pending_queue` 非空，新 prompt 入队尾，先 drain 旧队列。

`pending_queue` 保留用于观测和审计，重启后不自动执行；显式继续才会触发 drain。仅进程内的 settlement barrier 不持久化：进程重启意味着旧执行体已经不再属于新 host，恢复流程仍以 durable `interrupted` 记录为准。

配置热重建必须先 `dispose()` 旧 runtime，旧 host 会按精确 `ownerId` 收口自己的 active instance，再创建 replacement。一个 OS 进程内可以有多个 backend owner；owner 恢复不能把“PID 相同”等同于“旧 owner 已死”。若未来需要覆盖 PID reuse 或跨进程无 PID 环境，再升级为 owner registry/heartbeat/lease。

backend/client 顶层 `dispose()` 必须 await runtime controller reset。reset 使用串行 barrier：先等旧 runtime 的 host/RunManager/sandbox 全部 dispose，再允许 `getRuntime()` 创建 replacement；旧 creation 的失败回调只能清理它自己的 promise 引用。

---

## 四、工具面

### 4.1 对外工具

| 工具 | 用途 | 后端 |
|------|------|------|
| `subagent_run` | 创建或继续一个 subagent；唯一召唤入口 | `SessionSubagentHost.run` |
| `subagent_status` | 查询一个 subagent，或列出 parent 下 subagent 状态 | `SessionSubagentHost.status` |
| `subagent_close` | 关闭或取消一个 subagent | `SessionSubagentHost.close` |

`subagent_run` schema 重点字段：

```typescript
{
  role?: string,
  prompt: string,
  mode?: "foreground" | "background",
  subagent_id?: string,
  name?: string,
  description?: string,
  interrupt?: boolean
}
```

- `mode` 默认建议为 `foreground`，由模型显式选择 `background` 跑长任务。
- `subagent_id` 出现时表示继续既有 child instance，替代旧 `agent_eval`。
- `subagent_run` 声明 `timeoutOwner:"tool"`：scheduler 负责 caller cancel 和并发 admission，不再另设固定墙钟 guard；真正的 2h/单次 `timeout_ms` deadline 只由 host 判定并写 `timed_out`。
- 旧 `task`、`agent_open`、`agent_eval` 不再暴露给主 agent。必要时可以保留内部 deprecated adapter 过渡，但 registry 不应向模型展示。

### 4.2 文件改动

| 文件 | 改动 |
|------|------|
| `tools/subagent.ts` | 新增 `createSubagentTools(host)`，生成 `subagent_run/status/close` |
| `tools/task.ts` | 从 builtin registry 移除；可临时保留 deprecated adapter |
| `tools/agent-task.ts` | 从 builtin registry 移除；可临时保留 deprecated adapter |
| `tools/builtin.ts` | 注入一个 `subagentController` / `subagentHost`，不再同时注入 `taskExecutor` 与 `agentTaskController` |
| `tools/index.ts` | 导出新工具创建器 |

---

## 五、装配与服务层

### 5.1 `agents` 模块

| 文件 | 改动 | 说明 |
|------|------|------|
| `agents/subagent-host.ts` | 新增 | 统一 foreground/background subagent 调度 |
| `agents/subagents/types.ts` | 新增或迁移 | `SubagentInstanceRecord`、store、lookup、result 类型 |
| `agents/subagents/database-store.ts` | 新增 | SQLite durable store |
| `agents/subagents/in-memory-store.ts` | 新增或迁移 | 测试/回退 |
| `agents/tasks/manager.ts` | 收敛/删除 | 旧后台逻辑迁到 host |
| `agents/service.ts` | primary instance 入口 | `startSession` 通过 `AgentInstance.turn(stream)`；primary 不带 `contextScopeId`；不再承担 subagent 编排 |
| `agents/index.ts` | 更新导出 | 导出 host 与 subagent store |

### 5.2 composition

| 位置 | 目标 |
|------|------|
| 创建 store | `new DatabaseSubagentInstanceStore(getDatabase())` |
| 创建 host | 注入 `AgentManager`、`AgentInstanceFactory`、message/session/run deps、store |
| 创建 tools | `createSubagentTools(host)` |
| primary startSession | 指向 `AgentService.startSession`，内部走 `AgentInstance.turn(stream)`，但不写 primary `contextScopeId` |
| primary abort | `interruptRunTree(runId)` 先取得 parent `sessionId`，取消 primary run，并调用 `subagentHost.interruptByParent(sessionId)` |
| subagent close | host 先写 close 终态；composition 在对应 run lease settle 后销毁 `{sessionId, contextScopeId}` sandbox |
| runtime reset/dispose | 热重建先取消旧 runtime 的 active run、释放 scoped sandbox lease并销毁全部 sandbox context，再替换 composition |

RunManager 的 create lock 按 `sessionId + contextScopeId?` 建立，而不是只按 session。旧执行体不响应取消时，同一 scope 的 replacement 继续等待，避免副作用重叠；sibling scope 不受该锁阻塞。ToolScheduler 对已取消但仍未 settle 的写/危险工具保留并发槽，底层 promise settle 后才释放。

### 5.3 primary 暂缓项

以下内容不在本轮 agents 实施中完成：

- primary 物理 `contextScopeId`。
- 既有 primary message 的 `context_scope_id` 回填/迁移。
- UI stream projection 因 primary 物理 scope 迁移产生的契约调整。

这些在 subagent instance/context 基础设施稳定后再单独实施。

---

## 六、分步落地建议

| 步骤 | 内容 | 前置 |
|------|------|------|
| A0 | core/agents S1-S5 完成：`AgentInstance`、有行为的 `AgentContextScope`、subagent turn path | core |
| A1 | `subagent_instance` 迁移 + `DatabaseSubagentInstanceStore` + 集成测试 | 可与 A0 并行 |
| A2 | `SessionSubagentHost.run/status/close` 后台路径，重启置 `interrupted` | A0,A1 |
| A3 | foreground 路径吸收 `AgentService.executeTask` 语义 | A2 |
| A4 | 工具面切到 `subagent_run/status/close`，移除旧工具暴露 | A2,A3 |
| A5 | composition 装配切换；primary `startSession` 走 `AgentInstance.turn(stream)` 但不带 scope | A4 |
| A6 | e2e：foreground、background、interrupted resume、长任务压缩 | A5 |
| A7 | 后续阶段：primary 物理 `contextScopeId` | 本轮验收后 |

---

## 七、`goals-duty.md` 增量

`docs/agents/goals-duty.md` 建议在实施时同步更新：

- `SessionSubagentHost` 负责 subagent 生命周期、前后台调度、状态机和工具后端。
- `SubagentInstanceStore` 负责 durable subagent instance 记录，不负责 message 真相源。
- `AgentService` 本轮负责 primary `startSession`，通过 `AgentInstance.turn(stream)` 执行；不承担 subagent foreground 实现。
- `tools` 只暴露 `subagent_run/status/close` 给主 agent。
- primary 物理 `contextScopeId` 标注为后续阶段，不写入本轮 duty。
