# 后端实施与阶段验收

2026-11-11。分支：`codex/model-feedback`，从 `30965c23` 新建，没有使用 worktree。本次只验收 Codex 负责的 LLM、agent 和 SDK；Web / TUI 由 Claude 接入，视觉与联合验收尚未完成。

## 实施

- 请求失败与 `retryScheduled` 首次封口一起保存。重试预算、部分输出保护、取消和保存失败优先级保持原语义。
- SDK 从当前请求链推导 `phase` 和 `waitingStartedAt`。实时、source reasoning、持久读取及 legacy 快照使用同一规则；前一步内容不影响当前请求。
- 共享 provider 原因提取供 lifecycle 和 runtime 使用。消息保留原错误类型；prompt/run 得到安全说明及已有结构化字段。`UiRun.error` 读取 ledger；`listEndedTurns` 返回每轮唯一的可选 `error`。
- 逐次诊断复用现有 logger，关联 ID 采用原有稳定指纹。有限类别和安全 code/type 可记录，原始消息、认证信息、请求/响应正文不进入新诊断，也不进入请求 JSON。

前端目标与职责见 [frontend-goal-duty](frontend-goal-duty.md)。不要求新增 Syncing 文案；后端字段不等于界面应逐项展示的内容。

## 真实提供商请求

使用本地 `tests/models-4-tests.md` 与 `.env`，直接执行一次性命令；每项只有一次请求，SDK 自动重试关闭，45 秒上限。没有保存 E2E 脚本或凭证，没有修改现有 daemon、模型配置或用户会话。

| 请求                                | 真实结果                                     | 耗时    | 结论                                                    |
| ----------------------------------- | -------------------------------------------- | ------- | ------------------------------------------------------- |
| OpenAI Terra，Responses，medium     | 200，有正文，stop                            | 2726 ms | 当前请求可成功。                                        |
| OpenAI Responses，刻意使用假密钥    | 401，invalid_api_key / invalid_request_error | 801 ms  | 认证错误，应检查配置，自动重试无用。                    |
| OpenAI Terra，Chat + tools + medium | 400，invalid_request_error，reasoning_effort | 1202 ms | 协议组合不支持。修正后给出切换 Responses 的固定说明。   |
| Zenmux DeepSeek Flash，Chat         | 200，有正文，stop                            | 2125 ms | 当时可成功，不代表此前 429 限流没有发生或以后不会发生。 |

这是实际 adapter 请求结果，不冒充页面验收。错误分类器另用可控错误覆盖包装后的限流、余额、网络/TLS、部分输出及未知协议错误。

## HTTP 后端端到端

直接用一次性命令启动临时 HTTP daemon、SQLite、工作区与远程 SDK，使用独立端口和受控 HTTP provider。最终受控跑次共 5 个模型 HTTP 请求：

| 场景                                  | 结果                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| 429 后重试成功（2 次请求）            | SQLite、`session.changed.runs`、source view 与新客户端快照一致；等待起点连续。 |
| 同时打开的 Side Chat 返回 401（1 次） | 主会话重试不受影响；prompt、run、消息保存相同安全原因。                        |
| 已知协议组合返回 400（1 次）          | prompt、run、消息均提示改用 Responses。                                        |
| 部分正文后 EOF（1 次）                | 刷新后保留正文，没有自动重放。                                                 |

观察到 4 条失败诊断；上游测试标记和非持久诊断字段未进入快照或请求 JSON。另通过临时 daemon 完成 **1 次真实 Terra Responses** 请求，2341 ms 成功，SQLite 保存 1 次 success，未执行工具。所有临时状态在 finally 中清理。

## 验证与审查记录

以下全量检查和 E2E 是本次收窄修正之前的结果，不作为修正后重新全量验收的结论。当前改动未提交，等待用户检查。前端 T3/T5/T6/T7 的交互、动画与连接显示不在本次后端通过范围内；旧 UI 尚未接入新契约，不能据此宣称页面闪烁已经修复。

