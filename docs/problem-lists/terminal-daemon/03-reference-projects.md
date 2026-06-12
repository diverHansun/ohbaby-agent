# 03 · 优秀项目分析与借鉴

> **文档职责**：分析 opencode、gemini-cli、kimi-code、claude-code 四个项目中与本问题域相关的架构设计，提炼可借鉴的设计决策。
> **配套文档**：问题定义见 `01-problem-analysis.md`，方案设计见 `02-solution-design.md`，测试标准见 `04-test-criteria.md`。

---

## 目录

1. [各项目会话与进程架构对比](#各项目会话与进程架构对比)
2. [opencode: Session 隔离与 ACP 集成](#opencode-session-隔离与-acp-集成)
3. [gemini-cli: Daemon 模式与会话管理](#gemini-cli-daemon-模式与会话管理)
4. [claude-code: 多形态会话与 ACP 实现](#claude-code-多形态会话与-acp-实现)
5. [kimi-code: 进程内 RPC 与 Session Store](#kimi-code-进程内-rpc-与-session-store)
6. [与本项目的对比矩阵](#与本项目的对比矩阵)

---

## 各项目会话与进程架构对比

| 维度 | ohbaby-agent (当前) | opencode | gemini-cli | claude-code | kimi-code |
|------|---------------------|----------|------------|-------------|-----------|
| **进程架构** | 每终端独立进程 | 单进程（Effect runtime） | 父进程 daemon + 子进程 TUI | 多形态（daemon/bridge/CLI） | 每终端独立进程 |
| **启动默认行为** | 进入 DB 中的上次 session | 进入 Home 页，用户选择 | 新 session（需 `--resume` 恢复） | 新 session（需 `--resume`） | 新 session（需 `--session`） |
| **多 session 并发** | 不支持（多终端同 session） | 支持（每个 session 独立 run） | ACP 模式支持 Map 管理 | 支持（多 QueryEngine） | 不支持 |
| **session 持久化** | SQLite（better-sqlite3） | SQLite（Drizzle + Bun） | JSONL 文件 | JSONL 文件 | state.json + wire.jsonl |
| **通信协议** | 无远程协议 | ACP v1 + MCP | ACP + A2A | ACP v1 + Bridge | 内部对称 RPC |
| **并发控制** | 无（promptInFlight 仅本地） | SessionRunState + BusyError | ExecutingTasks Set | SessionRunState | 内部队列 |

---

## opencode: Session 隔离与 ACP 集成

### 项目概况

- **语言/运行时**：TypeScript，Bun 运行时
- **架构范式**：Effect 框架（函数式 DI），约 40 个 Service Layer 组合为运行时
- **TUI 框架**：SolidJS + `@opentui/solid`

### 会话隔离机制（最值得借鉴的设计）

**1. `InstanceState` 模式（`src/effect/instance-state.ts`）**

每个项目目录拥有独立的 `Instance`，Instance 内包含：
- 独立的 Session Service
- 独立的 Bus（PubSub）
- 独立的 Agent Service

这确保了不同项目的 session 在运行时层面完全隔离，不依赖命名空间或数据库过滤。

**2. `SessionRunState` 忙闲标志（`src/session/run-state.ts`）**

```typescript
// 概念等价代码
interface SessionRunState {
  status: "idle" | "running";
  runId?: string;
}

// prompt 入口
if (sessionRunState.status === "running") {
  throw new BusyError("Session is busy");
}
```

这是 P2/P7 的最佳实践：session 级别的忙闲判断在 prompt 入口强制执行。

**3. ACP 集成方式（`src/acp/agent.ts`）**

ACP Agent 实现作为**独立的适配层**叠加在核心 Session Service 之上：
- `prompt()` → 调用 SDK 的 `session.prompt()` → 核心 prompt pipeline
- 事件通过 `GlobalBus` → SSE → ACP client通知
- 不修改核心 session 逻辑

启示：AC协议可以作为薄适配层后加，不污染核心架构。

### 会话管理关键文件

| 文件 | 角色 |
|------|------|
| `src/session/session.ts` | Session Service（create/fork/get/list/remove） |
| `src/session/run-state.ts` | 每 session 的运行状态跟踪 |
| `src/session/prompt.ts` | Prompt 执行管道 |
| `src/session/session.sql.ts` | Drizzle ORM 表定义 |
| `src/acp/agent.ts` | ACP Agent 实现 |
| `src/server/routes/instance/session.ts` | HTTP session 路由 |

---

## gemini-cli: Daemon 模式与会话管理

### 项目概况

- **语言/运行时**：TypeScript，Node.js 24+
- **架构范式**：父进程 daemon + 子进程 TUI（两进程架构）
- **TUI 框架**：React + Ink
- **会话存储**：JSONL 文件

### 两进程架构（本项目 Phase 3 的直接参考）

**架构图**：
```
Parent Process (daemon)               Child Process (TUI)
  ┌──────────────────┐               ┌──────────────────┐
  │ Auto-tune V8 heap│               │ React/Ink UI      │
  │ IPC admin settings│◄──── IPC ───►│ GeminiClient      │
  │ Respawn on exit  │               │ Scheduler         │
  │   code 199       │               │ Config            │
  └──────────────────┘               └──────────────────┘
```

关键设计：
- 父进程不 import 任何重型模块，只负责内存调优和子进程重启
- 子进程 import 全量 CLI 逻辑
- 子进程退出码 199 = 父进程应重启子进程（用于自动更新）
- 子进程通过 IPC 向父进程发送 admin settings，父进程传递给下一轮子进程

启示：本项目 daemon 模式可采用类似的两层结构 —— **Supervisor（轻量父进程）+ DaemonRuntime（重量子进程）**。但 gemini-cli 的父进程不管理 session，本项目 daemon 应反之。

### ACP 多会话管理（`packages/cli/src/acp/acpClient.ts`）

```typescript
class GeminiAgent {
  private sessions: Map<string, Session> = new Map();
  // 每个 session 有独立的 Config、GeminiClient
}
```

关键点：**Session 对象包含其自己的 Config/GeminiClient 实例**，天然隔离。

启示：本项目 daemon 的 `bootstrapRuntime()` 需要为每个 session 创建独立的运行时上下文。

### A2A Server 多任务（`packages/a2a-server/`）

```typescript
class CoderAgentExecutor {
  private tasks: Map<string, TaskWrapper> = new Map();
  private executingTasks = new Set<string>();
}
```

启示：A2A 模式下任务执行互斥由 `executingTasks` Set 控制 —— 比本项目 `promptInFlight` 更健壮。

---

## claude-code: 多形态会话与 ACP 实现

### 项目概况

- **语言/运行时**：TypeScript，Bun 运行时
- **架构范式**：多形态（CLI / Daemon / Bridge / ACP）
- **TUI 框架**：React 19 + @anthropic/ink（自 fork）
- **会话存储**：JSONL 文件

### 多形态会话体系

| 形态 | 入口 | 用途 |
|------|------|------|
| **CLI TUI** | `claude`（默认） | 交互式终端 |
| **Daemon** | `claude daemon start` | 后台服务，管理 background sessions |
| **ACP** | `claude --acp` | IDE 集成（Zed/VS Code） |
| **Bridge** | `claude bridge` | 远程控制模式 |

这四种形态共享同一个 `QueryEngine` 核心，区别只在于输入/输出通道。

启示：本项目 Phase 3 的 daemon 上线后，CLI embedded 模式和 daemon remote 模式应共享同一个 `CoreAPI` / `UiBackendClient` 接口。

### ACP 实现（`src/services/acp/agent.ts`，7 个文件）

结构：
```
acp/
  entry.ts        # 入口：创建 NDJSON stream，启动 stdin/stdout JSON-RPC
  agent.ts        # AcpAgent 类实现完整 Agent 接口
  bridge.ts       # 内部消息 ↔ ACP SessionUpdate 转换
  permissions.ts  # ACP permission ↔ 内部 permission pipeline
  promptConversion.ts  # ACP prompt 格式转换
  utils.ts        # UUID 验证、路径格式化
```

启示：ACP 实现约 7 个文件即完成。对 ohbaby-agent 而言，在 daemon HTTP API 就位后，ACP 可以作为一个**额外的协议适配层**（约 3-5 天工作量）叠加，不影响核心。

### ACP Link（`packages/acp-link/`）

一个**独立的 WebSocket ↔ ACP 桥接服务器**：

```
WebSocket Clients ──► acp-link (Hono + WS) ──► claude --acp (子进程)
```

启示：web/app 前端可以通过一个类似的桥接层接入 daemon，无需等待完整 ACP 实现。Phase 3 的 `stream-bridge-ws-adapter.ts` 就是这个角色的最小版本。

---

## kimi-code: 进程内 RPC 与 Session Store

### 项目概况

- **语言/运行时**：TypeScript，Node.js 24+
- **架构范式**：进程内对称 RPC
- **TUI 框架**：pi-tui（自研终端 UI 框架）
- **会话存储**：`state.json` + `wire.jsonl`

### Session Store 设计（最值得借鉴的持久化设计）

**Session Index 文件**（`packages/agent-core/src/session/store/session-index.ts`）：

```typescript
// session_index.jsonl —— 全局 append-only 索引
{ "sessionId": "abc123", "path": "sessions/workdir-hash/abc123", "workDir": "/home/user/project" }
{ "sessionId": "def456", "path": "sessions/workdir-hash/def456", "workDir": "/home/user/project" }
```

- **Append-only**：无需锁，无需事务，崩溃后最后一行可能有残缺（被 skip）
- 全局索引 → 通过读取 JSONL 文件即可列出所有 sessions，**无需扫描目录**
- 效率高于 opencode 和 claude-code 的逐目录扫描方式

**每个 session 的存储结构**：
```
sessions/<workdir-hash>/<session-id>/
  state.json        # { title, createdAt, updatedAt, lastPrompt, agents: Map }
  agents/
    main/
      wire.jsonl    # 主 agent 的 turn 记录
    agent-0/
      wire.jsonl    # 子 agent 的 turn 记录
```

启示：本项目 SQLite 方案在结构化查询方面优于 JSONL，但 kimi-code 的 append-only index 思路可以应用于**需要快速列出 sessions 而不锁表的场景**。SQLite 本身已经通过 B-tree 索引提供了类似能力，不需要引入 JSONL。

### 对称 RPC 模式

```
CoreAPI (agent-core) ◄──RPC──► SDKAPI (node-sdk)
  createSession()               emitEvent()
  resumeSession()               requestApproval()
  prompt()                      requestQuestion()
  cancel()
```

与 ohbaby-agent 当前 RPC 的对比：
- ohbaby-agent 已有类似结构（`CoreAPI` / `SDKAPI`）
- kimi-code 额外引入了 `proxyWithExtraPayload()` 自动注入 `agentId`/`sessionId` —— 本项目可借鉴
- kimi-code 的 `ReverseRpcController` 实现了**审批队列**：并发请求排队、逐个展示 —— 本项目 daemon 模式下可能需要类似机制

---

## 与本项目的对比矩阵

### 可以直接复用 / 参照的设计

| 来源 | 设计 | 用于本项目何处 | Phase |
|------|------|---------------|-------|
| opencode | `SessionRunState` 忙闲检查 | P7 解决方案：同一契约两种载体——Phase 1 多进程下落在 DB 事务（原子占位），Phase 3 daemon 单进程后退回内存实现 | Phase 1 / 3 |
| gemini-cli | `--resume latest` 启动恢复 | `--continue` 标志（恢复最近 primary session） | Phase 1 |
| Gradle/Bazel/opencode | CLI 按需自动拉起后台服务 | Phase 3b auto-spawn（state-file 发现 + 版本握手 + 空闲自退） | Phase 3b |
| gemini-cli | `Map<string, Session>` 每个 session 独立上下文 | Daemon 的 session-scoped runtime | Phase 3 |
| gemini-cli | ACP 模式的多 session 并发 | Daemon 暴露 ACP/HTTP 时的 session 路由 | Phase 3 |
| claude-code | `claude --acp` 子进程模式 | `claude-code` 的 ACP Agent 作为适配层参考 | Phase 3 |
| claude-code | ACP Link WebSocket 桥 | `stream-bridge-ws-adapter.ts` 的实现参考 | Phase 3 |
| kimi-code | `proxyWithExtraPayload` 自动注入 sessionId | Daemon RPC 中自动注入上下文 | Phase 3 |
| kimi-code | `ReverseRpcController` 审批队列 | Daemon 中多前端审批请求的排队 | Phase 3 |

### 不适合本项目照搬的设计

| 来源 | 设计 | 原因 |
|------|------|------|
| opencode | Effect 框架全量依赖注入 | 引入 Effect 框架对当前项目是过重的范式迁移，收益不足以弥补成本 |
| gemini-cli | 父进程仅做内存调优不管理 session | 本项目 daemon 需要管理 session，不仅是进程守护 |
| claude-code | JSONL 文件 + head/tail 读取 | 本项目已有完整的 SQLite 持久化层，换 JSONL 没有收益 |
| claude-code | 19 个 feature flags 编译时裁剪 | 当前项目规模不需要编译时裁剪 |
| kimi-code | session_index.jsonl append-only | 本项目 SQLite 已提供索引和查询能力，不需要额外索引文件 |
