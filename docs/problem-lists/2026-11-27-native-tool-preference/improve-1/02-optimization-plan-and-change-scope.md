# 2. 方案与改动面

本文件是交给实施会话的执行契约。问题来源见 [01](01-problem-analysis-and-current-state.md)，参考项目见 [03](03-reference-projects.md)，验收见 [04](04-test-and-acceptance.md)。

## 2.1 目标与成功标准

目标：模型查看文件、找文件、搜内容时，优先用 read、list、glob、grep。bash 照常用来跑命令、跑任务，以及做原生工具做不到的事。

成功标准：

- 用 [04](04-test-and-acceptance.md) §4.3 列的模型真实对话、多测几次，查看文件基本不再走 bash（标准见 04 §4.4）。
- 合理的 bash 用法不受影响：构建、测试、git、管道统计、非 UTF-8 文件照样走 bash。
- 提示词总长度增幅可控（见 §2.2 D9）。
- 现有测试和 `prompt:check` 全部通过。

## 2.2 设计决策表

| 编号 | 决策点 | 建议 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 引导写在哪里 | 三处分工：bash 描述写"哪些事换原生工具 + 为什么 + 例外"（主力）；原生工具描述第一句写"什么时候用、替代哪个命令"；系统提示词只写一两条总规则，不再复制映射表 | bash 描述主代理和子代理共用，模型每次想调 bash 时都会看到；claude-code 和 kimi-code 都是这么分工的。三处各管一件事，避免重复和矛盾 | 已确认（2026-11-27）：三处分工，各司其职；系统提示词总规则带括号举例 |
| D2 | 引导理由怎么写 | 只写现在成立、improve-3 放开只读 bash 后也成立的理由，跟在每条映射后面：read 带行号、能从截断处接着读；glob 跳过 `.git` 和 `node_modules`、`dist`、`out`、`target`（`tools/utils/ripgrep-files.ts` 的固定排除），grep 跳过 `.git` 和 `.gitignore` 忽略的文件（`tools/utils/ripgrep-search.ts`）；edit 匹配不上原文就失败；原生工具明确知道访问哪个路径，bash 只能从命令文本分析，复杂命令每次都要审批且不能记住；原生工具审批后也能访问工作区外路径。不写"输出有上限"（bash 也有上限，超出部分存文件，见 `utils/capped-output-file.ts:158`）、"显示成文件链接"（Web 端所有工具共用一张通用卡片，见 `apps/ohbaby-web/src/ui/conversation/tool-card.tsx:78-118`）、"敏感路径检查"（bash 也有预检）、"bash 要审批"（improve-3 后只读命令不成立） | 理由不成立，模型会学到错误的规则 | 已确认（2026-11-27） |
| D3 | 语气 | 中等强度：标题语用祈使句"use the dedicated tools instead of shell commands"，不用"prefer"；路由段末尾加一句出口"Fall back to shell only when a dedicated tool cannot do the job or the user asks for a shell command"。不用 `IMPORTANT`、`NEVER`、大写 `NOT`。例外只在路由段第一段写一次，出口句不再罗列命令。实测显示太软时（查看类场景仍用 bash），只加强标题语 | "prefer"压不住 shell 偏好重的模型；大写喊话容易矫枉过正，现有提示词也没有这种写法 | 已确认（2026-11-27） |
| D4 | 一条 bash 打包多个查询 | bash 描述照 kimi-code 的写法：查看多个文件或多处内容时，在同一轮里并行调原生工具；不要用 `&&` 串起 `cat`、`ls`、`grep`，也不要用 echo 分隔符拼输出；`&&` 只用于互相依赖的命令。范围只限"查看"，本轮不要求把互不相关的其他 bash 命令拆成并行调用。统计脚本加 `bash_packed` 指标 | 只做查看的 bash 有 315 次，其中 226 次（72%）在一条命令里串了两个以上查看命令，123 次用了 echo 分隔符。improve-3 之前每次 bash 调用都要审批，要求拆分其他 bash 只会让用户多点几次 | 已确认（2026-11-27） |
| D5 | 子代理 base 提示词 | 在 `subagents/base.md` 的 `# Doing Your Task` 之后、`# Returning Your Result` 之前加一个 `# Tool Use` 小节，只放一条规则，和主代理总规则一字不差。explore、research 的任务提示不再重复，现有条目保留 | 按角色统计（01 §1.1），任务提示里写了工具规则的 explore 子代理 bash 查看只占 7%，什么规则都没有的 generic 子代理占 63%。generic 是主要受益方。explore 现有两句和新规则不冲突，再写一遍只会重复 | 已确认（2026-11-27） |
| D6 | Self-Configuration 的 `mkdir -p` | L95 后半句改成"When the target file does not exist, create it with `write`; it creates missing parent directories."；删掉 L98、L119 的"Create the … directory first if it is missing"，保留"不要写到别的位置" | `writeTextFileAtomic` 会递归建父目录（`tools/utils/text-files.ts:465`），这几句只会把模型推向 bash。**依赖 D13**：不修 `~`，`write ~/.ohbaby/mcp/settings.json` 会静默写到 `<工作区>/~/.ohbaby/…`，所以 D6 必须在 Stage 0 之后落地 | 已定稿（2026-11-27，与 Gemini 核对） |
| D7 | `FILE_PATH_SCHEMA` 和可选 `path` | 见 §2.3 的参数表。schema 写明"绝对路径、`~/` 开头的路径或相对工作区的路径；工作区外也可以，首次访问某个目录时要用户批准"。list、glob、grep 的可选 `path` 另写一句"默认是工作区根目录" | schema 被六个工具共用（read、write、edit、list、glob、grep），外部读写都走审批（scheduler 的 `confirmExternalReadPermission`、`confirmExternalWritePermission`）。现在的写法让模型以为外部路径只能走 bash。`~/` 这半句靠 Stage 0（D13）成立 | 已定稿（2026-11-27，与 Gemini 核对） |
| D8 | PowerShell 方言提示 | 换成 §2.3 的 `dialectNote` 文案：同一套路由也适用于 PowerShell 的等价命令（`Get-Content` → read，`Get-ChildItem` → list 或 glob，`Select-String` → grep，`Set-Content`、`Out-File` → write 或 edit）。位置紧跟路由段 | PowerShell 下模型不会用 `cat`、`grep`，而是用这些 cmdlet，原来的路由覆盖不到。claude-code 的 PowerShell 提示也是这样列等价命令的（`constants/prompts.ts:281-282`） | 已定稿（2026-11-27，与 Gemini 核对） |
| D9 | 长度预算 | bash 描述新增不超过约 1000 个字符（§2.3 初稿约 1000）；每个原生工具描述新增不超过约 300 个字符；系统提示词主代理和子代理各新增不超过约 400 个字符 | 提示词每轮都发，太长会稀释其他规则、增加成本。参考项目的映射表都在十行以内 | 已定稿（2026-11-27，与 Gemini 核对） |
| D10 | grep 描述里的"Use Bash explicitly for other encodings or raw bytes" | 挪到描述末尾，改成"For other encodings or raw bytes, use bash." | 这是真实的能力边界，应该说；放在中间会把模型的注意力引向 bash | 已定稿（2026-11-27，与 Gemini 核对） |
| D11 | 参数描述 | 按 §2.3 的参数表给缺描述的参数补一句话。bash 的 `command` 带半句提醒"查看和编辑文件用专用工具"，这是模型填参数前最后看到的地方 | 参考项目每个参数都有描述（kimi-code `agent-core-v2/src/agent/tools/os/*/*.ts`，claude-code `BashTool.tsx:302-309`）；没有描述时模型只能猜。每条都已对照代码核对（list 的 `ignore` 只精确匹配名字，glob 的 `pattern` 不能以 `/` 开头、不能含 `..`，grep 的 `include` 传给 `rg --glob`，对单个文件不起作用） | 已定稿（2026-11-27，与 Gemini 核对） |
| D12 | 提示词语言 | 保持英文 | 现有提示词全是英文，参考项目也是英文 | 已定稿（2026-11-27，与 Gemini 核对） |
| D13 | 原生工具不展开 `~` | 在原生工具的路径解析里展开 `~`、`~/`、`~\\`（不展开 `~user`）。用一个共享函数，覆盖四处：`sandbox/lease.ts` 的 `resolveInputPath`、`core/tool-scheduler/scheduler.ts` 的 `resolveLexicalForEnvironment`（权限判断的 `canonicalizeForPermission` 也走它）、`adapters/ui-runtime/host-local-environment.ts` 的 `resolveHostPath`、`tools/utils/file-access.ts` 的 `plan()`（资源锁路径，不改会锁 `<工作区>/~/…` 却写 `<HOME>/…`）。字面叫 `~` 的相对路径可以写成 `./~` | 会话库里有两次真实失败：`list` 传 `~/.ohbaby/skills`、`~/.ohbaby/mcp`，报 `ENOENT realpath '<HOME>/~/.ohbaby/skills'`（工作区当时是 HOME）。bash 执行时 shell 会自己展开 `~`，原生工具不会，这本身就把模型推回 bash（ohbaby 的 bash 预检并不展开 `~`，只是把命令判成分析不完整，见 improve-3 01 §1.4）。系统提示词也没告诉模型 HOME 在哪，模型没法自己展开 | 已确认（2026-11-27）：放进本轮，做 Stage 0 |
| D14 | 清理现有描述里的误导用语 | list 描述删掉"in the execution workspace"；glob 的"ignores ignore files"改成"does not apply .gitignore, but always skips .git, dist, node_modules, out and target"；read、grep 描述里的 `Read`、`Bash` 统一成小写工具名；删掉 grep 末尾的"No pagination or export." | 前两处和 D7、D2 矛盾或读不懂；工具名大小写不一致会让模型以为是别的工具 | 已定稿（2026-11-27，Gemini 提出，已核对代码） |

