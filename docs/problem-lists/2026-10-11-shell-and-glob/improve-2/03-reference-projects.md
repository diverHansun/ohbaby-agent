# Shell / Glob 参考项目与取舍

> 本地源码快照调研，不等同于项目最新线上行为。ohbaby 基线 `24c70034`；OpenCode `388406238b`；Pi `6fb2e7815`；Kimi `5b936697670ed15444bcb4720bd91e6ee776a941`。Codex `03b761dca9b0`；本地 Claude Code 恢复项目 `77a7934e15d6`。

## Shell

| 来源     | 做法与证据                                                                                                                                                                                           | ohbaby 取舍                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| OpenCode | [shell.ts](../../../../../opencode/packages/opencode/src/tool/shell.ts) L312：web-tree-sitter + Bash / PowerShell WASM；AST 提取命令与路径                                                           | 采用成熟分析方向；自行适配 Node / tsup 打包，不照搬其 bundler 资源导入        |
| Codex    | [exec_policy.rs](../../../../../codex/codex-rs/core/src/exec_policy.rs) L876：无法可靠拆分时保留原始 argv 进入策略；[shell.rs](../../../../../codex/codex-rs/core/src/shell.rs) 有多种原生解释器参数 | 借鉴原文执行与分析不完整的保守判断；不移植完整 OS 沙箱 / PTY                  |
| Codex    | [shell_detect.rs](../../../../../codex/codex-rs/shell-command/src/shell_detect.rs) L280：PowerShell 优先 pwsh 再 powershell                                                                          | 采用 Windows 默认顺序；本项目不把 cmd 作为未配置时的最终自动默认              |
| Pi       | [utils/shell.ts](../../../../../pi/packages/coding-agent/src/utils/shell.ts)：Bash / PowerShell 配置入口独立，传进程环境                                                                             | 借鉴真实解释器与普通 env 继承；不新增同义工具，也不照搬 Windows 默认 Git Bash |

成熟 AST 只提供语法结构，不证明任意脚本只读。OpenCode 的权限检查也不能被当作 OS 沙箱。Codex 的某些放行决策依赖它的隔离条件，不能移植到本项目 `host-local isolation:none` 后直接自动执行。

本地 `claude-code` 为第三方源码恢复项目，不作为官方实现证据；本批没有依据该目录推断官方安全边界。

## Glob

| 来源     | 实际执行路径                                                                                                                                                                                                                              | 可采用 / 不采用                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OpenCode | [core/ripgrep.ts](../../../../../opencode/packages/core/src/ripgrep.ts) L98：`rg --files`，limit+1，有取消和结果限制                                                                                                                      | 采用成熟引擎与多读一条的完成性判断；不照抄 hidden / ignore 默认  |
| Pi       | [find.ts](../../../../../pi/packages/coding-agent/src/core/tools/find.ts) L182：`fd --glob --hidden --max-results`；[分层 ignore 回归](../../../../../pi/packages/coding-agent/test/suite/regressions/3303-find-nested-gitignore.test.ts) | 借鉴具体范围测试；不额外打包 fd，不把其可返回目录的行为引入 Glob |
| Kimi     | [globTool.ts](../../../../../kimi-code/packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts) L357：rg files/hidden/glob；L242 区分 timeout / capture truncation / traversal error                                                   | 采用诚实完成性；不引入 mtime 排序、分页、另一套敏感文件规则      |

本地临时目录实验确认：rg 的正向 `--glob` 可覆盖 ignore；`--glob '*.ts'` 会匹配任意层同名文件。ohbaby 因而显式使用 `--no-ignore` 保留现状、`/<pattern>` 保留根锚定，并把固定排除放最后。

已验证的模式包括根层 `/*.ts`、递归 `/**/*.ts`、`/*.{ts,tsx}` 和前导感叹号 `/!*.ts`。复核还确认字面 `[x]` 目录需要用 `/[[]x]/*.ts` 匹配，路径流包含待规范化的 `./` 前缀。工具说明和验收用例已记录这个语法迁移。2026-10-11 复核本仓 bundled rg 15.0.0：`/x.ts` 正常命中，`//x.ts` 返回 exit 1 且 stdout / stderr 均为空。因此前导 `/` 用户输入须在拼接根锚定前拒绝，不能依赖 rg 报模式错误。

这些小实验是规划证据；完整兼容、取消和三平台打包仍需按 04 验收。

## 与方案的关系

以上借鉴直接支撑 [02](02-optimization-plan-and-change-scope.md) 的成熟 parser、原始 invocation、Windows PowerShell 默认、rg 路径流、limit+1 和完成性设计。权限模式、目录锁、环境传递、默认搜索范围以 ohbaby 已确认契约为准，不把参考项目的整套架构搬进来。
