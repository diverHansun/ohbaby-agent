# A. 最终结果提取

> 整项可靠性改造前置。2026-09-24 按用户要求独立记录，随逐项讨论更新。已确认最终正文返回链、过程展示、正常空正文及失败/中断交付规则；本地临时分支 `codex/execution-reliability-pre-a` 已实施；独立验收指出的 A-R1、A-R2、A-S1 已补修并通过全量复验及 Pi 复审，具备本地合回条件。

## 2026-09-24 本地实施记录

以下保留实施时的记录；当前是否可以合回，以下方验收问题补修与复验记录为准。

- `RunManager` 只在成功 completion 中传递本次 lifecycle 的 `finalResponse`；runner 的等待路径直接使用该字段，保留空字符串，不再查询整个 session/context scope 的历史来挑选最后一条非空消息。旧的 `extractFinalOutput` 导出仍保留供兼容，但生产等待路径不再调用它。
- `AgentRunResult.runStatus` 保留 `succeeded`、`failed`、`cancelled`、`interrupted` 的真实结束事实；失败结果只携带原因，不带 `finalOutput`。子代理 host 把取消或中断保留为对应状态，不把它们记成普通失败。
- `subagent_run` 和 `subagent_status` 仅对已完成、无当前 run、无待处理输入的空结果显示 `program_note: No output.`。后台排队时不回显上一轮结果；若后台执行在返回前已完成，显示本次结果。失败原因在 `<subagent_error>` 中显示，不包装成 `<subagent_output>`。
- 测试覆盖本次正文、旧历史隔离、正常空正文、仅有 reasoning、失败和取消、前台/后台工具输出，以及完整 composition 的父子代理链。普通主会话 stream 与 Web 的工具和追问展示通过编译产物服务的浏览器 E2E 核对；刷新后消息和会话身份保持一致。
- 2026-09-24 本地证据：全量 unit `2808 passed, 2 skipped`；全量 integration `546 passed`；子代理 composition E2E `6 passed`，其中受控 provider 先发片段再断流或被取消的用例确认原 scope 历史留片段、父代理只收到对应终态与原因；类型检查、lint、构建、格式检查及 compiled Web 浏览器 E2E 通过。

子代理只读审查指出后台结果展示的三个竞态，均已修复并经红绿测试验证；最终复审还使 reasoning-only 用例只约束正文为空，不限制未来的 reasoning part 持久化。部分正文后超时和中断尚未各自新增跨层端到端用例；目前由 lifecycle 与 host 的定向测试覆盖，不把单元证据写成这两个跨层场景都已逐一通过。

本批未改变 reasoning 持久化或历史页面；前者由 improve-1.1、后者由第三轮负责。测试中的 reasoning-only 子代理最终正文为空，其即时 reasoning 仍按现有链路处理，不把它当报告。

## 2026-09-24 验收问题补修

- A-R1：host 的完成回执区分本次运行结果与未执行输入的 `paused` 结果，工具再与后台实例快照区分。本次前台终态、正文或错误不再被后续队列遮住；后台派遣仍抑制尚未执行输入的旧报告、旧错误。真实 host → store → tool 回归覆盖有后续队列的成功正文、成功空正文、失败、超时和中断；前台追问被前轮失败/取消/超时/中断暂停时，正文与模型 metadata 都显示 paused，不借用前轮错误。
- A-R2：内存与数据库 store 均以 `closedAt` 判定关闭；保留单次 run 的 `cancelled` 状态，同时允许未关闭实例继续排队与 claim。测试同时验证取消后续跑、真正关闭后拒绝追加/claim，以及 late completion 不能覆盖 close。
- A-S1：明确关闭有运行中或排队工作的实例时，保存 `subagent closed` 原因，交付给原前台等待者，并通过本次 close 的独立 `reason` 在文本和模型 metadata 中显示原因。关闭空闲实例仍保留历史记录，但不将历史错误作为关闭原因。
- 补强完整链路证据：部分正文后超时、host 中断已加入 composition E2E，与原有取消、断流用例一起验证原 scope 留片段、父报告仅含终态与原因，当前 8 个 E2E 通过。
- 首次 Pi 审查指出“尚未执行的前台追问被暂停”与“空闲 close 借用旧错误”的两个反例，已补回归并修复；同一 `github-copilot/claude-opus-5.5` 会话复审未发现阻塞项，确认可本地合回。
- 最终复验：`pnpm test` 362 个文件通过、6 个文件跳过，3813 个用例通过、17 个跳过；composition E2E 8 个通过；lint、typecheck、format:check、build 和 diff 空白检查通过。新增回归均先确认失败，再验证修复后通过。测试代码中曾发现两处可选输出的类型错误，已修正并完整重跑。
- Pi 独立重跑 8 个文件的 93 个单元/集成用例及 8 个 composition E2E，全部通过。未覆盖的组合仍包括父级中断在尚未 claim 时暂停前台输入的模型渲染、SQLite store 经 host 的暂停链路；原始 metadata 中保留的实例历史 error 仍存在，给模型的投影会过滤。此次未重跑手工浏览器验收或真实模型业务请求。
- 本次只修复 A 的交付与实例准入边界，不包含 B/C、结果服务或资源清理改造。本地 `codex/execution-reliability-pre-a` 分支按用户要求保留。

