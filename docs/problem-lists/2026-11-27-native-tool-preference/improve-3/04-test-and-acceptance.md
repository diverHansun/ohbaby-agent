# 4. 测试与验收

对应方案见最新定稿的 [02](02-optimization-plan-and-change-scope.md)。路径相对 `packages/ohbaby-agent/src/`。

> **说明**：[01 §1.4](01-problem-analysis-and-current-state.md#14-常见写法被误判放行开关打开了也几乎没用) 中的历史模拟数据和 [tool-choice-stats.py](../tool-choice-stats.py) 的历史对比**不是**本轮新预期，也不作为验收指标。

## 4.1 解析器基线回归与新增结构事实单测（Stage 1–2）

在 `shell/analysis/parser.unit.test.ts` 中确认并补充以下用例：

### 已有 POSIX 路径事实回归（`6f4f0483` 已落地）

| 命令 | 期望 |
| --- | --- |
| `ls src 2>/dev/null`、`ls src >/dev/null 2>&1`、`ls src &>/dev/null`、`grep foo src 2>&1`、`echo x >&2` | 分析完整，不记为写文件，`/dev/null` 不在 `pathArgs` 里 |
| `ls src &>out.txt`、`ls src 2>err.log`、`ls >/dev/tty`、`ls >2` | 记为写文件，目标路径保留在 `pathArgs` 里 |
| `cd a && cd b && cat x && ls y` | 分析完整，纯 `&&` 链正确传播 `cwd` |
| `cd /tmp && ls a; ls b`、`cd x 2>/dev/null; cat y`、`cd x; ls a`、`cd x \|\| ls a`、`false && cd x; cat y`、`Set-Location x; Get-Content y` | 后续命令 `cwd` 清空，保持分析不完整 |
| `ls ~ ~/dir "~/dir" a~b` | 未引号的 `~`/`~/` 展开为 `os.homedir()` 下绝对路径，引号内与词中按字面量保留 |
| `cat ~user/a`、`cat ~+/a`、`cat ~\a` | 不展开，保持分析不完整 |

### 新增结构事实单测（Stage 2）

| 命令 | 期望 |
| --- | --- |
| `LD_PRELOAD=./x.so cat a.txt`、`GIT_DIR=./evil.git git status`、`FOO=1 ls` | 标记存在变量赋值前缀 |
| `env FOO=1 ls`、`env GIT_DIR=x git status`、`command ls`、`nohup ls`、`time pwd`、`sudo ls` | 标记经过包装器剥离 |
| `cat a.txt < .env`、`wc -l < .env`、`wc -l <<EOF\nhi\nEOF`、`ls > out.txt`、`ls >/dev/tty` | 标记存在非无害重定向 |
| `ls src 2>/dev/null`、`cat a.txt 2>&1`、`git status 2>/dev/null` | 不标记非无害重定向 |
| `ls; pwd`、`ls\npwd`、`ls &`、`ls \|\| pwd` | 走原审批 |

## 4.2 狭义白名单与路径提取单测（Stage 2）

在狭义白名单单测（如 `shell/readonly-allowlist.unit.test.ts`）以及 `shell/path-args`、`sandbox/preflight` 相关单测中覆盖：

### 允许免审批的正向用例（POSIX：`bash` / `zsh` / `sh`）

| 类别 | 命令 | 期望 |
| --- | --- | --- |
| `pwd` | `pwd` | 命中狭义只读 |
| `ls` | `ls`、`ls src`、`ls -la`、`ls -la src`、`ls src 2>/dev/null`、`ls ~/.ohbaby` | 命中狭义只读（含路径的参数仍正常进预检） |
| `cat` | `cat a.txt`、`cat "my file.txt"`、`cat a.txt 2>&1`、`cat ~/a.txt` | 命中狭义只读（文件路径进预检） |
| `head` / `tail` | `head -n 20 a.txt`、`tail -n 20 a.txt` | 命中狭义只读（文件路径进预检） |
| `wc` | `wc -l`、`wc -l a.txt` | 命中狭义只读（带文件时文件路径进预检） |
| `cd &&` 链 | `cd src && pwd`、`cd src && ls -la`、`cd a && cd b && cat x.txt`、`cd src && head -n 10 a.ts && tail -n 10 a.ts`、`cd src 2>/dev/null && ls` | 命中狭义只读（`cd` 目标进 `cdTargets` 预检，后续路径按跟踪后的 `cwd` 解析） |
| `git status`（初始工作区根） | `git status`、`git status --short`、`git status --porcelain`、`git status --short --branch`、`git status 2>/dev/null` | 命中狭义只读 |
| `cd` 回初始工作区根后的 `git status` | `cd <工作区绝对路径> && git status`、`cd . && git status --short`、`cd sub && cd .. && git status --porcelain` | 规范化 `cwd` 等于规范化初始工作区根，命中狭义只读 |
| POSIX 变体 | `zsh`、`sh` 下上述合法命令 | 命中狭义只读 |

### 必须走原审批的负向用例

| 类别 | 命令 | 期望 |
| --- | --- | --- |
| 通用参数 / 非白名单参数 | `pwd -P`、`ls -l`、`ls -a`、`ls -al`、`ls -R`、`ls a b`、`ls -la a b`、`ls src -la`、`cat`、`cat -n a.txt`、`cat a.txt b.txt`、`cat -`、`head a.txt`、`head -n10 a.txt`、`head -20 a.txt`、`head -n 10`、`head -n -5 a.txt`、`head -n 10 a b`、`tail -f app.log`、`tail -n +5 a.txt`、`tail -n 20`、`tail -n 20 a b`、`wc a.txt`、`wc -w a.txt`、`wc -l a.txt b.txt`、`wc --files0-from=list.txt`、`wc -l -` | 不命中，走原审批 |
| `cd` 误用与非 `&&` 结构 | `cd src`、`cd`、`cd -`、`cd -P src`、`cat a.txt && cd src`、`cd src; ls`、`cd src \|\| ls`、`cd src \| ls`、`cd x 2>/dev/null; ls`、`ls; pwd`、`ls\npwd`、`ls &`、`cat a.txt \| wc -l` | 不命中，走原审批 |
| 不在狭义列表的其他命令 | `grep foo a.txt`、`rg foo`、`find . -name '*.ts'`、`less a.txt`、`more a.txt`、`echo hi`、`stat a.txt`、`du -sh src`、`sort a.txt`、`uniq a.txt`、`sed -n 1,20p a.txt`、`awk '{print $1}' a.txt` | 不命中，走原审批 |
| `git` 非精确 argv / 其他子命令 | `git status -s`、`git status -sb`、`git status --porcelain=v2`、`git status --branch --short`、`git status -- src`、`git -c core.pager=sh status`、`git --config-env=x=y status`、`git --exec-path=/tmp status`、`git --git-dir=fix/evil.git status`、`git --work-tree=. status`、`git -C . status`、`git --no-pager status`、`git log`、`git diff`、`git show HEAD`、`git rev-parse HEAD`、`git branch` | 不命中，走原审批 |
| `git status` 不在初始工作区根 | `cd sub && git status`、`cd fix/evil.git && git status`、`cd /tmp && git status`、`cd sub; git status`；无 `workdir` 上下文时的 `cd /abs/ws && git status` | 不命中（fail-closed），走原审批 |
| 赋值前缀 / 包装器 / 路径命令名 | `LD_PRELOAD=./x.so cat a.txt`、`GIT_DIR=./evil.git git status`、`FOO=1 ls`、`env FOO=1 ls`、`env GIT_DIR=x git status`、`command ls`、`nohup ls`、`time pwd`、`/bin/ls`、`./git status` | 不命中，走原审批 |
| 非无害重定向与动态语法 | `cat a.txt < .env`、`wc -l < .env`、`wc -l <<EOF\nhi\nEOF`、`ls > out.txt`、`ls >/dev/tty`、`ls src/*.ts`、`cat $(echo a.txt)`、`cat ~user/a`、`cat ~\a` | 不命中，走原审批 |
| 非 POSIX shell | `powershell` 下的 `pwd`、`ls`、`cat a.txt`、`Get-ChildItem`、`Get-Content a.txt`、`git status`；`cmd` 下的 `dir`、`type a.txt`、`git status` | 不命中，走原审批 |
| 危险命令 | `rm -rf build`、`ls && rm -rf build`、`sudo ls` | 保持 `dangerous` 分类与原危险提示 |

### `wc` 路径提取与预检单测

| 命令 | 期望 |
| --- | --- |
| `wc -l .env` | `.env` 被提取进 `pathArgs`，命中敏感路径预检 |
| `wc -l ~/.ssh/id_rsa` | 展开后命中 denylist |
| `wc -l ../outside/a.ts` | 命中外部路径预检 |
| `wc -l` | `pathArgs` 为空 |

## 4.3 权限单测（Stage 3）

在 `permission/evaluator.unit.test.ts` 中补充：

| 场景 | 期望 |
| --- | --- |
| `default` 档，POSIX 狭义只读且分析完整 | 放行（`allow`） |
| `default` 档，POSIX 狭义只读但命中会话 `deny` 规则 | 拒绝（`deny`），顺序不变 |
| `default` 档，分析不完整 | 审批（`ask`），`rememberable: false`，保留原提示 |
| `default` 档，非狭义白名单的非危险命令（如 `git log`、`grep foo a.txt`、`ls -R`、`npm test`、PowerShell `git status`） | 审批（`ask`），提示文案为 `This command needs your approval.` |
| `default` 档，`bash-dangerous`（如 `rm -rf foo`、`sudo ls`） | 审批（`ask`），保留原危险提示 |
| `default` 档，`sensitive_path` 不变式与会话 `allow` 规则 | 原顺序与行为不变 |
| `full-access` 档 | 行为不变 |

## 4.4 集成测试（Stage 3）

在 `core/tool-scheduler` 集成测试中补充：

- 工作区内 `pwd`、`ls -la src`、`cat a.txt`、`head -n 10 a.txt`、`tail -n 10 a.txt`、`wc -l a.txt`、`cd src && ls -la`、`git status`、`cd <工作区绝对路径> && git status --short --branch`、`cd sub && cd .. && git status --porcelain`、`ls src 2>/dev/null`：均不弹窗，直接执行。
- `cd sub && git status`、`git log`、`grep foo a.txt`、`ls -R`：触发通用 shell 审批，文案为 `This command needs your approval.`。
- `cat .env`、`wc -l .env`、`cd sub && cat .env`：触发 `sensitive_path` 审批（不可记住）。
- `cat ~/.ssh/id_rsa`、`wc -l ~/.ssh/id_rsa`、`cd ~/.ssh && ls`：被 denylist 拦住。
- `ls ~/.ohbaby`、`cd ../outside && ls`、`wc -l ../outside/a.txt`：只弹一次 `external_directory_shell` 审批；点 Always 后，同目录下再跑狭义只读命令不弹窗。
- 子代理（如 `explore`）里的狭义只读 bash：同样免去命令审批，但仍受原有路径预检约束。

## 4.5 回归测试

```bash
pnpm vitest run packages/ohbaby-agent/src/shell packages/ohbaby-agent/src/permission packages/ohbaby-agent/src/core/tool-scheduler packages/ohbaby-agent/src/sandbox
```

## 4.6 真实环境冒烟（Web & TUI）

在 Web 和 TUI 各跑一遍冒烟检查：

- 狭义白名单里的常见查看命令（如 `ls -la`、`cat`、`head -n 20`、`wc -l`、`cd <工作区根> && git status --short`）不再弹命令审批。
- 越出狭义白名单的命令（如 `git log`、`grep`、`ls -R`、`cd sub && git status`、写命令、带 `||` 或通配符的命令）照旧弹窗。后端普通审批原因为 `This command needs your approval.`。TUI 显示该提示；Web 卡片沿用命令摘要、实际命令和审批按钮。

## 4.7 验收标准

- §4.1–§4.5 全部通过，§4.6 无误放行。
- Stage 2（结构事实、`wc` 路径提取、初始工作区根判定、白名单纯函数）先于 Stage 3（放行接入）完成。
- **最终审核**：由 **Opus high** 和 **Neon high** 完成最终审核，所有审核意见已处理闭环。
- **历史对比非新预期**：不以 01 §1.4 的历史模拟数据或 [tool-choice-stats.py](../tool-choice-stats.py) 的历史比例作为验收门槛。

## 4.8 对抗性审查要点（供 Opus high / Neon high 核对）

- 赋值前缀（`LD_PRELOAD=`、`GIT_DIR=`、`GIT_CONFIG_COUNT=`）、包装器（`env`、`command`、`nohup`、`exec`、`time`、`sudo`）或路径形式命令名（`/bin/ls`、`./git`）能否绕过狭义白名单。
- `wc -l` 及所有带路径参数的白名单命令在相对路径、绝对路径、未引号 `~`、符号链接、`cd` 链组合下，是否全部经过 `denylist`、`sensitive_path` 和 `external_directory_shell` 预检。
- `git status` 在子目录、嵌入裸仓库、外部目录、符号链接、`cd` 后未知 `cwd`、以及缺少 `workdir` 上下文时是否严格 fail-closed。
- `;`、`\n`、`&`、`||`、`<`、`<<`、`>`、`>/dev/tty`、通配符、动态展开，以及 `powershell` / `cmd` 是否 100% 走原审批。
- 审批提示文案是否仅在非危险未放行命令上改为 `This command needs your approval.`，而未误改 `bash-dangerous` 与分析不完整提示。