| 检查                                                 | 结果                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --maxWorkers=4 --minWorkers=1` | 682 个文件通过、6 个跳过；7,957 项通过、17 项跳过、0 失败，242.07 秒。包含既有 Web/TUI 回归，不替代新交互验收。 |
| `pnpm typecheck`                                     | 通过。                                                                                                          |
| `pnpm lint`                                          | 0 错误，120 个警告。未绕过提交钩子。                                                                            |
| `pnpm format:check`                                  | 通过；仓库默认忽略的议题文档另作显式格式检查。                                                                  |
| `pnpm build`                                         | 通过，含 Web bundle 与 CLI 包；保留现有大 chunk 提示。                                                          |
| HTTP E2E / 真实请求                                  | 见上表。一次性命令执行，没有新增 E2E 脚本。                                                                     |

独立子代理完成重试事实审查、后端投影/归属审查和错误/诊断审查。错误审查发现并修复了两项 P2：

- 未知 Responses 早期错误绕过安全提示：在重试决策之后保留 provider 边界类型，输出固定未知错误并记录安全诊断，不增加请求；可选字段读取失败也不会泄漏原文。
- SDK 的 `requestID` 字段未提取：补齐实际字段名，仍使用严格格式过滤及现有日志指纹。

复核重新执行原始 Responses mapper 与 SDK 构造器复现，确认这两项关闭；随后可维护性复审另发现下节两项问题，原“无剩余阻断”结论不完整。实现继续复用请求 JSON、ledger、轮次与日志，没有新增活动状态库或重试框架。

回归发现新的 provider 包装曾丢失已有 prompt-cache 策略标记，已在包装上保留标记并让原异常继续作为直接 `cause`；原有缓存断言通过，安全错误复核也通过。同步调整了旧原文错误断言及新增测试的类型写法；相关 333 项针对性测试通过后，运行上表最终全量回归。

另有 TUI 审批期间 Ctrl+C 用例曾偶发失败，隔离及最终全量运行通过；审查定位到未修改的 `session-recovery.refreshControl` 递归递增 ticket 可能让 `stop()` 拒绝的竞态。交给 Claude 在前端阶段核查，不把本轮后端通过写成这个问题已修复。

## 用户复审后的收窄修正

用户要求先不提交。此前三次本地提交已撤回，分支 HEAD 回到 `30965c23`，全部实施与文档改动保留在工作区。

- 撤回 `run-stream-adapter.ts` 及其单测的本轮整份增强。唯一生产入口固定关闭旧消息投影，因此无需为它增加阶段记忆和临时 reasoning 拼装。原有旧路径保留；实际使用的 source projection、SDK selector、`getSnapshot` 最终消息投影仍保留。
- `normalizeRunError` 优先尊重明确的 `ModelObservationError` / `ToolDeliveryError`。即使内部 cause 带 503 / ECONNRESET，也沿用 `RUNTIME_ERROR`、runtime 来源和不自动重试的语义；lifecycle 映射仍保留原 terminalReason，不附模型身份。
- 只新增一组参数化测试，共两例，各覆盖直接与 lifecycle 两个映射入口。修正前两例均失败，准确复现误报模型服务问题。

本次验证：7 个相关测试文件、311 项全部通过（错误映射、provider 分类、原旧桥测试、恢复投影、执行投影、进程内契约、lifecycle）。仅新增上述两例；没有新增 E2E 脚本、重跑真实模型请求或把之前全量结果冒充本次结果。

`pnpm typecheck` 通过；修改的两个 TypeScript 文件 ESLint 与 Prettier 检查通过。两位独立子代理分别复核 KISS/改动范围和错误归属：确认旧路径增强完全撤回、实际快照路径保留，原 P2 关闭，无新的阻断发现。此结论仅针对本次收窄修正，仍等待用户检查，未 commit。

## Pi 独立审查与后续修正

用户重新授权审查后分批提交。通过 calling-pi-agent 调用 `anthropic/claude-opus-5-5`，thinking 为 `xhigh`，本机模型目录与认证检查通过。Pi 只读检查当前工作区，结论为建议提交、无阻断项；原文完整呈现在本次对话，不另复制一份评审文档。

核实并采纳两项建议：本地请求校验不应被包装成模型服务错误；保存失败应在状态和轮次错误中使用同一份 lifecycle 摘要。保存终态还须保留 runtime 来源，即便底层 cause 带 HTTP 状态。没有调整重试预算或部分输出保护。

当时暂未采纳的建议（第 1、2 项后经用户确认收窄，见末节）：删除字段读取保护会丢失已知错误对象的安全降级覆盖；上游编号沿既有日志隐私规则保留指纹，仅用于关联，不声称可直接提供给供应商；把重试判断抽成新函数属于可选可读性重构，暂不扩大范围。

独立子代理确认 SDK 契约、侧聊隔离和当前请求链投影可供前端接入；保存失败摘要修正另经静态复审及 159 项针对性回归。本地校验修正另经独立子代理复核：只包装三个 adapter 的本地请求构造，SDK 请求与响应流保持在包装范围外；三个参数化用例先红后绿，确认零 HTTP、一次尝试、无重试。

最终全量回归：`pnpm exec vitest run --maxWorkers=4 --minWorkers=1`，682 个文件通过、6 个跳过；7,960 项通过、17 项跳过、0 失败，266.02 秒。`pnpm format:check` 通过。未再重复真实模型调用，原直接命令 E2E 结果见前文；本次新增修正覆盖在 adapter/streaming 与 runtime 的针对性测试及全量回归中。

最终 `pnpm build`、`pnpm typecheck` 通过；提交钩子完整运行，`pnpm lint` 为 0 错误、120 个警告。未绕过检查。代码分批提交：

- `caed459c`：LLM 请求事实、安全原因提取和本地请求校验边界。
- `643e7514`：SDK 活动/轮次契约、agent 投影及运行时错误一致性。

本记录和模块说明作为随后文档批次提交。后端可以交给 Claude 接入，Web/TUI 功能与视觉验收仍待两端完成后联合检查。

## 后续简化：总兜底与上游编号删除

按用户确认，错误提取移除逐字段、status 和 retryable 的局部补救，只保留一个总 try/catch；已确认 provider 来源后，坏字段导致固定通用说明，不透出原文。循环 cause 和 16 层深度上限不变。子代理发现初版对普通 HTTP 对象的来源保留不足，已在读取后续细节前保留来源，并补进原有参数化断言。

删除四种上游请求编号别名、正则校验、ProviderErrorDetail / 非持久 failure 中对应字段、lifecycle 转交和日志 upstreamId。本地 ModelRequestAttempt.requestId、operationId、run/session 关联保留。SDK、Web/TUI 文件不改；streaming 只少传一个诊断字段，重试控制流不动。

同一 Pi 会话再次调用 anthropic/claude-opus-5-5、xhigh，建议提交；其只读验证 163 项测试通过，并提醒同步文档。该意见对应初版收窄；子代理随后发现的普通 HTTP 对象兜底缺口另行修正并复核。Pi 原文呈现在对话中，不另建评审文件。

最终针对性回归：provider-error、request-observation、stream-idle、error-detail、lifecycle 共 5 个文件、163 项全部通过。子代理复核确认普通 HTTP provider 的兜底缺口关闭，未恢复多层防护。前端和 SDK diff 为空；streaming 只删除非持久诊断字段。本次不重复全量或真实模型请求，按现有提交钩子执行静态检查后提交。

## Web 前端实施与走查（2026-11-12）

Claude 按 00 §13（F1–F10）实施 Web；TUI 按用户安排在 Web 验收后单独进行，本节不代表 TUI 通过。

改动范围：

- **等待行**：`ModelWaiting` 改用 `modelActivity.phase` 和 `waitingStartedAt`，整条请求链保持同一行；重试时显示 `Retrying #n`，数字翻动、不显示计时；当前步骤出现可见正文、Thought 或工具卡片后让位；连接异常时不显示旧快照的等待行。
- **轮次错误**：`RunProcess` 带上 `listEndedTurns` 的 `error`（排除用户停止、服务关闭），在失败轮次末尾显示一行说明和可选 `HTTP 状态码`；同一轮的应用中断说明不再重复显示；尚未形成轮次的失败提问挂在其用户消息下。会话顶部卡片不再显示模型终态错误，`selectPersistedPromptError` 删除。
- **断线遮罩**：SSE 单次尝试 10 秒等不到 hello 即重试；401 / 409 视为 daemon 已重启并停止循环；`ClientSync` 在断线 10 秒后发布 `lost`，重启时发布 `restarted`；`AppShell` 增加 `blocking` 位，遮罩期间整页 `inert`。用户可见文案中的 `ohbaby` 改为“your services”。