以下独立验收保留当时发现与证据，描述的是 `e5e98878`，不代表补修后的最终结论。

## 2026-09-24 独立验收：暂不合回（补修前）

### 范围与结论

- 基线：开发分支 `codex/execution-reliability` 的 `675c8fc4c731db53356dd5e2852271ff12285305`。
- 被验版本：`codex/execution-reliability-pre-a` 的 `e5e9887880f645d9c01011171c1c3e86ba9b2135`，共四个提交、13 个变更文件；开始验收时工作区干净。
- 方法：主审完整核对 diff 和返回链；两个只读子代理分别审查代码正确性与原方案覆盖。问题通过真实 `SessionSubagentHost`、内存 store、工具渲染与模型 metadata 投影复现，并对前两项运行基线对照。
- 结论：核心正文返回链符合方案，现有自动化检查通过，但结果交付和取消后的续跑存在缺口，暂不合回。此次只更新验收记录，未修改产品代码、测试或执行合并。

### Standards：本次引入的回归

**A-R1 / P1：后续排队输入会遮住本次前台成功报告。**

定位：`packages/ohbaby-agent/src/tools/subagent.ts:71–90`。前台 first 还在执行时，对同一子代理排入后台 second；first 完成后，host 在 `subagent-host.ts:825` 交付的是 first 的完成快照，快照仍可包含 second 的 `pendingQueue`。渲染却用“整个队列为空”判断 first 是否完成，将文本改成 `status: queued / pending_inputs: 1`，删除 first 的正文。模型 metadata 只投影状态等信息，不包含报告正文，无法补回丢失内容。

真实复现中，host 已返回 `success: true / output: FIRST TASK REPORT`，父模型可见内容却没有这段报告；基线能够返回正文。first 失败时也会误写 `queued` 并省略错误块，不过错误仍在模型 metadata 中，属于文本与 metadata 矛盾，不能说失败原因完全丢失。

修复边界：区分“前台本次调用的完成结果”与“后台派遣后的实例快照”。后续队列不能遮住已经结束的前台结果；后台尚未执行的输入仍不能冒领上一轮报告。补充有后续队列时的成功正文、成功空正文、失败、超时和中断验收。

**A-R2 / P2：取消单次 run 后，未关闭的实例也不能继续使用。**

定位：`packages/ohbaby-agent/src/agents/subagent-host.ts:122–125`。新增映射将 run 的 `cancelled` 保存为实例状态，但内存 store 的 `appendPendingQueue/claim`（61、115 行）和数据库 store（202、280 行）都把此状态当作禁止再次使用的条件。

真实复现中，取消结果的 `closedAt` 未设置，随后同一 `subagent_id` 续跑仍报 `Subagent is closed: subagent`。基线虽然把该次 run 记成 failed，但实例可以续跑。本次保留真实取消事实是正确方向，需要同时对齐实例准入规则，区分“取消这一轮”与“明确关闭实例”；不能通过重新谎报 failed 来规避。修复时同时覆盖内存、数据库 store，并保证真正 close 的实例仍禁止续跑。

其余改动未发现需要报告的新增正确性问题。复用现有完成链、不增加历史扫描、自动补写或结果服务，改动范围符合 KISS；以上两项反映的是单次 run 与长期实例状态的边界未对齐，无需引入新的调度框架。

### Spec：方案覆盖与既有遗漏

