# 1. 现状与问题分析

本节只记录现状和原因，方案见 [02](02-optimization-plan-and-change-scope.md)。代码锚点以 2026-11-27 的 `main`（`39ab6863`）为准。

## 1.1 现象：真实会话数据

数据来自本机 `~/Library/Application Support/ohbaby/ohbaby.db`，时间范围是 2026-06-23 到 2026-11-27，共 4088 次工具调用。

| 工具 | 次数 |
| --- | --- |
| bash | 956 |
| read | 327 |
| glob | 76 |
| list | 65 |
| grep | 39 |

用 [tool-choice-stats.py](../tool-choice-stats.py) 按模型统计"只做查看的 bash"（只含 `cat`、`head`、`tail`、`sed -n`、`ls`、`find`、`grep`、`rg`、`wc`、`tree`、`nl`，没有构建、测试、网络、写入）：

| 时间段 | 模型 | 原生工具 | 只做查看的 bash | bash 占查看操作的比例 |
| --- | --- | --- | --- | --- |
| 2026-10 | deepseek/deepseek-v4.1-flash | 303 | 33 | 10% |
| 2026-11 | deepseek/deepseek-v4.1-flash | 86 | 209 | 71% |
| 2026-11 | deepseek-v4.1-flash | 14 | 67 | 83% |
| 2026-11 | gpt-6.1-terra | 0 | 1 | 一次会话里 73 次 bash，其中 71 次是 `python3` 脚本处理 xlsx 表格（read 读不了），只有 1 次是查看 |

脚本不把 `2>/dev/null`、`2>&1` 当成写文件（2026-11-27 修正过一次，之前的版本把这类查看命令漏算进了"其他 bash"）。

按角色拆开看（`--group agent`，全部时间），差别很大：

| 角色 | 原生工具 | 只做查看的 bash | bash 占查看操作的比例 |
| --- | --- | --- | --- |
| build（主代理） | 140 | 178 | 56% |
| explore（子代理） | 239 | 17 | 7% |
| generic（子代理） | 50 | 85 | 63% |
| research（子代理） | 2 | 31 | 94% |
| default（主代理） | 76 | 13 | 15% |

explore 子代理的任务提示里写了"先用 glob/grep 定位"，而且限定只读，表现最好。generic 子代理的任务提示（`prompts/subagents/tasks/generic.md`）一句工具规则都没有，子代理 base 也没有，它的 bash 查看比例在子代理里最高（research 除外）。这和缺少工具规则对得上，但两个角色接的任务也不一样，不能全算到提示词头上。research 子代理的 bash 大多是 `curl` 和 `python3` 抓网页、解析 HTML（323 次其他 bash），查看类调用一共只有 33 次，参考价值有限。

几个要注意的地方：

- **10 月到 11 月的突变不能归到某一次代码改动上。** 10 月有一个测试子代理会话一口气调了 204 次原生工具，11 月的任务多是跨目录验收，任务类型差别很大。7 月 `bcd6492b` 删掉的 `<tool_guidance>` 只是把各工具描述再复读一遍，里面没有路由规则，也不是原因。
- **常见的一种写法是用一条 bash 打包多个查询**，比如 `echo "=== X ===" && ls && cat package.json && grep ...`。模型是在省回合数。
- **不少 bash 查看的是工作区外的路径**，比如 `~/.ohbaby/sessions/.../scratch`、`/Users/.../Hansun-skills`、`~/.codex/plugins`。
- 原生工具 11 月几乎没有报错（read 2 次、grep 1 次），所以不是原生工具失败后才退回 bash。

## 1.2 链路检查：没有 bug

- 内置工具在 `packages/ohbaby-agent/src/tools/builtin.ts` 的 `createBuiltinTools` 里注册，顺序是 read、list、glob、grep、write、edit、todo、web、bash、task。
- OpenAI 兼容接口（`packages/ohbaby-llm/src/providers/openai-compatible.ts:95`）、Responses 接口和 Anthropic 接口都会原样传递 `description` 和参数 schema。

所以模型确实拿到了这些工具，问题在于拿到的是什么内容。

