# Shell / Glob 现状与问题

> 基线：`24c7003448840fb4ba5acedb15d31456651e1466`。本页描述现状，不表示规划已实施。

## 1.1 问题清单

| ID  | 问题                                 | 证据与影响                                                                                                                                                                                                                                      |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 手写解析器把不认识的语法当作执行错误 | [bash.ts](../../../../packages/ohbaby-agent/src/tools/bash.ts) L143：`parseCommand().hasError` 直接拒绝；命令替换 / 反引号等有效命令受阻                                                                                                        |
| S2  | Shell 选择、解析与 preflight 重复    | [scheduler.ts](../../../../packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts) L1814 / L1826 与 bash L160 各自选择；审批和执行可能基于不同事实                                                                                          |
| S3  | 审批分类 / 历史规则匹配仍重解析      | [classifier.ts](../../../../packages/ohbaby-agent/src/permission/classifier.ts) L74；[matcher.ts](../../../../packages/ohbaby-agent/src/permission/matcher.ts) L46 / L256；只换一个 parser 入口不能解决                                         |
| S4  | 不完整分析与长期 allow 的关系未建立  | [evaluator.ts](../../../../packages/ohbaby-agent/src/permission/evaluator.ts) L131 先匹配已有 allow；[manager.ts](../../../../packages/ohbaby-agent/src/permission/manager.ts) 还有 ask 二次评估与 autoApproveMatching                          |
| S5  | 平台默认与实际方言不清楚             | [detector.ts](../../../../packages/ohbaby-agent/src/shell/detector.ts) L123 / L131–148：Windows 有效显式 SHELL → 自动 Git Bash → COMSPEC / cmd；[preflight.ts](../../../../packages/ohbaby-agent/src/shell/preflight.ts) L75 把 zsh 等归为 bash |
| G1  | 手写 Glob 只支持有限模式             | [files.ts](../../../../packages/ohbaby-agent/src/tools/utils/files.ts) L45：花括号与字符类被当作普通字符                                                                                                                                        |
| G2  | 遍历不响应 signal，完成性易误报      | files L199 的 scanFiles 无 signal；[glob.ts](../../../../packages/ohbaby-agent/src/tools/glob.ts) L49 / L60 达到恰好 limit 也报 truncated，未完成仍可能输出 No files matched                                                                    |
| G3  | 完成性信息在模型边界丢失             | [tool-metadata-projection.ts](../../../../packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts) L132：Glob 未投影 scanComplete / displayLimited / stopReason                                                                      |

## 1.2 历史与诊断证据

2026-09-24 的 `04bd3794` 改进 Read 分块及 Grep 的 bundled rg；`22d7b130` 改进有界写入与原子修改；后续提交完善取消与文件资源锁。这些能力应保留。Shell 的 unsupported gate 由 `5519fe8f`（2026-05-14）引入；`git log --all -S "Unsupported shell syntax"` 只命中该提交。`26648a91` 仅将 `bash-tool.ts` 更名为 `bash.ts`，该文件没有内容变更。因此不能把此限制归因于两周前的读写工具改造。

此前诊断确认：普通 `for i in 1 2 3; do ...; done` 可执行；包含 `$(...)` 的版本被提前拒绝。`if` / `for` 的关键字会被轻量解析误当命令根。重定向、带副作用选项的命令以及 heredoc 还可能产生不准确的静态分类。诊断不等于证明 default 模式存在未审批执行：该模式目前对 Bash 默认询问。

真实 scheduler / permission 的诊断还显示，某些命令会先审批、后被工具的轻量 parser 拒绝；记住的规则可能已先保存。应消除重复判断，不新增执行成功后才提交权限的事务体系。

## 1.3 Shell 模块诊断

### 职责、架构与数据

系统 Shell 已执行原始 command；不是需要从零实现执行器。[shell/analysis/index.ts](../../../../packages/ohbaby-agent/src/shell/analysis/index.ts) 已预留成熟 parser 的替换入口，但当前仍转发轻量实现。

当前事实散落在 `ParsedCommand`、`ShellAnalysisResult`、preflight 路径事实和权限分类中。`shell/command-classifier.ts` 虽不直接调用 parser，也依赖旧 `ParsedCommand / CommandDetail` 类型，属于必须迁移的消费者。preflight 也会拆分并重新解析，且拒绝部分嵌套执行。分析器、静态检查、权限规则与执行入口各管一部分，导致语法支持不一致。