自动化验证：`apps/ohbaby-web` 全部测试通过（含新增的重试计数、轮次错误、SSE 重试、断线计时和遮罩测试）；`tsc -b`、ESLint、Prettier 通过。

浏览器走查（独立 home、假 OpenAI 兼容模型、真实 daemon 与 HTTP 链路）：

| 场景 | 结果 |
| --- | --- |
| 429 一次后成功 | `Retrying #1` 原位换成回答，未出现错误行 |
| 连续 429 直到重试耗尽 | 每 50 ms 采样：同一个 DOM 节点从 `Retrying #1` 走到 `#5`，结束时移除一次，无闪动；轮次末尾显示说明和 `HTTP 429` |
| 连接失败耗尽 | 显示“Could not reach the model…”，无状态码行 |
| 部分输出后断流 | 保留已输出内容，轮次末尾一条中断说明 |
| Side Chat 连续 429 | 侧聊内 `Retrying #2` 后显示自己的错误行，主会话不受影响，输入框上方无卡片 |
| 刷新页面 | 错误行仍在所属轮次，只出现一次 |
| 停止 daemon | 10 秒内顶栏 `Reconnecting…`，约 10 秒后全页静态遮罩 |
| 重启 daemon（新 token） | 遮罩改为“服务已重启，刷新继续”；点击 Refresh 后页面恢复 |
| 正常请求 | `Thinking 3s`，无 ` · ` 分隔 |

