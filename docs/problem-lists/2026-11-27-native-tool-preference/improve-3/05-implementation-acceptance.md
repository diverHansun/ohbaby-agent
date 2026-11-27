# 5. 实现与验收记录

对应定稿方案见 [02 方案](02-optimization-plan-and-change-scope.md)，验收口径见 [04 验收](04-test-and-acceptance.md)。本文汇总当前落地的放行边界、源码改动位置与已核验实测结果，供维护者快速复核。

## 1. 结论与放行边界

- **批次提交**：`6f4f0483` 修复解析器的路径与重定向分析，`e851945d` 识别符合条件的精确命令，`1bcf4eb4` 在路径预检和会话规则检查后接通放行。随后针对审查发现的语法边界做了两轮收紧：`169412a2` 拦住目录切换后非单纯 `cd ..` 的相对父路径、无命令主体重定向和命令名规范化不一致的写法；`1c0b0cef` 进一步把跨语句目录切换后的不确定 `cwd`（连同既有的子 shell 隔离边界）、zsh 动态参数展开、`sh` 下 `&>`/`&>>` 组合重定向以及无主体重定向统一标为分析不完整，回退一次性审批。
- **窄方案口径**：严格落地用户最终批准的 **POSIX 精确 argv 窄方案**。仅在 `default` 权限档、语法分析完整且原始 AST 为单条命令或纯 `&&` 链时自动放行，允许集合限定为 `pwd`、`ls`/`ls -la`（可带单目录）、`cat <文件>`、`head`/`tail -n <纯数字> <文件>`、`wc -l [<文件>]`、作前缀的 `cd <字面目录> &&`，以及仅限初始工作区根目录执行的 4 组 `git status`（完整定义与反例见 [02](02-optimization-plan-and-change-scope.md)）。
- **显式排除与审批文案**：在原始语法树与解析器层面排除变量赋值前缀、包装器（`env`/`command`/`nohup`/`exec`/`time`/`sudo`）、路径或变形命令名、通配符或动态展开（含 zsh 下双引号/无引号里的 `$` 与反引号展开）、含 `/..` 路径段与非初始目录下除 `cd ..` 外的相对父路径、`\r`/`\`、`sh` 下 `&>`/`&>>`、无主体重定向、非 `/dev/null` 或 fd 复制之外的重定向，以及 PowerShell 与 `cmd`。管道（含 `cat fixture.txt | wc -l`）、`git status -s`、其他 git 子命令和早期放弃的宽白名单，均按设计继续走原审批，并非实现缺失。
- **权限顺序保持不变**：放行只接入 `evaluateLevelFallback` 的最后一步；会话 `deny`、`full-access`、分析不完整（不可记住）、`sensitive_path`、会话 `allow`、`bash-dangerous` 以及 `denylist`/`external_directory_shell` 预检顺序均未调整。落到命令级审批兜底分支时提示 `This command needs your approval.`。

## 2. 源码改动位置

- 新增 `packages/ohbaby-agent/src/shell/analysis/default-approval.ts`：实现原始 AST 节点检查与精确 argv、路径预检覆盖及初始工作区根判定。
- 修改核心源码：`packages/ohbaby-agent/src/shell/analysis/parser.ts`、`types.ts`、`shell/path-args.ts`（补入 `wc` 进 `PATH_COMMANDS`）、`sandbox/preflight.ts`（`169412a2` 去掉向 `analyzeShellCommand` 额外传入的 `workdir`）、`tools/bash.ts`（向解析器传入实际工作目录）及 `permission/evaluator.ts`。
- 更新配套测试：权限评估、解析器、沙箱预检与工具调度相关的单元和集成测试文件（其中 `169412a2` 补充 `analysis-permission.integration.test.ts`，`1c0b0cef` 补充 `parser.unit.test.ts`）。

## 3. 已核验测试与实测统计

- **自动化测试**：108 项定向测试全部通过；解析器、权限、沙箱预检及 shell 集成范围 **530 通过、8 跳过**（证据见 `.scratch/native-preference/b3-unit.log`）。
- **10 模型隔离冒烟（`default` 权限）**：
  - 校验底版为 `84c31de3` + 本轮放行主体，该轮使用的冻结产物 sha256 为 `b009ba745ff21bc73403b4d2a68a876e229e9c35192555803653dad866ffa87d`；各模型的 OS `HOME`、`OHBABY_HOME`、DB、XDG、storage 与 workspace 彼此隔离。
  - 初次执行有 8 个因外部构建重写 `dist` 遇到 `parser/WASM could not load`，冻结产物后全部重跑，**10/10 工具调用 `completed`、CLI `exit 0`**。
  - 典型实测命令覆盖 `pwd`、`ls -la nested`、`cat fixture.txt`、`head -n 2`/`tail -n 1`、`wc -l nested/one.txt`、`cd nested && cat one.txt` 以及 `git status`（`--short`、`--porcelain`、`--short --branch`）；明细见 `/tmp/ohbaby-native-baseline.PG1oRf/after3-runs/isolated-results.json`，只认可其中各模型各自跑过的单条实测命令，不能推论所有模型覆盖了每个场景。
- **真实 TUI 核验（`deepseek-flash`，`auto/default`）**：证据见 `/tmp/ohbaby-native-tui.cQp0uc/final-*.txt`。
  - 同一 `cat fixture.txt` 基线需审批，改后自动执行并返回随机值；`touch written.txt` 弹出新文案，Enter 前文件不存在，`Allow once` 后文件落盘。
  - 外部目录 `cat` 首次只触发 `external_directory_shell`，选 `Always` 后读取成功，随后读取同目录另一随机文件免审批。
  - 管道 `cat fixture.txt | wc -l` 仍触发审批，Esc 后为 `rejected`；纯假数据 `.env.fixture` 触发 `sensitive_path`，仅提供 `Allow once` / `Reject`，Esc 后为 `rejected`。
  - 子代理补证：父代理派 `explore` 子代理用 `bash` 读取新随机文件，子代理继承 `default` 权限，记录 `cat child.txt` 为 `completed` 并返回 `child-random-WK87`，最终主代理收到并回复，整个过程没有审批（`/tmp/ohbaby-native-tui.cQp0uc/final-explore-result.txt`）。
- **内置浏览器目视核验（主代理亲测）**：`glob` 排除 `coverage` 后余 4 项；`grep` 命中两处大小写匹配并带前后各 1 行上下文；`read` 取到测试标记；首条 `git status --short --branch` 自动放行，第二条 `git status -s` 需点 `Allow once` 后完成（exit 0）。
- **历史库 324 条静态回放**：该样本按相同截止时间离线重建，原始 324 条的 ID 没有留存；按窄方案静态筛出 **8 条候选**（`5 cat` + `3 ls`）。所有历史命令均未实际执行，不能把 `8/324` 写成真实免审批率或用户等待减少百分比。

### 精简文案后的复测

在 `a171a9bb` 的冻结产物上重新运行十个真实模型。十个模型都完成了任务，查看文件均使用原生工具。Terra 通过一次外部路径确认读取 `~/`，Qwen 用原生工具查看文件、用 bash 执行校验脚本，Sol 通过两个子代理取得正确结果。Astra 直接传 grep 上下文参数，DeepSeek Flash 和 GLM 先 grep 再 read。Sonnet 最初将两个扩展名用逗号拼成一个 include，之后自行修正，得到正确的两个文件。逐模型参数及输出保存在本机临时目录 `/tmp/ohbaby-native-baseline.PG1oRf/final-runs/results.json`。

同一产物在内置浏览器中再次验证。默认 glob 返回 4 个文件，开启 `include_ignored` 后多出 `coverage/mark.ts`。grep 找到两行大小写不同的标记。外部家目录夹具只弹一次审批，允许后 read 成功。`git status --porcelain` 直接返回；`git status --porcelain=v2` 弹窗，点 Reject 后工具卡显示 rejected，模型结束会话且未重试。

### 语法与上下文边界收紧及回归（`169412a2`、`1c0b0cef`）

针对复杂 shell 写法下的路径归属与跨方言差异，这两次提交补齐了四类边界修复：

- **跨语句和子 shell 的工作目录**。`169412a2` 收紧了切换目录后对相对父路径的判断。例如，`cd sub && cd ../other && ls` 需要审批。`1c0b0cef` 处理了分号或换行前的条件链。对于 `cd a && false && cd ..; cat file`，前段可能短路，后续 `cat` 的工作目录无法确定，解析器将它标为未知，要求一次性审批。子 shell 内的目录变化只影响该子 shell，外层命令仍从自己的工作目录解析路径。
- **zsh 动态展开**：`1c0b0cef` 将字面量解码函数 `literal` 改为按 `ShellKind` 分流。由于解析器底层复用 Bash 语法树，无法覆盖全部 zsh 特有参数展开，因此在 `zsh` 下只要 `word` 或 `string` 节点包含 `$` 或反引号（如 `cat "$=FIXTURE"`、`cat "$~FIXTURE"`），就不再当作确定字面量，直接降级为分析不完整并走一次性审批；而单引号字面量（如 `cat '$FIXTURE'`）由 `raw_string` 分支按字面保留，仍准确记录 `pathArgs: ["$FIXTURE"]` 并正常放行。
- **`sh` 组合重定向**：`1c0b0cef` 去掉了原先对整个命令串粗略查找 `&>` 的写法，改为在解析每个重定向节点时精确检查；当 `shellKind === "sh"` 且重定向操作符为 `&>` 或 `&>>`（如 `ls &>/dev/null`）时，记录不可移植原因并标为分析不完整（`completeness: "incomplete"`、`defaultApproved: false`），不再当成可忽略的 `/dev/null` 重定向处理。
- **无主体重定向**：`169412a2` 已在 `isDefaultApprovalNode` 中拦住缺少命令主体的 `redirected_statement`（如 `ls && >/dev/null`）；`1c0b0cef` 进一步在 `parser.ts` 中对无 `body` 的 `redirected_statement` 直接写入 `"Redirection without a command is incomplete."`，使 `pwd && >/dev/null` 这类命令不仅不免审批，还会因分析不完整而强制走一次性审批，避免被会话规则误记住。
- **回归测试结果**：`1c0b0cef` 落地后复跑解析器、权限评估、沙箱预检与 shell 工具集成套件，**14 个测试文件、257 项测试全部通过**。详见本地日志 `.scratch/native-preference/cross-fixes-tests.log`。

### 最终候选 `1c0b0cef` 的验证结果

- **双模型交叉审查**。Opus 5.5 high 与 Gemini 4 Neon high 分别复核上述四处解析修复，均确认没有阻碍合并的问题。本地审查记录为 `.scratch/native-preference/cross-opus-verified.log` 与 `.scratch/native-preference/cross-neon-verified.log`。
- **内置浏览器实测**。最终候选的冻结产物在 macOS 上使用 `/bin/zsh`。默认权限下，`git status --short` 自动成功（exit 0）。随后以 zsh 动态展开读取工作区的 `note.txt`，审批弹窗只有 Reject 与 Allow once。点击 Reject 后，工具卡显示 `bash · rejected`，模型正常结束，没有重试。
- **全量测试**。Vitest 汇总了 779 个测试文件（769 个通过，10 个跳过），其中 9,299 项通过，28 项跳过，耗时 266.33 秒，退出码为 0。`pnpm build` 与 `tsc -b` 均通过，lint 报告 0 个错误、285 条警告。全量测试结果见本地日志 `.scratch/native-preference/verified-full-tests.log`。

## 4. 风险边界影响与剩余限制

- **对风险边界的实际影响**：以原始 AST 加精确 argv 的正向放行替代宽白名单与黑名单堵漏，收敛了默认免审批的暴露面；`wc` 补入 `PATH_COMMANDS` 且放行要求文件操作数已进入 `pathArgs`，配合拒绝 `/..` 路径段、`git status` 初始工作区根校验以及 `169412a2` / `1c0b0cef` 对跨语句 `cwd`、zsh 动态展开、`sh` 组合重定向与无主体重定向的不完整降级，使放行命令继续处于既有 `denylist`、`sensitive_path` 和 `external_directory_shell` 约束之下。
- **剩余限制**：仍沿用对本机登录 shell 与当前工作区已有 `.git/config` 的信任前提；窄集合有意不覆盖管道、多文件、常见短参数与非 POSIX shell，同时对含 `\r`、`\`、`/..`、`sh` 下 `&>`/`&>>`、无主体重定向或 zsh 潜在动态展开的写法保守回退原审批。
- **交叉审查记录的运行边界**。沿用登录 shell 对 `PATH`、`CDPATH`、alias 的信任前提，`git status` 可能短时持有 `index.lock`。大工作区的 glob `prefix/**` 和大量匹配时的 grep `files` / `count` 可能触及输出上限，读取结果时要留意不完整提示。
