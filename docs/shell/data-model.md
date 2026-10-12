# Shell 数据模型

## 分析结果

`ShellAnalysisResult` 包含真实 `shellKind`、`commands`、`completeness: complete | incomplete` 和 `incompleteReasons`。complete 只表示本次抽取的调用结构与必要事实可靠，不代表知道程序的所有副作用。

每条 `ShellCommandAnalysis` 保存 source、tokens、root、pathArgs、arityKey、danger 和 hasDynamic。可选字段包括 executedScript、inlineEval、interpreter、cdTarget、pipelineId、downloadTargets，以及相对于初始工作目录的 cwd。cwd 缺失代表当前目录不能可靠确定，不能用初始 cwd 猜测相对路径。

风险为 readonly、mutating、dangerous；聚合时 incomplete 至少为 mutating，可靠的 dangerous 事实仍保留。所有 AST 文件输出重定向至少为 mutating。

## 内部执行绑定

`ShellExecutionBinding` 是内部准备结果，包含原始 command、shell、args、cwd 和 commandPrefix。它经 `ToolExecutionContext.shellExecution` 传入 Bash，来自工具实例的可信准备入口，不能来自模型 params 或 metadata。执行前校验 command；不重新选择解释器、argv、cwd 或前缀。

`BashPreparation` 组合 shellAnalysis、执行绑定、Shell 政策结果和 sandbox 路径结果，仅在 scheduler 与 Bash 内部使用。权限层直接接收 shellAnalysis，不保存另一份命令或包装 facts。

执行绑定还携带原有 job metadata 的窄投影：cdTargets、resolvedPaths、paths、roots。它只用于结果展示，不参与权限分析；直接调用与 scheduler 调用保留同一元数据合同。

AST 已解码的路径按字面值解析，保留引号字符、首尾空白、单引号内的 `$HOME` 和 `~`。不对它们再次做引号剥离或 home 展开；未引用的 tilde 展开标为 incomplete。

## 错误与生命周期

| 来源 | 行为 |
| --- | --- |
| 分析不完整 | default 整条询问一次，禁止 Always |
| 静态政策或规则拒绝 | PermissionDeniedError，不启动进程 |
| 解释器、parser/WASM、路径 I/O 准备错误 | 明确失败，不制造误导审批或 running job |
| 实际命令失败 | 保留 exitCode、signal、stderr 和既有执行结果 |

`ShellPreflightResult` 提供 cdTargets 和 resolvedPaths。sandbox 的 `PreflightResult` 保留 internal/external/sensitive/denylist 路径事实，并用 completeness、incompleteReasons 表达分析边界。

进程树仍使用原有 `KillTreeResult` 的 confirmed/unconfirmed 证据、一次终止尝试及有界观察。ShellJobRegistry 的 jobId、running/completed/failed/cancelled/timed_out 与前后台清理合同不变。