## 1.3 问题一：bash 描述里没有任何路由引导

`packages/ohbaby-agent/src/tools/bash.ts` 的 `describe()`（L194–206）只讲执行机制：用什么解释器、Windows 怎么选 shell、前台超时、后台任务、自动转后台。里面没有一句"读文件用 read、搜内容用 grep"。PowerShell 方言提示（L189）也只说"别写 grep、head"，没说该用什么替代。

六个参数（`command`、`description`、`timeout`、`run_in_background`、`auto_background`、`wait_ms`）都没有字段描述。

## 1.4 问题二：原生工具的描述写成了接口说明书

| 工具 | 位置 | 现在的写法 | 缺什么 |
| --- | --- | --- | --- |
| read | `tools/read.ts:23` | 50 KiB、cursor、64 MiB 偏移扫描上限 | 没说"已知路径就直接读"，没说可以同一轮并行读多个文件；`offset` 没有字段描述 |
| list | `tools/list.ts:20` | 只有一句 "List immediate files and directories…" | 没说替代 `ls`；`ignore`、`limit` 没有字段描述 |
| glob | `tools/glob.ts:30` | ripgrep glob 语法、隐藏文件、排除目录 | 没说"按文件名找文件用它，别用 find"；`pattern`、`limit` 没有字段描述 |
| grep | `tools/grep.ts:63` | 正则方言、ignore 规则优先级 | 没说"搜内容用它，别用 shell grep/rg"；还主动写了 "Use Bash explicitly for other encodings or raw bytes"；`pattern`、`include`、`limit` 没有字段描述 |

kimi-code、claude-code、ZCode 的同类工具都把第一句写成"什么时候用、替代哪个命令"，见 [03](03-reference-projects.md)。

## 1.5 问题三：路径描述误导模型

`tools/utils/text-files.ts:20` 的 `FILE_PATH_SCHEMA` 写的是：

> Path inside the tool execution workspace.

模型读到这句，会认为原生工具只能访问工作区内的路径，工作区外的只能用 bash。实际行为是：

- 只读工具访问工作区外路径时，`core/tool-scheduler/scheduler.ts` 的 `createPermissionContext`（约 L1899）标记 `externalRead`，再由 `confirmExternalReadPermission`（约 L1443）弹一次 `external_directory_read` 审批。
- 用户选 Always 后，该目录会登记为可信根。
- `tools/files.scheduler.integration.test.ts` 约 L520–580 的用例证明审批后 read 能读到工作区外文件。

也就是说，原生工具能读工作区外的文件，只是要审批一次。bash 读外部路径同样要审批（`external_directory_shell`），所以这里原生工具并不吃亏，但描述让模型以为它做不到。

还有一个更直接的问题：**原生工具不展开 `~`**。`sandbox/lease.ts` 的 `resolveInputPath`、`core/tool-scheduler/scheduler.ts` 的 `resolveLexicalForEnvironment`（L269）、`adapters/ui-runtime/host-local-environment.ts` 的 `resolveHostPath`、`tools/utils/file-access.ts` 的 `plan()` 都只是"绝对路径原样用，否则拼到工作区后面"。所以 `~/.ohbaby/skills` 会被当成 `<工作区>/~/.ohbaby/skills`。

会话库里有两次真实失败：`list` 传 `~/.ohbaby/skills` 和 `~/.ohbaby/mcp`，都报 `ENOENT realpath '<HOME>/~/.ohbaby/skills'`（当时工作区就是 HOME）。bash 执行时 shell 会自己展开 `~`、`$HOME`，所以模型在原生工具上碰壁后，改用 bash 就能成功，这等于在训练它用 bash。（ohbaby 的 bash 预检并不展开它们：`shell/preflight.ts` 调 `sandbox/paths.ts` 时传 `literal: true`，命令只是被判成分析不完整、每次都审批，见 improve-3 01 §1.4。）

`write` 的后果更糟：`write ~/.ohbaby/mcp/settings.json` 不会报错，也不会触发外部路径审批，而是静默写到 `<工作区>/~/.ohbaby/mcp/settings.json`，MCP 加载器读不到。系统提示词的 Self-Configuration 一节恰好让模型写 `~/.ohbaby/…`，而且没有告诉模型 HOME 在哪。会话库里暂时没找到 write 传 `~` 的记录。

