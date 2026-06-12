# 01 · 问题分析与代码现状

> **文档职责**：逐一罗列当前终端多窗口场景下的问题，精确到代码位置、触发条件和影响范围。不涉及解决方案。
> **配套文档**：方案设计见 `02-solution-design.md`，参考项目分析见 `03-reference-projects.md`，测试标准见 `04-test-criteria.md`。

---

## 目录

1. [P1: activeSessionId 作为 DB 全局状态导致多终端同会话](#p1-activeSessionId-作为-db-全局状态导致多终端同会话)
2. [P2: promptInFlight 跨进程不可见导致并发写入同一 session](#p2-promptinflight-跨进程不可见导致并发写入同一-session)
3. [P3: 终端启动行为隐式且不可预测](#p3-终端启动行为隐式且不可预测)
4. [P4: 空 session 管理分散在多处逻辑不一致](#p4-空-session-管理分散在多处逻辑不一致)
5. [P5: ui-inprocess.ts 单文件承载过多职责](#p5-ui-inprocessts-单文件承载过多职责)
6. [P6: Daemon 模块已实现但未接入生产路径](#p6-daemon-模块已实现但未接入生产路径)
7. [P7: 缺少跨进程 session 忙标志](#p7-缺少跨进程-session-忙标志)
8. [P8: serve 命令为 stub，无远程前端通信基础设施](#p8-serve-命令为-stub无远程前端通信基础设施)
9. [P9: 运行状态跨进程串扰（snapshotStatus 全局扫描）](#p9-运行状态跨进程串扰snapshotstatus-全局扫描)
10. [P10: run 创建失败时残留 ghost user message](#p10-run-创建失败时残留-ghost-user-message)
11. [P11: 顺序 run ID 跨进程碰撞](#p11-顺序-run-id-跨进程碰撞)

---

## P1: activeSessionId 作为 DB 全局状态导致多终端同会话

### 严重性：🔴 架构级 | 可优化性：🎯 战略投资

### 代码位置

| 文件 | 行号 | 角色 |
|------|------|------|
| `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | 39, 367-381 | 读写 `app_state` 表中的 `activeSessionId` |
| `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | 424-458 | `readSessions()` 从 DB 读取 `activeSessionId` 并用它决定 snapshot 内容 |
| `packages/ohbaby-agent/src/adapters/ui-persistent.ts` | 468-472 | `applyResumeSessionOption()` 仅在 `--resume` 时写入，但**没有 `--resume` 时不清除旧值** |
| `packages/ohbaby-agent/src/services/database/schema.ts` | - | `app_state` 表结构，scope 为全局单一 |

### 问题描述

`activeSessionId` 存储于 SQLite `app_state` 表的单一行（scope=`"global"`, key=`"activeSessionId"`）。所有终端进程共享同一个 SQLite 文件，因此**共享同一个 `activeSessionId`**。

当终端 A 使用 session-1 后，`app_state` 记录 `activeSessionId = "session-1"`。终端 B 启动时，`readSessions()` 读取到同一个 `"session-1"`，于是终端 B 也进入 session-1。

### SWE 分类

属于 **公共耦合（Common Coupling，Constantine & Yourdon 分类中第二坏的耦合）**：多个进程通过同一份全局可变状态隐式耦合。

### 用户可见影响

1. 用户开两个终端，预期各自独立工作，实际同时进入同一个历史会话
2. 用户关闭终端 A，终端 B 的行为被终端 A 的"遗物"影响
3. 用户无法在终端 C 中"干净启动"一个新会话视窗（除非手动 `/new`）

---

## P2: promptInFlight 跨进程不可见导致并发写入同一 session

### 严重性：🔴 架构级 | 可优化性：🎯 战略投资

### 代码位置

| 文件 | 行号 | 角色 |
|------|------|------|
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 357 | `let promptInFlight = false` — 闭包变量，进程内存 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 1251-1255 | 检查 `promptInFlight`，设置 `true` |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 1418 | `promptInFlight = false` — finally 中释放 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 1257-1421 | `submitPromptInternal()` 完整函数 |

### 问题描述

`promptInFlight` 是 `createInProcessUiBackendClient` 工厂函数内的闭包变量（`let promptInFlight = false`）。它**仅在同一进程内**可见。

两个终端是两个独立的 Node.js 进程，各自拥有各自的 `promptInFlight` 变量。如果两个终端都进入了同一个 session（因 P1），且用户分别在两个终端中输入 prompt：

1. 终端 A 检查 `promptInFlight` → `false` → 设置 `true` → 开始提交
2. 终端 B 检查 `promptInFlight` → `false`（它自己的实例）→ 设置 `true` → 也开始提交
3. 两个进程同时调用 `runtime.startSession()` 到**同一个 sessionId**
4. 两个进程同时写入 `message` 和 `part` 表，消息交错
5. 两个 `run_ledger` 条目同时标记为 `running`
6. LLM 收到两个独立的 API 调用，两个响应流都试图写入同一个 session

### 实际后果

- **SQLite 层面**：WAL 模式下写入会被串行化，不会数据损坏，但**消息顺序无法保证**
- **业务层面**：session 的消息历史出现非确定性交错，`run_ledger` 状态混乱
- **用户体验**：两个终端看到的流式输出可能交叉、丢失、或重复

---

## P3: 终端启动行为隐式且不可预测

### 严重性：🟡 设计级 | 可优化性：🍒 低垂果实

### 代码位置

| 文件 | 行号 | 角色 |
|------|------|------|
| `packages/ohbaby-cli/src/cli/commands/terminal.ts` | 12-20 | `normalizeResumeSessionId()` — 仅处理 `--resume` |
| `packages/ohbaby-agent/src/adapters/ui-persistent.ts` | 400-412 | `applyResumeSessionOption()` — 仅 `--resume` 时执行 |
| `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | 428 | 总是从 DB 读 `activeSessionId` |

### 问题描述

终端启动时的行为取决于**不可见的外部状态**（DB 中上一次的 `activeSessionId`）：

- 如果 DB 中有有效 `activeSessionId` → 进入该 session（可能不是用户想要的）
- 如果 DB 中 `activeSessionId` 无效/null → 进入空状态（无活跃 session）
- 用户无法通过查看终端判断"我现在在哪个 session"
- `--resume` 是唯一显式选择 session 的方式，但没有 `--new` 或类似选项强制新视窗

### 与参考项目的对比

| 项目 | 启动行为 |
|------|---------|
| opencode | TUI 启动后显示 Home 页或最近 session 列表，用户主动选择 |
| gemini-cli | 新终端默认新 session；`--resume latest` 或 `--resume <id>` 恢复旧 session |
| claude-code | 新终端默认新会话；`--resume` 或 `--continue` 恢复；启动后显示 session picker |

---

## P4: 空 session 管理分散在多处逻辑不一致

### 严重性：🟡 设计级 | 可优化性：🍒 低垂果实

### 代码位置

| 文件 | 行号 | 问题 |
|------|------|------|
| `services/session/manager.ts` | 149-163 | `findReusableEmptyPrimary()` — Core 层空 session 查找 |
| `adapters/ui-inprocess.ts` | 818-859 | `isReusableUiSession()` + `canReuseUiSessionForNewCommand()` + `findReusableUiSession()` — UI 层空 session 查找 |
| `adapters/ui-inprocess.ts` | 899-979 | `createSessionFromCommand()` — 先检查 activeSession 是否可复用，再查 reusableCoreSession，再查 reusableUiSession |

### 问题描述

"在创建新 session 前先找一个可复用的空 session" 这一逻辑出现在三个不同层级：

1. **Core 层**：`SessionManager.findReusableEmptyPrimary()` — 查 core session store
2. **UI 层**：`findReusableUiSession()` — 查 UI snapshot 中的 session
3. **命令层**：`createSessionFromCommand()` 中内联的三层 fallback 逻辑

三处的判断条件不完全一致（Core 层检查 `messageCount === 0`，UI 层检查 `messages.length === 0`，命令层额外检查 `isSubagent === false`），容易因修改不同步产生 bug。

---

## P5: ui-inprocess.ts 单文件承载过多职责

### 严重性：🟡 设计级 | 可优化性：🎯 战略投资

### 代码位置

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` — **1696 行**

### 问题描述

该文件作为 `InProcessUiBackendClient` 的工厂函数，包含以下职责混合在一起：

| 职责 | 大致行范围 | 预估行数 |
|------|-----------|---------|
| Session 生命周期（创建/查找/复用/激活） | 800-980 | ~180 |
| Prompt 提交管道 | 1247-1421 | ~175 |
| 命令执行 | 1450-1650 | ~200 |
| Snapshot 管理 | 670-800 | ~130 |
| 权限管理 | 600-670 | ~70 |
| Model 连接 | 1423-1450 | ~30 |
| Stream 投影集成 | 1329-1421（内联） | ~90 |
| Context window 追踪 | 1190-1245 | ~55 |
| Session title 生成 | 1020-1190 | ~170 |

单一文件打破 **单一责任原则（SRP）**，修改任一部分（如 session 复用逻辑）都需要阅读全部 1696 行上下文。

---

## P6: Daemon 模块已实现但未接入生产路径

### 严重性：🔴 架构级 | 可优化性：🎯 战略投资

### 代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `runtime/daemon/supervisor.ts` | 1-275 | Supervisor 进程生命周期管理器（完整实现，6 单元测试） |
| `runtime/daemon/bootstrap.ts` | 1-182 | `bootstrapRuntime()` 组合根（完整实现，7 集成测试） |
| `runtime/daemon/pid-file.ts` | 1-146 | 跨平台 PID 文件锁（完整实现） |
| `runtime/daemon/state-file.ts` | 1-52 | JSON 状态文件管理（完整实现） |
| `runtime/daemon/app-events.ts` | 1-23 | 事件投影适配器（完整实现） |
| `runtime/daemon/errors.ts` | 1-19 | 错误类型定义 |
| `runtime/daemon/types.ts` | 1-106 | 类型定义 |
| `packages/ohbaby-agent/src/runtime/index.ts` | 4 | `export * from "./daemon/index.js"` — 仅 Supervisor 被公开导出 |
| `packages/ohbaby-cli/src/cli/commands/serve.ts` | 11-13 | `// TODO: wire to an ohbaby-agent headless server host` |

### 问题描述

Daemon 模块拥有完备的：
- 进程生命周期管理（Supervisor + PID 锁）
- 崩溃恢复（`runManager.init()` → `markInterrupted`）
- 优雅关闭（`runManager.cancelAll` → `interactionBroker.abortAll` → `streamBridge.close` → `db.close`）
- 事件投影基础设施（Bus → StreamBridge）

**但没有任何生产入口调用它们**。`Supervisor` 和 `bootstrapRuntime` 仅存在测试调用中。在 `ui-persistent.ts:414` 中，`createPersistentUiBackendClient` 直接创建 Bus/RunManager/SessionManager，完全绕过了 daemon 的组合根，造成了重复的组装逻辑。

`goals-duty.md` 规划的 `scheduler`、`heartbeat`、`TaskManager` 等模块也未实现。

---

## P7: 缺少跨进程 session 忙标志

### 严重性：🔴 架构级 | 可优化性：🍒 低垂果实

### 问题描述

当前 `run_ledger` 表记录了每个 run 的状态（`pending` / `running` / `succeeded` / `failed` / `cancelled` / `interrupted`，见 `runtime/run-ledger/types.ts:2-7`），但没有利用它在 `submitPromptInternal` 入口处检查目标 session 是否已有活跃 run。

P2 描述了跨进程并发写入的问题。最快的缓解手段不是完全防止并发，而是在 session 级别做一个忙/闲判断：

```
如果 session X 的 run_ledger 中有 status IN ('pending', 'running') 的行
  → 拒绝新的 prompt 提交，返回 "Session is busy"
```

当前已有的基础设施：
- `run_ledger` 表已存在（`schema.ts`），有 `session_id` 和 `status` 列
- `countActiveRuns(db)` 已在 `ui-persistent.ts:165-174` 实现，但**仅用于启动恢复**，未用于 prompt 入口保护
- `shouldRecoverStartupRuns` 只检查全局是否有活跃 run，不按 session 区分

---

## P8: serve 命令为 stub，无远程前端通信基础设施

### 严重性：🟡 设计级 | 可优化性：🎯 战略投资

### 代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `packages/ohbaby-cli/src/cli/commands/serve.ts` | 11-13 | `// TODO: wire to an ohbaby-agent headless server host` |
| `packages/ohbaby-cli/src/bin.ts` | - | `serve` 命令已注册但无实际逻辑 |

### 问题描述

项目 d.ts 和命令注册中已有 `serve` 子命令，但实现完全为空。Daemon 模块的 `app-events.ts` 已做好了将 Bus 事件投影到 `StreamBridge` 的 `"app"` scope 的基础设施，但缺少任何将 StreamBridge 暴露为远程可访问协议的传输层（HTTP/WebSocket/TCP）。

这是未来 web/app 前端的基础设施缺失。

---

## P9: 运行状态跨进程串扰（snapshotStatus 全局扫描）

### 严重性：🟡 设计级 | 可优化性：🍒 低垂果实

### 代码位置

| 文件 | 行号 | 角色 |
|------|------|------|
| `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | 413-422 | `readRuns()` 读取快照中**所有** recent sessions 的全部 runs |
| `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | 460-468 | `snapshotStatus()` 在全部 runs 中找任意 active run 决定 `running`/`idle` |

### 问题描述

`snapshotStatus()` 的判定范围是"快照中所有 session 的所有 run"，而非当前 active session 的 run。run 状态来自所有进程共享的 `run_ledger` 表，因此：

终端 B 即使处于空白新视窗（`activeSessionId = null`），只要终端 A 正在 session-1 中执行 run，B 的 `readSnapshot()` 也会扫到该 run 并显示 "running"。

**注意：即使 P1 修复（activeSessionId 进程内存化）后，此串扰依然存在**——它的根源是 status 判定范围错误，与 activeSessionId 的存储位置无关。

### 用户可见影响

- 新开终端的状态条显示"运行中"，但本终端没有任何任务在跑
- 状态指示不可信：用户无法区分"我的任务在跑"和"别的终端的任务在跑"

### 修复方向

`snapshotStatus()` 只在 `activeSessionId` 对应 session 的 runs 中查找 active run；`activeSessionId === null` 时直接返回 `idle`（除非 `mutable.status` 有进程内状态）。

---

## P10: run 创建失败时残留 ghost user message

### 严重性：🟡 设计级 | 可优化性：🍒 低垂果实

> 来源：05-implementation-plan 撰写时发现（2026-06-12 代码核实）。

### 代码位置

| 文件 | 行号 | 角色 |
|------|------|------|
| `packages/ohbaby-agent/src/core/agents/runner.ts` | 146 | `writeInitialUserMessage()` 在 run 创建**之前**执行 |
| `packages/ohbaby-agent/src/core/agents/runner.ts` | 151-168 | `runCoordinator.create()` 失败的 catch 只关闭事件订阅，**不清理已写入的 user message** |

### 问题描述

初始 user message 先于 run 记录写入。一旦 `create()` 被拒绝（引入 P7 的原子占位后，`SessionRunBusyError` 会让这条路径高频触发），DB 中残留一条没有对应 run 的孤儿 user message，session 历史出现"用户说了话但系统没有回应"的幽灵记录。

### 修复方向

run 创建在 runtime 执行开始前失败时，通过 message manager/store 既有路径删除该 user message；若 message API 缺少 delete-by-id，添加最小范围的删除方法并补测试。

---

## P11: 顺序 run ID 跨进程碰撞

### 严重性：🟡 设计级 | 可优化性：🍒 低垂果实

> 来源：05-implementation-plan 撰写时发现（2026-06-12 代码核实）。

### 代码位置

| 文件 | 行号 | 角色 |
|------|------|------|
| `adapters/ui-runtime/composition.ts` | 250-253 | 默认 ID 生成器本是防碰撞的 `run_${timestamp}_${random}` |
| `adapters/ui-inprocess.ts` | 625 | 将其覆盖为进程内顺序 ID `runIds.next()` |
| `adapters/ui-inprocess.ts` | 388-395 | `nextRunId()` 的 `hasRun` 查重是 check-then-act，跨进程仍可撞 |

### 问题描述

生产持久化路径使用进程本地顺序 run ID。两个进程从同一 DB snapshot 启动后会计算出相同的"下一个 ID"；`hasRun()` 查重与实际插入之间存在竞态窗口，跨进程可产生同名 run ID，导致 run_ledger 主键冲突或数据互写。

### 修复方向

生产路径恢复使用 composition 层防碰撞默认值（或 `crypto.randomUUID()`）；保留测试用的 `createRunId` 确定性注入。

---

## 问题依赖关系图

```
P3 (隐式启动行为) ──导致──► P1 (activeSessionId 共享)
                                │
                        导致     │
                                ▼
                            P2 (跨进程并发冲突)
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
                 P4 (空session P7 (无忙标志) P5 (单文件)
                  逻辑分散)
                    │
                    ▼
            ┌───────────────────┐
            │   P6 (Daemon未接入)  │
            │   P8 (serve为stub)   │
            └───────────────────┘
```

**修正路径**：P3 + P1 + P9 → P2 + P7 → P6 + P8（P4/P5 穿插处理）→ 最终目标：daemon 架构上线。

> P9 与 P1 同源（共享 DB 状态被错误地当作进程私有状态使用），但修复彼此独立：P1 修 activeSessionId 的存储位置，P9 修 status 的判定范围。两者都属 Phase 1。
