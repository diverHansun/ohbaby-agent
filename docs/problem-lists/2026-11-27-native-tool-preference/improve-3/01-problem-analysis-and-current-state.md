# 1. 现状与问题分析

代码锚点以立项当日（2026-11-27）分析时的 `main`（`39ab6863`）为准，路径相对 `packages/ohbaby-agent/src/`。

> **状态与非指标说明**：§1.4 提到的三项 POSIX 解析器路径事实（`/dev/null` 输出与 fd 复制、未引号家目录展开、纯 `&&` 链 `cwd` 与容器级清空）已在 `6f4f0483` 落地。本节及 §1.4 的 324 条历史模拟数据仅保留为立项背景，**不作为**最新狭义白名单方案（见 [00](00-discussion.md)、[02](02-optimization-plan-and-change-scope.md)）的覆盖指标或新预期。

## 1.1 一条 bash 命令的审批顺序

```text
scheduler 预检
  ├─ 命令里每个工作区外路径：external_directory_shell 审批（Always 会把目录登记为可信根）
  └─ 每个敏感路径：sensitive_path 审批
evaluatePermission（permission/evaluator.ts:112 起）
  1. 会话 deny 规则 → 直接拒绝
  2. full-access → 放行
  3. bash 且静态分析不完整 → 审批，且不能记住
  4. 敏感路径等不变式检查
  5. 会话 allow 规则（用户之前点过 Always 的命令前缀）
  6. 按分类兜底（evaluateLevelFallback，L71 起）
```

第 6 步里，`bash-readonly` 和 `bash-mutating` 返回的是同一句"Shell commands need your approval unless Full access is on."（L100–102）。原生只读工具在这一步直接放行（L80）。

权限只有 `default` 和 `full-access` 两档（`permission/types.ts` 的 `Level`）。

## 1.2 只读是怎么判断的

`shell/command-classifier.ts`：

- `classifyShellCommand`：没有分析结果或命令为空，算 mutating；分析不完整，算 mutating；否则取每条子命令分类的最大值。
- `classifyShellCommandDetail`：
  - `READONLY_ROOTS`：`cat`、`dir`、`find`、`get-childitem`、`get-content`、`grep`、`head`、`less`、`ls`、`more`、`pwd`、`rg`、`tail`、`type`。`echo`、`write-host` 也算只读。
  - `find` 带 `-delete`、`-exec`、`-execdir`、`-ok`、`-okdir` 算 mutating。
  - 有重定向写文件（`writesFiles`）算 mutating。
  - `git` 只有 `status`、`log`、`diff` 算只读。
  - 不认识的命令一律算 mutating，包括 `wc`、`stat`、`du`、`sort`、`uniq`、`sed`、`awk`、`cd`。

## 1.3 现在的分类有几处隐患

现在只读和 mutating 都要审批，这些隐患没有后果。一旦只读免审批，它们就变成了真实的漏洞：

| 命令 | 问题 |
| --- | --- |
| `find -fprint 文件`、`-fprint0`、`-fprintf`、`-fls` | 会写文件，但不在 `find` 的 mutating 参数里 |
| `rg --pre 命令` | 会对每个文件执行指定的预处理程序 |
| `git diff --output=文件`、`git log --output=文件` | 会写文件 |
| `git -c 配置=值 status` | 可以通过 `core.fsmonitor`、`core.pager` 之类的配置执行任意命令 |
| `git diff --ext-diff`、仓库里配置的 diff 驱动或 textconv | 会执行外部程序 |
| `less`、`more` | 交互式分页，在没有终端的环境里可能挂住（不是安全问题，靠超时兜底） |
| `LD_PRELOAD=./x.so cat a`、`GIT_EXTERNAL_DIFF=./x.sh git diff`、`env GIT_CONFIG_COUNT=1 git status`、`RIPGREP_CONFIG_PATH=.rgrc rg foo` | 解析器拆词时丢掉了 `VAR=x` 前缀和 `env NAME=`（`parser.ts` 约 L173–176），分类器只看到后面的命令；这些变量能让命令加载或执行任意程序 |
| `rg --hostname-bin=./x.sh foo` | 会执行指定的程序 |
| `git --git-dir=fix/evil.git log` | 读的是工作区里嵌入的裸仓库，它的 `config` 是随 `clone` 带下来的普通文件，可以配置外部程序 |
| `git log -p -- .env`、`git show HEAD:.env` | 能读出敏感文件内容，但路径提取不到（`--` 之后和 `<提交>:<路径>` 都没处理），敏感路径预检看不到 |

以上 `find -fprint`、`rg --pre`、`git log --output`、`git -c` 四条已用真实分析器跑过（2026-11-27，`tsx` 直接调用 `analyzeShellCommand` + `classifyShellCommand`），现在都判成 readonly。赋值前缀、`--hostname-bin`、`--git-dir` 和 git 路径提取这几条是方案定稿后子代理审查时同样实测发现的。其余几条实施时用单测逐条确认。

## 1.4 常见写法被误判，放行开关打开了也几乎没用

用同样的办法跑了几条常见写法，结果如下：

