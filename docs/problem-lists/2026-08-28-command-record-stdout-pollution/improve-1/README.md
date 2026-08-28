# improve-1 · Command Record 默认终端静默

## 1. 本批一句话

保留 `UiCommandRecord`、command gateway、脱敏、关联与 fail-open 合同，但取消低层 recorder 和默认 composition 的隐式终端 I/O：TUI in-process 与 `ohbaby serve` 在未显式注入 recorder 时都使用本地 no-op，不再把内部 command observation JSON 写入用户终端。

这是一项默认行为 Bug 修复，不是日志/debug/telemetry 系统建设。

## 2. 文档地图

| 文档 | 用途 |
| --- | --- |
| `00-discussion.md` | 用户确认的目标、边界与决策历史 |
| `01-problem-analysis-and-current-state.md` | 根因、证据链、影响面与现有测试盲区 |
| `02-optimization-plan-and-change-scope.md` | 实施方案、包级改动面、兼容与生命周期合同 |
| `04-test-and-acceptance.md` | TDD 用例、进程级回归、TUI/Web/E2E 验收门 |
| `05-implementation-acceptance.md` | 实施完成后的独立验收结论、规划对账、SWE 评估与未关闭项 |

（`03-reference-projects.md` 跳过：本批未采用外部参考项目，编号空缺是预期。）

## 3. In scope

- `command-recorder.ts`：structured recorder 必须显式提供 sink；默认 diagnostic 静默；低层模块不得直接写 `process.stdout` / `process.stderr`。
- Agent host 与 Server：`commandRecorder` 未提供或为 `false` 时，在所有环境统一使用各自的本地 no-op；显式 recorder 原样保留。
- 删除 composition root 对 command observation 的硬编码 stderr reporter；gateway、关联、脱敏、记录模型与 fail-open 不变。
- 默认 composition 不再拥有 structured recorder，也不在 dispose 时 flush 它；显式注入者拥有其 recorder 的 drain/flush/dispose 生命周期。
- 用精确 ESLint 规则保护 `command-recorder.ts` 不再引入隐式终端 I/O。
- 新增 `NODE_ENV=production`、清除 `OHBABY_DEBUG`、完全隔离用户配置/数据路径与 cwd 的真实子进程回归测试。
- 同步 SDK、TUI、Server 权威文档，并完成 TUI、Web、E2E 运行验收。

## 4. Out of scope

- 不建设日志/debug/telemetry 系统，不新增或复用环境变量作为 command record 产品出口。
- 不新增 `--verbose`、`--debug`、`--quiet` 或配置项。
- 不新增 `onCommandObservationDiagnostic` 等无当前调用方的 options 字段。
- 不在 SDK 新增共享 no-op 常量；Agent 与 Server 保留各自的微型本地实现，避免无收益的公共 API。
- 不修改 gateway 的记录所有权、correlation 注入、trusted queue owner、脱敏或 fail-open 语义。
- 不在 TUI 渲染层过滤 JSON，不 patch 全局 stream，也不把 stdout 污染简单搬到 stderr。
- 不处理 `migration/ohbaby-home.ts` 的 `[OHBABY_MIGRATION]` warning；它是同类 surface 问题，但不属于本批 command record 修复。
- 不把 `ohbaby run` 当作产品启动形态；本批只验收 in-process TUI 与 `ohbaby serve` Web。
- 实施与验收阶段不自行 merge/push；最终版本管理只在用户明确授权后执行。

## 5. 开发闸门

1. 四份规划文档与最终决策一致。
2. 先写并观察关键回归测试在旧实现上失败。
3. 按 Phase A → B → C 实施，不顺手扩展日志系统或公共 API。
4. lint、目标测试、全量测试、typecheck、build 通过。
5. 在隔离进程中完成 TUI、Web 与 E2E 验收。
6. 由独立子代理做代码审查与验收；主进程修复有效发现后再给出结论。
