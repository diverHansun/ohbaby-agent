# 3. 参考项目

路径相对 `code-cli/`。标"已核对"的锚点在 2026-11-27 打开源码看过原文，其余来自子代理调研报告。

## 3.1 对比总览

| 项目 | bash 描述里有没有映射 | 原生工具描述怎么开头 | 系统提示词 | 只读 bash 的权限 |
| --- | --- | --- | --- | --- |
| kimi-code | 有，逐条"换成哪个工具" | 写用法和理由 | 一句总规则 | 要审批；Read、Grep、Glob 免审批 |
| claude-code | 有，逐条"用 X（不要用 Y）" | 写用法 | 一句总规则，带例子 | 只读 bash 自动放行 |
| ZCode | 只列"避免的命令"，不给替代 | grep 写"优先于 shell grep" | 一句 | 只读 bash 自动放行 |
| deepseek-harness | 没有 | 每个原生工具往系统提示词里加一行"用 read，不要用 cat" | 由各工具拼出 | 没有差别 |
| ohbaby（现状） | 没有 | 写实现细节 | 一句软约束 | 要审批；原生只读工具免审批 |

## 3.2 kimi-code

- `packages/agent-core-v2/src/agent/tools/os/bash/bash.md:1-8`（已核对）：开头先说 bash 用来做 shell 才能做的事（管道、环境变量、进程、git、包管理器、构建和测试），然后用粗体写"把这些换成专用工具"，逐条列出：已知路径的 `cat`、`head`、`tail` 换 Read；`echo >`、`cat <<EOF` 换 Write；`find` 和递归 `ls` 换 Glob，但普通的 `ls 已知目录` 可以保留；`grep`、`rg` 换 Grep；`echo`、`printf` 换成直接输出文字。
- grep 的描述（已核对）直接给理由：shell 里的 grep、rg 会绕过工作区策略、输出上限和敏感文件过滤。
- 系统提示词 `system.md:21`：有合适的专用工具时，先用它，再考虑原始 shell。
- 权限 `default-tool-approve.ts:7-10`：Read、Grep、Glob 自动通过，Bash 走审批。

**借鉴**：映射表的结构、"普通 ls 可以保留"这种留余地的写法、给理由而不是只下命令。

**不照搬**：kimi 的理由里有"绕过敏感文件过滤"。ohbaby 的 bash 也会做敏感路径预检（`sandbox/preflight.ts` 收集 `sensitivePaths`，scheduler 逐个确认），所以这条理由在 ohbaby 不成立。ohbaby 能说的是：原生工具明确知道访问哪个路径，bash 只能从命令文本静态分析（02 D2）。

## 3.3 claude-code

- `src/constants/prompts.ts:283`（已核对）：系统提示词里一句话，优先用专用工具而不是 Bash 的等价命令，并举例 Read 替代 cat、Edit 替代 sed、Glob 替代 find、Grep 替代 grep；Bash 留给真正的 shell 操作。
- `src/tools/BashTool/prompt.ts:276-291`（已核对）：bash 描述里的 `toolPreferenceItems`，每条格式是"某类操作：用 X（不要用 Y）"，覆盖找文件、搜内容、读文件、改文件、写文件、输出文字六类。
- GrepTool 参数：pattern、path、glob、output_mode、上下文行（-A、-B、-C）、-n、-i、type、head_limit、offset、multiline。improve-2 参考。
- `readOnlyValidation.ts`：只读 bash 自动放行。improve-3 参考。

**借鉴**：系统提示词只写一句带例子的总规则，细节放进 bash 描述。

**不照搬**："NOT"大写的强硬语气。用户确认不完全禁止，ohbaby 用中等强度的祈使句"use the dedicated tools instead of shell commands"加明确的例外（02 D3，不用"prefer"）。

## 3.4 ZCode

- `identity.ts:38`：系统提示词里一句工具偏好。
- `bash-prompt.ts:6-14`：列出要避免的命令，但没说换成什么。效果不如 kimi 和 claude-code 的映射表。
- `grep.ts:25`（已核对）：优先用这个工具而不是 Bash 里的 grep、rg，理由是结果能接入权限界面和文件链接。
- `embedded-search-branch.ts:22-26`（已核对）：默认开启内嵌搜索时，Glob 和 Grep 根本不注册，模型直接用 shell。这是另一条路线（shell 优先），和用户确认的方向相反，不采用。
- `bash-readonly-policy-simple-commands.ts:62-94`：只读 bash 自动放行；`bash-read-file-sources.ts` 把 bash 里的 `cat` 记为一次读取。improve-3 参考。

**不借鉴**："结果能显示成文件链接"这条理由在 ohbaby 不成立：Web 端所有工具共用一张通用卡片，没有文件链接（02 D2）。只读 bash 自动放行的做法留给 improve-3 参考。

## 3.5 deepseek-harness

- `read.ts:69-75`、`grep.ts:277-283`、`glob.ts:312-318`：每个原生工具往系统提示词里注入一行"用这个工具，不要用 shell 的 cat、sed、head、tail"。
- 所有参数都有描述。
- bash 描述里没有映射，权限上也没有差别。

**借鉴**：参数全部写描述。

**不照搬**：按工具往系统提示词里各塞一行。ohbaby 的系统提示词是 md 模板，集中写一条总规则更好维护。

## 3.6 opencode

- 有通用提示词，也按模型家族加专用提示词（`plugin/optimize.ts`）。
- read 工具可以直接读目录。

本轮不采用按模型分提示词的做法（02 §2.8），等实测结果出来再看是否需要。

## 3.7 小结：ohbaby 取哪些

| 来源 | 取什么 | 落到哪里 |
| --- | --- | --- |
| kimi-code | 映射表结构，给理由，留余地 | 02 §2.3 bash 路由段，D1–D3 |
| claude-code | 系统提示词一句总规则带例子 | 02 §2.3 主代理 `# Tool Use`，K9 |
| ZCode | 本轮不取（"文件链接"理由不成立，见 02 D2）；只读 bash 放行留给 improve-3 | — |
| deepseek-harness | 参数全部写描述 | 02 D11 |
| 几家共同点 | 原生工具第一句写"什么时候用、替代什么" | 02 §2.3，K4–K7 |
