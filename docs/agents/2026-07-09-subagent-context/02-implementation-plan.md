# 02 · 实施方案与改动面（agents 服务层视角）

本文给出 `agents` 服务层的目标结构、`SessionSubagentHost` 设计、持久化方案，以及实施前的文件级改动面。当前决策是：先完成 subagent context/instance 化与工具面收敛，primary root instance 后续单独实施。

---

## 一、目标结构

```
agents/
├── registry.ts / roles.ts / builtin/*       （保留）agent 描述符子层
├── manager.ts                               （保留）getRuntimeAgent / 描述符解析
├── subagent-host.ts                         （新增）SessionSubagentHost，统一 run/status/close
├── subagents/
│   ├── types.ts                             （新增或由 tasks/types.ts 迁移）SubagentInstanceRecord / Store / Controller
│   ├── database-store.ts                    （新增）DatabaseSubagentInstanceStore
│   └── in-memory-store.ts                   （测试/回退）InMemorySubagentInstanceStore
├── tasks/                                   （过渡期可保留路径）
│   └── ...                                  旧 AgentTask* 代码迁移或降级为 host 内部实现
├── service.ts                               （保留 primary startSession 旧路径；executeTask 删除或薄委托）
└── types.ts                                 （微调）Subagent 相关参数名收敛
```

> 实现可以短期沿用 `agents/tasks/*` 目录以降低补丁风险，但领域名和对外契约应改为 `Subagent*`。新文档和新测试以 `SubagentInstance` 命名为准。

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
    parentSessionId: string,
  ): Promise<readonly SubagentInstanceRecord[]>;
}
```

约束：

- 新建 subagent：必须有 `role`、`parentSessionId`、`prompt`，不能传 `subagentId`。
- 继续 subagent：必须有 `subagentId`、`parentSessionId`、`prompt`，`SessionSubagentHost` 校验 parent 归属。
- `mode` 只决定返回时机，不决定是否创建另一套执行路径。
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

`AgentContextScope` 负责校验 identity、生成 `runAgent` options、`context` 查询条件与 `message` 写入/读取 scope。压缩执行仍在 lifecycle/context manager 中完成，但每轮 prepare/compact 必须使用同一个 subagent identity 派生出的 `sessionId + contextScopeId`。数据库继续负责 durable session/message。

`subagentId` 不等于 child `sessionId`。`subagentId` 是 agent instance handle；`sessionId` 是会话/线程容器。若一个 child session 下存在多个 subagent，message/context 读写必须使用 `sessionId + contextScopeId(subagentId)` 隔离。大白话：child session 像一个文件夹，subagent instance 才是一份具体档案，不能只按文件夹名找内容。

---

## 三、持久化方案

### 3.1 新增 `subagent_instance` 表

迁移文件追加到 `services/database/migrations.ts`。本轮实际拆成基础表与 owner 增量两步：`008_subagent_instance` 建表，`011_subagent_instance_owner` 补 `owner_id/owner_pid` 与 owner 状态索引。

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
| `idle` | 实例可继续，当前无运行 turn |
| `completed` | foreground 或 background 当前任务完成 |
| `failed` | 当前 turn 失败 |
| `timed_out` | 当前 turn 超时 |
| `interrupted` | 进程重启或运行中断，必须由主 agent 显式继续 |
| `cancelled` | 用户或 parent 显式关闭 |

重启恢复只把 `pending` / `running` 转成 `interrupted`。不把它们转成 `idle`，也不自动 drain queue。

### 3.3 Store

目标 store：

```typescript
export interface SubagentInstanceStore {
  create(record: SubagentInstanceRecord): Promise<void>;
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

### 3.4 重启语义

进程启动或 parent 首次访问时：

1. host 调 `recoverInterrupted({ parentSessionId?, ownerId, ownerPid, recoverUnknownOwner })`；composition 启动时会注入当前 backend owner。
2. store 只处理中断当前 owner、同 PID 旧 owner、owner PID 已死或 legacy unknown-owner 的 `pending/running` 记录；活着的其他 owner 不动。
3. 被恢复命中的记录置为 `interrupted`，写 `interrupted_at` 与 `updated_at`。
4. host 不创建新 `AgentInstance`，不自动发起 `turn()`。
5. 主 agent 可通过 `subagent_status` 看见 `interrupted` item。
6. 主 agent 如需继续，显式调用 `subagent_run({ subagent_id, prompt, mode })`，host 从该 `subagent_id` 对应的 child session + context scope 重建 instance 并追加新 turn。

`pending_queue` 保留用于观测和审计，但重启后不自动执行。显式继续时，新 prompt 是新的执行输入；队列是否合并留给后续产品策略。

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
| `agents/service.ts` | 保留 primary | `startSession` 继续当前 `runAgent(stream)`；`executeTask` 删除或薄委托到 host |
| `agents/index.ts` | 更新导出 | 导出 host 与 subagent store |

### 5.2 composition

| 位置 | 目标 |
|------|------|
| 创建 store | `new DatabaseSubagentInstanceStore(getDatabase())` |
| 创建 host | 注入 `AgentManager`、`AgentInstanceFactory`、message/session/run deps、store |
| 创建 tools | `createSubagentTools(host)` |
| primary startSession | 本轮仍指向 `AgentService.startSession` 当前实现 |

### 5.3 primary 暂缓项

以下内容不在本轮 agents 实施中完成：

- `startSession` 切 root `AgentInstance`。
- UI stream projection 因 root instance 迁移产生的契约调整。
- primary instance registry。

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
| A5 | composition 装配切换；primary `startSession` 保持旧路径 | A4 |
| A6 | e2e：foreground、background、interrupted resume、长任务压缩 | A5 |
| A7 | 后续阶段：primary root instance | 本轮验收后 |

---

## 七、`goals-duty.md` 增量

`docs/agents/goals-duty.md` 建议在实施时同步更新：

- `SessionSubagentHost` 负责 subagent 生命周期、前后台调度、状态机和工具后端。
- `SubagentInstanceStore` 负责 durable subagent instance 记录，不负责 message 真相源。
- `AgentService` 本轮仍负责 primary `startSession`，不承担 subagent foreground 实现。
- `tools` 只暴露 `subagent_run/status/close` 给主 agent。
- primary root instance 标注为后续阶段，不写入本轮 duty。
