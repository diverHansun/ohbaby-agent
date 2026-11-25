# 4. 测试与验收标准

> 本仓库没有单独的 test-blueprint 文档。测试由仓库根目录的 Vitest 统一收集（`pnpm test` / `pnpm vitest run <path>`）。
>
> CI（`.github/workflows/ci.yml`）在 `ubuntu-latest`、`windows-latest`、`macos-latest` 三个系统上跑 typecheck、lint、`pnpm test:unit`（只收 `*.unit.test.*`）、几组点名的 `vitest run` 文件列表和 build。**CI 不跑全量 `pnpm test`**。和本专题相关、在 CI 里三平台都会跑的有：`bin.unit.test.ts`、`packaging-smoke.integration.test.ts`，以及所有 `*.unit.test.*`（包括 `paths/ohbaby-home.unit.test.ts`、`project-env.unit.test.ts`）。其余集成测试由实施者在本地跑全量 `pnpm test`。

## 4.1 测试范围

这是一次删除改造，不新增功能，主要风险有三个：

1. 删漏了：某处还在读旧目录。
2. 删多了：误删了与旧路径无关、但名字相近的代码，比如 `startupNotices`、`emitWithoutAffectingProduct`、`backupLegacyModelDocument`。
3. 隐性依赖：测试或脚本悄悄靠迁移、回退读取或迁移诊断事件才能跑通，删除后挂掉。01 §1.3.7 已列出审查找到的全部依赖。

所以测试分三类：

