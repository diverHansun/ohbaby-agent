# 03 测试与验收标准

> 文档职责：定义验证本次彻底修复所需的测试与验收门。前置：[`01-root-cause-analysis.md`](./01-root-cause-analysis.md)、[`02-implementation-plan.md`](./02-implementation-plan.md)。
> 方法：TDD，先写失败的回归测试复现根因，再改实现使其通过。项目测试约定：测试 colocated 于源文件旁，三级命名 `.unit.test.ts` / `.integration.test.ts` / `.e2e.test.ts`，root vitest。

---

## 一、测试范围

覆盖：

- per-session 并发语义：不同 session 可并发；同 session 被拒。
- per-run 所有权恢复：owner 进程已死/为 NULL 的孤儿 run 被回收；存活 owner 的 run 不被触碰。
- 移除全局 lease 后，多个 backend（多窗口模拟）在同一库下互不阻塞。
- 数据库升级路径：旧库加 owner 列、清理历史 lease 行后行为正确。

不覆盖（非本次职责）：

- server 模式的 prompt-queue/permission/replay 协调（属 ohbaby-server）。
- `.ohbaby/daemon-state.json` 写入来源（单独追踪）。
- PID 复用极端边界（列为后续硬化）。

---

## 二、失败回归测试先行（TDD 第一步）

在改实现前，先写下述测试并确认它们在当前代码下失败（复现根因）：

1. 同一数据库、两个不同 session、近乎同时 submit -> 两个都应进入运行，均不被拒。
   - 当前代码：第二个会因全局 lease 抛 `SessionRunBusyError`（失败，复现 bug）。
2. 同一数据库、同一 session、第一个运行中再 submit -> 第二个应被拒（queued）。
   - 当前与修复后都应通过（保证不回退正确语义）。

这两条共同钉死目标不变量：拒绝只发生在同 session，不发生在跨 session。

---

## 三、单元测试（run-ledger，注入假存活判定）

文件：`runtime/run-ledger/database.unit.test.ts` 或扩充现有 `database.integration.test.ts` / `in-memory.unit.test.ts`

注入可控的 `isOwnerAlive` 假实现，覆盖：

- claim 跨 session：两个不同 session 各自 claim，均成功（无全局阻塞）。
- claim 同 session、owner 存活：第二个 claim 抛 `SessionRunBusyError`。
- claim 同 session、owner 已死：该 session 的死 owner active run 被懒恢复为 interrupted，新 claim 成功。
- claim 同 session、owner 为 NULL（旧数据）：按孤儿处理，懒恢复后成功。
- `recoverOrphanedRuns`：库中混合存活/死亡 owner 的 active run，只回收死/NULL owner 的，存活 owner 的保持 active。
- owner_id/owner_pid 正确写入与读回。

存活判定的保守性：实现需明确"探测异常时的默认判定"，单元测试应固定该行为（建议探测不确定时偏向视为存活，避免误删他人 run）。

---

## 四、集成测试（真实数据库，多 backend）

文件：扩充 `adapters/ui-persistent.integration.test.ts`

- 在同一真实 SQLite 库上创建两个 persistent backend 实例（模拟两个窗口），不同 session 并发 submit -> 两者都能推进，互不阻塞（修复前此用例失败）。
- 同库、同 session 串行语义保持。
- 升级路径：用一个仅有旧 schema（无 owner 列）且含一条 running 行的库初始化，跑迁移后启动 -> owner 列存在、历史 lease 行被清理、旧 running 行被恢复为 interrupted。
- 移除 `backendLeaseMode` 后，原先依赖 `backendLeaseMode: "disabled"` 的用例（[ui-persistent.integration.test.ts:918](../../../packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts#L918)、[:1213](../../../packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts#L1213)）需更新为新语义。

---

## 五、人工验证（真实多窗口）

- 同机打开 3 个 `ohbaby` 窗口：2 个在 `D:\Projects\Code-cli\ohbaby-agent`、1 个在 `C:\`，各自 submit 不同 prompt -> 三者都应运行，无 queued。
- 在同一窗口同一 session 运行中再次提交 -> 表现为同 session 串行（符合预期）。
- 杀掉一个正在运行的窗口进程，重开该 session 再提交 -> 不被永久拒绝（孤儿被回收后可继续）。
- 需用真实 API key 跑通至少一次完整 run，确认非纯 mock 路径无回归。

---

## 六、验收标准

功能门：

- 不同 session 跨窗口可并发运行（核心修复目标）。
- 同 session 多写者仍被正确拒绝。
- owner 已死的孤儿 run 可被启动恢复或同 session 懒恢复回收，不阻塞后续提交。
- 全局 backend lease 相关代码已删除，无残留引用。

回归红线（不得破坏）：

- 现有 run-ledger 状态机测试、session 切换测试、persistent backend 集成测试通过。
- `docs/problem-lists/terminal-daemon/`（终端闪烁修复）、`docs/problem-lists/sessions-ui-backend/`（session 切换修复）不得回退。
- server 模式集成测试通过（移除 `backendLeaseMode` 无行为变化）。

工程门：

- 失败回归测试在修复前红、修复后绿。
- 全量自动化测试通过；真实 API key 验证通过；人工多窗口验证通过。
- changelog 记录"多窗口并发"行为变化与升级说明。

---

## 七、验证顺序

1. 写失败回归测试（第二节），确认复现。
2. 按 02 的提交批次逐批实现，每批跑相关单元/集成测试。
3. 全量门 + 升级路径集成测试。
4. 真实 API key 与多窗口人工验证。
5. 更新 changelog，进入 v0.1.4 发布门禁。
