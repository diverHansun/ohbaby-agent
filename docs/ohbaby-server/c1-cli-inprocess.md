# C1 · 默认 CLI 回 in-process（实施前调查与步骤）

> **定位**：抽 `ohbaby-server` 的**前置步骤**。先修地基（默认 CLI 不再依赖隐藏 daemon），再搬家（迁移 daemon → ohbaby-server）。
> **来源决策**：`docs/problem-lists/server/07-route-c-cli-inprocess-explicit-server.md` 的 C1。本文是它的落地版。
> **交付**：独立阶段、独立 commit，可单独测试审查；但与 `ohbaby-server` 迁移共用同一个 v0.1.4 release gate，不单独发布中间版本。

---

## 一、目标

默认 `ohbaby`（terminal 命令）启动时使用 **in-process runtime**：当前进程内同时跑 UI + agent runtime，Ctrl+C / 关窗口即释放。不再自动 discover/spawn 后台 daemon。

daemon/server 能力**不删除**，改为显式：`ohbaby serve` 起 server，`ohbaby --remote-port <port>` 显式 attach。

---

## 二、调查结论（病根定位）

默认走 daemon 的只有**一处**，由两层默认值串通造成：

| 入口 | 文件 | 当前默认 | 处置 |
|------|------|---------|------|
| `terminal`（`ohbaby`） | [terminal.ts:95-102](../../packages/ohbaby-cli/src/cli/commands/terminal.ts#L95-L102) | 无 flag → `{ daemon: true }` auto-spawn | ✅ 翻为 in-process |
| `core-api-factory` | [core-api-factory.ts:100](../../packages/ohbaby-agent/src/host/core-api-factory.ts#L100) | `inProcess !== true && daemon !== false` → spawn | ✅ 收紧为仅显式 daemon |
| `run`（`ohbaby run`） | [run.ts:51-52](../../packages/ohbaby-cli/src/cli/commands/run.ts#L51-L52) | 已 `{ daemon: false, inProcess: true }` | ✓ 已正确，作样板 |
| `serve`（`ohbaby serve`） | [serve.ts](../../packages/ohbaby-cli/src/cli/commands/serve.ts) | 显式 server（start/status/stop） | ✓ 保留（文案 daemon→server 属 C2） |

连锁反应（删 `--daemon` 后）：
- `terminal` 只剩两种模式：默认 in-process / `--remote-port` 显式 attach。
- `ensureDaemonRunning` / `spawn.ts`（自动发现-或-拉起）**失去唯一生产调用方**，只剩测试/SDK 使用 → 白纸黑字证明"自动 spawn 不在任何默认路径"，为迁移时把它归入 detached 降级抽屉提供依据。
- daemon/server 代码本身**不在 C1 删除**，仍供 `serve` + 显式 attach 使用；删码是迁移阶段的事。

---

## 三、决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| `--daemon` 标志 | **删除** | 偏好干净；daemon 能力经 serve+attach 显式保留 |
| `--in-process` 标志 | **删除** | 默认已 in-process，该 flag 成冗余别名 |
| daemon 分支代码 | **C1 保留，迁移再删** | C1 保持最小，只翻默认值 |
| 交付节奏 | **独立阶段 + 同一 v0.1.4 门禁** | 小改动先落地验证，但不单独发布中间版本 |

---

## 四、实施步骤

### 步骤 1：`terminal.ts`
- 移除 `--daemon`、`--in-process` 两个 option（builder 中删除）。
- 移除 `useInProcess` 推导与 `--remote-port cannot be used with --in-process` 的相关分支（简化为：有 `--remote-port` 即 remote，否则 in-process）。
- 默认传参：`remotePort === undefined → { inProcess: true }`（保留 `--remote-port` 的 remote 分支）。
- 清理 describe 文案中的 "daemon" 措辞（如 `--remote-port` 描述）。

### 步骤 2：`core-api-factory.ts`
- 将 [line 100](../../packages/ohbaby-agent/src/host/core-api-factory.ts#L100) 条件从 `options.inProcess !== true && options.daemon !== false` 改为 **仅 `options.daemon === true`** 才进 `ensureDaemonRunning` 分支。
- 默认（无 daemon、无 remotePort）直接落到 `createPersistentUiBackendClient` in-process 分支。
- daemon 分支代码保留（迁移阶段处理）。

### 步骤 3：测试跟随
- `core-api-factory.unit.test.ts`：默认用例断言从"走 daemon"改为"走 in-process"；保留显式 `daemon: true` 仍走 spawn 的用例。
- `bin.unit.test.ts`：terminal 默认传参断言更新（不再有 `{ daemon: true }`）。
- `spawn.unit.test.ts`：确认无"默认必被调用"的隐式断言（spawn 自身逻辑不变）。
- daemon 全局 FIFO 集成测试：改用 `serve` + `--remote-port` 驱动 daemon 路径（不能再靠 `terminal --daemon`）。

### 步骤 4：文档与变更说明
- 更新 `docs/problem-lists/server/07`：勾验收、标 C1 状态为已实施。
- changelog / README / release notes：声明默认行为变化 +「`--daemon`/`--in-process` 已移除，显式 server 改用 `ohbaby serve` + `ohbaby --remote-port`（迁移后可扩展为 `ohbaby attach <url>`）」。

---

## 五、验收标准（doc 07 三道门）

- npm 安装后默认 `ohbaby` **不创建** daemon state/pid 文件。
- 同一目录两个终端运行 `ohbaby`，得到**两个独立新 session**（不共享 active session 指针）。
- 关闭终端后**无残留**后台 daemon 进程。
- 回归红线：`docs/problem-lists/terminal-daemon/`（闪烁修复）、`docs/problem-lists/sessions-ui-backend/`（session 切换修复）不得回退。

---

## 六、风险与必须告知的行为变化

| 项 | 说明 | 缓解 |
|----|------|------|
| **多窗口不再共享 session** | C1 后同目录两个 `ohbaby` = 两个独立 in-process session | doc 02 P0 预期（可预测性）；写入 changelog；需要共享走 `serve`+`attach` |
| 依赖 `--daemon` 的用户 | 该 flag 被删，脚本会报 unknown option | changelog 显式说明替代路径 `serve` + `--remote-port` |
| daemon-global-fifo 测试改造 | 驱动方式从 terminal 改为 serve+attach | 行为仍被覆盖，仅入口变 |

---

## 七、与后续迁移的衔接

C1 完成后，不单独发布；进入 `ohbaby-server` 迁移阶段。迁移 plan 见 [`migration-sequence.md`](./migration-sequence.md)。C1 已证明自动 spawn 不在默认路径，迁移时可放心把 `spawn/supervisor/state-file/pid-file` 归入 `lifecycle/` 降级抽屉（见 [architecture.md](./architecture.md)）。
