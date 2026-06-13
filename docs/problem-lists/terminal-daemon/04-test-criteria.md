# 04 · 测试与验收标准

> **文档职责**：为 `02-solution-design.md` 的三个 Phase 定义分阶段测试策略和验收标准。所有测试遵循 SWE 原则：测试应验证行为和契约，不为通过而测试，不为覆盖而覆盖。
> **配套文档**：问题定义见 `01-problem-analysis.md`，方案见 `02-solution-design.md`，参考项目见 `03-reference-projects.md`。

---

## 目录

1. [测试分类与层级](#测试分类与层级)
2. [Phase 1 测试标准](#phase-1-测试标准)
   - [1.1 activeSessionId 进程内存化](#11-activesessionid-进程内存化)
   - [1.2 跨进程 session 忙标志：原子占位](#12-跨进程-session-忙标志原子占位)
   - [1.3 --continue 标志](#13---continue-标志)
   - [1.4 运行状态按 active session 过滤（P9）](#14-运行状态按-active-session-过滤p9)
3. [Phase 2 测试标准](#phase-2-测试标准)
   - [2.1 ui-inprocess.ts 拆分](#21-ui-inprocessts-拆分)
   - [2.2 空 session 查找统一](#22-空-session-查找统一)
4. [Phase 3 测试标准](#phase-3-测试标准)
   - [3.1 Daemon 启动与关闭](#31-daemon-启动与关闭)
   - [3.2 CLI remote 连接](#32-cli-remote-连接)
   - [3.3 HTTP/SSE 事件传输](#33-httpsse-事件传输)
   - [Phase 4 预览：Auto-spawn 与生命周期](#phase-4-预览auto-spawn-与生命周期)
5. [端到端验收场景](#端到端验收场景)
6. [回归安全网](#回归安全网)

---

## 测试分类与层级

| 层级 | 定位 | 工具 | 覆盖范围 |
|------|------|------|---------|
| **单元测试** | 验证单个函数/模块的行为契约 | vitest | 新增模块的内部逻辑 |
| **集成测试** | 验证模块间组装是否正确 | vitest | Daemon bootstrap、远程 client 连接 |
| **Contract 测试** | 验证接口实现是否符合契约 | vitest | `UiBackendClient` 合约 |
| **端到端测试** | 验证完整用户场景 | vitest e2e / 手动 | 多终端、daemon+CLI 联动 |

### SWE 测试原则

- **行为优先于覆盖**：不为了覆盖率写无意义的测试。每个测试必须有明确的失败条件。
- **一个测试一个断言意图**：不是一行代码一个 `expect`，而是验证一个逻辑结论。
- **测试边界而非实现**：契约测试验证接口输入输出，不绑定内部实现细节。
- **失败必须可诊断**：测试失败时，错误消息必须直接指出哪个契约被违背。

---

## Phase 1 测试标准

### 1.1 activeSessionId 进程内存化

#### 单元测试

| 测试 | 验证点 | 位置 |
|------|-------|------|
| 启动时 activeSessionId 为 null | `createPersistentUiStateStore` 返回的 snapshot 中 `activeSessionId` 应为 `null` | `persistent-store.integration.test.ts` |
| setActiveSessionId 仅影响进程内存 | 调用 `setActiveSessionId("s1")` 后 readSnapshot 返回 `s1`；但新创建的 store 实例 readSnapshot 返回 `null` | `persistent-store.integration.test.ts` |
| 重启后不恢复上次的 activeSessionId | 在同一 DB 上两次 `createPersistentUiStateStore`，第二次不应继承第一次的 `activeSessionId` | `persistent-store.integration.test.ts` |
| `--resume` 仍正确设置 activeSessionId | `applyResumeSessionOption({resumeSessionId: "s1"})` 后 snapshot 的 activeSessionId 为 `"s1"` | `ui-persistent.integration.test.ts` |
| 删除 app_state 中的旧 key 不影响功能 | DB 中残留旧 `activeSessionId` 行时，新进程不应读取它 | `persistent-store.integration.test.ts` |

#### 回归保护

- `ui-inprocess.contract.test.ts` 中所有涉及 `activeSessionId` 的测试断言需要重审，部分需要更新
- `ui-persistent.integration.test.ts` 中验证"重启进入同一 session"的测试应**删除或改为验证"不进入同一 session"**

#### 验收标准

- [ ] 启动新终端，snapshot 的 `activeSessionId` 为 `null`
- [ ] 终端 A 在 session-1 中工作，终端 B 启动后 activeSessionId 为 `null`（不进入 session-1）
- [ ] `--resume <id>` 仍能将 activeSessionId 设置为指定 session
- [ ] 旧 DB 中的 `activeSessionId` 残留行被忽略，不产生错误

---

### 1.2 跨进程 session 忙标志：原子占位

#### 单元测试

| 测试 | 验证点 | 位置 |
|------|-------|------|
| 空闲 session 占位成功 | session X 的 run_ledger 无 running/pending 行，`claimPendingRun` 成功插入 pending 行 | `run-ledger` 单元测试 |
| 忙碌 session 占位失败 | session X 的 run_ledger 有 running/pending 行，`claimPendingRun` 抛出 `SessionRunBusyError` 且**不留下新行** | `run-ledger` 单元测试 |
| 错误消息包含 sessionId | `SessionRunBusyError.message` 应包含错误的 session ID | `run-ledger` 单元测试 |
| 终态 run 不阻塞 | session X 仅有 succeeded/failed/cancelled/interrupted run 时，占位成功 | `run-ledger` 单元测试 |
| 忙碌 session 的 prompt 排队 | `submitPrompt` 到忙碌 session 时进入本地 FIFO 队列，run 结束后自动提交（claim 层的 `SessionRunBusyError` 被队列消费，不上抛给用户） | `ui-inprocess.contract.test.ts` |

#### 集成测试（原子性验证）

| 测试 | 验证点 |
|------|-------|
| 并发占位串行化 | 同一 DB 上两个并发 `claimPendingRun(sessionX)`，恰好一个成功、一个抛 `SessionRunBusyError`，run_ledger 中恰好新增一行 |
| 崩溃残留可恢复 | 手工插入 running 残留行 → `markInterrupted` 启动恢复后 → `claimPendingRun` 成功 |

#### 验收标准

- [ ] 终端 B 对 session-1 发 prompt 而 session-1 有活跃 run 时，B 的 prompt 进入本终端队列并显示 Queued 状态（队列语义，2026-06-12 定稿；非 TUI 的直接 API 调用方仍可见 `SessionRunBusyError`）
- [ ] run 进入终态（succeeded/failed/cancelled/interrupted）后，队首 prompt 自动提交
- [ ] 占位与 run 记录创建在同一 `BEGIN IMMEDIATE` 事务内，无 check-then-act 窗口

#### 已知限制（不在本 Phase 解决）

- 进程崩溃留下的僵尸 running 行依赖启动恢复（`markInterrupted`）清理；崩溃后、恢复前该 session 表现为"忙"
- 跨终端严格 FIFO / 合流需 Phase 4 daemon 全局队列（单写者 + 内存 RunState）

---

### 1.3 --continue 标志

> 修订记录：原为 `--new` 标志测试。1.1 落地后默认即新视窗，`--new` 废弃，改为 `--continue`。

#### 验收标准

- [ ] `pnpm start --continue` 启动终端，`activeSessionId` 为最近一次 primary session（按 updatedAt）
- [ ] `--continue` 与 `--resume` 同时使用时报 mutual exclusive usage 错误
- [ ] DB 中无可恢复 session 时，`--continue` 回退到空白新视窗并输出一行提示，不报错
- [ ] `--continue` 不会选中 subagent session
- [ ] help 文本说明 `--continue` 含义

#### 单元测试

| 测试 | 验证点 |
|------|-------|
| `--continue` 选取逻辑 | 多个 primary session 中选 updatedAt 最新者；过滤 isSubagent |
| 互斥校验 | `--continue` + `--resume` → failUsage |
| 空库回退 | 无 session 时 activeSessionId 保持 null |

---

### 1.4 运行状态按 active session 过滤（P9）

#### 单元测试

| 测试 | 验证点 | 位置 |
|------|-------|------|
| 空视窗状态为 idle | activeSessionId = null 且其他 session 有 running run 时，snapshot.status 为 `idle` | `persistent-store.integration.test.ts` |
| 非 active session 的 run 不影响状态 | activeSessionId = session-2，session-1 有 running run，status 为 `idle` | `persistent-store.integration.test.ts` |
| active session 的 run 正确反映 | activeSessionId = session-1 且 session-1 有 running run，status 为 `running` 且 runId 正确 | `persistent-store.integration.test.ts` |

#### 验收标准

- [ ] 终端 A 在 session-1 执行 run 期间，新开终端 B（空白视窗）状态条显示 idle
- [ ] 终端 B `--resume session-1` 后，状态条正确显示 session-1 的 running 状态

---

## Phase 2 测试标准

### 2.1 ui-inprocess.ts 拆分

#### 测试策略

**Contract 测试保持 public contract 不变**：`ui-inprocess.contract.test.ts` 测试的是 `UiBackendClient` 接口。Phase 2 精简版保留 `ui-inprocess.ts` 作为 public assembly，因此 import 路径不变；测试可以补充行为覆盖，但不应改变接口语义。

**新增模块级单元测试**：

| 新模块 | 测试文件 | 最小验证点 |
|--------|---------|-----------|
| `session-controller.ts` | `session-controller.unit.test.ts` | `resolveSessionForNewPrompt` 的 active/explicit/inactive opt-in 路径 |
| `prompt-controller.ts` | `prompt-controller.unit.test.ts` | queue binding、active session inheritance、close rejection |
| `runtime-controller.ts` | `runtime-controller.unit.test.ts` | runtime lazy creation、creation failure status、abort target |
| `event-router.ts` | `event-router.unit.test.ts` | handler 异常隔离、snapshot replacement、unsubscribe |
| `types.ts` | 无需独立测试 | 仅内部类型，无运行时逻辑 |

#### 验收标准

- [ ] `ui-inprocess.contract.test.ts` 全部通过（无需修改测试逻辑）
- [ ] 拆分后每个新模块有独立的单元测试
- [ ] 新模块间无循环 import
- [ ] `ui-inprocess.ts` 保留为 public assembly，且不新增 daemon 相关业务逻辑
- [ ] command/title/snapshot/permission/context 的继续拆分在 Phase 3/4 触碰对应边界时单独验收

---

### 2.2 空 session 查找统一

#### 单元测试

| 测试 | 验证点 |
|------|-------|
| `resolveSessionForNewPrompt` 优先级 | explicit session → active 空 session → inactive reuse opt-in → 创建新 session |
| 不可复用非空 session | activeSession 有 messages 时，不应复用 |
| 不可复用其他 project 的 session | projectRoot 不匹配的 session 不应被复用 |
| 普通 prompt 不复用 inactive empty session | fresh terminal 普通提交不捡起 inactive 空 session |
| `/new` opt-in 复用 inactive empty session | `/new` 传 `reuseInactiveEmptySessions: true` 后才走 Core/UI inactive fallback |

#### 验收标准

- [ ] `/new` 命令行为不变（按优先级查找可复用 session）
- [ ] 普通 `submitPrompt()` 不走 inactive empty session fallback
- [ ] `findReusableEmptyPrimary` 的调用**只有一处**（`resolveSessionForNewPrompt` 中）

---

## Phase 3 测试标准

### 3.1 Daemon 启动与关闭

#### 集成测试

| 测试 | 验证点 | 位置 |
|------|-------|------|
| Daemon 启动成功 | Supervisor.start() → 状态文件写为 "running" | `supervisor.integration.test.ts` |
| PID 锁防止重复启动 | 两个 Supervisor 不能同时持有同一 PID 文件 | `supervisor.integration.test.ts` |
| SIGTERM 优雅关闭 | 发出 SIGTERM → runManager.cancelAll 被调用 → streamBridge 关闭 → 状态写为 "stopped" | `supervisor.integration.test.ts` |
| 崩溃恢复 | 启动时 run_ledger 中有 pending/running → 标记为 interrupted | `bootstrap.integration.test.ts`（已有） |
| 关闭超时强制退出 | shutdownTimeout 到期后仍未完成 → process.exit | `supervisor.unit.test.ts`（已有） |

#### 新增测试

| 测试 | 验证点 |
|------|-------|
| SessionManager 在 bootstrap 中正确组装 | `bootstrapRuntime` 启动后可通过 SessionManager API 操作 sessions |
| HTTP server 在 daemon 启动后监听端口 | `GET /api/health` 返回 200 |

#### 验收标准

- [ ] `pnpm serve` 启动 daemon 进程，`pnpm serve status` 返回 running
- [ ] daemon 进程崩溃后，下次启动自动恢复（标记 interrupted runs）
- [ ] daemon 进程收到 SIGTERM/SIGINT，5 秒内完成优雅关闭
- [ ] 同一项目目录不能同时运行两个 daemon

---

### 3.2 CLI remote 连接

#### 集成测试

| 测试 | 验证点 | 位置 |
|------|-------|------|
| remote client getSnapshot | HTTP JSON-RPC 到 daemon → 返回 snapshot JSON | `runtime/daemon/client.integration.test.ts` |
| remote client submitPrompt | HTTP JSON-RPC prompt → daemon 创建 run → 返回确认 | `runtime/daemon/client.integration.test.ts` |
| remote client subscribeEvents | SSE 连接 → 接收 `UiEvent` 事件 | `runtime/daemon/client.integration.test.ts` |
| remote client 重建连接 | SSE 断开 → 新 client 连接 → 获取最新 snapshot | `runtime/daemon/client.integration.test.ts` |
| explicit daemon 重连保留历史 | client A 通过 daemon 提交 prompt，client B 重新连接同一 daemon 后 snapshot 保留 session/message 历史 | `tests/integration/cli/daemon-terminal.integration.test.ts` |

#### Contract 测试

| 测试 | 验证点 |
|------|-------|
| Remote client CoreAPI 方法契约 | `runtime/daemon/client.integration.test.ts` 逐个调用所有 `CoreAPI` 方法，断言 remote client → daemon → backend 的参数与返回值不漂移 |
| Remote client 行为契约套件 | Phase 4 开工前抽出可复用 contract harness，让 remote client 能跑与 `ui-inprocess.contract.test.ts` 等价的行为断言 |

#### 验收标准

- [ ] CLI `terminal` 命令通过 `--remote-port` 连接到 daemon，UI 行为与嵌入式模式一致
- [x] remote client 的 `CoreAPI` 方法转发契约通过测试
- [ ] remote client 的完整行为契约套件抽象完成并通过
- [ ] 两个 CLI 终端同时连接到同一 daemon，分别操作不同 session，互不干扰

---

### 3.3 HTTP/SSE 事件传输

#### 集成测试

| 测试 | 验证点 |
|------|-------|
| 事件广播到所有 SSE 客户端 | Daemon 产生事件 → 所有连接的 SSE 客户端都收到同一事件 |
| 单客户端断线不影响其他客户端 | 客户端 A 断开 → 客户端 B 仍能收到后续事件 |
| 事件类型完整性 | 所有 `UiEvent` union type 的变体都能通过 SSE JSON 传输（序列化/反序列化循环） |

#### 验收标准

- [ ] TUI 在远程模式下看到的流式输出与嵌入式模式一致
- [ ] permission 弹窗在远程模式下正常工作
- [ ] 命令执行结果在远程模式下正确回传

---

### Phase 4：Auto-spawn、生命周期与全局 FIFO

Phase 4 将 daemon 变为默认 terminal 路径；以下条目是本阶段 merge 前的自动化与手工验收口径。

#### 集成测试

| 测试 | 验证点 |
|------|-------|
| 无 daemon 时自动拉起 | state-file 不存在 → CLI 启动后 daemon 进程存在且 CLI 已连接 | `tests/integration/cli/daemon-auto-spawn.integration.test.ts` |
| 有 daemon 时直连复用 | daemon 已运行 → 第二个 CLI 启动不产生新 daemon 进程 | `tests/integration/cli/daemon-auto-spawn.integration.test.ts` |
| 并发拉起只有一个胜出 | 同时启动两个 CLI（无 daemon）→ 恰好一个 daemon，两个 CLI 都成功连接 | 待手工/子代理补充 |
| 版本握手不匹配 | state-file 中版本与 client 不一致 → 旧 daemon 优雅退出 → 新版 daemon 拉起 | `runtime/daemon/spawn.unit.test.ts` |
| 僵尸 state-file 恢复 | state-file 存在但 PID 已死 → CLI 清理后正常拉起 | `runtime/daemon/spawn.unit.test.ts` |
| 空闲自退 | 最后一个 client 断开后超过空闲阈值 → daemon 自动退出，state-file 清理 | `runtime/daemon/supervisor.unit.test.ts`, `runtime/daemon/server.integration.test.ts` |
| 默认 idle timeout | `startDaemonServer()` 未显式传 idle timeout 时使用 15 分钟默认值 | `runtime/daemon/main.unit.test.ts` |
| health 身份校验 | 配置 auth token 后 `/api/health` 也要求 bearer token；client 校验 health `packageVersion` | `runtime/daemon/server.integration.test.ts`, `runtime/daemon/spawn.unit.test.ts` |
| state-file token 权限 | POSIX 下 daemon state-file 以 owner-only 权限写入 | `runtime/daemon/state-file.unit.test.ts` |
| `--no-daemon` 逃生舱 | 使用该 flag 时不发现/不拉起 daemon，走嵌入式路径 | `packages/ohbaby-cli/src/bin.unit.test.ts` |
| 显式 remote auth | `ohbaby serve --auth-token` 与 `ohbaby --remote-auth-token` 可打通带 auth 的显式 daemon remote 路径 | `packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts`, `packages/ohbaby-cli/src/bin.unit.test.ts` |
| `ohbaby run` 非交互边界 | 一次性 prompt 不走 daemon auto-spawn，保持嵌入式 stdout/error 语义 | `packages/ohbaby-cli/src/cli/commands/run.unit.test.ts`, `tests/integration/cli/prompt-process.integration.test.ts` |
| 全局 FIFO | 两个 remote client 对同一 session submit，第二条在第一条 abort 后自动跟进 | `tests/integration/cli/daemon-global-fifo.integration.test.ts` |
| backend lease 边界 | daemon mode 不被 preparing lease 阻塞；in-process fallback 保留 lease 保护 | `ui-persistent.integration.test.ts` |
| daemon 崩溃恢复 | daemon 禁用 backend lease gate 时，启动仍会恢复 stale `pending/running` runs | `ui-persistent.integration.test.ts` |
| permission owner routing | permission 请求只发给发起 run 的 client | `runtime/daemon/server.integration.test.ts` |
| permission owner 断线 | owner client 断开后释放 owner 映射，pending permission 回到 unknown-owner 防死锁规则 | `runtime/daemon/permission-router.unit.test.ts` |

#### 验收标准

- [x] 默认 terminal host 走 daemon auto-spawn/reuse；`--in-process` / `--no-daemon` 走嵌入式 fallback
- [x] npm 升级路径的版本握手逻辑有 unit 覆盖；session 数据完整性仍需发布前手工 smoke
- [x] daemon 不会在无人使用时常驻（空闲自退逻辑有 fake-timer 覆盖）
- [x] 审批路由：permission 请求只发给发起该 run 的前端，其他前端只读
- [x] 子代理 review 的 must-fix 与安全/握手 important 项已补测试并修复
- [x] 真实 `.env` smoke 已执行：`pnpm run test:smoke:real`，3 个真实 provider TUI 场景通过，5 个按开关跳过
- [ ] 真实双终端手工演练仍需在可交互终端中执行

---

## 端到端验收场景

### E2E-1: 两个终端独立工作

```
前置：终端 A 在 session-1 中发送 prompt "写一个函数"
操作：
  1. 终端 B 执行 pnpm start
  2. 终端 B 发送 prompt "写一个类"
  3. 终端 A 等待 response 完成
  4. 终端 B 等待 response 完成

验证：
  - 终端 B 不在 session-1 中（activeSessionId 独立或为 null）
  - 终端 A 和 B 的消息不会交叉
  - DB 中有两个独立的 session，各自有独立的消息
```

### E2E-2: 同一 session 的并发保护

```
前置：终端 A 在 session-1 中，run 正在执行
操作：
  1. 终端 B 通过 --resume session-1 进入同一 session
  2. 终端 B 发送 prompt

验证：
  - 终端 B 的 prompt 进入 B 的本地队列并显示 Queued，session-1 的
    run 结束后自动提交（Phase 1：本地队列 + claim 重试，不保证跨终端顺序）
  或
  - 终端 B 的 prompt 在 daemon 全局 FIFO 中排队，跨终端严格有序（Phase 4）
```

### E2E-3: Daemon + Remote CLI 完整流程

```
操作：
  1. pnpm serve --port 4096
  2. pnpm start --remote-port 4096
  3. 发送 prompt "hello"
  4. 查看 response
  5. CTRL+C 退出 CLI
  6. CLI 重新连接 (pnpm start --remote-port 4096)
  7. 验证 session 历史完整保留
  8. pnpm serve stop

验证：
  - Step 3-4：流式输出正常
  - Step 6-7：重连后 session 状态完整（之前对话可见）
  - Step 8：daemon 优雅关闭，状态文件为 "stopped"

自动化覆盖：
  - `tests/integration/cli/daemon-terminal.integration.test.ts` 使用 explicit daemon、fake LLM、remote client A/B 验证 Step 3-7；真实前台进程 `pnpm serve`/`pnpm start` 的手工窗口演练仍作为最终发布前检查。
```

### E2E-4: Daemon 崩溃恢复

```
操作：
  1. pnpm serve
  2. 终端 A pnpm start --remote-port 4096
  3. 终端 A 发送 prompt（run 启动）
  4. 强制 kill daemon 进程
  5. 重新 pnpm serve
  6. 终端 A 重新连接

验证：
  - Step 5：daemon 启动成功，旧 run 被标记为 interrupted
  - Step 6：CLI snapshot 显示旧 run 状态为 interrupted/failed
```

### E2E-5: Auto-spawn 全流程（Phase 4）

```
前置：无 daemon 运行，state-file 不存在
操作：
  1. 终端 A 执行 ohbaby（无任何 flag）
  2. 终端 A 发送 prompt，确认流式输出正常
  3. 终端 B 执行 ohbaby
  4. 确认系统中只有一个 daemon 进程
  5. 终端 B 发送 prompt（不同 session），与 A 并行执行
  6. 关闭 A 和 B，等待空闲阈值

验证：
  - Step 1：daemon 被自动拉起，A 正常进入空白新视窗
  - Step 4：B 复用已有 daemon，无第二个 daemon
  - Step 5：两个 session 并行执行互不干扰（多 session 并发能力）
  - Step 6：daemon 空闲自退，无残留进程
```

---

## 回归安全网

### 每个 Phase 完成后的必跑测试

```bash
# 单元测试 + 集成测试（不涉及 e2e）
pnpm test

# Contract 测试（验证 UiBackendClient 接口未被破坏）
pnpm --filter ohbaby-agent test -- --grep "contract"

# Daemon 模块测试（Phase 3 前已存在）
pnpm --filter ohbaby-agent test -- --grep "daemon\|supervisor\|bootstrap\|pid-file"
```

### 不可妥协的质量门

以下情况**任何 Phase 都不应发生**，发生后必须修复才能推进：

1. ❌ `ui-inprocess.contract.test.ts` 测试失败（接口契约被破坏）
2. ❌ 现有 daemon 模块测试（`supervisor.unit.test.ts` 等）失败
3. ❌ `SessionManager` 接口被修改（破坏了 Core 层契约）
4. ❌ 新代码中出现 `process.exit()` 调用（应在 Supervisor 中集中管理）
5. ❌ 测试文件中有 `setTimeout` 等待时间超过 2 秒（应使用 vitest fake timers）