### 数据流与关键用例

当前路径为调度器建权限上下文 → 权限判断 / 用户审批 → Bash 再次 parse、选择 shell、preflight → ShellJobRegistry spawn。应重点验证“用户审批的原始命令在同一解释器和工作目录执行”，以及 default 子代理审批由根会话处理。

### 非功能与边界

Host-local 明确 `isolation: none`。静态分析不能发现任意脚本的全部副作用。当前 Bash admission 主要管理 cleanupOwner，没有根据全部路径事实建立文件读写锁；不应把现状写成已拥有全局 Shell 文件隔离。

ShellJobRegistry 已实现前后台任务、超时、取消、owner/scope 清理，应保留。完整输出日志另有议题，本批不扩大范围。

### 测试缺口

已有 Shell、permission、scheduler、Bash 生命周期测试。[detector-windows.unit.test.ts](../../../../packages/ohbaby-agent/src/shell/detector-windows.unit.test.ts) L22–28 在 `COMSPEC=cmd` 时仍断言优先自动发现 Git Bash；PowerShell 默认方案会改变该行为，必须同步调整相关测试。缺口为成熟 parser 到历史规则匹配的全链路、zsh 方言差异、三个平台真实解释器及安装产物中的 WASM 资源可用性。

## 1.4 Glob 模块诊断

Glob 当前是 `withFileAccess(..., "tree")` 包装的只读工具，先做路径授权，再用 `scanFiles` 遍历。默认 100 个匹配、10,000 个已访问文件上限；按目录项排序，不遵守 ignore 文件，包含隐藏文件，固定排除五类名称，不跟随内部 symlink。

当前 `*.ts` 是根相对的。直接照搬 `rg --glob '*.ts'` 会扩大到任意层，必须显式保留根锚定。正向 rg glob 会覆盖 ignore，不能声称默认遵守 `.gitignore`。

项目已有 `@vscode/ripgrep`，Grep 有有界输出、取消和进程清理实现。现有 [ripgrep-search.ts](../../../../packages/ohbaby-agent/src/tools/utils/ripgrep-search.ts) L88 使用 `--json`，L210 按换行解析 JSON 记录。拟议 Glob 才使用 `--null` 的 NUL 路径帧；可以复用二进制定位和必要生命周期方法，不能把两种输出协议混为一谈。

`createGlobMatcher / scanFiles / walkFiles` 已没有其他生产消费者；迁移后可删除。`files.ts` 的 `ensureWritableParent` 仍被写文件使用，不可整文件盲删。rg 不提供原先的 visitedFileCount，不能伪造该数字。

另需注意，旧 command-parser helpers 经 `utils/index.ts` 和包根 `index.ts` L113 的 `export *` 暴露到公开包入口。删除不能只检查仓内调用，还要明确公开 API 的迁移影响。

## 1.5 文档与实现对照

| 文档                                                                                           | 代码实际情况                                             | 本批处理                                                   |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| [Shell 旧分析规划](../../../shell/improve-1/integration-plan.md) 已提 Tree-sitter              | 仍是轻量 parser                                          | 落实成熟分析，旧规划相关章节标记被本方案承接               |
| [Shell 架构](../../../shell/architecture.md) Windows Git Bash / cmd                            | 当前有效 SHELL 优先，其次自动 Git Bash，再 COMSPEC / cmd | 取消 Git Bash 自动探测，改为 PowerShell 默认并说明真实方言 |
| [Shell 后台规划](../../../shell/improve-3/README.md)                                           | 已有 job 生命周期                                        | 保留，不另造执行框架                                       |
| [工具接口](../../../tools/dfd-interface.md) / [权限接口](../../../permission/dfd-interface.md) | 需要对齐完整性与规则复用                                 | 实施同步，历史验收不改写                                   |

## 1.6 SWE 判断

值得改的是重复的命令判断与不完整的搜索实现。保留现有业务边界，权限函数共用分析结果，执行层固定原始命令与解释器；Glob 复用成熟引擎。成本主要来自依赖打包和权限兼容，04 必须覆盖；不以此为由新增通用 Shell DSL、解析器插件框架、所有命令的资源锁预测或搜索分页。