走查中发现并修复一个问题：401 时先清除 `lost` 会同步触发新的 10 秒计时，10 秒后把“已重启”覆盖回“未响应”。改为先写 `restarted` 再清理计时，并让计时不覆盖 `restarted`，补充对应单元测试。

未覆盖：断线后同一 daemon 自动恢复（无法在不重启 daemon 的情况下制造断流，由单元测试覆盖）；减少动态效果下的翻动动画依赖全局规则，未单独截图；应用目前只有浅色主题。

子代理代码审查（只读）报告 1 条中等、5 条轻微问题，均已修复：

- **中**：设置弹窗打开时会给整个 `.ohb-shell` 加 `inert`，原先放在 shell 内的遮罩也随之不可点。改为挂到 `body` 的原生 `<dialog>`，用 `showModal()` 进入顶层，其余内容（含设置、菜单等 portal）一并不可操作，Esc 不能关闭。浏览器复核：设置打开时断线，遮罩在最上层（`:modal` 为真），焦点在 `Reconnect now`，Esc 无效，重启后 Refresh 正常。
- **轻**：读屏改为只播报 `Thinking` / `Retrying #n` 的变化，不播报每秒计时；本页看着运行后失败的轮次，用一次 polite 播报说出原因，历史错误不重复播报。遮罩撤下后焦点回到原来的位置。等待 hello 的尝试中按 `Reconnect now` 会立即放弃该尝试并重连。重试期间不再每秒重渲染。常量注释位置、未使用的类名和不必要的导出已清理。

提交：`d1a1dcbb`（等待行与轮次错误）、`de8ce134`（断线遮罩）。修复后 `apps/ohbaby-web` 全部 950 项测试、`tsc -b`、ESLint 通过。
