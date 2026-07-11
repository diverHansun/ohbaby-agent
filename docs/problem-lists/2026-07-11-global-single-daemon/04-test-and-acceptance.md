# 4. 测试与验收标准

## 4.1 测试原则

项目测试分类与命名以 `docs-test/classification.md`、`docs-test/writing-guide.md` 为准。本议题延续 **co-located** 约定：server 相关 integration 测试放在 `packages/ohbaby-server/src/**` 邻近被测边界，不另造 `tests/integration/server/` 第二套目录。

- 单元测试优先固化 **用户级 pid/state**、**InstanceStore**、**workspace router/dispatcher**、**claim 双写** 边界。
- 集成测试使用 `app.fetch` 注入（ADR-001 测试 harness），避免不必要的真实端口（lock 与 listen 除外需少量真实端口用例）。
- 默认 TUI in-process 路径：回归现有 `ui-inprocess.contract.test.ts`，确保 **无** 引入 remote 依赖。
- 双写场景必须 **断言机制**（claim 失败 / 单行 run），不能仅断言 stderr 含提示文案。
- 真实 `.env` / provider 仅用于 smoke，不写入快照。

---

## 4.2 单元测试矩阵

| 模块 | 测试文件（新建或扩展） | 必测行为 |
|------|------------------------|----------|
| 用户级 pid/state | 扩展 `runtime/daemon/{pid-file,state-file,main}.unit.test.ts` | `O_EXCL`；stale takeover；release ownership；启动中等待；state 真实端口/token；packageVersion 精确匹配；版本不同或缺版本拒绝且不 kill |
| InstanceStore | `packages/ohbaby-server/src/runtime/instance-store.unit.test.ts` | 同 scope 并发 load 只创建一次；不同 scope 不同 runtime；load 失败移除缓存可重试；disposeAll 幂等 |
| workspace 路由 | `runtime/instance-store.unit.test.ts` + `runtime/daemon/global-server.integration.test.ts` | header 解析；realpath/git-root 归一；缺 header 400；不存在/不可读/非目录 400；无 query/cwd fallback |
| per-scope app 隔离 | `runtime/daemon/global-server.integration.test.ts`（扩展） | 不同 header 返回对应 project sessions；同 clientId 跨 scope 不串 view/permission/replay；当前只覆盖基础分发与 fail-closed，完整隔离断言待补 |
| claimPendingRun | `packages/ohbaby-agent/src/runtime/run-ledger/*.test.ts` | 已有；保持跨连接并发单成功 |
| SessionRunBusyError | `packages/ohbaby-agent/src/runtime/run-ledger/errors` | 含 sessionId；可选 owner 字段 |
| prompt-queue | `packages/ohbaby-server/src/coordination/prompt-queue.unit.test.ts` | 同 scope/session FIFO；不同 session 可并发；queue 随 WorkspaceInstance 隔离 |
| serve-awareness | `packages/ohbaby-cli/src/serve-awareness.unit.test.ts` + `bin.unit.test.ts` | pid/state + health + version 成功才提示；无全局 state → 无提示；默认 TUI 不 import `ohbaby-server` |

---

## 4.3 集成测试矩阵

| 场景 | 测试文件 | 验收条件 |
|------|----------|----------|
| 全局单 serve | `runtime/daemon/main.unit.test.ts` + `runtime/daemon/global-single-serve.integration.test.ts` | 第一次成功；第二次同机复用 URL，仅一个 pid/listener |
| 多 scope 单端口 | `runtime/daemon/global-server.integration.test.ts` | repoA/repoB header 路由到不同 app runtime；session 与 SSE scope 隔离 |
| remote client + directory | `packages/ohbaby-server/src/protocols/jsonrpc/client.integration.test.ts` | client 传 directory，RPC 落到正确 scope |
| 双写同 session | `packages/ohbaby-agent/src/runtime/run-ledger/dual-writer-process.integration.test.ts` | 两个真实进程共享 DB 并 claim 同 session，**恰好一个**成功，另一个 `SessionRunBusyError`，run_ledger 仅一行 active run |
| 孤儿恢复 | `ui-persistent.integration.test.ts` | owner_pid 死 → recover → 另一端可 claim |
| TUI 默认不 remote | `packages/ohbaby-cli/src/bin.ts` 相关测试 | `createCoreHost` 无 serve 时不调 `createRemoteUiBackendClient` |
| 端口避让 | `main.unit.test.ts` / 全局 serve 集成 | 4096 占用时 `daemon-state.json` 中 port 非 4096 且 health OK；显式 `--port` 占用则失败 |
| foreground 生命周期 | 全局 serve 集成 | 所有客户端断开并超过旧 15min 后仍存活；Ctrl+C/stop 才退出 |
| 全局面板 | `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts` + `src/ui/App.unit.test.tsx` | repoA/repoB 共用 origin；切换后旧 SSE 关闭，新 HTTP+SSE header 同步变化，UI 选择器调用 runtime switch |
| legacy 兼容 | `runtime/daemon/main.unit.test.ts`（基础已覆盖）；若需真实进程再增 co-located integration | 当前 cwd live legacy 阻止全局 start；无全局 state 时 status/stop 回退；ownership 不明不 kill |

---

## 4.4 关键用例详述

### 4.4.1 用户级 pid/state 单实例

**步骤**

1. 启动 serve A，独占写入用户级 pid，listen 成功后写 state。
2. 启动 serve B（同机）。
3. B 应 reused 或 exit 0 并打印 A 的 URL，**不应** bind 第二端口。

