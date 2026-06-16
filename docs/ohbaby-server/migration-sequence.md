# ohbaby-server · migration-sequence（v0.1.4 实施顺序）

> 本文把 C1 与 `ohbaby-server` 迁移合并到一个 v0.1.4 release gate 下。它不是代码实现计划的替代品；真正动代码前还需要按此文档写 implementation plan，并逐步测试。

---

## 1. 总体策略

v0.1.4 采用**两阶段、同一发布门禁**：

1. **阶段 C1：默认 CLI 回 in-process**
   - 解决真实用户痛点：默认启动不再依赖 hidden daemon。
   - 删除 `--daemon` / `--in-process`。
   - 保留显式 remote 参数和现有 `serve` 路径，降低切换风险。

2. **阶段 S：迁移 `ohbaby-server` 包**
   - 建立 `packages/ohbaby-server`。
   - 把 server/protocol/coordination/auth/lifecycle 从 `runtime/daemon/` 按职责迁出。
   - `ohbaby-cli` 显式 server/remote 路径接到 `ohbaby-server`。
   - 默认 `ohbaby` 仍保持 in-process，不触达 server 包。

当前状态：S0 package skeleton、S1 low-risk primitives、remote client 迁移已经落地；显式 CLI server/remote 路径解析到 `ohbaby-server`。生命周期/HTTP server 文件的深层拆分仍是后续 cleanup，v0.1.4 不把 detached daemon 重新引入默认路径。

两阶段可以分批 commit、分批审查，但不发布中间版本。v0.1.4 发布前必须完成自动化测试、真实 API key 验证、用户本机验证。

---

## 2. 分支建议

从当前规划基线创建临时分支：

```text
work/v0.1.4-doc-alignment
work/v0.1.4-c1-inprocess
work/v0.1.4-ohbaby-server
```

推荐顺序：

1. `work/v0.1.4-doc-alignment`：只提交文档对齐。
2. `work/v0.1.4-c1-inprocess`：基于文档分支，实现 C1。
3. `work/v0.1.4-ohbaby-server`：基于 C1 分支，迁移 server 包。

不要急着 merge 到 `main`。等自动化、子代理审查、真实 API key 测试、用户本机测试都通过后，再决定合并策略。

---

## 3. 阶段 C1：默认 CLI 回 in-process

目标见 [`c1-cli-inprocess.md`](./c1-cli-inprocess.md)。

当前状态：`work/v0.1.4-c1-inprocess` 已实现并通过聚焦单测；仍需在 `ohbaby-server` 迁移完成后一并跑完整回归与真实环境验证，不单独发布。

必要改动：

- `packages/ohbaby-cli/src/cli/commands/terminal.ts`
  - 删除 `--daemon`。
  - 删除 `--in-process`。
  - 默认传 `{ inProcess: true }`。
  - 有 `--remote-port` 时走显式 remote。
- `packages/ohbaby-agent/src/host/core-api-factory.ts`
  - auto-spawn 条件收紧为仅 `options.daemon === true`。
  - 无 remotePort、无显式 daemon 时走 local backend。
- 测试更新：
  - `packages/ohbaby-cli/src/bin.unit.test.ts`
  - `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts`
  - 受 `--daemon` 影响的 CLI/daemon 集成测试。

验收：

- 默认 `ohbaby` 不调用 `ensureDaemonRunning()`。
- 默认 `ohbaby` 不创建 daemon state/pid 文件。
- 同一目录两个终端启动是两个新 session。
- 终端闪烁与 session view reset 回归不破坏。

---

## 4. 阶段 S0：新包骨架

目标：创建可构建、可类型检查、暂无行为切换的 `packages/ohbaby-server`。

必要改动：

- 新增 `packages/ohbaby-server/package.json`。
- 新增 `packages/ohbaby-server/tsconfig.json`。
- 新增 `packages/ohbaby-server/tsup.config.ts`。
- 新增 `packages/ohbaby-server/src/index.ts`，先导出空的窄接口或迁移后的类型占位。
- root `tsconfig.json` 增加 project reference。

验收：

- `pnpm --filter ohbaby-server build` 通过。
- `pnpm run typecheck` 通过。
- 默认 CLI 测试仍走 C1 后的 in-process 路径。

---

## 5. 阶段 S1：迁移纯协议与工具逻辑

