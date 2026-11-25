# 删除旧路径（`.ohbaby-agent`）迁移与兼容代码

2026-07 把配置根从 `~/.ohbaby-agent/` 改名为 `~/.ohbaby/`、把数据根从 `<平台数据目录>/ohbaby-agent` 改名为 `<平台数据目录>/ohbaby` 时，加了一套自动迁移代码和“新路径没有就读旧路径”的回退逻辑，当时约定“保留一个 minor 版本后移除”。现在已经发到 0.1.20，用户确认旧路径废弃、不再兼容。本议题规划把这些代码整体删掉。

---

## 范围说明

- **In Scope（本轮包含）**：
  1. 删除迁移模块 `packages/ohbaby-agent/src/migration/`（配置迁移 `migrateOhbabyConfig` 和数据迁移 `migrateOhbabyData`），以及它在 CLI、daemon、运行时环境加载里的全部调用和诊断事件。
  2. 删除“旧路径回退读取” `resolveReadPathWithLegacy`，以及它在 model、search、mcp、agents、skills 配置加载器和 `config-coordination.ts` 里的用法。
  3. 删除 `paths/` 里的旧路径工具：`resolveLegacyOhbabyHome`、`resolveLegacyProjectOhbabyRoot`、`resolveLegacyOhbabyDataRoot`、`resolveLegacyGlobalMemoryPath` 和 `OHBABY_LEGACY_*` 常量；同时删掉旧指令 loader（`custom-instruction-loader.ts`）里对这些函数的调用。
  4. 清理依赖旧路径的测试、e2e 脚本里的 `.skip-auto-migrate` 标记，以及 README 和权威文档里的旧路径兼容承诺。产品 README 只介绍当前目录。
  5. 在同一个 `loadRuntimeEnvIntoProcessEnv()` 里堵住全局根劫持：项目 `.env` 在所有平台按大小写无关匹配，静默跳过 `OHBABY_HOME`、`HOME`、`USERPROFILE`。
- **Out of Scope（本轮不做）**：
  1. 删除旧指令 loader `custom-instruction-loader.ts` 本身：由[指令提醒化专题](../2026-11-24-instructions-reminder-and-memory-cleanup/README.md)的 Stage 2 负责。
  2. 与目录改名无关、只是名字里带 legacy 的代码：daemon 的 `assertNoLiveLegacyDaemon`（旧的“每个项目一个 daemon”）、`backupLegacyModelDocument`（没有 `schemaVersion` 的旧版 `model.json` 格式）、model 配置里的 legacy connect 等。
  3. 用户机器上残留的旧目录：程序不读、不删、不提示。

---

## 轮次地图

| 轮次 | 开启日期 | 状态 | 触发事件 | 说明 |
| --- | --- | --- | --- | --- |
| `improve-1/` | 2026-11-24 | 规划中（待审查） | 首轮立项 | 一次删干净三层旧路径兼容，轮内分 3 个 Stage |

---

## `improve-1/` 文档地图

| 编号 | 文档 | 作用 |
| --- | --- | --- |
| 00 | [00-discussion.md](./improve-1/00-discussion.md) | 与用户确认的结论和边界 |
| 01 | [01-problem-analysis-and-current-state.md](./improve-1/01-problem-analysis-and-current-state.md) | 三层旧路径兼容的现状、代码锚点和平台差异 |
| 02 | [02-optimization-plan-and-change-scope.md](./improve-1/02-optimization-plan-and-change-scope.md) | 实施契约：分 Stage 方案、改动清单、下游开工检查 |
| 03 | [03-reference-projects.md](./improve-1/03-reference-projects.md) | OpenCode、Kimi Code、Codex、Claude Code 的做法对照 |
| 04 | [04-test-and-acceptance.md](./improve-1/04-test-and-acceptance.md) | 测试、三平台验证和发布门 |
| 05 | `05-implementation-acceptance.md`（预留） | 本轮实施完成后由验收模式写入，规划期不存在 |

---

## 关联文档

- 原改名议题（历史记录，不改正文）：[2026-07-14-ohbaby-home-unification](../2026-07-14-ohbaby-home-unification/README.md)。其中“旧路径只读 fallback 保留一个 minor 版本后移除”的约定，由本议题兑现。
- 后续议题：[2026-11-24-instructions-reminder-and-memory-cleanup](../2026-11-24-instructions-reminder-and-memory-cleanup/README.md)。**本议题是它的前置条件，要先落地**。它开工前会用 `rg -n "migrateOhbaby|OHBABY_LEGACY|resolveLegacy" packages/` 检查本议题是否已完成，并确认本议题的 AC-12 已通过。

## 实施契约

- 本规划会话不写代码。实施在独立会话中按 `02` 执行、按 `04` 自测。
- 本议题没有前置依赖，可以直接开工。完成标准之一是上面那条 `rg` 结果为空且 AC-12 通过，让指令提醒化专题可以开工。
