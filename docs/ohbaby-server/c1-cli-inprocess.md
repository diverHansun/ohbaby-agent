# C1 · 默认 CLI 回 in-process（实施前调查与步骤）

> **定位**：抽 `ohbaby-server` 的**前置步骤**。先修地基（默认 CLI 不再依赖隐藏 daemon），再搬家（迁移 daemon → ohbaby-server）。
> **来源决策**：`docs/problem-lists/server/07-route-c-cli-inprocess-explicit-server.md` 的 C1。本文是它的落地版。
> **交付**：独立阶段、独立 commit，可单独测试审查；但与 `ohbaby-server` 迁移共用同一个 v0.1.4 release gate，不单独发布中间版本。

> **实施状态**：已合并到 `main`。默认 in-process、删除用户可见 `--daemon` / `--in-process`，并在 `ohbaby-server` 迁移后删除 `ohbaby-agent/src/runtime/daemon`。仍需完整回归、真实 API key 验证和用户本机测试后进入 v0.1.4 发布门禁。

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
| `core-api-factory` | [core-api-factory.ts](../../packages/ohbaby-agent/src/host/core-api-factory.ts) | `inProcess !== true && daemon !== false` → spawn | ✓ 删除 remote/daemon 分支，仅保留 local backend |
| `run`（`ohbaby run`） | [run.ts](../../packages/ohbaby-cli/src/cli/commands/run.ts) | 已 `{ daemon: false, inProcess: true }` | ✓ 仅保留 `{ inProcess: true }` |
| `serve`（`ohbaby serve`） | [serve.ts](../../packages/ohbaby-cli/src/cli/commands/serve.ts) | 显式 server（start/status/stop） | ✓ 保留（文案 daemon→server 属 C2） |

连锁反应（删 `--daemon` 后）：
- `terminal` 只剩两种模式：默认 in-process / `--remote-port` 显式 attach。
- `ensureDaemonRunning` / `spawn.ts`（自动发现-或-拉起）在 C1 后失去生产调用方，并已在 server 迁移清理中删除。
- daemon/server 代码不再留在 `ohbaby-agent`；显式 `serve` + remote attach 由 `ohbaby-server` 承担。

---

## 三、决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| `--daemon` 标志 | **删除** | 偏好干净；daemon 能力经 serve+attach 显式保留 |
| `--in-process` 标志 | **删除** | 默认已 in-process，该 flag 成冗余别名 |
| daemon 分支代码 | **迁移到 ohbaby-server，并删除 agent 目录** | C1 后的 v0.1.4 清理已完成 |
| 交付节奏 | **独立阶段 + 同一 v0.1.4 门禁** | 小改动先落地验证，但不单独发布中间版本 |

---

## 四、实施步骤

### 步骤 1：`terminal.ts`
- 移除 `--daemon`、`--in-process` 两个 option（builder 中删除）。
- 移除 `useInProcess` 推导与 `--remote-port cannot be used with --in-process` 的相关分支（简化为：有 `--remote-port` 即 remote，否则 in-process）。
- 默认传参：`remotePort === undefined → { inProcess: true }`（保留 `--remote-port` 的 remote 分支）。
- 清理 describe 文案中的 "daemon" 措辞（如 `--remote-port` 描述）。

### 步骤 2：`core-api-factory.ts`
- 删除 `remotePort` / `daemon` / `ensureDaemonRunning` 分支。
- 默认直接落到 `createPersistentUiBackendClient` in-process/persistent 分支。
- remote 选择由 `ohbaby-cli` 命令层分发到 `ohbaby-server`。

### 步骤 3：测试跟随
- `core-api-factory.unit.test.ts`：默认用例断言从"走 daemon"改为"走 in-process"；删除显式 `daemon: true` auto-spawn 用例。
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

C1 完成后，不单独发布；进入 `ohbaby-server` 迁移阶段。迁移 plan 见 [`migration-sequence.md`](./migration-sequence.md)。当前 `spawn/ensureDaemonRunning` 已删除，`supervisor/state-file/pid-file/main` 已迁到 `ohbaby-server` 的显式 server runtime。

---

## 八、Release notes draft

- 默认 `ohbaby` 改为 in-process runtime，不再自动 discover/spawn 隐藏 daemon。
- 移除 `--daemon` 与 `--in-process`；它们属于内部实现细节，不再作为用户 CLI surface 暴露。
- 显式 server 使用路径仍保留：`ohbaby serve` 启动服务，`ohbaby --remote-port <port>` 连接显式 server。
