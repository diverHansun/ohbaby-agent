# 2. 方案与改动面

默认权限下，只对能完整分析的 POSIX 常见查看写法免去命令级审批。以下范围取代早期的宽白名单方案。[现状分析](01-problem-analysis-and-current-state.md) 里的比例是历史模拟，不作为验收目标。

## 放行范围

| 命令 | 允许的精确 argv | 典型走原审批的反例 | 路径预检 |
| --- | --- | --- | --- |
| `pwd` | `["pwd"]` | `pwd -P`、`pwd -L`、`pwd foo` | 无路径参数 |
| `ls` | `["ls"]`、`["ls", <目录>]`、`["ls", "-la"]`、`["ls", "-la", <目录>]` | `ls -l`、`ls -a`、`ls -al`、`ls -R`、`ls a b`、`ls -la a b`、`ls src -la` | 已在 `PATH_COMMANDS`，`<目录>` 进预检 |
| `cat` | `["cat", <文件>]` | `cat`、`cat -n a.txt`、`cat a.txt b.txt`、`cat -` | 已在 `PATH_COMMANDS`，`<文件>` 进预检 |
| `head` | `["head", "-n", <纯数字>, <文件>]` | `head a.txt`、`head -n10 a.txt`、`head -20 a.txt`、`head -n 10`、`head -n -5 a.txt`、`head -n 10 a b` | 已在 `PATH_COMMANDS` 且已跳过 `-n` 值，`<文件>` 进预检 |
| `tail` | `["tail", "-n", <纯数字>, <文件>]` | `tail a.txt`、`tail -f app.log`、`tail -n +5 a.txt`、`tail -n 20`、`tail -n 20 a b` | 已在 `PATH_COMMANDS` 且已跳过 `-n` 值，`<文件>` 进预检 |
| `wc` | `["wc", "-l"]`、`["wc", "-l", <文件>]` | `wc a.txt`、`wc -w a.txt`、`wc -l a.txt b.txt`、`wc --files0-from=list.txt`、`wc -l -` | **本轮补进 `PATH_COMMANDS`**，`<文件>` 进预检 |
| `cd`（仅作 `&&` 链前缀） | `["cd", <字面目录>]`，且只能位于纯 `&&` 链中后续允许命令之前（可连续多次 `cd`） | 单独 `cd dir`、`cd`、`cd -`、`cd -P dir`、末尾悬空 `ls && cd dir`、`cd dir; ls`、`cd dir \|\| ls`、`cd dir \| ls` | 已在 `DIRECTORIES`，目标进 `cdTargets` 预检并传播 `cwd` |
| `git status`（仅限初始工作区根） | 仅允许 4 组精确 argv：`["git", "status"]`、`["git", "status", "--short"]`、`["git", "status", "--porcelain"]`、`["git", "status", "--short", "--branch"]`；**且**该命令执行时的 `cwd` 必须确认为初始工作区根目录（含 `cd` 回根） | `git status -s`、`git status -sb`、`git status --porcelain=v2`、`git status --branch --short`、`git status -- src`、`git -c ... status`、`git -C . status`、`git --git-dir=... status`、`git log`、`git diff`、`git show`、`git branch`、`cd sub && git status`、`cd /tmp && git status` | 无文件参数；通过规范化初始工作区根校验锁死仓库范围 |

只接受单条命令和纯 `&&` 链。管道、后台、多语句、赋值前缀、包装器、非字面参数及 PowerShell、cmd 继续走原审批。重定向沿用已验证的 POSIX 空设备输出与文件描述符复制。

## 实现

1. 复用已有解析器对文件描述符、未加引号的家目录和成功 `cd` 链的路径分析。根据原始语法树与精确 argv 判断，保留原有粗粒度风险分类。给 `wc -l <文件>` 补上文件路径预检。
2. 限定 Git 命令执行时的目录为初始工作区根。系统信任该仓库已有的 Git 配置。其他子命令和参数组合按原流程处理。
3. 在原有权限判断的最后一步接入。会话 deny、外部目录确认、敏感路径检查、不可记住的单次确认和 Full access 的优先级沿用现有执行顺序。普通命令的审批提示为 `This command needs your approval.`

本轮沿用登录 shell 和工作区的本机信任前提。验收见 [04](04-test-and-acceptance.md)。