## 1.6 问题四：系统提示词的引导太弱，还在把模型推向 bash

`core/system-prompt/prompts/primary/base.md` 的 `# Tool Use`（L46–52）只有一句软约束：

> Explore with `read`/`list`/`glob`/`grep` before broad changes … Use `bash` for shell-assisted and workspace tasks, not for file exploration that dedicated tools handle better.

问题有三个：

- 没有逐条映射（`cat` 换 read、`find` 换 glob 等），模型不知道"dedicated tools handle better"具体指什么。
- 这句话夹在大段 Todo、Goal、Background shell、子代理说明中间，分量很轻。
- `# Self-Configuration`（L95）主动教模型"create the directory … with `bash` (`mkdir -p` then write the file)"。实际上 `write` 会自动创建父目录（`tools/utils/files.ts:25` 的 `fs.mkdir(..., { recursive: true })`），这句话没必要，还在加强 bash 的存在感。

子代理这边：

- `prompts/subagents/base.md` 完全没有工具使用规则，只在 L36–37 讲了 bash 后台任务。
- `prompts/subagents/tasks/explore.md:5` 和 `research.md:6` 提到了先用 glob/grep，但没说别用 bash 做查看。

## 1.7 问题五：审批成本对模型不可见

`permission/evaluator.ts:100` 让 `bash-readonly` 和 `bash-mutating` 一样返回 ask（除非开了 full-access），原生只读工具则直接放行（L80）。这正是用户频繁点审批的原因。但提示词从没告诉模型这个差别，模型以为两种方式成本一样。

`agents/builtin/build.ts` 里虽然写了 `bash: { "*": "allow" }`，但 evaluator 不读取 agent 的 `permission` 字段，这个配置实际不生效。

这一点由 improve-3 处理。本轮只负责：引导理由不能单靠"bash 要审批"，因为 improve-3 放开只读 bash 后这条理由就不对了。

## 1.8 模型因素

- 现有数据里，用 bash 查看的主要是 deepseek-v4.1-flash，样本也最多。gpt-6.1-terra 那个会话的 bash 几乎都是用 `python3` 处理 xlsx，属于正当用法，不能证明它偏爱用 bash 查看；glm-5.2 主要用原生工具。后两个模型的样本都太小，下不了结论。
- GPT、Codex 这类模型在 shell 环境里训练得多，可能天生偏爱 shell（推测，本地数据样本不够验证）。Codex 自己的提示词就推荐用 `rg`。
- claude-code、kimi-code 靠"bash 描述里的映射表 + 系统提示词映射 + 工具描述写用法"压住这种偏好。我们三处都没写，所以模型的偏好完全没被压住。

结论：模型偏好是存在的，但它是放大器，不是主因。同样的模型在 claude-code、kimi-code 这类有完整引导的环境里，表现会不一样。

## 1.9 能力缺口（交给 improve-2）

下面这些情况，模型退回 bash 是合理的，本轮的文案要承认它们，不能硬说"一律别用 bash"：

- grep 不能带上下文行（`-C`），不能忽略大小写，不能只列文件名或计数。
- list 只列一层目录。
- glob 不读 `.gitignore`，结果容易被构建产物淹没。
- 统计行数、目录大小（`wc`、`du`）没有原生工具。

## 1.10 SWE 视角小结

- **这是信息问题，不是结构问题。** 链路和工具都在，缺的是"告诉模型什么时候用哪个"。改文案是最小、可逆的改动。
- **引导分散在三处，没有一个地方讲清楚。** bash 描述、原生工具描述、系统提示词各自只讲自己的机制。方案要定好每处写什么，避免三处重复同一段长文，也避免互相矛盾。
- **文案和代码要同步。** 工具描述写在 TS 代码里，系统提示词写在 md 里，由 `pnpm --filter ohbaby-agent prompt:generate` 生成 `templates.generated.ts`。改完要跑 `prompt:check`。
