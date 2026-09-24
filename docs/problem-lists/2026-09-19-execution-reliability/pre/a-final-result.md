# A. 最终结果提取

> 整项可靠性改造前置。2026-09-24 按用户要求独立记录，随逐项讨论更新。已确认最终正文返回链、过程展示、正常空正文及失败/中断交付规则；本地临时分支 `codex/execution-reliability-pre-a` 已实施并验收，尚未合回开发分支。

## 2026-09-24 本地实施记录

- `RunManager` 只在成功 completion 中传递本次 lifecycle 的 `finalResponse`；runner 的等待路径直接使用该字段，保留空字符串，不再查询整个 session/context scope 的历史来挑选最后一条非空消息。旧的 `extractFinalOutput` 导出仍保留供兼容，但生产等待路径不再调用它。
- `AgentRunResult.runStatus` 保留 `succeeded`、`failed`、`cancelled`、`interrupted` 的真实结束事实；失败结果只携带原因，不带 `finalOutput`。子代理 host 把取消或中断保留为对应状态，不把它们记成普通失败。
- `subagent_run` 和 `subagent_status` 仅对已完成、无当前 run、无待处理输入的空结果显示 `program_note: No output.`。后台排队时不回显上一轮结果；若后台执行在返回前已完成，显示本次结果。失败原因在 `<subagent_error>` 中显示，不包装成 `<subagent_output>`。
- 测试覆盖本次正文、旧历史隔离、正常空正文、仅有 reasoning、失败和取消、前台/后台工具输出，以及完整 composition 的父子代理链。普通主会话 stream 与 Web 的工具和追问展示通过编译产物服务的浏览器 E2E 核对；刷新后消息和会话身份保持一致。
- 2026-09-24 本地证据：全量 unit `2807 passed, 2 skipped`；全量 integration `546 passed`；子代理 composition E2E `6 passed`，其中受控 provider 先发片段再断流或被取消的用例确认原 scope 历史留片段、父代理只收到对应终态与原因；类型检查、lint、构建、格式检查及 compiled Web 浏览器 E2E 通过。

子代理只读审查未发现确定的严重或重要缺陷，并指出后台结果展示的两个竞态；两者已修复并经红绿测试验证。部分正文后超时和中断尚未各自新增跨层端到端用例；目前由 lifecycle 与 host 的定向测试覆盖，不把单元证据写成这两个跨层场景都已逐一通过。

本批未改变 reasoning 持久化或历史页面；前者由 improve-1.1、后者由第三轮负责。测试中的 reasoning-only 子代理最终正文为空，其即时 reasoning 仍按现有链路处理，不把它当报告。

## 已核实的现状

- 普通主会话在 `packages/ohbaby-agent/src/agents/service.ts` 使用 `waitMode: stream`；对用户保持流式输出。
- `core/lifecycle/lifecycle.ts` 分别处理正文和 `reasoningTextDelta`；普通流式正文没有在这里拼接 reasoning。
- `core/agents/output.ts::extractFinalOutput` 会拼接 assistant 消息中的 text/reasoning。`core/agents/runner.ts` 的 waitForCompletion 路径读取会话或 context scope 历史后调用它，没有在提取处限定本次 run。是否触发拼接，取决于消息中是否存在 reasoning part，不能写成每次普通对话都受影响。
- Web `apps/ohbaby-web/src/ui/App.tsx` 有 Thought 区域和 reasoning part 渲染分支；个别文本辅助函数也合并两种类型。用户观察到页面未显示 reasoning，尚不能据此断言前端不支持它，或认定其具体原因。
- 2026-09-24 补查：`core/lifecycle/lifecycle.ts` 已在本次执行的 `LifecycleResult.finalResponse` 中返回正文；`runtime/run-manager/worker.ts` 保留该 result，但 `manager.ts::completionFromResult` 未把正文传入 completion，runner 随后才查询历史重新提取。失败路径的 finalResponse 也可能是错误说明，不能无条件当成成功正文。
- 普通主会话的过程文字已有展示链路：worker 发布正文增量，`adapters/ui-runtime/run-stream-adapter.ts` 将文字和工具结果按顺序组成 parts，Web `eventReducer.ts` 更新它们，`App.tsx::MessagePart` 在 streaming 时渲染 text。当前实时投影会将多步内容放进一个展示消息；真实消息身份及刷新恢复的修正仍由 improve-1.1 负责。不能从这条主会话链路推导子代理只读界面已经完成。

## 2026-09-24 已确认：最终返回与过程展示

用户确认最终消息“检查完成，两个问题分别是……”需要返回；“我先检查配置文件”“找到两个问题，我继续验证”等过程回复在 run 运行期间也应展示，并明确“确认你补齐这条完成结果返回链的方案”。据此记录：