| 类别 | 内容 | 方式 |
| --- | --- | --- |
| 静态检索 | 生产代码、测试、脚本里没有旧路径和迁移符号 | `rg` + `pnpm typecheck` |
| 行为验证 | 旧目录存在时程序完全不碰它；新路径照常工作 | 少量负例单测 / 集成断言 |
| 回归 | 原有测试全部通过 | 本地全量 `pnpm test` + 三平台 CI |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 期望结果 | Stage |
| --- | --- | --- | --- | --- |
| AC-01 | 临时 home 下只有 `~/.ohbaby-agent/.env` 和 `model.json`，没有 `~/.ohbaby/` | 单测（`project-env.unit.test.ts`） | `loadRuntimeEnvIntoProcessEnv` 不加载旧 `.env` 里的变量；调用结束后 `~/.ohbaby/` 不会被创建，旧目录内容原封不动 | 1 |
| AC-02 | 旧数据根下有 `ohbaby-agent.db`，新数据根为空，启动 daemon | 集成（改写 `global-single-serve.integration.test.ts` 里原来的迁移用例） | daemon 在新数据根建一个新的空 `ohbaby.db`；旧库文件没有被复制、改名或删除 | 1 |
| AC-03 | 诊断日志不再有迁移事件 | 集成（`command-record-terminal.integration.test.ts`；`scripts/run-compiled-web-e2e.mjs`） | 期望列表删掉两个迁移事件后测试通过；增加负例断言：日志中不存在 `event.startsWith("migration.")` 或 `component === "migration"` 的记录（不写死旧事件字面量，避免与 §4.5 的 `rg` 发布门冲突） | 1 |
| AC-04 | （已撤除）解析前 `presentStartupNotices` 与 middleware 已随迁移 `onWarning` 一起删除 | — | 删掉迁移 `onWarning` 后解析前已无任何 `startupNotices` 生产者，且自动更新在 `bin.ts:143-155` 已直写 stderr；删除 `presentStartupNotices`、解析前 middleware 与 `bin.unit.test.ts:448-476`，保留 `startupNotices` 缓冲由 AC-05 覆盖 | 1 |
| AC-05 | TUI 启动时的更新提示 | 现有单测（`bin-startup-update.unit.test.ts`、`terminal-startup-update.unit.test.ts`、`app.contract.test.tsx`） | `initialNotices` 照常显示 | 1 |
| AC-06 | 旧配置根下有 `mcp/settings.json`，新配置根为空 | 单测（`config/mcp/__tests__/loaders.unit.test.ts`，把删掉的回退用例改成负例） | 加载结果为空配置，不读旧文件 | 2 |
| AC-07 | `settingsConfigVersion` 在旧路径与当前路径变更时的版本判断 | 单测（`config/llm/__tests__/settings-version.unit.test.ts`） | 只有旧配置根有文件时版本哈希和“两个根都为空”相同；修改旧文件不触发版本变化，修改当前有效文件仅影响对应域（覆盖 `search` 间接路径） | 2 |
| AC-08 | 旧指令目录存在：`~/.ohbaby-agent/OHBABY.md`、`<project>/.ohbaby-agent/OHBABY.md`、`~/.config/ohbaby-agent/OHBABY.md` | 单测（`custom-instruction-loader-service.unit.test.ts`，把删掉的“preserves global instructions from the legacy home directory”改成负例） | 加载结果里没有这三个文件的内容；新路径下的指令照常加载 | 2 |
| AC-09 | 三个平台的新数据根解析 | 单测（`paths/ohbaby-home.unit.test.ts`，用 `platform` 参数，CI 三平台都跑） | Linux 为 `$XDG_DATA_HOME/ohbaby` 或 `~/.local/share/ohbaby`；macOS 在未设置 `XDG_DATA_HOME` 时为 `~/Library/Application Support/ohbaby`（设置了 `XDG_DATA_HOME` 时优先用之，与 `ohbaby-home.ts:111-119` 一致）；Windows 为 `%LOCALAPPDATA%\ohbaby`，`LOCALAPPDATA` 为空时回落到 `~\AppData\Local\ohbaby`，并且不受 `APPDATA` 影响 | 2 |
| AC-10 | `OHBABY_HOME` 和项目 `.ohbaby/` 的解析 | 现有单测 | 行为不变 | 2 |
| AC-11 | `prompt-process` 集成测试和 `tui-real-provider` 冒烟测试改用 `~/.ohbaby/model.json` | 现有测试 | 通过。冒烟测试需要真实 key，CI 不跑，由实施者本地确认能读到配置 | 2 |
| AC-12 | 项目 `.env` 不能改写全局根：宿主 home 指向临时目录且未设 `OHBABY_HOME`，可信全局根的 `.env` 放标记变量 `TRUSTED_MARK`；项目根 `.env` 写入合法绝对路径 `OHBABY_HOME=<attackerDir>`、`HOME=<attackerDir>`、`USERPROFILE=<attackerDir>` 和一个普通变量；在各平台分别覆盖三个保留键的大写、小写和混合大小写拼法，`<attackerDir>/.env` 放标记变量 `ATTACKER_MARK`；另测宿主显式设置 `OHBABY_HOME` | 单测（`project-env.unit.test.ts`，不传 `homeDirectory`，传了会绕过 `OHBABY_HOME` 解析） | 调用后 `OHBABY_HOME` 仍未设置，`HOME` / `USERPROFILE` 保持宿主原值；返回的 `globalEnvPath` 和 `resolveOhbabyHome()` 都指向可信根；同时断言 `TRUSTED_MARK` 已加载、`ATTACKER_MARK` 未加载（防止“全局整体失效”也能假通过）；项目 `.env` 中各拼法的保留键都被静默跳过；普通变量以原名加载；宿主显式设置的 `OHBABY_HOME` 照常生效。结束后恢复 `process.env` | 1 |

AC-01、AC-02、AC-06、AC-07、AC-08 是“旧目录存在时程序不碰它”的负例测试，测试代码里会出现 `.ohbaby-agent` 字符串，这是预期内的。负例不必每个配置域都写一个，mcp 一个域代表回退读取的删除就够了，其余配置域靠 `rg` 和类型检查兜底。

## 4.3 集成边界

- **CLI ↔ agent 包**：CLI 不再探测 `migrateOhbabyData`；`pnpm typecheck` 能发现残留引用。
- **daemon ↔ agent 包**：`main.ts` 不再调用迁移；daemon 的单测和 AC-02 覆盖启动路径。
- **诊断日志**：`DiagnosticsComponent` 去掉 `"migration"` 后，按组件枚举的地方由 typecheck 发现；AC-03 覆盖日志内容。
- **指令提醒化专题**：本专题完成后，那边开工前的检查命令必须为空，见 4.5 的“下游开工条件”。

## 4.4 回归清单

