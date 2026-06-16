# 01 原因分析

> 文档职责：定位"多窗口只有一个能运行"的根因，逐层给出代码证据（精确到文件与行号），不展开修复方案（方案见 02）。
> 调试方法：遵循 systematic-debugging，先根因后修复。本文是 Phase 1（根因）与 Phase 2（模式）的产出。

---

## 一、症状

同机打开 3 个 `ohbaby` 窗口（独立 PowerShell 进程）：

- 其中 2 个的 project root 是 `D:\Projects\Code-cli\ohbaby-agent`。
- 第 3 个的 project root 是 `C:\`（C 盘根目录）。

现象：只有 1 个窗口能发送消息并运行，其余 2 个提交 prompt 时显示 queued，无法运行。

预期：默认 CLI 是单窗口单前端的 in-process runtime，不同窗口是相互独立的 session，应能并发运行。

---

## 二、复现与数据流

提交 prompt 时，in-process backend 在真正写入 per-session 记录之前，先经过一个全局闸门 `beforePromptSubmit`：

1. 窗口 1（session S1）submit：拿到全局 lease，run 进入 active，全局 active run 计数为 1。
2. 窗口 2（session S2）submit：全局 lease 判定"窗口 1 进程存活且全局 active run 计数大于 0 且 owner 不是自己"，拿不到锁，抛 `SessionRunBusyError`，显示 queued。
3. 窗口 3（session S3，位于 C:）submit：因为共用同一个全局数据库与同一把全局锁，同样拿不到锁，显示 queued。

这精确解释了"1 个运行、2 个 queued"，也解释了为什么连不同 project root（C:）的窗口都被卡住。

---

## 三、逐层证据

### 证据 1：数据库是全局单库，不是 per-project-root

`resolveDatabasePath` 默认解析到用户级单一路径（Windows 为 `%APPDATA%\ohbaby-agent\ohbaby-agent.db`）。

- [services/database/path.ts:24-27](../../../packages/ohbaby-agent/src/services/database/path.ts#L24-L27)

含义：所有窗口，无论 project root 在 D: 还是 C:，共用同一个 SQLite 库。因此任何"按库"的全局状态都会跨窗口共享。

### 证据 2：backend lease 是全局单行、按全局计数

- lease 存成 `app_state` 表里一个固定 scope/key 的单行（一个库一把锁）：
  - 常量 [ui-persistent.ts:75-76](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L75-L76)（`scope = "global"`、`key = "persistentUiBackendLease"`）。
  - 写入 [ui-persistent.ts:164-177](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L164-L177)。
- 计数是全表跨 session 的：`countActiveRuns` 为 `COUNT(*) WHERE status IN ('pending','running')`，不区分 session：
  - [ui-persistent.ts:180-189](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L180-L189)。

### 证据 3：提交前的全局闸门先于 per-session 检查

`beforePromptSubmit` 调用 `refreshBackendLeaseIfSafe`，拿不到锁即抛 `SessionRunBusyError`：

- 闸门 [ui-persistent.ts:615-636](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L615-L636)。
- 锁判定 [ui-persistent.ts:202-240](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L202-L240)：
  - `acquired = !liveOwner || (activeRunCount === 0 && !preparingOwner) || previousLease.ownerId === ownerId`。
  - 多窗口下，别的窗口存活（liveOwner=true）、全局 activeRunCount>0、owner 不是自己 → acquired=false。

关键：即使提交方是一个全新的唯一 session（per-session 的 `claimPendingRun` 本会放行），也会被这个前置的全局 lease 直接挡死。

### 证据 4：默认启用，且与 server 路径不对称（冒烟枪）

- in-process 默认启用 lease：`backendLeaseEnabled = options.backendLeaseMode !== "disabled"`，默认即 enabled，core-api-factory 调用时未传该选项：
  - [ui-persistent.ts:583](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L583)。
- server 路径已显式禁用 lease：
  - [ohbaby-server/src/runtime/daemon/main.ts:92](../../../packages/ohbaby-server/src/runtime/daemon/main.ts#L92) `backendLeaseMode: "disabled"`。

迁移时 server 路径想清楚了：它有自己的 prompt-queue 协调，所以禁用了 lease。但 in-process 路径被遗漏，恰恰是现在拥有 N 个独立窗口的路径，却保留了为单 daemon 设计的全局锁。

### 证据 5：per-session 路径本身是正确的

`claimPendingRun` 只按 session 锁：先查该 session 的 active run，有则拒，无则插入。

- [run-ledger/database.ts:234-247](../../../packages/ohbaby-agent/src/runtime/run-ledger/database.ts#L234-L247)（内部用 `getActiveRunIdsForSession`，[database.ts:151-165](../../../packages/ohbaby-agent/src/runtime/run-ledger/database.ts#L151-L165)）。

这一层是正确的，应保留；问题在它之外、之前的那把全局锁。

---

## 四、根因

全局 backend lease 是为"单 daemon = 单写者"拓扑设计的不变量。迁移把进程拓扑从"1 个 daemon"改成"N 个独立窗口"，却没有重新审视这个不变量，也没有像 server 路径那样在 in-process 路径禁用它。结果：全局 lease 把同一个全局库下的所有窗口/所有 session 串行化，同机只允许一个 active run，其余提交被拒为 queued。

用户看到的 queued 不是"单窗口单前端生命进程失败"，而是默认 in-process 路径残留了一把全局 backend 锁。

---

## 五、SWE 判断

### 职责揉合（SRP 违反）

这把 lease 把两件本应分离的事揉在一起：

1. 崩溃恢复（合理）：启动时把"owner 进程已死"的孤儿 run 标为 interrupted。
   - [shouldRecoverStartupRuns:265-276](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L265-L276)。
2. 并发单写者（已失效）：提交时阻止"别的存活 owner 有 active run"。这是 daemon 拓扑的不变量，现在错误地阻断了多窗口并发。

### 正确的不变量

应为：不同 session 可并发（各窗口各自 session）；只有同 session 的多写者才该被拒/只读化。per-session `claimPendingRun` 已满足后者；全局 lease 属于过度执行，且执行错了对象。

### 归属错位（cohesion）

"运行所有权 + 崩溃恢复"被放在 `ui-persistent` 适配器里的全局 lease，与运行生命周期的真正归属者 `run-ledger` 分离。这是把判定放错了层。彻底修复应把该职责重定位到 `run-ledger`（见 02）。

---

## 六、同源的次要问题

- 提交闸门里的 `markInterrupted` 也是全局的：当 owner 死了时跨所有 session 标 interrupted。
  - [ui-persistent.ts:631-635](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts#L631-L635)。
  - 与主 bug 同源（全局 scope），随彻底修复一并消除。

---

## 七、本文不处理（单独追踪）

- project root 下出现 `.ohbaby/daemon-state.json`：它是显式 server 的 state-file（[ohbaby-server/.../daemon/main.ts:20](../../../packages/ohbaby-server/src/runtime/daemon/main.ts#L20)）。需另行确认是 `serve` 产物/旧残留，还是默认 `ohbaby` 仍在写（后者违反 C1 验收）。与本次 lease 修复无直接因果，单独记录。