## 2.3 文案初稿（英文，待 Pi 协作打磨）

以下是给实施会话的起点，不是终稿。终稿按 §2.4 的流程产出，并由用户确认。

**bash 描述新增的路由段**。位置顺序固定为：第一句（用哪个解释器运行命令）→ 下面这段路由映射、理由和例外 → PowerShell 方言提示和 Windows shell 选择说明 → 后台和超时说明。现在的 `commandDescription` 已经包含 Windows 说明，实施时要把第一句和后面的说明拆开，不能把路由段简单接在 `commandDescription` 后面。`describe()` 的两个分支（能管理后台任务的、只能跑前台命令的）都要带上这段。

```text
Use bash for shell work: running builds, tests, git, package managers, scripts,
pipelines that filter or aggregate command output (| grep, | tail, wc -l,
sort | uniq -c, du), and anything the dedicated tools cannot do, such as
non-UTF-8 or binary files.

To look at files, use the dedicated tools instead of shell commands:
- Reading a known file (cat, head, tail, sed -n): use read. It numbers lines
  and can resume exactly where it stopped.
- Listing one directory (ls): use list. Finding files by name (find, ls -R):
  use glob. Searching file contents (grep, rg): use grep. glob skips .git and
  common dependency or build directories; grep skips .git and files ignored
  by .gitignore.
- Creating or changing files (echo >, cat <<EOF, sed -i): use write or edit.
  edit fails safely when the text does not match.
The dedicated tools know exactly which paths they touch. Shell commands are
checked from their text, so complex ones need the user's approval every time.
The dedicated tools also work outside the workspace once the user approves
the directory. Fall back to shell only when a dedicated tool cannot do the job
or the user asks for a shell command.

To look at several files or patterns, call the dedicated tools in parallel in
one response. Do not chain cat, ls and grep with && or stitch their output
together with echo separators. Use && only for commands that depend on each
other.
```