**命令**

```bash
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/pid-file.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/state-file.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts
```

### 4.4.2 InstanceStore 隔离

**验收**

- header `directory=/path/repoA` 与 `directory=/path/repoA/sub` 映射同一 scopeKey，backend 实例相同。
- `directory=/path/repoB` 不同实例。
- repoA 的 session 不出现在 repoB 的 snapshot 中。
- 同一 clientId 在 repoA/repoB 的 active session、permission owner、SSE replay seq 互不污染。
- 缺 header 必须得到 400，不能静默进入启动 serve 时的 cwd。

### 4.4.3 双写预防（同 session）

**验收**

- 两 backend 共享 `OHBABY_DB_PATH` 临时库。
- 对 `session-1` 几乎同时 `submitPrompt`。
- 断言：run_ledger 中 `session-1` 的 `pending|running` 行数在任一时刻 ≤ 1。
- 失败方收到 `SessionRunBusyError` 或进入本地队列（若测试 Web 队列语义则单测 coordination）。

**禁止**

- 仅断言 stderr 含 "Avoid prompting"；必须有 claim 层面的断言。

### 4.4.4 TUI serve 感知（Phase 1b 发布门）

**验收**

- mock 用户级 pid/state + health + matching packageVersion → `formatServeCoexistenceNotice()` 非空。
- 不 mock 时默认 `ohbaby` 仍成功启动 backend。

### 4.4.5 回归：默认 CLI

**验收**

- `pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` 全绿。
- `packages/ohbaby-cli/src/host/core-api-factory.unit.test.ts` 仍调用 `createPersistentUiBackendClient`，非 remote。

---

## 4.5 手动验收清单

1. 单 serve：在 repoA 执行 `ohbaby serve`，记录 URL；在 repoB 再执行 `ohbaby serve`，应复用 **同一** URL/全局面板，repoB 只作为本次初始选中项目；面板可切换两项目。
2. `ohbaby serve status` / `stop` 不依赖 cwd（读用户级 pid/state）；兼容窗口内无全局 state 时允许当前 cwd legacy fallback。
3. serve 运行时另开终端 `ohbaby`，TUI 正常；对 **不同** session 两边各发 prompt 成功；对 **同一** session 一边跑 run 时另一边 busy/排队。
4. `ohbaby --remote-port` 连 serve，带 directory 可访问正确项目 session。
5. 关闭所有浏览器并等待超过旧 idle timeout，显式 foreground serve 仍存活。
6. 停止 serve 后 pid 文件释放、state 进入可解释终态、DB 连接关闭（无僵尸 pid）。
7. 使用不同 packageVersion 再次启动时拒绝复用并提示手动重启，旧 server 不被自动 kill。

---

## 4.6 非目标（本批不测）

- `/loop` fire、Scheduler、Heartbeat。
- Web 全局面板的高级项目管理/视觉体验（本批只验最小 known/selected/switch 闭环）。
- LAN/CORS/移动端鉴权。
- TUI attach serve。
- 多机分布式 serve。

---

## 4.7 发布门（Release Gate）

状态说明：`[x]` 表示已有自动化或明确的手动 E2E 证据；Phase 1 发布门已全部关闭。

- [x] 用户级 pid/state + InstanceStore + fail-closed workspace routing 合入且单测绿。
- [x] 同机第二 `serve` 不产生第二监听端口（真实双进程集成测试）。
- [x] 双写同 session 真实跨进程集成测试绿。
- [x] 默认 `ohbaby` 契约测试无回归，且不加载 server 包。
- [x] 默认 TUI 通过轻量 pid/state + health/version 检查给出 coexistence 提示，且实现不 import `ohbaby-server`。
- [x] `docs/problem-lists/2026-07-11-global-single-daemon/` 与 `hono-app/04` 交叉引用更新。
- [x] 4096 被占用时 serve 自动换端口且 state 记录真实 port。
- [x] packageVersion 不一致或缺失时拒绝复用且不自动 kill。
- [x] 显式 foreground serve 不配置 idle-exit。
- [x] 全局面板可在同 origin 切换 repoA/repoB，HTTP/SSE 均无 scope 串扰。
- [x] legacy 当前 cwd 检测、status/stop fallback 与 ownership 防误杀单测通过。

---

## 4.8 命令汇总

```bash
# 核心单测
pnpm test:unit
pnpm test:contract

# 双写与 serve
pnpm test:integration

# 回归
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm exec vitest run packages/ohbaby-server/src/protocols/jsonrpc/client.integration.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts
```

---

## 4.9 2026-07-11 实施验收记录

- `pnpm test:unit`：192 个文件、1552 个测试通过。
- `pnpm test:contract`：10 个文件、201 个测试通过。
- `pnpm test:integration`：39 个文件、242 个测试通过，包含真实双进程单 listener 与同 session 双写 claim。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全部通过。
- `pnpm test:smoke`：2 个文件、9 个依赖真实外部 provider 的用例按环境条件跳过，无失败。
- 真实 CLI：从 repoA 启动 serve、repoB 再执行 serve，二者返回同一 origin；从任意 `/tmp` 路径执行 status/`serve ps` 成功；serve 存活时默认 in-process TUI 正常启动并显示轻量 coexistence 提示。
- 浏览器 E2E：同一全局面板在 repoA/repoB 间切换；repoA 新建会话后切到 repoB 不可见，再切回 repoA 恢复为 1 个会话；浏览器错误日志为空。
