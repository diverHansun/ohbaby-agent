# 子会话失败反馈与受控上游诊断

实施日期：2026-11-12 至 2026-11-13。基线：`3b36ae05`。分支：`codex/subagent-failure-diagnostics-20261112`。

## 真实问题与证据边界

目标会话 `session_1794497229574_ickj331` 有 7 个子代理：5 个失败、2 个完成。失败 run 都带 `PROVIDER_API`、`providerId: zenmux`、`statusCode: 400`、`retryable: false`；终止原因不是输出长度上限。首次派遣 4 个，随后主代理又派遣了 3 个。不能依据主代理报告中的“6 个/4 个失败”计数。

本地诊断日志只留下通用 `invalid_request`。没有保留当时上游的详细错误或请求 ID，因此个人 key 的并发限制仍是待验证假设。后续合成工具历史和历史片段请求返回 200，但没有复刻完整原始系统提示和工具集合，不能据此排除当时的请求内容或上游路由问题。

页面未显示原因的根因已确认：`SubagentConversationBody` 没传 `conversation.view.runs`，同时把阅读缓存身份 `root:subagent` 当成了真实子会话 ID；`listEndedTurns` 因而无法匹配失败 run。

## 修改与字段边界

前端继续使用 `ConversationStream` / `TurnError`，传入真实 child session ID 和已按 scope 过滤的 runs。阅读缓存仍使用 `root:subagent`，组件以该 identity 为 key，避免共用物理子会话的子代理相互影响。读取失败提示和执行失败提示保持各自已有语义。

后端只增加两个可选日志诊断字段，详见 [后端诊断边界](./backend-diagnostics.md)。没有增加数据库列、SDK DTO、配置项或新的错误组件，也未改变调度、接续和重试策略。

## 验收

- 前端由 Pi `anthropic/claude-opus-5-5`、xhigh 实施，主代理复核并独立运行测试。
- `provider-error` 的新诊断用例在实现前失败；Pi 报告其四个 UI 回归用例在基线全部失败，仅移除组件 key 时阅读隔离用例也失败。
- 前一轮针对性回归：40 个测试文件、636 项全部通过。测试覆盖 provider 分类、SDK 错误对象、流式请求、请求观测、重试、生命周期、日志编码及真实日志进程、run 错误归一化，以及 Web session/side-panel/conversation/side-chat。
- 类型检查、修改文件 ESLint、Web 生产构建通过。构建仍有既有大 chunk 提示。
- 内置浏览器加载新构建，通过仅允许查看/订阅操作的本地验收代理读取原 4096 服务。打开真实 `Access-Policy-Auditor` 后，失败轮次下方显示一次既有错误文案和 `HTTP 400`。没有提交消息、重跑任务或修改模型配置；没有重启原服务。截图：本地 `/tmp/subagent-error-ui-acceptance.png`。
- 历史重开、阅读位置隔离和 reader 网络错误与 run 失败区分由回归测试验证。不据此宣称覆盖所有历史会话或所有真实 provider。

旧失败缺失的上游信息无法追补。没有 `UiRun.error` 的旧数据仍可能只有 Failed；不在本轮制造推测原因。新诊断在更新并重启服务后才会记录后续失败。

## 2026-11-13 合并前复审

- 两个独立子代理审查后端诊断边界与前端失败链路，均重新核实状态码来源；真实 SQLite 的五条失败仍为 `statusCode: 400`。状态码不由诊断标签推算。
- 修正审查发现：原 `missing_reasoning_content` 名称会将“不允许携带”和“必须为字符串”误称为缺失，改为 `invalid_reasoning_content`，补两种输入的回归断言。
- 子会话展示测试扩展为 400、429、缺失状态码三种情形：显示真实状态码，缺失时不显示 HTTP。
- 隐私边界：`upstreamId` 是有界、限定来源及格式的原始关联元数据，不是匿名化数据；格式校验无法证明任意上游伪造值绝不包含敏感内容。没有新增正文日志通道。
- 已有历史限制：后端取最近 50 条物理会话 run 后才按 scope 过滤，很早的子代理历史可能缺少相应 run；本次不扩展历史分页。

- Pi 后端复审发现两条诊断误标并已修正：只在明确请求并发的短语出现时标记 `concurrency_limit`，不将每条消息的工具调用数上限当成账户并发限流；工具标签统一为 `invalid_tool_request`，不将 schema 校验误称为历史错误。新增实际反例，并修正 4096 字符边界测试使其仍能捕获移除截断的退化。子代理最终复核未发现产品阻塞。

## 最终验证

- `pnpm test`：698 个文件通过、6 个跳过；8156 项通过、17 项跳过。跳过项未计入通过数。
- 最后调整的 4096 字符边界回归单独复跑：provider-error 17 项通过。
- 子会话测试包含 400 / 429 / 无状态码：仅展示实际提供的 HTTP 状态。
- 模型设置的视觉验收另见 [UI 细节调整](../../config/llm/2026-11-12-model-settings-automation/improve-1/08-ui-polish.md)。

- 最终类型检查、全仓 lint、完整生产构建通过；lint 为 0 error / 125 项既有 warning。新增测试中的数字插值已按仓库规则显式转字符串，子会话文件 11 项复跑通过。修改文件格式检查和 `git diff --check` 通过。
- 代码、测试、文档按后端诊断、子会话反馈、模型设置视觉三个职责分别提交。合并采用 fast-forward；已验证的产品代码不在合并时改写。