**原生工具描述的第一句**：

| 工具 | 第一句初稿 |
| --- | --- |
| read | Read a file when you know its path. Use this instead of cat, head, tail or sed -n. Call it several times in parallel to read several files. |
| list | List the entries of one directory. Use this instead of ls. Use glob to search recursively. |
| glob | Find files by name or path pattern, for example `src/**/*.ts`. Use this instead of find or ls -R. |
| grep | Search file contents with a regular expression. Use this instead of shell grep or rg. |

原有的实现说明（50 KiB、cursor、ignore 规则等）保留在第一句之后，可以精简，但不能删掉影响正确调用的信息。

**主代理 `# Tool Use` 第一条改为**：

```text
- Use the dedicated tools to look at files (read over cat/head/tail, list over
  ls, glob over find, grep over grep/rg). Use bash to run commands: builds,
  tests, git, scripts, and work the dedicated tools cannot do. For several
  independent lookups, call the dedicated tools in parallel instead of packing
  them into one bash command.
```

括号里只放最常见的四组对照，完整映射表和例外只写在 bash 描述里（D1）。

**子代理 `subagents/base.md` 新增 `# Tool Use`**：内容与主代理这一条相同，只保留这一条。

**PowerShell 方言提示（`dialectNote`，D8）**，紧跟路由段：