| 原方案要求 | 本次核对结果 |
|---|---|
| 本次 run 最后一步正文，不回取历史或 reasoning | 已接通 lifecycle → worker → completion → runner；runner 不再查历史，成功空字符串保持为空 |
| 空正文成功结束，独立英文 `program_note`，不补请求 | 普通路径通过，composition E2E 确认提示进入父模型、子正文为空、总请求数为 3；有后续队列时须修复 A-R1 |
| 失败片段留原历史，不作为报告 | 断流失败、取消的真实 composition 用例通过；失败 completion 不携带 finalResponse，runner 失败分支没有 finalOutput |
| 前台与后台交付一致，保留真实终态与原因 | 尚未完整达到：A-R1 影响前台结果；下述 A-S1 缺少明确关闭的原因 |
| 普通 stream、旧调用方与原生 model-state 兼容 | stream 路径和 provider 回放边界未改；旧 extractFinalOutput 导出保留，新字段 optional。旧 coordinator 不给 finalResponse 时返回空正文，不回捞历史 |
| 不提前实施后续轮次 | 未新增 partialOutput、结果持久化服务或自动重试；真实资源清理仍属于 C |

**A-S1 / P2，基线已有验收缺口：明确 close 正在运行的子代理时，没有交付取消原因。**

定位：`packages/ohbaby-agent/src/agents/subagent-host.ts:289–299` 未保存 close 的原因，991–992 行在关闭后直接返回该记录。真实 host/tool 复现中，前台等待者只收到 `status: cancelled`；模型 metadata 同样没有 error。这不是本次引入的回归，但仍不满足 A 已确认的“真实终态和原因”。应在本批补齐关闭原因的交付与用例；不扩展到进程清理或第三轮结果服务。

还有三处测试证据需要补强，不据此直接断定实现错误：部分正文后超时、部分正文后 host 中断的完整父子链；前一步有正文且调用工具、最后一步为空的完整返回链；真实后台完成与连续追问的组合场景。现有 mock 工具测试和分层测试不能冒充这些跨层用例。

### 当前版本重新执行的检查

| 命令 / 检查 | 结果 |
|---|---|
| `pnpm test` | 362 个文件通过、6 个跳过；3798 个用例通过、17 个跳过；退出码 0 |
| `pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts` | 6 个用例通过；退出码 0 |
| `pnpm typecheck`、`pnpm lint`、`pnpm format:check` | 全部退出码 0 |
| `pnpm build` | 全部工作区构建通过；退出码 0 |
| `git diff --check` | 通过 |
| 真实 host/store/tool 当前与基线对照 | A-R1 的成功、失败场景及 A-R2 均复现；主审独立重跑确认 |
| 模型工具内容投影与 close 路径 | 确认 A-R1 的成功正文没有 metadata 兜底；确认 A-S1 没有原因 |

本次没有重跑手工 compiled Web 浏览器验收或调用真实付费模型；上方本地实施记录中的浏览器证据属于实施阶段记录。受控 provider 的 6 个 composition 用例已重新执行。

复现脚本和运行日志保存在本机临时目录 `/tmp/ohbaby-pre-a-acceptance.1bjrwz/`；原始当前/基线脚本为 `/tmp/pre-a-standards-repro.mts` 与 `/tmp/pre-a-standards-baseline-repro.mts`。临时文件不作为长期验收依赖，后续应把上述触发条件写入正式回归测试。

修复后继续在当前 pre-a 临时分支复验，先确认 A-R1、A-R2、A-S1 及对应回归测试，再更新本节结论；通过后才进入合回开发分支步骤。

## 已核实的实施前现状

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

以上是已确认的验收要求，通过情况见独立验收记录。底层进程清理与资源释放仍由 C 负责，结果返回不证明真实操作已经停止。

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

实施前源码依据（ohbaby `10018b4d`）：`tools/subagent.ts::renderRun/renderStatus` 已把身份、状态与 `<subagent_output>` 分开，当时空 output 只被省略；`agents/subagent-host.ts::successfulOutput` 直接传递成功的 finalOutput。Pi `57cde86906` 子代理扩展示例在文本结果中显示 `(no output)`，说明提示必须进入模型可见文本；不照搬它的正文提取或失败兜底。验收应检查父模型真正收到的工具文本、空的正文存储及不增加模型请求，不能只检查 UI 元数据。当前本地分支已接线，验收结论见上文。验收同时检查程序提示使用英文；中文文档中的解释不得直接作为运行时提示输出。

## 与后续轮次的边界

第三轮消费本次正文和真实结束事实，再负责结果持久化、通知、内部只读授权及产物清理。A 不新增 improve 编号；触顶原因的全链路贯通仍按第三轮 S3a 处理。Read 能力由 [B](b-file-tools.md) 独立验收。

返回：[前置索引](prerequisite-follow-ups.md) · [总体路线](../README.md) · [第三轮](../improve-3/README.md)。
