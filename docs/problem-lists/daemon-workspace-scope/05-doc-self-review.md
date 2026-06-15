# Daemon Workspace Scope: 文档自审

> **归档状态**：该思路已放弃，由 `docs/problem-lists/server` 方案替代。本文仅保留旧文档集自审记录，不代表当前推荐方案。

## 1. 自审结论

本文档集已按 v0.1.4 目标整理，重点从“临时要求用户固定目录启动”调整为“多路径启动必须有明确 daemon scope 和连接恢复能力”。

已覆盖：

- 当前为什么会出现多个 daemon。
- `packages/ohbaby-agent/src/project` 模块是否能用于修复。
- root/subdir 是否共享 daemon的产品决策边界。
- 同一 scope 并发启动只 spawn 一次的技术方案。
- daemon state owner/generation 的必要性。
- remote client reconnect 的短期策略。
- 测试、手工验收、npm 本机 smoke 和审查标准。

## 2. 与用户反馈的一致性检查

用户指出：

> 从 repo root 和 repo 子目录启动，只 spawn 一个 daemon，这点我不太同意。

文档已修正：

- 没有把 root/subdir 一定共享 daemon 写成结论。
- 将其拆为 scope 策略选择：
  - git-root scope
  - canonical-cwd scope
  - hybrid explicit scope
- 当前推荐是先建立 `DaemonScope` 抽象，默认策略可继续讨论。

用户确认：

> 两个终端同时启动同一 workspace，只 spawn 一次，这是对的。

文档已作为 P0 技术目标写入：

- `daemon-start.lock`
- spawn 前后双重 health check
- 并发测试

## 3. 未决策点

实施前需要最终确认：

1. v0.1.4 默认 scope 是否保持 `cwd`。
2. 是否在 v0.1.4 暴露 `--scope` 或 `--workspace-root`。
3. 写操作 reconnect 后是否恢复 prompt 文本并要求用户重新提交。
4. `ohbaby serve status` 是否只显示当前 scope，还是本轮就实现 `--all`。

## 4. 风险检查

### 风险 1: scope 改动影响历史 session 归属

如果默认改成 git-root scope，已有从子目录创建的 session 可能在 projectRoot 语义上出现变化。需要迁移或兼容策略。

缓解：

- v0.1.4 可默认 cwd scope。
- git-root scope 先作为可选能力或后续版本。

### 风险 2: reconnect 重复提交 prompt

`submitPrompt` 连接失败时，服务端可能已经收到请求但响应丢失。自动重试会造成重复 prompt。

缓解：

- v0.1.4 不自动 replay 写操作。
- 后续如需写操作幂等，应引入 client request id 和 server 去重。

### 风险 3: start lock stale

Windows 进程异常退出可能留下 lock。

缓解：

- lock 文件写 pid/createdAt。
- pid 已死亡或超时则清理。
- 测试覆盖 stale lock。

### 风险 4: status/stop scope 不一致

如果 `ohbaby` 默认走 scope resolver，而 `ohbaby serve status` 仍读 cwd 默认路径，会继续造成用户困惑。

缓解：

- CLI serve command 必须接入同一 resolver。
- status 输出 scope root。

## 5. 文档完整性检查

- 没有 `TODO` 占位。
- 没有把 v0.1.4 误写为 v0.1.3。
- 没有把 root/subdir 共享 daemon 作为未确认结论。
- 没有要求用户只能从项目根目录启动。
- 没有把 reconnect 写成会自动重放写操作。
- 没有要求本轮实现全局 daemon registry。

## 6. 建议用户重点审查

请重点看：

1. `02-design-and-implementation-plan.md` 的 Scope 策略选项。
2. `02-design-and-implementation-plan.md` 的当前推荐是否符合你对 root/subdir 的预期。
3. `04-testing-acceptance-review.md` 中手工验收是否覆盖你正在做的多路径压力测试。