```text
The interpreter is PowerShell, not bash: write PowerShell commands ($null
instead of /dev/null; no grep or head). Apply the same routing to PowerShell
equivalents (Get-Content -> read, Get-ChildItem -> list/glob, Select-String ->
grep, Set-Content/Out-File -> write/edit). Start long-running processes with
run_in_background, not Start-Process; processes started with Start-Process are
outside ohbaby's process cleanup.
```

**参数描述（D7、D11）**。带 `~/` 的措辞依赖 Stage 0（D13）：

| 参数 | 描述 |
| --- | --- |
| `FILE_PATH_SCHEMA` | Absolute path, ~/ home path, or path relative to the workspace. Paths outside the workspace also work; the first access to an external directory asks for user approval. |
| list、glob 的 `path` | Directory to inspect. Defaults to the workspace root. Accepts absolute, ~/, or workspace-relative paths; external directories ask for approval on first access. |
| grep 的 `path` | 同上，`Directory` 改成 `File or directory` |
| bash `command` | Shell command to run. Use dedicated tools (read, list, glob, grep, write, edit) for file inspection or editing. |
| bash `description` | Short summary of what the command does, e.g. "Run grep unit tests". |
| bash `timeout` | Process lifetime in milliseconds. Defaults and limits are in the tool description. |
| read `offset` | 1-based line number to start from. Cannot be combined with cursor. |
| list `ignore` | Exact immediate entry names to omit (not globs). .git, node_modules, and dist are always omitted. |
| list `limit` | Maximum entries to return (default: 100). |
| glob `pattern` | Relative ripgrep glob (no leading / or ..). Use **/*.ts for recursive matches; *.ts matches only the root. |
| glob `limit` | Maximum file paths to return (default: 100). |
| grep `pattern` | Ripgrep regular expression (no look-around or backreferences). |
| grep `include` | Ripgrep glob to filter searched files (e.g. "*.ts" by name or "src/**/*.ts" by path). Ignored when path is a single file. |
| grep `limit` | Maximum matching lines to return (default: 100). |

list、glob、grep 的 `path` 现在直接用 `FILE_PATH_SCHEMA`，实施时要给它们单独的 schema（展开 `FILE_PATH_SCHEMA` 再覆盖 `description`），read、write、edit 继续用共享的那份。

**Self-Configuration（D6）**：L95 后半句改为"When the target file does not exist, create it with `write`; it creates missing parent directories."，删掉 L98 的"Create the `mcp/` directory first if it is missing."，L119 改为"Do not write the skill anywhere else."。

## 2.4 Pi 协作流程（工具描述和系统提示词）

用户要求工具描述和系统提示词必须请三个模型协助打磨。

**模型**（实施前用 `pi --list-models` 确认准确 ID，用 `pi auth check` 确认可用）：

| 用户写的名字 | 2026-11-27 查到的 ID | 思考强度 |
| --- | --- | --- |
| `magpie/claude-opus-5-5` | `magpie` 下的 `claude/claude-opus-5-5` | medium |
| `magpie/auto-gemini-4-neon` | `magpie` 下的 `auto/gemini-4-neon` | high |
| `magpie/openai-codex/gpt-6.2-astra` | `magpie` 下的 `codex/gpt-6.2-astra`；另有 provider `openai-codex` 下的 `gpt-6.2-astra` | high |

`magpie` 下没有字面上叫 `openai-codex/gpt-6.2-astra` 的模型。实施会话要先向用户确认用哪一个，不要自己替换。

**流程**：

1. 实施会话按 §2.3 和 D1–D14 写出第一版文案，放在会话 scratch 里，不直接改代码。
2. 三个模型各开一个独立 Pi 会话，在 `ohbaby-agent` 目录启动。提示里给出：用户原话（§00 确认的方向）、01 的问题摘要、第一版文案、D2 的理由约束、D9 的长度预算、参考锚点（[03](03-reference-projects.md) 里 kimi-code `bash.md`、claude-code `BashTool/prompt.ts` 和 `prompts.ts`、ZCode `grep.ts`、`bash-prompt.ts` 的路径）。
3. 三个模型的意见原样保存到 scratch，实施会话合并成第二版，写明每条意见采纳或不采纳的理由。
4. 第二版交用户确认后再落进代码。
5. 代码改完、测试跑完后，请 `magpie` 下的 `auto/gemini-4-neon`（high）做一次实施审查。

