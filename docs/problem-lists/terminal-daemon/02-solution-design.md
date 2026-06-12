# 02 · 优化方案与实施设计

> **文档职责**：针对 `01-problem-analysis.md` 列出的 9 个问题，给出具体的优化方案、牵动代码清单、变更依赖关系和实施顺序。
> **配套文档**：问题罗列见 `01-problem-analysis.md`，参考项目分析见 `03-reference-projects.md`，测试标准见 `04-test-criteria.md`。

---

## 目录

1. [总体策略：分三阶段推进](#总体策略分三阶段推进)
2. [Phase 1: 低垂果实 —— 终端窗口解耦](#phase-1-低垂果实--终端窗口解耦)
   - [1.1 activeSessionId 进程内存化](#11-activeSessionId-进程内存化)
   - [1.2 跨进程 session 忙标志：原子占位](#12-跨进程-session-忙标志原子占位)
   - [1.3 启动行为显式化：增加 `--continue` 标志](#13-启动行为显式化增加---continue-标志)
   - [1.4 运行状态按 active session 过滤（P9）](#14-运行状态按-active-session-过滤p9)
3. [Phase 2: 内部重构 —— 净化代码结构](#phase-2-内部重构--净化代码结构)
   - [2.1 拆分 ui-inprocess.ts](#21-拆分-ui-inprocessts)
   - [2.2 统一空 session 查找逻辑](#22-统一空-session-查找逻辑)
4. [Phase 3: 战略投资 —— Daemon 架构上线（3a 显式 / 3b 自动拉起）](#phase-3-战略投资--daemon-架构上线3a-显式--3b-自动拉起)
   - [3.1 Daemon 入口与 CLI serve 命令接通](#31-daemon-入口与-cli-serve-命令接通)
   - [3.2 CLI terminal 接入 Daemon](#32-cli-terminal-接入-daemon)
   - [3.3 StreamBridge 远程传输层](#33-streambridge-远程传输层)
   - [3.4 Phase 3b: daemon 按需自动拉起（生产终态）](#34-phase-3b-daemon-按需自动拉起生产终态)
   - [3.5 并发控制终态与审批路由](#35-并发控制终态与审批路由)
5. [通信协议决策：ACP / A2A 暂缓](#通信协议决策acp--a2a-暂缓)
6. [变更影响范围总览](#变更影响范围总览)

---

## 总体策略：分三阶段推进

```
Phase 1 (2-3 天)          Phase 2 (3-5 天)          Phase 3 (2-3 周 + auto-spawn)
  ┌──────────────┐       ┌──────────────┐       ┌──────────────────────┐
  │ 终端窗口解耦  │  ──►  │ 内部重构净化  │  ──►  │ Daemon 上线           │
  │              │       │              │       │ 3a 显式 serve（架构）  │
  │ P1,P2,P3,    │       │ P4,P5        │       │ 3b auto-spawn（产品） │
  │ P7,P9        │       │              │       │ P6,P8                │
  └──────────────┘       └──────────────┘       └──────────────────────┘
  低风险，高收益           中等风险，结构改善        高收益，架构升级
```

- **Phase 1 可独立交付**：解决最紧迫的多终端问题，无需改架构
- **Phase 2 在 Phase 1 基础上安全重构**：修改的代码已经是 Phase 1 解耦后的，风险可控
- **Phase 3 是最终目标**：daemon 单后端多前端，为 web/app 铺路

---

## Phase 1: 低垂果实 —— 终端窗口解耦

### 1.1 activeSessionId 进程内存化

**解决的问题**：P1（多终端同会话）、P3（启动行为不可预测）

#### 设计思路

将 `activeSessionId` 从 SQLite `app_state` 表移除，改为进程内存中的 `mutable` 状态。每个终端进程拥有独立的 `activeSessionId`，互不干扰。

启动时 `activeSessionId` 初始化为 `null`（"新会话视窗"：不关联任何已有 session，直到用户发送第一条 prompt）。

`--resume <id>` 的行为完全不变。

#### 牵动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `adapters/ui-state/persistent-store.ts` | **修改** | `readSessions()` 中删除 `getActiveSessionId()` 调用；`setActiveSessionId()` 改为仅写入进程内存 |
| `adapters/ui-state/persistent-store.ts` | **修改** | `readSnapshot()` 的 `activeSessionId` 从进程内存读，初始 `null` |
| `adapters/ui-persistent.ts` | **修改** | `applyResumeSessionOption()` 保持功能，但写入改为进程内存 |
| `adapters/ui-persistent.ts` | **删除** | 删除 `appState.getActiveSessionId()` 相关的 DB 操作 |
| `adapters/ui-state/memory-store.ts` | **不变** | 已经是进程内存实现，不需要改动 |
| `adapters/ui-state/persistent-store.integration.test.ts` | **修改** | 更新测试：验证不持久化 `activeSessionId` |

#### 关键实现伪代码

```typescript
// persistent-store.ts 中的 readSessions()
async function readSessions() {
  // 删除: const activeSessionId = await options.appState.getActiveSessionId();
  const activeSessionId = mutable.activeSessionId; // 进程内存
  // ... 其余不变
}

// writeActiveSessionId 仅在进程内存中操作
async function setActiveSessionId(sessionId: string | null) {
  mutable.activeSessionId = sessionId;
  // 删除: options.appState.setActiveSessionId(sessionId);
}
```

#### 向后兼容

- `app_state` 表中的旧 `activeSessionId` 行在下次启动时会被忽略，数据库迁移可选
- `--resume` 功能完全不受影响
- 内存模式（`createInMemoryUiStateStore`）已具有此行为，无变更

---

### 1.2 跨进程 session 忙标志：原子占位

**解决的问题**：P2（跨进程并发写入）、P7（无忙标志）

#### 设计思路

利用已有的 `run_ledger` 表做原子的 **compare-and-claim**：把"检查 session 是否忙"和"插入新 run 记录"合并进同一个 `BEGIN IMMEDIATE` 事务，而不是先查后提交。run 记录的 insert 本来就要发生，本方案只是把它提前到 pipeline 入口并原子化。

```sql
BEGIN IMMEDIATE;  -- 立即获取写锁，跨进程串行化
SELECT COUNT(*) FROM run_ledger
WHERE session_id = ? AND status IN ('pending', 'running');
-- count > 0 → ROLLBACK，抛 SessionRunBusyError
-- count = 0 → INSERT INTO run_ledger (..., status='pending', ...)
COMMIT;
```

`BEGIN IMMEDIATE` 在事务开始时即获取 SQLite 写锁，两个进程的 claim 被数据库天然串行化，**没有 check-then-act 竞态窗口**（对比先 `countActiveBySession` 再提交的两步式方案）。

这把 P2 中最危险的场景——两个终端同时向同一 session 发 prompt——从"缓解"变为"解决"。

#### 残留风险与兜底

唯一残留风险是进程崩溃后留下僵尸 `pending`/`running` 行导致 session 永久"忙"。兜底已存在：`shouldRecoverStartupRuns` → `markInterrupted`（`ui-persistent.ts`）在启动时清理。可选增强：claim 时跳过超过一定时长（如 30 分钟）无心跳的 stale run。

#### 牵动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `runtime/run-ledger/` | **新增方法** | `claimPendingRun({id, sessionId, promptId, createdAt})` —— 在单个 `BEGIN IMMEDIATE` 事务内完成忙检查 + insert，忙时抛 `SessionRunBusyError` |
| `adapters/ui-inprocess.ts` | **修改** | `submitPromptInternal()` 入口改为调用 `claimPendingRun()`，替代原"先创建 run 再标记"的顺序 |
| `runtime/run-ledger/errors.ts` | **新增** | `SessionRunBusyError` 错误类型（含 sessionId） |

#### 关键实现伪代码

```typescript
async function submitPromptInternal(text: string, submitOptions?) {
  if (promptInFlight) {
    throw new Error("A prompt is already running");
  }
  assertStateStoreWritable();
  promptInFlight = true;
  try {
    // ... 解析/创建 session（不变）
    const runId = await nextRunId();
    // 原子占位：忙则抛 SessionRunBusyError，闲则已插入 pending run
    await options.runLedger.claimPendingRun({ id: runId, sessionId: session.id, ... });
    // ... 后续 startSession 等逻辑不变（run 记录已存在，状态流转 pending → running）
  } finally {
    promptInFlight = false;
  }
}
```

#### 注意

- 与 daemon 架构不冲突且演化路径清晰：daemon 模式下锁的职责转移到 daemon 进程内存（见 3.5），`run_ledger` 降级为持久化审计 + 崩溃恢复，`claimPendingRun` 的接口契约不变，实现简化
- 错误消息应引导用户："Session is busy — wait for the current run or switch to another session"

---

### 1.3 启动行为显式化：增加 `--continue` 标志

**解决的问题**：P3（启动行为隐式）

#### 设计思路

> 修订记录：原方案为 `--new` 标志。Phase 1.1 落地后默认行为已是"空白新视窗"，`--new` 成为无操作 flag（YAGNI），废弃。真正缺失的是反方向的能力：快速回到最近的会话。

启动行为收敛为三种显式入口（对齐 claude-code / gemini-cli 习惯）：

| 入口 | 行为 |
|------|------|
| 默认（无 flag） | 空白新视窗：`activeSessionId = null`，首条 prompt 才创建 session |
| `--resume <id>` | 恢复指定 session（行为不变） |
| `--continue` | 恢复最近一次 primary session（按 `updatedAt` 取最新，过滤 `isSubagent`） |

规则：

- `--resume` 与 `--continue` 互斥，同时使用报 usage 错误
- `--continue` 在无可恢复 session 时回退到空白新视窗，并输出一行提示（不报错）

#### 牵动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `cli/commands/terminal.ts` | **修改** | 增加 `--continue` boolean option，与 `--resume` 互斥校验 |
| `adapters/ui-persistent.ts` | **修改** | `applyResumeSessionOption()` 支持 `continueLatest` 入参：查最近 primary session 后设置 activeSessionId |
| `services/session/manager.ts` | **新增方法** | 可选：`getMostRecentPrimary(projectRoot?)`，复用 `getRecent` + filter |

---

### 1.4 运行状态按 active session 过滤（P9）

**解决的问题**：P9（运行状态跨进程串扰）

#### 设计思路

`snapshotStatus()`（`persistent-store.ts:460-468`）当前在快照中**所有** session 的 runs 里找任意 active run 来决定 `running`/`idle`。修改为只看 `activeSessionId` 对应 session 的 runs：

```typescript
function snapshotStatus(
  runs: readonly RunLedgerRecord[],
  activeSessionId: string | null,
): UiRunStatus {
  if (mutable.status.kind !== "idle") {
    return { ...mutable.status };
  }
  if (activeSessionId === null) {
    return { kind: "idle" };
  }
  const activeRun = runs.find(
    (run) => isActiveRun(run) && run.sessionId === activeSessionId,
  );
  return activeRun
    ? { kind: "running", runId: activeRun.runId }
    : { kind: "idle" };
}
```

#### 牵动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `adapters/ui-state/persistent-store.ts` | **修改** | `snapshotStatus()` 增加 activeSessionId 入参并过滤 |
| `adapters/ui-state/persistent-store.integration.test.ts` | **修改** | 新增串扰回归测试（见 04 文档 1.4） |

---

## Phase 2: 内部重构 —— 净化代码结构

### 2.1 拆分 ui-inprocess.ts

**解决的问题**：P5（单文件 1696 行）

#### 2026-06-12 Phase 2 实施修订

Phase 2 已按 `06-phase-2-execution-plan.md` 收窄为 daemon 前置重构的最小有价值切片，而不是一次性删除 `ui-inprocess.ts`。当前落地结构为：

```
adapters/
  ui-inprocess.ts              # public assembly / composition entry (~1424 行)
  ui-inprocess/
    types.ts                   # 内部共享类型
    session-controller.ts      # active session、create/rename/delete、空 session 复用
    prompt-controller.ts       # prompt queue 绑定与 drain 入口
    runtime-controller.ts      # runtime lazy creation、stream、abort
    event-router.ts            # app event routing、snapshot invalidation、handler isolation
```

这个结果只解决了 P5 的一半：它把 Phase 3 daemon 需要接触的 session/prompt/runtime/event 边界从大文件中抽出，降低继续接线时的风险；但命令执行、title 生成、snapshot 管理、permission/context 等逻辑仍在 `ui-inprocess.ts` 内。后续不应把这部分作为 Phase 3 的阻塞项，而应在 Phase 3/4 真正触碰对应边界时继续按同样原则拆出。

#### 拆分原则

- 每个新 controller 只引入它**直接需要**的依赖（不传整个 `options` 对象）
- 通过构造函数或函数参数显式传递依赖
- `ui-inprocess.ts` 保留为 public import 兼容层和组装入口，不再新增 daemon 相关业务逻辑
- 单元测试跟随新文件拆分
- command/title/snapshot/permission/context 的继续拆分延后到触碰对应功能的阶段

#### 牵动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `adapters/ui-inprocess.ts` | **修改** | 保留为 public assembly，组装 controllers，兼容既有 imports |
| `adapters/ui-inprocess/types.ts` | **新建** | 内部共享类型 |
| `adapters/ui-inprocess/session-controller.ts` | **新建** | session 创建/查找/复用/激活 |
| `adapters/ui-inprocess/prompt-controller.ts` | **新建** | prompt queue binding |
| `adapters/ui-inprocess/runtime-controller.ts` | **新建** | runtime lifecycle、stream、abort |
| `adapters/ui-inprocess/event-router.ts` | **新建** | event fanout、snapshot invalidation、异常隔离 |
| `adapters/ui-inprocess.contract.test.ts` | **保持接口契约** | 只补充行为覆盖，不改 public contract |

---

### 2.2 统一空 session 查找逻辑

**解决的问题**：P4

#### 设计思路

将 `findReusableEmptyPrimary`（Core层）、UI 层空 session 判断、`createSessionFromCommand` 与普通 prompt 的 session 选择合并为一处：

```typescript
// 在 ui-inprocess/session-controller.ts 中
async function resolveSessionForNewPrompt(params: {
  projectRoot: string;
  explicitSessionId?: string;
  snapshot: UiSnapshot;
  sessionManager: SessionManager;
  reuseInactiveEmptySessions?: boolean;
}): Promise<{ session: UiSession; isNewSession: boolean }>
```

这个函数内部做**一次**从高到低优先级的查找（不需要调用方知道细节）：
1. 显式 sessionId 存在 → 使用该 session，不存在则按给定 id 创建
2. 当前 activeSession 如果是同 project 的空 primary session → 复用
3. `reuseInactiveEmptySessions !== true` → 直接创建新 session
4. `reuseInactiveEmptySessions === true` 时，Core 层查找可复用空 primary session
5. `reuseInactiveEmptySessions === true` 时，UI snapshot 中查找可复用空 primary session
6. 都不满足 → 创建新 session

调用语义：

- 普通 `submitPrompt()` 默认不传 `reuseInactiveEmptySessions`，只允许复用当前 active 空 session，避免 fresh terminal 意外捡起 inactive 空 session。
- `/new` 命令显式传 `reuseInactiveEmptySessions: true`，允许复用 inactive empty primary session，避免用户主动新建时制造重复空 session。
- `findReusableEmptyPrimary` 只应从 `resolveSessionForNewPrompt` 这一条路径调用。

---

## Phase 3: 战略投资 —— Daemon 架构上线（3a 显式 / 3b 自动拉起）

### 分两步走

| 子阶段 | 定位 | 内容 |
|--------|------|------|
| **Phase 3a** | 架构验证（面向开发者） | 显式 `serve` 启动 daemon；终端加 `--remote` 才连 daemon，默认仍嵌入式。对应 3.1-3.3 |
| **Phase 3b** | 生产终态（面向 npm 发布用户） | `ohbaby` 启动时按需自动拉起 daemon 并连接，用户无感知。嵌入式降级为 `--no-daemon` 逃生舱。对应 3.4 |

理由：发布形态下不能要求用户先 `ohbaby serve` 再 `ohbaby`（两条命令）。但 auto-spawn 的运维复杂度（版本握手、孤儿进程、空闲回收）应与架构验证解耦——3a 先把"daemon 单写者 + 远程 client 契约"跑通，3b 再解决产品化。先例：Gradle daemon、Bazel client/server、opencode TUI 自动拉起 server。

### 目标架构图

```
┌──────────────────────────────────────────────────┐
│                    Daemon 进程                     │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │              Supervisor                       │ │
│  │  (PID lock, state file, graceful shutdown)   │ │
│  └──────────────────┬───────────────────────────┘ │
│                     │                               │
│  ┌──────────────────▼───────────────────────────┐ │
│  │           bootstrapRuntime()                  │ │
│  │  Bus → RunManager → StreamBridge → DB        │ │
│  │  SessionManager → MessageManager             │ │
│  │  CommandService → PermissionManager          │ │
│  └──────┬──────────────┬──────────────┬─────────┘ │
│         │              │              │            │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────────┐│
│  │ Local RPC   │ │HTTP/WS     │ │StreamBridge    ││
│  │ (stdio/unix │ │Server      │ │"app" scope     ││
│  │  socket)    │ │(Hono)      │ │                ││
│  └──────┬──────┘ └─────┬──────┘ └────────────────┘│
└─────────┼──────────────┼──────────────────────────┘
          │              │
    ┌─────▼──────┐  ┌────▼──────────┐
    │ CLI (TUI)  │  │ Web / App     │
    │ (Ink)      │  │ (未来)        │
    └────────────┘  └───────────────┘
```

### 3.1 Daemon 入口与 CLI serve 命令接通

**解决的问题**：P6、P8

#### 新增文件

| 文件 | 说明 |
|------|------|
| `runtime/daemon/main.ts` | **新建** — `main()` 入口：创建 Supervisor + bootstrap + start |
| `runtime/daemon/server.ts` | **新建** — HTTP/WebSocket server（Hono），暴露 session 操作 API |
| `cli/commands/serve.ts` | **修改** — 用 Supervisor + bootstrap 替换当前 stub |

#### 设计要点

- `daemon/main.ts` 是 daemon 的生产入口，负责：
  1. 解析 `--db-path`、`--port` 等参数
  2. `initDatabase(...)`
  3. `bootstrapRuntime(...)` ← 复用现有代码
  4. `new Supervisor({bootstrap, ...})`
  5. `supervisor.start()`
- `daemon/server.ts` 基于 Hono，提供：
  - `GET /api/sessions` — 列出 sessions
  - `POST /api/sessions` — 创建 session
  - `POST /api/sessions/:id/prompt` — 提交 prompt
  - `WS /api/events` — StreamBridge 实时事件流
- `serve.ts` 调用 `daemon/main.ts` 的入口函数

#### 牵动文件

| 文件 | 变更类型 |
|------|---------|
| `runtime/daemon/main.ts` | **新建** |
| `runtime/daemon/server.ts` | **新建** |
| `cli/commands/serve.ts` | **重写** |
| `runtime/daemon/index.ts` | **修改** — 增加新导出 |
| `runtime/daemon/bootstrap.ts` | **修改** — 增加 SessionManager 组装 |

---

### 3.2 CLI terminal 接入 Daemon

**解决的问题**：让 CLI 终端通过 RPC 连接到 daemon，而非直接创建 Core 进程。

#### 设计要点

CLI 支持两种模式：

- **嵌入式模式（当前）**：CLI 进程内嵌 Core（Phase 1-2 后保留此模式）
- **远程模式（新）**：CLI 连接到 daemon 的 RPC 端口

切换逻辑：

```typescript
// terminal.ts
if (daemonPort || daemonSocketPath) {
  // 远程模式：连接到 daemon
  client = createRemoteUiBackendClient({ host, port });
} else {
  // 嵌入式模式：内嵌 Core（当前路径）
  client = createPersistentUiBackendClient(options);
}
```

`createRemoteUiBackendClient` 实现 `UiBackendClient` 接口，所有方法通过 HTTP/WS 代理到 daemon：

| UiBackendClient 方法 | 远程实现方式 |
|---------------------|------------|
| `getSnapshot()` | `GET /api/snapshot` |
| `submitPrompt(text, opts)` | `POST /api/sessions/:id/prompt` |
| `executeCommand(invocation)` | `POST /api/commands` |
| `subscribeEvents(handler)` | WebSocket 连接，接收 StreamBridge 事件 |
| `respondPermission(...)` | `POST /api/permissions/:id` |
| `abortRun(runId)` | `POST /api/runs/:id/abort` |

#### 新增文件

| 文件 | 说明 |
|------|------|
| `adapters/ui-remote.ts` | **新建** — `createRemoteUiBackendClient` |
| `adapters/ui-remote.integration.test.ts` | **新建** — 远程 client 的集成测试 |
| `adapters/ui-remote.contract.test.ts` | **新建** — 远程 client 的 contract 测试 |

---

### 3.3 StreamBridge 远程传输层

**解决的问题**：P8

#### 设计要点

Daemon 的 StreamBridge 当前是纯内存的发布/订阅。需要增加一个传输适配器，将事件从 StreamBridge 桥接到 WebSocket：

```
StreamBridge (in-memory)
       │
       ▼
StreamBridgeWsAdapter  ← 新增
       │
       ▼
WebSocket Server (Hono)
       │
       ▼
Remote UiBackendClient (CLI)
       │
       ▼
TUI Store (React state)
```

#### 新增文件

| 文件 | 说明 |
|------|------|
| `runtime/daemon/stream-bridge-ws-adapter.ts` | **新建** — 订阅 StreamBridge，广播到 WS 客户端 |

---

### 3.4 Phase 3b: daemon 按需自动拉起（生产终态）

**解决的问题**：npm 发布后用户只运行 `ohbaby` 一条命令；终端/web/app 的写入统一收口到单写者。

#### 连接/拉起流程

```
ohbaby 启动
  │
  ├─► 读 state-file（runtime/daemon/state-file.ts，已有）
  │     ├─ 有记录 → PID 存活校验（pid-file.ts，已有）+ 版本握手
  │     │     ├─ 通过 → 直连（WS/本地端口）
  │     │     └─ 版本不匹配 → 请求旧 daemon 优雅退出 → 走拉起路径
  │     └─ 无记录/进程已死 → 拉起路径
  │
  └─► 拉起路径：detached spawn daemon → 轮询 state-file 就绪（超时报错）→ 连接
```

PID 锁保证并发拉起时只有一个 daemon 胜出，失败方退回连接路径。

#### 三个配套机制（缺一不可）

1. **版本握手**：daemon 在 state-file 中记录自身版本；client 版本不匹配时请求 daemon 优雅退出并拉起新版。解决 npm 升级后旧 daemon 残留服务新 client 的问题。
2. **空闲自退**：最后一个 client 断开 N 分钟（默认建议 15）后 daemon 自动退出，不留常驻进程。
3. **`--no-daemon` 逃生舱**：嵌入式模式保留为显式 flag，用于调试与测试路径，不删除。Phase 1 的原子占位（1.2）继续保护该模式下的多进程并发。

#### 牵动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `cli/commands/terminal.ts` | **修改** | 默认走"发现/拉起 daemon"路径；`--no-daemon` 回退嵌入式 |
| `runtime/daemon/spawn.ts` | **新建** | detached spawn + state-file 就绪轮询 + 版本握手 client 侧 |
| `runtime/daemon/state-file.ts` | **修改** | 记录版本号、端口/socket 路径 |
| `runtime/daemon/supervisor.ts` | **修改** | 空闲自退计时器；收到"版本退位"请求时优雅关闭 |

---

### 3.5 并发控制终态与审批路由

#### 并发控制三层模型

```
进程级    daemon 是 DB 唯一写者（PID 锁保证全局唯一 daemon）
            → 跨进程写冲突从结构上消失
session 级 daemon 进程内存中每 session 一个 RunState（idle/running）
            → 同一 session 互斥（一次一个 run）
            → 不同 session 并行执行（相对现状的能力增量）
入口策略   排队（FIFO）—— 2026-06-12 修订，原"默认拒绝"方案废弃：
            · Phase 1：同进程同 session 的 prompt 进入进程本地 FIFO 队列，
              double-Esc 中断当前 run 后自动续跑下一条
            · Phase 4：daemon 持有全局 FIFO，跨终端/前端严格有序
            → claim 层仍抛 SessionRunBusyError（跨进程互斥不变），
              但该错误由队列消费重试，用户看到 "Queued" 状态而非报错
            → "合流"（向运行中 turn 追加消息）仍是远期产品特性
```

职责转移：daemon 模式下锁的载体从 DB 事务（Phase 1 的 1.2）转移到 daemon 内存 RunState——锁放在最便宜的地方；`run_ledger` 降级为**持久化审计 + 崩溃恢复**，不再承担锁职责。`claimPendingRun` 接口契约不变，实现替换。

过渡期（Phase 1-2 嵌入式多进程）不做跨进程排队：排队需要协调者，协调者就是 daemon 本身，提前实现是预支 Phase 3 复杂度（YAGNI）。

#### Phase 1-2 过渡：backend lease 全局写互斥

Phase 1 实现中除了 session 级 `claimPendingRun`，还引入了一个 persistent backend 级 lease：`app_state(global, persistentUiBackendLease)`。这不是 daemon 终态锁，而是嵌入式多进程时期的过渡保护：

- 每个 persistent backend 启动时生成 `ownerId = backend_<pid>_<uuid>`，lease 记录 `ownerId`、`pid`、`state`、`updatedAt`。
- `beforePromptSubmit` 先在 `BEGIN IMMEDIATE` 中刷新 lease，并把 state 写为 `preparing`。这段窗口保护的是“prompt 已经准备提交但 run claim 尚未可见”的瞬间，避免另一个进程把它误判为 idle 并接管。
- 如果已有 active run 且 lease owner 仍存活，新的 backend 不抢占，`SessionRunBusyError` 留给本地队列重试。
- 如果已有 active run 但 owner pid 已死亡，新的 backend 可以接管并先把 stale `pending/running` run 标为 interrupted，再继续 drain 自己的队列。
- `afterPromptSubmitSettled` 将同 owner 的 `preparing` lease 释放回 `idle`，避免准备态长期阻塞后续 prompt。

Phase 4 daemon 默认路径上线后，这层 lease 必须被显式评估：daemon 单写者路径不应再依赖 backend lease，也不应叠加出 daemon queue + backend lease 的双重阻塞；但 `--no-daemon` / `--in-process` 逃生路径如果保留，就仍需要某种跨进程保护。该取舍放入 Phase 4 验收任务，而不是让 lease 作为隐形遗留机制继续存在。

#### 审批路由（多前端必须回答的问题）

多个前端（终端 + web）同时连接 daemon 时，permission 请求发给谁：

- **默认策略**：路由给**发起该 run 的前端**，其他前端只读展示该 run 的流
- 发起方断线时：请求进入待决队列，任一前端重连/接管后展示（参考 kimi-code `ReverseRpcController` 审批队列）
- daemon RPC 层自动注入 sessionId/runId 上下文（参考 kimi-code `proxyWithExtraPayload`），前端不自行拼装

---

## 通信协议决策：ACP / A2A 暂缓

**结论：现在不引入 ACP/A2A，投资点是三条"缝"。**

| 投资项 | 是什么 | 为什么 |
|--------|--------|--------|
| `UiBackendClient` 契约 | 前端与核心之间的稳定接口 | remote client 与 in-process client 跑**同一套 contract 测试**，保证缝不腐烂 |
| daemon 单写者 | 所有写入收口到一个进程 | 任何新前端/协议都不再引入并发写问题 |
| 协议无关的事件流 | StreamBridge → 传输适配器 | WS 只是第一个适配器，换协议不动核心 |

按需后加的路线（依据 `03-reference-projects.md` 的证据）：

- **web/app**：Phase 3 的 HTTP/WS 即可覆盖，无需 ACP
- **ACP**（IDE 集成）：需求真实出现时，按 opencode / claude-code 先例做薄适配层（约 7 个文件，预估 3-5 天），叠加在 daemon API 之上，不动核心
- **A2A**（外部 agent 互操作）：仅当出现真实的跨 agent 协作需求时再评估；当前没有该需求（YAGNI）

---

## 变更影响范围总览

### 按 Phase 汇总

| Phase | 模块 | 新建 | 修改 | 删除 |
|-------|------|------|------|------|
| 1 | `adapters/ui-state/` | 0 | 3 | 0 |
| 1 | `adapters/ui-persistent.ts` | 0 | 1 | 0 |
| 1 | `adapters/ui-inprocess.ts` | 0 | 1 | 0 |
| 1 | `runtime/run-ledger/` | 1 | 1 | 0 |
| 1 | `cli/commands/terminal.ts` | 0 | 1 | 0 |
| 2 | `adapters/ui-inprocess/` | 5 | 0 | 0 |
| 2 | `adapters/ui-inprocess.ts` | 0 | 1 | 0 |
| 2 | `adapters/ui-inprocess.contract.test.ts` | 0 | 1（补充覆盖）| 0 |
| 3a | `runtime/daemon/` | 3 | 2 | 0 |
| 3a | `adapters/` | 3 | 0 | 0 |
| 3a | `cli/commands/serve.ts` | 0 | 1 | 0 |
| 3a | `cli/commands/terminal.ts` | 0 | 1 | 0 |
| 3b | `runtime/daemon/` | 1 | 3 | 0 |
| 3b | `cli/commands/terminal.ts` | 0 | 1 | 0 |

### 关键不变接口

以下外部接口在三个阶段中**保持不变**，确保 CLI（TUI）端无需大规模改动：

- `UiBackendClient` 接口（`ohbaby-sdk/src/client.ts`）
- `CoreAPI` 接口（`ohbaby-sdk/src/rpc/types.ts`）
- `SessionManager` 接口（`services/session/types.ts`）
- `UiEvent` 事件类型（`ohbaby-sdk/src/events.ts`）
