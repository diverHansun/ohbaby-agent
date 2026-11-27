# 讨论结论

## 背景

议题总览见 [README](../README.md)。默认权限下，常见只读 bash（例如 `ls`、`cat`、`git status`）和会改东西的 bash 一样，每次都要审批，打断开发体验。

## 最新定稿（2026-11-27，用户最新确认优先）

本节结论取代下方早期宽白名单讨论，作为 [02 方案](02-optimization-plan-and-change-scope.md) 与 [04 验收](04-test-and-acceptance.md) 的唯一有效口径：

- **复用已有 POSIX 解析器路径事实**：`6f4f0483` 已落地的空设备输出（`/dev/null`）与 fd 复制（`>&数字` / `>&-`）、未引号的家目录展开（`~` / `~/`）、纯 `&&` 链 `cwd` 传播及容器级清空，直接作为基线事实复用。
- **收紧为 POSIX 狭义明确只读白名单，不做通用参数解析**：
  - `pwd`
  - `ls`（含 `-la`，可带一个目录）
  - `cat <文件>`
  - `head -n <数字> <文件>`、`tail -n <数字> <文件>`
  - `wc -l [<文件>]`（同时将 `wc` 补进 `shell/path-args.ts` 的 `PATH_COMMANDS`，防止敏感/外部路径漏检）
  - `cd <字面目录> &&` 后续上述形式（纯 `&&` 链；管道（包括 `cat <文件> | wc -l`）走原审批，同样排除 `;`、`||`、`&`、换行多语句、非无害重定向、变量赋值前缀及包装器）
- **`git status` 精确限定**：仅在**初始工作区根目录**（初始在根，或经纯 `&&` 链 `cd` 回根）允许 4 组精确 argv：`git status`、`git status --short`、`git status --porcelain`、`git status --short --branch`。系统信任工作区已有的 `.git/config`；其他所有 git 子命令（`log`、`diff`、`show`、`branch`、`rev-parse` 等）、额外选项、全局参数或非工作区根目录执行，一律走原审批。
- **保持原权限顺序与路径预检，非 POSIX 走原审批**：不改动 `evaluatePermission` 与 scheduler 预检顺序（deny、分析不完整、denylist、`external_directory_shell`、`sensitive_path`、会话 allow 全部不动）；仅限 POSIX（`bash` / `zsh` / `sh`）狭义写法，PowerShell、`cmd` 等其余 shell 维持原审批。
- **通用 shell 审批提示**：未命中狭义白名单的非危险命令统一改用通用英文提示 `This command needs your approval.`（对应“此命令需要你的批准”）；危险命令与分析不完整提示保持不变。
- **历史模拟非新预期**：[01 §1.4](01-problem-analysis-and-current-state.md#14-常见写法被误判放行开关打开了也几乎没用) 的 324 条历史模拟仅保留作背景参考，不作为新方案指标或预期。
- **不做项不变**：bash 工具本身的能力优化仍不做。
- **最终审核**：由 **Opus high** 和 **Neon high** 执行最终审核。

## 历史讨论归档（2026-11-27 早期版本，已由上方最新确认取代）

以下记录保留背景脉络，其中与最新定稿冲突的宽白名单、git 多子命令放行、审批文案与单一模型审核结论均已作废：

- 早期曾计划把解析器误判修复（现已在 `6f4f0483` 落地）连同大范围白名单扩充（`stat`、`du`、`file`、`which`、`basename`、`dirname`、`realpath`、`cut`、`tr`、`sort`、`uniq`、`true` 及 `find`/`rg`/`grep` 漏洞修补）和 `git log`/`diff`/`show`/`rev-parse`/`branch` 一并纳入（原 P1–P12），并只按单一模型审核。
- 经安全边界复核与用户最终拍板，放弃“宽白名单 + 黑名单堵漏 + 通用参数解析”的复杂路线，改采上方最小狭义白名单方案。