注意：Pi 的沙箱读不到 `code-cli/` 下的兄弟仓库。参考文案要由实施会话摘出来贴进提示里，不能只给路径。

## 2.5 实施阶段

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| Stage 0（D13） | 原生工具路径展开 `~`，单独一个提交，带单测。本轮唯一的代码行为改动，必须先于 Stage 2、Stage 3 合入。单测覆盖：read、list、write 传 `~/…` 都落到 HOME 下，权限判断和资源锁用的是同一个路径 | 新单测通过，原有路径相关测试不变 |
| Stage 1 | 按 §2.4 产出并确认终稿文案 | 用户确认第二版 |
| Stage 2 | 改工具描述和参数描述（bash、read、list、glob、grep、`FILE_PATH_SCHEMA`），含 D14 的清理 | 相关单测通过 |
| Stage 3 | 改系统提示词（主代理 base、子代理 base），重新生成 `templates.generated.ts` | `prompt:generate` 后 `prompt:check` 通过，系统提示词测试通过 |
| Stage 4 | 按 04 §4.3 用真实模型多次实测，请 Gemini 审查 | 04 的验收项全部有结论 |

## 2.6 兼容、风险与回滚

- **测试锚点**：`tools/bash-cleanup.scheduler.integration.test.ts:163` 和 `:204` 断言 bash 描述里有"only run foreground commands"，改 `describe()` 时要保留这句。实施前再用 `grep` 扫一遍测试里对描述原文的断言。
- **生成文件**：`templates.generated.ts` 是生成的，不要手改。
- **矫枉过正**：模型可能因此不敢用 bash 跑统计或处理特殊编码。文案里要写明例外，实测要覆盖该用 bash 的场景（见 04 §4.3）。
- **改善不明显**：如果实测显示某个模型几乎没变，不在本轮加针对单个模型的提示词，记录下来作为后续议题。
- **回滚**：文案和生成文件一个 revert 就能回滚。Stage 0 是单独的代码提交，可以单独 revert；revert 后要同时撤掉 D6、D7 里依赖 `~` 的措辞。

## 2.7 和另外两轮的衔接

- improve-2 给 grep 加上下文、忽略大小写、只列文件名等参数后，要回头更新本轮写的 grep 描述，如果终稿里写了"需要上下文行时用 bash"这类例外，也要一并删掉。
- improve-3 放开只读 bash 后，D2 的理由依然成立，本轮文案不需要改。
- 如果 improve-2、improve-3 先于本轮实施，要先对照 D2、D10 检查文案。

## 2.8 不在本轮范围

- 调整 explore 子代理的工具集（例如去掉 bash）。
- 把 `agents/builtin/*.ts` 里的 `permission` 配置接进权限判断（improve-3 讨论）。
- 按模型家族写不同的提示词。
- 运行时拦截或改写 bash 查看命令。
- 要求把互不相关的非查看类 bash 命令（例如 `git status` 和 `git diff`）拆成多次并行调用。claude-code 和 kimi-code 都这么写，但 improve-3 之前每次 bash 调用都要审批，拆开会增加弹窗。登记为 improve-3 之后的候选。
- 在 bash 查看命令的结果末尾附提示（例如"read/grep 也能做这件事"）。会混进命令输出，还可能误报 `git log | grep` 这类正当用法。登记为后续候选：如果实测显示 shell 偏好重的模型仍没改善，再考虑每个会话最多提示一两次。
- research 子代理用 `curl`、`python3` 抓网页和解析 HTML，而不是用 `web_fetch`（01 §1.1 里有 323 次）。这和"bash 查看文件"是两回事，登记为观察，本轮不处理。
- grep、glob、list 的能力升级（improve-2）。
- 只读 bash 免审批（improve-3）。

## 2.9 关键改动清单

行号是 2026-11-27 `main`（`39ab6863`）的快照，实施时以符号为准。路径相对 `packages/ohbaby-agent/src/`。