1. 最终结果返回本次执行结束时的正式正文；过程文字继续随执行展示并保留在历史中。A 的最终结果选择不删除或隐藏这些过程文字，也不将它们拼成最终报告。
2. 沿已有 lifecycle → RunWorker → run completion → AgentRunResult 传递本次正文，替换生产 waitForCompletion 路径的全会话历史回捞。保持真实 run/session/context scope 归属，按成功、失败、中断区分结果；不为 A 新建结果服务或历史扫描框架。
3. 正文与 reasoning 分开。improve-1.1 后续保存展示思考时，这些记录不能混入最终报告；provider 原生 model-state 的回放边界沿原契约。
4. 第三轮取得 A 的结果后，再负责完整保存、通知及 `.output` 导出。第三轮的 SQLite 权威结果要求不意味着 A 必须先从消息数据库搜索正文；具体交接见 [第三轮 02](../improve-3/02-optimization-plan-and-change-scope.md)。

## 2026-09-24 已确认：正常结束但没有最终正文

用户确认：“正常结束，但没有最终正文”这个事实应明确提示，不自动追加模型请求，不采用 Kimi 的自动补写做法。

- 保留真实的正常结束状态；正文为空不改成执行失败，也不据此宣称用户任务已全部完成。
- 最终正文保持为空，程序单独返回英文说明 `No output.`。该说明属于程序反馈，与模型正文区分，不能作为模型生成的报告保存。
- 不回取上次答复、过程说明或 reasoning 填补空正文；已有过程文字和工具历史继续可查看。
- 后端不因空正文自动补请求或重跑任务。父代理或用户可根据真实结果决定是否另行追问。

验收须覆盖正常有正文、正常空正文及仅有 reasoning；空正文场景不增加模型或工具调用次数，不回退到其他步骤或其他 run 的文字。失败/中断场景按下一节的真实终态规则处理。

## 2026-09-24 已确认：失败、中断时交付终态与原因

用户确认：“向调用方交付真实终态和原因，部分正文保留在消息历史中，不自动作为报告交给父代理”，并要求保持 KISS、遵循 SWE 原则。

- 失败、超时或中断时，向调用方交付对应的真实终态和原因。各层沿用自身已有的状态语义，不因存在正文就映射成正常完成，也不把所有结束原因压成一个无法区分的成功布尔值。
- 已产生并保留的部分正文留在本次执行的消息历史中，保持真实归属及失败/中断事实；不删除，也不标成完整报告。普通主会话已经流式展示的过程文字继续保留；子代理只读历史界面的建设仍归第三轮。
- 不自动将部分正文附给父代理，不用它填补 finalOutput 或错误原因，不回捞其他步骤或上次执行的答复作为替代报告。
- A 不新增 partialOutput 返回通道、半份报告导出或自动补写/重跑机制。复用已有完成结果链、错误处理和消息历史，分别负责结果交付、结束原因和过程保留。

对应的行为验收要求：

| 场景 | 必须验证 |
|---|---|
| 正文已产生一部分后失败 | 调用方收到失败终态和真实原因，已有片段仍可在原消息历史定位；不作为成功正文或附加报告返回 |
| 正文已产生一部分后超时/取消/中断 | 分别保留对应的真实结束事实；历史片段不删除、不改写为正常完成，不自动交给父代理 |
| 没有正文就失败/中断 | 仍返回真实终态和原因，不按正常空正文处理，不从旧历史补文字 |
| 前台/后台子执行收口 | 两条路径遵守相同的正文选择和错误边界；不为携带片段新增模型请求、重跑工具或等待额外报告生成 |

以上是待实施的验收要求，不是已通过的测试记录。底层进程清理与资源释放仍由 C 负责，结果返回不证明真实操作已经停止。

## 2026-09-24 参考核查：正文、空结果与结束原因

以下为本地源码观察，未运行参考项目。路径相对 `/Users/hansun025/Projects/code-cli/`，只说明已读路径，不推断整个项目的保证。

| 项目 / revision | 实际实现 | 本问题的借鉴边界 |
|---|---|---|
| OpenCode / `d4ad650f73` | `packages/opencode/src/tool/task.ts::runTask` 从本次 prompt 返回消息取最后一个 text part，缺失时返回空字符串 | 支持直接使用本次调用返回对象；不照搬只取一个 part 的做法 |
| Pi / `57cde8690` | `packages/coding-agent/examples/extensions/subagent/index.ts` 的 `getFinalOutput` 取 assistant text；单任务分支按 exitCode/stopReason 判断失败，正常空输出显示 `(no output)` | 是子代理扩展示例；输出是否为空与失败判定分开，历史回查规则不照搬 |
| Kimi / `19c5aa64e` | `packages/agent-core/src/session/subagent-host.ts::waitForChildCompletion` 调用 `lastAssistantText`；结果少于 200 字符时最多追加一次模型请求，再接受结果 | 这是主动补写策略，会增加执行；用户已确认正常空正文不自动补请求；历史找非空正文也不作为本项目方案 |
| DeepSeek Harness / `47f943859b` | `packages/subagent/subagent-dsh-sdk/src/run.ts` 返回 output 与 stopReason；`packages/subagent/subagent/src/assistant-output.ts` 选最后非空 assistant 消息或累计流式片段，没有内容则由调用方返回空数组 | 借鉴输出和结束原因分开；其过程片段兜底不等于本项目已确认的最终正文规则 |

