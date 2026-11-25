# 讨论记录与已确认要点

> 来源：2026-11-24 规划会话。这次规划由“指令提醒化专题”的会话派生出来，结论由用户在本会话中逐项确认。

## 1. 背景与动机

- 2026-07-15 的提交 `f15748b7`（feat: unify ohbaby config and data homes）统一了配置根和数据根，同时加了自动迁移和旧路径回退读取。原议题文档约定：“旧路径只读 fallback 保留一个 minor 版本后移除”。三份 README 也对用户写了同样的承诺。
- 现在已经发到 0.1.20，过渡期早就结束了。用户明确表示：`~/.ohbaby-agent/`、`<project>/.ohbaby-agent/` 已废弃，不再需要兼容。
- 这些代码还在每次启动时运行。配置迁移每次加载运行时环境都会跑，数据迁移在 CLI 和 daemon 启动时都会跑。它们给启动路径多加了文件系统探测、锁和诊断事件，也让维护者读代码时多一层“新路径还是旧路径”的分支。

## 2. 已确认：目标与范围

| 议题 | 结论 |
| --- | --- |
| 删除范围 | **三层一起删**：配置迁移、数据迁移（含会话数据库）、旧路径回退读取，以及 `paths/` 里的全部旧路径工具（包括 `resolveLegacyGlobalMemoryPath`）。删完后代码里不再有“旧配置根 / 旧数据根”的概念。 |
| 会话数据迁移 | **一起删**。用户知道这样做的后果：没迁过数据的机器升级后看不到历史会话，旧数据库文件仍留在磁盘上。 |
| 旧目录怎么处理 | **不读、不删、不提示**。程序把旧目录当作不存在；产品 README 删除旧迁移段落，只介绍当前路径。 |
| 全局根防劫持 | 本专题 Stage 1 顺手做：项目 `.env` 在所有平台按大小写无关匹配，静默跳过 `OHBABY_HOME`、`HOME`、`USERPROFILE`（和删迁移调用是同一个函数；从指令提醒化专题挪过来，见 §6）。 |
| 完整改动清单 | 需要。02 写明全部调用方、公开导出、测试和文档的改动清单。 |
| 文档落点 | `docs/problem-lists/2026-11-24-legacy-home-removal/improve-1/` |

## 3. 已确认：边界（不做的事）

- 不做“检测到旧目录就提示一次”。
- 不自动删除用户的旧目录。
- 不动名字里带 legacy、但和目录改名无关的代码，比如 `assertNoLiveLegacyDaemon` 和 `backupLegacyModelDocument`。
- 不删除旧指令 loader（`custom-instruction-loader.ts`）本身，那是指令提醒化专题 Stage 2 的事。
- 不改原改名议题（2026-07-14）以及其他历史问题清单、release notes 的正文。

## 4. 已确认：与关联议题的关系

**本专题先落地，是指令提醒化专题（`2026-11-24-instructions-reminder-and-memory-cleanup`）的前置条件。**

- 指令提醒化专题已经按这个顺序改好了文档：它不再修改 `migration/`，也不再给迁移加“跳过指令文件”的规则。它在开工前会执行 `rg -n "migrateOhbaby|OHBABY_LEGACY|resolveLegacy" packages/ --glob "!**/dist/**"`，要求结果为空。
- 为了让旧路径一次清干净，本专题**顺手删掉旧 loader 里的旧路径探测**（`<project>/.ohbaby-agent/`、`~/.ohbaby-agent/` 和旧全局记忆文件这三类候选路径），并删掉 `resolveLegacyGlobalMemoryPath`。这样本专题落地后，上面那条 `rg` 的结果直接为空。
- 旧 loader 文件本身仍由那边的 Stage 2 整个删除。那边已不再列出删除 `resolveLegacyGlobalMemoryPath` 的步骤，两边不会重复改。

## 5. 参考项目

调研了上级目录 `code-cli/` 下的 OpenCode、Kimi Code、Codex 和 Claude Code。OpenCode 在 2026-06 把运行了约 3.5 个月的 JSON→SQLite 迁移整块删掉，没有留回退，也没有提示，和本专题的做法一致。详见 [03-reference-projects.md](./03-reference-projects.md)。

## 6. 用户确认记录

- 2026-11-24：用户确认旧路径废弃、不再兼容；这一轮只写文档、不实施。
- 2026-11-24：用户确认三项决定：数据迁移一起删；旧目录不读、不删、不提示；落地顺序待定。
- 2026-11-24：落地顺序最初选的是“指令专题先做”，和指令专题会话里得到的确认相反。向用户核对后，最终确认**本专题先做**，并由本专题顺手删掉旧 loader 里的旧路径探测和 `resolveLegacyGlobalMemoryPath`。
- 2026-11-25（复审修订）：当时确认收紧三份 README 的手动迁移说明（此项由下文最终决定取代）（停掉新旧版本进程、先备份两边、仅在目标位置不存在 `ohbaby.db` 及其 `-wal`/`-shm` 时才复制改名、两边已有会话不覆盖不混用、顺带说明旧项目级 `<project>/.ohbaby-agent/` 配置按需逐项合并），并把回滚说明改实（代码可 `git revert`，但新旧两边已分叉的数据库不能自动合并）。
- 2026-11-25（复审修订）：确认删除 `bin.ts` 中已无解析前生产者的 `presentStartupNotices`、解析前 `.middleware(...)` 与对应测试 `bin.unit.test.ts:448-476`（撤掉 AC-04，仅保留 `startupNotices` / `takeStartupNotices` 供 TUI 重显自动更新提示，并避免 `finally` 重复打印 stderr）；补删 `bin.ts:665, 683` 的死变量 `diagnosticsHandle`；AC-03 负例断言改为检查不含 `event.startsWith("migration.")` / `component === "migration"`，消除与 §4.5 `rg` 门禁的字面冲突。
- 2026-11-25（复审收尾）：对齐 Stage 2 细节——提醒 `resolveSearchJsonPath` 若改为同步须同步更新 `config-coordination.ts:130`、清理过时 legacy 注释；`ohbaby-home.unit.test.ts` 补齐 AC-09 的 Linux/Windows fallback 用例；统一 AC-06 与 AC-08 在 `02`/`04` 中“改为负例”的表述；AC-07 明确目标文件 `settings-version.unit.test.ts` 并补充有效路径正例（覆盖 `search` 间接路径）。
- 2026-11-25（指令专题复审）：确认把“项目 `.env` 不能改写全局根”的加固从指令提醒化专题挪到本专题 Stage 1。理由：两边改的是同一个 `loadRuntimeEnvIntoProcessEnv()`，分开做会冲突；它保护的是整个全局配置根，不只是指令。做法是项目 `.env` 不接受 `OHBABY_HOME`、`HOME`、`USERPROFILE`，验收见 04 的 AC-12。

- 2026-11-25（最终决定）：旧目录属于开发阶段历史，三份产品 README 直接删除旧迁移段落。项目 `.env` 的三个保留键在所有平台按大小写无关匹配并静默跳过，只在加载处写代码注释，由 AC-12 验证。