| ID | 类型 | 路径 | 符号 / 位置 | 行号快照 | 改什么 | 为什么 |
| --- | --- | --- | --- | --- | --- | --- |
| K1 | 工具描述 | `tools/bash.ts` | `describe()` 里的 `commandDescription`，以及 L198 的前台分支 | L195–206 | 拆开第一句和 Windows 说明，按 §2.3 的顺序插入路由段；两个分支都带上 | 01 §1.3，D1–D4 |
| K2 | 工具描述 | `tools/bash.ts` | `dialectNote` | L189 | 先指向原生工具，再说 PowerShell 没有 `grep`、`head` | D8 |
| K3 | 参数描述 | `tools/bash.ts` | `parametersJsonSchema.properties` | L213–224 | 给 `command`、`description`、`timeout` 补描述（措辞与工具描述里已有的 timeout 说明保持一致）；`describe()` L198 保留"only run foreground commands" | D11，测试锚点 |
| K4 | 工具描述 | `tools/read.ts` | `description`、`offset` | L23–24，L40 | 改第一句；`cursor` 描述里的 `Read` 改小写；给 `offset` 补描述 | 01 §1.4，D11，D14 |
| K5 | 工具描述 | `tools/list.ts` | `description`、参数 | L20–21 | 改第一句，删掉"in the execution workspace"；给 `path`、`ignore`、`limit` 补描述 | 01 §1.4，D11，D14 |
| K6 | 工具描述 | `tools/glob.ts` | `description`、参数 | L30–31 | 改第一句；"ignores ignore files"换成 D14 的说法；给 `pattern`、`limit` 补描述 | 01 §1.4，D11，D14 |
| K7 | 工具描述 | `tools/grep.ts` | `description`、参数 | L63–64 | 改第一句；把"Use Bash explicitly…"挪到末尾改成例外；`Read` 改小写，删掉"No pagination or export."；给 `pattern`、`include`、`limit` 补描述 | 01 §1.4，D10，D11，D14 |
| K8 | 共享 schema | `tools/utils/text-files.ts` | `FILE_PATH_SCHEMA` | L20–24 | 说明工作区外路径可用、首次访问需确认 | 01 §1.5，D7 |
| K9 | 系统提示词 | `core/system-prompt/prompts/primary/base.md` | `# Tool Use` 第一条 | L47 | 换成 §2.3 的总规则 | 01 §1.6，D1，D4 |
| K10 | 系统提示词 | `core/system-prompt/prompts/primary/base.md` | `# Self-Configuration` | L95，L98，L119 | 删掉"用 bash 跑 `mkdir -p`"和两处"先建目录"，改为说明 `write` 会自动建父目录 | D6 |
| K11 | 系统提示词 | `core/system-prompt/prompts/subagents/base.md` | 新增 `# Tool Use` | 放在 `# Doing Your Task`（L16）之后、`# Returning Your Result`（L26）之前 | 加一条与主代理一致的总规则 | D5 |
| K12 | 系统提示词 | `core/system-prompt/prompts/subagents/tasks/explore.md`、`research.md` | 工具相关条目 | explore L5–6，research L6–7 | 不改。只核对现有条目和新规则没有矛盾 | D5 |
| K14 | 代码（Stage 0） | `sandbox/lease.ts`、`core/tool-scheduler/scheduler.ts`、`adapters/ui-runtime/host-local-environment.ts`、`tools/utils/file-access.ts` | `resolveInputPath`、`resolveLexicalForEnvironment`、`resolveHostPath`、`plan()` | lease L16–20，scheduler L269–276，host-local L59–63，file-access L71–73 | 用一个共享函数展开 `~`、`~/`、`~\\`，四处都改用它 | D13 |
| K15 | 工具描述 | `tools/list.ts`、`tools/glob.ts`、`tools/grep.ts` | `path` 参数 | list L26，glob L35，grep L70 附近 | 不再直接用 `FILE_PATH_SCHEMA`，换成带"默认工作区根目录"的描述 | D7 |
| K13 | 生成文件 | `core/system-prompt/prompts/templates.generated.ts` | 整个文件 | — | 运行 `pnpm --filter ohbaby-agent prompt:generate` 重新生成，不手改 | 生成链路 |