| 命令 | 现在的结果 | 原因 |
| --- | --- | --- |
| `ls src 2>/dev/null` | mutating；预检还把 `/dev/null` 当成工作区外路径，多弹一次外部路径审批 | 解析器只要看到 `N>`、`>&` 就记为写文件（`shell/analysis/parser.ts` 约 L392），重定向目标也会进 `pathArgs` |
| `grep foo src 2>&1` | mutating | 同上，`2>&1` 只是合并输出，不写文件 |
| `cd /tmp && ls a` | mutating | `cd` 不在白名单，按"不认识的命令"处理 |
| `cd /tmp && ls a && ls b` | 分析不完整 | `a && b && c` 解析成左嵌套的 `list`，内层 `list` 结束时把外层的 cwd 清空（`parser.ts` 的 `list` 分支，`if (nested.cwd !== context.cwd) context.cwd = undefined`），后面的相对路径就成了"cwd 未知" |
| `cd x; ls a` | 分析不完整 | 这是有意的：`cd` 失败后 `;` 仍会继续执行，cwd 确实不可知。`parser.unit.test.ts` 有用例覆盖 |
| `cd x 2>/dev/null; cat y` | 分析完整，`cat` 的 cwd 记成 `x`（**错**） | 容器循环只在子节点类型是 `command` 时才清空 cwd（`parser.ts` 约 L484），带重定向的 `cd` 是 `redirected_statement`，漏过去了。`cd` 失败时 `cat` 其实在原目录跑，预检按错的目录解析路径 |
| `ls ~/.ohbaby` | 分析不完整 | `literal()` 遇到以 `~` 开头的词就返回 undefined（`parser.ts` 约 L142）。预检也不会补救：`resolveAnalyzedPath` 调 `sandbox/paths.ts` 时传的是 `literal: true`，不展开 `~`。真正展开 `~` 的是执行时的 bash 自己 |
| `cat a \|\| true` | 分析不完整 | `\|\|` 一律算不完整；`true` 也不在白名单 |
| `ls src/*.ts` | 分析不完整 | 通配符路径预检无法解析，这是有意的 |

再把会话库里全部 956 条 bash 命令跑一遍，只看其中 324 条"只做查看"的（定义同 [tool-choice-stats.py](../tool-choice-stats.py)），逐项累加修正后能免审批的条数（**历史模拟保留，明确非指标、非新预期**：以下数字对应早期宽白名单讨论，最新定稿已收紧为 [02](02-optimization-plan-and-change-scope.md) 中的 POSIX 狭义白名单，不再以这些历史对比占比作为目标或验收标准）：

| 累加的修正 | 免审批条数 | 占比 |
| --- | --- | --- |
| 只把 `bash-readonly` 改成放行 | 7 | 2% |
| + `/dev/null` 重定向和 `2>&1` 这类合并输出不算写文件 | 13 | 4% |
| + 解析器展开 `~` | 20 | 6% |
| + `cd` 算只读，并修好纯 `&&` 链里的 cwd 跟踪 | 112 | 35% |
| + 扩白名单（`wc`、`stat`、`du`、`file`、`which`、`basename`、`dirname`、`realpath`、`cut`、`tr`、`sort`、`uniq`、`true`） | 141 | 44% |
| + `sed -n`、`tree`、`nl`、`printf`、`date` | 210 | 65% |

几点说明：

- 324 条里有 221 条以 `cd <绝对路径> && …` 开头，这是模型最常见的写法，所以 `cd` 和 `&&` 链是最大的一块。
- `/dev/null`、`~`、`&&` 链三项是模拟出来的：前两项用文本替换去掉重定向、把 `~` 换成绝对路径，第三项去掉开头的 `cd <绝对路径> &&`。真实实现的结果可能差几条。
- 剩下免不了审批的主要是：通配符 26 条、`||` 25 条（典型是 `cat x 2>/dev/null || echo "none"`）、变量和 `for` 循环约 40 条。这些保持审批是对的，静态分析确实看不清。
- improve-1 会让查看类 bash 本身变少。本轮是兜底：剩下的、确实无害的命令别再让用户点。

结论：只改 evaluator 一个分支，用户几乎感觉不到变化。真正起作用的是解析器和分类器里这几处误判。

## 1.5 能不能免审批，取决于静态分析靠不靠谱

- ohbaby 没有系统级沙箱（参见 [bash-double-approval](../../2026-11-23-bash-double-approval/README.md)），免审批完全靠命令文本的静态分析。
- 分析不完整时第 3 步已经会要审批，这是安全底线，本轮不动。
- 已核对：命令替换和子 shell 记为不完整（"Nested shell context is incomplete"），变量展开记为不完整，`xargs` 和 `bash`/`sh` 等解释器算 mutating，`eval` 不在白名单所以也算 mutating。

## 1.6 和其他权限机制的关系

- 外部路径和敏感路径的预检在 evaluator 之前，免审批不会绕过它们。用户第一次用 bash 看工作区外的目录时，仍会弹外部路径审批；点 Always 后，这个目录下的只读命令就不再弹窗。
- `agents/builtin/build.ts` 写了 `bash: { "*": "allow" }`，`explore.ts`、`generic.ts` 写了 `bash: { "*": "ask" }`，但 evaluator 不读取这些配置，它们现在不生效。

## 1.7 bash 能力本身

没发现 bash 工具本身的能力缺口导致问题。现有的超时、后台任务、输出截断都够用。按用户"没必要就不做"的要求，本轮不改 bash 能力（[02 D9](02-optimization-plan-and-change-scope.md#23-设计决策表)）。
