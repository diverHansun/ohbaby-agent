# 5. 实施与验收（improve-1）

对应方案见 [02-optimization-plan-and-change-scope.md](02-optimization-plan-and-change-scope.md)，验收口径见 [04-test-and-acceptance.md](04-test-and-acceptance.md)。本轮在分支 `codex/native-tool-preference` 上实施，基线为 `39ab6863`。本次由 Astra 主控复核，Neon high 撰写文案，Opus high 分批审查。

## 5.1 批次验收快照

**本轮功能实现、自动化测试及 CLI 阶段 10 模型实测均已通过**，当前边界如下：

- Stage 0（`~` / `~/` / `~\` 路径展开）独立成提交，权限判断、资源锁与实际读写落到同一路径；默认权限下访问工作区外 `~/` 文件仅弹一次审批即可用 `read` 成功读取，不再因路径报错退回 `bash`。
- 工具描述与主/子代理系统提示词已按 D1–D14 落地并通过 `prompt:generate` / `prompt:check` 校验；Opus high 审查提出的 3 项实质问题均已在 `6d8392d8` 修正。
- 10 模型 CLI 实测覆盖独立请求、常规查看、子代理、外部 `~/` 默认权限和显式 shell 指令出口，行为方向符合预期；**10 模型常规对话在 `full-access` 下运行，仅用于观察工具选择，不能据此验收审批流程**；改前改后属于灵活题目的小样本对比，不做百分比外推。
- **边界与衔接**：最终交叉验证、最终分支合并、Windows 真机 PowerShell 实测及 [tool-choice-stats.py](../tool-choice-stats.py) 的上线后事后统计均未在本轮结论范围内；内置浏览器联合验证（`glob` 排除 `coverage` 后返回 4 项、`grep` 忽略大小写命中 2 处含上下文、`read` 返回标记）属于后续验收。最终 Web/TUI、全量测试、交叉评审和合并记录见 [improve-3/05-implementation-acceptance.md](../improve-3/05-implementation-acceptance.md)。

## 5.2 提交清单与改动面

| 提交 | 内容 | 主要源码与测试（相对路径） |
| --- | --- | --- |
| `cf7169f6` | Stage 0：统一 `~` / `~/` / `~\` 展开（独立提交，可单独回滚） | 新增 `resolveToolPath` 于 [path-canonicalize.ts](../../../../packages/ohbaby-agent/src/utils/path-canonicalize.ts)；四处接入：[lease.ts](../../../../packages/ohbaby-agent/src/sandbox/lease.ts)、[scheduler.ts](../../../../packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts)、[host-local-environment.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts)、[file-access.ts](../../../../packages/ohbaby-agent/src/tools/utils/file-access.ts)；补测：[host-local-environment.unit.test.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.unit.test.ts)、[files.scheduler.integration.test.ts](../../../../packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts) |
| `f8b006b4` | 工具描述、参数说明与主/子代理系统提示词路由改造 | 系统提示词：[primary/base.md](../../../../packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md)、[subagents/base.md](../../../../packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/base.md)、生成物 [templates.generated.ts](../../../../packages/ohbaby-agent/src/core/system-prompt/prompts/templates.generated.ts)；工具描述与 schema：[bash.ts](../../../../packages/ohbaby-agent/src/tools/bash.ts)、[read.ts](../../../../packages/ohbaby-agent/src/tools/read.ts)、[list.ts](../../../../packages/ohbaby-agent/src/tools/list.ts)、[glob.ts](../../../../packages/ohbaby-agent/src/tools/glob.ts)、[grep.ts](../../../../packages/ohbaby-agent/src/tools/grep.ts)、[text-files.ts](../../../../packages/ohbaby-agent/src/tools/utils/text-files.ts)、[edit.ts](../../../../packages/ohbaby-agent/src/tools/edit.ts)、[write.ts](../../../../packages/ohbaby-agent/src/tools/write.ts)；集成测试：[files.scheduler.integration.test.ts](../../../../packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts) |
| `6d8392d8` | Opus high 审查修正：收紧 shell 回退措辞与 `edit` 描述，补沙箱 `~` 与 PowerShell 断言 | [bash.ts](../../../../packages/ohbaby-agent/src/tools/bash.ts)、[edit.ts](../../../../packages/ohbaby-agent/src/tools/edit.ts)、[host-local-environment.unit.test.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.unit.test.ts)、[bash.unit.test.ts](../../../../packages/ohbaby-agent/src/tools/bash.unit.test.ts) |

核对说明：按 02 K12，[explore.md](../../../../packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks/explore.md) 与 [research.md](../../../../packages/ohbaby-agent/src/core/system-prompt/prompts/subagents/tasks/research.md) 与新规则无冲突，保持未改。

## 5.3 自动化回归与代码审查

- **批 1 自动化测试**（对应 `b1-unit.log`）：覆盖 `system-prompt`、`tools`、`sandbox`、`tool-scheduler`、`adapters/ui-runtime`（含 `prompt-assets.unit.test.ts` 生成物一致性校验），**55 个测试文件、619 项通过、2 项跳过**。
- **提交前静态检查**（对应 `b1-commit.log`、`b1-review-commit.log`）：`eslint` 0 errors（285 条既有 warnings），`pnpm typecheck`（`tsc -b`）通过。
- **Opus high 审查与修正**（对应 `b1-opus.log`、`b1-review-test.log`）：
  - Stage 0 审查无阻塞：`~user` 与 `./~` 保持原义，`path.join` 避免 `~//etc` 越界，权限检查与资源锁共用 `resolveToolPath`。
  - 审查指出的 3 项实质问题全部已在 `6d8392d8` 修正：① [bash.ts](../../../../packages/ohbaby-agent/src/tools/bash.ts) 路由标题收紧到文件操作并恢复 D3 出口句，避免与“构建/测试/git 用 bash”矛盾及诱导先试原生工具；② 修正 `.gitignore` 措辞、工具名大小写混淆和 `know exactly which paths they touch` 表述；③ 修正 [edit.ts](../../../../packages/ohbaby-agent/src/tools/edit.ts) 对唯一匹配失败和预览省略的描述。
  - 同步补齐沙箱 `lease` 解析 `~` 与字面目录 `./~/note.txt` 的单测，以及 PowerShell 描述包含 `Get-Content -> read` 的断言；定向回归 **2 个测试文件、53 项通过**。