- `pnpm vitest run packages/ohbaby-agent/src/paths packages/ohbaby-agent/src/utils packages/ohbaby-agent/src/config packages/ohbaby-agent/src/observability packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/adapters/settings-refresh.integration.test.ts`
- `pnpm vitest run packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/bin-startup-update.unit.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- `pnpm vitest run packages/ohbaby-server/src/runtime/daemon`
- `pnpm vitest run tests/integration/cli`
- `node scripts/run-compiled-web-e2e.mjs`（按脚本自身要求先构建）
- 全量 `pnpm test`，并核对执行的测试文件数和用例数都大于 0。

## 4.5 验收标准（发布门）

| 门 | 标准 | 检查方式 |
| --- | --- | --- |
| 迁移零残留 | 没有迁移符号、迁移事件和跳过标记 | `rg -n "migrateOhbaby\|MigrationReport\|MigrationCompleted\|migration\.(config\|data)\.completed\|skip-auto-migrate\|migrated-from-ohbaby" packages tests scripts apps --glob '!**/dist/**'` 为空 |
| 旧路径工具零残留 | 没有回退读取和旧路径函数 | `rg -n "OHBABY_LEGACY\|resolveLegacy\|resolveReadPathWithLegacy\|getLegacy" packages tests scripts apps --glob '!**/dist/**'` 为空 |
| 下游开工条件 | 指令提醒化专题可以开工 | `rg -n "migrateOhbaby\|OHBABY_LEGACY\|resolveLegacy" packages/ --glob "!**/dist/**"` 为空，且 AC-12 通过 |
| 旧路径字符串 | 只剩本专题点名负例测试 | `rg -n "\.ohbaby-agent\|ohbaby-agent\.db" packages tests scripts apps --glob '!**/dist/**' --glob '!**/*.md'` 只命中 4.2 列出的负例测试文件（注：这是本前置提交的阶段门；后续指令提醒化专题合入后会由其 AC-04 接替旧 loader 的负例夹具） |
| 类型与规范 | 全部通过 | `pnpm typecheck && pnpm lint && pnpm format:check` |
| 全量测试 | 本地通过，用例数大于 0 | `pnpm test` |
| 三平台 CI | `ubuntu-latest`、`windows-latest`、`macos-latest` 全绿 | GitHub Actions |
| 文档 | 三份产品 README 仅介绍当前路径；权威设计文档删除旧路径兼容承诺 | 按 02 Stage 3 的 DoD 检索 |
| 打包冒烟 | 打出的 CLI 包能在干净 home 上启动 | `tests/integration/cli/packaging-smoke.integration.test.ts`（CI 三平台都跑） |

## 4.6 对抗性审查要点

- 有没有误删 `emitWithoutAffectingProduct`、`startupNotices` / `takeStartupNotices`、`runtimeEnvResult`？它们还有别的用途；同时确认 `diagnosticsHandle`、`presentStartupNotices` 和解析前 `.middleware(...)` 已彻底清理、无未用变量或重复 stderr 输出。
- `resolveModelJsonReadPath` 简化后，`options.modelJsonPath` 显式传入时的行为是否不变？`llm/writer.ts` 的兜底分支删掉后，第一次写入（`originalModel` 为空）的行为是否不变？
- `settingsConfigVersion` 改完后，各配置域的哈希输入顺序是否不变？顺序变了，所有运行中的实例会误判一次“配置已改”。
- Windows 上 `platformDataBase` 是否还在读 `APPDATA`？
- 旧 loader 是否只删了三类旧候选路径，其余逻辑原样保留？
- 项目 `.env` 里的 `OHBABY_HOME` / `HOME` / `USERPROFILE` 是否真的被跳过？AC-12 是否同时断言了可信标记出现、恶意标记不出现？`globalEnvPath` 是否在项目 `.env` 加载之后才计算也不受影响？
- 有没有新加“检测旧目录”或“删除旧目录”的代码？按 00 的决定，两者都不该有。
- 重新构建后，打包产物（`dist`）里是否还有 `migration` 目录？规划时已核对过，`packages/ohbaby-agent/package.json` 没有单独列出这个目录，按理不会残留。