目标：先迁移低风险、少副作用的文件，减少大爆炸。

候选迁移：

- `runtime/daemon/protocol.ts` → `ohbaby-server/src/protocols/jsonrpc/protocol.ts`
- `runtime/daemon/auth.ts` → `ohbaby-server/src/auth/token.ts`
- `runtime/daemon/prompt-queue.ts` → `ohbaby-server/src/coordination/prompt-queue.ts`
- `runtime/daemon/permission-router.ts` → `ohbaby-server/src/coordination/permission-router.ts`

测试跟随迁移到同包 colocated 位置，或者保留旧测试路径但改 import。优先保持测试含义不变。

验收：

- 迁移文件的 unit tests 通过。
- `ohbaby-agent` 不再导出这些 server-only 内部实现，除非为过渡显式 re-export。

---

## 6. 阶段 S2：迁移 remote client 与 server

目标：把显式 remote/server 能力移到 `ohbaby-server`，并保持 CLI 默认不触达。

候选迁移：

- `runtime/daemon/client.ts` → `ohbaby-server/src/protocols/jsonrpc/client.ts`
- `runtime/daemon/server.ts` → 拆入：
  - `ohbaby-server/src/transport/app.ts`
  - `ohbaby-server/src/transport/node-server.ts`
  - `ohbaby-server/src/protocols/jsonrpc/rpc-handler.ts`
  - `ohbaby-server/src/protocols/web/routes.ts`（如本期启用 web 路由）

接线原则：

- `ohbaby-cli` remote/serve 路径 import `ohbaby-server`。
- `ohbaby-agent` 不 import `ohbaby-server`。
- `core-api-factory.ts` 在迁移后应偏向 local/in-process；remote 选择由 CLI 命令层或 CLI runtime dependency 完成。

验收：

- `ohbaby serve` 使用 `ohbaby-server` 启动显式 server。
- `ohbaby --remote-port` 使用 `ohbaby-server` remote client。
- 默认 `ohbaby` 的 import 路径不拉起 server 包。

---

## 7. 阶段 S3：生命周期降级抽屉

目标：处理原 daemon lifecycle 代码，避免它继续影响默认 CLI。

候选处理：

- `runtime/daemon/spawn.ts`
- `runtime/daemon/supervisor.ts`
- `runtime/daemon/state-file.ts`
- `runtime/daemon/pid-file.ts`
- `runtime/daemon/main.ts`

策略：

- foreground server 是主路径。
- detached lifecycle 若保留，迁到 `ohbaby-server/src/lifecycle/detached/`，并只由显式命令触达。
- 若当前 v0.1.4 不需要 detached，先不打磨，只保留必要兼容或删除入口。

验收：

- 默认 CLI 不 import `spawn/supervisor/state-file/pid-file`。
- `rg "ensureDaemonRunning|pid-file|state-file"` 不应命中默认 terminal path 的生产调用链。

---

## 8. 回归测试范围

必须覆盖：

- `docs/problem-lists/session-switch-regression`
- `docs/problem-lists/session-view-reset`
- `docs/problem-lists/terminal-daemon`
- `docs/ohbaby-server/test.md` 的 server 包单元/集成测试

命令层建议：

```bash
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run build
```

真实环境验证：

- 使用真实 API key 跑默认 `ohbaby`。
- 使用 `npm pack` + 本机全局安装验证默认 CLI。
- 显式启动 `ohbaby serve` 并用 remote 参数连接。
- 验证关闭 terminal 后无 hidden daemon 残留。

---

## 9. 审查门禁

完成实现后：

- 先做本地自审：diff、依赖方向、测试覆盖、npm pack。
- 再派子代理分块审查：
  - C1 CLI 默认路径审查。
  - `ohbaby-server` 包边界和依赖方向审查。
  - 测试与回归矩阵审查。
- 不急着 merge，不急着 tag，不急着 npm publish。等待用户真实环境测试和审核。

---

## 10. 不做事项

- 不为了测试通过保留 hidden daemon 默认路径。
- 不让 `ohbaby-agent` 反向依赖 `ohbaby-server`。
- 不自动重放 prompt。
- 不把 detached lifecycle 提升为默认稳定性方案。
- 不提前做完整 web/app/ACP/A2A，只保留 server 包边界。