## 5.4 真实模型实测（改前 vs 改后）

模型清单来自 [tests/models-4-tests.md](../../../../tests/models-4-tests.md)（10 个模型）。改前基线在 `39ab6863` 上运行，改后实测在 `f8b006b4` 上运行（`6d8392d8` 为审查措辞收紧与补测，未单独重跑全套 10 模型批 1 题目；批 2 已在 `6d8392d8` 上完成 10 模型实测）。

### 改前基线（`39ab6863`）

| 项目 | 实测结果 |
| --- | --- |
| 独立工具请求 | 10/10 产生工具调用 |
| 正式 CLI 10 模型首轮（`full-access`） | 10 个模型均调用工具，9 个完成回答；`gpt-6.1-sol` 启动后台 `explore` 子代理时 CLI 退出。Qwen 在读取之外用 bash 打包运行了 `ls -la && ... od -c ...`（带 `echo` 分隔符） |
| 子代理补测（持续后端） | `explore` 调用 `glob` + `read`，`generic` 调用 `read`，父代理收到两项正确值 |
| 工作区外 `~/` 路径（`gpt-6.1-terra`） | `read` 原样传入 `~/...` 报错，模型随后改用 `bash` 执行 `cat` 读取 |

**改前测试隔离事故与处置**：改前首轮忽略了 `OHBABY_HOME` 仅隔离配置目录、不隔离 macOS 默认 SQLite 路径，导致 10 个测试主会话和 1 个 `explore` 子会话写入了用户本机数据库。事后已通过 `archiveSession` 归档全部 10 个主会话；该 `explore` 子会话仍挂在已归档的父会话下（产品目前不支持单独归档子会话）。未删除任何用户历史，也未改动默认模型。后续测试会话均显式指定 `OHBABY_DB_PATH` 和 `XDG_DATA_HOME` 隔离数据库与应用配置（旧批次未隔离 OS HOME，不称完全隔离）。