## 本次核实与待继续讨论

2026-09-24 在 ohbaby 基线 `164ef2f7` 运行以下现有定向测试，2 个用例通过、35 个未选中。分别验证工具结果后的文字按顺序追加，以及两轮工具调用之间的旧正文不会被后文覆盖。该证据只覆盖现有适配器和 Web reducer，不是 A 已实施，也不是浏览器刷新或子代理面板验收。

```sh
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts -t 'appends text that arrives after a tool result in chronological part order|keeps earlier text intact across two rounds of tools'
```

待补充：旧调用方兼容，以及上述规则在真实完成结果链上的具体验收接线。正文选择、正常空正文和失败/中断交付规则已确认，不再列为待讨论的产品方向。

## 后续方案应解决

1. 最终交付只取本次执行、正确 session/context scope 的正式正文；没有正文时明确无结果，不取上次答复。
2. 成功正文、失败原因、取消事实与不完整输出区分；不把失败前片段包装为成功报告。
3. 分别验证普通主会话 stream、内部 waitForCompletion、子代理前台/后台结果及旧消息兼容。
4. reasoning 与正文保持类型边界。是否展示、保存或回放 reasoning 不在这条待办中擅自改变，尤其不能破坏 provider 的原生 model-state 回放。

不将该缺陷直接归因为先前主代理卡住的根因；目前证据支持的是结果正确性风险。

## 失败与中断的补查事实（2026-09-24）

本节记录上述交付取舍的参考事实，revision 与上表一致；这些项目不同层次的处理并不完全相同，不能据此声称所有实现都采用同一策略。

- ohbaby：`core/agents/types.ts::AgentRunResult` 的失败分支只有 error；`agents/subagent-host.ts::successfulOutput` 将失败原因作为 output，超时/中断出口也保存状态与原因。当前 completion 返回链不承诺携带部分正文。lifecycle 的部分失败出口用错误说明覆盖 finalResponse，断流出口也可能返回空值，不能把这个字段在所有终态下都当作模型原文。
- DeepSeek Harness：`packages/subagent/subagent/src/out-of-process.ts::settleRunResult` 在失败/取消时可返回已收集 output，`types.ts::SubagentResult` 将它与 stopReason 分开；但 `run-settlement.ts::runOutcome` 的后台一次性任务路径在失败/中止时不转交部分输出。不能把底层保留能力说成所有父任务都会收到半成品。
- OpenCode：`packages/opencode/src/tool/task.ts` 的前台等待路径遇到 error/cancelled 时返回对应错误；只有正常完成分支渲染 completed 正文。
- Pi：`packages/coding-agent/examples/extensions/subagent/index.ts::getResultOutput` 在失败时优先 errorMessage/stderr，缺少错误说明才回退文字；完整 messages 仍在结果详情中。单任务调用标记 isError，不能因有文字就当成功。

## 2026-09-24 外部反馈：最终正文与空正文提示

[Opus 5.5 反馈](https://opncd.ai/share/1MQFKOmb) 提出最后一步正文和本次最后非空正文的区别。此前用户已确认不回取过程说明补最终报告，继续沿此规则：即使前一步写出看似完整的结论后又调用工具，正常结束时正文为空，仍说明没有最终正文；最后只说“好了”，就交付“好了”。前面的结论保留在历史中，不由程序判断其内容更像报告而替换最终正文。该例子细化已有选择，不改变正文来源。

**用户已确认：真实状态＋空正文＋单独的英文 `program_note`。** 正常结束且最终正文为空时，保留真实终态和空的 `finalOutput`，在工具结果的程序说明区域展示 `program_note: No output.`，不放进 `<subagent_output>`，不写回为模型正文或报告。只在本次执行已正常结束时生成，后台派遣尚未完成或查询仍在运行时不显示。沿现有结果渲染补一条说明，不新增报告服务或自动补请求；后续第三轮后台交付采用相同语义。

源码依据（ohbaby `10018b4d`）：`tools/subagent.ts::renderRun/renderStatus` 已把身份、状态与 `<subagent_output>` 分开，当前空 output 只被省略；`agents/subagent-host.ts::successfulOutput` 直接传递成功的 finalOutput。Pi `57cde86906` 子代理扩展示例在文本结果中显示 `(no output)`，说明提示必须进入模型可见文本；不照搬它的正文提取或失败兜底。待验收应检查父模型真正收到的工具文本、空的正文存储及不增加模型请求，不能只检查 UI 元数据。提示格式及英文输出要求已确认，未实施。验收同时检查程序提示使用英文；中文文档中的解释不得直接作为运行时提示输出。

## 与后续轮次的边界

第三轮消费本次正文和真实结束事实，再负责结果持久化、通知、内部只读授权及产物清理。A 不新增 improve 编号；触顶原因的全链路贯通仍按第三轮 S3a 处理。Read 能力由 [B](b-file-tools.md) 独立验收。

返回：[前置索引](prerequisite-follow-ups.md) · [总体路线](../README.md) · [第三轮](../improve-3/README.md)。