### 改后实测（`f8b006b4`）

| 场景 | 实测结果 |
| --- | --- |
| 独立工具请求 | 10/10 产生工具调用 |
| 正式 CLI 10 模型常规任务（`full-access`） | 10/10 回答正确。Qwen 从改前打包 `ls`/`od`/`echo` 查看变为原生 `list`/`glob`/`read`，仅在运行脚本时调用 `bash`；OpenAI Astra 用 `read` 后用 `bash` 跑 `node check.cjs`；ZenMux Sonnet 用 `list`/`read` 读取，另跑了一次 `node check.cjs && wc -c ...` 复核；DeepSeek Pro 在“合并报告”任务中主动用 `write` 写入 `report.txt`（仅在临时测试工作区，行为与改前类似）；其余 6 个模型查看文件均用原生工具（部分同时调用 `skill`） |
| 外部 `~/` 路径（`gpt-6.1-terra`，**默认权限**） | 读取同一个用户 HOME 下的测试文件，仅弹出一次外部路径审批，批准后 `read` 直接成功，全程无 `bash` |
| 子代理复测（持续后端） | `explore` 用 `glob` + `read`，`generic` 用 `read`，无查看类 `bash`，父代理汇总两项正确值 |
| 显式要求 shell 的出口验证（`gpt-5.6-luna`） | 用户明确指定用 `cat` + `wc` 时，模型按出口句调用 `bash` 并返回 31 字节，未出现矫枉过正 |

## 5.5 偏差与后续观察项

- **改动面增量（已登记采纳）**：`f8b006b4` 额外更新了 [edit.ts](../../../../packages/ohbaby-agent/src/tools/edit.ts) 和 [write.ts](../../../../packages/ohbaby-agent/src/tools/write.ts) 的首句引导（不在 02 §2.9 清单内），经 Opus 审查并由 `6d8392d8` 修正 `edit.ts` 描述后予以保留。
- **长度预算**：经 `6d8392d8` 修正后，`bash.ts` 路由段约 1086 字符（较 D9“约 1000 字符”高约 9%），其余工具描述与系统提示词均在预算内（主代理系统提示词净减 57 字符）。
- **暂不处理的低优先级项**（来自 Opus 审查备忘）：`~\` 在 macOS/Linux 上按 D13 同步展开；[text-files.ts](../../../../packages/ohbaby-agent/src/tools/utils/text-files.ts) 等运行时报错里仍残留个别大写工具名（如 `Use Bash`）；PowerShell 下路由首行的 `| grep` 示例与方言提示存在轻微张力；[host-local-environment.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts) 的 import 排序风格。

### 小上下文模型回归

全量测试发现，16K 窗口预留 4,096 个输出 token 后，一条普通请求因工具描述过长而在发出前失败。Neon 精简了八个工具源码文件中的英文说明（`a171a9bb`）。相同工作目录下，原始基线、修复前和修复后的输入估算分别为 10,003、11,270、10,478，输入预算为 10,880。宿主机复跑原始集成用例成功，17 个相关文件共 231 项通过，提示词生成物一致性检查通过。

## 5.6 本机临时记录（未入库）

以下文件仅存在于本机工作区临时目录与 `/tmp`，不作为受版本控制的永久链接，供本机复盘核对：

- 自动化测试与审查日志（`.scratch/native-preference/`）：`b1-unit.log`、`b1-commit.log`、`b1-opus.log`、`b1-review-test.log`、`b1-review-commit.log`
- 真实模型实测快照（`/tmp/ohbaby-native-baseline.PG1oRf/`）：`requests.json`、`first-results.json`、`first-home.json`、`child-baseline-tools.json`、`after1-runs/requests.json`、`after1-runs/e2e-results.json`、`after1-home.json`、`after1-children.json`
